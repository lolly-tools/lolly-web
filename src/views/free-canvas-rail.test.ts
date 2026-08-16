// SPDX-License-Identifier: MPL-2.0
/**
 * The editor's TOOL RAIL after it became a floating palette: the Lolly menu that now
 * holds every document action, the selection gate on the layout options, and the drag.
 *
 * Three claims are worth locking down, and each failed in an obvious way while this was
 * being built:
 *   • the drag must position with left/top and NEVER a transform - a transformed
 *     ancestor becomes the containing block for the rail's position:fixed colour
 *     popover and throws it off-screen (a bug already fixed once in this file), so the
 *     "no transform anywhere on the dock or the rail" assertion is the regression guard;
 *   • undo/redo moved INTO a menu, and they were the editor's only visible undo
 *     affordance, so the rows must exist, must reflect the history stack live (the
 *     menu stays open while you step back), and must still be driven by the shell's
 *     registered callback;
 *   • Arrange acts on a selection, so it hides without one - but only the BUTTON goes;
 *     the right-click menu and the keyboard are untouched.
 *
 * Everything runs against the real `initFreeCanvas` on the same jsdom harness
 * free-canvas-tools.test.ts established. What is NOT testable here, and is verified by
 * hand in a browser: the actual painted position (jsdom has no layout, so every
 * getBoundingClientRect is stubbed), the frosted/opaque look of the palette, and
 * pointer capture during a drag.
 *
 * Run directly:  node --test shells/web/src/views/free-canvas-rail.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import type { Box } from './free-canvas-math.ts';
import { clampRailPos, initFreeCanvas, placePopover } from './free-canvas.ts';

// ── jsdom bootstrap (same shape as free-canvas-tools.test.ts) ─────────────────
const dom = new JSDOM('<!DOCTYPE html><body></body>');
const W = dom.window as unknown as typeof globalThis & { MouseEvent: typeof MouseEvent; KeyboardEvent: typeof KeyboardEvent };
for (const k of ['window', 'document', 'HTMLElement', 'KeyboardEvent', 'Event', 'MouseEvent', 'Node', 'getComputedStyle', 'MutationObserver']) {
  (globalThis as Record<string, unknown>)[k] = (dom.window as unknown as Record<string, unknown>)[k];
}
const rafQueue: Array<() => void> = [];
(globalThis as Record<string, unknown>).requestAnimationFrame = (fn: FrameRequestCallback): number => {
  rafQueue.push(() => fn(0));
  return rafQueue.length;
};
(globalThis as Record<string, unknown>).cancelAnimationFrame = (): void => {};
function frames(n = 3): void {
  for (let i = 0; i < n; i++) {
    const pending = rafQueue.splice(0, rafQueue.length);
    for (const fn of pending) fn();
  }
}
(globalThis as Record<string, unknown>).matchMedia = (q: string) =>
  ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
(globalThis as Record<string, unknown>).ResizeObserver = class { observe() {} disconnect() {} };

const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; },
} as DOMRect);

function pointerEvent(type: string, o: { x: number; y: number; id?: number; buttons?: number }): MouseEvent {
  // `buttons` is part of the gesture, not decoration: the rail's move handler treats a
  // move with NO button held as "the pointerup was lost" and finishes the drag, which is
  // the escape from a stolen pointer capture. Default to held for down/move, released for
  // up/cancel - what a real browser sends.
  const buttons = o.buttons ?? (type === 'pointerdown' || type === 'pointermove' ? 1 : 0);
  const e = new W.MouseEvent(type, { bubbles: true, cancelable: true, clientX: o.x, clientY: o.y, button: 0, buttons });
  Object.defineProperty(e, 'pointerId', { value: o.id ?? 1 });
  Object.defineProperty(e, 'pointerType', { value: 'mouse' });
  return e;
}

// ── fixture ───────────────────────────────────────────────────────────────────

const STAGE = 1000;
const RAIL_W = 54, RAIL_H = 300;

function canvasCfg(): Record<string, unknown> {
  return {
    idField: 'id', xField: 'x', yField: 'y', wField: 'w', hField: 'h', rotationField: 'rot',
    fillField: 'bg', opacityField: 'opacity', shapeField: 'shape', radiusField: 'radius',
    textField: 'text', groupField: 'group', clipField: 'clip',
    addKinds: [{ id: 'box', label: 'Box', seed: {} }],
  };
}

interface Fixture {
  stageEl: HTMLElement;
  canvasEl: HTMLElement;
  dock: HTMLElement;
  rail: HTMLElement;
  calls: string[];
  setHistory(canUndo: boolean, canRedo: boolean): void;
  destroy(): void;
}

const plainBox = (id: string, x: number, y: number): Box =>
  ({ kind: 'box', shape: 'rect', id, x, y, w: 120, h: 120, bg: '#ccc' } as Box);

function mount(initial: Box[] = [], o: { withActions?: boolean; withHistory?: boolean; withSize?: boolean } = {}): Fixture {
  const doc = dom.window.document;
  const viewEl = doc.createElement('div');
  const stageEl = doc.createElement('div');
  const canvasEl = doc.createElement('div');
  stageEl.appendChild(canvasEl);
  viewEl.appendChild(stageEl);
  doc.body.appendChild(viewEl);
  stageEl.getBoundingClientRect = () => rect(0, 0, STAGE, STAGE);
  canvasEl.getBoundingClientRect = () => rect(0, 0, STAGE, STAGE);

  const model = new Map<string, unknown>([['boxes', initial]]);
  const subs: Array<() => void> = [];
  const runtime = {
    getModel: () => [...model.entries()].map(([id, value]) => ({ id, value })),
    setInput(id: string, value: unknown) { model.set(id, value); for (const s of subs) s(); },
    subscribe(fn: () => void) { subs.push(fn); return () => { subs.splice(subs.indexOf(fn), 1); }; },
  };
  const calls: string[] = [];
  let histSync: ((u: boolean, r: boolean) => void) | null = null;
  const handle = initFreeCanvas({
    viewEl, stageEl, canvasEl,
    runtime: runtime as never,
    host: {} as never,
    input: { id: 'boxes', canvas: canvasCfg() as never, fields: [] },
    nativeW: STAGE, nativeH: STAGE,
    ...(o.withActions === false ? {} : {
      actions: {
        export: () => calls.push('export'),
        save: () => calls.push('save'),
        copy: () => calls.push('copy'),
        share: () => calls.push('share'),
      },
    }),
    ...(o.withHistory === false ? {} : {
      history: {
        undo: () => calls.push('undo'),
        redo: () => calls.push('redo'),
        register: (cb: (u: boolean, r: boolean) => void) => { histSync = cb; },
      },
    }),
    ...(o.withSize === false ? {} : { setCanvasSize: (w: number, h: number) => calls.push(`size:${w}x${h}`) }),
  } as never);
  frames();
  const dock = stageEl.querySelector<HTMLElement>('.fc-toolbar-dock')!;
  const rail = stageEl.querySelector<HTMLElement>('.fc-toolbar')!;
  // jsdom has no layout: give the rail a size so the clamp has something to work with.
  rail.getBoundingClientRect = () => {
    const l = parseFloat(dock.style.left || '0'), tp = parseFloat(dock.style.top || '0');
    return rect(l, tp, RAIL_W, RAIL_H);
  };
  return {
    stageEl, canvasEl, dock, rail, calls,
    setHistory(u, r) { histSync?.(u, r); },
    destroy() { handle.destroy(); viewEl.remove(); doc.body.innerHTML = ''; },
  };
}

const click = (el: Element): void => { el.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); };
const menuRow = (f: Fixture, key: string): HTMLButtonElement | null =>
  f.stageEl.querySelector<HTMLButtonElement>(`.fc-popover [data-pop="${key}"]`);
const openLollyMenu = (f: Fixture): void => {
  const trigger = f.rail.querySelector<HTMLButtonElement>('.fc-btn-lolly');
  assert.ok(trigger, 'the rail has a Lolly menu trigger');
  click(trigger!);
  frames();
};
/** Select a box the way a user would: a tap on it. */
function selectBox(f: Fixture, x: number, y: number): void {
  f.canvasEl.dispatchEvent(pointerEvent('pointerdown', { x, y }));
  f.canvasEl.dispatchEvent(pointerEvent('pointerup', { x, y }));
  frames();
}
/**
 * Drag the rail by its grip so its ORIGIN lands on (left, top). The grab point is
 * taken 2px inside the current origin, so the requested position is independent of
 * wherever the rail happens to be sitting (the position is module-level session
 * state, so a later test starts where the previous one dropped it).
 */
