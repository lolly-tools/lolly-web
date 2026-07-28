// SPDX-License-Identifier: MPL-2.0
/**
 * oklch-slice-geom.ts — the pure colour↔position mapping the gamut charts plot
 * and drag through. Run: node --test "shells/web/src/**\/*.test.ts"
 *
 * The contract that matters: every plane round-trips (a colour placed at a
 * position comes back from that position), the axis maxima are where the doc
 * says they are, and off-plane projection is honest about how far off it is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLICE_C_MAX, SLICE_AXES, oklchSliceXY, sliceXYToOklch, sliceFixedOf,
  sliceOffPlane, sliceTicks,
} from './oklch-slice-geom.ts';
import type { Oklch } from './oklch-slice-geom.ts';

const PLANES = ['lc', 'ch', 'lh'] as const;

test('every plane round-trips a colour through its position', () => {
  const colors: Oklch[] = [
    { l: 0.5, c: 0.1, h: 0 }, { l: 0.82, c: 0.2, h: 145 },
    { l: 0.2, c: 0.05, h: 264 }, { l: 0.95, c: 0.31, h: 330 },
    { l: 0, c: 0, h: 0 }, { l: 1, c: SLICE_C_MAX, h: 359.9 },
  ];
  for (const plane of PLANES) {
    for (const o of colors) {
      const p = oklchSliceXY(plane, o);
      const back = sliceXYToOklch(plane, p.x, p.y, sliceFixedOf(plane, o));
      assert.ok(Math.abs(back.l - o.l) < 1e-9, `${plane} L: ${back.l} vs ${o.l}`);
      assert.ok(Math.abs(back.c - o.c) < 1e-9, `${plane} C: ${back.c} vs ${o.c}`);
      assert.ok(Math.abs(back.h - o.h) < 1e-6, `${plane} H: ${back.h} vs ${o.h}`);
    }
  }
});

test('the axis maximum is at the TOP and the minimum at the left', () => {
  // 'lc': lightness up the side (1 at the top), chroma across (0 at the left).
  assert.deepEqual(oklchSliceXY('lc', { l: 1, c: 0, h: 0 }), { x: 0, y: 0 });
  assert.deepEqual(oklchSliceXY('lc', { l: 0, c: SLICE_C_MAX, h: 0 }), { x: 1, y: 1 });
  // 'ch': chroma up the side, hue across.
  assert.deepEqual(oklchSliceXY('ch', { l: 0.5, c: SLICE_C_MAX, h: 0 }), { x: 0, y: 0 });
  assert.deepEqual(oklchSliceXY('ch', { l: 0.5, c: 0, h: 359.99 }), { x: 359.99 / 360, y: 1 });
  // 'lh': lightness up the side, hue across.
  assert.deepEqual(oklchSliceXY('lh', { l: 1, c: 0.1, h: 180 }), { x: 0.5, y: 0 });
});

test('positions clamp into the box instead of running off it', () => {
  for (const plane of PLANES) {
    for (const o of [
      { l: 2, c: 0.9, h: 400 }, { l: -1, c: -0.5, h: -90 },
    ] as Oklch[]) {
      const p = oklchSliceXY(plane, o);
      assert.ok(p.x >= 0 && p.x <= 1, `${plane} x ${p.x}`);
      assert.ok(p.y >= 0 && p.y <= 1, `${plane} y ${p.y}`);
    }
    // And the inverse never emits a negative channel or an unnormalised hue.
    for (const [x, y] of [[-1, -1], [2, 2], [0.5, 1.5]] as [number, number][]) {
      const o = sliceXYToOklch(plane, x, y, -30);
      assert.ok(o.l >= 0 && o.l <= 1, `${plane} L ${o.l}`);
      assert.ok(o.c >= 0 && o.c <= SLICE_C_MAX, `${plane} C ${o.c}`);
      assert.ok(o.h >= 0 && o.h < 360, `${plane} H ${o.h}`);
    }
  }
});

test('the fixed channel comes from `fixed`, not from the position', () => {
  for (const plane of PLANES) {
    const ch = SLICE_AXES[plane].fixed;
    const a = sliceXYToOklch(plane, 0.3, 0.7, ch === 'h' ? 200 : ch === 'l' ? 0.8 : 0.15);
    const b = sliceXYToOklch(plane, 0.3, 0.7, ch === 'h' ? 40 : ch === 'l' ? 0.2 : 0.05);
    assert.notEqual(a[ch], b[ch], `${plane}: ${ch} should follow the fixed value`);
    for (const other of ['l', 'c', 'h'] as const) {
      if (other !== ch) assert.equal(a[other], b[other], `${plane}: ${other} should not move`);
    }
  }
});

test('off-plane distance wraps hue and forgives greys', () => {
  // 350° and 10° are 20° apart, not 340.
  const near = sliceOffPlane('lc', { l: 0.5, c: 0.2, h: 350 }, 10);
  assert.ok(Math.abs(near - 20 / 180) < 1e-9, `wrapped distance ${near}`);
  // Opposite hues are the maximum.
  assert.equal(sliceOffPlane('lc', { l: 0.5, c: 0.2, h: 0 }, 180), 1);
  // A grey has no hue worth honouring — it belongs to every hue plane.
  assert.equal(sliceOffPlane('lc', { l: 0.5, c: 0.005, h: 123 }, 300), 0);
  // Non-hue fixed channels are a plain normalised difference.
  assert.equal(sliceOffPlane('ch', { l: 0.4, c: 0.1, h: 0 }, 0.4), 0);
  assert.ok(Math.abs(sliceOffPlane('ch', { l: 0.4, c: 0.1, h: 0 }, 0.9) - 0.5) < 1e-9);
  assert.equal(sliceOffPlane('lh', { l: 0.4, c: 0, h: 0 }, SLICE_C_MAX), 1);
});

test('sliceFixedOf reads the channel the plane holds constant', () => {
  const o: Oklch = { l: 0.61, c: 0.13, h: 271 };
  assert.equal(sliceFixedOf('lc', o), 271);
  assert.equal(sliceFixedOf('ch', o), 0.61);
  assert.equal(sliceFixedOf('lh', o), 0.13);
});

test('ticks span the axis and are labelled in the channel’s own units', () => {
  const h = sliceTicks('h');
  assert.equal(h[0]!.at, 0);
  assert.equal(h[h.length - 1]!.at, 1);
  assert.equal(h[1]!.label, '60°');
  const l = sliceTicks('l');
  assert.equal(l[l.length - 1]!.label, '100%');
  const c = sliceTicks('c');
  assert.equal(c[0]!.label, '0.00');
  assert.equal(c[c.length - 1]!.label, SLICE_C_MAX.toFixed(2));
  // A custom ceiling relabels the chroma axis rather than rescaling the ticks.
  assert.equal(sliceTicks('c', 0.2)[c.length - 1]!.label, '0.20');
  for (const ch of ['l', 'c', 'h'] as const) {
    const ticks = sliceTicks(ch);
    for (let i = 1; i < ticks.length; i++) {
      assert.ok(ticks[i]!.at > ticks[i - 1]!.at, `${ch} ticks ascend`);
    }
  }
});
