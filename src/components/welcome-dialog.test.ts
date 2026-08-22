// SPDX-License-Identifier: MPL-2.0
/**
 * The first-run welcome's own decisions (plans/137 A2/A3): what the dialog shows
 * before anyone touches it, what the language expander does, and which exits
 * count as a dismissal.
 *
 * Run directly (the module imports its stylesheet, so the CSS stub is required):
 *   node --import ./tests/css-stub.mjs --test shells/web/src/components/welcome-dialog.test.ts
 *
 * jsdom with a real origin (history + localStorage need one) and showModal/close
 * stubbed on the prototype, as in modal-back.test.ts - jsdom has <dialog> but
 * neither method.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lolly.tools/#/' });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.history = dom.window.history as unknown as typeof globalThis.history;
globalThis.location = dom.window.location as unknown as typeof globalThis.location;
globalThis.localStorage = dom.window.localStorage;
// The dialog's delegated click handler narrows with `instanceof Element`, which
// resolves against the realm's global - not the jsdom window's.
globalThis.Element = dom.window.Element;

const dialogProto = dom.window.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
dialogProto.showModal = function showModal(this: { open: boolean }): void { this.open = true; };
dialogProto.close = function close(this: { open: boolean }): void { this.open = false; };

const { showWelcomeDialog } = await import('./welcome-dialog.ts');

const dialog = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('.welcome-dialog');
  assert.ok(el, 'the welcome dialog should be mounted');
  return el;
};
const open = (): Promise<string> => {
  localStorage.clear();
  return showWelcomeDialog() as unknown as Promise<string>;
};

test('the language row opens collapsed: the detected language plus one expander', async () => {
  const settled = open();
  const el = dialog();
  assert.equal(el.querySelectorAll('[data-lang]').length, 1, 'one chip only - not the whole wall');
  assert.equal(el.querySelector('[data-lang]')?.getAttribute('data-lang'), 'en');
  assert.equal(el.querySelectorAll('[data-lang-more]').length, 1);
  // The visible twin of Escape, and the privacy line the standalone strip carries.
  assert.equal(el.querySelector('.welcome-skip')?.getAttribute('data-choice'), 'dismiss');
  assert.match(el.querySelector('.welcome-privacy')?.textContent ?? '', /stay on this device/);
  assert.equal(el.querySelector('.welcome-privacy-link')?.getAttribute('href'), '#/docs/privacy');
  el.querySelector<HTMLButtonElement>('.welcome-skip')?.click();
  await settled;
});

test('"More languages…" expands in place to the full row and retires itself', async () => {
  const settled = open();
  dialog().querySelector<HTMLButtonElement>('[data-lang-more]')?.click();
  const el = dialog();
  assert.ok(el.querySelectorAll('[data-lang]').length > 20, 'every language after expanding');
  assert.equal(el.querySelectorAll('[data-lang-more]').length, 0);
  assert.ok(el.querySelector('.welcome-skip'), 'the rest of the dialog survives the repaint');
  el.querySelector<HTMLButtonElement>('.welcome-skip')?.click();
  await settled;
});

test('"Skip for now" is a dismissal: it settles the welcome AND the privacy notice', async () => {
  const settled = open();
  dialog().querySelector<HTMLButtonElement>('.welcome-skip')?.click();
  assert.equal(await settled, 'dismiss');
  assert.equal(localStorage.getItem('lolly-welcome-dismissed'), '1');
  assert.equal(localStorage.getItem('lolly-privacy-ack'), '1');
});

test('a route change is teardown, not a dismissal - it persists neither flag', async () => {
  const settled = open();
  window.dispatchEvent(new dom.window.Event('hashchange'));
  await settled;
  assert.equal(document.querySelector('.welcome-dialog'), null);
  assert.equal(localStorage.getItem('lolly-welcome-dismissed'), null);
  assert.equal(localStorage.getItem('lolly-privacy-ack'), null);
});
