// SPDX-License-Identifier: MPL-2.0
/**
 * The asset picker's INITIAL TAB - `PickerOpts.initialTab`.
 *
 * The picker already opened on a non-Library pane in exactly one hard-coded case (collect
 * mode → Tools). `initialTab` turns that into something a caller can ask for per add-kind,
 * which is what lets "add a tool" land on the tool grid and "add audio" land on the
 * type-filtered library. The three claims worth locking down are the ones a hard-coded
 * default never had to make:
 *   - the requested pane is the one actually SHOWING (not merely the tab that looks
 *     selected - the markup bakes Library in, so a missed switch is invisible in ARIA);
 *   - it is a DEFAULT, not a lock - the strip still works afterwards;
 *   - a tab this pick doesn't offer degrades to Library instead of opening an empty pane.
 *
 * Everything runs against the real `openPicker` in jsdom with a real (in-memory) host, so
 * "the Tools pane is open" is read off the rendered DOM.
 *
 * Run directly:  node --test shells/web/src/views/picker-initial-tab.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import type { AssetRef } from '@lolly-tools/core/host-v1';

// picker.ts imports its own stylesheet (the lazy-view pattern). Node has no idea what a
// .css module is; Vite is what resolves it for real.
registerHooks({
  load(url: string, ctx: unknown, next: (u: string, c: unknown) => unknown) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {};' };
    return next(url, ctx);
  },
} as Parameters<typeof registerHooks>[0]);

const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true, url: 'https://lolly.test/' });
const W = dom.window as unknown as typeof globalThis & { MouseEvent: typeof MouseEvent; KeyboardEvent: typeof KeyboardEvent };
for (const k of [
  'window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLImageElement',
  'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'DOMParser',
  'getComputedStyle', 'MutationObserver', 'IntersectionObserver',
]) {
  const v = (dom.window as unknown as Record<string, unknown>)[k];
  if (v !== undefined) (globalThis as Record<string, unknown>)[k] = v;
}
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => dom.window.requestAnimationFrame(cb)) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((h: number) => dom.window.cancelAnimationFrame(h)) as typeof cancelAnimationFrame;
(globalThis as Record<string, unknown>).matchMedia = (q: string) =>
  ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
(globalThis as Record<string, unknown>).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (!(globalThis as Record<string, unknown>).IntersectionObserver) {
  (globalThis as Record<string, unknown>).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const { openPicker } = await import('./picker.ts');

// ── fixture ───────────────────────────────────────────────────────────────────

const asset = (id: string, type = 'raster'): AssetRef => ({
  id, type, url: `blob:${id}`, meta: { name: id, tags: ['photo'] },
} as unknown as AssetRef);

/** Two tools that pass isEmbeddable (exportable + an image format), so the Tools tab exists. */
const TOOLS = [
  { id: 'qr-code', name: 'QR Code', exportable: true, formats: ['svg', 'png'] },
  { id: 'chart-creator', name: 'Chart Creator', exportable: true, formats: ['svg', 'png'] },
];

function setToolIndex(tools: unknown[]): void {
  (dom.window as unknown as Record<string, unknown>).__toolIndex = { tools };
}

function makeHost(assets: AssetRef[], userAssets: AssetRef[] = []) {
  return {
    capabilities: [],
    log() {},
    profile: { get: async () => ({}), set: async () => {} },
    state: { list: async () => [], load: async () => null, save: async () => {}, delete: async () => {} },
    compose: {
      render: async () => null,
      renderUrl: async () => null,
      _describeUrl: async () => null,
    },
    assets: {
      query: async () => assets,
      get: async (id: string) => assets.find(a => a.id === id) ?? null,
      isAvailable: async () => true,
      _listUserAssets: async () => userAssets,
      _userAssetsCount: async () => 0,
      _deleteUserAsset: async () => {},
      _iconThemes: async () => [],
      _photoTreatments: async () => [],
      _uploadUserAsset: async () => {},
    },
  };
}

/** Let the picker's async render (profile + query + sessions) land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise<void>(r => setTimeout(r, 0));
}

interface Open {
  panel: HTMLElement;
  /** data-pane of the ONE visible pane. */
  visiblePane(): string | null;
  tab(id: string): HTMLButtonElement | null;
  selectedTab(): string | null;
  close(): Promise<void>;
}

async function open(
  opts: Record<string, unknown>,
  assets: AssetRef[] = [asset('a/one'), asset('a/two')],
  userAssets: AssetRef[] = [],
): Promise<Open> {
  const done = openPicker(makeHost(assets, userAssets) as never, opts as never);
  await settle();
  const panel = dom.window.document.querySelector<HTMLElement>('.asset-picker-panel');
  assert.ok(panel, 'the picker mounted a panel');
  return {
    panel: panel!,
    visiblePane() {
      const shown = [...panel!.querySelectorAll<HTMLElement>('.asset-picker-pane')].filter(p => !p.hidden);
      assert.equal(shown.length, 1, `exactly one pane is visible (saw ${shown.length})`);
      return shown[0]!.dataset.pane ?? null;
    },
    tab: (id: string) => panel!.querySelector<HTMLButtonElement>(`.asset-picker-tab[data-tab="${id}"]`),
    selectedTab() {
      return panel!.querySelector<HTMLElement>('.asset-picker-tab[aria-selected="true"]')?.dataset.tab ?? null;
    },
    async close() {
      panel!.querySelector<HTMLButtonElement>('.asset-picker-close')!.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
      assert.equal(await done, null, 'closing the picker resolves null');
      await settle();
    },
  };
}

