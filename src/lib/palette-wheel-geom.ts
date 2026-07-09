// SPDX-License-Identifier: MPL-2.0
/**
 * Palette-wheel geometry — the pure OKLCH↔polar mapping the wheel plots and drags
 * through. Split out of palette-wheel.ts (which imports CSS) so it stays DOM- and
 * CSS-free and can be unit-tested under `node --test` (palette-wheel.test.ts).
 *
 * The disc is an OKLCH hue/chroma plane: angle = hue (0° straight up, clockwise),
 * distance from the centre = chroma (grey at the middle, vivid at the rim).
 * Lightness is the third axis and is NOT positional — it rides in the dot's colour.
 */

// Disc geometry, in % of the square box. The rim is where the highest in-gamut
// chroma lands; a small inner floor keeps near-greys off the exact centre so
// they're still clickable. CMAX is a practical sRGB chroma ceiling — colours
// past it (rare) just pin to the rim.
export const WHEEL_R = 41;
export const WHEEL_R_IN = 4;
export const WHEEL_CMAX = 0.33;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const DEG = Math.PI / 180;

/** OKLCH → dot position (x,y in % of the box). angle=hue, radius=chroma. */
export function oklchWheelXY(o: { l: number; c: number; h: number }): { x: number; y: number } {
  const rad = WHEEL_R_IN + clamp(o.c / WHEEL_CMAX, 0, 1) * (WHEEL_R - WHEEL_R_IN);
  return { x: 50 + rad * Math.sin(o.h * DEG), y: 50 - rad * Math.cos(o.h * DEG) };
}

/** Dot position (x,y in % of the box) → { c, h }. Inverse of oklchWheelXY. */
export function wheelXYToChromaHue(x: number, y: number): { c: number; h: number } {
  const dx = x - 50, dy = y - 50;
  const rad = Math.hypot(dx, dy);
  const c = clamp((rad - WHEEL_R_IN) / (WHEEL_R - WHEEL_R_IN), 0, 1) * WHEEL_CMAX;
  let h = Math.atan2(dx, -dy) / DEG;
  if (h < 0) h += 360;
  return { c, h };
}
