// SPDX-License-Identifier: MPL-2.0
/**
 * Playhead-aware canvas selection.
 *
 * A sequence composition stacks its scenes full-canvas; at any playhead time the
 * clock hides every inactive one by stamping sequence-dom's OFF_CLASS on its
 * `.lolly-box`. Hit-testing used to ignore that: a click on the visible scene
 * selected whatever was TOP of the boxes array — usually a scene the user could
 * not see (the bug a screen recording demonstrated: playhead on scene 1, click
 * selects scene 2). Selection must follow what the canvas shows.
 *
 * Runs against the real `initFreeCanvas` on the jsdom harness
 * free-canvas-timeline-add.test.ts established. The canvas DOM is hand-stamped
 * with `.lolly-box[data-box-id]` elements + OFF_CLASS exactly as the tool hooks
 * and the sequence clock leave them — the clock itself never stamps these
 * fixtures (they carry no data-seq attrs), so the class is fully test-owned.
 * Selection is observed through the model: click, press Delete, see which box
 * left the array — a full round trip, no spies.
 *
 * Run directly:  node --test shells/web/src/views/free-canvas-seq-hit.test.ts
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
const W = dom.window as unknown as typeof globalThis & {
  MouseEvent: typeof MouseEvent; KeyboardEvent: typeof KeyboardEvent;
};
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
const { OFF_CLASS } = await import('../bridge/sequence-dom.ts');

// free-canvas deliberately does NOT import sequence-dom (that would drag the lazy
// sequence graph into every editor tool's eager chunk) and carries the class name
// as a literal instead. This pin is what allows the literal: if OFF_CLASS ever
// changes, this fails before any user does.
test('free-canvas seq-off literal matches sequence-dom OFF_CLASS', () => {
  assert.equal(OFF_CLASS, 'seq-off');
});

const NATIVE = 1000;
const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; },
} as DOMRect);

function pointer(type: string, x: number, y: number): MouseEvent {
  const e = new W.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: 'mouse' });
  Object.defineProperty(e, 'buttons', { value: type === 'pointermove' ? 1 : 0 });
  return e;
}

function canvasCfg(): Record<string, unknown> {
  return {
    idField: 'id', xField: 'x', yField: 'y', wField: 'w', hField: 'h', rotationField: 'rot',
    fillField: 'bg', textField: 'text', imageField: 'image', fitField: 'fit',
    startField: 'start', durField: 'dur', clipInField: 'clipIn', speedField: 'speed',
    enterField: 'enter', exitField: 'exit', enterMsField: 'enterMs', exitMsField: 'exitMs',
    muteField: 'mute', laneField: 'lane',
    addKinds: [{ id: 'card', label: 'Card', seed: { kind: 'box', lane: 'seq', dur: 2.5 } }],
  };
}

// Two full-canvas scenes (scene2 later in the array = on top when both visible)
// and one small untimed overlay badge in the corner, above both.
const SCENES = (): Box[] => ([
  { id: 'scene1', kind: 'box', x: 0, y: 0, w: 1000, h: 1000, start: 0, dur: 2, lane: 'seq' },
  { id: 'scene2', kind: 'box', x: 0, y: 0, w: 1000, h: 1000, start: 2, dur: 2, lane: 'seq' },
  { id: 'badge', kind: 'box', x: 0, y: 0, w: 100, h: 100 },
] as never[]);

interface Fixture {
  stageEl: HTMLElement; canvasEl: HTMLElement;
  boxes(): Box[];
  ids(): string[];
  setOff(...ids: string[]): void;
  destroy(): void;
}

function mount(boxes: Box[]): Fixture {
  const doc = dom.window.document;
  const viewEl = doc.createElement('div');
  const stageEl = doc.createElement('div');
  const canvasEl = doc.createElement('div');
  stageEl.appendChild(canvasEl);
  viewEl.appendChild(stageEl);
  doc.body.appendChild(viewEl);
  stageEl.getBoundingClientRect = () => rect(0, 0, NATIVE, NATIVE);
  canvasEl.getBoundingClientRect = () => rect(0, 0, NATIVE, NATIVE);

  // The rendered boxes as the tool hooks paint them (id stamped; the clock/test
  // adds OFF_CLASS). No data-seq attrs, so a mounted clock never touches these.
  for (const b of boxes) {
    const el = doc.createElement('div');
    el.className = 'lolly-box';
    el.setAttribute('data-box-id', String((b as unknown as { id: string }).id));
    canvasEl.appendChild(el);
  }

  const model = new Map<string, unknown>([['boxes', boxes]]);
  const subs: Array<() => void> = [];
  const runtime = {
    getModel: () => [...model.entries()].map(([id, value]) => ({ id, value })),
    setInput(id: string, value: unknown) { model.set(id, value); for (const s of subs) s(); },
    subscribe(fn: () => void) { subs.push(fn); return () => { subs.splice(subs.indexOf(fn), 1); }; },
  };
  const handle = initFreeCanvas({
    viewEl, stageEl, canvasEl,
    runtime: runtime as never,
    host: {} as never,
    input: { id: 'boxes', canvas: canvasCfg() as never, fields: [] },
    nativeW: NATIVE, nativeH: NATIVE,
  });
  return {
    stageEl, canvasEl,
    boxes: () => model.get('boxes') as Box[],
    ids: () => (model.get('boxes') as Array<{ id: string }>).map((b) => b.id),
    setOff(...offIds: string[]) {
      for (const el of canvasEl.querySelectorAll('.lolly-box')) {
        el.classList.toggle(OFF_CLASS, offIds.includes(el.getAttribute('data-box-id') as string));
      }
    },
    destroy() { handle.destroy(); viewEl.remove(); doc.body.innerHTML = ''; },
  };
}

/** Let the lazy timeline chunk resolve and any queued frame run. */
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

