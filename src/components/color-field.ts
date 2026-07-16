// SPDX-License-Identifier: MPL-2.0
/**
 * Shared SUSE colour picker — the ONE colour field used across the app.
 *
 * Renders the palette swatches + hex entry + alpha + native picker + current
 * swatch, and wires their behaviour. Both the single-tool sidebar (views/tool.js)
 * and the /pro batch grid use this, so there is a single implementation to
 * maintain (no per-view variations).
 *
 * Markup styling lives in styles/app.css (`.color-picker-field`, `.color-popover`,
 * `.color-swatch`, `.color-trigger`, …) — global, so it applies wherever this
 * markup is mounted.
 *
 *   colorFieldHtml(id, value, { float })   → HTML string for one field
 *   wireColorField(scopeEl, { onChange, onInteractStart, onInteractEnd })
 *
 * `float` makes the popover position itself (fixed) anchored to the trigger and
 * close on outside-click — for hosts where the field sits inside a clipping /
 * scrolling container (the /pro grid). Regular sidebar fields use plain CSS
 * positioning; block-colour fields keep their sidebar-spanning behaviour.
 */
import { hexToOklch, oklchToHex, rgbToCmyk, cmykToRgbApprox, contrastRatio, deltaEOk } from '@lolly/engine';
import type { Oklch } from '@lolly/engine';
import { PALETTE } from '../palette.ts';
import { hexToRgba, rgbaToHex, rgbToHsl, hslToRgb, formatColor, parseColor } from '../lib/color-formats.ts';
import type { ColorFormat } from '../lib/color-formats.ts';
import { escape } from '../utils.ts';
import { wireTabs } from '../lib/tabs.ts';

/** One swatch as the picker renders it (see SWATCHES below). */
export interface ColorSwatchOption {
  value: string;
  label?: string | null;
  group?: string | null;
  /** canonical token reference ('{color.brand.jungle}') — null for plain colours */
  ref?: string | null;
}

/** What onChange receives: a plain colour string, or a token-linked value. */
export type ColorFieldValue = string | { ref: string; value: string };

export interface WireColorFieldOpts {
  onChange?(id: string, value: ColorFieldValue): void;
  onInteractStart?(): void;
  onInteractEnd?(): void;
}

// The swatch source the picker renders. Defaults to the built-in brand palette
// (so the picker works before — and without — tokens), and is replaced at runtime
// by setSwatches() with swatches resolved from design tokens. Shape per swatch:
//   { value: '#rrggbb' | 'transparent', label, group, ref|null }
// `ref` is the canonical token reference ('{color.brand.jungle}'); choosing such a
// swatch stores a token value so the colour stays linked to the token.
let SWATCHES: ColorSwatchOption[] = PALETTE.map(s => ({ value: s.hex, label: s.label, group: s.group ?? null, ref: null }));

/** Replace the picker's swatches (e.g. with tokens). Ignored if empty/invalid. */
export function setSwatches(list: ColorSwatchOption[]): void {
  if (Array.isArray(list) && list.length) SWATCHES = list;
}

/**
 * Repopulate the already-visible swatch grids under `scope` from the current
 * SWATCHES — call after setSwatches() when the brand palette changed so open
 * pickers (the dashboard/start inline primary) reflect added/deleted swatches
 * live. Closed popovers rebuild lazily on next open, so only touch grids that
 * are already built (or belong to an always-open inline field). Clicks are
 * delegated to the persistent box, so no re-wiring is needed here.
 */
export function refreshSwatches(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLElement>('[data-color-field]').forEach(field => {
    // No box = an inline field (they carry no palette) or one whose popover has
    // never been opened; either way there's nothing built to refresh.
    const box = field.querySelector<HTMLElement>('.color-swatches');
    if (box && box.childElementCount) box.innerHTML = swatchButtonsHtml(field.dataset.colorField!);
  });
}

// A colour value may be a token value object ({ ref, value }); the field UI works
// in plain colour strings, so coerce to the (cached) hex for display.
function toHex(value: unknown): string {
  const o = value as { ref?: unknown; value?: unknown };
  return ((value && typeof value === 'object' && typeof o.ref === 'string') ? (o.value ?? '') : value) as string;
}

/**
 * The palette name for a colour value ("Persimmon 3"), or '' when it isn't a named
 * swatch (a custom colour). Matches on the RGB channels — alpha is ignored — against
 * the active swatch list (the brand palette, or tokens once setSwatches() has run).
 * The FIRST matching swatch wins, so a hex shared by several ramps takes its primary
 * name (e.g. #0c322c → "Pine", not "Jungle 1").
 */
export function swatchName(value: unknown): string {
  const raw = toHex(value);
  if (typeof raw !== 'string' || !raw) return '';
  let v = raw.toLowerCase();
  if (v !== 'transparent' && /^#[0-9a-f]{8}$/.test(v)) v = v.slice(0, 7); // ignore alpha when naming
  for (const s of SWATCHES) {
    const sv = typeof s.value === 'string' ? s.value.toLowerCase() : '';
    if (sv && sv === v) return s.label || '';
  }
  return '';
}

/**
 * The perceptually nearest swatch to a custom colour (ΔEOK over the active
 * swatch list, alpha ignored) — the "snap back to the brand" hint. Returns the
 * winning swatch + its distance; the caller decides whether the distance is
 * close enough to be worth showing. Transparent and non-hex swatch values
 * (token aliases mid-resolve) are skipped.
 */
function nearestSwatch(value: string): { value: string; ref: string | null; label: string; d: number } | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(raw)) return null;
  const rgb = raw.slice(0, 7);
  let best: ColorSwatchOption | null = null;
  let bestD = Infinity;
  for (const s of SWATCHES) {
    const sv = typeof s.value === 'string' ? s.value : '';
    if (!/^#[0-9a-f]{6}$/i.test(sv)) continue;
    const d = deltaEOk(rgb, sv);
    if (Number.isFinite(d) && d < bestD) { bestD = d; best = s; }
  }
  return best ? { value: best.value, ref: best.ref ?? null, label: best.label || best.value, d: bestD } : null;
}

// A colour value is only interpolated into an inline `style="…"` attribute after
// passing this shape test: a bare hex, a colour function (rgb()/hsl()/oklch()/…)
// whose arguments contain no nested parens/quotes/semicolons/braces, or a plain
// ident ('rebeccapurple', 'transparent'). Swatch values can come from a
// user-IMPORTED tokens document (setSwatches ← host.tokens.colors(), fed by the
// #/start wizard), and escape() doesn't neutralise CSS metacharacters — so a
// malicious $value like `#000; background-image:url(https://evil.example/x)`
// would otherwise smuggle a live declaration into the attribute and fire an
// external request. The engine's colorToHex is the primary gate upstream; this
// is the defense-in-depth at the sink.
const SAFE_CSS_COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^();"'{}<>\\]*\)|[a-z][a-z0-9-]*)$/i;

/** `v` when it's a safely inlinable CSS colour, else '' (paints nothing). */
function safeCssColor(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return SAFE_CSS_COLOR.test(s) ? s : '';
}

// ── OKLCH sliders (the LCH-first custom-colour surface) ─────────────────────
// The picker's custom-colour controls are OKLCH sliders — perceptual axes
// (lightness / chroma / hue) instead of the RGB cube, matching the OKLCH-native
// brand token system. The engine's brand-derive module is the conversion
// authority: hexToOklch to seed the sliders, gamut-mapped oklchToHex (chroma
// reduced until sRGB-representable) on the way out — so any slider position
// yields a real, in-gamut hex.

/** Slider ranges. C's ceiling is CSS Color 4's practical sRGB chroma maximum. */
export const LCH_MAX = { l: 100, c: 0.4, h: 360 } as const;

/** Sliders' fallback when the current value has no colour to seed from
 * ('transparent', or an unparsable string): a pleasant mid-blue, not black —
 * black sits at C=0 where the H slider does nothing, a dead-feeling start. */
const LCH_SEED: Oklch = { l: 0.62, c: 0.11, h: 250 };

// An axis's colour ramp is generated ONCE, as a list of stops, and then poured
// into two shapes: a linear-gradient (the slider track) and a conic-gradient (the
// dial). Same stops, same colours, so the dial can never disagree with the slider
// beneath it.
const linearStops = (stops: readonly string[]): string => `linear-gradient(to right, ${stops.join(', ')})`;
/** `from 0deg` puts the range's start at 12 o'clock and sweeps it clockwise —
 *  which is exactly how the needle angle (frac × 360°) is measured. */
const conicStops = (stops: readonly string[]): string => `conic-gradient(from 0deg, ${stops.join(', ')})`;

/**
 * The three axis ramps for the current colour, as stop lists. Each axis sweeps
 * its own range while holding the other two at the current value, so the ramp
 * previews exactly what moving that axis will do. Stops are raw `oklch()`
 * strings — the browser renders and gamut-maps them; no per-stop JS conversion.
 */
function lchTrackStops(l: number, c: number, h: number): { l: string[]; c: string[]; h: string[] } {
  const ramp = (n: number, at: (t: number) => string): string[] =>
    Array.from({ length: n }, (_, i) => at(i / (n - 1)));
  const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
  return {
    l: ramp(9, t => `oklch(${pct(t)} ${c} ${h})`),
    c: ramp(9, t => `oklch(${pct(l)} ${t * LCH_MAX.c} ${h})`),
    h: ramp(13, t => `oklch(${pct(l)} ${Math.max(c, 0.08)} ${t * 360})`), // floor C so the hue sweep stays visible near grey
  };
}

