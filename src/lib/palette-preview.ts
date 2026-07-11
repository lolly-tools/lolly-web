// SPDX-License-Identifier: MPL-2.0
/**
 * Illustrative "your palette applied to graphics" mockups for the brand
 * generator — à la palettemaker.com: instead of a flat row of swatches, show
 * the palette living on real-looking artwork (a poster, a chart, a UI card) so
 * the user sees how the colours actually behave together, and how the picture
 * fills out as they add more colours.
 *
 * Every scene is a self-contained, viewBox'd SVG string (no <script>, no
 * external <image>/href, no url() refs) meant to be dropped into the DOM via
 * innerHTML. Because the palette comes from user input, EVERY colour is passed
 * through `col()` before it touches an SVG attribute — only `#rgb…#rrggbbaa`
 * hex (per /^#[0-9a-f]{3,8}$/i) or the literal 'transparent' survives; anything
 * else (`'#000;url(x)'`, `'red"/>'`, …) is replaced with a safe fallback, so a
 * hostile string can never break out of the attribute it lands in.
 *
 * Pure + deterministic: the same palette always yields the same three SVGs.
 */

import { contrastRatio } from '@lolly/engine';

export interface PalettePreview {
  /** Human name for the scene ("Poster", "Chart", "UI card"). */
  label: string;
  /** A complete, self-contained SVG document string. */
  svg: string;
}

// ── Colour sanitisation ───────────────────────────────────────────────────────

/** The only shapes allowed straight into an SVG attribute (plus 'transparent'). */
const HEX_RE = /^#[0-9a-f]{3,8}$/i;
/** Neutral stand-in when a colour is missing/invalid, or the palette is empty. */
const FALLBACK = '#8a8f98';
/** A pleasant default palette when the caller passes nothing usable at all. */
const FALLBACK_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'] as const;

/** Attribute-safe colour: a validated hex, 'transparent', or the fallback. */
function col(c: unknown, fallback: string = FALLBACK): string {
  if (c === 'transparent') return 'transparent';
  return typeof c === 'string' && HEX_RE.test(c) ? c : fallback;
}

/** #rgb/#rgba/#rrggbb/#rrggbbaa → [r,g,b] 0-255, or null when unparseable. */
function toRgb(hex: string): [number, number, number] | null {
  let h = hex.replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((ch) => ch + ch).join('');
  if (h.length < 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [r, g, b].some(Number.isNaN) ? null : [r, g, b];
}

/** A readable ink colour (near-black or white) for text/marks sitting on `bg` —
 *  whichever wins the engine's WCAG contrastRatio (one implementation of the
 *  luminance math app-wide; this file used to carry its own approximation). */
function ink(bg: string): string {
  const hex = col(bg);
  if (hex === 'transparent') return '#141414';
  return contrastRatio('#141414', hex) >= contrastRatio('#ffffff', hex) ? '#141414' : '#ffffff';
}

/** Mix a colour toward black (amt<0) or white (amt>0); returns valid #rrggbb. */
function shade(hex: string, amt: number): string {
  const rgb = toRgb(hex);
  if (!rgb) return col(hex);
  const target = amt < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(amt));
  return '#' + rgb
    .map((v) => Math.round(v + (target - v) * p).toString(16).padStart(2, '0'))
    .join('');
}

// ── Palette prep ──────────────────────────────────────────────────────────────

/** Sanitise the caller's palette to a non-empty list of real hex colours. */
function normalizePalette(colors: unknown): string[] {
  const arr = Array.isArray(colors) ? colors : [];
  const clean = arr
    .map((c) => (typeof c === 'string' && HEX_RE.test(c) ? c : null))
    .filter((c): c is string => c !== null);
  return clean.length ? clean : [...FALLBACK_PALETTE];
}

/**
 * Pad a short palette up to `min` entries with tints/shades of its own colours,
 * so a 1–2 colour palette still fills a scene with distinguishable fields. The
 * user's real colours stay at the front (index order preserved).
 */
function expand(pal: string[], min: number): string[] {
  const out = [...pal];
  let k = 0;
  while (out.length < min) {
    const base = pal[k % pal.length]!; // pal is non-empty (normalizePalette)
    const amt = (Math.floor(k / pal.length) + 1) * 0.16 * (k % 2 ? -1 : 1);
    out.push(shade(base, amt));
    k++;
  }
  return out;
}

/** Cycle: colour at index `i`, wrapping the palette. */
const at = (pal: string[], i: number): string => col(pal[i % pal.length]);

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Opening tag: viewBox'd, responsive (fills width, keeps ratio), labelled. */
function open(w: number, h: number, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" `
    + `aria-label="${label}" style="width:100%;height:auto;display:block">`;
}

// ── Scene 1: Poster ───────────────────────────────────────────────────────────

function poster(ex: string[]): string {
  const bg = at(ex, 0);
  const orb = at(ex, 2);
  const wedge = at(ex, 1);
  const footer = at(ex, 3);
  const head = ink(bg);
  return open(300, 380, 'Poster mockup using your palette')
    + `<rect width="300" height="380" fill="${bg}"/>`
    // big accent orb, bleeding off the top-right corner
    + `<circle cx="278" cy="46" r="120" fill="${orb}"/>`
    // a brand "dot" mark, top-left
    + `<circle cx="42" cy="52" r="15" fill="${wedge}"/>`
    // heading text block (contrast-picked bars)
    + `<rect x="32" y="150" width="150" height="26" rx="5" fill="${head}"/>`
    + `<rect x="32" y="186" width="112" height="26" rx="5" fill="${head}"/>`
    + `<rect x="32" y="224" width="82" height="12" rx="6" fill="${wedge}"/>`
    // footer bar with a logo dot + baseline
    + `<rect x="0" y="300" width="300" height="80" fill="${footer}"/>`
    + `<circle cx="42" cy="340" r="16" fill="${ink(footer)}"/>`
    + `<rect x="70" y="334" width="120" height="12" rx="6" fill="${ink(footer)}"/>`
    + '</svg>';
}

