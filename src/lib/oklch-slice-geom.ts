// SPDX-License-Identifier: MPL-2.0
/**
 * OKLCH slice geometry — the pure mapping between a colour and its position on a
 * 2D plane through OKLCH space. Split out of oklch-slice.ts (which imports CSS
 * and touches a canvas) so it stays DOM-free and unit-testable under
 * `node --test` — the same split palette-wheel-geom.ts makes for the wheel.
 *
 * The wheel plots hue and chroma polar-style and lets the dot's own colour carry
 * lightness. That reads beautifully as an instrument, but it cannot show the one
 * thing a brand needs before committing to a colour: WHERE THE GAMUT ENDS. The
 * sRGB boundary is a curve in lightness×chroma that moves with hue — yellow
 * reaches roughly twice the chroma of blue — so it only becomes visible on a
 * plane that has lightness or chroma as a real axis.
 *
 * Hence the three planes (engine `SlicePlane`; the FIRST letter is the vertical
 * axis, the second the horizontal one):
 *
 *   'lc'  lightness × chroma at a fixed hue  — the horseshoe. The working view.
 *   'ch'  chroma × hue at a fixed lightness  — which hues hold up at this L.
 *   'lh'  lightness × hue at a fixed chroma  — can a ramp keep this chroma?
 *
 * Coordinates here are FRACTIONS of the plot box, x rightward and y DOWNWARD
 * (SVG/canvas convention), so a caller multiplies by its pixel size. The engine's
 * `sliceGamutEdge` returns points in the same space.
 */

import type { SlicePlane } from '@lolly/engine';

/** Ceiling of the chroma axis. Matches the colour picker's C slider maximum, so
 *  a colour cannot sit off the edge of one surface and on another. */
export const SLICE_C_MAX = 0.4;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const normHue = (h: number): number => ((h % 360) + 360) % 360;

export interface Oklch { l: number; c: number; h: number }
export interface SliceXY { x: number; y: number }

/** What each plane's axes and fixed channel are, for labels and controls. */
export interface SliceAxes {
  /** The channel on the horizontal axis. */
  x: 'l' | 'c' | 'h';
  /** The channel on the vertical axis (its maximum is at the TOP). */
  y: 'l' | 'c' | 'h';
  /** The channel held constant across the plane. */
  fixed: 'l' | 'c' | 'h';
}

export const SLICE_AXES: Record<SlicePlane, SliceAxes> = {
  lc: { x: 'c', y: 'l', fixed: 'h' },
  ch: { x: 'h', y: 'c', fixed: 'l' },
  lh: { x: 'h', y: 'l', fixed: 'c' },
};

/** The full range of a channel, for scaling a position to a value. */
const channelMax = (ch: 'l' | 'c' | 'h', cMax: number): number =>
  ch === 'h' ? 360 : ch === 'c' ? cMax : 1;

/** A colour's value on one channel. */
const channelOf = (o: Oklch, ch: 'l' | 'c' | 'h'): number =>
  ch === 'h' ? normHue(o.h) : ch === 'c' ? o.c : o.l;

/**
 * Where a colour plots on a plane, as fractions of the box (x right, y DOWN).
 *
 * This is a PROJECTION: a colour whose fixed channel differs from the slice's
 * still lands somewhere, because a palette has to stay visible while you scrub
 * through hues. Pair it with {@link sliceOffPlane} to fade the dots that aren't
 * really there — a dot drawn at full strength on a plane it doesn't belong to
 * would be the chart lying.
 */
export function oklchSliceXY(plane: SlicePlane, o: Oklch, cMax = SLICE_C_MAX): SliceXY {
  const { x, y } = SLICE_AXES[plane];
  return {
    x: clamp01(channelOf(o, x) / channelMax(x, cMax)),
    y: 1 - clamp01(channelOf(o, y) / channelMax(y, cMax)), // the axis maximum is at the top
  };
}

/**
 * A position on the plane → the colour there. Inverse of {@link oklchSliceXY};
 * `fixed` supplies the channel the plane holds constant, which the position
 * cannot know.
 */
export function sliceXYToOklch(
  plane: SlicePlane, x: number, y: number, fixed: number, cMax = SLICE_C_MAX,
): Oklch {
  const axes = SLICE_AXES[plane];
  const out: Oklch = { l: 0, c: 0, h: 0 };
  out[axes.x] = clamp01(x) * channelMax(axes.x, cMax);
  out[axes.y] = (1 - clamp01(y)) * channelMax(axes.y, cMax);
  out[axes.fixed] = axes.fixed === 'h' ? normHue(fixed) : Math.max(0, fixed);
  // The right edge of a hue axis is 360°, which IS 0° — normalise so callers
  // never see an out-of-range hue from a drag that reached the far edge.
  out.h = normHue(out.h);
  return out;
}

/** The value this colour would need the slice fixed at to lie exactly on it —
 *  what a "snap the chart to this swatch" click sets. */
export function sliceFixedOf(plane: SlicePlane, o: Oklch): number {
  return channelOf(o, SLICE_AXES[plane].fixed);
}

/**
 * How far off this plane a colour sits, 0 (exactly on it) … 1 (as far as the
 * fixed channel goes). Hue wraps, so 350° is near 10°; a near-grey is treated as
 * ON every hue plane, because its hue is noise rather than a choice — the same
 * `carry` threshold the engine's `mixOklch` uses.
 */
export function sliceOffPlane(plane: SlicePlane, o: Oklch, fixed: number, cMax = SLICE_C_MAX): number {
  const ch = SLICE_AXES[plane].fixed;
  if (ch === 'h') {
    if (o.c < 0.02) return 0;
    const d = Math.abs(normHue(o.h) - normHue(fixed));
    return Math.min(d, 360 - d) / 180;
  }
  return Math.min(1, Math.abs(channelOf(o, ch) - fixed) / channelMax(ch, cMax));
}

/**
 * Tick positions for an axis, as `{ at, label }` in box fractions along that
 * axis (0 = left/top edge). Callers place them; this owns the numbers so the
 * three planes are labelled consistently.
 */
export function sliceTicks(ch: 'l' | 'c' | 'h', cMax = SLICE_C_MAX): { at: number; label: string }[] {
  if (ch === 'h') {
    return [0, 60, 120, 180, 240, 300, 360].map(d => ({ at: d / 360, label: `${d}°` }));
  }
  if (ch === 'l') {
    return [0, 0.25, 0.5, 0.75, 1].map(l => ({ at: l, label: `${Math.round(l * 100)}%` }));
  }
  const step = cMax / 4;
  return [0, 1, 2, 3, 4].map(i => ({ at: i / 4, label: (i * step).toFixed(2) }));
}