/** The three slider-track gradients for the current colour. Exported for tests. */
export function lchTrackGradients(l: number, c: number, h: number): { l: string; c: string; h: string } {
  const s = lchTrackStops(l, c, h);
  return { l: linearStops(s.l), c: linearStops(s.c), h: linearStops(s.h) };
}

/** Black or white — whichever reads on `hex`. Perceptual luminance threshold. */
export function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return '#000000';
  const r = parseInt(m[1]!, 16), g = parseInt(m[2]!, 16), b = parseInt(m[3]!, 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#000000' : '#ffffff';
}

// ── Colour-space slider modes (opt-in via `modes`) ──────────────────────────
// The picker's default surface is the OKLCH sliders above. `modes` adds a tab
// bar — OKLCH · HSL · RGB · CMYK — so the same colour can be set in whichever
// space the user thinks in (the brand primary wants this). OKLCH keeps its own
// dedicated state machine (.color-lch — its data-l/c/h avoids low-chroma hue
// drift); the other three are "generic" groups driven by these helpers. Each
// generic group holds its channels as data-* on the group element and only
// round-trips to hex on the way OUT, so a lossy space (CMYK↔RGB is many-to-one
// on K) stays stable while dragging — same discipline as the OKLCH group.
// OKLCH is the DEFAULT tab — the perceptual dials + sliders make it the best
// space to pick in. 'hex' is a first-class tab too — it has no sliders of its
// own, so it BORROWS the RGB slider group (sliderMode below maps hex→rgb) while
// its value field speaks plain #rrggbb. The active tab is the emphasised one
// (bold pill), whichever space that is.
export type ColorMode = 'hex' | 'oklch' | 'hsl' | 'rgb' | 'cmyk';
/** The generic (non-OKLCH) spaces — those driven by MODE_AXES + gen* helpers. */
type GenMode = 'hsl' | 'rgb' | 'cmyk';

interface ModeAxis { ch: string; label: string; aria: string; min: number; max: number; step: number; }
/** Channel spec per generic mode — UI units (RGB 0–255, HSL h 0–360 s/l 0–100, CMYK 0–100). */
const MODE_AXES: Record<GenMode, ModeAxis[]> = {
  hsl: [
    { ch: 'h', label: 'H', aria: 'Hue', min: 0, max: 360, step: 1 },
    { ch: 's', label: 'S', aria: 'Saturation', min: 0, max: 100, step: 1 },
    { ch: 'l', label: 'L', aria: 'Lightness', min: 0, max: 100, step: 1 },
  ],
  rgb: [
    { ch: 'r', label: 'R', aria: 'Red', min: 0, max: 255, step: 1 },
    { ch: 'g', label: 'G', aria: 'Green', min: 0, max: 255, step: 1 },
    { ch: 'b', label: 'B', aria: 'Blue', min: 0, max: 255, step: 1 },
  ],
  cmyk: [
    { ch: 'c', label: 'C', aria: 'Cyan', min: 0, max: 100, step: 1 },
    { ch: 'm', label: 'M', aria: 'Magenta', min: 0, max: 100, step: 1 },
    { ch: 'y', label: 'Y', aria: 'Yellow', min: 0, max: 100, step: 1 },
    { ch: 'k', label: 'K', aria: 'Black', min: 0, max: 100, step: 1 },
  ],
};

/** A generic mode's channel values (UI units) read from an sRGB hex. */
function genFromHex(mode: GenMode, hex: string): Record<string, number> {
  const { r, g, b } = hexToRgba(hex) ?? { r: 0, g: 0, b: 0, a: 1 };
  if (mode === 'rgb') return { r, g, b };
  if (mode === 'hsl') { const [h, s, l] = rgbToHsl(r, g, b); return { h, s, l }; }
  const [c, m, y, k] = rgbToCmyk(r / 255, g / 255, b / 255); // engine returns 0–1
  return { c: c * 100, m: m * 100, y: y * 100, k: k * 100 };
}

/** A generic mode's channel values → an sRGB `#rrggbb` (gamut-safe, no alpha). */
function genToHex(mode: GenMode, st: Record<string, number>): string {
  if (mode === 'rgb') return rgbaToHex(st.r!, st.g!, st.b!, 1);
  if (mode === 'hsl') { const [r, g, b] = hslToRgb(st.h!, st.s!, st.l!); return rgbaToHex(r, g, b, 1); }
  const [r, g, b] = cmykToRgbApprox([st.c! / 100, st.m! / 100, st.y! / 100, st.k! / 100] as [number, number, number, number]);
  return rgbaToHex(r * 255, g * 255, b * 255, 1);
}

/** Per-channel stop list for a generic mode: each sweeps its axis, others held. */
function genTrackStops(mode: GenMode, st: Record<string, number>): Record<string, string[]> {
  if (mode === 'rgb') return {
    r: [`rgb(0,${st.g},${st.b})`, `rgb(255,${st.g},${st.b})`],
    g: [`rgb(${st.r},0,${st.b})`, `rgb(${st.r},255,${st.b})`],
    b: [`rgb(${st.r},${st.g},0)`, `rgb(${st.r},${st.g},255)`],
  };
  if (mode === 'hsl') return {
    h: Array.from({ length: 13 }, (_, i) => `hsl(${i / 12 * 360} ${st.s}% ${st.l}%)`),
    s: [`hsl(${st.h} 0% ${st.l}%)`, `hsl(${st.h} 100% ${st.l}%)`],
    l: [`hsl(${st.h} ${st.s}% 0%)`, `hsl(${st.h} ${st.s}% 50%)`, `hsl(${st.h} ${st.s}% 100%)`],
  };
  // CMYK: no CSS cmyk() — sample the approx conversion at 7 stops per axis.
  const sample = (vary: 'c' | 'm' | 'y' | 'k'): string[] => Array.from({ length: 7 }, (_, i) => {
    const v = { ...st, [vary]: (i / 6) * 100 };
    const [r, g, b] = cmykToRgbApprox([v.c! / 100, v.m! / 100, v.y! / 100, v.k! / 100] as [number, number, number, number]);
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  });
  return { c: sample('c'), m: sample('m'), y: sample('y'), k: sample('k') };
}

/** Per-channel track gradient for a generic mode. */
function genTracks(mode: GenMode, st: Record<string, number>): Record<string, string> {
  const stops = genTrackStops(mode, st);
  return Object.fromEntries(Object.entries(stops).map(([ch, s]) => [ch, linearStops(s)]));
}

/** A generic channel's readout: hue in degrees, RGB as an integer, the rest as %. */
function genValText(mode: GenMode, ch: string, v: number): string {
  if (mode === 'rgb') return `${Math.round(v)}`;
  if (mode === 'hsl' && ch === 'h') return `${Math.round(v)}°`;
  return `${Math.round(v)}%`;
}

// ── Dials ────────────────────────────────────────────────────────────────────
// INLINE HOSTS ONLY (the brand editor's spacious always-open panel). The trigger
// popover is a narrow floating column where the rings cost a lot of height to
// restate axes the sliders under them already show, and its result disc would
// duplicate the eyedropper in the value field above — so it renders sliders only.
//
// A ring per channel, sitting above the sliders: the axis's ramp poured into a
// conic gradient, with a needle at value → angle. Hue is genuinely circular, so
// its dial is the real shape of that axis; the others are a sweep (the ramp's
// start and end meet at 12 o'clock, which is why there's a visible seam there —
// that's the range's edge, not an artefact).
//
// The dials are painted from the CURRENT colour, so they carry the context the
// sliders do: with hue on green and saturation at zero, the S and L dials both
// show their green-to-grey and black-to-white sweeps *for that hue*, and the
// result disc reads mid-grey. Dragging one is a convenience — the slider under
// it stays the control of record (it is the accessible one, and the precise one),
// and a dial drag simply drives it.
//
// The fourth disc is the OUTPUT: the colour these three axes currently make. It's
// split in half — the top picks a colour off the screen (eyedropper), the bottom
// opens the swatch menu — with the glyphs struck through it in its own contrast
// colour.

interface DialSpec { ch: string; label: string; aria: string; frac: number; stops: string[] }

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** The needle's angle for a 0–1 position on the axis. Matches conicStops' `from 0deg`. */
const needleDeg = (frac: number): string => `${(clamp01(frac) * 360).toFixed(1)}deg`;

const EDIT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

/** The OKLCH group's three dials, for the current state. */
function lchDials(l: number, c: number, h: number): DialSpec[] {
  const s = lchTrackStops(l, c, h);
  return [
    { ch: 'l', label: 'L', aria: 'Lightness', frac: l, stops: s.l },
    { ch: 'c', label: 'C', aria: 'Chroma', frac: c / LCH_MAX.c, stops: s.c },
    { ch: 'h', label: 'H', aria: 'Hue', frac: h / 360, stops: s.h },
  ];
}

/** A generic group's dials (one per channel), for the current state. */
function genDials(mode: GenMode, st: Record<string, number>): DialSpec[] {
  const stops = genTrackStops(mode, st);
  return MODE_AXES[mode].map(a => ({
    ch: a.ch, label: a.label, aria: a.aria,
    frac: (st[a.ch]! - a.min) / (a.max - a.min),
    stops: stops[a.ch]!,
  }));
}

/** The dial row: one ring per channel + the output disc. `outHex` is machine-made
 *  (oklchToHex / genToHex), so it's always a safe `#rrggbb` for a CSS context. */
