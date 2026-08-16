// SPDX-License-Identifier: MPL-2.0
/**
 * The canvas editor's TOOL MODE - the pointer tool, mutual exclusion between the modes, and
 * the Escape ladder.
 *
 * The bug this file locks down was never the missing Pointer button on its own: the modes
 * used to be four independent booleans, so "enter pen" and "leave connect" were unrelated
 * events and nothing in the code said they could not both be true. So the exclusion
 * assertions here are exhaustive over the ORDERED PAIRS rather than sampled - a one-way
 * check is exactly what let `armConnect` keep the pen armed.
 *
 * The fourth mode in the matrix is the LINE tool as of plan 96 P2. Connect lost its rail
 * button there (one primitive, one way in - a line is a path box now, and P3 binds it by
 * dragging an endpoint onto a box), and a mode with no way in cannot be driven "the way a
 * user would". Line took its place rather than the matrix shrinking to three: the exclusion
 * claim is about the modes a tool actually offers at once, and Line is one of them.
 *
 * Everything is driven through real DOM events against the real `initFreeCanvas`, on the
 * jsdom harness free-canvas-pen.test.ts established: an in-memory runtime that echoes
 * `setInput` back through `getModel`, so a "the model did not change" claim is a round trip
 * and not a stub.
 *
 * Run directly:  node --test shells/web/src/views/free-canvas-tools.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { encodeAuthoredPath, decodeAuthoredPath, type SplineNode } from '@lolly/engine';
import type { Box } from './free-canvas-math.ts';
import { initFreeCanvas } from './free-canvas.ts';

// ── jsdom bootstrap (same shape as free-canvas-pen.test.ts) ───────────────────
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

function pointerEvent(
  type: string,
  o: { x: number; y: number; id?: number; pointerType?: string; time?: number; alt?: boolean; shift?: boolean },
): MouseEvent {
  const e = new W.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: o.x, clientY: o.y, button: 0,
    altKey: !!o.alt, shiftKey: !!o.shift,
  });
  Object.defineProperty(e, 'pointerId', { value: o.id ?? 1 });
  Object.defineProperty(e, 'pointerType', { value: o.pointerType ?? 'mouse' });
  Object.defineProperty(e, 'timeStamp', { value: o.time ?? 0 });
  Object.defineProperty(e, 'buttons', { value: type === 'pointermove' ? 1 : 0 });
  return e;
}

// ── fixture ───────────────────────────────────────────────────────────────────

const NATIVE = 1000;

/** Design's canvas block plus Org Chart's `connect` block, so ONE fixture can be put
 *  into all four modes AND still carry the connector input the Auto-arrange button reads.
 *  Every mode is opt-in on a config key, and the exclusion claim is about the modes a tool
 *  actually offers at once. */
function canvasCfg(): Record<string, unknown> {
  return {
    idField: 'id', xField: 'x', yField: 'y', wField: 'w', hField: 'h', rotationField: 'rot',
    fillField: 'bg', opacityField: 'opacity', shapeField: 'shape', radiusField: 'radius',
    textField: 'text', groupField: 'group', clipField: 'clip',
    pathField: 'path',
    // The plan 96 path decorations, exactly as both Design manifests declare them.
    // They are DECLARED rather than defaulted: the editor only authors a head or a binding
    // into a tool whose manifest named the field, so a fixture that omits them would be
    // testing Sequence Studio's version of the feature, not Design's.
    headStartField: 'headStart', headEndField: 'headEnd',
    bindStartField: 'bindStart', bindEndField: 'bindEnd',
    strokeDashArrayField: 'strokeDashArray', dashFitField: 'dashFit',
    connect: { input: 'edges', fromField: 'from', toField: 'to' },
    addKinds: [
      { id: 'box', label: 'Box', seed: {} },
      { id: 'path', label: 'Path', seed: { kind: 'path', shape: 'rect', bg: '', stroke: '#0e1217', strokeW: 4, fillRule: 'nonzero' } },
    ],
  };
}

interface Fixture {
  stageEl: HTMLElement;
  canvasEl: HTMLElement;
  boxes(): Box[];
  edges(): Box[];
  commits: () => number;
  sync(): void;
  destroy(): void;
}

