/**
 * Deck Builder — live on-canvas editor overlay (render.layout:"deck").
 *
 * Mounts into the stage subtree (a region of the stage OUTSIDE #tool-canvas, like
 * doc-editor.ts / free-canvas.ts) so it SURVIVES the canvas's full-innerHTML repaint on
 * every model commit — the canvas is rebuilt each paint, the overlay is not. The 'deck'
 * layout is NOT chromeless: the input sidebar stays, and this overlay ADDS on-canvas
 * editing on top of it. See plans/slides-live-editor.md.
 *
 * Shipped here:
 *   • a bottom FILMSTRIP (pagination) — one thumbnail per slide, click to make it the
 *     active slide (writes `focusSlide`, which the tool freezes the preview to). Add /
 *     remove slides from the strip.
 *   • JSON + Markdown LOAD — paste a deck as JSON or Markdown and it populates the `deck`
 *     blocks array (image references become resolvable {url}/{id} refs).
 *
 * Later phases add: per-region inline rich-text editing of title/subtitle, an on-canvas
 * background + image-slot picker, and the edit-mode render-mode ↔ export handshake.
 *
 * All writes go through the runtime the overlay receives (shell-side clone-and-commit,
 * the way free-canvas commits), never by poking sidebar DOM.
 */

import {
  boxRect, withRect, moveBoxes, resizeRect, num,
  marqueeHit, alignBoxes, distributeBoxes, reorderZ, rotateGroup, selectionAABB, boxAABB,
  snapMove, snapAngle, normDragRect,
} from './free-canvas-math.ts';
import type { Box, BoxFieldConfig, HandleName, AlignEdge, Axis, ZOp, AABB, Rect } from './free-canvas-math.ts';
import { icon } from '../lib/icons.ts';
import { parsePptxGenJs, inchesToNative } from '../lib/pptxgen-import.ts';
import type { TextRun } from '../lib/pptxgen-import.ts';
import { nearestBrandColor } from '@lolly/engine';

// ── types ────────────────────────────────────────────────────────────────────

interface AssetRef { url?: string; id?: string; [k: string]: unknown }

// The field-name config the free-canvas geometry helpers read a box's geometry from.
// Mirrors the SHARED box shape (see CONTRACT below) — id/x/y/w/h + optional rot, all in
// px on the slide's native canvas (e.g. 1920×1920). The tool renders each box absolutely
// positioned as a % of the slide; a text box's `text` is markdown (same renderer as slide
// content), an image box's `src` is an asset ref/url.
const BOX_CFG: BoxFieldConfig = {
  idField: 'id', xField: 'x', yField: 'y', wField: 'w', hField: 'h', rotationField: 'rot',
};
// The 8 resize handles, in a stable order (mirrors free-canvas.ts HANDLES).
const HANDLES: HandleName[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** One slide row of the `deck` blocks input. Every field is optional / defended.
 *  `content` is a plain MARKDOWN STRING (the single source of the slide text — the first
 *  `# heading` acts as the title, the rest is body; supports ## / bullets / **bold** /
 *  *italic*). It REPLACES the old title/subtitle pair. `bg` is an OPTIONAL per-slide
 *  override — empty means "inherit the deck theme background". `theme`/`logo` are per-slide
 *  furniture overrides threaded through verbatim (resolved by the tool hook, not here). */
interface Slide {
  layout?: string;
  content?: string;
  /** 'layout' (structured template + `content`, the default) or 'freeform' (a free-canvas
   *  of hand-positioned `boxes`). SHARED contract with the tool hook: a freeform slide
   *  renders its boxes, a layout/absent slide renders content+layout. */
  mode?: string;
  /** Freeform slides only — hand-positioned elements (the free-canvas geometry shape). */
  boxes?: Box[];
  bg?: string;
  theme?: string;
  logo?: string;
  media1?: AssetRef | null;
  media2?: AssetRef | null;
  media3?: AssetRef | null;
  media4?: AssetRef | null;
  notes?: string;
  [k: string]: unknown;
}

interface DeckInput { id: string; fields?: Array<{ id: string; type?: string }> }

interface DeckRuntime {
  getModel(): Array<{ id: string; value: unknown }>;
  setInput(id: string, value: unknown): Promise<void> | void;
  setInputNoHistory?(id: string, value: unknown): Promise<void> | void;
  subscribe(fn: () => void): () => void;
}

export interface InitDeckEditorOpts {
  viewEl: HTMLElement & { _cleanup?: () => void };
  stageEl: HTMLElement;
  canvasEl: HTMLElement;
  runtime: DeckRuntime;
  host: { assets?: { pick?: (...args: unknown[]) => Promise<unknown> } };
  input: DeckInput;
  inputs: Array<{ id: string; type?: string }>;
  nativeW?: number;
  nativeH?: number;
  onDirty?: (id: string) => void;
  editTool?: (toolUrl: string, mode?: string) => Promise<unknown>;
  history?: { undo?: () => void; redo?: () => void; register?: (sync: (u: boolean, r: boolean) => void) => void };
  actions?: { export?: () => void; save?: () => void; canSave?: boolean; dirtyRef?: HTMLElement | null };
}

export interface DeckEditorHandle { destroy(): void }

const OVERLAY_CLASS = 'deck-editor';
// Which media slots each layout shows, in order — mirrors SLOTS_FOR in the tool hook so a
// thumbnail lays out the same cells the real slide does.
const SLOTS_FOR: Record<string, string[]> = {
  title: [], full: ['media1'], hero: ['media1'],
  split: ['media1', 'media2'], stack: ['media1', 'media2'], golden: ['media1', 'media2'],
  cols3: ['media1', 'media2', 'media3'], grid4: ['media1', 'media2', 'media3', 'media4'],
};
const LAYOUTS = Object.keys(SLOTS_FOR);
const DEFAULT_BG = '#141b2d';
const MAX_SLIDES = 40;   // mirrors the tool hook's cap

// Static thumbnail scheme colours — mirror the tool hook's THEME_FALLBACK + schemeColors
// (community/deck-builder/hooks.js) so a themed slide's thumbnail reflects its scheme
// (light/dark/primary/accent) rather than collapsing to one swatch. The overlay can't resolve
// live brand tokens (only the hook can), so these are the blank/SUSE FALLBACK colours: exact on
// an un-branded profile, an honest approximation of the theme on a branded one.
const THUMB_SCHEMES: Record<string, { bg: string; ink: string }> = {
  auto:    { bg: '#ffffff', ink: '#172029' },
  brand:   { bg: '#ffffff', ink: '#172029' },
  light:   { bg: '#ffffff', ink: '#172029' },
  dark:    { bg: '#172029', ink: '#ffffff' },
  primary: { bg: '#30ba78', ink: '#ffffff' },
  accent:  { bg: '#2453ff', ink: '#ffffff' },
};

/** Contrasting ink for a background — the same white/dark pick the tool's idealInk makes,
 *  so a thumbnail's text is legible on its slide colour. */
function idealInk(hex: string): string {
  const s = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{3,8}$/.test(s)) return '#ffffff';
  const h = s.length === 3 ? s.replace(/(.)/g, '$1$1') : (s + '000000').slice(0, 6);
  const lin = (i: number): number => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return lum < 0.5 ? '#ffffff' : '#141b2d';
}

// ── pure helpers (exported for headless tests) ───────────────────────────────

/** A ref → its display URL, matching the tool hook's refUrl exactly. */
export function refUrl(r: unknown): string {
  return r && typeof r === 'object' && typeof (r as AssetRef).url === 'string' ? (r as AssetRef).url! : '';
}

const isHex = (s: string): boolean => /^#[0-9a-fA-F]{3,8}$/.test(s.trim());
const clampLayout = (v: unknown): string => (typeof v === 'string' && LAYOUTS.includes(v) ? v : 'title');
const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Turn a loose image value (a URL string, a catalog id, a {url}/{id} ref) into a ref the
 *  runtime resolves: an http(s)/data URL → {url} (passes through untouched, the hook reads
 *  .url); anything else that looks like an id → {id} (resolved via the catalog / tool-URL
 *  path). Empty → null (renders as the placeholder slot). */
export function toMediaRef(v: unknown): AssetRef | null {
  if (!v) return null;
  if (typeof v === 'object') {
    const r = v as AssetRef;
    if (typeof r.url === 'string' && r.url) return { url: r.url };
    if (typeof r.id === 'string' && r.id) return { id: r.id };
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^(https?:|data:)/i.test(s)) return { url: s };
  return { id: s };   // a catalog id or a Lolly tool link
}

/** Derive the slide's `content` markdown string from a loose object: an explicit `content`
 *  string wins; otherwise synthesise one from the legacy title/subtitle/body aliases as
 *  `# {title}` + a blank-line-separated body, so hand-written JSON that predates the content
 *  model still loads. Returns '' for an empty slide. */
export function deriveContent(o: Record<string, unknown>): string {
  if (typeof o.content === 'string') return o.content;
  const title = asText(o.title ?? o.heading);
  const body = asText(o.subtitle ?? o.body ?? o.text);
  const parts: string[] = [];
  if (title) parts.push('# ' + title);
  if (body) parts.push(body);
  return parts.join('\n\n');
}

/** Coerce one loose object into a defended slide record. Accepts common aliases so hand-
 *  written JSON is forgiving (image/img/media → media1; content OR title/subtitle/body →
 *  the `content` markdown string). `bg` defaults to '' — empty means "inherit the deck
 *  theme background", so a per-slide `bg` only overrides when explicitly a hex colour. */
export function coerceSlide(o: Record<string, unknown>): Slide {
  const bg = asText(o.bg ?? o.background);
  const media1 = toMediaRef(o.media1 ?? o.image ?? o.img ?? o.media ?? o.photo);
  const s: Slide = {
    layout: clampLayout(o.layout),
    content: deriveContent(o),
    bg: isHex(bg) ? bg : '',
    notes: asText(o.notes),
  };
  const theme = asText(o.theme), logo = asText(o.logo);
  if (theme) s.theme = theme;
  if (logo) s.logo = logo;
  if (media1) s.media1 = media1;
  const m2 = toMediaRef(o.media2), m3 = toMediaRef(o.media3), m4 = toMediaRef(o.media4);
  if (m2) s.media2 = m2; if (m3) s.media3 = m3; if (m4) s.media4 = m4;
  // A slide carrying images but no explicit layout reads better as a picture layout.
  if (s.layout === 'title' && media1 && !o.layout) s.layout = 'full';
  // Freeform mode + boxes are threaded through verbatim (defended). Only 'freeform' is a
  // real override — anything else means the default structured 'layout' experience.
  if (asText(o.mode) === 'freeform') s.mode = 'freeform';
  if (Array.isArray(o.boxes)) {
    const boxes = o.boxes.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object').map(coerceBox);
    if (boxes.length) s.boxes = boxes;
  }
  return s;
}

let boxSeq = 0;
/** A colour value (hex, with or without the leading #) → a safe `#rrggbb(aa)` or '' if not a
 *  hex. Accepts the hash-less 6-hex pptxgenjs uses. */
