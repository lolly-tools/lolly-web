// SPDX-License-Identifier: MPL-2.0
/**
 * The Places spotlight provider (plans/99 §2b): label + keyword matching with
 * diacritic folding, and the Batch-mode entry gated on the Pro flag PER SEARCH
 * CALL through the flag mirror (feature-flags.ts flagEnabledSync reads the
 * 'lolly:featureFlags' localStorage mirror, defaulting ON when unset).
 *
 * Run directly:
 *   node --import ./tests/css-stub.mjs --test shells/web/src/lib/search/providers/places.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// jsdom globals BEFORE the dynamic import (the co-located suite convention).
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lolly.tools/' });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const { createPlacesProvider } = await import('./places.ts');
const { tokenize } = await import('../match.ts');

const provider = createPlacesProvider();
const FLAG_MIRROR_KEY = 'lolly:featureFlags'; // feature-flags.ts's mirror

test('labels match and navigate: Verify by name, with glyph and score', async () => {
  const hits = await provider.search(tokenize('verify'), 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.href, '#/verify');
  assert.equal(hits[0]!.title, 'Verify');
  assert.ok(hits[0]!.icon.includes('<svg'));
  assert.ok(hits[0]!.score > 0);
});

test('diacritics fold on the query side', async () => {
  const hits = await provider.search(tokenize('vérify'), 5);
  assert.equal(hits[0]?.href, '#/verify');
});

test('keywords widen recall: oklch finds the Colour Lab, apart finds the PDF view', async () => {
  assert.equal((await provider.search(tokenize('oklch'), 5))[0]?.href, '#/lab');
  assert.equal((await provider.search(tokenize('apart'), 5))[0]?.href, '#/pdf');
});

test('a label hit (w3) outranks a keyword-only hit (w1)', async () => {
  const hits = await provider.search(tokenize('design'), 5);
  // 'Design System studio' matches the label; nothing else carries 'design' as
  // a label word, so it must lead whatever keyword matches trail it.
  assert.equal(hits[0]?.href, '#/start');
});

test('Batch mode rides the Pro flag, evaluated per call (not at module load)', async () => {
  // Mirror unset → flagEnabledSync defaults ON → Batch mode present.
  localStorage.removeItem(FLAG_MIRROR_KEY);
  assert.equal((await provider.search(tokenize('batch'), 5))[0]?.href, '#/pro');
  // Flag off in the mirror → gone, on the SAME provider instance.
  localStorage.setItem(FLAG_MIRROR_KEY, JSON.stringify({ 'pro-batch': false }));
  assert.equal((await provider.search(tokenize('batch'), 5)).length, 0);
  // Back on → back in the registry.
  localStorage.setItem(FLAG_MIRROR_KEY, JSON.stringify({ 'pro-batch': true }));
  assert.equal((await provider.search(tokenize('batch'), 5))[0]?.href, '#/pro');
  localStorage.removeItem(FLAG_MIRROR_KEY);
});

test('limit slices after ranking; no match → empty', async () => {
  assert.equal((await provider.search(tokenize('o'), 2)).length, 2);
  assert.deepEqual(await provider.search(tokenize('zebra'), 5), []);
});
