// SPDX-License-Identifier: MPL-2.0
/**
 * Colour-format bridge — read and write one colour in Hex / RGB / RGBA / OKLCH /
 * CMYK, always round-tripping through a canonical sRGB hex.
 *
 * The brand editor's swatch popover lets a user set a swatch from ANY of these
 * spaces and extrapolates the rest (Andy: "set the CMYK, Hex, RGBA or LCH values
 * … and extrapolate the RGB or hex"). Everything funnels to a `#rrggbb`(`aa`)
 * hex, which is what the DTCG doc stores and every picker/export already reads.
 *
 * "LCH" in this app means OKLCH — the perceptual space the tokens, the wizard and
 * the colour field all speak (brand.json `$value`s are `oklch()` strings). All
 * conversions defer to the engine's colour authority (rgbToCmyk / cmykToRgbApprox
 * / hexToOklch / oklchToHex / colorToHex); this module only parses/formats the
 * human-facing text around them. Pure + DOM-free → unit-tested (color-formats.test.ts).
 */

import { colorToHex, rgbToCmyk, cmykToRgbApprox, hexToOklch, oklchToHex } from '@lolly/engine';

export type ColorFormat = 'hex' | 'rgb' | 'rgba' | 'oklch' | 'cmyk';

export const COLOR_FORMATS: ReadonlyArray<{ id: ColorFormat; label: string; hint: string }> = [
  { id: 'hex', label: 'Hex', hint: '#4f83cc' },
  { id: 'rgb', label: 'RGB', hint: '79, 131, 204' },
  { id: 'rgba', label: 'RGBA', hint: '79, 131, 204, 1' },
  { id: 'oklch', label: 'OKLCH', hint: '60% 0.1 250' },
  { id: 'cmyk', label: 'CMYK', hint: '61, 36, 0, 20' },
];

export interface Rgba { r: number; g: number; b: number; a: number } // r,g,b 0-255; a 0-1

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const h2 = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
/** All the numbers in a string, in order (tolerant of commas/labels/parens/%). */
const nums = (s: string): number[] => (s.match(/-?\d*\.?\d+/g) ?? []).map(Number).filter(n => !Number.isNaN(n));

/** #rgb / #rgba / #rrggbb / #rrggbbaa (with or without the leading #) → channels. */
export function hexToRgba(hex: string): Rgba | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

/** Channels → `#rrggbb`, or `#rrggbbaa` when `a < 1`. */
export function rgbaToHex(r: number, g: number, b: number, a = 1): string {
  const base = `#${h2(r)}${h2(g)}${h2(b)}`;
  return a >= 1 ? base : base + h2(a * 255);
}

const fmtNum = (n: number, dp: number): string => {
  const s = n.toFixed(dp);
  return dp > 0 ? s.replace(/\.?0+$/, '') : s; // trim trailing zeros for the perceptual axes
};

/**
 * Render `hex` (#rrggbb or #rrggbbaa) as the given format's editable text.
 * Non-hex/unset input yields '' (the caller shows a placeholder).
 */
export function formatColor(fmt: ColorFormat, hex: string): string {
  const rgba = hexToRgba(hex);
  if (!rgba) return '';
  const { r, g, b, a } = rgba;
  const hex6 = rgbaToHex(r, g, b, 1);
  switch (fmt) {
    case 'hex': return (a < 1 ? rgbaToHex(r, g, b, a) : hex6).toUpperCase();
    case 'rgb': return `${r}, ${g}, ${b}`;
    case 'rgba': return `${r}, ${g}, ${b}, ${fmtNum(a, 3)}`;
    case 'oklch': {
      const o = hexToOklch(hex6);
      return o ? `${fmtNum(o.l * 100, 1)}% ${fmtNum(o.c, 4)} ${fmtNum(o.h, 1)}` : '';
    }
    case 'cmyk': {
      const [c, m, y, k] = rgbToCmyk(r / 255, g / 255, b / 255);
      return [c, m, y, k].map(v => Math.round(v * 100)).join(', ');
    }
  }
}

/**
 * Parse a format's text back to a canonical hex (#rrggbb, or #rrggbbaa when an
 * alpha < 1 is given). Returns null on anything unparseable so the caller can
 * hold the last good value. Number entry is forgiving: commas, spaces, `rgb(...)`
 * / `oklch(...)` wrappers and `%` signs are all tolerated — only the numbers matter.
 */
export function parseColor(fmt: ColorFormat, text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  switch (fmt) {
    case 'hex': {
      const hex = colorToHex(t.startsWith('#') ? t : `#${t}`);
      return hex ?? colorToHex(t) ?? null; // also accept a bare named/functional colour
    }
    case 'rgb': {
      const [r, g, b] = nums(t);
      return r === undefined || g === undefined || b === undefined ? null
        : rgbaToHex(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255), 1);
    }
    case 'rgba': {
      const [r, g, b, a] = nums(t);
      if (r === undefined || g === undefined || b === undefined) return null;
      const alpha = a === undefined ? 1 : clamp(a, 0, 1);
      return rgbaToHex(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255), alpha);
    }
    case 'oklch': {
      // L (percent) C H — reconstruct the canonical oklch() the engine parses.
      const [l, c, h] = nums(t);
      if (l === undefined || c === undefined || h === undefined) return null;
      return oklchToHex({ l: clamp(l, 0, 100) / 100, c: Math.max(0, c), h });
    }
    case 'cmyk': {
      const [c, m, y, k] = nums(t);
      if (c === undefined || m === undefined || y === undefined || k === undefined) return null;
      const [r, g, b] = cmykToRgbApprox([c, m, y, k].map(v => clamp(v, 0, 100) / 100) as [number, number, number, number]);
      return rgbaToHex(r * 255, g * 255, b * 255, 1);
    }
  }
}
