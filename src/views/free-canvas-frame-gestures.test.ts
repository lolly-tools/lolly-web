// SPDX-License-Identifier: MPL-2.0
/**
 * Artboard (frame-kind box) gestures - the plans/141 WP-A pins.
 *
 * A frame renders as `.lolly-frame-page[data-frame-id]`, never as a `.lolly-box`, so
 * the live-gesture writers need their frame fallback and the commit paths must cascade
 * members. Three behaviours pinned here:
 *
 *   1. moving a frame commits the frame AND translates its members (regression pin);
 *   2. an origin-moving resize handle (nw) cascades members with the origin - Figma
 *      semantics: children keep their frame-local position;
 *   3. DURING the gesture the frame's own page element tracks the pointer (this was
 *      the "artboards go invisible while dragging" bug: the old `.lolly-box`-only
 *      selector made a frame drag a visual no-op until the commit repaint), and the
 *      lifted page clip is restored verbatim at gesture end.
 *
 * Same jsdom harness as free-canvas-kf-commit.test.ts: real initFreeCanvas, in-memory
 * runtime, model-round-trip assertions.
 *
 * Run directly:  node --test shells/web/src/views/free-canvas-frame-gestures.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import type { Box } from './free-canvas-math.ts';

registerHooks({
  load(url: string, ctx: unknown, next: (u: string, c: unknown) => unknown) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {};' };
    return next(url, ctx);
  },
} as Parameters<typeof registerHooks>[0]);

const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
const W = dom.window as unknown as typeof globalThis & { MouseEvent: typeof MouseEvent };
for (const k of [
  'window', 'document', 'HTMLElement', 'Element', 'KeyboardEvent', 'Event', 'CustomEvent',
  'MouseEvent', 'Node', 'getComputedStyle', 'MutationObserver',
]) {
  (globalThis as Record<string, unknown>)[k] = (dom.window as unknown as Record<string, unknown>)[k];
}
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => dom.window.requestAnimationFrame(cb)) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((h: number) => dom.window.cancelAnimationFrame(h)) as typeof cancelAnimationFrame;
(globalThis as Record<string, unknown>).matchMedia = (q: string) =>
  ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
(globalThis as Record<string, unknown>).ResizeObserver = class { observe() {} disconnect() {} };

const { initFreeCanvas } = await import('./free-canvas.ts');

const NATIVE = 1000;
const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; },
} as DOMRect);

function pointerEvent(type: string, x: number, y: number): MouseEvent {
  const e = new W.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: 'mouse' });
  Object.defineProperty(e, 'timeStamp', { value: 0 });
  Object.defineProperty(e, 'buttons', { value: type === 'pointermove' ? 1 : 0 });
  return e;
}

const CFG = {
  idField: 'id', kindField: 'kind', xField: 'x', yField: 'y', wField: 'w', hField: 'h',
  rotationField: 'rot', fillField: 'bg',
  addKinds: [{ id: 'box', label: 'Box', seed: { kind: 'box' } }],
};
const FRAME_CFG = { frameField: 'frame', frameKind: 'frame', orderField: 'order', clipChildrenField: 'clipChildren' };

/** One 400×300 artboard at (100,100) with one member box at (150,150). A click at
 *  (400,300) hits empty artboard area - the only way to grab the artboard. */
const SEED = (): Box[] => ([
  { id: 'f1', kind: 'frame', x: 100, y: 100, w: 400, h: 300, order: 0, clipChildren: true },
  { id: 'b1', kind: 'box', x: 150, y: 150, w: 100, h: 50, frame: 'f1' },
] as Box[]);

interface Fixture {
  stageEl: HTMLElement;
  canvasEl: HTMLElement;
  boxes(): Box[];
  byId(id: string): Record<string, unknown>;
  writes(): number;
  destroy(): void;
}

function mount(seed: Box[]): Fixture {
  const viewEl = dom.window.document.createElement('div');
  const stageEl = dom.window.document.createElement('div');
  const canvasEl = dom.window.document.createElement('div');
  stageEl.appendChild(canvasEl);
  viewEl.appendChild(stageEl);
  dom.window.document.body.appendChild(viewEl);
  stageEl.getBoundingClientRect = () => rect(0, 0, NATIVE, NATIVE);
  canvasEl.getBoundingClientRect = () => rect(0, 0, NATIVE, NATIVE);

  const model = new Map<string, unknown>([['boxes', seed]]);
  const subs: Array<() => void> = [];
  let writes = 0;
  const runtime = {
    getModel: () => [...model.entries()].map(([id, value]) => ({ id, value })),
    setInput(id: string, value: unknown) { writes++; model.set(id, value); for (const s of subs) s(); },
    subscribe(fn: () => void) { subs.push(fn); return () => { subs.splice(subs.indexOf(fn), 1); }; },
  };
  const handle = initFreeCanvas({
    viewEl, stageEl, canvasEl,
    runtime: runtime as never,
    host: {} as never,
    input: { id: 'boxes', canvas: CFG as never, fields: [] },
    frame: FRAME_CFG,
    nativeW: NATIVE, nativeH: NATIVE,
  });
  return {
    stageEl, canvasEl,
    boxes: () => model.get('boxes') as Box[],
    byId: (id: string) => (model.get('boxes') as Box[]).find((b) => b.id === id)! as Record<string, unknown>,
    writes: () => writes,
    destroy() { handle.destroy(); viewEl.remove(); dom.window.document.body.innerHTML = ''; },
  };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 25)); for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

