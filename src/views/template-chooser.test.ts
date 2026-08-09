// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { openTemplateChooser, parseTemplates, templateValuesById } from './template-chooser.ts';

// A manifest `templates[]` as it arrives off the loaded manifest (typed unknown[]).
const RAW = [
  {
    id: 'poster',
    name: 'Poster',
    category: 'Poster',
    description: 'One frame filling the canvas.',
    values: { boxes: [{ id: 'frame', kind: 'frame', x: 0, y: 0, w: 1080, h: 1080 }] },
  },
  {
    id: 'carousel',
    name: 'Carousel',
    category: 'Carousel',
    values: {
      boxes: [
        { id: 'slide1', kind: 'frame', x: 0 },
        { id: 'slide2', kind: 'frame', x: 1120 },
        { id: 'slide3', kind: 'frame', x: 2240 },
      ],
    },
  },
];

test('parseTemplates: keeps well-formed entries and their full values seed', () => {
  const parsed = parseTemplates(RAW);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(t => t.id), ['poster', 'carousel']);
  assert.equal(parsed[0]!.name, 'Poster');
  assert.equal(parsed[0]!.category, 'Poster');
  // values passes through verbatim — any size, read directly into the fresh session.
  const boxes = (parsed[1]!.values.boxes as unknown[]);
  assert.equal(boxes.length, 3);
});

test('parseTemplates: drops malformed entries rather than throwing', () => {
  const parsed = parseTemplates([
    { id: 'ok', name: 'OK', values: {} },
    { name: 'no-id', values: {} },      // missing id
    { id: 'no-name', values: {} },      // missing name
    { id: 'dup', name: 'A', values: {} },
    { id: 'dup', name: 'B', values: {} }, // duplicate id — first wins
    null,
    'nonsense',
    { id: 'bad-values', name: 'Bad', values: [1, 2] }, // array values → {}
  ]);
  assert.deepEqual(parsed.map(t => t.id), ['ok', 'dup', 'bad-values']);
  assert.equal(parsed.find(t => t.id === 'dup')!.name, 'A');
  assert.deepEqual(parsed.find(t => t.id === 'bad-values')!.values, {});
});

test('parseTemplates: metadata-only entries (from the synced index, NO values) parse with an empty seed', () => {
  // The index now carries id/name/category/description/thumb only — the heavy `values`
  // is fetched on demand. Such entries must still populate the chooser grid.
  const parsed = parseTemplates([
    { id: 'poster', name: 'Poster', category: 'Poster', description: 'A poster.' },
    { id: 'video', name: 'Video', category: 'Video', thumb: '/tools/x/t.svg' },
  ]);
  assert.deepEqual(parsed.map(t => t.id), ['poster', 'video']);
  assert.deepEqual(parsed[0]!.values, {}, 'no inline values → empty seed (fetched later)');
  assert.equal(parsed[0]!.category, 'Poster');
  assert.equal(parsed[1]!.thumb, '/tools/x/t.svg');
});

test('parseTemplates: non-array input is empty (a tool without templates[])', () => {
  assert.deepEqual(parseTemplates(undefined), []);
  assert.deepEqual(parseTemplates(null), []);
  assert.deepEqual(parseTemplates({}), []);
});

test('templateValuesById: resolves the reserved ?template=<id> seed, null on miss', () => {
  const seed = templateValuesById(RAW, 'carousel');
  assert.ok(seed);
  assert.equal((seed!.boxes as unknown[]).length, 3);
  assert.equal(templateValuesById(RAW, 'nope'), null);
  assert.equal(templateValuesById(undefined, 'poster'), null);
});