// ── the requested tab opens ───────────────────────────────────────────────────

test('initialTab: tools opens ON the Tools pane, not just with the tab selected', async () => {
  setToolIndex(TOOLS);
  const p = await open({ allowUpload: true, initialTab: 'tools' });
  assert.equal(p.visiblePane(), 'tools', 'the Tools pane is the visible one');
  assert.equal(p.selectedTab(), 'tools');
  // The pane really rendered its grid - a switch that only flipped `hidden` would
  // leave the tool cards absent.
  const cards = p.panel.querySelectorAll('.asset-picker-toolgrid [data-tool-id]');
  assert.equal(cards.length, TOOLS.length, 'every embeddable tool has a card');
  await p.close();
});

test('a typed library pick opens on Library with only the matching assets rendered', async () => {
  setToolIndex(TOOLS);
  // What free-canvas sends for the Audio add-kind: type narrows the query, initialTab
  // keeps the pane on the library so the narrowed set is what the user sees.
  const audio = asset('music/bed', 'audio');
  const p = await open({ allowUpload: true, type: 'audio', initialTab: 'library' }, [audio]);
  assert.equal(p.visiblePane(), 'library');
  const ids = [...p.panel.querySelectorAll<HTMLElement>('.asset-picker-library [data-asset-id]')]
    .map(c => c.dataset.assetId);
  assert.deepEqual(ids, ['music/bed'], 'the library shows the audio asset and nothing else');
  await p.close();
});

// ── absence preserves today's behaviour ───────────────────────────────────────

test('no initialTab keeps the historical default: Library for a slot-fill pick', async () => {
  setToolIndex(TOOLS);
  const p = await open({ allowUpload: true });
  assert.equal(p.visiblePane(), 'library');
  assert.equal(p.selectedTab(), 'library');
  assert.ok(p.tab('tools'), 'the Tools tab still exists — it just is not the one open');
  await p.close();
});

test('no initialTab keeps the historical default: collect mode still opens on Tools', async () => {
  setToolIndex(TOOLS);
  const p = await open({
    allowUpload: true,
    collect: {
      folderName: 'Campaign',
      tools: TOOLS,
      onAsset: async () => true, onSession: async () => true,
      onOpenTool() {}, onQuickAddTool: async () => true,
    },
  });
  assert.equal(p.visiblePane(), 'tools');
  await p.close();
});

// ── graceful degradation ──────────────────────────────────────────────────────

test('initialTab: tools degrades to Library when this pick offers no tools', async () => {
  setToolIndex([]);                       // nothing embeddable → no Tools tab at all
  const p = await open({ allowUpload: true, initialTab: 'tools' });
  assert.equal(p.tab('tools'), null, 'there is no Tools tab to open');
  assert.equal(p.visiblePane(), 'library', 'so the pick falls back to the library');
  assert.equal(p.selectedTab(), 'library');
  await p.close();
});

test('an unknown initialTab is ignored rather than honoured into an empty pane', async () => {
  setToolIndex(TOOLS);
  const p = await open({ allowUpload: true, initialTab: 'nonsense' });
  assert.equal(p.visiblePane(), 'library');
  await p.close();
});

// ── a default, never a lock ───────────────────────────────────────────────────

test('the user can switch away from the requested tab immediately', async () => {
  setToolIndex(TOOLS);
  const p = await open({ allowUpload: true, initialTab: 'tools' });
  assert.equal(p.visiblePane(), 'tools');
  p.tab('library')!.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(p.visiblePane(), 'library', 'clicking Library switches to it');
  assert.equal(p.selectedTab(), 'library');
  // …and back again, so the seeded default left no one-way state behind.
  p.tab('tools')!.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(p.visiblePane(), 'tools');
  await p.close();
});


// ── the user rail is not all pictures ─────────────────────────────────────────

test('an untyped pick tiles only the user assets that HAVE a picture', async () => {
  setToolIndex(TOOLS);
  // The user-asset rail is universal storage: fonts, tokens and (1.73) ICC profiles
  // ride it beside uploaded images. An untyped pick used to accept every type, so a
  // profile tiled as a broken image with a delete button that removed the bytes
  // behind the Colour Lab's back.
  const mine = [
    asset('user/images/photo', 'raster'),
    asset('user/profiles/0c8a584b288a306e', 'profile'),
    asset('user/fonts/inter', 'font'),
  ];
  const p = await open({ allowUpload: true }, [], mine);
  const ids = [...p.panel.querySelectorAll<HTMLElement>('.asset-picker-card-user [data-asset-id]')]
    .map(c => c.dataset.assetId);
  assert.deepEqual(ids, ['user/images/photo'],
    `only the image tiles: ${ids.join()}`);
  assert.equal(p.panel.querySelector('[data-delete-id="user/profiles/0c8a584b288a306e"]'), null,
    'and nothing offers to delete a profile from here');
  await p.close();
});