function dialsHtml(dials: readonly DialSpec[], outHex: string): string {
  const ring = (d: DialSpec): string => `
      <button type="button" class="color-dial" data-dial-ch="${d.ch}" tabindex="-1"
              style="background:${conicStops(d.stops)}" title="${d.aria}" aria-hidden="true">
        <span class="color-dial-needle" style="transform:rotate(${needleDeg(d.frac)})"></span>
        <span class="color-dial-hub">${d.label}</span>
      </button>`;
  return `<div class="color-dials">
      ${dials.map(ring).join('')}
      <div class="color-dial-out" data-dial-out style="--out:${outHex};--out-fg:${contrastText(outHex)}">
        <button type="button" class="color-dial-act" data-dial-act="eyedropper"
                title="Pick a colour from your screen" aria-label="Pick a colour from your screen">${EYEDROPPER_ICON}</button>
        <button type="button" class="color-dial-act" data-dial-act="native"
                title="More colours" aria-label="More colours">${EDIT_ICON}</button>
      </div>
    </div>`;
}

/** Repaint a group's dials + output disc from its current state. */
function paintDials(group: HTMLElement, dials: readonly DialSpec[], outHex: string): void {
  for (const d of dials) {
    const dial = group.querySelector<HTMLElement>(`.color-dial[data-dial-ch="${d.ch}"]`);
    if (!dial) continue;
    dial.style.background = conicStops(d.stops);
    const needle = dial.querySelector<HTMLElement>('.color-dial-needle');
    if (needle) needle.style.transform = `rotate(${needleDeg(d.frac)})`;
  }
  const out = group.querySelector<HTMLElement>('[data-dial-out]');
  if (out) {
    out.style.setProperty('--out', outHex);
    out.style.setProperty('--out-fg', contrastText(outHex));
  }
}

/** One generic mode's slider group (channels as data-* on the wrapper). */
function genGroupHtml(mode: GenMode, rgbHex: string, hidden: boolean, dials: boolean): string {
  const st = genFromHex(mode, rgbHex);
  const tracks = genTracks(mode, st);
  const rows = MODE_AXES[mode].map(a => `
      <div class="color-lch-row">
        <span class="color-lch-label" aria-hidden="true">${a.label}</span>
        <input type="range" class="color-mode-slider" data-mode-ch="${a.ch}"
               min="${a.min}" max="${a.max}" step="${a.step}" value="${Math.round(st[a.ch]!)}"
               style="background:${tracks[a.ch]}" aria-label="${a.aria}">
        <span class="color-lch-val" data-mode-val="${a.ch}">${genValText(mode, a.ch, st[a.ch]!)}</span>
      </div>`).join('');
  const data = MODE_AXES[mode].map(a => `data-${a.ch}="${st[a.ch]}"`).join(' ');
  return `<div class="color-modegroup" data-mode-group="${mode}" ${data}${hidden ? ' hidden' : ''}>${
    dials ? dialsHtml(genDials(mode, st), genToHex(mode, st)) : ''
  }${rows}</div>`;
}

/**
 * The mode tab bar + all slider groups. OKLCH is the DEFAULT active tab — its
 * .color-lch group starts visible; HEX/HSL/RGB/CMYK start hidden. The active tab
 * gets the bold pill (CSS aria-selected), whichever space it is. HEX has no
 * sliders of its own, so when picked it borrows the RGB group.
 */
function colorModesHtml(eid: string, rgbHex: string | null, dials: boolean): string {
  const seed = rgbHex ?? '#4f83cc'; // generic groups need a real hex; OKLCH seeds itself
  const tab = (m: ColorMode, label: string, on: boolean): string =>
    `<button type="button" class="color-mode-tab" role="tab" data-mode="${m}" aria-selected="${on}">${label}</button>`;
  // OKLCH is the default space now that the perceptual dials + sliders make it the
  // best one to pick in. Its .color-lch group starts visible; the others hidden.
  return `<div class="color-modes" data-color-modes="${eid}" data-active-mode="oklch">
      <div class="color-mode-tabs" role="tablist" aria-label="Colour space">
        ${tab('hex', 'HEX', false)}${tab('oklch', 'OKLCH', true)}${tab('hsl', 'HSL', false)}${tab('rgb', 'RGB', false)}${tab('cmyk', 'CMYK', false)}
      </div>
      ${lchSlidersHtml(eid, rgbHex, false, dials)}
      ${genGroupHtml('hsl', seed, true, dials)}
      ${genGroupHtml('rgb', seed, true, dials)}
      ${genGroupHtml('cmyk', seed, true, dials)}
    </div>`;
}

/** Repaint a generic group's sliders + readouts + tracks from its data-* state. */
function paintGenGroup(group: HTMLElement): void {
  const mode = group.dataset.modeGroup as GenMode;
  const st: Record<string, number> = {};
  for (const a of MODE_AXES[mode]) st[a.ch] = parseFloat(group.dataset[a.ch] ?? '0');
  const tracks = genTracks(mode, st);
  for (const a of MODE_AXES[mode]) {
    const slider = group.querySelector<HTMLInputElement>(`[data-mode-ch="${a.ch}"]`);
    const val = group.querySelector<HTMLElement>(`[data-mode-val="${a.ch}"]`);
    if (slider) { slider.value = String(Math.round(st[a.ch]!)); slider.style.background = tracks[a.ch]!; }
    if (val) val.textContent = genValText(mode, a.ch, st[a.ch]!);
  }
  paintDials(group, genDials(mode, st), genToHex(mode, st));
}

/** Re-seed a generic group's channels from an sRGB hex (external colour change). */
function seedGenGroup(group: HTMLElement, hex: string): void {
  const mode = group.dataset.modeGroup as GenMode;
  const st = genFromHex(mode, hex);
  for (const [k, v] of Object.entries(st)) group.dataset[k] = String(v);
  paintGenGroup(group);
}

// Pipette glyph for the screen eyedropper button (stroke follows the input's
// contrast-flipped text colour via currentColor).
const EYEDROPPER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>';

// The value input doubles as a live swatch of the current colour: the colour
// itself (alpha included, over the .color-input--painted checkerboard so a
// translucent value previews its opacity) as background, a contrast-tinted
// edge of the same colour as border, and the text flipped to whichever of
// white/black reads with more contrast (WCAG ratio, engine brand-derive math).
// Delivered as custom properties (--color-input-*) rather than style longhands
// so the stylesheet's :focus ring still outranks the border tint.
const CHECKER_AVG = 0xe6; // the checkerboard's average grey (#fff / #ccc squares)
function colorInputPaint(hex: string): Record<string, string> {
  const rgb = hex.slice(0, 7);
  const a = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
  // Judge contrast against what the eye actually sees: a translucent colour
  // composites over the checkerboard, so blend toward its average grey first.
  const eff = '#' + [1, 3, 5].map((i) => {
    const c = parseInt(rgb.slice(i, i + 2), 16);
    return Math.round(c * a + CHECKER_AVG * (1 - a)).toString(16).padStart(2, '0');
  }).join('');
  const fg = contrastRatio('#ffffff', eff) >= contrastRatio('#000000', eff) ? '#ffffff' : '#000000';
  return {
    '--color-input-bg': hex,
    '--color-input-border': `color-mix(in oklab, ${rgb}, ${fg} 25%)`,
    '--color-input-fg': fg,
  };
}

/** (Re)paint a value input as the given colour's swatch — or back to the
 *  neutral chrome when the value has no colour (transparent / mid-edit junk).
 *  The custom props land on the .color-input-wrap (they inherit), so the
 *  eyedropper button beside the input flips contrast along with the text. */
function paintColorInput(input: HTMLInputElement | null, value: string): void {
  if (!input) return;
  const hex = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value) ? value : null;
  const paint = hex ? colorInputPaint(hex) : null;
  input.classList.toggle('color-input--painted', Boolean(paint));
  const holder = input.closest<HTMLElement>('.color-input-wrap') ?? input;
  for (const p of ['--color-input-bg', '--color-input-border', '--color-input-fg']) {
    if (paint) holder.style.setProperty(p, paint[p]!);
    else holder.style.removeProperty(p);
  }
}