function dragRail(f: Fixture, left: number, top: number): void {
  const grip = f.rail.querySelector<HTMLElement>('.fc-grip');
  assert.ok(grip, 'the rail has a drag grip');
  const from = f.rail.getBoundingClientRect();
  grip!.dispatchEvent(pointerEvent('pointerdown', { x: from.left + 2, y: from.top + 2 }));
  f.rail.dispatchEvent(pointerEvent('pointermove', { x: left + 2, y: top + 2 }));
  frames();
  f.rail.dispatchEvent(pointerEvent('pointerup', { x: left + 2, y: top + 2 }));
  frames();
}

// ══ the clamp (pure) ══════════════════════════════════════════════════════════

test('clampRailPos keeps the rail inside the stage, padded on every edge', () => {
  const rail = { w: 60, h: 300 }, stage = { w: 1000, h: 800 };
  assert.deepEqual(clampRailPos({ left: 400, top: 200 }, rail, stage), { left: 400, top: 200 });
  assert.deepEqual(clampRailPos({ left: -50, top: -80 }, rail, stage), { left: 8, top: 8 });
  // Right/bottom: the far edge of the RAIL is what has to stay inside, not its origin.
  assert.deepEqual(clampRailPos({ left: 9999, top: 9999 }, rail, stage), { left: 932, top: 492 });
});

