// SPDX-License-Identifier: MPL-2.0
/**
 * Authored-deck-model lowering - the PURE, DOM-free half of the tool→native-pptx path.
 *
 * A tool may emit its own deck as inline JSON (a `[data-pptx-deck]` <script>) so it gets
 * NATIVE PowerPoint objects - editable text, real `a:tbl` tables, a brand theme - rather
 * than pictures from the DOM walk. This module lowers that (UNTRUSTED, tool-authored)
 * JSON into the engine's `PptxSlide`/`PptxShape` model: CSS colours → hex, the deck's own
 * px space → EMU, everything coerced defensively so a hostile/typo'd field degrades to a
 * safe default instead of emitting invalid OOXML. Image elements are the ONLY async part
 * (they fetch bytes) and stay in export-pptx.ts; everything here is synchronous and
 * node-testable. The engine (buildPptxParts) frames the OOXML; this never touches a DOM.
 *
 * Contract (the deck model a tool emits) - all positions/sizes in the deck's px space:
 *   { size?:{w,h}, theme?:DeckTheme, layouts?:[DeckLayout], slides:[ { bg?:DeckFill, layout?:number, notes?, elements:[DeckEl] } ] }
 *   DeckEl.t ∈ 'rect' | 'text' | 'table' | 'image'   (image handled by the caller)
 *   A text DeckEl may carry ph:{type,idx} to bind to a layout placeholder.
 *   DeckLayout = { name, bg?:DeckFill, elements?:[DeckEl], placeholders?:[{type,idx?,x,y,w,h,anchor?,style?,prompt?}] }
 *   - the branded layout gallery (engine PptxLayout); slide.layout indexes into it.
 *   colours are CSS strings: '#30BA78', '#3bfa', 'rrggbb', 'rgb(…)', 'rgba(…)'.
 *
 * EMITTER OBLIGATION (the tool, not this module): when serialising the deck INTO the
 * `<script type="application/json" data-pptx-deck>` node, escape '<' so a deck string value
 * (text, notes, cell text, bullet char, theme name, image src) containing '</script>'
 * can't close the tag and break out into HTML. Use
 *   JSON.stringify(deck).replace(/</g, '\\u003c')
 * This module's reader (parseDeckModel) is safe either way - a truncated model just fails
 * JSON.parse and falls back to the DOM walk - but the un-escaped emit is a stored-XSS /
 * DOM-breakout hole in the tool's OWN render, so it is mandatory on the emit side.
 */
import { EMU_PER_PX, MAX_TABLE_COLS, MAX_TABLE_ROWS } from "../../../../engine/src/pptx.ts";
import type { PptxAnim, PptxEffect, PptxFill, PptxPara, PptxRun, PptxShape, PptxTable, PptxTableCell, PptxLine, PptxPic, PptxTheme, PptxPhType, PptxPlaceholder } from "../../../../engine/src/pptx.ts";

export type DeckBox = { x: number; y: number; cx: number; cy: number };

// ECMA-376 ST_Coordinate bound - an EMU past this is schema-invalid (→ PowerPoint repair),
// so an absurd px value gets clamped rather than emitted. Gradient stops are also capped.
const ST_COORD_MAX = 27273042316900;
const MAX_GRAD_STOPS = 64;

// ── defensive coercion (every field is untrusted tool JSON) ───────────────────
export const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const asFinite = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
export const emuOf = (v: unknown, d = 0): number => Math.max(-ST_COORD_MAX, Math.min(ST_COORD_MAX, Math.round(asFinite(v, d) * EMU_PER_PX)));
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);

// NaN-safe: a malformed rgb() channel ('.', '1.2.3') parses to NaN, which must never reach
// the hex string as the literal "NAN" (invalid ST_HexColorRGB → repair).
const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(Number.isFinite(n) ? n : 0))).toString(16).padStart(2, '0').toUpperCase();

