// SPDX-License-Identifier: MPL-2.0
/**
 * The writing view's pure pieces: the word count and the listening estimate.
 * The rest is element wiring over host.speech (shared plumbing already covered
 * by script-audio.test.ts), verified in a real browser.
 *
 * The module imports its stylesheets (a Vite-only construct), so the run relies
 * on the stylesheet-import stub the `test` script registers (tests/css-stub.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords, estimateListenSeconds, formatListenEstimate, LISTEN_WPM } from './script-studio.ts';

test('countWords counts whitespace-separated runs, nothing fancier', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('   \n\t '), 0);
  assert.equal(countWords('one'), 1);
  assert.equal(countWords('Hello there.\nAcross two lines, six words.'), 7);
  assert.equal(countWords('  padded   runs\n\ncount once  '), 4);
});

test('estimateListenSeconds is the honest wpm math', () => {
  assert.equal(estimateListenSeconds(0), 0);
  // 150 words at 150 wpm is exactly a minute.
  assert.equal(estimateListenSeconds(LISTEN_WPM), 60);
  // Faster speech shortens the estimate proportionally.
  assert.equal(estimateListenSeconds(LISTEN_WPM, 1.2), 50);
  assert.equal(estimateListenSeconds(LISTEN_WPM, 0.8), 75);
  // A degenerate speed multiplier falls back to the natural pace, never Infinity.
  assert.equal(estimateListenSeconds(LISTEN_WPM, 0), 60);
  assert.equal(estimateListenSeconds(LISTEN_WPM, -1), 60);
});

test('formatListenEstimate picks the right whole-sentence shape', () => {
  // Sub-minute: seconds only. Never claims zero - the floor is one second.
  assert.equal(formatListenEstimate(0), 'About 1 sec to listen, an estimate');
  assert.equal(formatListenEstimate(42), 'About 42 sec to listen, an estimate');
  // Exact minutes drop the seconds clause entirely.
  assert.equal(formatListenEstimate(120), 'About 2 min to listen, an estimate');
  // Mixed: both units, with rounding to the nearest second.
  assert.equal(formatListenEstimate(89.6), 'About 1 min 30 sec to listen, an estimate');
});