test('clampRailPos lifts the rail clear of a reserved bottom band (the export pill)', () => {
  const rail = { w: 60, h: 300 }, stage = { w: 1000, h: 800 };
  const free = clampRailPos({ left: 0, top: 9999 }, rail, stage).top;
  const reserved = clampRailPos({ left: 0, top: 9999 }, rail, stage, { reserveBottom: 120 }).top;
  assert.equal(free, 492);
  assert.equal(reserved, 372, 'the pill band comes off the travel range');
});

test('clampRailPos never returns a negative offset, even when the rail is taller than the stage', () => {
  const pos = clampRailPos({ left: 500, top: 500 }, { w: 60, h: 2000 }, { w: 300, h: 400 }, { reserveBottom: 200 });
  assert.deepEqual(pos, { left: 232, top: 8 }, 'an oversized rail parks at the padded top-left, not off-stage');
});

// ══ popover placement (the other half of "the rail moves") ═══════════════════

test('placePopover opens to the anchor\'s right while the rail is docked left', () => {
  const pos = placePopover({ left: 10, right: 54, top: 40 }, { w: 200, h: 260 }, { w: 960, h: 540 });
  assert.deepEqual(pos, { left: 62, top: 40 }, 'unchanged from the docked behaviour');
});

test('placePopover flips to the left once a dragged rail would push it off the stage', () => {
  // Rail dragged to the right edge: right-side placement would start at 902 and run
  // to 1102, well past a 960 stage that is overflow:hidden on the paged tools.
  const pos = placePopover({ left: 850, right: 894, top: 40 }, { w: 200, h: 260 }, { w: 960, h: 540 });
  assert.deepEqual(pos, { left: 642, top: 40 }, 'opens to the LEFT of the anchor instead');
});

test('placePopover pulls a tall menu up so its foot stays on the stage', () => {
  const pos = placePopover({ left: 10, right: 54, top: 480 }, { w: 200, h: 300 }, { w: 960, h: 540 });
  assert.equal(pos.top, 234, 'anchored top 480 + 300 tall would overflow 540; lifted to fit');
  assert.ok(pos.top + 300 <= 540 - 6, 'foot inside the padded stage');
});

test('placePopover keeps the anchored placement when the stage cannot be measured', () => {
  // jsdom has no layout, and a display:none stage measures zero in a real browser too - 
  // clamping against zeroes would slam every menu into the corner.
  const pos = placePopover({ left: 10, right: 54, top: 40 }, { w: 0, h: 0 }, { w: 0, h: 0 });
  assert.deepEqual(pos, { left: 62, top: 40 });
});

// ══ the Lolly menu ════════════════════════════════════════════════════════════

test('the Lolly mark leads the rail and is the only document-action affordance on it', () => {
  const f = mount([plainBox('a', 300, 300)]);
  const first = f.rail.querySelector('.fc-btn');
  assert.equal(first?.classList.contains('fc-btn-lolly'), true, 'the mark is the first button in the rail');
  assert.ok(first!.querySelector('svg'), 'it renders the Lolly glyph');
  assert.equal(first!.getAttribute('aria-haspopup'), 'menu');
  // The standalone export/save/undo/redo/size icons are gone from the rail itself.
  assert.equal(f.rail.querySelector('.fc-action-save'), null);
  assert.equal(f.rail.querySelector('.fc-history'), null);
  f.destroy();
});

