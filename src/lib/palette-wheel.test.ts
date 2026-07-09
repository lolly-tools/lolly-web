// SPDX-License-Identifier: MPL-2.0
/**
 * palette-wheel.ts geometry — the pure OKLCH↔polar mapping the editable wheel
 * drags through. Run: node --test "shells/web/src/**\/*.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  oklchWheelXY, wheelXYToChromaHue, WHEEL_R, WHEEL_R_IN, WHEEL_CMAX,
} from './palette-wheel-geom.ts';

test('hue maps to angle: 0°=top, 90°=right, 180°=bottom, 270°=left', () => {
  const at = WHEEL_CMAX; // full chroma → the rim
  const top = oklchWheelXY({ l: 0.6, c: at, h: 0 });
  const right = oklchWheelXY({ l: 0.6, c: at, h: 90 });
  const bottom = oklchWheelXY({ l: 0.6, c: at, h: 180 });
  const left = oklchWheelXY({ l: 0.6, c: at, h: 270 });
  assert.ok(Math.abs(top.x - 50) < 0.01 && top.y < 50, 'hue 0 sits straight up');
  assert.ok(right.x > 50 && Math.abs(right.y - 50) < 0.01, 'hue 90 sits to the right');
  assert.ok(Math.abs(bottom.x - 50) < 0.01 && bottom.y > 50, 'hue 180 sits at the bottom');
  assert.ok(left.x < 50 && Math.abs(left.y - 50) < 0.01, 'hue 270 sits to the left');
});

test('chroma maps to radius: grey → centre floor, full chroma → rim', () => {
  const grey = oklchWheelXY({ l: 0.6, c: 0, h: 200 });
  assert.ok(Math.hypot(grey.x - 50, grey.y - 50) <= WHEEL_R_IN + 0.01);
  const vivid = oklchWheelXY({ l: 0.6, c: WHEEL_CMAX, h: 200 });
  assert.ok(Math.abs(Math.hypot(vivid.x - 50, vivid.y - 50) - WHEEL_R) < 0.01);
  // Over-gamut chroma just pins to the rim, never past it.
  const over = oklchWheelXY({ l: 0.6, c: WHEEL_CMAX * 2, h: 200 });
  assert.ok(Math.hypot(over.x - 50, over.y - 50) <= WHEEL_R + 0.01);
});

test('oklchWheelXY ∘ wheelXYToChromaHue round-trips chroma + hue', () => {
  for (const h of [0, 45, 130, 250, 300, 359]) {
    for (const c of [0.02, 0.1, 0.2, WHEEL_CMAX]) {
      const { x, y } = oklchWheelXY({ l: 0.5, c, h });
      const back = wheelXYToChromaHue(x, y);
      assert.ok(Math.abs(back.c - c) < 1e-6, `chroma ${c} @ ${h}° → ${back.c}`);
      assert.ok(Math.abs(((back.h - h + 540) % 360) - 180) < 1e-6, `hue ${h}° → ${back.h}°`);
    }
  }
});

test('wheelXYToChromaHue clamps chroma to [0, CMAX] outside the disc', () => {
  const beyond = wheelXYToChromaHue(50, 50 - (WHEEL_R + 20)); // well past the rim, straight up
  assert.equal(beyond.c, WHEEL_CMAX);
  assert.ok(Math.abs(beyond.h) < 1e-6, 'straight up is hue 0');
  const centre = wheelXYToChromaHue(50, 50);
  assert.equal(centre.c, 0);
});