export function toHex(v: unknown): string {
  const s = asText(v).trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^[0-9a-fA-F]{6}$/.test(s) || /^[0-9a-fA-F]{3}$/.test(s) || /^[0-9a-fA-F]{8}$/.test(s)) return '#' + s;
  return '';
}
const SHAPE_NORM: Record<string, 'rect' | 'round' | 'pill' | 'ellipse'> = {
  rect: 'rect', square: 'rect', round: 'round', rounded: 'round', roundrect: 'round',
  pill: 'pill', stadium: 'pill', ellipse: 'ellipse', circle: 'ellipse', oval: 'ellipse',
};

/** Coerce a loose object into a defended freeform box (the SHARED box shape): id +
 *  kind:"text"|"image"|"box" + x/y/w/h numbers (px on the slide native canvas) + optional
 *  rot; text/color/fontSize/align for text, src for image, and fill/shape/radius/lineColor/
 *  lineWidth for a shape "box". Missing geometry defaults to a sensible size. */
export function coerceBox(o: Record<string, unknown>): Box {
  const rawKind = asText(o.kind);
  const kind = rawKind === 'image' ? 'image' : rawKind === 'box' ? 'box' : 'text';
  const b: Box = {
    id: asText(o.id) || ('bx' + (Date.now().toString(36).slice(-3)) + (boxSeq++).toString(36)),
    kind,
    x: num(o.x as never, 0), y: num(o.y as never, 0),
    w: Math.max(1, num(o.w as never, 600)), h: Math.max(1, num(o.h as never, 300)),
  };
  const rot = num(o.rot as never, 0); if (rot) b.rot = rot;
  if (kind === 'box') {
    // A filled shape (rect / rounded / pill / ellipse), used as a card/background layer. No
    // text or image of its own — text sits in separate boxes above it (array order = z-order).
    const fill = toHex(o.fill); if (fill) b.fill = fill;
    b.shape = SHAPE_NORM[asText(o.shape).toLowerCase()] || 'rect';
    if (o.radius != null) { const r = Math.max(0, num(o.radius as never, 0)); if (r) b.radius = r; }
    const lc = toHex(o.lineColor ?? o.stroke); if (lc) b.lineColor = lc;
    if (o.lineWidth != null || o.strokeWidth != null) { const lw = Math.max(0, num((o.lineWidth ?? o.strokeWidth) as never, 0)); if (lw) b.lineWidth = lw; }
  } else if (kind === 'text') {
    b.text = asText(o.text);
  } else if (o.src != null) {
    b.src = o.src as Box[string];
  } else {
    const ref = toMediaRef(o.image ?? o.url); if (ref) b.src = ref.url ?? ref.id;
  }
  if (typeof o.color === 'string' && o.color) b.color = o.color;
  if (o.fontSize != null && Number.isFinite(num(o.fontSize as never, NaN))) b.fontSize = num(o.fontSize as never, 0);
  // Accept both the compact 'l'/'c'/'r' the overlay writes AND the full words 'left'/
  // 'center'/'right' (what layout-studio-style tools + hand-written JSON use). The hook's
  // BOX_ALIGN map renders both, so normalise to the compact form for a stable stored value.
  const al = ALIGN_NORM[asText(o.align).toLowerCase()];
  if (al) b.align = al;
  return b;
}

const ALIGN_NORM: Record<string, 'l' | 'c' | 'r'> = {
  l: 'l', left: 'l', c: 'c', center: 'c', centre: 'c', r: 'r', right: 'r',
};

// ── layout → freeform conversion ("switch to freeform, keep the content") ─────────
// Turning a structured layout slide into a freeform canvas EXPLODES its content into
// positioned boxes: one text box holding the slide's `content` markdown placed where the
// layout paints its text, plus one image box per FILLED media slot placed on that layout's
// slot grid. So the user drops into freeform already holding their content and fine-tunes,
// rather than starting from a blank canvas. Fractions of the native canvas mirror the CSS
// grid in the tool's styles.css (a head band on top, the slot grid below), so a converted
// slide reads like the layout it came from.
interface Frac { x: number; y: number; w: number; h: number }
const FF_PAD = 0.055, FF_GAP = 0.03, FF_HEAD = 0.24;

/** The slot-grid cell rectangles (fractions) for a layout — mirrors SLOTS_FOR + the
 *  grid-template rules in styles.css (.sl-l-*). */
function gridCells(layout: string): Frac[] {
  const gx = FF_PAD, gw = 1 - 2 * FF_PAD;
  const gy = FF_PAD + FF_HEAD + FF_GAP, gh = 1 - gy - FF_PAD;
  const cols = (n: number, weights?: number[]): Frac[] => {
    const ws = weights ?? Array<number>(n).fill(1);
    const tot = ws.reduce((a, b) => a + b, 0);
    const cells: Frac[] = []; let cx = gx;
    for (let i = 0; i < n; i++) { const cw = (gw - FF_GAP * (n - 1)) * ws[i]! / tot; cells.push({ x: cx, y: gy, w: cw, h: gh }); cx += cw + FF_GAP; }
    return cells;
  };
  const rows = (n: number): Frac[] => {
    const cells: Frac[] = []; let cy = gy; const rh = (gh - FF_GAP * (n - 1)) / n;
    for (let i = 0; i < n; i++) { cells.push({ x: gx, y: cy, w: gw, h: rh }); cy += rh + FF_GAP; }
    return cells;
  };
  switch (layout) {
    case 'full':   return [{ x: 0, y: 0, w: 1, h: 1 }];
    case 'hero':   return [{ x: 0, y: FF_PAD + FF_HEAD + FF_GAP, w: 1, h: 1 - (FF_PAD + FF_HEAD + FF_GAP) }];
    case 'split':  return cols(2);
    case 'stack':  return rows(2);
    case 'golden': return cols(2, [1.618, 1]);
    case 'cols3':  return cols(3);
    case 'grid4': {
      const halfH = (gh - FF_GAP) / 2;
      const top = cols(2).map(c => ({ ...c, h: halfH }));
      const bot = top.map(c => ({ ...c, y: gy + halfH + FF_GAP }));
      return [top[0]!, top[1]!, bot[0]!, bot[1]!];
    }
    default:       return [];
  }
}

/** Where the text (title + body) sits for a layout — centred for `title`, a caption band
 *  at the foot for `full` (over the cover image), else the head band on top. */
function textRegion(layout: string): Frac {
  if (layout === 'title') return { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  if (layout === 'full') return { x: 0.04, y: 0.76, w: 0.92, h: 0.2 };
  return { x: FF_PAD, y: FF_PAD, w: 1 - 2 * FF_PAD, h: FF_HEAD };
}

/** Explode a layout slide into freeform boxes. Image boxes are pushed FIRST so a `full`
 *  slide's caption text lands ON TOP of its cover image (later boxes paint above). */
export function layoutToBoxes(slide: Slide, nativeW = 1920, nativeH = 1920): Box[] {
  const layout = clampLayout(slide.layout);
  const boxes: Box[] = [];
  const px = (f: Frac): Record<string, unknown> => ({
    x: Math.round(f.x * nativeW), y: Math.round(f.y * nativeH),
    w: Math.round(f.w * nativeW), h: Math.round(f.h * nativeH),
  });
  const slots = SLOTS_FOR[layout] ?? [];
  const cells = gridCells(layout);
  slots.forEach((field, i) => {
    const url = refUrl((slide as Record<string, unknown>)[field]);
    const cell = cells[i];
    if (url && cell) boxes.push(coerceBox({ kind: 'image', src: url, ...px(cell) }));
  });
  const content = asText(slide.content);
  if (content.trim()) {
    boxes.push(coerceBox({ kind: 'text', text: content, align: layout === 'title' ? 'c' : 'l', ...px(textRegion(layout)) }));
  }
  return boxes;
}

/** Parse a JSON deck: an array of slide objects, or { slides|deck: [...] }. Throws on
 *  malformed JSON so the caller can surface a clear error. */
export function parseJsonDeck(text: string): Slide[] {
  const data = JSON.parse(text);
  const rows: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { slides?: unknown[] })?.slides) ? (data as { slides: unknown[] }).slides
    : Array.isArray((data as { deck?: unknown[] })?.deck) ? (data as { deck: unknown[] }).deck
    : [];
  return rows
    .filter(r => r && typeof r === 'object')
    .slice(0, MAX_SLIDES)
    .map(r => coerceSlide(r as Record<string, unknown>));
}

/** Parse a Markdown deck (Marp/reveal convention): a line that is exactly `---` splits
 *  slides; the whole slide chunk — headings, prose, bullets, inline bold/italic markup — IS
 *  the slide's `content` markdown string (kept verbatim, no flattening). Standalone
 *  directive lines are peeled off first: `![alt](url)` becomes the slide image (media1) and
 *  `bg: #hex` / `layout: name` set those fields; everything else is preserved as content.
 *  Returns at least one slide. */
export function parseMarkdownDeck(text: string): Slide[] {
  let src = String(text).replace(/\r\n?/g, '\n');
  // Strip a leading YAML front-matter block (Marp / Jekyll / reveal): `---\n…\n---` at the very
  // top — otherwise its closing `---` reads as a slide separator and the metadata becomes a
  // bogus first slide ("marp: true", …).
  src = src.replace(/^﻿?[ \t]*\n?---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '');
  const chunks = src.split(/^[ \t]*---[ \t]*$/m).map(c => c.trim()).filter(Boolean);
  const slides = chunks.map((chunk): Slide => {
    const o: Record<string, unknown> = {};
    const contentLines: string[] = [];
    for (const raw of chunk.split('\n')) {
      const line = raw.trim();
      const bg = /^bg\s*:\s*(#[0-9a-fA-F]{3,8})\s*$/i.exec(line);
      const layoutDir = /^layout\s*:\s*([a-z0-9]+)\s*$/i.exec(line);
      const img = /^!\[[^\]]*\]\(([^)]+)\)\s*$/.exec(line);   // a line that is ONLY an image
      if (bg) { o.bg = bg[1]; continue; }
      if (layoutDir) { o.layout = layoutDir[1]; continue; }
      if (img) { if (o.image == null) o.image = img[1]; continue; }
      // an image embedded mid-prose still seeds the slot, but the line stays in content
      const inlineImg = /!\[[^\]]*\]\(([^)]+)\)/.exec(line);
      if (inlineImg && o.image == null) o.image = inlineImg[1];
      contentLines.push(raw);   // preserve the raw markdown (markup + indentation)
    }
    o.content = contentLines.join('\n').trim();
    if (o.image && o.layout == null) o.layout = 'full';
    return coerceSlide(o);
  });
  return slides.length ? slides : [coerceSlide({})];
}

/** The first `# heading`'s text from a content markdown string, inline formatting stripped —
 *  the slide's "title" line, used for thumbnails + accessible labels. '' if none. */
export function contentTitle(content: string): string {
  for (const raw of String(content).split('\n')) {
    // #{1,3} only — matches the tool hook's heading regex (hooks.js), so title detection
    // here agrees with what the tool actually renders as a heading (####+ is body text).
    const h = /^#{1,3}\s+(.*)$/.exec(raw.trim());
    if (h) return mdInlineToText(h[1]!);
  }
  return '';
}

/** The first non-heading, non-blank line of a content markdown string (a leading bullet
 *  marker dropped), inline formatting stripped — a one-line body preview. '' if none. */