function clickAt(f: Fixture, x: number, y: number): void {
  f.canvasEl.dispatchEvent(pointer('pointerdown', x, y));
  dom.window.document.dispatchEvent(pointer('pointerup', x, y));
}
function pressDelete(): void {
  // The auto-opened timeline panel focuses its ruler; while focus is inside
  // `.tl-panel`, onKey defers to the panel's own key handling (by design). A real
  // canvas click moves focus, jsdom's synthetic pointerdown does not — so park
  // focus on body first, as the browser would after the click.
  (dom.window.document.activeElement as HTMLElement | null)?.blur?.();
  dom.window.document.body.dispatchEvent(
    new W.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
}

test('click selects the VISIBLE scene, not the hidden top-of-array one', async () => {
  const f = mount(SCENES());
  await settle();
  f.setOff('scene2');                      // playhead inside scene1's window
  clickAt(f, 500, 500);
  pressDelete();
  assert.deepEqual(f.ids(), ['scene2', 'badge'], 'the visible scene1 was selected and deleted');
  f.destroy();
});

test('the same click with the playhead on scene2 selects scene2', async () => {
  const f = mount(SCENES());
  await settle();
  f.setOff('scene1');
  clickAt(f, 500, 500);
  pressDelete();
  assert.deepEqual(f.ids(), ['scene1', 'badge']);
  f.destroy();
});

test('an always-on overlay above a hidden scene still wins its own pixels', async () => {
  const f = mount(SCENES());
  await settle();
  f.setOff('scene2');
  clickAt(f, 50, 50);                      // inside the badge, which sits on top
  pressDelete();
  assert.deepEqual(f.ids(), ['scene1', 'scene2']);
  f.destroy();
});

test('with nothing hidden the historical topmost-wins behaviour is unchanged', async () => {
  const f = mount(SCENES());
  await settle();                          // no setOff — no OFF_CLASS anywhere
  clickAt(f, 500, 500);
  pressDelete();
  assert.deepEqual(f.ids(), ['scene1', 'badge'], 'top-of-array scene2 was selected');
  f.destroy();
});

test('a click where ONLY hidden boxes exist selects nothing', async () => {
  const f = mount(SCENES());
  await settle();
  f.setOff('scene1', 'scene2');
  clickAt(f, 500, 500);                    // outside the badge, both scenes hidden
  pressDelete();
  assert.deepEqual(f.ids(), ['scene1', 'scene2', 'badge'], 'nothing was selected, nothing deleted');
  f.destroy();
});