// A CSS colour string → { hex:'RRGGBB', alpha? } or null (none/transparent/unparseable).
// Handles #rgb / #rgba / #rrggbb / #rrggbbaa (with or without '#') and rgb()/rgba(). Named
// CSS colours are NOT resolved - an authored deck emits hex/rgb (pptxgenjs convention).
export function deckColor(v: unknown): { hex: string; alpha?: number } | null {
  const s = (typeof v === 'string' ? v : '').trim();
  if (!s || s === 'transparent') return null;
  const hm = /^#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s);
  if (hm) {
    let h = hm[1]!;
    if (h.length === 3 || h.length === 4) h = h.split('').map(ch => ch + ch).join('');
    const hex = h.slice(0, 6).toUpperCase();
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return a <= 0.01 ? null : { hex, alpha: a < 1 ? a : undefined };
  }
  const rm = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s);
  if (rm) {
    const a = rm[4] !== undefined ? parseFloat(rm[4]) : 1;
    return a <= 0.01 ? null : { hex: hex2(+rm[1]!) + hex2(+rm[2]!) + hex2(+rm[3]!), alpha: a < 1 ? a : undefined };
  }
  return null;
}

// A DeckFill - a CSS colour string OR { grad:{ stops:[{pos,color}], angle } }.
export function deckFill(f: unknown): PptxFill | undefined {
  if (typeof f === 'string') { const c = deckColor(f); return c ? { solid: c.hex, alpha: c.alpha } : undefined; }
  const g = (f as { grad?: { stops?: unknown; angle?: unknown } } | null)?.grad;
  if (!g) return undefined;
  const stops = (Array.isArray(g.stops) ? g.stops : []).slice(0, MAX_GRAD_STOPS);
  const grad = stops.flatMap((s: { pos?: unknown; color?: unknown }) => {
    const c = deckColor(s?.color);
    return c ? [{ pos: Math.max(0, Math.min(1, asFinite(s?.pos))), color: c.hex, alpha: c.alpha }] : [];
  });
  return grad.length >= 2 ? { grad, angle: asFinite(g.angle, 180) } : undefined;
}

const deckLine = (l: unknown): PptxLine | undefined => {
  const c = deckColor((l as { color?: unknown } | null)?.color);
  return c ? { color: c.hex, w: Math.max(0, emuOf((l as { w?: unknown }).w, 1)) } : undefined;
};

export function deckRun(r: Record<string, unknown>): PptxRun {
  return {
    text: asStr(r?.text) ?? '', sizePt: asFinite(r?.sizePt, 12),
    color: deckColor(r?.color)?.hex, bold: asBool(r?.bold), italic: asBool(r?.italic),
    underline: asBool(r?.underline), strike: asBool(r?.strike), font: asStr(r?.font),
  };
}

export function deckPara(p: Record<string, unknown>): PptxPara {
  const para: PptxPara = { runs: Array.isArray(p?.runs) ? p.runs.map(deckRun) : [] };
  const align = oneOf(p?.align, ['l', 'ctr', 'r', 'just'] as const); if (align) para.align = align;
  if (typeof p?.level === 'number' && Number.isFinite(p.level)) para.level = p.level;
  const b = p?.bullet;
  if (b === true || b === false || b === 'number') para.bullet = b;
  else if (b && typeof b === 'object' && typeof (b as { char?: unknown }).char === 'string') para.bullet = { char: (b as { char: string }).char };
  const bc = deckColor(p?.bulletColor); if (bc) para.bulletColor = bc.hex;
  for (const k of ['lineSpacingPct', 'spaceBeforePt', 'spaceAfterPt'] as const)
    if (typeof p?.[k] === 'number' && Number.isFinite(p[k])) para[k] = p[k] as number;
  return para;
}

function deckCell(c: Record<string, unknown>): PptxTableCell {
  const cell: PptxTableCell = {};
  if (Array.isArray(c?.paras)) cell.paras = c.paras.map(deckPara);
  else { const t = asStr(c?.text); if (t != null) cell.text = t; }
  cell.fill = deckColor(c?.fill)?.hex;
  cell.color = deckColor(c?.color)?.hex;
  const align = oneOf(c?.align, ['l', 'ctr', 'r', 'just'] as const); if (align) cell.align = align;
  const anchor = oneOf(c?.anchor, ['t', 'ctr', 'b'] as const); if (anchor) cell.anchor = anchor;
  if (typeof c?.colSpan === 'number') cell.colSpan = c.colSpan;
  if (typeof c?.rowSpan === 'number') cell.rowSpan = c.rowSpan;
  if (typeof c?.bold === 'boolean') cell.bold = c.bold;
  if (typeof c?.sizePt === 'number') cell.sizePt = c.sizePt;
  const font = asStr(c?.font); if (font) cell.font = font;
  if (typeof c?.margin === 'number') cell.margin = emuOf(c.margin);
  const bs = c?.borders as Record<string, unknown> | undefined;
  if (bs && typeof bs === 'object') {
    const b: NonNullable<PptxTableCell['borders']> = {};
    for (const side of ['l', 'r', 't', 'b'] as const) { const ln = deckLine(bs[side]); if (ln) b[side] = ln; }
    if (Object.keys(b).length) cell.borders = b;
  }
  return cell;
}