test('the menu holds export, save, undo, redo, canvas size, copy, share', () => {
  const f = mount([plainBox('a', 300, 300)]);
  openLollyMenu(f);
  for (const key of ['export', 'save', 'undo', 'redo', 'size', 'copy', 'share']) {
    assert.ok(menuRow(f, key), `the menu offers "${key}"`);
  }
  f.destroy();
});

test('Export and Save in the menu run the tool\'s own handlers (the #render-fab indirection)', () => {
  const f = mount([plainBox('a', 300, 300)]);
  openLollyMenu(f);
  click(menuRow(f, 'export')!);
  frames();
  openLollyMenu(f);
  click(menuRow(f, 'save')!);
  frames();
  assert.deepEqual(f.calls, ['export', 'save'], 'both delegate to opts.actions, nothing is reimplemented');
  f.destroy();
});

test('Save is absent when the tool cannot save, and the menu still opens', () => {
  const f = mount([plainBox('a', 300, 300)]);
  f.destroy();
  // canSave:false is threaded through initFreeCanvas's actions; rebuild with it.
  const doc = dom.window.document;
  const viewEl = doc.createElement('div');
  const stageEl = doc.createElement('div');
  const canvasEl = doc.createElement('div');
  stageEl.appendChild(canvasEl); viewEl.appendChild(stageEl); doc.body.appendChild(viewEl);
  stageEl.getBoundingClientRect = () => rect(0, 0, STAGE, STAGE);
  canvasEl.getBoundingClientRect = () => rect(0, 0, STAGE, STAGE);
  const model = new Map<string, unknown>([['boxes', []]]);
  const handle = initFreeCanvas({
    viewEl, stageEl, canvasEl,
    runtime: {
      getModel: () => [...model.entries()].map(([id, value]) => ({ id, value })),
      setInput(id: string, v: unknown) { model.set(id, v); },
      subscribe: () => () => {},
    } as never,
    host: {} as never,
    input: { id: 'boxes', canvas: canvasCfg() as never, fields: [] },
    nativeW: STAGE, nativeH: STAGE,
    actions: { export() {}, save() {}, copy() {}, share() {}, canSave: false },
  } as never);
  frames();
  click(stageEl.querySelector<HTMLButtonElement>('.fc-btn-lolly')!);
  frames();
  assert.ok(stageEl.querySelector('.fc-popover [data-pop="export"]'), 'export is still there');
  assert.equal(stageEl.querySelector('.fc-popover [data-pop="save"]'), null, 'save is not');
  handle.destroy(); viewEl.remove(); doc.body.innerHTML = '';
});

// ══ undo / redo inside the menu ═══════════════════════════════════════════════

test('undo/redo reflect the history stack, live, and keep the menu open', () => {
  const f = mount([plainBox('a', 300, 300)]);
  f.setHistory(false, false);
  openLollyMenu(f);
  assert.equal(menuRow(f, 'undo')!.disabled, true, 'nothing to undo at the bottom of the stack');
  assert.equal(menuRow(f, 'redo')!.disabled, true);
  // The shell's registered callback must reach the OPEN menu, not just the next open.
  f.setHistory(true, false);
  assert.equal(menuRow(f, 'undo')!.disabled, false, 'the open menu follows the stack');
  assert.equal(menuRow(f, 'redo')!.disabled, true);
  click(menuRow(f, 'undo')!);
  frames();
  assert.deepEqual(f.calls, ['undo']);
  assert.ok(menuRow(f, 'undo'), 'the menu stays open so you can step back again');
  f.setHistory(false, true);
  assert.equal(menuRow(f, 'undo')!.disabled, true);
  assert.equal(menuRow(f, 'redo')!.disabled, false);
  click(menuRow(f, 'redo')!);
  frames();
  assert.deepEqual(f.calls, ['undo', 'redo']);
  f.destroy();
});

test('a disabled undo/redo row does nothing', () => {
  const f = mount([plainBox('a', 300, 300)]);
  f.setHistory(false, false);
  openLollyMenu(f);
  click(menuRow(f, 'undo')!);
  click(menuRow(f, 'redo')!);
  frames();
  assert.deepEqual(f.calls, []);
  f.destroy();
});

// ══ the selection gate ════════════════════════════════════════════════════════