export function contentBody(content: string): string {
  for (const raw of String(content).split('\n')) {
    const line = raw.trim();
    if (!line || /^#{1,3}\s+/.test(line)) continue;   // #{1,3} = heading (matches the tool hook)
    return mdInlineToText(line.replace(/^[-*+]\s+/, ''));
  }
  return '';
}

/** Strip the inline Markdown we don't yet render richly, down to plain text. */
function mdInlineToText(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // images (handled separately)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')    // links → their text
    .replace(/\*\*([^*]+)\*\*/g, '$1')          // bold
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')    // italic
    .replace(/`([^`]+)`/g, '$1')                // code
    .trim();
}

/** True when the pasted text is a pptxgenjs BUILDER SCRIPT (require/new pptxgen + slide-builder
 *  calls) rather than plain Markdown/JSON — so parseDeck runs it through the pptxgen importer. */
export function isPptxGenSource(t: string): boolean {
  return /require\(\s*['"]pptxgenjs['"]|new\s+[A-Za-z_$][\w$]*\s*\([^)]*\)|PptxGenJS/.test(t)
    && /\.addSlide\s*\(|\.addText\s*\(|\.addShape\s*\(/.test(t);
}

/** One text element's runs → the markdown a freeform text box stores (bold/italic marks; a
 *  run's breakLine becomes a newline). */
function runsToMarkdown(runs: TextRun[]): string {
  let md = '';
  for (const r of runs) {
    let t = asText(r.text);
    if (r.bold && t) t = '**' + t + '**';
    if (r.italic && t) t = '*' + t + '*';
    md += t;
    if (r.breakLine) md += '\n';
  }
  return md.replace(/\n+$/, '');
}

/** Import a pptxgenjs builder script as FREEFORM slides: each captured element becomes a
 *  positioned box — a shape → a `box`, an image → an `image`, text runs → a `text` box —
 *  with inches mapped onto the tool's 1920² native canvas (the pptxgen layout aspect and the
 *  deck's wide size match, so a single per-axis map keeps proportions). Colours/fonts get
 *  re-themed to the brand separately (brandifyDeck, at load time — it needs the host tokens). */
export function parsePptxGenDeck(source: string): Slide[] {
  const parsed = parsePptxGenJs(source);
  const NW = 1920;
  const wIn = parsed.layout.wIn || 13.333, hIn = parsed.layout.hIn || 7.5;
  const nx = (v: number): number => Math.round(inchesToNative(v, wIn, NW));   // x / width / radius (width axis)
  const ny = (v: number): number => Math.round(inchesToNative(v, hIn, NW));   // y / height (height axis)
  const npt = (pt: number): number => Math.round(inchesToNative(pt / 72, hIn, NW));   // points → native
  const slides = parsed.slides.slice(0, MAX_SLIDES).map((sl): Slide => {
    const boxes: Box[] = [];
    for (const el of sl.elements) {
      if (el.type === 'shape') {
        boxes.push(coerceBox({
          kind: 'box', x: nx(el.xIn), y: ny(el.yIn), w: nx(el.wIn), h: ny(el.hIn),
          fill: el.fill, shape: el.shape,
          radius: el.radius != null ? nx(el.radius) : undefined,
          lineColor: el.line?.color, lineWidth: el.line?.widthPt != null ? npt(el.line.widthPt) : undefined,
        }));
      } else if (el.type === 'image') {
        boxes.push(coerceBox({ kind: 'image', x: nx(el.xIn), y: ny(el.yIn), w: nx(el.wIn), h: ny(el.hIn), src: el.src }));
      } else {
        const first = el.runs[0];
        boxes.push(coerceBox({
          kind: 'text', x: nx(el.xIn), y: ny(el.yIn), w: nx(el.wIn), h: ny(el.hIn),
          text: runsToMarkdown(el.runs),
          color: first?.color, fontSize: first?.sizePt != null ? npt(first.sizePt) : undefined,
          align: el.align,
        }));
      }
    }
    const s: Slide = { mode: 'freeform', boxes };
    const bg = toHex(sl.background); if (bg) s.bg = bg;
    return s;
  });
  return slides.length ? slides : [coerceSlide({})];
}

/** Route paste text to the right parser: a pptxgenjs script → the pptxgen importer; JSON if it
 *  starts with { or [ ; else Markdown. */
export function parseDeck(text: string): Slide[] {
  const t = text.trim();
  if (isPptxGenSource(t)) return parsePptxGenDeck(t);
  return t.startsWith('{') || t.startsWith('[') ? parseJsonDeck(t) : parseMarkdownDeck(t);
}

/** Build a faithful mini-slide for a thumbnail: the SAME structure the tool renders — a
 *  header (title + subtitle) over a slot grid whose template is chosen by the layout —
 *  so the thumbnail shows the real composition (which layout, where the image sits, the
 *  slide colour + contrasting ink), not just a colour swatch. `data-layout` drives the
 *  per-layout grid template in deck-editor.css, mirroring the tool's .sl-l-* rules. */
export function buildThumbFace(slide: Slide, deckTheme = 'auto', resolved?: { bg: string; ink: string } | null): HTMLElement {
  const layout = typeof slide.layout === 'string' && SLOTS_FOR[slide.layout] ? slide.layout : 'title';
  // Prefer the ACTUAL rendered colours (read off the live slide's --bg/--ink by the caller) so
  // a brand-derived scheme — e.g. SUSE's green accent — matches the render exactly rather than
  // the static THUMB_SCHEMES approximation (which can't resolve brand tokens). Fall back to the
  // scheme: an explicit per-slide `bg` wins; else the slide/deck theme picks the scheme colours.
  const explicitBg = typeof slide.bg === 'string' && isHex(slide.bg) ? slide.bg : '';
  const slideTheme = typeof slide.theme === 'string' && slide.theme && slide.theme !== 'auto' ? slide.theme : deckTheme;
  const scheme = THUMB_SCHEMES[slideTheme] || THUMB_SCHEMES.auto!;
  const bg = resolved?.bg || explicitBg || scheme.bg;
  const face = document.createElement('div');
  face.className = 'deck-thumb__slide';
  face.dataset.layout = layout;
  face.style.background = bg;
  face.style.color = resolved?.ink || (explicitBg ? idealInk(bg) : scheme.ink);

  const content = asText(slide.content);
  const title = contentTitle(content), subtitle = contentBody(content);
  if (title || subtitle) {
    const head = document.createElement('div');
    head.className = 'deck-thumb__head';
    if (title) { const t = document.createElement('div'); t.className = 'deck-thumb__t-title'; t.textContent = title; head.appendChild(t); }
    if (subtitle) { const s = document.createElement('div'); s.className = 'deck-thumb__t-sub'; s.textContent = subtitle; head.appendChild(s); }
    face.appendChild(head);
  }

  const slots = SLOTS_FOR[layout]!;
  if (slots.length) {
    const grid = document.createElement('div');
    grid.className = 'deck-thumb__grid';
    for (const field of slots) {
      const url = refUrl((slide as Record<string, unknown>)[field]);
      const cell = document.createElement('div');
      cell.className = 'deck-thumb__slot' + (url ? ' is-filled' : '');
      if (url) {
        const im = document.createElement('img');
        im.className = 'deck-thumb__slot-img';
        im.src = url; im.alt = ''; im.loading = 'lazy';
        cell.appendChild(im);
      }
      grid.appendChild(cell);
    }
    face.appendChild(grid);
  }
  return face;
}

// ── rich-text: the slide `content` markdown subset ⇄ editable HTML (step 5) ────
// The on-canvas editor edits `content` as RICH TEXT but the stored value is a MARKDOWN
// STRING (the same subset the tool hook renders: `#`/`##`/`###` headings, `-`/`*` bullets,
// `**bold**`, `*italic*`). These two pure functions are the bridge — markdown → editable
// HTML on open, editable HTML → markdown on blur — so the round-trip is lossless for that
// subset and DOM-testable headlessly.

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One line's inline markdown (`**bold**` / `*italic*`) → HTML. Bold is consumed first so
 *  its `**` markers never leak into the italic pass. */
function inlineMdToHtml(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/** Markdown subset → the HTML shown in the contenteditable. Consecutive bullet lines fold
 *  into one `<ul>`; headings become `<h1..3>`; blank lines become empty paragraphs (so the
 *  paragraph structure round-trips); everything else is a `<p>`. */
export function mdToRichHtml(md: string): string {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let ul: string[] = [];
  const flushUl = (): void => { if (ul.length) { out.push('<ul>' + ul.join('') + '</ul>'); ul = []; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) { ul.push('<li>' + inlineMdToHtml(bullet[2]!) + '</li>'); continue; }
    flushUl();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { const lvl = heading[1]!.length; out.push(`<h${lvl}>` + inlineMdToHtml(heading[2]!) + `</h${lvl}>`); continue; }
    if (line.trim() === '') { out.push('<p><br></p>'); continue; }
    out.push('<p>' + inlineMdToHtml(line) + '</p>');
  }
  flushUl();
  return out.join('');
}

/** One inline element's children → markdown (`<strong>`→`**`, `<em>`→`*`, `<br>`→newline). */
function inlineHtmlToMd(el: Node): string {
  let s = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) { s += node.nodeValue || ''; continue; }
    if (node.nodeType !== 1) continue;
    const c = node as HTMLElement;
    const tag = c.tagName.toUpperCase();
    // A soft break (Shift+Enter, or a browser's in-block <br>) is real content — emit a
    // newline, don't drop it, or adjacent lines mash into one word-run on save.
    if (tag === 'BR') { s += '\n'; continue; }
    const inner = inlineHtmlToMd(c);
    if (tag === 'STRONG' || tag === 'B') s += '**' + inner + '**';
    else if (tag === 'EM' || tag === 'I') s += '*' + inner + '*';
    else s += inner;
  }
  return s;
}

/** The contenteditable's HTML → the stored markdown-subset string. Block children map back:
 *  `<h1..3>`→`#…`, `<ul>/<ol>`→`- `/`N. ` list lines, `<p>/<div>`→a plain line. Trailing
 *  empty lines (a browser's stray final paragraph) are trimmed. */
export function richHtmlToMd(root: HTMLElement): string {
  const blocks: string[] = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) { const txt = (node.nodeValue || '').trim(); if (txt) blocks.push(txt); continue; }
    if (node.nodeType !== 1) continue;
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (/^H[1-6]$/.test(tag)) {
      const lvl = Math.min(3, Number(tag[1]));
      blocks.push('#'.repeat(lvl) + ' ' + inlineHtmlToMd(el));
    } else if (tag === 'UL' || tag === 'OL') {
      let n = 1;
      for (const li of Array.from(el.children)) {
        if (li.tagName.toUpperCase() !== 'LI') continue;
        blocks.push((tag === 'OL' ? (n++ + '. ') : '- ') + inlineHtmlToMd(li));
      }
    } else if (tag === 'LI') {
      blocks.push('- ' + inlineHtmlToMd(el));
    } else {
      // p / div / anything block-level. A paragraph that is ONLY a soft break (an empty
      // <p><br></p>, the browser's blank-line marker) collapses to an empty block = the
      // blank-line separator; a paragraph with real content keeps its internal <br> newlines.
      const md = inlineHtmlToMd(el);
      blocks.push(md.trim() === '' ? '' : md);
    }
  }
  while (blocks.length && blocks[blocks.length - 1] === '') blocks.pop();
  return blocks.join('\n');
}