export const deckSrcRect = (s: unknown): PptxPic['srcRect'] => {
  if (!s || typeof s !== 'object') return undefined;
  const o = s as Record<string, unknown>;
  const f = (k: string) => Math.max(0, Math.min(0.99, asFinite(o[k])));
  const l = f('l'), t = f('t'), r = f('r'), b = f('b');
  return l || t || r || b ? { l, t, r, b } : undefined;
};

export const deckBox = (el: Record<string, unknown>): DeckBox => ({
  x: emuOf(el?.x), y: emuOf(el?.y), cx: Math.max(1, emuOf(el?.w, 1)), cy: Math.max(1, emuOf(el?.h, 1)),
});

// A placeholder binding on a deck text element: { type, idx? }. Whitelisted types only
// (the engine drops unknowns too; filtering here keeps the model honest at the boundary).
const DECK_PH_TYPES = ['title', 'ctrTitle', 'subTitle', 'body', 'sldNum'] as const;
export function deckPh(v: unknown): { type: PptxPhType; idx?: number } | undefined {
  const type = oneOf((v as { type?: unknown } | null)?.type, DECK_PH_TYPES);
  if (!type) return undefined;
  const idx = (v as { idx?: unknown }).idx;
  return typeof idx === 'number' && Number.isFinite(idx) && idx >= 0 ? { type, idx: Math.round(idx) } : { type };
}

// One layout placeholder: binding + a px-space box + role text style + prompt.
export function deckPlaceholder(p: unknown): PptxPlaceholder | null {
  if (!p || typeof p !== 'object') return null;
  const el = p as Record<string, unknown>;
  const bind = deckPh(el);
  if (!bind) return null;
  const st = el.style as Record<string, unknown> | undefined;
  const out: PptxPlaceholder = { ...bind, ...deckBox(el) };
  const anchor = oneOf(el.anchor, ['t', 'ctr', 'b'] as const); if (anchor) out.anchor = anchor;
  const prompt = asStr(el.prompt); if (prompt) out.prompt = prompt;
  if (st && typeof st === 'object') {
    const style: NonNullable<PptxPlaceholder['style']> = {};
    const font = asStr(st.font); if (font) style.font = font;
    if (typeof st.sizePt === 'number' && Number.isFinite(st.sizePt)) style.sizePt = st.sizePt;
    style.color = deckColor(st.color)?.hex;
    const align = oneOf(st.align, ['l', 'ctr', 'r'] as const); if (align) style.align = align;
    const bullet = asBool(st.bullet); if (bullet != null) style.bullet = bullet;
    out.style = style;
  }
  return out;
}

// ── native animation (plans/175 WP-E) ─────────────────────────────────────────
//
// Maps Lolly's animation vocabulary (the design tool's enter/exit kinds + split
// text fields, carried raw on a deck element's `anim`) onto the engine's SUPPORTED
// OOXML subset. Everything Lolly can say that PowerPoint cannot degrades to the
// nearest listed preset with a note pushed into `notes` - one logged substitution
// line, never a silent difference, never a refusal of the export.

const ANIM_KIND_MAP: Record<string, { preset: PptxEffect['preset']; dir?: PptxEffect['dir']; note?: string }> = {
  fade: { preset: 'fade' },
  pop: { preset: 'zoom', note: 'pop → Zoom' },
  grow: { preset: 'zoom', note: 'grow → Zoom' },
  rise: { preset: 'fly', dir: 'b', note: 'rise → Fly In from bottom' },
  drop: { preset: 'fly', dir: 't', note: 'drop → Fly In from top' },
  'slide-left': { preset: 'fly', dir: 'r' },
  'slide-right': { preset: 'fly', dir: 'l' },
  'slide-up': { preset: 'fly', dir: 'b' },
  'slide-down': { preset: 'fly', dir: 't' },
  'zoom-in': { preset: 'zoom' },
  'zoom-out': { preset: 'zoomOut' },
  tilt: { preset: 'fly', dir: 'b', note: 'tilt → Fly In from bottom' },
  swoop: { preset: 'fly', dir: 'r', note: 'swoop → Fly In from right' },
  spin: { preset: 'zoom', note: 'spin → Zoom' },
  drift: { preset: 'fade', note: 'drift → Fade' },
};