test('the layout options appear only while something is selected', () => {
  const f = mount([plainBox('a', 300, 300)]);
  const arrange = f.rail.querySelector<HTMLButtonElement>('.fc-btn[aria-label^="Arrange"]');
  assert.ok(arrange, 'the rail has an Arrange button');
  assert.equal(arrange!.hidden, true, 'hidden with an empty selection');
  selectBox(f, 360, 360);
  assert.equal(arrange!.hidden, false, 'revealed by a selection');
  // Deselect (a tap on empty canvas).
  selectBox(f, 900, 900);
  assert.equal(arrange!.hidden, true, 'hidden again once the selection is dropped');
  f.destroy();
});

test('the right-click menu still offers the layout actions with nothing selected', () => {
  const f = mount([plainBox('a', 300, 300)]);
  f.canvasEl.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 900 }));
  frames();
  const pop = f.stageEl.querySelector('.fc-popover');
  assert.ok(pop, 'the context menu opens on empty canvas');
  assert.ok(pop!.querySelector('[aria-label="Bring to front"]'), 'the ordering actions are still reachable (disabled)');
  f.destroy();
});

// ══ the drag ══════════════════════════════════════════════════════════════════

test('dragging the grip moves the rail with left/top — never a transform', () => {
  const f = mount([plainBox('a', 300, 300)]);
  assert.equal(f.dock.classList.contains('is-detached'), false, 'docked until dragged');
  dragRail(f, 300, 120);
  assert.equal(f.dock.classList.contains('is-detached'), true);
  assert.equal(f.dock.style.left, '300px');
  assert.equal(f.dock.style.top, '120px');
  // The regression guard: a transform on either the dock or the rail captures the
  // colour popover's position:fixed and throws it off-screen.
  assert.equal(f.dock.style.transform, '');
  assert.equal(f.rail.style.transform, '');
  assert.equal(f.dock.classList.contains('is-dragging'), false, 'the dragging class is cleared on release');
  f.destroy();
});

test('the drag clamps to the stage', () => {
  const f = mount([plainBox('a', 300, 300)]);
  dragRail(f, 5000, 5000);
  assert.equal(f.dock.style.left, `${STAGE - RAIL_W - 8}px`);
  assert.equal(f.dock.style.top, `${STAGE - RAIL_H - 8}px`);
  dragRail(f, -500, -500);
  assert.equal(f.dock.style.left, '8px');
  assert.equal(f.dock.style.top, '8px');
  f.destroy();
});

test('a click on a tool button never starts a drag', () => {
  const f = mount([plainBox('a', 300, 300)]);
  const before = { left: f.dock.style.left, top: f.dock.style.top };
  const pointer = f.rail.querySelector<HTMLElement>('.fc-btn-pointer')!;
  pointer.dispatchEvent(pointerEvent('pointerdown', { x: 20, y: 400 }));
  f.rail.dispatchEvent(pointerEvent('pointermove', { x: 400, y: 400 }));
  frames();
  assert.equal(f.dock.style.left, before.left, 'the rail stayed put');
  assert.equal(f.dock.style.top, before.top);
  assert.equal(f.dock.classList.contains('is-dragging'), false);
  f.destroy();
});

test('the dragged position is remembered for the session and re-clamped on the next mount', () => {
  const a = mount([plainBox('a', 300, 300)]);
  dragRail(a, 400, 240);
  assert.equal(a.dock.style.left, '400px');
  a.destroy();
  const b = mount([plainBox('a', 300, 300)]);
  assert.equal(b.dock.classList.contains('is-detached'), true, 'the next editor opens where the rail was left');
  assert.equal(b.dock.style.left, '400px');
  assert.equal(b.dock.style.top, '240px');
  // Chrome state only: nothing about the rail reaches the box model or the canvas.
  assert.equal(b.canvasEl.outerHTML.includes('fc-toolbar'), false);
  b.destroy();
});