// ── the overlay ──────────────────────────────────────────────────────────────

export function initDeckEditor(opts: InitDeckEditorOpts): DeckEditorHandle {
  const { stageEl, input, runtime, onDirty } = opts;

  stageEl.querySelectorAll(`.${OVERLAY_CLASS}`).forEach(n => n.remove());

  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.setAttribute('data-deck-editor', '');

  // model access ----------------------------------------------------------------
  const readDeck = (): Slide[] => {
    const v = runtime.getModel().find(i => i.id === input.id)?.value;
    return Array.isArray(v) ? (v as Slide[]) : [];
  };
  const activeIndex = (): number => {
    const f = Number(runtime.getModel().find(i => i.id === 'focusSlide')?.value) || 0;
    return f > 0 ? f - 1 : 0;
  };
  const commitDeck = (next: Slide[]): void => {
    onDirty?.(input.id);
    runtime.setInput(input.id, next);
  };

  // Re-theme an imported deck's colours to the active brand: snap every box fill / text colour /
  // stroke / slide background to the nearest brand token (host.tokens). This is how a pptxgen
  // import "forms in our tokens" — its bespoke palette collapses onto the brand's. Fonts follow
  // automatically because the tool renders freeform text in the brand font. No brand tokens (or
  // a headless host) → the deck keeps its original colours untouched.
  async function brandifyDeck(slides: Slide[]): Promise<Slide[]> {
    let brand: Array<{ name: string; hex: string }> = [];
    try {
      const tk = (opts.host as { tokens?: { colors?: (o: unknown) => Promise<Array<{ path?: string; value?: string }>> } }).tokens;
      const sw = tk?.colors ? await tk.colors({ theme: 'light' }) : [];
      brand = (sw || []).map(s => ({ name: asText(s.path), hex: toHex(s.value) })).filter(b => !!b.hex);
    } catch { /* no brand tokens available */ }
    if (!brand.length) return slides;
    // Snap through the engine's brand mapper (Fable track E3): perceptual ΔEOK with a CHROMA GATE,
    // so a slate greys to a brand grey instead of jumping to the nearest saturated accent, and a
    // chromatic source never collapses to a neutral. Falls back to the source when unmappable.
    const snap = (v: unknown): string | undefined => {
      const h = toHex(v);
      if (!h) return typeof v === 'string' ? v : undefined;
      return nearestBrandColor(h, brand)?.hex ?? h;
    };
    return slides.map(s => {
      const out: Slide = { ...s };
      if (s.bg) out.bg = snap(s.bg);
      if (Array.isArray(s.boxes)) {
        out.boxes = (s.boxes as Box[]).map(b => {
          const nb: Box = { ...b };
          if (b.fill) nb.fill = snap(b.fill);
          if (b.color) nb.color = snap(b.color);
          if (b.lineColor) nb.lineColor = snap(b.lineColor);
          return nb;
        });
      }
      return out;
    });
  }
  // Navigation stays OUT of undo history (setInputNoHistory) so slide-hopping doesn't
  // bury real edits in the undo stack.
  // Expand the sidebar block that authors slide `i` (accordion: fold every other block), so the
  // active slide's fields are open to edit as you move through the filmstrip. Reaches into the
  // shell's blocks-input by its stable [data-block-index] contract; NEVER moves focus (so the
  // filmstrip's own arrow-key navigation keeps working). No-op when the sidebar isn't present.
  const expandSidebarBlock = (i: number): void => {
    try {
      const blocksEl = opts.viewEl.querySelector<HTMLElement>('.blocks-input[data-input-id="' + input.id + '"]');
      if (!blocksEl) return;
      const items = Array.from(blocksEl.querySelectorAll<HTMLElement>('.block-item.is-typed'));
      const target = items.find(b => b.dataset.blockIndex === String(i));
      if (!target) return;
      for (const b of items) {
        const collapse = b !== target;
        if (b.classList.contains('is-collapsed') !== collapse) {
          b.classList.toggle('is-collapsed', collapse);
          const btn = b.querySelector('[data-block-collapse]');
          btn?.setAttribute('aria-label', collapse ? 'Expand block' : 'Collapse block');
          btn?.setAttribute('title', collapse ? 'Expand' : 'Collapse');
        }
      }
      target.closest('details.input-section')?.setAttribute('open', '');
      // Scroll the sidebar so the just-opened block is in view (the accordion above it just
      // collapsed, so its position moved) — deferred a frame to let that relayout settle.
      requestAnimationFrame(() => { try { target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* jsdom */ } });
    } catch { /* sidebar not present (headless) */ }
  };

  const setActive = (i: number): void => {
    const deck = readDeck();
    const clamped = Math.max(0, Math.min(deck.length - 1, i));
    (runtime.setInputNoHistory ?? runtime.setInput)('focusSlide', clamped + 1);
    expandSidebarBlock(clamped);
  };

  // active-slide helpers (shared by the toolbar, the text editor + the free-canvas) ------
  const clampedActive = (): number => {
    const deck = readDeck();
    return Math.max(0, Math.min(deck.length - 1, activeIndex()));
  };
  const activeSlide = (): Slide | undefined => readDeck()[clampedActive()];
  // Clone-and-commit a patch onto the ACTIVE slide (the shared shell-side write-back path:
  // read the live deck, clone, mutate deck[i].<field>, setInput("deck", arr) + onDirty).
  // Commit a patch to a SPECIFIC slide index (not necessarily the active one). Used by the
  // deferred text-edit commits, which must land on the slide the editor was OPENED on even if
  // the user has since navigated away (else the edit overwrites the wrong slide).
  const commitSlideAt = (i: number, patch: Partial<Slide>): void => {
    const deck = readDeck().slice();
    if (!deck[i]) return;
    deck[i] = { ...deck[i], ...patch } as Slide;
    commitDeck(deck);
  };
  const commitSlide = (patch: Partial<Slide>): void => commitSlideAt(clampedActive(), patch);
  const commitBoxesAt = (i: number, boxes: Box[]): void => commitSlideAt(i, { boxes });
  const commitBoxes = (boxes: Box[]): void => commitSlide({ boxes });

  // Native(box-space px) ↔ screen mapping, read off the LIVE canvas rect each call so a
  // repaint/resize is picked up (the overlays reposition on every model commit — subscribe).
  // ANISOTROPIC: boxes live in a fixed nativeW×nativeH space (the tool's 1920×1920), and the
  // hook places each as a % of that space applied to the REAL slide rect — so a wide (16:9)
  // slide squishes Y/height vs X/width. We must use the SAME per-axis scale or the overlay
  // frames drift below + taller than the rendered content (the "duplicated, off-size" bug).
  interface Metrics { cr: DOMRect; sr: DOMRect; scaleX: number; scaleY: number }
  const canvasMetrics = (): Metrics => {
    const cr = opts.canvasEl.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    const nw = opts.nativeW || 1920, nh = opts.nativeH || 1920;
    const scaleX = cr.width > 0 && nw > 0 ? cr.width / nw : 1;
    const scaleY = cr.height > 0 && nh > 0 ? cr.height / nh : 1;
    return { cr, sr, scaleX, scaleY };
  };

  // slide toolbar (step 7) + free-canvas layer (step 6) — created up front, (re)populated
  // by renderBar()/renderFree() on every model change.
  const bar = document.createElement('div');
  bar.className = 'deck-bar';
  bar.setAttribute('data-export-hide', '');
  overlay.appendChild(bar);

  const free = document.createElement('div');
  free.className = 'deck-free';
  free.setAttribute('data-export-hide', '');
  free.hidden = true;
  overlay.appendChild(free);

  // ── slide toolbar (step 7) ────────────────────────────────────────────────────
  const DECK_THEMES = ['auto', 'light', 'dark', 'primary', 'accent'];
  const SLIDE_LOGOS = ['auto', 'mono', 'off'];
  const MODES = ['layout', 'freeform'];
  const cap1 = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

  // Friendly labels for the on-canvas layout picker (mirrors the manifest's layout option
  // labels — makeSelect's default cap1 would render 'cols3'/'grid4' unhelpfully).
  const LAYOUT_LABELS: Record<string, string> = {
    title: 'Title only', full: 'Full bleed', hero: 'Hero + title', split: 'Side by side',
    stack: 'Stacked', golden: 'Golden ratio', cols3: 'Three columns', grid4: 'Four grid',
  };

  function makeSelect(cls: string, label: string, choices: string[], value: string, onChange: (v: string) => void, labelOf: (v: string) => string = cap1): HTMLLabelElement {
    const wrap = document.createElement('label');
    wrap.className = 'deck-bar__field';
    const capEl = document.createElement('span'); capEl.className = 'deck-bar__cap'; capEl.textContent = label;
    const sel = document.createElement('select'); sel.className = cls;
    for (const o of choices) { const op = document.createElement('option'); op.value = o; op.textContent = labelOf(o); sel.appendChild(op); }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    wrap.append(capEl, sel);
    return wrap;
  }

  function renderBar(): void {
    bar.textContent = '';
    const slide = activeSlide();
    const deckTheme = String(runtime.getModel().find(i => i.id === 'theme')?.value ?? 'auto') || 'auto';
    const slideTheme = asText(slide?.theme), slideLogo = asText(slide?.logo);
    const mode = asText(slide?.mode) === 'freeform' ? 'freeform' : 'layout';

    // Deck theme is GLOBAL — committed via setInput("theme", …), never through the deck clone.
    bar.appendChild(makeSelect('deck-bar__sel deck-bar__deck-theme', 'Deck theme',
      DECK_THEMES, DECK_THEMES.includes(deckTheme) ? deckTheme : 'auto',
      (v) => { onDirty?.('theme'); runtime.setInput('theme', v); }));
    // On-canvas slide LAYOUT picker — layout mode only (freeform has no template). Mirrors
    // the sidebar's layout sub-field so the primary flow (pick the slide's shape right on
    // the canvas) never needs the sidebar.
    if (mode !== 'freeform') {
      const slideLayout = asText(slide?.layout);
      bar.appendChild(makeSelect('deck-bar__sel deck-bar__slide-layout', 'Layout',
        LAYOUTS, LAYOUTS.includes(slideLayout) ? slideLayout : 'title',
        (v) => commitSlide({ layout: v }), (v) => LAYOUT_LABELS[v] ?? cap1(v)));
    }
    // Per-slide theme / logo / mode — each clone-and-commits the active slide.
    bar.appendChild(makeSelect('deck-bar__sel deck-bar__slide-theme', 'Slide theme',
      DECK_THEMES, DECK_THEMES.includes(slideTheme) ? slideTheme : 'auto',
      (v) => commitSlide({ theme: v })));
    bar.appendChild(makeSelect('deck-bar__sel deck-bar__slide-logo', 'Logo',
      SLIDE_LOGOS, SLIDE_LOGOS.includes(slideLogo) ? slideLogo : 'auto',
      (v) => commitSlide({ logo: v })));
    // Mode: switching a layout slide to freeform EXPLODES its content into positioned boxes
    // (layoutToBoxes) so the user keeps their content — but only when the slide has no boxes
    // yet, so flipping back and forth never clobbers a canvas they've already arranged.
    bar.appendChild(makeSelect('deck-bar__sel deck-bar__slide-mode', 'Mode',
      MODES, mode, (v) => {
        if (v === 'freeform') {
          const s = activeSlide();
          const hasBoxes = Array.isArray(s?.boxes) && (s!.boxes as Box[]).length > 0;
          if (s && !hasBoxes) { commitSlide({ mode: 'freeform', boxes: layoutToBoxes(s, opts.nativeW, opts.nativeH) }); return; }
        }
        commitSlide({ mode: v });
      }));

    // Edit-text opens the on-canvas rich editor — layout mode only (freeform edits text
    // per-box: double-click a text box in the canvas).
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'deck-bar__edit';
    editBtn.textContent = 'Edit text';
    editBtn.disabled = mode === 'freeform';
    editBtn.addEventListener('click', () => openTextEditor());
    bar.appendChild(editBtn);
  }

  // ── on-canvas rich-text editor (step 5) ────────────────────────────────────────
  let textEditor: HTMLElement | null = null;
  let textEditorSlideIdx = -1;   // slide the layout editor was opened on (deferred-commit target)
  const onEditorKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); closeTextEditor(true); }
  };
  function closeTextEditor(commit: boolean): void {
    if (!textEditor) return;
    const area = textEditor.querySelector<HTMLElement>('.deck-text__area');
    if (commit && area) {
      const md = richHtmlToMd(area);
      // Commit to the slide the editor was OPENED on (a focusout can fire after the user has
      // navigated to another slide — writing to the live active slide would overwrite it).
      if (md !== asText(readDeck()[textEditorSlideIdx]?.content)) commitSlideAt(textEditorSlideIdx, { content: md });
    }
    textEditor.remove();
    textEditor = null;
    document.removeEventListener('keydown', onEditorKey, true);
  }
  function positionTextEditor(): void {
    if (!textEditor) return;
    const m = canvasMetrics();
    textEditor.style.left = (m.cr.left - m.sr.left) + 'px';
    textEditor.style.top = (m.cr.top - m.sr.top) + 'px';
    textEditor.style.width = m.cr.width + 'px';
    textEditor.style.height = m.cr.height + 'px';
  }
  function openTextEditor(): void {
    if (textEditor) { closeTextEditor(true); return; }
    const slide = activeSlide();
    if (!slide || asText(slide.mode) === 'freeform') return;
    textEditorSlideIdx = clampedActive();
    const wrap = document.createElement('div');
    wrap.className = 'deck-text';
    const area = document.createElement('div');
    area.className = 'deck-text__area';
    area.contentEditable = 'true';
    area.setAttribute('role', 'textbox');
    area.setAttribute('aria-multiline', 'true');
    area.setAttribute('aria-label', 'Slide text');
    area.innerHTML = mdToRichHtml(asText(slide.content));
    const exec = (c: string, val?: string): void => { try { document.execCommand(c, false, val); } catch { /* jsdom / unsupported */ } area.focus(); };
    const fmt = document.createElement('div');
    fmt.className = 'deck-text__bar';
    const cmd = (label: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'deck-text__btn'; b.textContent = label; b.title = label;
      b.addEventListener('pointerdown', (e) => e.preventDefault());   // keep the editable's selection
      b.addEventListener('click', run);
      return b;
    };
    fmt.append(
      cmd('H1', () => exec('formatBlock', 'h1')),
      cmd('H2', () => exec('formatBlock', 'h2')),
      cmd('B', () => exec('bold')),
      cmd('I', () => exec('italic')),
      cmd('•', () => exec('insertUnorderedList')),
    );
    wrap.append(fmt, area);
    // Commit + close when focus leaves the editor entirely (blur to another app control).
    wrap.addEventListener('focusout', () => {
      setTimeout(() => { if (textEditor && !textEditor.contains(document.activeElement)) closeTextEditor(true); }, 0);
    });
    overlay.appendChild(wrap);
    textEditor = wrap;
    positionTextEditor();
    document.addEventListener('keydown', onEditorKey, true);
    area.focus();
  }

  // ── per-slide free-canvas (step 6+) ────────────────────────────────────────────
  // A layout-studio-grade editor over the ACTIVE freeform slide's boxes, reusing the shared,
  // tested geometry in free-canvas-math (move/resize/rotate/align/distribute/z-order/marquee/
  // snap). Multi-select (shift/⌘-click + marquee), a group bounding box with a rotate handle,
  // snap guides, arrow-nudge and copy/paste. All writes clone-and-commit deck[i].boxes.
  const SNAP_SCREEN = 6;   // snap tolerance in SCREEN px (converted to native per gesture)
  let selection = new Set<number>();
  let primary = -1;        // the single box whose resize/rotate handles show
  let lastActiveIdx = -1;  // active slide at the last render — a change resets the selection
  let boxEls: HTMLElement[] = [];
  let guidesLayer: HTMLElement | null = null;
  let marqueeEl: HTMLElement | null = null;
  let clipboard: Box[] = [];
  interface Gesture {
    type: 'move' | 'resize' | 'rotate' | 'marquee';
    idx: number;
    handle?: HandleName;
    indices: number[];
    startClient: { x: number; y: number };
    startBoxes: Box[];
    startRect?: Rect;
    centre?: { x: number; y: number };
    startAngle?: number;
    marqueeBase?: Set<number>;
    marqueeOrigin?: { x: number; y: number };
    plainClick?: boolean;   // a non-additive pointerdown (candidate for click-through collapse)
    moved?: boolean;        // the pointer actually dragged (so it wasn't just a click)
    scaleX: number;
    scaleY: number;
    live: Box[];
  }
  let gesture: Gesture | null = null;
  const selIndices = (): number[] => [...selection].sort((a, b) => a - b);
  const idOf = (b: Box | undefined): string => (b && typeof b.id === 'string' ? b.id : '');
  // Re-point the selection at box IDS after an op reorders/removes boxes, so highlight +
  // subsequent ops follow the same boxes rather than stale indices.
  const setSelByIds = (boxes: Box[], ids: string[]): void => {
    selection = new Set(ids.map(id => boxes.findIndex(b => idOf(b) === id)).filter(i => i >= 0));
    primary = selection.size === 1 ? selIndices()[0]! : -1;
  };
  // Freeform text-box edit state: which box (if any) is open as a live contenteditable, plus
  // a stored commit closure so a click elsewhere can flush it. And a pointerdown timestamp for
  // double-click detection (the dblclick EVENT is unreliable — selecting rebuilds the box DOM
  // between the two clicks — so we detect it from two quick pointerdowns on the same box).
  let editingBox = -1;
  let boxEditCommit: (() => void) | null = null;
  let lastDown = { idx: -1, t: 0 };
  const activeBoxes = (): Box[] => { const b = activeSlide()?.boxes; return Array.isArray(b) ? b : []; };

  function positionBoxEls(boxes: Box[], scaleX: number, scaleY: number): void {
    for (let i = 0; i < boxEls.length; i++) {
      const box = boxes[i]; const el = boxEls[i];
      if (!box || !el) continue;
      const r = boxRect(box, BOX_CFG);
      el.style.left = (r.x * scaleX) + 'px';
      el.style.top = (r.y * scaleY) + 'px';
      el.style.width = (r.w * scaleX) + 'px';
      el.style.height = (r.h * scaleY) + 'px';
      el.style.transform = r.rot ? `rotate(${r.rot}deg)` : '';
    }
  }

  // The overlay box is a TRANSPARENT interactive frame that sits ON TOP of the tool hook's
  // live render — it draws NO image/text of its own (that would duplicate the rendered content
  // and, on any coordinate drift, show a second mis-placed copy). It carries only the frame +
  // selection handles; a text box's editable is populated on demand while editing.
  function buildBoxEl(box: Box, i: number): HTMLElement {
    const el = document.createElement('div');
    const kindCls = box.kind === 'image' ? ' deck-free-box--img' : box.kind === 'box' ? ' deck-free-box--shape' : ' deck-free-box--text';
    el.className = 'deck-free-box' + (selection.has(i) ? ' is-sel' : '') + kindCls;
    el.dataset.idx = String(i);
    if (box.kind === 'image') {
      const src = typeof box.src === 'string' ? box.src : refUrl(box.src);
      // Empty image box: the hook renders nothing, so show a hint + a faint fill; a filled box
      // stays transparent so the hook's picture shows through the frame.
      if (!src) { el.classList.add('is-empty'); const hint = document.createElement('span'); hint.className = 'deck-free-box__hint'; hint.textContent = 'Double-click to add an image'; el.appendChild(hint); }
    } else if (box.kind === 'box') {
      // A shape: the hook renders the fill/stroke beneath; the overlay is only the transparent
      // interactive frame (drag / resize / rotate). No content of its own.
    } else {
      // Empty transparent text host — the hook renders the text beneath; startBoxTextEdit fills
      // this node (and makes it opaque) only while the box is being edited.
      const tx = document.createElement('div');
      tx.className = 'deck-free-box__text';
      el.appendChild(tx);
    }
    el.addEventListener('pointerdown', (e) => startMove(e as PointerEvent, i));
    // Resize + rotate handles show only for a SINGLE selected box (a multi-selection gets
    // the group bounding box's rotate handle instead — see renderFree).
    if (selection.size === 1 && i === primary) {
      for (const h of HANDLES) {
        const hd = document.createElement('div');
        hd.className = 'deck-free-h deck-free-h--' + h;
        hd.dataset.handle = h;
        hd.addEventListener('pointerdown', (e) => startResize(e as PointerEvent, i, h));
        el.appendChild(hd);
      }
      const rot = document.createElement('div');
      rot.className = 'deck-free-rot';
      rot.title = 'Rotate';
      rot.addEventListener('pointerdown', (e) => startRotate(e as PointerEvent));
      el.appendChild(rot);
    }
    return el;
  }

  function buildToolbar(): HTMLElement {
    const tools = document.createElement('div');
    tools.className = 'deck-free__tools';
    const hasSel = selection.size > 0;
    const btn = (label: string, title: string, cls: string, run: () => void, disabled = false, svg?: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'deck-free__btn' + cls; b.title = title; b.disabled = disabled;
      if (svg) { b.innerHTML = svg; b.setAttribute('aria-label', title); } else b.textContent = label;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());   // a toolbar click never starts a marquee
      b.addEventListener('click', run);
      return b;
    };
    const grp = (...kids: HTMLElement[]): HTMLElement => { const g = document.createElement('div'); g.className = 'deck-free__grp'; g.append(...kids); return g; };
    tools.append(
      grp(
        btn('+ Text', 'Add a text box', '', () => addBox('text')),
        btn('+ Image', 'Add an image box', '', () => addBox('image')),
        btn('+ Shape', 'Add a shape', '', () => addBox('box')),
      ),
      grp(
        btn('', 'Align left', ' deck-free__btn--icon', () => doAlign('left'), !hasSel, icon('alignL')),
        btn('', 'Align centre', ' deck-free__btn--icon', () => doAlign('hcentre'), !hasSel, icon('alignC')),
        btn('', 'Align right', ' deck-free__btn--icon', () => doAlign('right'), !hasSel, icon('alignR')),
        btn('', 'Align top', ' deck-free__btn--icon', () => doAlign('top'), !hasSel, icon('alignT')),
        btn('', 'Align middle', ' deck-free__btn--icon', () => doAlign('vcentre'), !hasSel, icon('alignM')),
        btn('', 'Align bottom', ' deck-free__btn--icon', () => doAlign('bottom'), !hasSel, icon('alignB')),
      ),
      grp(
        btn('', 'Distribute horizontally', ' deck-free__btn--icon', () => doDistribute('h'), selection.size < 3, icon('distH')),
        btn('', 'Distribute vertically', ' deck-free__btn--icon', () => doDistribute('v'), selection.size < 3, icon('distV')),
      ),
      grp(
        btn('', 'Bring to front', ' deck-free__btn--icon', () => doZ('front'), !hasSel, icon('orderFront')),
        btn('', 'Bring forward', ' deck-free__btn--icon', () => doZ('forward'), !hasSel, icon('orderForward')),
        btn('', 'Send backward', ' deck-free__btn--icon', () => doZ('backward'), !hasSel, icon('orderBackward')),
        btn('', 'Send to back', ' deck-free__btn--icon', () => doZ('back'), !hasSel, icon('orderBack')),
      ),
      grp(btn('Delete', 'Delete selection', ' deck-free__btn--del', () => deleteBox(), !hasSel)),
    );
    return tools;
  }

  function renderFree(): void {
    const isFree = asText(activeSlide()?.mode) === 'freeform';
    free.hidden = !isFree;
    free.textContent = '';
    boxEls = []; guidesLayer = null; marqueeEl = null;
    // Box indices are PER-SLIDE, so a stale selection carried across a slide change would
    // highlight — and drive Delete/align/nudge on — the wrong boxes. Reset it whenever the
    // active slide changes (navigation), not just when the deck shrinks under it.
    const ai = clampedActive();
    if (ai !== lastActiveIdx) { selection = new Set(); primary = -1; lastActiveIdx = ai; }
    if (!isFree) { selection = new Set(); primary = -1; return; }
    const m = canvasMetrics();
    free.style.left = (m.cr.left - m.sr.left) + 'px';
    free.style.top = (m.cr.top - m.sr.top) + 'px';
    free.style.width = m.cr.width + 'px';
    free.style.height = m.cr.height + 'px';

    const boxes = activeBoxes();
    // Drop any stale selection indices (a load/undo can shrink the deck), then re-derive primary.
    selection = new Set(selIndices().filter(i => i < boxes.length));
    primary = selection.size === 1 ? selIndices()[0]! : -1;

    // A full-cover background BELOW the boxes catches empty-canvas marquee-drags + deselect.
    const bg = document.createElement('div');
    bg.className = 'deck-free__bg';
    bg.addEventListener('pointerdown', (e) => startMarquee(e as PointerEvent));
    free.appendChild(bg);
    free.appendChild(buildToolbar());

    boxes.forEach((box, i) => { const el = buildBoxEl(box, i); free.appendChild(el); boxEls[i] = el; });

    // A group bounding box (with a rotate handle) frames a multi-selection.
    if (selection.size > 1) {
      const aabb = selectionAABB(boxes, selIndices(), BOX_CFG);
      if (aabb) {
        const bbox = document.createElement('div');
        bbox.className = 'deck-free-bbox';
        bbox.style.left = (aabb.minX * m.scaleX) + 'px';
        bbox.style.top = (aabb.minY * m.scaleY) + 'px';
        bbox.style.width = (aabb.w * m.scaleX) + 'px';
        bbox.style.height = (aabb.h * m.scaleY) + 'px';
        const rot = document.createElement('div');
        rot.className = 'deck-free-rot';
        rot.title = 'Rotate selection';
        rot.addEventListener('pointerdown', (e) => startRotate(e as PointerEvent));
        bbox.appendChild(rot);
        free.appendChild(bbox);
      }
    }

    guidesLayer = document.createElement('div');
    guidesLayer.className = 'deck-free__guides';
    free.appendChild(guidesLayer);

    positionBoxEls(boxes, m.scaleX, m.scaleY);
  }

  function addBox(kind: 'text' | 'image' | 'box'): void {
    const boxes = activeBoxes().slice();
    const nw = opts.nativeW || 1920, nh = opts.nativeH || 1080;
    const w = Math.round(nw * 0.4), h = Math.round(nh * 0.2);
    const seed: Record<string, unknown> = { kind, x: Math.round((nw - w) / 2), y: Math.round((nh - h) / 2), w, h };
    if (kind === 'text') seed.text = 'Text';
    else if (kind === 'box') { seed.shape = 'round'; seed.radius = Math.round(nw * 0.02); seed.fill = '#cfd8dc'; }
    boxes.push(coerceBox(seed));
    const at = boxes.length - 1;
    selection = new Set([at]); primary = at;
    commitBoxes(boxes);
    // A new image box is empty — go straight to the picker so "+ Image" is one gesture.
    if (kind === 'image') void pickBoxImage(at);
  }
  function deleteBox(): void {
    if (!selection.size) return;
    const del = new Set(selIndices());
    const boxes = activeBoxes().filter((_, i) => !del.has(i));
    selection = new Set(); primary = -1;
    commitBoxes(boxes);
  }

  // ── arrange ops (align / distribute / z-order) — all operate on the selection ─────
  function doAlign(edge: AlignEdge): void {
    if (!selection.size) return;
    const nw = opts.nativeW || 1920, nh = opts.nativeH || 1920;
    commitBoxes(alignBoxes(activeBoxes().slice(), selIndices(), edge, BOX_CFG, { w: nw, h: nh }));
  }
  function doDistribute(axis: Axis): void {
    if (selection.size < 3) return;
    commitBoxes(distributeBoxes(activeBoxes().slice(), selIndices(), axis, BOX_CFG));
  }
  function doZ(op: ZOp): void {
    if (!selection.size) return;
    const ids = selIndices().map(i => idOf(activeBoxes()[i])).filter(Boolean);
    const boxes = reorderZ(activeBoxes().slice(), selIndices(), op);
    setSelByIds(boxes, ids);   // reordering moves the boxes — keep the selection on them
    commitBoxes(boxes);
  }

  // Open a text box for in-place rich-text editing: the box's rendered `.deck-free-box__text`
  // (already showing mdToRichHtml(box.text)) becomes contenteditable; on blur / Escape /
  // Cmd+Enter it serialises back to the box's markdown `text` via richHtmlToMd. One box at a
  // time; boxEditCommit lets a click elsewhere flush it first.
  function startBoxTextEdit(idx: number, boxEl: HTMLElement): void {
    const tx = boxEl.querySelector<HTMLElement>('.deck-free-box__text');
    if (!tx) return;
    editingBox = idx;
    const editSlideIdx = clampedActive();   // the deferred commit lands HERE, even if the user navigates away
    selection = new Set([idx]); primary = idx;
    const box = activeBoxes()[idx];
    tx.innerHTML = mdToRichHtml(asText(box?.text));
    tx.setAttribute('contenteditable', 'true');
    tx.setAttribute('role', 'textbox');
    tx.setAttribute('aria-label', 'Box text');
    tx.style.pointerEvents = 'auto';
    boxEl.classList.add('is-editing');
    const range = document.createRange(); range.selectNodeContents(tx);
    // Reach the window via document.defaultView (present in browsers AND jsdom) rather than a
    // global `window`, so selecting-all never throws where no global window exists.
    const sel = document.defaultView?.getSelection?.(); sel?.removeAllRanges(); sel?.addRange(range);
    tx.focus();
    let done = false;
    const commit = (): void => {
      if (done) return; done = true;
      tx.removeEventListener('blur', onBlur); tx.removeEventListener('keydown', onKey);
      boxEditCommit = null;
      editingBox = -1;
      const md = richHtmlToMd(tx);
      const slideBoxes = readDeck()[editSlideIdx]?.boxes;
      const boxes = Array.isArray(slideBoxes) ? slideBoxes.slice() : [];
      if (boxes[idx] && asText(boxes[idx]!.text) !== md) { boxes[idx] = { ...boxes[idx]!, text: md }; commitBoxesAt(editSlideIdx, boxes); }
      else { boxEl.classList.remove('is-editing'); renderFree(); }
    };
    // Commit on blur, but DEFERRED: a click on another box, or a browser that blurs on an
    // innerHTML change, must not pre-empt an Escape / Cmd+Enter with stale content (mirrors
    // the layout text editor's focusout timing). The guard skips it once already committed.
    function onBlur(): void { setTimeout(() => { if (editingBox === idx) commit(); }, 0); }
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); commit(); }
      else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commit(); }
      ev.stopPropagation();   // keep global Delete/nav off while typing
    }
    boxEditCommit = commit;
    tx.addEventListener('blur', onBlur);
    tx.addEventListener('keydown', onKey);
  }

  // Pick / replace an image box's picture via the host asset picker (same picker + edit-tool
  // flow as the sidebar image slots). Stores the resolved URL string as the box `src` (the
  // hook's boxUrl reads a URL string). No-ops without a host picker (headless / CLI).
  async function pickBoxImage(idx: number): Promise<void> {
    const pick = opts.host?.assets?.pick;
    if (typeof pick !== 'function') return;
    const box = activeBoxes()[idx];
    const cur = typeof box?.src === 'string' ? box.src : refUrl(box?.src);
    try {
      const ref = await pick({ title: 'Choose an image', allowUpload: true, current: cur, editTool: opts.editTool }) as (Record<string, unknown> & { url?: string }) | null;
      if (!ref || typeof ref.url !== 'string' || !ref.url) return;
      const boxes = activeBoxes().slice();
      // Store the FULL asset ref (id = canonical embed URL + meta.toolUrl), not just the url — so
      // a Lolly-tool render placed on the canvas keeps its identity: editable in place + re-
      // renderable on load, matching the sidebar media slots (Fable N1). boxUrl reads .url either way.
      if (boxes[idx]) { boxes[idx] = { ...boxes[idx]!, src: ref as Box[string] }; commitBoxes(boxes); }
    } catch { /* user cancelled */ }
  }

  function startMove(e: PointerEvent, idx: number): void {
    // A pointerdown INSIDE the box currently being edited just places the caret — never move.
    if (editingBox === idx) return;
    e.preventDefault(); e.stopPropagation();
    // A click on a DIFFERENT box while an edit is open commits that edit first.
    if (boxEditCommit) boxEditCommit();
    // Double-click (two quick pointerdowns on the same box) opens it: a text box → in-place
    // rich-text edit; an image box → the picker. Shift-clicks are multi-select, never edits.
    const now = Date.now();
    if (lastDown.idx === idx && now - lastDown.t < 350 && !e.shiftKey) {
      lastDown = { idx: -1, t: 0 };
      const box = activeBoxes()[idx];
      if (box?.kind === 'image') { void pickBoxImage(idx); return; }
      const bEl = boxEls[idx]; if (bEl) startBoxTextEdit(idx, bEl);
      return;
    }
    lastDown = { idx, t: now };
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive) { if (selection.has(idx)) selection.delete(idx); else selection.add(idx); }
    else if (!selection.has(idx)) selection = new Set([idx]);
    primary = selection.size === 1 ? selIndices()[0]! : -1;
    renderFree();   // reflect the new selection (handles / bbox) immediately
    if (!selection.has(idx)) return;   // an additive click that DESELECTED this box — no drag
    const boxes = activeBoxes().slice();
    const m = canvasMetrics();
    gesture = { type: 'move', idx, indices: selIndices(), startClient: { x: e.clientX, y: e.clientY }, startBoxes: boxes, scaleX: m.scaleX, scaleY: m.scaleY, live: boxes, plainClick: !additive, moved: false };
    attachGesture();
  }
  function startResize(e: PointerEvent, idx: number, handle: HandleName): void {
    e.preventDefault(); e.stopPropagation();
    selection = new Set([idx]); primary = idx;
    const boxes = activeBoxes().slice();
    const m = canvasMetrics();
    gesture = { type: 'resize', idx, handle, indices: [idx], startClient: { x: e.clientX, y: e.clientY }, startBoxes: boxes, startRect: boxRect(boxes[idx], BOX_CFG), scaleX: m.scaleX, scaleY: m.scaleY, live: boxes };
    attachGesture();
  }
  function startRotate(e: PointerEvent): void {
    e.preventDefault(); e.stopPropagation();
    const boxes = activeBoxes().slice();
    const idxs = selIndices();
    const aabb = selectionAABB(boxes, idxs, BOX_CFG);
    if (!aabb) return;
    const centre = { x: (aabb.minX + aabb.maxX) / 2, y: (aabb.minY + aabb.maxY) / 2 };
    const m = canvasMetrics();
    // Angle is measured in SCREEN space (about the box's on-screen centre), matching the hook's
    // CSS `rotate()` — so the box visually follows the pointer even on a squished (16:9) slide.
    const csx = m.cr.left + centre.x * m.scaleX, csy = m.cr.top + centre.y * m.scaleY;
    const startAngle = Math.atan2(e.clientY - csy, e.clientX - csx) * 180 / Math.PI;
    gesture = { type: 'rotate', idx: primary, indices: idxs, centre, startAngle, startClient: { x: e.clientX, y: e.clientY }, startBoxes: boxes, scaleX: m.scaleX, scaleY: m.scaleY, live: boxes };
    attachGesture();
  }
  function startMarquee(e: PointerEvent): void {
    e.preventDefault();
    if (boxEditCommit) boxEditCommit();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? new Set(selection) : new Set<number>();
    if (!additive) { selection = new Set(); primary = -1; }   // click empty canvas = deselect
    const m = canvasMetrics();
    const ox = (e.clientX - m.cr.left) / m.scaleX, oy = (e.clientY - m.cr.top) / m.scaleY;
    gesture = { type: 'marquee', idx: -1, indices: [], startClient: { x: e.clientX, y: e.clientY }, startBoxes: activeBoxes().slice(), scaleX: m.scaleX, scaleY: m.scaleY, live: activeBoxes().slice(), marqueeBase: base, marqueeOrigin: { x: ox, y: oy } };
    attachGesture();
  }

  const clearGuides = (): void => { if (guidesLayer) guidesLayer.textContent = ''; };
  function drawGuides(guides: Array<{ x1: number; y1: number; x2: number; y2: number }>, scaleX: number, scaleY: number): void {
    if (!guidesLayer) return;
    guidesLayer.textContent = '';
    for (const g of guides) {
      const d = document.createElement('div');
      const vertical = Math.abs(g.x1 - g.x2) < 0.5;
      d.className = 'deck-free__guide deck-free__guide--' + (vertical ? 'v' : 'h');
      if (vertical) { d.style.left = (g.x1 * scaleX) + 'px'; d.style.top = (Math.min(g.y1, g.y2) * scaleY) + 'px'; d.style.height = (Math.abs(g.y2 - g.y1) * scaleY) + 'px'; }
      else { d.style.top = (g.y1 * scaleY) + 'px'; d.style.left = (Math.min(g.x1, g.x2) * scaleX) + 'px'; d.style.width = (Math.abs(g.x2 - g.x1) * scaleX) + 'px'; }
      guidesLayer.appendChild(d);
    }
  }

  const onGestureMove = (e: Event): void => {
    if (!gesture) return;
    const pe = e as PointerEvent;
    // A gesture only becomes a real drag once the pointer clears a small threshold, so a click
    // carrying sub-pixel trackpad jitter still reads as a click (no box move, no commit).
    if (Math.abs(pe.clientX - gesture.startClient.x) > 3 || Math.abs(pe.clientY - gesture.startClient.y) > 3) gesture.moved = true;
    const dx = (pe.clientX - gesture.startClient.x) / gesture.scaleX;
    const dy = (pe.clientY - gesture.startClient.y) / gesture.scaleY;
    if (gesture.type === 'move') {
      if (!gesture.moved) return;   // below the drag threshold — don't nudge the box yet
      let moved = moveBoxes(gesture.startBoxes, gesture.indices, dx, dy, BOX_CFG);
      // Smart-guide snap to the artboard + sibling edges/centres (hold Alt to bypass).
      if (!pe.altKey) {
        const sel = new Set(gesture.indices);
        const active = selectionAABB(moved, gesture.indices, BOX_CFG);
        if (active) {
          const others: AABB[] = [];
          moved.forEach((b, i) => { if (!sel.has(i)) others.push(boxAABB(b, BOX_CFG)); });
          const snap = snapMove(active, others, { w: opts.nativeW || 1920, h: opts.nativeH || 1920 }, SNAP_SCREEN / gesture.scaleX);
          if (snap.dx || snap.dy) moved = moveBoxes(moved, gesture.indices, snap.dx, snap.dy, BOX_CFG);
          drawGuides(snap.guides, gesture.scaleX, gesture.scaleY);
        }
      } else clearGuides();
      gesture.live = moved;
      positionBoxEls(gesture.live, gesture.scaleX, gesture.scaleY);
    } else if (gesture.type === 'resize') {
      if (!gesture.moved) return;
      const nr = resizeRect(gesture.startRect!, gesture.handle!, dx, dy, { minSize: 24 });
      gesture.live = gesture.startBoxes.map((b, i) => (i === gesture!.idx ? withRect(b, nr, BOX_CFG) : b));
      positionBoxEls(gesture.live, gesture.scaleX, gesture.scaleY);
    } else if (gesture.type === 'rotate') {
      if (!gesture.moved) return;
      const cm = canvasMetrics();
      const csx = cm.cr.left + gesture.centre!.x * cm.scaleX, csy = cm.cr.top + gesture.centre!.y * cm.scaleY;
      const ang = Math.atan2(pe.clientY - csy, pe.clientX - csx) * 180 / Math.PI;
      let delta = ang - gesture.startAngle!;
      // Snap the reference box's RESULTING angle to 15° steps (hold Alt to bypass).
      const refI = gesture.idx >= 0 ? gesture.idx : gesture.indices[0]!;
      const rot0 = boxRect(gesture.startBoxes[refI], BOX_CFG).rot || 0;
      if (!pe.altKey) { delta = snapAngle(rot0 + delta, 15, 5) - rot0; }
      gesture.live = rotateGroup(gesture.startBoxes, gesture.indices, gesture.centre!, delta, BOX_CFG);
      positionBoxEls(gesture.live, gesture.scaleX, gesture.scaleY);
    } else if (gesture.type === 'marquee') {
      const cm = canvasMetrics();
      const cx = (pe.clientX - cm.cr.left) / cm.scaleX, cy = (pe.clientY - cm.cr.top) / cm.scaleY;
      const rectN = normDragRect(gesture.marqueeOrigin!.x, gesture.marqueeOrigin!.y, cx, cy, 1);
      if (!marqueeEl) { marqueeEl = document.createElement('div'); marqueeEl.className = 'deck-free__marquee'; free.appendChild(marqueeEl); }
      marqueeEl.style.left = (rectN.x * gesture.scaleX) + 'px';
      marqueeEl.style.top = (rectN.y * gesture.scaleY) + 'px';
      marqueeEl.style.width = (rectN.w * gesture.scaleX) + 'px';
      marqueeEl.style.height = (rectN.h * gesture.scaleY) + 'px';
      const next = new Set(gesture.marqueeBase);
      for (const i of marqueeHit(gesture.startBoxes, rectN, BOX_CFG)) next.add(i);
      selection = next; primary = selection.size === 1 ? selIndices()[0]! : -1;
      for (let i = 0; i < boxEls.length; i++) boxEls[i]?.classList.toggle('is-sel', selection.has(i));
    }
  };
  const onGestureUp = (): void => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    detachGesture();
    clearGuides();
    if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }
    if (g.type === 'marquee') { renderFree(); return; }   // selection changed → repaint chrome
    // A real drag clears the double-click candidate, so a quick follow-up click on the same
    // box isn't mistaken for a double-click (which would open the text editor).
    if (g.moved) lastDown = { idx: -1, t: 0 };
    if (!g.moved) {
      // No drag happened (a click). A plain click on a box within a multi-selection collapses
      // to just that box; otherwise there is nothing to commit — restore any sub-threshold
      // nudge and skip the commit so resize/rotate/move clicks never push a no-op undo entry.
      if (g.type === 'move' && g.plainClick && selection.size > 1) { selection = new Set([g.idx]); primary = g.idx; renderFree(); return; }
      positionBoxEls(activeBoxes(), g.scaleX, g.scaleY);
      return;
    }
    commitBoxes(g.live);
  };
  function attachGesture(): void {
    document.addEventListener('pointermove', onGestureMove, true);
    document.addEventListener('pointerup', onGestureUp, true);
  }
  function detachGesture(): void {
    document.removeEventListener('pointermove', onGestureMove, true);
    document.removeEventListener('pointerup', onGestureUp, true);
  }

  // ── keyboard: nudge, copy/paste, delete (freeform slide, selection present) ────────
  function onFreeKey(e: KeyboardEvent): void {
    if (editingBox >= 0 || gesture) return;
    if (asText(activeSlide()?.mode) !== 'freeform') return;
    const ae = document.activeElement as HTMLElement | null;
    const tag = ae?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae?.isContentEditable) return;
    if (ae?.closest?.('.deck-strip, .deck-bar, .deck-load, .deck-text')) return;   // their own keys
    const nudges: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (nudges[e.key] && selection.size) {
      e.preventDefault();
      const [ux, uy] = nudges[e.key]!;
      const step = e.shiftKey ? 10 : 1;
      commitBoxes(moveBoxes(activeBoxes().slice(), selIndices(), ux * step, uy * step, BOX_CFG));
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === 'c' || e.key === 'C') && selection.size) {
      clipboard = selIndices().map(i => ({ ...activeBoxes()[i] })) as Box[];
      return;
    }
    if (meta && (e.key === 'v' || e.key === 'V') && clipboard.length) {
      e.preventDefault();
      const off = (opts.nativeW || 1920) * 0.03;
      const boxes = activeBoxes().slice();
      const start = boxes.length;
      for (const b of clipboard) boxes.push(coerceBox({ ...b, id: undefined, x: num(b.x as never, 0) + off, y: num(b.y as never, 0) + off }));
      selection = new Set(boxes.map((_, i) => i).filter(i => i >= start));
      primary = selection.size === 1 ? selIndices()[0]! : -1;
      commitBoxes(boxes);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) { e.preventDefault(); deleteBox(); }
  }
  document.addEventListener('keydown', onFreeKey);

  // Re-render everything on a model change (strip + toolbar + free-canvas), and reposition
  // the open text editor over the (repainted) canvas.
  // Cap the sidebar "Pause on slide" slider at the actual slide count (0 = play the whole
  // deck, 1..n = hold on slide n) — the manifest's static max:40 would let it run past the
  // last slide. Reaches into the sidebar control by its [data-input-id] (no-op when absent).
  function syncFocusMax(): void {
    try {
      const n = Math.max(1, readDeck().length);
      const host = opts.viewEl.querySelector<HTMLElement>('[data-input-id="focusSlide"]');
      host?.querySelectorAll<HTMLInputElement>('input[type="range"], input[type="number"]').forEach(el => { el.max = String(n); });
    } catch { /* sidebar not present (headless) */ }
  }

  function renderAll(): void {
    renderStrip();
    renderBar();
    renderFree();
    positionTextEditor();
    syncFocusMax();
  }

  // filmstrip -------------------------------------------------------------------
  const strip = document.createElement('div');
  strip.className = 'deck-strip';
  strip.setAttribute('role', 'listbox');
  strip.setAttribute('aria-label', 'Slides');
  strip.setAttribute('aria-orientation', 'horizontal');

  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.className = 'deck-strip__load';
  loadBtn.textContent = 'Load';
  loadBtn.title = 'Load a deck from JSON or Markdown';

  const stripScroll = document.createElement('div');
  stripScroll.className = 'deck-strip__scroll';

  strip.append(loadBtn, stripScroll);
  overlay.appendChild(strip);
  stageEl.appendChild(overlay);

  // one thumbnail per slide, keyboard-navigable
  // Thumbnail width tracks the deck's aspect ratio (read off the live canvas) so a square
  // deck gets square thumbs and a wide deck gets wide ones — height is fixed by CSS.
  const thumbWidth = (): number => {
    const cw = parseFloat(opts.canvasEl.style.width) || opts.nativeW || 1;
    const ch = parseFloat(opts.canvasEl.style.height) || opts.nativeH || 1;
    const aspect = cw > 0 && ch > 0 ? cw / ch : 1;
    return Math.round(Math.max(44, Math.min(150, 66 * aspect)));
  };

  // The exact colours the hook rendered slide `i` with — its inlined `--bg`/`--ink` custom
  // props on the live `.sl-slide--i` node — so a thumbnail matches the brand-derived scheme
  // (e.g. SUSE green accent) instead of the static approximation. Null when unavailable
  // (not yet painted, or a headless/jsdom env where custom props don't compute).
  const readRenderedColors = (i: number): { bg: string; ink: string } | null => {
    try {
      const view = document.defaultView;
      const el = opts.canvasEl.querySelector<HTMLElement>('.sl-slide--' + i);
      if (!el || !view?.getComputedStyle) return null;
      const cs = view.getComputedStyle(el);
      const bg = cs.getPropertyValue('--bg').trim();
      const ink = cs.getPropertyValue('--ink').trim();
      return bg ? { bg, ink: ink || '#ffffff' } : null;
    } catch { return null; }
  };

  function renderStrip(): void {
    const deck = readDeck();
    const active = activeIndex();
    const deckTheme = String(runtime.getModel().find(i => i.id === 'theme')?.value ?? 'auto') || 'auto';
    const prevScroll = stripScroll.scrollLeft;
    const w = thumbWidth();
    stripScroll.textContent = '';

    deck.forEach((slide, i) => {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'deck-thumb' + (i === active ? ' is-active' : '');
      thumb.setAttribute('role', 'option');
      thumb.setAttribute('aria-selected', String(i === active));
      const label = contentTitle(asText(slide.content));
      thumb.setAttribute('aria-label', `Slide ${i + 1}${label ? ': ' + label : ''}`);
      thumb.tabIndex = i === active ? 0 : -1;
      thumb.style.width = w + 'px';

      // A faithful mini-render of the slide (layout + theme colour + text + images), tinted with
      // the ACTUAL rendered slide colours where we can read them off the live canvas.
      const face = buildThumbFace(slide, deckTheme, readRenderedColors(i));

      const num = document.createElement('span');
      num.className = 'deck-thumb__num';
      num.textContent = String(i + 1);

      const del = document.createElement('span');
      del.className = 'deck-thumb__del';
      del.setAttribute('role', 'button');
      del.setAttribute('aria-label', `Delete slide ${i + 1}`);
      del.title = 'Delete slide';
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        const d = readDeck();
        if (d.length <= 1) return;   // keep at least one slide
        const next = d.slice(0, i).concat(d.slice(i + 1));
        commitDeck(next);
        setActive(Math.min(i, next.length - 1));
      });

      thumb.append(face, num, del);
      thumb.addEventListener('click', () => setActive(i));
      thumb.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setActive(i + 1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setActive(i - 1); }
        else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
        else if (e.key === 'End') { e.preventDefault(); setActive(readDeck().length - 1); }
      });
      stripScroll.appendChild(thumb);
    });

    // add-slide button
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'deck-thumb deck-thumb--add';
    add.setAttribute('aria-label', 'Add slide');
    add.title = 'Add slide';
    add.textContent = '+';
    add.disabled = deck.length >= MAX_SLIDES;
    add.addEventListener('click', () => {
      const d = readDeck();
      if (d.length >= MAX_SLIDES) return;
      const next = d.concat([coerceSlide({})]);
      commitDeck(next);
      setActive(next.length - 1);
    });
    stripScroll.appendChild(add);

    stripScroll.scrollLeft = prevScroll;
    // keep the active thumb in view (scrollIntoView is absent in jsdom test envs)
    stripScroll.querySelector<HTMLElement>('.deck-thumb.is-active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    // move focus to the active thumb only if focus already lives in the strip (so we don't
    // steal focus from the canvas / a text field mid-edit)
    if (stripScroll.contains(document.activeElement)) {
      stripScroll.querySelector<HTMLElement>('.deck-thumb.is-active')?.focus();
    }
  }

  // load popover ----------------------------------------------------------------
  let loadPop: HTMLElement | null = null;
  const closeLoad = (): void => { loadPop?.remove(); loadPop = null; document.removeEventListener('keydown', onLoadKey, true); };
  const onLoadKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); closeLoad(); } };

  function openLoad(): void {
    if (loadPop) { closeLoad(); return; }
    loadPop = document.createElement('div');
    loadPop.className = 'deck-load';
    loadPop.innerHTML =
      '<div class="deck-load__hd">Load a deck</div>' +
      '<p class="deck-load__hint">Paste, <strong>upload</strong>, or <strong>drop a file</strong> — Markdown (slides split by <code>---</code>), JSON (an array of slides), or a <strong>pptxgenjs</strong> script (re-themed to your brand).</p>';
    const ta = document.createElement('textarea');
    ta.className = 'deck-load__ta';
    ta.setAttribute('aria-label', 'Deck Markdown or JSON');
    ta.placeholder = '# My first slide\nA subtitle line\n\n---\n\n# Second slide\n![](https://example.com/pic.jpg)';
    const err = document.createElement('div');
    err.className = 'deck-load__err';
    err.hidden = true;

    // Read a picked / dropped file's text into the textarea.
    const readFile = (file: File | null | undefined): void => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { ta.value = String(reader.result ?? ''); err.hidden = true; ta.focus(); };
      reader.onerror = () => { err.hidden = false; err.textContent = 'Could not read that file.'; };
      reader.readAsText(file);
    };
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.md,.markdown,.mdown,.json,.txt,.js,.mjs,text/markdown,application/json,text/plain,text/javascript';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => readFile(fileInput.files?.[0]));
    // Drag-and-drop a file anywhere on the popover.
    loadPop.addEventListener('dragover', (e) => { e.preventDefault(); loadPop?.classList.add('is-dragover'); });
    loadPop.addEventListener('dragleave', () => loadPop?.classList.remove('is-dragover'));
    loadPop.addEventListener('drop', (e) => {
      e.preventDefault(); loadPop?.classList.remove('is-dragover');
      readFile(e.dataTransfer?.files?.[0]);
    });

    const row = document.createElement('div');
    row.className = 'deck-load__row';
    const upload = document.createElement('button');
    upload.type = 'button'; upload.className = 'deck-load__btn'; upload.textContent = 'Upload file…';
    upload.addEventListener('click', () => fileInput.click());
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'deck-load__btn'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeLoad);
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'deck-load__btn deck-load__btn--go'; go.textContent = 'Load deck';
    go.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) { closeLoad(); return; }
      let slides: Slide[];
      try { slides = parseDeck(text); }
      catch (e) { err.hidden = false; err.textContent = 'Could not parse that — check the Markdown / JSON / pptxgenjs. ' + (e as Error).message; return; }
      if (!slides.length) { err.hidden = false; err.textContent = 'No slides found in that input.'; return; }
      // A pptxgenjs import arrives with its own colours — re-theme them to the brand palette.
      if (isPptxGenSource(text)) { try { slides = await brandifyDeck(slides); } catch { /* keep the imported colours */ } }
      commitDeck(slides);
      setActive(0);
      closeLoad();
    });
    row.append(upload, cancel, go);
    loadPop.append(ta, err, row, fileInput);
    overlay.appendChild(loadPop);
    document.addEventListener('keydown', onLoadKey, true);
    ta.focus();
  }
  loadBtn.addEventListener('click', openLoad);

  // wire up ---------------------------------------------------------------------
  renderAll();
  // Re-render when the model changes (add/remove/reorder/nav/edit). Skip work when the
  // deck signature + active index are unchanged so unrelated input edits don't thrash it.
  let lastSig = '';
  // The signature covers everything buildThumbFace draws — the full content, the slide
  // theme/bg (thumbnails reflect the scheme), and ALL slots the layout can show (media1-4),
  // plus the deck-level theme (a global-theme change restyles every themed slide). Anything
  // the thumbnail renders must be here, or a change to it leaves the strip stale.
  // The signature also covers the toolbar + free-canvas surfaces: per-slide mode / logo and
  // the freeform `boxes` geometry (a box move/resize/add/delete must repaint the layer), so a
  // committed change to any of them re-renders. A live drag doesn't commit until pointer-up,
  // so this never thrashes mid-gesture.
  const sigOf = (): string => {
    const deck = readDeck();
    const deckTheme = String(runtime.getModel().find(i => i.id === 'theme')?.value ?? '');
    return activeIndex() + '|' + deckTheme + '|' + deck.map(s =>
      `${s.layout}:${s.bg}:${s.theme}:${s.logo}:${s.mode}:${s.content || ''}:${refUrl(s.media1)}:${refUrl(s.media2)}:${refUrl(s.media3)}:${refUrl(s.media4)}:${JSON.stringify(s.boxes || [])}`
    ).join('~');
  };
  lastSig = sigOf();
  const unsubscribe = runtime.subscribe(() => {
    if (!overlay.isConnected) return;
    if (gesture) return;    // a live drag/resize owns the DOM until pointer-up commits
    if (editingBox >= 0) return;   // an open box text edit owns its node until it commits
    const sig = sigOf();
    if (sig === lastSig) return;
    lastSig = sig;
    renderAll();
  });

  return {
    destroy(): void {
      try { unsubscribe(); } catch { /* already gone */ }
      detachGesture();
      document.removeEventListener('keydown', onFreeKey);
      closeTextEditor(false);
      closeLoad();
      overlay.remove();
    },
  };
}