// Named easing → (accel, decel) in 1000ths of a percent of the duration. The default -
// unauthored, or a custom bezier PPTX cannot carry - is the ease-out every kind was
// born with (lib/transitions.ts easeOutCubic).
const EASE_TO_ACCEL: Record<string, readonly [number, number]> = {
  linear: [0, 0],
  'ease-out': [0, 80000],
  'ease-in': [80000, 0],
  'ease-in-out': [50000, 50000],
  smooth: [50000, 50000],
  snappy: [30000, 10000],
  overshoot: [0, 60000],
  anticipate: [30000, 30000],
};
const DEFAULT_EASE: readonly [number, number] = [0, 80000];

const finiteMs = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

/**
 * One deck element's `anim` (untrusted tool JSON, Lolly vocabulary) → the engine's
 * PptxAnim, or undefined when nothing animates. Degrades are pushed into `notes`.
 */
export function deckAnim(v: unknown, notes?: string[]): PptxAnim | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const a = v as Record<string, unknown>;
  const note = (s: string): void => { if (notes && !notes.includes(s)) notes.push(s); };

  // Split text: letter/word ride OOXML's own iterate; line has no per-line iterate on
  // a single-paragraph text box (our deck text is one paragraph by construction).
  let by: 'letter' | 'word' | '' = a.split === 'letter' || a.split === 'word' ? a.split : '';
  if (a.split === 'line') { by = 'word'; note('split by line → by word (PPTX iterates letters or words)'); }
  const order = typeof a.order === 'string' ? a.order : '';
  if (order === 'center' || order === 'random') note(`text order ${order} → first-to-last (no OOXML form)`);
  // The hold/loop bucket (plans/175 WP-B) has no OOXML form at all - the shape
  // exports still, and the export log says why it is not moving.
  if (typeof a.hold === 'string' && a.hold) note(`hold effect ${a.hold} → not exported (no PowerPoint form)`);
  const iterate: PptxEffect['iterate'] = by
    ? { by, staggerMs: finiteMs(a.stagger, 1, 2000, 60), ...(order === 'reverse' ? { backwards: true } : {}) }
    : undefined;

  const click = finiteMs(a.click, 0, 999, 0);

  const effect = (kindRaw: unknown, msRaw: unknown, easeRaw: unknown, delayRaw: unknown, entering: boolean): PptxEffect | undefined => {
    const kind = typeof kindRaw === 'string' ? kindRaw : '';
    let mapped = Object.prototype.hasOwnProperty.call(ANIM_KIND_MAP, kind) ? ANIM_KIND_MAP[kind] : undefined;
    if (!mapped) {
      // 'none' (the Cut) is an effect worth exporting only when something needs a
      // trigger to hang off: split units (the typewriter) or a click build (a
      // fragment must Appear on its click). A bare cut with neither is no animation.
      if (!entering || (!iterate && click < 1)) return undefined;
      if (kind !== '' && kind !== 'none') return undefined; // junk kind - not an effect
      mapped = { preset: 'appear' };
    }
    if (mapped.note) note(mapped.note);
    const ease = typeof easeRaw === 'string' && Object.prototype.hasOwnProperty.call(EASE_TO_ACCEL, easeRaw)
      ? EASE_TO_ACCEL[easeRaw] as readonly [number, number] : DEFAULT_EASE;
    const fx: PptxEffect = {
      preset: mapped.preset,
      ms: finiteMs(msRaw, 100, 3000, 400),
      delayMs: finiteMs(delayRaw, 0, 600_000, 0),
    };
    if (mapped.dir) fx.dir = mapped.dir;
    if (iterate) fx.iterate = iterate;
    if (mapped.preset !== 'appear') {
      if (ease[0] > 0) fx.accel = ease[0];
      if (ease[1] > 0) fx.decel = ease[1];
    }
    return fx;
  };

  const enter = effect(a.enter, a.enterMs, a.enterEase, a.delayMs, true);
  // Exits are exported ONLY with a derived delay (the hook computes one from a timed
  // box's own end). An exit firing at t=0 would hide content the moment it appeared.
  const exit = a.exitDelayMs != null && typeof a.exitDelayMs === 'number' && Number.isFinite(a.exitDelayMs)
    ? effect(a.exit, a.exitMs, a.exitEase, a.exitDelayMs, false)
    : (typeof a.exit === 'string' && a.exit && a.exit !== 'none'
      ? (note('exit without timing → not exported (needs a timed box)'), undefined)
      : undefined);

  if (!enter && !exit) return undefined;
  const out: PptxAnim = {};
  if (enter) out.enter = enter;
  if (exit) out.exit = exit;
  if (click > 0) out.click = click;
  return out;
}