test('a lost pointer capture ends the drag instead of gluing the rail to the cursor', () => {
  // Losing capture fires NEITHER pointerup nor pointercancel - the export shutter sets
  // `pointer-events: none` on the rail mid-drag, which releases capture implicitly. Before
  // this was handled the drag state stuck: `.is-dragging` stayed on, a bare HOVER kept
  // sliding the rail, and onRailDown refused to start a new drag ever again.
  const f = mount([plainBox('a', 300, 300)]);
  const grip = f.rail.querySelector<HTMLElement>('.fc-grip')!;
  grip.dispatchEvent(pointerEvent('pointerdown', { x: 10, y: 10 }));
  f.rail.dispatchEvent(pointerEvent('pointermove', { x: 300, y: 200 }));
  frames();
  assert.equal(f.dock.classList.contains('is-dragging'), true, 'precondition: dragging');

  f.rail.dispatchEvent(pointerEvent('lostpointercapture', { x: 300, y: 200, buttons: 0 }));
  assert.equal(f.dock.classList.contains('is-dragging'), false, 'the drag is over');

  // A hover afterwards must not move anything.
  const parked = { left: f.dock.style.left, top: f.dock.style.top };
  f.rail.dispatchEvent(pointerEvent('pointermove', { x: 700, y: 600, buttons: 0 }));
  frames();
  assert.deepEqual({ left: f.dock.style.left, top: f.dock.style.top }, parked, 'hovering does not drag');

  // And a fresh drag still works, which the stuck state made impossible.
  dragRail(f, 120, 90);
  assert.equal(f.dock.style.left, '120px');
  assert.equal(f.dock.style.top, '90px');
  f.destroy();
});

test('a bare move with no button held finishes a drag whose pointerup went missing', () => {
  const f = mount([plainBox('a', 300, 300)]);
  const grip = f.rail.querySelector<HTMLElement>('.fc-grip')!;
  grip.dispatchEvent(pointerEvent('pointerdown', { x: 10, y: 10 }));
  f.rail.dispatchEvent(pointerEvent('pointermove', { x: 200, y: 150 }));
  frames();
  f.rail.dispatchEvent(pointerEvent('pointermove', { x: 640, y: 480, buttons: 0 }));
  frames();
  assert.equal(f.dock.classList.contains('is-dragging'), false);
  assert.notEqual(f.dock.style.left, '640px', 'the buttonless move did not reposition the rail');
  f.destroy();
});

test('clampRailPos hands back the wanted position when the stage cannot be measured', () => {
  // A ResizeObserver's first delivery on a not-yet-laid-out stage, or a stage that has gone
  // display:none on navigation, measures 0×0. Clamping against that would collapse every
  // axis to the pad and silently teleport the rail to the top-left corner, losing the
  // position the user dragged it to.
  const pos = clampRailPos({ left: 420, top: 260 }, { w: 54, h: 300 }, { w: 0, h: 0 });
  assert.deepEqual(pos, { left: 420, top: 260 });
});

test('the rail keeps clear of the docked timeline panel, not just the export pill', () => {
  // The panel is z-index 22 with pointer-events:auto against the dock's 16, so a rail
  // dragged under it is both invisible (the rail is opacity:0 at rest) and unclickable - 
  // and the position survives a tool switch with no way to recover it.
  const f = mount([plainBox('a', 300, 300)]);
  const panel = f.stageEl.ownerDocument.createElement('div');
  panel.className = 'tl-panel';
  const BAND = 220;
  panel.getBoundingClientRect = (() => ({
    left: 0, top: STAGE - BAND, right: STAGE, bottom: STAGE, width: STAGE, height: BAND, x: 0, y: STAGE - BAND,
    toJSON: () => ({}),
  })) as never;
  panel.getClientRects = (() => ({ length: 1 })) as never;
  f.stageEl.appendChild(panel);

  dragRail(f, 400, 5000);
  const top = parseFloat(f.dock.style.top);
  assert.ok(top + RAIL_H <= STAGE - BAND, `the rail's foot (${top + RAIL_H}) stays above the panel band`);
  f.destroy();
});

test('the rail restates [hidden] — the views layer would otherwise beat base.css', () => {
  // base.css's `[hidden]{display:none}` lives in the `base` cascade layer; editor.css is
  // wrapped in `views`, which WINS on layer order no matter the specificity. Without this
  // restatement `.fc-btn`'s own `display: inline-flex` survives and a hidden button keeps
  // its 40px box: only `visibility: hidden` applies, leaving an invisible dead hole in the
  // palette. jsdom applies no stylesheet, so the rule itself is what gets asserted.
  const css = readFileSync(new URL('../styles/parts/editor.css', import.meta.url), 'utf8');
  assert.match(css, /\.fc-btn\[hidden\]\s*\{[^}]*display:\s*none/,
    'editor.css must declare .fc-btn[hidden] { display: none }');
});