export function colorFieldHtml(id: string, value: unknown, { float = false, swatchesOnly = false, block = false, inline = false, modes = false }: { float?: boolean; swatchesOnly?: boolean; block?: boolean; inline?: boolean; modes?: boolean } = {}): string {
  const rawVal = toHex(value) ?? '';
  const isTransparent = rawVal === 'transparent';
  const isHex8 = /^#[0-9a-fA-F]{8}$/.test(rawVal);
  const isHex6 = /^#[0-9a-fA-F]{6}$/.test(rawVal);
  const rgbHex = isHex8 ? rawVal.slice(0, 7) : (isHex6 ? rawVal : '#000000');
  const alphaInt = isHex8 ? parseInt(rawVal.slice(7, 9), 16) : (isTransparent ? 0 : 255);
  const alphaPct = Math.round(alphaInt / 255 * 100);
  const hexDisplay = isHex8 ? rawVal.toLowerCase() : (isHex6 ? rawVal.toLowerCase() : '');
  const previewBg = isTransparent ? '' : `style="background:${escape(safeCssColor(rawVal) || '#000000')}"`;
  const previewClass = `color-trigger-preview${isTransparent ? ' color-swatch--transparent' : ''}`;
  const eid = escape(id);
  const hexText = hexDisplay || rawVal || '#000000';
  const name = swatchName(value);

  // Swatches are NOT rendered here — they're the heaviest part (the whole
  // palette per field) and are built lazily on first popover open (see
  // buildSwatches in wireColorField). Keeps the initial grid DOM light.
  //
  // The trigger shows the swatch circle + the colour NAME (small, muted SUSE Mono) —
  // NOT the hex; the hex value lives only inside the popover picker. A CSS container
  // query on the button collapses the name away, leaving just the circle, when the
  // field is squeezed in next to other controls (see .color-trigger in components.css).
  // The name span is always present (:empty hides it) so live edits can fill/clear it
  // without a rebuild. The hex still rides in the aria-label for screen readers.
  // `block` marks a field living inside a block-editor row: positionPopover's
  // block-color-field branch spans the popover across the sidebar, and the block
  // host routes its onChange by the composite id ("blockId:idx:fieldId").
  // `inline` drops the trigger entirely and keeps the popover always-open, laid
  // out in flow (no floating/positioning) — for hosts with room to spare that
  // want the picker as a spacious inline panel, not a click-to-open popover (the
  // brand editor's Primary colour and swatch editor). CSS (.color-field--inline)
  // turns the popover static and gives the dials the full width. It is also what
  // gates the dials on at all: they're a panel affordance, and the narrow trigger
  // popover shows sliders alone.
  //
  // It carries NO swatch palette: every inline host is the brand editor, where
  // the swatches would be the very palette being edited — offering the brand's
  // own colours as presets for a brand colour is circular. Omitted rather than
  // hidden: the grid is the heaviest part of the popover's DOM.
  const cls = `color-picker-field${float ? ' color-field--float' : ''}${block ? ' block-color-field' : ''}${inline ? ' color-field--inline' : ''}`;
  return `<div class="${cls}" data-color-field="${eid}">
    ${inline ? '' : `<button type="button" class="color-trigger" data-color-trigger="${eid}" aria-haspopup="true" aria-expanded="false" aria-label="Colour: ${escape(name ? name + ' ' : '')}${escape(hexText)}">
      <span class="${previewClass}" ${previewBg} aria-hidden="true"></span>
      <span class="color-trigger-name">${escape(name)}</span>
    </button>`}
    <div class="color-popover" role="group" aria-label="Colour options"${inline ? '' : ' hidden'}>
      ${swatchesOnly ? '' : `<div class="color-input-wrap"${isHex6 || isHex8 ? ` style="${Object.entries(colorInputPaint(hexDisplay)).map(([k, v]) => `${k}:${v}`).join(';')}"` : ''}>
      <input type="text" class="color-input${isHex6 || isHex8 ? ' color-input--painted' : ''}" data-color-hex="${eid}"
             value="${escape(hexDisplay || rawVal || '#000000')}" placeholder="${modes ? 'colour value' : '#rrggbbaa'}"
             ${modes ? '' : 'maxlength="9" '}spellcheck="false" autocomplete="off" aria-label="Colour value">
      <button type="button" class="color-eyedropper" data-color-eyedropper="${eid}" aria-label="Pick a colour from your screen" title="Pick a colour from your screen">${EYEDROPPER_ICON}</button>
      </div>
      ${modes
        ? colorModesHtml(eid, isHex6 || isHex8 ? rgbHex : null, inline)
        : lchSlidersHtml(eid, isHex6 || isHex8 ? rgbHex : null, false, inline)}
      <div class="color-alpha-row">
        <span class="color-alpha-label" aria-hidden="true">A</span>
        <input type="range" class="color-alpha-slider" data-color-alpha="${eid}"
               min="0" max="255" value="${alphaInt}" aria-label="Opacity">
        <span class="color-alpha-pct" data-alpha-pct="${eid}">${alphaPct}%</span>
      </div>
      <input type="color" class="color-popover-native" data-input-id="${eid}" value="${escape(rgbHex)}" aria-label="Pick a custom colour">
      <button type="button" class="color-nearest" data-color-nearest="${eid}" hidden></button>`}
      ${inline
        // Inline has no always-open palette (the brand editor's own tiles ARE the
        // palette). The swatch grid instead lives in a menu the result disc's edit
        // action opens — "the swatch context menu" — so presets stay one click away.
        ? '<div class="color-swatch-menu" data-swatch-menu hidden><div class="color-swatches"></div></div>'
        : '<div class="color-swatches"></div>'}
    </div>
  </div>`;
}

/** Slider readout formatting per axis — L in %, C to 3 places, H in degrees. */
function lchValText(axis: 'l' | 'c' | 'h', v: number): string {
  return axis === 'l' ? `${Math.round(v)}%` : axis === 'c' ? v.toFixed(3) : `${Math.round(v)}°`;
}

/**
 * The OKLCH slider stack for one field, seeded from `rgbHex` (or the neutral
 * seed when the value has no colour, e.g. 'transparent'). The current OKLCH
 * state rides on data-l/c/h of the wrapper — the sliders are its projection,
 * and slider drags mutate the state directly (never a hex round-trip, which
 * would drift hue at low chroma).
 */
function lchSlidersHtml(eid: string, rgbHex: string | null, hidden = false, dials = false): string {
  const o = (rgbHex ? hexToOklch(rgbHex) : null) ?? LCH_SEED;
  const tracks = lchTrackGradients(o.l, o.c, o.h);
  const row = (axis: 'l' | 'c' | 'h', label: string, aria: string, max: number, step: number, value: number) => `
      <div class="color-lch-row">
        <span class="color-lch-label" aria-hidden="true">${label}</span>
        <input type="range" class="color-lch-slider" data-lch-axis="${axis}"
               min="0" max="${max}" step="${step}" value="${value}"
               style="background:${tracks[axis]}" aria-label="${aria}">
        <span class="color-lch-val" data-lch-val="${axis}">${lchValText(axis, value)}</span>
      </div>`;
  return `<div class="color-lch" data-color-lch="${eid}" data-l="${o.l}" data-c="${o.c}" data-h="${o.h}"${hidden ? ' hidden' : ''}>
      ${dials ? dialsHtml(lchDials(o.l, o.c, o.h), oklchToHex(o)) : ''}
      ${row('l', 'L', 'Lightness', LCH_MAX.l, 0.5, Math.round(o.l * 1000) / 10)}
      ${row('c', 'C', 'Chroma', LCH_MAX.c, 0.004, Math.round(o.c * 1000) / 1000)}
      ${row('h', 'H', 'Hue', LCH_MAX.h, 1, Math.round(o.h))}
    </div>`;
}

/** The palette swatch buttons for a field — built lazily on first popover open. */
function swatchButtonsHtml(id: string): string {
  const eid = escape(id);
  return SWATCHES.map(s => {
    const isTrans = s.value === 'transparent';
    const refAttr = s.ref ? ` data-swatch-ref="${escape(s.ref)}"` : '';
    const name = s.label || s.value;
    const aria = s.group && s.label ? `${s.group} · ${s.label}` : name;
    // Each swatch carries its own colour (--sw-c) + a black/white contrast colour
    // (--sw-fg) as inline custom props; the floating hover tooltip paints itself in
    // those (see showSwatchTip). Transparent has no colour of its own, so give the
    // tooltip a neutral chip. No native `title` — the graphical tip replaces it.
    // safeCssColor: this is a CSS context, so attribute-escaping alone isn't
    // enough — an unvalidated token value could smuggle extra declarations.
    const val = safeCssColor(s.value);
    const tip = isTrans ? '--sw-c:#c9ccd1;--sw-fg:#1d1d1d' : `--sw-c:${escape(val || '#c9ccd1')};--sw-fg:${contrastText(val)};background:${escape(val)}`;
    return `<button type="button"
      class="color-swatch${isTrans ? ' color-swatch--transparent' : ''}"
      data-swatch-for="${eid}" data-swatch-value="${escape(s.value)}"${refAttr}
      data-name="${escape(name)}" style="${tip}"
      aria-label="${escape(aria)}"></button>`;
  }).join('');
}

// ── Swatch name tooltip (a single shared, floating chip) ─────────────────────────
// A graphical hover label for the palette swatches: a little chip painted in the
// swatch's OWN colour with a contrasting black/white name. It lives on document.body
// as position:fixed, so the swatch grid's own scroll/overflow never clips it (a CSS
// ::after would be), pops in after a tiny delay, and is pointer-events:none — hovering
// it never steals a click, so you can slide straight onto the next swatch. One shared
// element + delegated listeners cover every field's (lazily built) swatches.
let swatchTip: HTMLElement | null = null;
let swatchTipTimer: ReturnType<typeof setTimeout> | undefined;
let swatchTipArmed = false;

function showSwatchTip(swatch: HTMLElement): void {
  const name = swatch.dataset.name;
  if (!name) return;
  if (!swatchTip) {
    swatchTip = document.createElement('div');
    swatchTip.className = 'swatch-name-tip';
    swatchTip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(swatchTip);
  }
  const tip = swatchTip;
  tip.textContent = name;
  tip.style.background = swatch.style.getPropertyValue('--sw-c').trim() || '#333';
  tip.style.color = swatch.style.getPropertyValue('--sw-fg').trim() || '#fff';
  const r = swatch.getBoundingClientRect();
  tip.style.left = `${Math.round(r.left + r.width / 2)}px`;
  tip.style.top = `${Math.round(r.top - 6)}px`;
  clearTimeout(swatchTipTimer);
  swatchTipTimer = setTimeout(() => tip.classList.add('is-shown'), 240); // the tiny delay
}

