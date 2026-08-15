// SPDX-License-Identifier: MPL-2.0
/**
 * Pure logic of the URL-budget gauge: the band math (shared by the sync render and the
 * packed refine, so they can't disagree) and the share-query reconstruction the async
 * pack refine feeds to packQuery. The DOM render + debounce/seq-guard are exercised in
 * the browser; these are the parts that must be exactly right regardless of the DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandForLength, shareQueryOf } from './url-budget-gauge.ts';
import type { UrlCostModel } from './url-budget.ts';

const BROWSER = { warn: 2000, hard: 4096 };
const QR = { warn: 260, hard: 300 };

test('bandForLength: browser target — ok < warn ≤ warn < hard ≤ over', () => {
  assert.deepEqual(bandForLength(BROWSER, 500), { band: 'ok', usedFraction: 0.25, overBy: -1500 });
  const warn = bandForLength(BROWSER, 2500);
  assert.equal(warn.band, 'warn'); // ≥2000, <4096
  assert.equal(warn.overBy, 500);
  assert.equal(bandForLength(BROWSER, 4096).band, 'over'); // ≥ hard
  assert.equal(bandForLength(BROWSER, 1999).band, 'ok'); // just under warn
});

test('bandForLength: qr target is far tighter', () => {
  assert.equal(bandForLength(QR, 100).band, 'ok');
  assert.equal(bandForLength(QR, 280).band, 'warn');
  assert.equal(bandForLength(QR, 300).band, 'over');
});

test('shareQueryOf: only KEPT rows, joined by & — matches the readable share query', () => {
  const model = {
    params: [
      { status: 'kept', emit: 'a=hello' },
      { status: 'default', emit: '' },
      { status: 'dropped-len', emit: '' },
      { status: 'kept', emit: 'b=world' },
      { status: 'kept', emit: 'format=png' },
    ],
  } as unknown as UrlCostModel;
  assert.equal(shareQueryOf(model), 'a=hello&b=world&format=png');
});

test('shareQueryOf: an all-default model yields an empty query', () => {
  const model = { params: [{ status: 'default', emit: '' }] } as unknown as UrlCostModel;
  assert.equal(shareQueryOf(model), '');
});
