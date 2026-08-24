// SPDX-License-Identifier: MPL-2.0
/**
 * The mobile profile menu's row contract + the Language child popover's
 * ownership rules (the body-popover `isInside` case).
 *
 * Run directly:  node --test shells/web/src/components/profile-menu.test.ts
 *
 * What is pinned:
 *  - the menu carries the consolidated rows: theme segments, Home (root-absolute
 *    `/#/`, the back pill's HOME_HREF reasoning), Language (with the current
 *    language's native name), brand and settings - so utility views can hide
 *    their standalone home/language fabs on mobile against a stable replacement;
 *  - the Language row spawns the real lang-menu popover as a CHILD, and a
 *    pointerdown inside that child does NOT dismiss the parent menu under it;
 *  - closing the parent closes the child with it (the onClose cascade).
 *
 * Positioning/flip and the Escape ladder are body-popover.test.ts's business.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><a href="#/profile" id="pl">Profile</a></body></html>', { url: 'https://lolly.tools/' });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
// Mobile breakpoint matches; the '(pointer: coarse)' back-stack probe does not.
(globalThis.window as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia =
  (q: string) => ({ matches: q.includes('max-width') });

const { attachProfileMenu, mountProfileFab } = await import('./profile-menu.ts');

/** A host slice good enough for setTheme/switchLang signatures - never invoked
 *  here (no theme click, no language pick reaches switchLang). */
const host = {
  profile: { get: async () => ({}), set: async () => {} },
  state: { get: async () => null, set: async () => {} },
} as unknown as Parameters<typeof attachProfileMenu>[1];

const trigger = (): HTMLElement => document.getElementById('pl')!;
const menu = (): HTMLElement | null => document.querySelector('.profile-menu');
const langPop = (): HTMLElement | null => document.querySelector('.lang-menu');
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function pointerDownOn(target: Element): void {
  // jsdom has no PointerEvent constructor wired to dispatch typing - a plain
  // Event with the right type is what the document listener reads.
  const e = new dom.window.Event('pointerdown', { bubbles: true });
  target.dispatchEvent(e);
}

test('mobile click opens the menu with the consolidated rows', async () => {
  const detach = attachProfileMenu(trigger(), host);
  trigger().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const el = menu();
  assert.ok(el, 'popover mounted on body');
  assert.ok(el!.querySelector('[data-theme-seg]'), 'theme segments present');
  const home = el!.querySelector<HTMLAnchorElement>('[data-act="home"]');
  assert.ok(home, 'Home row present');
  assert.equal(home!.getAttribute('href'), '/#/', 'Home is root-absolute (HOME_HREF)');
  const lang = el!.querySelector<HTMLElement>('[data-act="lang"]');
  assert.ok(lang, 'Language row present');
  assert.ok(lang!.textContent!.includes('English'), 'current language named on the row');
  assert.equal(lang!.getAttribute('aria-haspopup'), 'menu');
  assert.ok(el!.querySelector('[data-act="settings"]'), 'Settings row still present');
  detach();
  assert.equal(menu(), null, 'detach removes the popover');
});

test('Language spawns the child lang-menu; taps inside it never dismiss the parent', async () => {
  const detach = attachProfileMenu(trigger(), host);
  trigger().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  // The row wires through a lazy import + a deferred outside-pointerdown
  // listener (both a macrotask) - settle them before interacting.
  await tick(); await tick();
  const lang = menu()!.querySelector<HTMLElement>('[data-act="lang"]');
  lang!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick();
  const child = langPop();
  assert.ok(child, 'lang-menu popover opened as a child');
  assert.ok(menu(), 'parent menu still open under the child');

  // A pointerdown INSIDE the child is "inside" to the parent (isInside) - the
  // parent must survive it; the same tap anywhere else dismisses the parent.
  pointerDownOn(child!.querySelector('[data-lang]')!);
  assert.ok(menu(), 'parent survived a tap inside the child');

  // Closing the parent (detach → popover.close) cascades to the child.
  detach();
  assert.equal(menu(), null, 'parent closed');
  assert.equal(langPop(), null, 'child closed with it (onClose cascade)');
});

test('mountProfileFab appends the right-most quick link and wires the same menu', async () => {
  const cluster = document.createElement('div');
  cluster.className = 'gallery-topright';
  cluster.innerHTML = '<button class="lang-fab"></button>';
  document.body.appendChild(cluster);
  mountProfileFab(cluster, host);
  const fab = cluster.querySelector<HTMLAnchorElement>('a.profile-fab');
  assert.ok(fab, 'fab appended');
  assert.equal(fab!.getAttribute('href'), '#/profile', 'desktop: a plain quick link to the profile');
  assert.equal(cluster.lastElementChild, fab, 'appended last, so it sits right-most in the cluster');
  assert.ok(fab!.getAttribute('aria-label'), 'accessible name present');
  // Mobile (matchMedia stub says max-width matches): the click opens the menu.
  fab!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.ok(menu(), 'mobile click opens the consolidated menu');
  await tick();
  pointerDownOn(document.body);
  assert.equal(menu(), null);
  cluster.remove();
});

test('a pointerdown outside both popovers closes the parent', async () => {
  const detach = attachProfileMenu(trigger(), host);
  trigger().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick();
  assert.ok(menu());
  pointerDownOn(document.body);
  assert.equal(menu(), null, 'outside tap dismissed the menu');
  detach();
});