function hideSwatchTip(): void {
  clearTimeout(swatchTipTimer);
  swatchTip?.classList.remove('is-shown');
}

/** Arm the delegated swatch-tooltip listeners once (idempotent across every wireColorField). */
function armSwatchTip(): void {
  if (swatchTipArmed) return;
  swatchTipArmed = true;
  document.addEventListener('mouseover', (e) => {
    const sw = (e.target as Element | null)?.closest<HTMLElement>('.color-swatch');
    if (sw) showSwatchTip(sw);
  });
  document.addEventListener('mouseout', (e) => {
    if ((e.target as Element | null)?.closest('.color-swatch')) hideSwatchTip();
  });
  // A fixed chip doesn't follow a scrolling swatch grid — drop it rather than strand it.
  window.addEventListener('scroll', hideSwatchTip, true);
}

/**
 * The viewport origin of the box a `position:fixed` descendant of `el` is laid out
 * against. `fixed` is viewport-relative ONLY when no ancestor establishes a containing
 * block — a `transform`, the individual `translate`/`scale`/`rotate` properties,
 * `perspective`, `filter`, `backdrop-filter`, `will-change`, or `contain` on an ancestor
 * all make `fixed` resolve against THAT box's padding edge instead. Two traps bite here:
 * the sidebar carries `backdrop-filter: blur()`, and every `.input-row` keeps a computed
 * `translate: 0px` from the `card-in` enter animation's `both` fill-mode — and a non-`none`
 * `translate` establishes a containing block even at zero (a computed value other than
 * `none`, not a visible offset, is the trigger). Either way a popover portalled to `fixed`
 * lands on the controls below its trigger. Callers subtract this origin so their
 * viewport-space coords stay correct; returns {0,0} (a no-op) when nothing traps `fixed`.
 */
