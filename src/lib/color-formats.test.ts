// SPDX-License-Identifier: MPL-2.0
/**
 * color-formats.ts — Hex/RGB/RGBA/OKLCH/CMYK ↔ canonical hex.
 * Run: node --test "shells/web/src/**\/*.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgba, rgbaToHex, formatColor, parseColor } from './color-formats.ts';

test('hexToRgba parses #rgb / #rrggbb / #rrggbbaa (with or without #)', () => {
  assert.deepEqual(hexToRgba('#4f83cc'), { r: 79, g: 131, b: 204, a: 1 });
  assert.deepEqual(hexToRgba('4f83cc'), { r: 79, g: 131, b: 204, a: 1 });
  assert.deepEqual(hexToRgba('#08f'), { r: 0, g: 136, b: 255, a: 1 });
  const a = hexToRgba('#4f83cc80')!;
  assert.equal(a.r, 79); assert.ok(Math.abs(a.a - 0.5) < 0.01);
  assert.equal(hexToRgba('nope'), null);
});

test('rgbaToHex round-trips and only appends alpha when < 1', () => {
  assert.equal(rgbaToHex(79, 131, 204), '#4f83cc');
  assert.equal(rgbaToHex(79, 131, 204, 1), '#4f83cc');
  assert.equal(rgbaToHex(0, 136, 255, 0.5), '#0088ff80');
  assert.equal(rgbaToHex(300, -5, 128), '#ff0080'); // clamped to [0,255]
});

test('formatColor renders each space from a hex', () => {
  assert.equal(formatColor('hex', '#4f83cc'), '#4F83CC');
  assert.equal(formatColor('rgb', '#4f83cc'), '79, 131, 204');
  assert.equal(formatColor('rgba', '#4f83cc'), '79, 131, 204, 1');
  assert.equal(formatColor('rgba', '#0088ff80'), '0, 136, 255, 0.502'); // 0x80/255 = 0.502
  // OKLCH: "L% C H" — the perceptual triple the tokens speak.
  assert.match(formatColor('oklch', '#4f83cc'), /^\d+(\.\d+)?% [\d.]+ \d+(\.\d+)?$/);
  // CMYK: four integer percentages.
  assert.match(formatColor('cmyk', '#4f83cc'), /^\d+, \d+, \d+, \d+$/);
  assert.equal(formatColor('rgb', 'transparent'), '');
});

test('parseColor: hex accepts #, bare, and short forms', () => {
  assert.equal(parseColor('hex', '#4f83cc'), '#4f83cc');
  assert.equal(parseColor('hex', '4f83cc'), '#4f83cc');
  assert.equal(parseColor('hex', '#08f'), '#0088ff');
  assert.equal(parseColor('hex', 'not-a-colour!!'), null);
});

test('parseColor: RGB / RGBA are comma- or space-tolerant and clamp', () => {
  assert.equal(parseColor('rgb', '79, 131, 204'), '#4f83cc');
  assert.equal(parseColor('rgb', '79 131 204'), '#4f83cc');
  assert.equal(parseColor('rgb', 'rgb(79, 131, 204)'), '#4f83cc');
  assert.equal(parseColor('rgba', '0, 136, 255, 0.5'), '#0088ff80');
  assert.equal(parseColor('rgba', '0 136 255'), '#0088ff'); // missing alpha → opaque
  assert.equal(parseColor('rgb', '300, 0, 0'), '#ff0000'); // clamp
  assert.equal(parseColor('rgb', 'only two, 5'), null);
});

test('parseColor: OKLCH accepts "L% C H" and oklch(...) and round-trips near-exactly', () => {
  const hex = parseColor('oklch', '60% 0.1 250');
  assert.match(hex!, /^#[0-9a-f]{6}$/i);
  assert.equal(parseColor('oklch', 'oklch(60% 0.1 250)'), hex);
  // Round-trip: hex → oklch text → hex is stable to the byte.
  const back = parseColor('oklch', formatColor('oklch', hex!));
  assert.equal(back, hex);
  assert.equal(parseColor('oklch', '60% 0.1'), null); // needs all three
});

test('parseColor: CMYK (percentages) → rgb hex, and hex→cmyk→hex is close', () => {
  assert.equal(parseColor('cmyk', '0, 0, 0, 0'), '#ffffff');
  assert.equal(parseColor('cmyk', '0, 0, 0, 100'), '#000000');
  assert.equal(parseColor('cmyk', '100, 0, 0, 0'), '#00ffff');
  // A round-trip through the naïve separation lands within a couple of levels.
  const start = '#4f83cc';
  const round = parseColor('cmyk', formatColor('cmyk', start))!;
  const a = hexToRgba(start)!, b = hexToRgba(round)!;
  for (const ch of ['r', 'g', 'b'] as const) {
    assert.ok(Math.abs(a[ch] - b[ch]) <= 3, `${ch}: ${a[ch]} vs ${b[ch]}`);
  }
});

test('empty / whitespace input parses to null (caller holds last good value)', () => {
  for (const f of ['hex', 'rgb', 'rgba', 'oklch', 'cmyk'] as const) {
    assert.equal(parseColor(f, '   '), null);
    assert.equal(parseColor(f, ''), null);
  }
});
