// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="card"></div></body></html>', { url: 'https://lolly.tools/' });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.CustomEvent = dom.window.CustomEvent as unknown as typeof CustomEvent;
globalThis.Event = dom.window.Event as unknown as typeof Event;

const { renderDesignSystemsCard } = await import('./design-systems-card.ts');

const records = [
  { id: 'active', label: 'Active brand', ns: 'user/ds/active/', headId: null, source: { kind: 'local' }, locked: false, createdAt: 1, lastUsedAt: 1 },
  { id: 'hosted', label: 'Hosted brand', ns: 'user/ds/hosted/', headId: null, source: { kind: 'hosted', instance: 'https://brand.example', packUrl: null, signature: 'verified' }, locked: true, createdAt: 2, lastUsedAt: 2 },
] as const;

function host() {
  return {
    designSystems: {
      list: async () => [...records],
      activeId: async () => 'active',
    },
    assets: {},
  };
}

test('inactive design-system card is one large switch target with labelled secondary actions', async () => {
  const body = document.querySelector<HTMLElement>('#card')!;
  await renderDesignSystemsCard(body, host() as never);

  const active = body.querySelector<HTMLElement>('[data-ds-row="active"]')!;
  const hosted = body.querySelector<HTMLElement>('[data-ds-row="hosted"]')!;
  const hit = hosted.querySelector<HTMLButtonElement>('.ds-row-hit')!;
  assert.equal(active.querySelector('.ds-row-hit'), null, 'the already-active card is not a fake switch');
  assert.equal(hit.dataset.dsAct, 'switch');
  assert.equal(hit.getAttribute('aria-label'), 'Switch to Hosted brand');
  assert.equal(hosted.querySelector('[data-ds-act="refresh"]')?.textContent?.trim(), 'Check for updates');
  assert.equal(hosted.querySelector('[data-ds-act="fork"]')?.textContent?.trim(), 'Make an editable copy');
  assert.match(body.querySelector('[data-ds-act="file"]')?.textContent ?? '', /Open or import a file/);
});