export function fixedContainingBlockOrigin(el: HTMLElement): { x: number; y: number } {
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const s = getComputedStyle(a);
    const backdrop = s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter');
    // container-type: size/inline-size applies layout containment — a fixed containing
    // block — but computed `contain` does NOT reflect it, so it needs its own check
    // (e.g. the record tool's `.tool-stage.has-record { container-type: inline-size }`).
    const ctype = s.getPropertyValue('container-type');
    if (s.transform !== 'none' || s.translate !== 'none' || s.scale !== 'none' || s.rotate !== 'none' ||
        s.perspective !== 'none' || s.filter !== 'none' ||
        (backdrop && backdrop !== 'none') ||
        (ctype && ctype !== 'normal') ||
        /\b(transform|perspective|filter|translate|scale|rotate)\b/.test(s.willChange) ||
        /\b(strict|content|layout|paint)\b/.test(s.contain)) {
      const r = a.getBoundingClientRect();
      // Containing block is the ancestor's padding box, not its border box.
      return { x: r.left + (parseFloat(s.borderLeftWidth) || 0), y: r.top + (parseFloat(s.borderTopWidth) || 0) };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * Wire every colour field within `scope`. Calls onChange(id, value) with the
 * canonical value string (#rrggbb, #rrggbbaa, or 'transparent'). The trigger
 * preview + sibling controls are kept in sync so the field reflects changes
 * without the host needing to re-render.
 */
export function wireColorField(scope: HTMLElement, { onChange = () => {}, onInteractStart, onInteractEnd }: WireColorFieldOpts = {}): void {
  const interact = (on: boolean) => { (on ? onInteractStart : onInteractEnd)?.(); };
  const q = <T extends Element = Element>(sel: string) => scope.querySelector<T>(sel);
  armSwatchTip();

  // ── The value field's format follows the active mode (when `modes` is on) ─────
  // With a mode picker present, the big value input reads/writes in the active
  // space (OKLCH string / HSL / RGB / CMYK) — like the swatch editor's set-by-value
  // row — instead of always hex. Without modes it stays a plain hex field.
  const MODE_FMT: Record<ColorMode, ColorFormat> = { hex: 'hex', oklch: 'oklch', hsl: 'hsl', rgb: 'rgb', cmyk: 'cmyk' };
  /** The active value-field format for a field, or null (plain hex — no modes). */
  const valueFmt = (field: HTMLElement | null): ColorFormat | null => {
    const m = field?.querySelector<HTMLElement>('.color-modes');
    return m ? MODE_FMT[(m.dataset.activeMode as ColorMode) || 'oklch'] : null;
  };
  /** Write the shared value field for `id` — in the active mode's space, else hex.
   *  Never clobbers the field's TEXT while the user is typing in it, but always
   *  repaints its swatch chrome (background/border/contrast-flipped text). */
  const writeValueField = (id: string, field: HTMLElement | null, fullHex: string): void => {
    const input = q<HTMLInputElement>(`[data-color-hex="${CSS.escape(id)}"]`);
    if (!input) return;
    paintColorInput(input, fullHex);
    if (input === document.activeElement) return;
    const fmt = valueFmt(field);
    input.value = fmt ? formatColor(fmt, fullHex) : fullHex;
  };

  function updateTrigger(field: HTMLElement | null, value: string): void {
    const preview = field?.querySelector<HTMLElement>('.color-trigger-preview');
    const nameText = field?.querySelector<HTMLElement>('.color-trigger-name');
    const isTrans = value === 'transparent';
    if (preview) {
      preview.classList.toggle('color-swatch--transparent', isTrans);
      preview.style.background = isTrans ? '' : (value || '#000000');
    }
    const name = swatchName(value);
    if (nameText) nameText.textContent = name;             // :empty CSS hides it for custom colours
    const trigger = field?.querySelector('.color-trigger');
    if (trigger) trigger.setAttribute('aria-label', `Colour: ${name ? name + ' ' : ''}${value || '#000000'}`);
    updateNearest(field, value);
  }

  // ── Nearest-brand hint ("Snap to Jungle") ────────────────────────────────────
  // A custom colour that lands NEAR a brand swatch is usually a drifted brand
  // colour — offer the snap. Shown only when the value is not already a swatch
  // (ΔEOK > a rounding hair) and the nearest one is close enough to be the
  // intended colour (≤ 0.12 ≈ clearly-related); clicking re-emits through
  // applySwatch, so a token-backed swatch RE-LINKS the value to its ref.
  function updateNearest(field: HTMLElement | null, value: string): void {
    const btn = field?.querySelector<HTMLElement>('.color-nearest');
    if (!btn) return;
    const near = value && value !== 'transparent' ? nearestSwatch(value) : null;
    if (!near || near.d < 0.005 || near.d > 0.12) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.dataset.nearValue = near.value;
    btn.dataset.nearRef = near.ref ?? '';
    const chip = safeCssColor(near.value) || '#c9ccd1';
    btn.innerHTML = `<span class="color-nearest-chip" style="background:${escape(chip)}" aria-hidden="true"></span><span>Snap to ${escape(near.label)}</span>`;
    btn.title = `Nearest brand colour (ΔE ${near.d.toFixed(3)}) — use ${near.label}`;
  }

  scope.querySelectorAll<HTMLElement>('.color-nearest').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.closest<HTMLElement>('[data-color-field]');
      const value = btn.dataset.nearValue;
      if (field && value) applySwatch(field, value, btn.dataset.nearRef || null);
    });
  });

  /** Seed the hint from the field's current colour (the canonical native input)
   *  when the popover opens — updateTrigger only runs on later edits. */
  function seedNearest(field: HTMLElement | null): void {
    if (!field) return;
    const hex = field.querySelector<HTMLInputElement>('input.color-popover-native')?.value || '';
    updateNearest(field, hex);
  }

  // ── OKLCH sliders ────────────────────────────────────────────────────────────
  // The wrapper's data-l/c/h is the single OKLCH state; sliders read AND write
  // it. Drags convert state → hex (gamut-mapped) for the output; hex/swatch/
  // native edits convert hex → state to re-seat the sliders. State only ever
  // crosses through hex in that one direction, so low-chroma hue never drifts.

  /** Repaint the three tracks + readouts from the wrapper's current state. */
  function paintLch(box: HTMLElement): void {
    const l = parseFloat(box.dataset.l!), c = parseFloat(box.dataset.c!), h = parseFloat(box.dataset.h!);
    const tracks = lchTrackGradients(l, c, h);
    for (const [axis, value] of [['l', l * 100], ['c', c], ['h', h]] as const) {
      const slider = box.querySelector<HTMLInputElement>(`[data-lch-axis="${axis}"]`);
      const val = box.querySelector<HTMLElement>(`[data-lch-val="${axis}"]`);
      if (slider) { slider.value = String(value); slider.style.background = tracks[axis]; }
      if (val) val.textContent = axis === 'l' ? `${Math.round(value)}%` : axis === 'c' ? value.toFixed(3) : `${Math.round(value)}°`;
    }
    paintDials(box, lchDials(l, c, h), oklchToHex({ l, c, h }));
    // Out-of-gamut flag: oklchToHex silently reduces chroma when the position
    // leaves sRGB — surface it on the chroma readout instead of pretending the
    // slider position is the emitted colour. 0.01 margin absorbs byte rounding.
    const emitted = hexToOklch(oklchToHex({ l, c, h }));
    const clamped = !!emitted && emitted.c < c - 0.01;
    const cVal = box.querySelector<HTMLElement>('[data-lch-val="c"]');
    if (cVal) {
      cVal.classList.toggle('is-clamped', clamped);
      cVal.title = clamped ? 'Outside sRGB — showing the nearest displayable colour (chroma reduced)' : '';
    }
  }

  /** Re-seed the sliders from a hex chosen elsewhere (swatch / hex box / native).
   *  Re-seeds the OKLCH group AND — when a colour-space mode is active (`modes`)
   *  — the visible generic group, so RGB/HSL/CMYK sliders catch up to the change. */
  function seedLch(field: HTMLElement, hex: string): void {
    const rgb = hex.startsWith('#') ? hex.slice(0, 7) : hex;
    const box = field.querySelector<HTMLElement>('.color-lch');
    if (box) {
      const o = hexToOklch(rgb);
      // 'transparent' / invalid — leave the sliders where they were
      if (o) { box.dataset.l = String(o.l); box.dataset.c = String(o.c); box.dataset.h = String(o.h); paintLch(box); }
    }
    const active = field.querySelector<HTMLElement>('.color-modegroup:not([hidden])');
    if (active && /^#[0-9a-fA-F]{6}$/.test(rgb)) seedGenGroup(active, rgb);
  }

  // ── Palette swatches (lazy) ──────────────────────────────────────────────────
  // Apply a swatch's colour to the field, syncing the popover controls + trigger.
  // A swatch carrying a token `ref` emits a token value ({ ref, value }) so the
  // colour stays linked to the token; a plain swatch emits the hex string. Editing
  // the hex/native/alpha afterwards emits a plain string, de-linking from the token.
  function applySwatch(field: HTMLElement, hex: string, ref: string | null = null): void {
    const id = field.dataset.colorField;
    const native = field.querySelector<HTMLInputElement>('input.color-popover-native');
    const alphaSlider = field.querySelector<HTMLInputElement>('.color-alpha-slider');
    const alphaPctEl = field.querySelector<HTMLElement>('.color-alpha-pct');
    if (native && hex.startsWith('#')) native.value = hex.slice(0, 7);
    if (id) writeValueField(id, field, hex);
    if (alphaSlider) alphaSlider.value = hex === 'transparent' ? '0' : '255';
    if (alphaPctEl) alphaPctEl.textContent = (hex === 'transparent' ? 0 : 100) + '%';
    seedLch(field, hex);
    updateTrigger(field, hex);
    onChange(id!, ref ? { ref, value: hex } : hex);
  }

  // Build the swatch grid the first time a field's popover opens — deferring the
  // whole palette (the heaviest part of each colour cell) until it's needed.
  // Clicks are DELEGATED to the (persistent) box, so the grid can be repopulated
  // later (refreshSwatches, when the brand palette changes) without re-wiring.
  function buildSwatches(field: HTMLElement, force = false): void {
    const box = field.querySelector<HTMLElement>('.color-swatches');
    if (!box || (!force && box.childElementCount)) return; // already built
    box.innerHTML = swatchButtonsHtml(field.dataset.colorField!);
    if (!box.dataset.wired) {
      box.dataset.wired = '1';
      box.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-swatch-value]');
        if (!btn) return;
        applySwatch(field, btn.dataset.swatchValue!, btn.dataset.swatchRef || null);
        // Picking from the disc's swatch menu closes it — a menu, not a panel.
        closeSwatchMenu(field);
      });
    }
  }

  // ── The result disc's swatch menu (inline pickers) ───────────────────────────
  // The disc's edit action opens the brand swatch grid as a floating menu below
  // the disc, reusing buildSwatches/applySwatch. Anchored via offsetTop/Left, so
  // the popover it lives in is the positioned ancestor (CSS makes it relative).
  let swatchMenuOff: (() => void) | null = null;
  function closeSwatchMenu(field: HTMLElement): void {
    const menu = field.querySelector<HTMLElement>('[data-swatch-menu]');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    field.querySelector('[data-dial-act="native"]')?.setAttribute('aria-expanded', 'false');
    if (swatchMenuOff) { swatchMenuOff(); swatchMenuOff = null; }
  }
  function toggleSwatchMenu(field: HTMLElement, menu: HTMLElement, btn: HTMLElement): void {
    if (!menu.hidden) { closeSwatchMenu(field); return; }
    buildSwatches(field);
    const disc = field.querySelector<HTMLElement>('[data-dial-out]');
    if (disc) { menu.style.top = `${disc.offsetTop + disc.offsetHeight + 6}px`; menu.style.left = `${disc.offsetLeft}px`; }
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    // Close on Escape or a click outside the menu (not on the toggle, which handles
    // its own toggle). Deferred so THIS opening click doesn't immediately close it.
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { closeSwatchMenu(field); e.stopPropagation(); } };
    const onDown = (e: PointerEvent): void => {
      const tgt = e.target as Node;
      if (!menu.contains(tgt) && !btn.contains(tgt)) closeSwatchMenu(field);
    };
    setTimeout(() => {
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    swatchMenuOff = () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  // Inline fields have no trigger, so the on-open hooks above never fire — seed
  // their nearest-brand hint up front. (They carry no swatch grid to build.)
  scope.querySelectorAll<HTMLElement>('.color-field--inline[data-color-field]').forEach(f => seedNearest(f));

  // ── Trigger: open/close the popover ──────────────────────────────────────────
  scope.querySelectorAll<HTMLElement>('[data-color-trigger]').forEach(trigger => {
    const field = trigger.closest<HTMLElement>('[data-color-field]');
    trigger.addEventListener('click', () => {
      const popover = field?.querySelector<HTMLElement>('.color-popover');
      if (!popover) return;
      scope.querySelectorAll<HTMLElement>('.color-popover:not([hidden])').forEach(p => {
        if (p !== popover) {
          p.hidden = true; p.style.cssText = '';
          p.closest('[data-color-field]')?.querySelector('.color-trigger')?.setAttribute('aria-expanded', 'false');
        }
      });
      popover.hidden = !popover.hidden;
      trigger.setAttribute('aria-expanded', String(!popover.hidden));
      if (popover.hidden) { popover.style.cssText = ''; disarmOutside(); }
      else { buildSwatches(field!); seedNearest(field); positionPopover(field!, trigger, popover); }
    });

    // Escape closes this field's open popover and returns focus to the trigger.
    // Bound to the field (re-created on each render) — not the persistent scope —
    // so re-wiring on re-render doesn't accumulate listeners.
    field?.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const popover = field.querySelector<HTMLElement>('.color-popover:not([hidden])');
      if (!popover) return;
      popover.hidden = true; popover.style.cssText = ''; disarmOutside();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
      e.stopPropagation();
    });
  });

  function positionPopover(field: HTMLElement, trigger: HTMLElement, popover: HTMLElement): void {
    // Force-settle any in-flight entrance cascade on the field's ancestors first: while
    // `card-in` is running, the animated `translate` makes that ancestor the popover's
    // containing block — mispositioned AND clipped by the section — and the trap would
    // flip anyway (a visible jump) the moment the animation ends. Stripping .reveal-item
    // cancels the animation and snaps the item straight to its natural (settled) state.
    for (let a = field.closest<HTMLElement>('.reveal-item'); a;
         a = a.parentElement ? a.parentElement.closest<HTMLElement>('.reveal-item') : null) {
      a.classList.remove('reveal-item');
      a.style.removeProperty('--reveal-delay');
    }
    // We compute viewport-space coords below, then translate into the box `fixed`
    // is actually laid out against (the sidebar's backdrop-filter traps it — see
    // fixedContainingBlockOrigin). `cb` is {0,0} when `fixed` is truly viewport-relative.
    const cb = fixedContainingBlockOrigin(popover);
    if (field.classList.contains('block-color-field')) {
      // Block colour fields span the sidebar (escape its overflow clipping).
      const sidebar = scope.closest('.sidebar-body') || scope.closest('.sidebar');
      if (sidebar) {
        const sb = sidebar.getBoundingClientRect();
        const t = trigger.getBoundingClientRect();
        popover.style.cssText = `position:fixed;top:${t.bottom + 4 - cb.y}px;left:${sb.left + 14 - cb.x}px;width:${sb.width - 28}px;right:auto;z-index:10001;`;
      }
      // Same close-on-outside/scroll as the other fixed branches — without it the
      // popover survives a click on another block's field and strands on scroll.
      armOutside(field, popover);
    } else if (field.classList.contains('color-field--float')) {
      // Float: dock to the CELL frame's top-left (not the trigger's — the field's
      // padding would otherwise leave the popover a few px low), escaping any
      // scroll container; close on outside. Match the cell width when it's wider
      // than the minimum (the field is fluid at 100%), squaring the docked corner.
      const t = (trigger.closest('td') || trigger).getBoundingClientRect();
      const W = Math.max(224, Math.round(t.width));
      const left = Math.max(8, Math.min(t.left, window.innerWidth - W - 8));
      popover.style.cssText = `position:fixed;top:${Math.round(t.top - cb.y)}px;left:${Math.round(left - cb.x)}px;width:${W}px;right:auto;z-index:10001;border-top-left-radius:0;`;
      armOutside(field, popover);
    } else {
      // Regular sidebar field: portal to position:fixed anchored to the field (like the
      // block/float branches). An absolute popover was trapped whenever an ancestor
      // formed a stacking context — the focus-spotlight dim on non-focused
      // sections, or the section's own clip — and a later section painted over it (the
      // "picker renders below" bug). Fixed escapes every ancestor stacking context and
      // overflow clip, so it's always on top. Flip above when it would overflow the
      // sidebar's bottom; close on any outside interaction.
      const sb = scope.closest('.sidebar-body') || scope.closest('.sidebar');
      const f = field.getBoundingClientRect();
      const prev = popover.style.cssText;
      popover.style.cssText = `position:fixed;visibility:hidden;left:-9999px;top:0;width:${Math.round(f.width)}px;`;
      const ph = popover.offsetHeight;
      const bottomLimit = sb ? sb.getBoundingClientRect().bottom : window.innerHeight;
      const openUp = (bottomLimit - f.bottom) < ph + 10;
      const top = openUp ? Math.max(8, Math.round(f.top - 4 - ph)) : Math.round(f.bottom + 4);
      popover.style.cssText = prev;
      popover.style.cssText = `position:fixed;top:${top - cb.y}px;left:${Math.round(f.left) - cb.x}px;width:${Math.round(f.width)}px;right:auto;z-index:10001;`;
      armOutside(field, popover);
    }
  }

  // Outside-click / scroll close (float + regular sidebar fields, both position:fixed).
  let outside: ((e: PointerEvent) => void) | null = null;
  let onScroll: (() => void) | null = null;
  function armOutside(field: HTMLElement, popover: HTMLElement): void {
    disarmOutside();
    const close = () => { popover.hidden = true; popover.style.cssText = ''; field.querySelector('.color-trigger')?.setAttribute('aria-expanded', 'false'); disarmOutside(); };
    outside = (e) => { if (!field.contains(e.target as Node | null)) close(); };
    // A fixed popover doesn't follow the field — close it on scroll rather than leave
    // it stranded over unrelated controls (capture catches the sidebar's own scroll).
    onScroll = () => close();
    setTimeout(() => {
      document.addEventListener('pointerdown', outside!);
      window.addEventListener('scroll', onScroll!, true);
    }, 0);
  }
  function disarmOutside(): void {
    if (outside) { document.removeEventListener('pointerdown', outside); outside = null; }
    if (onScroll) { window.removeEventListener('scroll', onScroll, true); onScroll = null; }
  }

  // ── OKLCH sliders (the primary custom-colour control) ───────────────────────
  scope.querySelectorAll<HTMLElement>('.color-lch[data-color-lch]').forEach(box => {
    const id = box.dataset.colorLch!;
    const field = box.closest<HTMLElement>('[data-color-field]');
    box.querySelectorAll<HTMLInputElement>('.color-lch-slider').forEach(slider => {
      slider.addEventListener('pointerdown', () => interact(true));
      slider.addEventListener('pointerup', () => interact(false));
      slider.addEventListener('input', () => {
        const axis = slider.dataset.lchAxis as 'l' | 'c' | 'h';
        const raw = parseFloat(slider.value);
        box.dataset[axis] = String(axis === 'l' ? raw / 100 : raw);
        const state = { l: parseFloat(box.dataset.l!), c: parseFloat(box.dataset.c!), h: parseFloat(box.dataset.h!) };
        paintLch(box); // repaint the OTHER two tracks around the new position
        const rgbHex = oklchToHex(state); // gamut-mapped — always a real sRGB hex
        const alphaSlider = q<HTMLInputElement>(`[data-color-alpha="${CSS.escape(id)}"]`);
        const alphaInt = alphaSlider ? parseInt(alphaSlider.value, 10) : 255;
        const fullHex = alphaInt < 255 ? rgbHex + alphaInt.toString(16).padStart(2, '0') : rgbHex;
        writeValueField(id, field, fullHex);
        const native = q<HTMLInputElement>(`input.color-popover-native[data-input-id="${CSS.escape(id)}"]`);
        if (native) native.value = rgbHex;
        updateTrigger(field, fullHex);
        onChange(id, fullHex);
      });
    });
  });

  // ── Dials ────────────────────────────────────────────────────────────────────
  // A dial never emits a colour itself: it converts the pointer's angle to a value
  // and drives the slider for that axis, whose `input` handler already owns the
  // whole emit path (state → gamut-mapped hex → value field → native input →
  // trigger → onChange). One control of record per axis; the dial is a second way
  // to move it. The output disc's two halves delegate to the eyedropper button the
  // popover already carries and to the swatch menu. No-ops where no dials render
  // (the trigger popover) — the row simply isn't there.
  scope.querySelectorAll<HTMLElement>('.color-dials').forEach(row => {
    const field = row.closest<HTMLElement>('[data-color-field]');
    const group = row.closest<HTMLElement>('.color-lch, .color-modegroup');

    row.querySelectorAll<HTMLElement>('.color-dial').forEach(dial => {
      const ch = dial.dataset.dialCh!;
      const slider = group?.querySelector<HTMLInputElement>(`[data-lch-axis="${ch}"], [data-mode-ch="${ch}"]`);
      if (!slider) return;
      const min = parseFloat(slider.min || '0');
      const max = parseFloat(slider.max || '1');

      // Angle → value, measured the same way the needle and the conic are: 0° at
      // 12 o'clock, clockwise. The range's two ends meet at the top, so a drag
      // across that seam jumps min↔max — inherent to putting a linear axis on a
      // ring, and precisely why the slider stays.
      const setFromPointer = (e: PointerEvent): void => {
        const r = dial.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        let ang = Math.atan2(dx, -dy) * 180 / Math.PI;
        if (ang < 0) ang += 360;
        slider.value = String(min + (ang / 360) * (max - min)); // the range input snaps to its own step
        slider.dispatchEvent(new Event('input'));
      };

      dial.addEventListener('pointerdown', e => {
        dial.setPointerCapture(e.pointerId);
        interact(true);
        setFromPointer(e);
        e.preventDefault(); // don't take focus off the slider / start a text selection
      });
      dial.addEventListener('pointermove', e => {
        if (dial.hasPointerCapture(e.pointerId)) setFromPointer(e);
      });
      const release = (e: PointerEvent): void => {
        if (!dial.hasPointerCapture(e.pointerId)) return;
        dial.releasePointerCapture(e.pointerId);
        interact(false);
      };
      dial.addEventListener('pointerup', release);
      dial.addEventListener('pointercancel', release);
    });

    row.querySelectorAll<HTMLElement>('.color-dial-act').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.dialAct === 'eyedropper') { field?.querySelector<HTMLButtonElement>('.color-eyedropper')?.click(); return; }
        // The edit half opens the swatch context menu. Dials render only on inline
        // fields, and those are exactly the ones carrying that menu in place of an
        // always-open grid — so there is no other case to fall back to.
        const menu = field?.querySelector<HTMLElement>('[data-swatch-menu]');
        if (menu && field) toggleSwatchMenu(field, menu, btn);
      });
    });
  });

  // ── Colour-space modes (opt-in `modes`: OKLCH · HSL · RGB · CMYK) ────────────
  // The tab bar swaps which slider group is visible; the OKLCH group is the
  // dedicated .color-lch (wired above), the other three are generic groups
  // driven by the gen* helpers. Each group re-seeds from the current hex on
  // entry, so switching spaces never loses the colour.
  scope.querySelectorAll<HTMLElement>('.color-modes[data-color-modes]').forEach(modes => {
    const id = modes.dataset.colorModes!;
    const field = modes.closest<HTMLElement>('[data-color-field]');
    const lchGroup = modes.querySelector<HTMLElement>('.color-lch');
    const genGroups = modes.querySelectorAll<HTMLElement>('.color-modegroup');

    /** The field's current sRGB hex. The hidden native input always holds the
     *  canonical `#rrggbb` (every handler syncs it), so it's the reliable source
     *  even when the value field is showing a non-hex space (OKLCH/HSL/CMYK). */
    const currentHex = (): string => {
      const nv = q<HTMLInputElement>(`input.color-popover-native[data-input-id="${CSS.escape(id)}"]`)?.value.trim();
      if (nv && /^#[0-9a-fA-F]{6}$/.test(nv)) return nv;
      const raw = q<HTMLInputElement>(`[data-color-hex="${CSS.escape(id)}"]`)?.value.trim() || '';
      const parsed = parseColor(valueFmt(field) ?? 'hex', raw);
      return parsed ? parsed.slice(0, 7) : oklchToHex(LCH_SEED);
    };

    /** Current sRGB hex + the alpha slider's byte → the full value for the field. */
    const currentFullHex = (): string => {
      const rgb = currentHex();
      const alpha = q<HTMLInputElement>(`[data-color-alpha="${CSS.escape(id)}"]`);
      const a = alpha ? parseInt(alpha.value, 10) : 255;
      return a < 255 ? rgb + a.toString(16).padStart(2, '0') : rgb;
    };
    // lib/tabs.ts's shared roving-tabindex machinery (component audit rec 1) —
    // was a hand-rolled click-only listener with no arrow-key nav despite the
    // role="tablist"/role="tab" markup; wireTabs adds that (Left/Right/Home/End
    // + one tab stop) for free. `onSelect` owns everything mode-switch-specific.
    const selectMode = wireTabs(modes, {
      key: 'mode',
      onSelect: (modeValue) => {
        const mode = modeValue as ColorMode;
        // HEX has no sliders of its own — it shows the RGB group. Every group-
        // visibility decision below keys off sliderMode so hex and rgb share it.
        const sliderMode = mode === 'hex' ? 'rgb' : mode;
        modes.dataset.activeMode = mode; // drives the value field's format (valueFmt)
        if (lchGroup) lchGroup.hidden = sliderMode !== 'oklch';
        genGroups.forEach(g => {
          const on = g.dataset.modeGroup === sliderMode;
          g.hidden = !on;
          if (on) seedGenGroup(g, currentHex()); // catch up to the current colour
        });
        if (sliderMode === 'oklch' && field) seedLch(field, currentHex());
        writeValueField(id, field, currentFullHex()); // reformat the value field to the new space
      },
    });
    // Establish the roving tabindex for the server-rendered active mode, and
    // seed the value field in that space on wire.
    selectMode(modes.dataset.activeMode ?? 'oklch');

    genGroups.forEach(group => {
      const mode = group.dataset.modeGroup as GenMode;
      group.querySelectorAll<HTMLInputElement>('.color-mode-slider').forEach(slider => {
        slider.addEventListener('pointerdown', () => interact(true));
        slider.addEventListener('pointerup', () => interact(false));
        slider.addEventListener('input', () => {
          group.dataset[slider.dataset.modeCh!] = slider.value;
          const st: Record<string, number> = {};
          for (const a of MODE_AXES[mode]) st[a.ch] = parseFloat(group.dataset[a.ch] ?? '0');
          paintGenGroup(group); // repaint the other tracks around the new position
          const rgbHex = genToHex(mode, st);
          const alphaSlider = q<HTMLInputElement>(`[data-color-alpha="${CSS.escape(id)}"]`);
          const alphaInt = alphaSlider ? parseInt(alphaSlider.value, 10) : 255;
          const fullHex = alphaInt < 255 ? rgbHex + alphaInt.toString(16).padStart(2, '0') : rgbHex;
          writeValueField(id, field, fullHex);
          const native = q<HTMLInputElement>(`input.color-popover-native[data-input-id="${CSS.escape(id)}"]`);
          if (native) native.value = rgbHex;
          updateTrigger(field, fullHex);
          onChange(id, fullHex);
        });
      });
    });
  });

  // ── Native colour input (RGB) ────────────────────────────────────────────────
  scope.querySelectorAll<HTMLInputElement>('input.color-popover-native[data-input-id]').forEach(native => {
    const id = native.dataset.inputId!;
    const field = native.closest<HTMLElement>('[data-color-field]');
    native.addEventListener('pointerdown', () => interact(true));
    native.addEventListener('pointerup', () => interact(false));
    native.addEventListener('input', () => {
      const alphaSlider = q<HTMLInputElement>(`[data-color-alpha="${CSS.escape(id)}"]`);
      const alphaInt = alphaSlider ? parseInt(alphaSlider.value, 10) : 255;
      const fullHex = (alphaInt < 255 ? native.value + alphaInt.toString(16).padStart(2, '0') : native.value).toLowerCase();
      writeValueField(id, field, fullHex);
      if (field) seedLch(field, native.value);
      updateTrigger(field, fullHex);
      onChange(id, fullHex);
    });
  });

  // ── Screen eyedropper ────────────────────────────────────────────────────────
  // The EyeDropper API's overlay samples ANYWHERE on screen — other windows and
  // the desktop included, not just this page (Chromium; secure contexts). Where
  // it doesn't exist (Firefox/Safari, the Tauri WebViews) the button is removed,
  // never a dead control. The picked colour applies exactly like a native-picker
  // change: current alpha kept, sliders re-seeded, trigger + host notified. The
  // OS overlay swallows pointer events, so the popover's close-on-outside never
  // fires mid-pick; interact() still brackets it like a slider drag so hosts
  // hold their popover/undo grouping open.
  scope.querySelectorAll<HTMLButtonElement>('.color-eyedropper[data-color-eyedropper]').forEach(btn => {
    type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };
    const EyeDropper = (window as { EyeDropper?: EyeDropperCtor }).EyeDropper;
    if (!EyeDropper) { btn.remove(); return; }
    const id = btn.dataset.colorEyedropper!;
    const field = btn.closest<HTMLElement>('[data-color-field]');
    btn.addEventListener('click', async () => {
      interact(true);
      try {
        const rgbHex = (await new EyeDropper().open()).sRGBHex.toLowerCase();
        const alphaSlider = q<HTMLInputElement>(`[data-color-alpha="${CSS.escape(id)}"]`);
        const alphaInt = alphaSlider ? parseInt(alphaSlider.value, 10) : 255;
        const fullHex = alphaInt < 255 ? rgbHex + alphaInt.toString(16).padStart(2, '0') : rgbHex;
        const native = q<HTMLInputElement>(`input.color-popover-native[data-input-id="${CSS.escape(id)}"]`);
        if (native) native.value = rgbHex;
        writeValueField(id, field, fullHex);
        if (field) seedLch(field, fullHex);
        updateTrigger(field, fullHex);
        onChange(id, fullHex);
      } catch { /* Esc / dismissed — nothing picked */ }
      finally { interact(false); }
    });
  });

  // ── Hex text entry ───────────────────────────────────────────────────────────
  scope.querySelectorAll<HTMLInputElement>('.color-input[data-color-hex]').forEach(hexInput => {
    const id = hexInput.dataset.colorHex!;
    const field = hexInput.closest<HTMLElement>('[data-color-field]');
    hexInput.addEventListener('focus', () => interact(true));
    hexInput.addEventListener('blur', () => interact(false));
    hexInput.addEventListener('input', () => {
      const raw = hexInput.value.trim();
      const fmt = valueFmt(field);
      const alphaSlider = q<HTMLInputElement>(`[data-color-alpha="${CSS.escape(id)}"]`);
      const alphaPctEl = q<HTMLElement>(`[data-alpha-pct="${CSS.escape(id)}"]`);
      const native = q<HTMLInputElement>(`input.color-popover-native[data-input-id="${CSS.escape(id)}"]`);
      // When a mode is active the value field speaks that space (LCH/HSL/RGB/CMYK);
      // parse in it. `parseColor` may return a hex8 (oklch/rgba can carry alpha);
      // otherwise keep the alpha slider's current value.
      const parsed = fmt ? parseColor(fmt, raw) : (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(raw) ? raw : null);
      if (!parsed) return; // unparseable mid-edit — hold the last good colour
      const rgbHex = parsed.slice(0, 7);
      const alphaInt = parsed.length === 9 ? parseInt(parsed.slice(7, 9), 16)
        : (fmt && alphaSlider ? parseInt(alphaSlider.value, 10) : 255);
      if (native) native.value = rgbHex;
      if (alphaSlider) alphaSlider.value = String(alphaInt);
      if (alphaPctEl) alphaPctEl.textContent = Math.round(alphaInt / 255 * 100) + '%';
      const finalVal = (alphaInt < 255 ? rgbHex + alphaInt.toString(16).padStart(2, '0') : rgbHex).toLowerCase();
      paintColorInput(hexInput, finalVal);   // typing repaints the swatch chrome live
      if (field) seedLch(field, finalVal);
      updateTrigger(field, finalVal);
      onChange(id, finalVal);
    });
  });

  // ── Alpha slider ─────────────────────────────────────────────────────────────
  scope.querySelectorAll<HTMLInputElement>('.color-alpha-slider[data-color-alpha]').forEach(alphaSlider => {
    const id = alphaSlider.dataset.colorAlpha!;
    const field = alphaSlider.closest<HTMLElement>('[data-color-field]');
    alphaSlider.addEventListener('pointerdown', () => interact(true));
    alphaSlider.addEventListener('pointerup', () => interact(false));
    alphaSlider.addEventListener('input', () => {
      const alphaInt = parseInt(alphaSlider.value, 10);
      const alphaPctEl = q<HTMLElement>(`[data-alpha-pct="${CSS.escape(id)}"]`);
      if (alphaPctEl) alphaPctEl.textContent = Math.round(alphaInt / 255 * 100) + '%';
      const native = q<HTMLInputElement>(`input.color-popover-native[data-input-id="${CSS.escape(id)}"]`);
      const rgbHex = native?.value || '#000000';
      const fullHex = (alphaInt < 255 ? rgbHex + alphaInt.toString(16).padStart(2, '0') : rgbHex).toLowerCase();
      writeValueField(id, field, fullHex);
      updateTrigger(field, fullHex);
      onChange(id, fullHex);
    });
  });
}

