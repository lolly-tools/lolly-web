// SPDX-License-Identifier: MPL-2.0
/**
 * The print-profile panel, driven in jsdom.
 *
 * Two things are under test, and both were bugs a reader hit:
 *
 * 1. **A press-condition row must do something.** It listed FOGRA39 / FOGRA51 / SWOP /
 *    GRACoL and nothing was clickable, which is honest and useless. Every row is now a
 *    real button, and the three states it can be in each lead somewhere: chart the
 *    loaded profile, fetch a licence-clean one, or open the picker naming the file.
 * 2. **The intent buttons said `per rel sat abs`** with the words hidden in a `title`,
 *    which does not exist on touch. They say the whole word now, and an intent the file
 *    has no table for stays focusable so it can still answer why.
 *
 * Run directly:
 *   node --import ./tests/css-stub.mjs --test shells/web/src/components/profiles-manager.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Event = dom.window.Event;
globalThis.Node = dom.window.Node;
// Node's own Blob/File, NOT jsdom's: jsdom's Blob has no `arrayBuffer()`, which is
// exactly what ingest reads the bytes with.
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// a11y.announce defers its live-region write by a frame.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  dom.window.setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
(dom.window as unknown as { CSS: { escape(s: string): string } }).CSS = {
  escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`),
};
globalThis.CSS = (dom.window as unknown as { CSS: typeof globalThis.CSS }).CSS;
// jsdom implements <dialog> but not the modal layer in every version we run under.
const proto = dom.window.HTMLDialogElement.prototype as unknown as {
  showModal?: () => void; close?: (v?: string) => void;
};
if (typeof proto.showModal !== 'function') {
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
}

const { openProfilesPanel } = await import('./profiles-manager.ts');
const { PRESS_CONDITIONS, fetchSourceFor } = await import('../lib/press-conditions.ts');
const { _resetProfileCache } = await import('../lib/color-profiles.ts');

// ── A host whose stored list the test writes directly ─────────────────────────
//
// `listProfiles` rebuilds a row from `meta` alone and never re-parses, so a row can be
// stated here without any ICC bytes — which is exactly what the "already loaded" case
// needs to test, and keeps the test honest about where each behaviour lives.

interface Stored { id: string; type: string; meta?: Record<string, unknown> }

function fakeHost(rows: Stored[] = []): { host: Parameters<typeof openProfilesPanel>[0]['host']; rows: Stored[]; blobs: Map<string, Blob> } {
  const blobs = new Map<string, Blob>();
  const host = {
    assets: {
      async _uploadUserAsset(r: { id: string; type: string; blob: Blob; meta?: Record<string, unknown> }) {
        rows.push({ id: r.id, type: r.type, meta: r.meta });
        blobs.set(r.id, r.blob);
      },
      async _deleteUserAsset(id: string) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows.splice(i, 1); return null; },
      async _listUserAssets() { return rows; },
      async _getBlob(id: string) { return blobs.get(id) ?? null; },
    },
  };
  return { host, rows, blobs };
}

const profileRow = (digest: string, description: string, intents = ['perceptual', 'relative', 'saturation', 'absolute']): Stored => ({
  id: `user/profiles/${digest}`,
  type: 'profile',
  meta: {
    name: `${description}.icc`, description, deviceClass: 'prtr', colourSpace: 'CMYK',
    channels: 4, version: '2.4.0', intents, activeIntent: 'relative', bytes: 2195228, addedAt: 1,
  },
});

const settle = (): Promise<void> => new Promise(r => { dom.window.setTimeout(() => r(), 0); });
const click = (el: Element): void => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); };
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.labp');
const condRow = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-labp-cond="${id}"]`)!.closest<HTMLElement>('.labp-cond')!;
const msgText = (): string => document.querySelector('[data-labp-msg]')?.textContent ?? '';

interface Opened { closed: Promise<void>; activated: Array<[string, string]> }

function open(host: Parameters<typeof openProfilesPanel>[0]['host'], activate: (d: string, i: string) => boolean = () => true): Opened {
  const activated: Array<[string, string]> = [];
  const closed = openProfilesPanel({
    host,
    onActivate: (digest, intent) => { activated.push([digest, intent]); return activate(digest, intent); },
    onRemove: () => {},
  });
  return { closed, activated };
}

test.afterEach(() => {
  _resetProfileCache();
  for (const d of Array.from(document.querySelectorAll('dialog'))) d.remove();
});

test('every press-condition row is a keyboard-reachable button with an action in its name', async () => {
  const { host } = fakeHost();
  open(host);
  await settle();
  const rows = Array.from(document.querySelectorAll('.labp-cond'));
  assert.equal(rows.length, PRESS_CONDITIONS.length, 'one row per condition the export path offers');
  for (const c of PRESS_CONDITIONS) {
    const btn = document.querySelector<HTMLElement>(`[data-labp-cond="${c.id}"]`);
    assert.ok(btn, `${c.id} has a control`);
    assert.equal(btn.tagName, 'BUTTON', 'a real button, not a div with a click handler');
    // The name says what pressing it does, not just what the row is.
    assert.match(btn.getAttribute('aria-label') ?? '', /^(Get|Compare against|Choose) /, `${c.id}: ${btn.getAttribute('aria-label')}`);
    assert.ok((btn.textContent ?? '').includes(c.identifier), 'and the row still shows the registry identifier');
  }
});

test('a condition whose profile is loaded charts against it and closes the panel', async () => {
  // The instant case: the profile is here, so pressing the row is the same act as
  // pressing its intent pill — no extra step, no confirmation.
  const { host } = fakeHost([profileRow('a1b2c3d4a1b2c3d4', 'PSO Coated v3')]);
  const o = open(host);
  await settle();
  assert.equal(condRow('fogra51').dataset.state, 'loaded');
  assert.match(condRow('fogra51').textContent ?? '', /PSO Coated v3/);
  click(document.querySelector('[data-labp-cond="fogra51"]')!);
  await o.closed;
  assert.deepEqual(o.activated, [['a1b2c3d4a1b2c3d4', 'relative']], 'charted under the row’s own intent');
  assert.equal(panel(), null, 'and got out of the way');
});

test('a loaded condition whose bytes have gone says so and does NOT close', async () => {
  // onActivate reports failure, so the panel must not pretend the charts moved.
  const { host } = fakeHost([profileRow('deadbeefdeadbeef', 'Coated FOGRA39 (ISO 12647-2:2004)')]);
  open(host, () => false);
  await settle();
  click(document.querySelector('[data-labp-cond="fogra39"]')!);
  await settle();
  assert.match(msgText(), /could not be read/);
  assert.ok(panel(), 'still open');
});

test('an unfetchable condition opens the picker and names the file to look for', async () => {
  // The no-source path. `fetchSourceFor` is data, so this drives it through a condition
  // that has none rather than asserting on today's SOURCES table.
  const noSource = PRESS_CONDITIONS.find(c => !fetchSourceFor(c));
  if (!noSource) {
    // Every condition is fetchable today — assert the fallback still exists as data,
    // since it is what an offline reader gets.
    for (const c of PRESS_CONDITIONS) assert.ok(c.files.length, `${c.id} names a filename`);
    return;
  }
  const { host } = fakeHost();
  open(host);
  await settle();
  let picked = 0;
  document.querySelector<HTMLInputElement>('[data-labp-file]')!.addEventListener('click', () => { picked++; });
  click(document.querySelector(`[data-labp-cond="${noSource.id}"]`)!);
  await settle();
  assert.equal(picked, 1, 'the picker opened');
  assert.match(msgText(), new RegExp(noSource.files[0]!.replace('.', '\\.')));
});

test('a fetch that fails names the file on this device instead of dead-ending', async () => {
  const fetchable = PRESS_CONDITIONS.find(c => fetchSourceFor(c));
  assert.ok(fetchable, 'at least one condition is fetchable');
  const { host } = fakeHost();
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 503, async arrayBuffer() { return new ArrayBuffer(0); } })) as unknown as typeof fetch;
  try {
    open(host);
    await settle();
    click(document.querySelector(`[data-labp-cond="${fetchable.id}"]`)!);
    await settle();
    await settle();
    assert.match(msgText(), new RegExp(fetchable.files[0]!.replace('.', '\\.')), 'says the filename, not the network');
    assert.equal(condRow(fetchable.id).hasAttribute('data-busy'), false, 'and the row is pressable again');
  } finally {
    globalThis.fetch = real;
  }
});

// The success path needs REAL profile bytes, since ingest parses them. macOS ships one;
// elsewhere this is skipped rather than faked — a synthetic buffer would test the stub.
const SYSTEM_CMYK = '/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc';
test('a fetched profile is stored, mounted and charted in one press', { skip: !existsSync(SYSTEM_CMYK) && 'no system CMYK profile' }, async () => {
  const bytes = readFileSync(SYSTEM_CMYK);
  const fetchable = PRESS_CONDITIONS.find(c => fetchSourceFor(c))!;
  const { host, rows } = fakeHost();
  const real = globalThis.fetch;
  let asked = '';
  globalThis.fetch = (async (url: string) => {
    asked = String(url);
    return { ok: true, status: 200, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
  }) as unknown as typeof fetch;
  try {
    const o = open(host);
    await settle();
    click(document.querySelector(`[data-labp-cond="${fetchable.id}"]`)!);
    await o.closed;
    assert.equal(asked, fetchSourceFor(fetchable)!.url, 'fetched the probed URL, nothing else');
    assert.equal(rows.length, 1, 'stored as a user asset');
    assert.equal(rows[0]!.type, 'profile');
    assert.equal(o.activated.length, 1, 'and charted — pressing a condition IS the request to compare');
    assert.equal(panel(), null);
  } finally {
    globalThis.fetch = real;
  }
});

test('the intent buttons say the whole word, and an absent table stays focusable', async () => {
  const { host } = fakeHost([profileRow('0f0f0f0f0f0f0f0f', 'Generic Lab Profile', ['perceptual', 'relative'])]);
  open(host);
  await settle();
  const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('.labp-intents [data-lab-intent]'));
  assert.deepEqual(btns.map(b => (b.textContent ?? '').trim()), ['Perceptual', 'Relative', 'Saturation', 'Absolute']);
  for (const b of btns) {
    assert.equal(b.hasAttribute('title'), false, 'no title= — invisible to keyboard and touch');
  }
  const sat = btns.find(b => b.dataset.labIntent === 'saturation')!;
  assert.equal(sat.getAttribute('aria-disabled'), 'true', 'stated, not hidden');
  assert.equal(sat.disabled, false, 'but still focusable, so it can answer why');
  assert.match(sat.getAttribute('data-tip') ?? '', /saturation/, 'the touch-capable tooltip primitive, not title');
  // Pressing it answers in the status line rather than doing nothing.
  click(sat);
  await settle();
  assert.match(msgText(), /saturation/);
});

test('the panel stylesheet dresses the row button and never with a dashed border', () => {
  // A dashed border means DROP AREA in this design language, and the drop zone above is
  // the only one. Also guards the wrap: four whole words must fold, not squeeze.
  const css = readFileSync(new URL('../styles/parts/color-lab.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.labp-cond-btn'), css.indexOf('.labp-list'));
  assert.ok(block.includes('cursor: pointer'), 'the row reads as pressable');
  assert.ok(block.includes(':focus-visible'), 'and shows a focus ring');
  assert.ok(!/dashed/.test(block), 'no dashed border on a condition row');
  assert.match(css, /\.labp-intents \{[^}]*flex-wrap: wrap/, 'whole-word intents wrap on a phone');
});