/** The page element the tool's TEMPLATE would paint for frame f1 (free-canvas only
 *  drives the model and the chrome, so the live node is built by hand, exactly like
 *  the kf-commit suite builds its `.lolly-box`). */
function addPageEl(f: Fixture): HTMLElement {
  const el = dom.window.document.createElement('div');
  el.className = 'lolly-frame-page';
  el.setAttribute('data-pdf-page', '');
  el.setAttribute('data-frame-id', 'f1');
  el.style.cssText = 'position:absolute;left:100px;top:100px;width:400px;height:300px;overflow:hidden';
  f.canvasEl.appendChild(el);
  return el;
}

test('moving an artboard commits it AND translates its members in one write', async () => {
  const f = mount(SEED());
  try {
    const before = f.writes();
    f.canvasEl.dispatchEvent(pointerEvent('pointerdown', 400, 300));
    f.canvasEl.dispatchEvent(pointerEvent('pointermove', 450, 330));
    await settle();
    f.canvasEl.dispatchEvent(pointerEvent('pointerup', 450, 330));
    await settle();

    assert.equal(f.writes() - before, 1, 'one commit, one undo step');
    const fr = f.byId('f1');
    assert.equal(fr.x, 150); assert.equal(fr.y, 130);
    const m = f.byId('b1');
    assert.equal(m.x, 200, 'member travelled with the frame…');
    assert.equal(m.y, 180);
    assert.equal(m.frame, 'f1', '…and kept its membership');
  } finally { f.destroy(); }
});

test('an origin-moving resize handle (nw) cascades members with the origin', async () => {
  const f = mount(SEED());
  try {
    // Select the artboard by its empty area, then grab the nw handle.
    f.canvasEl.dispatchEvent(pointerEvent('pointerdown', 400, 300));
    f.canvasEl.dispatchEvent(pointerEvent('pointerup', 400, 300));
    await settle();
    const nw = f.stageEl.querySelector<HTMLElement>('.fc-handle.fc-h-nw');
    assert.ok(nw, 'a selected artboard carries resize handles');

    nw!.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    f.canvasEl.dispatchEvent(pointerEvent('pointermove', 60, 60));
    await settle();
    f.canvasEl.dispatchEvent(pointerEvent('pointerup', 60, 60));
    await settle();

    const fr = f.byId('f1');
    assert.equal(fr.x, 60); assert.equal(fr.y, 60);
    assert.equal(fr.w, 440); assert.equal(fr.h, 340, 'opposite corner stayed fixed');
    const m = f.byId('b1');
    assert.equal(m.x, 110, 'member kept its frame-local position (150−40)…');
    assert.equal(m.y, 110);
    assert.equal(m.frame, 'f1', '…and its membership');
  } finally { f.destroy(); }
});

test('the canvas stamps + emits the ACTIVE artboard for the export bar (plans/141 WP-B)', async () => {
  const f = mount(SEED());
  try {
    await settle();
    assert.equal(f.canvasEl.dataset.fcActiveFrame, 'f1',
      'with no selection the primary (lowest-order) artboard is active');
    const events: Array<{ sel: { id: string; w: number; h: number } | null; timed: unknown }> = [];
    f.canvasEl.addEventListener('fc-artboard', (e) => events.push((e as CustomEvent).detail));

    // A committed resize changes the active artboard's size → the emitter re-fires
    // with the new numbers (the export bar mirrors them).
    f.canvasEl.dispatchEvent(pointerEvent('pointerdown', 400, 300));
    f.canvasEl.dispatchEvent(pointerEvent('pointerup', 400, 300));
    await settle();
    const nw = f.stageEl.querySelector<HTMLElement>('.fc-handle.fc-h-nw')!;
    nw.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    f.canvasEl.dispatchEvent(pointerEvent('pointermove', 60, 60));
    await settle();
    f.canvasEl.dispatchEvent(pointerEvent('pointerup', 60, 60));
    await settle();

    const last = events.at(-1);
    assert.ok(last?.sel, 'the event carries the selected artboard');
    assert.equal(last!.sel!.id, 'f1');
    assert.equal(last!.sel!.w, 440, 'the mirrored size is the committed one');
    assert.equal(last!.sel!.h, 340);
    assert.equal(last!.timed, null, 'no timed pages in this doc');
  } finally { f.destroy(); }
});

test('DURING a drag the frame page element tracks the pointer, and its clip round-trips', async () => {
  const f = mount(SEED());
  try {
    const page = addPageEl(f);
    f.canvasEl.dispatchEvent(pointerEvent('pointerdown', 400, 300));
    f.canvasEl.dispatchEvent(pointerEvent('pointermove', 450, 330));
    await settle();

    // Mid-gesture: the page element itself is the live target (the old `.lolly-box`
    // selector found nothing here - the invisibility bug), its clip is lifted so
    // members can spill while crossing pages, and it is hoisted above later pages.
    assert.equal(page.style.left, '150px', 'the artboard follows the pointer live');
    assert.equal(page.style.top, '130px');
    assert.equal(page.style.overflow, 'visible', 'page clip lifted for the drag');
    assert.equal(page.dataset.fcOverflow, 'hidden', 'original clip stashed verbatim');
    assert.equal(page.style.zIndex, '9999', 'dragged artboard paints above later pages');

    f.canvasEl.dispatchEvent(pointerEvent('pointerup', 450, 330));
    await settle();
    assert.equal(page.style.overflow, 'hidden', 'clip restored verbatim at gesture end');
    assert.equal(page.dataset.fcOverflow, undefined, 'stash cleared');
    assert.equal(page.style.zIndex, '', 'z-hoist dropped');
  } finally { f.destroy(); }
});