export interface MountColorFieldOpts {
  /** Initial colour (#rrggbb / #rrggbbaa / 'transparent' / token value). */
  value?: unknown;
  /** Called with the canonical value string on every change. */
  onChange(value: string): void;
  float?: boolean;
  swatchesOnly?: boolean;
  inline?: boolean;
  modes?: boolean;
  onInteractStart?(): void;
  onInteractEnd?(): void;
}

/**
 * Mount our colour picker into `container`, in place of a native
 * `<input type=color>` — the shell never opens the OS colour picker, so every
 * colour surface routes through this one component. Fills the container with a
 * single field and wires it; `onChange` gets the canonical value string
 * (#rrggbb / #rrggbbaa / 'transparent'). Returns the field element so callers
 * can find its trigger for styling. Safe to call again on the same container to
 * re-seed (it replaces the contents).
 */
export function mountColorField(container: HTMLElement, id: string, opts: MountColorFieldOpts): HTMLElement {
  container.innerHTML = colorFieldHtml(id, opts.value ?? '', {
    float: opts.float, swatchesOnly: opts.swatchesOnly, inline: opts.inline, modes: opts.modes,
  });
  wireColorField(container, {
    onChange: (_id, value) => opts.onChange(String(value)),
    onInteractStart: opts.onInteractStart,
    onInteractEnd: opts.onInteractEnd,
  });
  return container.querySelector<HTMLElement>('[data-color-field]') ?? container;
}