// ── Scene 2: Chart ────────────────────────────────────────────────────────────

function chart(ex: string[], bars: number): string {
  const padL = 22, padR = 18, top = 58, base = 188, w = 320;
  const usable = w - padL - padR;
  const gap = 10;
  const bw = (usable - gap * (bars - 1)) / bars;
  let rects = '';
  for (let i = 0; i < bars; i++) {
    // deterministic, varied heights so it reads as data even in one colour
    const hn = 0.35 + 0.6 * (0.5 + 0.5 * Math.sin(i * 1.25 + 0.7));
    const bh = Math.round((base - top) * hn);
    const x = r1(padL + i * (bw + gap));
    const y = base - bh;
    rects += `<rect x="${x}" y="${y}" width="${r1(bw)}" height="${bh}" rx="3" fill="${at(ex, i)}"/>`;
  }
  return open(w, 220, 'Bar chart using your palette')
    + `<rect width="${w}" height="220" rx="16" fill="#ffffff" stroke="#eceef2"/>`
    // title + subtitle lines
    + `<rect x="22" y="20" width="112" height="12" rx="4" fill="#2b2f36"/>`
    + `<rect x="22" y="38" width="70" height="8" rx="4" fill="#cbced4"/>`
    // faint gridlines + baseline
    + `<line x1="22" y1="150" x2="302" y2="150" stroke="#eef0f3" stroke-width="1"/>`
    + `<line x1="22" y1="112" x2="302" y2="112" stroke="#eef0f3" stroke-width="1"/>`
    + `<line x1="22" y1="${base}" x2="302" y2="${base}" stroke="#e4e6ea" stroke-width="1.5"/>`
    + rects
    + '</svg>';
}

// ── Scene 3: UI card ──────────────────────────────────────────────────────────

function uiCard(ex: string[]): string {
  const primary = at(ex, 0);
  const btn = at(ex, 1);
  const w = 320, h = 220;
  // chips cycle the accents after the primary
  let chips = '';
  for (let i = 0; i < 4; i++) {
    const x = 24 + i * 52;
    chips += `<rect x="${x}" y="130" width="42" height="20" rx="10" fill="${at(ex, i + 1)}"/>`;
  }
  return open(w, h, 'App UI card using your palette')
    // card body (full border — not a one-sided stripe)
    + `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="16" fill="#ffffff" stroke="#e7e9ee"/>`
    // header bar with top corners rounded to match the card
    + `<path d="M0 16 A16 16 0 0 1 16 0 L304 0 A16 16 0 0 1 320 16 L320 46 L0 46 Z" fill="${primary}"/>`
    + `<circle cx="24" cy="23" r="4.5" fill="${at(ex, 1)}"/>`
    + `<circle cx="42" cy="23" r="4.5" fill="${at(ex, 2)}"/>`
    + `<circle cx="60" cy="23" r="4.5" fill="${at(ex, 3)}"/>`
    + `<circle cx="296" cy="23" r="11" fill="${at(ex, 2)}"/>`
    // title + body copy
    + `<rect x="24" y="64" width="120" height="15" rx="4" fill="#2b2f36"/>`
    + `<rect x="24" y="90" width="252" height="9" rx="4" fill="#dfe2e7"/>`
    + `<rect x="24" y="106" width="196" height="9" rx="4" fill="#dfe2e7"/>`
    // accent chips
    + chips
    // primary + secondary buttons
    + `<rect x="24" y="170" width="110" height="32" rx="9" fill="${btn}"/>`
    + `<rect x="54" y="183" width="50" height="6" rx="3" fill="${ink(btn)}"/>`
    + `<rect x="146" y="170" width="110" height="32" rx="9" fill="transparent" stroke="${at(ex, 2)}" stroke-width="2"/>`
    + `<rect x="176" y="183" width="50" height="6" rx="3" fill="${at(ex, 2)}"/>`
    + '</svg>';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Three illustrative SVG scenes painted from `colors` (the brand palette, in
 * order — `colors[0]` is treated as primary). Bar count in the chart reflects
 * the palette size, or `opts.steps` when given. Pure + deterministic; each SVG
 * is self-contained and safe to inject via innerHTML.
 */
export function palettePreviewSvgs(colors: string[], opts?: { steps?: number }): PalettePreview[] {
  const pal = normalizePalette(colors);
  const bars = opts?.steps != null && Number.isFinite(opts.steps)
    ? clamp(Math.round(opts.steps), 2, 12)
    : clamp(pal.length, 5, 8);
  // Enough distinct fields for every scene, even from a 1-colour palette.
  const ex = expand(pal, Math.max(6, bars));
  return [
    { label: 'Poster', svg: poster(ex) },
    { label: 'Chart', svg: chart(ex, bars) },
    { label: 'UI card', svg: uiCard(ex) },
  ];
}
