// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the colour field's pure helpers — the OKLCH slider-track
 * gradient builder. DOM-free: the module only touches document inside its
 * wiring functions, so importing it under node:test is safe.
 * Run directly:  node --test shells/web/src/components/color-field.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lchTrackGradients, LCH_MAX } from './color-field.ts';

test('each axis track sweeps its own range while holding the other two', () => {
  const t = lchTrackGradients(0.62, 0.11, 250);
  // L: 9 stops from 0% to 100%, C and H fixed at the current value.
  assert.equal((t.l.match(/oklch\(/g) ?? []).length, 9);
  assert.ok(t.l.startsWith('linear-gradient(to right, oklch(0% 0.11 250)'));
  assert.ok(t.l.endsWith('oklch(100% 0.11 250))'));
  // C: 0 → LCH_MAX.c at the current L/H.
  assert.ok(t.c.includes('oklch(62% 0 250)'));
  assert.ok(t.c.endsWith(`oklch(62% ${LCH_MAX.c} 250))`));
  // H: 13 stops (every 30°), closing the wheel at 360.
  assert.equal((t.h.match(/oklch\(/g) ?? []).length, 13);
  assert.ok(t.h.endsWith('oklch(62% 0.11 360))'));
});

test('the hue track floors chroma so the sweep stays visible near grey', () => {
  const t = lchTrackGradients(0.5, 0, 0);
  assert.ok(t.h.includes('oklch(50% 0.08 '), 'hue stops use the 0.08 floor, not the real C=0');
  // …but the chroma track itself must still start at the true zero.
  assert.ok(t.c.includes('oklch(50% 0 0)'));
});