function mount(initial: Box[]): Fixture {
  const viewEl = dom.window.document.createElement('div');
  const stageEl = dom.window.document.createElement('div');
  const canvasEl = dom.window.document.createElement('div');
  stageEl.appendChild(canvasEl);
  viewEl.appendChild(stageEl);
  dom.window.document.body.appendChild(viewEl);
  canvasEl.style.width = NATIVE + 'px';
  canvasEl.style.height = NATIVE + 'px';
  stageEl.getBoundingClientRect = () => rect(0, 0, NATIVE, NATIVE);
  canvasEl.getBoundingClientRect = () => rect(0, 0, NATIVE, NATIVE);

  const model = new Map<string, unknown>([['boxes', initial], ['edges', []]]);
  let commits = 0;
  const subs: Array<() => void> = [];
  const runtime = {
    getModel: () => [...model.entries()].map(([id, value]) => ({ id, value })),
    setInput(id: string, value: unknown) { model.set(id, value); commits++; for (const s of subs) s(); },
    subscribe(fn: () => void) { subs.push(fn); return () => { subs.splice(subs.indexOf(fn), 1); }; },
  };
  const handle = initFreeCanvas({
    viewEl, stageEl, canvasEl,
    runtime: runtime as never,
    host: {} as never,
    input: { id: 'boxes', canvas: canvasCfg() as never, fields: [] },
    nativeW: NATIVE, nativeH: NATIVE,
  });
  frames();
  return {
    stageEl, canvasEl,
    boxes: () => model.get('boxes') as Box[],
    edges: () => model.get('edges') as Box[],
    commits: () => commits,
    sync() { for (const s of subs) s(); frames(); },
    destroy() { handle.destroy(); viewEl.remove(); dom.window.document.body.innerHTML = ''; },
  };
}

const click = (el: Element): void => { el.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); };
const key = (
  k: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): void => {
  dom.window.dispatchEvent(new W.KeyboardEvent('keydown', {
    key: k, bubbles: true, cancelable: true,
    metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt,
  }));
};

const btn = (f: Fixture, cls: string): HTMLButtonElement => {
  const b = f.stageEl.querySelector<HTMLButtonElement>('.' + cls);
  assert.ok(b, `the rail has a .${cls} button`);
  return b!;
};
const pressed = (b: HTMLButtonElement): boolean => b.getAttribute('aria-pressed') === 'true';
const armed = (b: HTMLButtonElement): boolean => b.classList.contains('is-armed');

