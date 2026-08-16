// SPDX-License-Identifier: MPL-2.0
/**
 * Ask retrieval (plans/103 M0). Pins the docs weight ladder (heading > title >
 * body, best first, capped) and that provider federation asks every registered
 * provider EXCEPT `ask` (which would recurse into this surface), dropping empty
 * groups.
 *
 * Run directly:  node --test shells/web/src/lib/ask/retrieve.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lolly.tools/' });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

// fetch stub feeding the shared docs-index loader.
let indexBody: unknown = [];
globalThis.fetch = (async () => ({ ok: true, json: async () => indexBody })) as unknown as typeof fetch;

const { retrieveDocsSections, retrieveProviderHits } = await import('./retrieve.ts');
const { _resetDocsIndexCache } = await import('../search/docs-index.ts');
const { registerProvider, resetProviders } = await import('../search/registry.ts');
const { tokenize } = await import('../search/match.ts');

const RECORDS = [
  { p: 'a', t: 'Alpha', h: 'Colour maths', a: 'colour-maths', x: 'plain prose' },   // heading hit
  { p: 'b', t: 'Colour Lab', h: 'Panels', a: 'panels', x: 'plain prose' },          // title hit
  { p: 'c', t: 'Gamma', h: 'Extras', a: 'extras', x: 'notes about colour here' },   // body hit
];

test('docs sections rank heading > title > body, best first, capped', async () => {
  indexBody = RECORDS;
  _resetDocsIndexCache();
  const hits = await retrieveDocsSections(tokenize('colour'), 5);
  assert.deepEqual(hits.map((h) => h.rec.h), ['Colour maths', 'Panels', 'Extras']);
  assert.ok(hits[0]!.score > hits[1]!.score && hits[1]!.score > hits[2]!.score);
  const capped = await retrieveDocsSections(tokenize('colour'), 2);
  assert.equal(capped.length, 2);
});

test('empty tokens retrieve nothing', async () => {
  indexBody = RECORDS;
  _resetDocsIndexCache();
  assert.deepEqual(await retrieveDocsSections([], 5), []);
});

test('natural-language questions strip stopwords and match content terms (OR, not AND)', async () => {
  // The spotlight docs provider (AND) finds nothing for a full question - no
  // section contains "how" AND "do" AND "i". Ask retrieval must still answer.
  indexBody = [
    { p: 'x', t: 'Exporting', h: 'Transparency', a: 'transparency', x: 'export a transparent png with alpha' },
    { p: 'y', t: 'Other', h: 'Colours', a: 'colours', x: 'nothing relevant here' },
  ];
  _resetDocsIndexCache();
  const hits = await retrieveDocsSections(tokenize('how do I export a transparent png'), 5);
  assert.ok(hits.length >= 1, 'a full question must still find its section');
  assert.equal(hits[0]!.rec.h, 'Transparency');
});

test('coverage wins: matching more content terms outranks a single strong-field hit', async () => {
  indexBody = [
    { p: 'a', t: 'A', h: 'export', a: 'export', x: 'plain' },                 // 1 term, in a heading (strong field)
    { p: 'b', t: 'B', h: 'Guide', a: 'guide', x: 'export transparent png' },  // 3 terms, in the body (weak field)
  ];
  _resetDocsIndexCache();
  const hits = await retrieveDocsSections(tokenize('export transparent png'), 5);
  assert.equal(hits[0]!.rec.p, 'b', 'covering all three terms beats a lone heading hit');
});

test('provider hits exclude the ask group and drop empty groups', async () => {
  resetProviders();
  registerProvider({ id: 'tools', async search() { return [{ icon: '', title: 'QR', href: '#/tool/qr-code', score: 3 }]; } });
  registerProvider({ id: 'places', async search() { return []; } }); // empty → dropped
  registerProvider({ id: 'ask', async search() { return [{ icon: '', title: 'Ask', href: '#/ask?q=x', score: 1 }]; } });

  const groups = await retrieveProviderHits(tokenize('qr'));
  assert.deepEqual(groups.map((g) => g.group), ['tools']);
  assert.ok(!groups.some((g) => g.group === 'ask'), 'the ask group must never appear in its own answer');
});

test('a throwing provider contributes nothing, never rejects the whole retrieval', async () => {
  resetProviders();
  registerProvider({ id: 'tools', async search() { throw new Error('boom'); } });
  registerProvider({ id: 'settings', async search() { return [{ icon: '', title: 'Theme', href: '#/profile?focus=appearance-section', score: 2 }]; } });
  const groups = await retrieveProviderHits(tokenize('theme'));
  assert.deepEqual(groups.map((g) => g.group), ['settings']);
});