// ── Eager preview enqueue on open ────────────────────────────────────────────
// Regression guard for the "tiles show only glyphs" defect: the preview drain must
// NOT be gated solely on the IntersectionObserver firing. Here the IO is stubbed to
// NEVER deliver an intersecting entry, yet on open every non-blank template must still
// be enqueued and drained. If the drain were IO-gated (the old code), zero previews
// would be requested and the tiles would stay glyphs.
//
// No module mocking (the harness runs without --experimental-test-module-mocks): the
// REAL renderFeaturedVariant runs, driven down its cache-HIT branch by a stub
// host.previews.get that returns a matching entry — so it returns a thumbnail instantly
// without loading the engine, and this also exercises the real keyPrefix='template'
// cache-key + fall-through (no early null return). Spying on get() proves each template
// was enqueued: renderVariantAt calls get exactly once per drained template.

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.CSS = (dom.window.CSS ?? {}) as unknown as typeof globalThis.CSS;
if (typeof (globalThis.CSS as { escape?: unknown })?.escape !== 'function') {
  (globalThis.CSS as unknown as { escape: (s: string) => string }) = { escape: (s) => s };
}
globalThis.matchMedia = ((q: string) => ({
  matches: false, media: q, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
})) as unknown as typeof globalThis.matchMedia;
// A stub that RECORDS observed tiles but NEVER invokes the callback → proves previews
// do not depend on the IO firing.
const observed: string[] = [];
globalThis.IntersectionObserver = class {
  constructor(_cb: unknown, _opts?: unknown) {}
  observe(el: Element) { observed.push((el as HTMLElement).dataset?.templateId ?? ''); }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
} as unknown as typeof globalThis.IntersectionObserver;

const THUMB = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';

test('openTemplateChooser: eagerly renders a preview for every non-blank template even when the IntersectionObserver never fires', async () => {
  observed.length = 0;
  const inline: Record<string, Record<string, unknown>> = {
    poster: { boxes: [{ id: 'a' }] },
    carousel: { boxes: [{ id: 'b' }] },
  };
  const templates = parseTemplates([
    { id: 'poster', name: 'Poster', category: 'Poster', values: inline.poster },
    { id: 'carousel', name: 'Carousel', category: 'Carousel', values: inline.carousel },
  ]);
  // Spy host: previews.get records the cache key the drain probes for each template, and
  // returns a HIT (sig === JSON.stringify(values)) so renderFeaturedVariant returns THUMB
  // without importing the render engine.
  const getKeys: string[] = [];
  const host = {
    previews: {
      get: async (key: string) => {
        getKeys.push(key);
        const id = key.match(/^template:layout-studio:(.+):svg$/)?.[1];
        const values = id ? inline[id] : undefined;
        return values ? { sig: JSON.stringify(values), thumb: THUMB } : null;
      },
      put: async () => {},
    },
  } as never;

  // Fire-and-forget: the returned promise only settles on select/close, which we never do.
  void openTemplateChooser({
    toolName: 'Layout Studio', toolId: 'layout-studio', templates, host, formats: ['svg', 'png'],
  });
  // Drain is serial + async (dynamic import of featured-render, then per-template render).
  for (let i = 0; i < 200 && getKeys.length < 2; i++) await new Promise(r => setTimeout(r, 0));

  // Both templates were drained (get probed once each) — vector-first svg key, 'template'
  // namespace — and none for the Blank tile.
  assert.deepEqual(
    getKeys.slice().sort(),
    ['template:layout-studio:carousel:svg', 'template:layout-studio:poster:svg'],
    'both non-blank templates were enqueued + drained (get probed per template)',
  );
  // The IO was still wired for off-screen prioritisation, but it never fired — so the
  // previews above are attributable solely to the eager enqueue.
  assert.ok(observed.includes('poster') && observed.includes('carousel'), 'tiles are still observed');
  assert.ok(!observed.includes('__blank__'), 'the Blank tile is never observed');

  // And the rendered thumbnail was actually swapped into each tile's media slot.
  await new Promise(r => setTimeout(r, 0));
  const img = document.querySelector<HTMLImageElement>(
    '.tmpl-chooser-tile[data-template-id="poster"] .tmpl-chooser-tile-media img.tmpl-chooser-tile-thumb',
  );
  assert.ok(img && img.src === THUMB, 'the live preview <img> replaced the glyph');
  document.querySelector('.tmpl-chooser-modal')?.remove();
});

test('openTemplateChooser: with no host it renders glyph tiles and requests NO previews', async () => {
  const getKeys: string[] = [];
  const templates = parseTemplates([{ id: 'poster', name: 'Poster', values: { boxes: [] } }]);
  // No host → the whole preview block is skipped; a glyph tile is the graceful fallback.
  void openTemplateChooser({ toolName: 'Layout Studio', toolId: 'layout-studio', templates });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(getKeys.length, 0, 'offline (no host) never renders a live preview');
  const tile = document.querySelector('.tmpl-chooser-tile[data-template-id="poster"] .tmpl-chooser-tile-icon');
  assert.ok(tile, 'a glyph icon is shown as the fallback media');
  document.querySelector('.tmpl-chooser-modal')?.remove();
});
