// SPDX-License-Identifier: MPL-2.0
/*
 * back-pill.ts — the shared back control's target resolution and click contract.
 *
 * Run directly:  node --test shells/web/src/components/back-pill.test.ts
 *
 * What's worth pinning down here is the decision table the pill replaced a pile
 * of hardcoded `<a href="#/">Tools</a>` anchors with: what it's CALLED, where it
 * GOES, and whether it goes there by popping a history entry or pushing one.
 * Everything else about the pill is CSS.
 *
 * jsdom supplies the DOM, sessionStorage (which lib/back-nav.ts persists to) and
 * a history object. The router isn't running, so the module's writers
 * (noteMountedView/recordLeave) are driven directly — exactly the two calls
 * main.ts makes around every navigation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main id="view"></main></body></html>', {
  url: 'http://localhost/#/dashboard',
});
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.MouseEvent = dom.window.MouseEvent;

const backNav = await import('../lib/back-nav.ts');
const { resolveBackTarget, backPillHtml, mountBackPill } = await import('./back-pill.ts');

/** Reset the module's persisted memory between cases. The in-memory
 *  "did this document navigate?" flag can't be un-set, so ordering matters:
 *  the direct-visit case runs FIRST, while it's still false. */
const clearStored = (): void => { sessionStorage.clear(); };

/** jsdom reports history.length === 1, which reads as "no entry to pop". Give
 *  the cases that care a second entry, the way a real navigation would. */
const withHistoryEntry = (): void => {
  Object.defineProperty(dom.window.history, 'length', { value: 2, configurable: true });
};

/** Stand in for one router navigation: leave `fromTitle` at `fromHref`, arrive
 *  somewhere else. Mirrors main.ts — noteMountedView() after the mount, then
 *  recordLeave() when that view is left. */
function walkFrom(routeName: string, title: string, href: string): void {
  document.title = title;
  dom.reconfigure({ url: `http://localhost${href}` });
  backNav.noteMountedView(routeName);
  backNav.recordLeave(href);
}

test('a direct visit — no previous view — falls back to Tools → the gallery', () => {
  clearStored();
  const target = resolveBackTarget();
  assert.equal(target.label, 'Tools');
  assert.equal(target.href, '#/');
  assert.equal(target.useHistory, false, 'nothing to go back TO, so it must be a forward link');
});

test('an in-app arrival wears the previous view’s name and returns there', () => {
  clearStored();
  withHistoryEntry();
  walkFrom('projects', 'Campaign assets — Lolly', '/#/p/abc');
  const target = resolveBackTarget();
  assert.equal(target.label, 'Campaign assets', 'the " — Lolly" suffix is stripped');
  assert.equal(target.href, '/#/p/abc');
  assert.equal(target.useHistory, true, 'a real history entry sits behind us');
});

test('the gallery is named "Tools" rather than the bare product name', () => {
  clearStored();
  walkFrom('gallery', 'Lolly', '/');
  assert.equal(resolveBackTarget().label, 'Tools');
});

test('a pinned target (the tool view’s launch folder) keeps its href', () => {
  clearStored();
  withHistoryEntry();
  walkFrom('projects', 'Campaign assets — Lolly', '/#/p/abc');

  // Previous view IS the pinned folder → it wears the folder's name and still
  // goes back through history.
  const matching = resolveBackTarget({ href: '/#/p/abc' });
  assert.equal(matching.label, 'Campaign assets');
  assert.equal(matching.useHistory, true);

  // Previous view is something else → the pill must still land in the folder,
  // so history.back() (which would go elsewhere) is off the table.
  const mismatched = resolveBackTarget({ href: '/#/p/other' });
  assert.equal(mismatched.href, '/#/p/other');
  assert.equal(mismatched.label, 'Back');
  assert.equal(mismatched.useHistory, false);
});

test('markup carries a real href and the resolved mode', () => {
  clearStored();
  withHistoryEntry();
  walkFrom('catalog', 'Catalog — Lolly', '/#/catalog');
  const html = backPillHtml();
  assert.match(html, /href="\/#\/catalog"/);
  assert.match(html, /data-back-pill="history"/);
  assert.match(html, /class="tools-home home-full"/);
  assert.match(html, />Catalog</, 'the label is the previous view, not "Tools"');
  assert.match(html, /<svg /, 'the arrow is a real glyph, not the ::before text fallback');
});

test('iconOnly drops the label but keeps the destination in the accessible name', () => {
  clearStored();
  withHistoryEntry();
  walkFrom('projects', 'Campaign assets — Lolly', '/#/p/abc');
  const html = backPillHtml({ class: 'me-back', iconOnly: true });
  assert.match(html, /aria-label="Back to Campaign assets"/);
  assert.doesNotMatch(html, /back-pill-label/);
});

test('a history-mode click pops the entry instead of pushing a new one', () => {
  clearStored();
  withHistoryEntry();
  walkFrom('catalog', 'Catalog — Lolly', '/#/catalog');
  const root = document.getElementById('view')!;
  root.innerHTML = backPillHtml();

  let backCalls = 0;
  Object.defineProperty(dom.window.history, 'back', { value: () => { backCalls++; }, configurable: true });

  mountBackPill(root);
  root.querySelector<HTMLElement>('[data-back-pill]')!.dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  assert.equal(backCalls, 1);
});

test('a modified click is left to the browser, so "open in new tab" still works', () => {
  clearStored();
  withHistoryEntry();
  walkFrom('catalog', 'Catalog — Lolly', '/#/catalog');
  const root = document.getElementById('view')!;
  root.innerHTML = backPillHtml();

  let backCalls = 0;
  Object.defineProperty(dom.window.history, 'back', { value: () => { backCalls++; }, configurable: true });

  mountBackPill(root);
  const ev = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
  root.querySelector<HTMLElement>('[data-back-pill]')!.dispatchEvent(ev);
  assert.equal(backCalls, 0);
  assert.equal(ev.defaultPrevented, false);
});

test('an intercepting view owns the click until it calls go()', () => {
  clearStored();
  withHistoryEntry();
  walkFrom('catalog', 'Catalog — Lolly', '/#/catalog');
  const root = document.getElementById('view')!;
  root.innerHTML = backPillHtml();

  let backCalls = 0;
  Object.defineProperty(dom.window.history, 'back', { value: () => { backCalls++; }, configurable: true });

  let release: (() => void) | null = null;
  mountBackPill(root, { intercept: (go) => { release = go; return true; } });
  const pill = root.querySelector<HTMLElement>('[data-back-pill]')!;
  pill.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.equal(backCalls, 0, 'the unsaved-work dialog is up — nothing has navigated yet');
  assert.equal(typeof release, 'function');
  release!();
  assert.equal(backCalls, 1, 'the dialog’s "leave" runs the pill’s own navigation');
});
