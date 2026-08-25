// SPDX-License-Identifier: MPL-2.0
/**
 * Edge docking - the runtime half of lib/edge-dock.ts: occupancy + stacking, the
 * `--dock-w` inset, collapse, the RTL-aware drop hit-test, and the two invariants:
 *
 *   - MOBILE UNTOUCHABLE: below the 640px breakpoint the module is fully inert - no
 *     column, no `--dock-w`, no attribute, nothing moved.
 *   - BYTE-IDENTICAL IDLE: once the last panel undocks, the column, the `--dock-w`
 *     custom property and the `data-edge-dock` attribute are all gone.
 *
 * Run directly:  node --test shells/web/src/lib/edge-dock.test.ts
 *
 * jsdom with a real origin (geometry persists to localStorage). matchMedia is a
 * controllable stub so a test can pretend to be phone-width; window.innerWidth is
 * jsdom's default 1024.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lolly.tools/' });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

// A dragged column width, seeded BEFORE import so the read-direction of persistence is
// covered: the module loads its geometry at import time.
localStorage.setItem('lolly:edge-dock', JSON.stringify({ width: 400 }));

// Controllable breakpoint. mobile=false ⇒ desktop ⇒ docking available.
let mobile = false;
(globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({
  matches: q.includes('max-width: 640px') ? mobile : !mobile,
  media: q, onchange: null, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});

const ED = await import('./edge-dock.ts');

function panel(id: string): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  document.body.appendChild(el);
  return el;
}
function reset(): void {
  ED.releaseDock('neuro');
  ED.releaseDock('export');
  document.querySelector('.edge-dock-drop')?.remove();
  document.documentElement.dir = '';
  mobile = false;
  for (const el of [...document.querySelectorAll('#pn, #px')]) el.remove();
}
const dockW = (): string => document.documentElement.style.getPropertyValue('--dock-w');
const hasCol = (): boolean => !!document.querySelector('.edge-dock');

test('below the mobile breakpoint docking is fully inert', () => {
  reset();
  mobile = true;
  const el = panel('pn');
  assert.equal(ED.requestDock('neuro', el), false);
  assert.equal(hasCol(), false);
  assert.equal(dockW(), '');
  assert.equal(document.documentElement.hasAttribute('data-edge-dock'), false);
  assert.equal(el.parentElement, document.body);   // never moved
});

test('docking builds the column, sets --dock-w (persisted width) and the attribute, and moves the panel', () => {
  reset();
  const el = panel('pn');
  assert.equal(ED.requestDock('neuro', el), true);
  assert.equal(hasCol(), true);
  assert.equal(dockW(), '400px');   // the width seeded in localStorage
  assert.equal(document.documentElement.getAttribute('data-edge-dock'), '');
  assert.ok(el.closest('.edge-dock-slot'), 'panel now lives in a dock slot');
  assert.equal(ED.isDocked('neuro'), true);
});

test('releasing the last panel restores it and tears down to byte-identical idle', () => {
  reset();
  const el = panel('pn');
  let released = false;
  ED.requestDock('neuro', el, { onRelease: () => { released = true; } });
  ED.releaseDock('neuro');
  assert.equal(released, true);
  assert.equal(el.parentElement, document.body);   // back home
  assert.equal(hasCol(), false);
  assert.equal(dockW(), '');
  assert.equal(document.documentElement.hasAttribute('data-edge-dock'), false);
});

test('two panels stack player-over-export with one divider between', () => {
  reset();
  const n = panel('pn'); const x = panel('px');
  ED.requestDock('export', x);   // request order should not decide stacking order
  ED.requestDock('neuro', n);
  assert.equal(ED.dockedCount(), 2);
  const slots = [...document.querySelectorAll('.edge-dock-slot')];
  assert.equal(slots.length, 2);
  assert.equal(slots[0]!.getAttribute('data-slot'), 'neuro');    // player on top
  assert.equal(slots[1]!.getAttribute('data-slot'), 'export');   // export below
  assert.equal(document.querySelectorAll('.edge-dock-divider').length, 1);
  assert.ok(slots[1]!.classList.contains('edge-dock-slot--fill'), 'bottom panel fills the remainder');
});

test('RTL-aware hit-test tracks the inline-end edge', () => {
  reset();
  const vw = window.innerWidth;
  assert.equal(ED.edgeDockHitTest(vw - 4), true);    // LTR: inline-end is the right
  assert.equal(ED.edgeDockHitTest(10), false);
  document.documentElement.dir = 'rtl';
  assert.equal(ED.edgeDockHitTest(10), true);        // RTL: inline-end is the left
  assert.equal(ED.edgeDockHitTest(vw - 4), false);
});

test('preview shows and clears the drop affordance', () => {
  reset();
  ED.edgeDockPreview(true);
  assert.equal(document.querySelectorAll('.edge-dock-drop').length, 1);
  ED.edgeDockPreview(false);
  assert.equal(document.querySelectorAll('.edge-dock-drop').length, 0);
});

test('dropping below the breakpoint undocks everything on resize', () => {
  reset();
  ED.requestDock('neuro', panel('pn'));
  assert.equal(hasCol(), true);
  mobile = true;
  window.dispatchEvent(new dom.window.Event('resize'));
  assert.equal(ED.isDocked('neuro'), false);
  assert.equal(hasCol(), false);
  assert.equal(dockW(), '');
});

test('divider drag resizes via the existing handle (regression: it kept losing focus)', () => {
  reset();
  ED.requestDock('export', panel('px'));
  ED.requestDock('neuro', panel('pn'));
  const divider = document.querySelector('.edge-dock-divider')!;
  const top = document.querySelector<HTMLElement>('.edge-dock-slot')!;   // first slot = player
  divider.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 100, clientY: 200, bubbles: true }));
  divider.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 100, clientY: 260, bubbles: true }));
  // The handle must survive the move (relayout used to rebuild it, detaching the drag).
  assert.equal(document.querySelectorAll('.edge-dock-divider').length, 1);
  assert.equal(document.querySelector('.edge-dock-divider'), divider, 'same divider node across the drag');
  assert.ok(top.style.height, 'top slot got an explicit height from the split');
  divider.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 100, clientY: 260, bubbles: true }));
});

test('collapse hides the body to the rail and persists; expand restores', () => {
  reset();
  ED.requestDock('neuro', panel('pn'));
  const btn = document.querySelector<HTMLElement>('.edge-dock-collapse')!;
  btn.click();
  assert.ok(document.querySelector('.edge-dock')!.classList.contains('is-collapsed'));
  assert.equal(dockW(), '48px');   // the rail width
  assert.equal(JSON.parse(localStorage.getItem('lolly:edge-dock')!).collapsed, true);
  btn.click();
  assert.equal(document.querySelector('.edge-dock')!.classList.contains('is-collapsed'), false);
  assert.equal(dockW(), '400px');
  assert.equal(JSON.parse(localStorage.getItem('lolly:edge-dock')!).collapsed, false);
});
