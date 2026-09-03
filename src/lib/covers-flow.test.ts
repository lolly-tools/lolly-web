// SPDX-License-Identifier: MPL-2.0
/**
 * The Cover Flow's opening cover: the one whose posed hue is nearest the reader's
 * accent, measured around the hue circle (359° and 1° are neighbours, not
 * opposites). Pure function, so no DOM here - mountCoverFlow's wiring is verified
 * in the browser, this pins the maths the landing's first impression rides on.
 *
 * Run directly:
 *   node --test "shells/web/src/lib/covers-flow.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestCoverIndex } from './covers-flow.ts';

// The sixteen posed hues, 22.5° apart (scripts/build-covers.ts POSES / docs/site/covers.json).
const HUES = Array.from({ length: 16 }, (_, i) => i * 22.5);

test('an exact posed hue picks its own cover', () => {
  HUES.forEach((h, i) => assert.equal(nearestCoverIndex(HUES, h), i));
});

test('a hue between two poses goes to the nearer one', () => {
  assert.equal(nearestCoverIndex(HUES, 150), 7);    // 157.5 (Design) beats 135 (Deck)
  assert.equal(nearestCoverIndex(HUES, 143), 6);    // 135 beats 157.5
  assert.equal(nearestCoverIndex(HUES, 100), 4);    // 90 beats 112.5
});

test('distance wraps around the circle', () => {
  assert.equal(nearestCoverIndex(HUES, 355), 0);    // 5° from red, not 17.5° from rose
  assert.equal(nearestCoverIndex(HUES, 340), 15);   // rose at 337.5
  assert.equal(nearestCoverIndex(HUES, 720 + 45), 2); // out-of-range input still resolves
});

test('no reader hue, or no posed hues, opens on the first cover', () => {
  assert.equal(nearestCoverIndex(HUES, null), 0);
  assert.equal(nearestCoverIndex([], 120), 0);
  assert.equal(nearestCoverIndex([null, null, null], 120), 0);
});

test('covers without a hue are skipped, not treated as 0°', () => {
  // Only the third cover is posed; a red reader must not land on an un-hued first card.
  assert.equal(nearestCoverIndex([null, null, 200, null], 5), 2);
  // A mixed strip: the un-hued card never wins even when it sits where 0° would.
  assert.equal(nearestCoverIndex([null, 90, 180, 270], 3), 1);
});

test("Lolly's own green opens on the Design cover", () => {
  // Pine Green (#30ba78) is OKLCH hue 157.2°: readerHue() falls back to it for a
  // fresh visitor and for the ink-and-paper starter brand (no hue), and the
  // flagship cover is posed at 157.5° so that is where a first visit opens.
  assert.equal(nearestCoverIndex(HUES, 157.2), 7);
});