// The synchronous shapes (rect / text / table). Returns null for 'image' (the caller
// resolves those async) and for any unknown/malformed element. `animNotes`, when
// given, collects the animation mapping's degrade notes (plans/175 WP-E).
export function deckSyncShape(el: Record<string, unknown>, animNotes?: string[]): PptxShape | null {
  if (!el || typeof el !== 'object') return null;
  const box = deckBox(el);
  const anim = deckAnim(el.anim, animNotes);
  const withAnim = <T extends PptxShape>(s: T): T => (anim ? { ...s, anim } : s);
  switch (el.t) {
    case 'rect':
      return withAnim({ kind: 'rect', ...box, fill: deckFill(el.fill), line: deckLine(el.line), radius: el.radius != null ? emuOf(el.radius) : undefined });
    case 'text':
      return withAnim({ kind: 'text', ...box, anchor: oneOf(el.anchor, ['t', 'ctr', 'b'] as const), paras: (Array.isArray(el.paras) ? el.paras : []).map(deckPara), ph: deckPh(el.ph) });
    case 'table': {
      // Cap rows/cols at the engine's own limits (the engine slices too, but doing it
      // here avoids building a huge intermediate - a 5000×200 table is 1e6 cell objects).
      const cols = (Array.isArray(el.cols) ? el.cols : []).slice(0, MAX_TABLE_COLS).map((w: unknown) => emuOf(w, 100));
      const rows = (Array.isArray(el.rows) ? el.rows : []).slice(0, MAX_TABLE_ROWS).map((row: Record<string, unknown>) => ({
        h: row?.h != null ? emuOf(row.h) : undefined,
        cells: (Array.isArray(row?.cells) ? row.cells : []).slice(0, MAX_TABLE_COLS).map(deckCell),
      }));
      return withAnim({ kind: 'table', ...box, cols, rows, firstRow: asBool(el.firstRow) } as PptxTable);
    }
    default:
      return null; // 'image' → caller; unknown → dropped
  }
}

export function deckTheme(t: unknown): PptxTheme | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const src = t as Record<string, unknown>;
  const out: PptxTheme = {};
  const name = asStr(src.name); if (name) out.name = name;
  const cIn = src.colors as Record<string, unknown> | undefined;
  if (cIn && typeof cIn === 'object') {
    const colors: NonNullable<PptxTheme['colors']> = {};
    for (const k of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'] as const) {
      const c = deckColor(cIn[k]); if (c) colors[k] = c.hex;
    }
    if (Object.keys(colors).length) out.colors = colors;
  }
  const fIn = src.fonts as Record<string, unknown> | undefined;
  if (fIn && typeof fIn === 'object') {
    const fonts: NonNullable<PptxTheme['fonts']> = {};
    const major = asStr(fIn.major); if (major) fonts.major = major;
    const minor = asStr(fIn.minor); if (minor) fonts.minor = minor;
    if (Object.keys(fonts).length) out.fonts = fonts;
  }
  return Object.keys(out).length ? out : undefined;
}

// Parse + validate a deck-model JSON string. Returns null (→ DOM-walk fallback) when the
// string is blank, not JSON, or lacks a non-empty `slides` array.
export function parseDeckModel(raw: string | null | undefined): Record<string, unknown> | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    const m = JSON.parse(s) as Record<string, unknown>;
    return m && typeof m === 'object' && Array.isArray(m.slides) && m.slides.length ? m : null;
  } catch { return null; }
}