/** One node placed on the canvas: down, optional drag, up. */
function place(f: Fixture, x: number, y: number, o: { drag?: [number, number]; pointerType?: string } = {}): void {
  const pt = o.pointerType ?? 'mouse';
  f.canvasEl.dispatchEvent(pointerEvent('pointerdown', { x, y, pointerType: pt }));
  if (o.drag) f.canvasEl.dispatchEvent(pointerEvent('pointermove', { x: o.drag[0], y: o.drag[1], pointerType: pt }));
  const end = o.drag ?? [x, y];
  f.canvasEl.dispatchEvent(pointerEvent('pointerup', { x: end[0], y: end[1], pointerType: pt }));
  frames();
}
const dblClick = (f: Fixture, x: number, y: number): void => {
  f.canvasEl.dispatchEvent(new W.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  frames();
};

/** A path box whose curve passes near (400, 480) - the double-click target for node edit. */
function pathBox(o: { id?: string } = {}): Box {
  const nodes: SplineNode[] = [
    { x: 0, y: 1, hOutX: 0.2, hOutY: -0.4, continuity: 'corner' },
    { x: 0.5, y: 0, hInX: -0.2, hInY: 0, hOutX: 0.2, hOutY: 0, continuity: 'smooth' },
    { x: 1, y: 1, hInX: -0.2, hInY: -0.4, continuity: 'corner' },
  ];
  return {
    kind: 'path', shape: 'rect', id: o.id ?? 'p1', bg: '', stroke: '#000', strokeW: 2, fillRule: 'nonzero',
    x: 300, y: 300, w: 200, h: 200, rot: 0,
    path: encodeAuthoredPath({ kind: 'cubic', closed: false, nodes }),
  } as Box;
}
const plainBox = (id: string, x: number, y: number): Box =>
  ({ kind: 'box', shape: 'rect', id, x, y, w: 120, h: 120, bg: '#ccc' } as Box);

// ── mode entry helpers ────────────────────────────────────────────────────────

const MODES = ['select', 'create', 'pen', 'line'] as const;
type Mode = typeof MODES[number];

/** Put the editor into `m` the way a user would: through the rail. */
function enter(f: Fixture, m: Mode): void {
  if (m === 'select') { click(btn(f, 'fc-btn-pointer')); frames(); return; }
  if (m === 'pen') { click(btn(f, 'fc-btn-pen')); frames(); return; }
  if (m === 'line') { click(btn(f, 'fc-btn-line')); frames(); return; }
  // Create: the Add button opens a menu of kinds; the first item arms that kind.
  click(btn(f, 'fc-btn-add'));
  frames();
  const item = f.stageEl.querySelector<HTMLButtonElement>('.fc-pop-item, .fc-pop-gitem');
  assert.ok(item, 'the Add menu offers at least one kind');
  click(item!);
  frames();
}

/** The mode as the STAGE reports it - the classes the CSS and the cursor key off, read back
 *  independently of the rail so a passing rail cannot cover for stale stage state. */
function stageMode(f: Fixture): Mode {
  const c = f.stageEl.classList;
  const on: Mode[] = [];
  if (c.contains('fc-arming')) on.push('create');
  if (c.contains('fc-penning')) on.push('pen');
  if (c.contains('fc-lining')) on.push('line');
  assert.ok(on.length <= 1, `the stage claims to be in ${on.length} modes at once: ${on.join(' + ')}`);
  return on[0] ?? 'select';
}

/** The rail as the USER reads it: exactly one mode button pressed, and it is `m`. */
function railMode(f: Fixture): Mode {
  const map: Array<[Mode, string]> = [
    ['select', 'fc-btn-pointer'], ['create', 'fc-btn-add'], ['pen', 'fc-btn-pen'], ['line', 'fc-btn-line'],
  ];
  const on = map.filter(([, cls]) => pressed(btn(f, cls))).map(([m]) => m);
  assert.equal(on.length, 1, `exactly one mode button is pressed, not ${on.length} (${on.join(' + ')})`);
  for (const [m, cls] of map) assert.equal(armed(btn(f, cls)), on[0] === m, `.is-armed tracks aria-pressed on .${cls}`);
  return on[0]!;
}

const assertMode = (f: Fixture, m: Mode, why = ''): void => {
  assert.equal(railMode(f), m, `${why}: the rail shows ${m}`);
  assert.equal(stageMode(f), m, `${why}: the stage is in ${m}`);
};

const nodeEditing = (f: Fixture): boolean => f.stageEl.classList.contains('fc-node-editing');
const penNodes = (f: Fixture): number => f.stageEl.querySelectorAll('.fc-pen-node').length;
const selectionCount = (f: Fixture): number => f.stageEl.querySelectorAll('.fc-chrome .fc-outline').length;

/** Enter node editing on the path box by double-clicking its curve. */
function enterNodeEdit(f: Fixture): void {
  place(f, 400, 480);
  dblClick(f, 400, 480);
  assert.ok(nodeEditing(f), 'node-edit mode is on');
}

// ══ the pointer tool ══════════════════════════════════════════════════════════

test('the rail leads with a Pointer tool, active on mount', () => {
  const f = mount([plainBox('a', 700, 700)]);
  const first = f.stageEl.querySelector('.fc-toolbar .fc-btn:not(.fc-action):not(.fc-hist-btn)');
  assert.equal(first?.classList.contains('fc-btn-pointer'), true, 'Pointer is the first tool in the rail');
  assertMode(f, 'select', 'on mount');
  f.destroy();
});

test('entering any mode exits every other one (all ordered pairs)', () => {
  for (const from of MODES) {
    for (const to of MODES) {
      if (from === to) continue;
      const f = mount([plainBox('a', 700, 700)]);
      enter(f, from);
      assertMode(f, from, `entered ${from}`);
      enter(f, to);
      assertMode(f, to, `${from} → ${to}`);
      f.destroy();
    }
  }
});

test('Pointer exits node editing too, and node editing keeps the rail on Pointer', () => {
  const f = mount([pathBox()]);
  enterNodeEdit(f);
  assertMode(f, 'select', 'node editing is a sub-state of the pointer, not a fifth mode');
  click(btn(f, 'fc-btn-pointer'));
  frames();
  assert.equal(nodeEditing(f), false, 'Pointer left node editing');
  assert.equal(penNodes(f), 0, 'and its node chrome is gone');
  f.destroy();
});

test('entering pen or the line tool from node editing leaves node editing', () => {
  for (const to of ['pen', 'line'] as const) {
    const f = mount([pathBox()]);
    enterNodeEdit(f);
    enter(f, to);
    assert.equal(nodeEditing(f), false, `entering ${to} left node editing`);
    assertMode(f, to);
    f.destroy();
  }
});

test('clicking Pointer mid-draw FINISHES the path (a tool switch commits, unlike Escape)', () => {
  const f = mount([plainBox('a', 700, 700)]);
  enter(f, 'pen');
  for (const [x, y] of [[100, 100], [200, 160], [300, 100]] as Array<[number, number]>) place(f, x, y);
  const commits = f.commits();
  click(btn(f, 'fc-btn-pointer'));
  frames();
  assert.equal(f.commits() - commits, 1, 'the draft committed, in one step');
  assert.equal(f.boxes().filter((b) => b.kind === 'path').length, 1, 'and it is a path box');
  assertMode(f, 'select');
  f.destroy();
});

test('clicking Pointer after ONE node discards it — a single click is a mis-click', () => {
  const f = mount([plainBox('a', 700, 700)]);
  const before = structuredClone(f.boxes());
  enter(f, 'pen');
  place(f, 100, 100);
  const commits = f.commits();
  click(btn(f, 'fc-btn-pointer'));
  frames();
  assert.equal(f.commits(), commits, 'nothing committed');
  assert.deepEqual(f.boxes(), before, 'the model is what it was');
  assertMode(f, 'select');
  f.destroy();
});

// ══ Escape ════════════════════════════════════════════════════════════════════

test('Escape ends node editing, returns to Pointer, and changes nothing in the model', () => {
  const f = mount([pathBox()]);
  const before = structuredClone(f.boxes());
  enterNodeEdit(f);
  const commits = f.commits();
  key('Escape');
  frames();
  assert.equal(nodeEditing(f), false, 'Escape left node editing');
  assert.equal(penNodes(f), 0);
  assertMode(f, 'select');
  assert.equal(f.commits(), commits, 'and committed nothing');
  assert.deepEqual(f.boxes(), before, 'the model is deep-equal');
  f.destroy();
});

test('Escape in node editing still works after the object bar has opened a panel', () => {
  // The reported defect: `morePanel` is the innermost rung of the ladder, and a panel that
  // went away by any route OTHER than closeMorePanel left the variable pointing at a
  // detached element - after which every Escape was eaten by the popover rung and the pen
  // never saw the key.
  const f = mount([pathBox()]);
  enterNodeEdit(f);
  const stroke = f.stageEl.querySelector<HTMLElement>('.fc-ctxbar [data-cx="stroke"]');
  assert.ok(stroke, 'node editing shows the path paint controls, stroke among them');
  click(stroke!);
  frames();
  assert.ok(f.stageEl.querySelector('.fc-panel'), 'the stroke panel is open');
  // Something else tears the panel out of the DOM - a re-render, a view swap, anything that
  // is not the overlay's own dismissal path.
  f.stageEl.querySelector('.fc-panel')!.remove();
  key('Escape');
  frames();
  assert.equal(nodeEditing(f), false, 'Escape still reaches the pen');
  assertMode(f, 'select');
  f.destroy();
});

test('the Escape ladder: panel, then the mode, then the selection', () => {
  const f = mount([pathBox()]);
  enterNodeEdit(f);
  const stroke = f.stageEl.querySelector<HTMLElement>('.fc-ctxbar [data-cx="stroke"]')!;
  click(stroke);
  frames();
  assert.ok(f.stageEl.querySelector('.fc-panel'), 'a panel is open');

  key('Escape');
  frames();
  assert.equal(f.stageEl.querySelector('.fc-panel'), null, 'press 1 closed only the panel');
  assert.equal(nodeEditing(f), true, 'and stayed in node editing');

  key('Escape');
  frames();
  assert.equal(nodeEditing(f), false, 'press 2 left the mode');
  assertMode(f, 'select');
  assert.ok(selectionCount(f) > 0, 'and the box is still selected');

  key('Escape');
  frames();
  assert.equal(selectionCount(f), 0, 'press 3 cleared the selection');
  f.destroy();
});

test('the same ladder holds for the line tool and for armed create', () => {
  for (const m of ['line', 'create'] as const) {
    const f = mount([plainBox('a', 700, 700)]);
    place(f, 760, 760);                       // a selection to be cleared at the end
    assert.ok(selectionCount(f) > 0, 'a box is selected');
    enter(f, m);
    key('Escape');
    frames();
    assertMode(f, 'select', `Escape left ${m}`);
    key('Escape');
    frames();
    assert.equal(selectionCount(f), 0, 'a further Escape clears the selection');
    f.destroy();
  }
});

test('Escape mid-draw cancels the path but stays in pen mode; a second Escape leaves it', () => {
  const f = mount([plainBox('a', 700, 700)]);
  const before = structuredClone(f.boxes());
  enter(f, 'pen');
  for (const [x, y] of [[100, 100], [200, 160], [300, 100]] as Array<[number, number]>) place(f, x, y);
  key('Escape');
  frames();
  assert.deepEqual(f.boxes(), before, 'Escape committed nothing — this is the half that must NOT commit');
  assertMode(f, 'pen', 'the tool is still the pen, ready for the next path');
  key('Escape');
  frames();
  assertMode(f, 'select', 'and a second Escape puts the pointer back');
  f.destroy();
});

// ══ keyboard ══════════════════════════════════════════════════════════════════

test('V and P switch tools', () => {
  const f = mount([plainBox('a', 700, 700)]);
  key('p');
  frames();
  assertMode(f, 'pen', 'p armed the pen');
  key('v');
  frames();
  assertMode(f, 'select', 'v put the pointer back');
  key('P');
  frames();
  assertMode(f, 'pen', 'the capital works too (Shift-P is the same tool)');
  key('V');
  frames();
  assertMode(f, 'select');
  f.destroy();
});

test('V and P are inert with a modifier held', () => {
  for (const mods of [{ meta: true }, { ctrl: true }, { alt: true }]) {
    const f = mount([plainBox('a', 700, 700)]);
    key('p', mods);
    frames();
    assertMode(f, 'select', `p+${Object.keys(mods)[0]} is not the pen shortcut`);
    f.destroy();
  }
});

test('V and P are inert while focus is in a field, and while a text edit is live', () => {
  const f = mount([plainBox('a', 700, 700)]);
  const input = dom.window.document.createElement('input');
  dom.window.document.body.appendChild(input);
  input.focus();
  key('p');
  frames();
  assertMode(f, 'select', 'typing "p" into a field does not arm the pen');
  input.blur();
  input.remove();

  // A live inline text edit is a focused contenteditable inside the canvas (the tool owns
  // the .lolly-box elements, which this harness does not render, so the editable stands in
  // for it - `typingTarget()` reads `isContentEditable`, which is the whole test).
  const ed = dom.window.document.createElement('div');
  ed.contentEditable = 'true';
  ed.tabIndex = 0;                          // jsdom only focuses a focusable area
  Object.defineProperty(ed, 'isContentEditable', { value: true });
  f.canvasEl.appendChild(ed);
  ed.focus();
  key('p');
  frames();
  assertMode(f, 'select', 'and typing "p" into a live text edit does not arm the pen');
  f.destroy();
});

// ══ the rail is built once ════════════════════════════════════════════════════

test('the active state survives a model sync and a pan/zoom, without rebuilding the rail', () => {
  const f = mount([plainBox('a', 700, 700)]);
  enter(f, 'pen');
  const pointer = btn(f, 'fc-btn-pointer');
  const pen = btn(f, 'fc-btn-pen');
  f.sync();
  f.stageEl.dispatchEvent(new W.MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
  f.stageEl.dispatchEvent(new dom.window.Event('wheel', { bubbles: true }));
  frames(4);
  assert.equal(btn(f, 'fc-btn-pointer'), pointer, 'the Pointer button is the SAME element — no rebuild per frame');
  assert.equal(btn(f, 'fc-btn-pen'), pen, 'nor is the Pen button');
  assertMode(f, 'pen', 'and the mode still reads as pen');
  f.destroy();
});

// ══ touch ═════════════════════════════════════════════════════════════════════

test('the mode buttons work from a touch pointer, and pen mode leaves the two-finger tap alone', () => {
  const f = mount([pathBox()]);
  const pen = btn(f, 'fc-btn-pen');
  pen.dispatchEvent(pointerEvent('pointerdown', { x: 20, y: 100, pointerType: 'touch' }));
  click(pen);
  frames();
  assertMode(f, 'pen', 'a touch tap arms the pen');

  // Two-finger tap on the stage → the context menu, exactly as it does in select mode.
  // (Capture-phase recogniser on stageEl; see the pen handoff note.)
  f.stageEl.dispatchEvent(pointerEvent('pointerdown', { x: 400, y: 480, id: 1, pointerType: 'touch', time: 0 }));
  f.stageEl.dispatchEvent(pointerEvent('pointerdown', { x: 430, y: 500, id: 2, pointerType: 'touch', time: 20 }));
  f.stageEl.dispatchEvent(pointerEvent('pointerup', { x: 400, y: 480, id: 1, pointerType: 'touch', time: 120 }));
  f.stageEl.dispatchEvent(pointerEvent('pointerup', { x: 430, y: 500, id: 2, pointerType: 'touch', time: 140 }));
  frames();
  assert.ok(f.stageEl.querySelector('.fc-popover'), 'the two-finger tap still opens the context menu in pen mode');
  f.destroy();
});

// ══ the Line tool (plan 96 P2) ════════════════════════════════════════════════
//
// The line USED to write a row into the `connectors` blocks input - an edge with no nodes,
// which is why it could not be node-edited or given a spline kind. It writes a path box
// now, through the same `commitPathBox` the pen commits through. These pin the switch: the
// connectors input must stay untouched, and what lands must be a real authored path.

test('the Line tool draws a PATH BOX, not a connector edge', () => {
  const f = mount([plainBox('a', 700, 700)]);
  enter(f, 'line');
  const before = f.commits();
  place(f, 120, 140, { drag: [420, 300] });
  assert.equal(f.commits() - before, 1, 'one drag, one commit — one undo step');
  assert.equal(f.edges().length, 0, 'the connectors input is not written to at all');
  const made = f.boxes().filter((b) => b.kind === 'path');
  assert.equal(made.length, 1, 'exactly one path box');
  const path = decodeAuthoredPath(String(made[0]!.path));
  assert.equal(path?.kind, 'line', 'a straight-segment spline');
  assert.equal(path?.nodes.length, 2, 'with two nodes');
  assert.equal(path?.closed, false);
  assertMode(f, 'select', 'and the tool hands back to the pointer');
  f.destroy();
});

test('a line carries the decoration fields: an end arrowhead and two empty bindings', () => {
  const f = mount([plainBox('a', 700, 700)]);
  enter(f, 'line');
  place(f, 120, 140, { drag: [420, 300] });
  const made = f.boxes().filter((b) => b.kind === 'path')[0]!;
  assert.equal(made.headEnd, 'triangle', 'a line points at something by default');
  assert.equal(made.headStart, 'none');
  assert.equal(made.bindStart, '', 'a free end is an EMPTY binding, not an absent field');
  assert.equal(made.bindEnd, '');
  f.destroy();
});

test('a Line tap (no drag) commits nothing — a mis-click leaves no invisible box', () => {
  const f = mount([plainBox('a', 700, 700)]);
  const before = structuredClone(f.boxes());
  enter(f, 'line');
  const commits = f.commits();
  place(f, 200, 200);
  assert.equal(f.commits(), commits, 'nothing committed');
  assert.deepEqual(f.boxes(), before, 'the model is what it was');
  f.destroy();
});

test('the retired Connect button is gone from the rail, and its mode with it', () => {
  const f = mount([plainBox('a', 700, 700)]);
  assert.equal(f.stageEl.querySelector('.fc-btn-connect'), null, 'no Connect tool in the rail');
  assert.equal(f.stageEl.classList.contains('fc-connecting'), false, 'and nothing can be in it');
  // The Line tool took its place next to the Pen - both are the one path primitive.
  assert.ok(f.stageEl.querySelector('.fc-btn-line'), 'the Line tool is there');
  assert.ok(f.stageEl.querySelector('.fc-btn-pen'), 'beside the Pen');
  f.destroy();
});
