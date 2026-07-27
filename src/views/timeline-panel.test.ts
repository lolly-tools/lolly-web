// SPDX-License-Identifier: MPL-2.0
/**
 * timeline-panel tests.
 *
 * Two layers, both reachable without a browser:
 *
 *   • the PURE viewport model — seconds ↔ pixels at a zoom and a scroll, the
 *     zoom-about-cursor anchor, the rebuild-vs-restyle memo key, snap candidates,
 *     seam detection, the keyboard containment predicate, and the ruler/filmstrip
 *     density heuristics. These are the functions every gesture is built out of, so
 *     a regression here is a whole class of "the clip lands in the wrong place".
 *
 *   • the CONTROLLER against a jsdom stage, driven through real pointer events, to
 *     pin the one invariant the whole editing model rests on: a drag writes the
 *     model EXACTLY ONCE, on pointerup, never per frame.
 *
 * The panel is driven through its real DOM and its real opts. Nothing here asserts
 * on a mock: `commit` is a recorder because it is the module's output, and what is
 * checked is the resulting Box[], not that a function was called.
 *
 * NOT covered here (browser-only): filmstrip/waveform painting (canvas 2D + real
 * decode), layout-derived geometry (jsdom reports 0 for every rect, so the tests
 * below stub the two rects the gesture math reads), the ResizeObserver refit, the
 * <dialog> junction modal, and anything the sequence clock does with real media.
 *
 * Run directly:  node --test shells/web/src/views/timeline-panel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
// Type-only, so it costs nothing at runtime and needs no CSS stub.
import type { Box } from './timeline-math.ts';

// timeline-panel.ts imports its own stylesheet (the self-registering lazy-view
// pattern). Node has no idea what a .css module is, so stub it in-thread for the
// duration of this file — Vite is what resolves it for real.
registerHooks({
  load(url: string, ctx: unknown, next: (u: string, c: unknown) => unknown) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {};' };
    return next(url, ctx);
  },
} as Parameters<typeof registerHooks>[0]);

// `pretendToBeVisual` is what gives jsdom a requestAnimationFrame at all — the panel
// rAF-coalesces its drag painting, and without it every pointermove throws.
const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'getComputedStyle']) {
  (globalThis as Record<string, unknown>)[k] = (dom.window as unknown as Record<string, unknown>)[k];
}
// Bound, not copied: these are window methods and lose `this` when lifted bare.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => dom.window.requestAnimationFrame(cb)) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((h: number) => dom.window.cancelAnimationFrame(h)) as typeof cancelAnimationFrame;

const {
  timeToPx, pxToTime, clientToTime, clampPxPerSec, fitPxPerSec, zoomAbout,
  tracksKey, snapCandidates, junctionAt, isTextControl, panelKeysActive,
  clampPanelH, tickStep, frameCountFor, packSeqRow, initTimelinePanel,
  MIN_PPS, MAX_PPS, MIN_PANEL_H, EDGE_PX,
} = await import('./timeline-panel.ts');

/** The phase-1 field mapping, exactly as sequence-studio's manifest declares it. */
const cfg = {
  idField: 'id', startField: 'start', durField: 'dur', clipInField: 'clipIn',
  speedField: 'speed', enterField: 'enter', exitField: 'exit',
  enterMsField: 'enterMs', exitMsField: 'exitMs', muteField: 'mute', laneField: 'lane',
};

const clip = (id: string, start: number, dur: number): Box => ({ id, start, dur, lane: 'seq' });
const overlay = (id: string, start: number, dur: number): Box => ({ id, start, dur, lane: '' });
const scenery = (id: string): Box => ({ id, start: '', dur: '', lane: '' });

// ── the viewport model (pure) ─────────────────────────────────────────────────

test('timeToPx / pxToTime round-trip at a zoom, and degenerate zoom reads as 0s', () => {
  assert.equal(timeToPx(2.5, 40), 100);
  assert.equal(pxToTime(100, 40), 2.5);
  for (const pps of [4, 40, 137, 600]) {
    assert.ok(Math.abs(pxToTime(timeToPx(3.25, pps), pps) - 3.25) < 1e-9, `round-trip at ${pps}`);
  }
  // A zero/negative/NaN zoom must not produce Infinity or NaN seconds.
  assert.equal(pxToTime(100, 0), 0);
  assert.equal(pxToTime(100, -40), 0);
  assert.equal(pxToTime(100, NaN), 0);
  assert.equal(timeToPx(NaN, 40), 0);
});

test('clientToTime folds in the viewport left edge AND the scroll, and never goes negative', () => {
  // Track viewport starts at x=200, scrolled 80px in, 40px per second.
  assert.equal(clientToTime(200, 200, 0, 40), 0);
  assert.equal(clientToTime(400, 200, 0, 40), 5);
  assert.equal(clientToTime(400, 200, 80, 40), 7);      // +80px of scroll = +2s
  assert.equal(clientToTime(200, 200, 80, 40), 2);
  // Left of the viewport with no scroll would be negative time; it clamps.
  assert.equal(clientToTime(100, 200, 0, 40), 0);
});

test('clampPxPerSec holds the zoom range, including junk input', () => {
  assert.equal(clampPxPerSec(1), MIN_PPS);
  assert.equal(clampPxPerSec(1e9), MAX_PPS);
  assert.equal(clampPxPerSec(40), 40);
  assert.equal(clampPxPerSec(NaN), MIN_PPS);
});

test('fitPxPerSec makes a duration fill the viewport, and survives a zero-length timeline', () => {
  const pps = fitPxPerSec(10, 824);
  assert.equal(pps, 80);                                  // (824 - 24 padding) / 10s
  assert.ok(timeToPx(10, pps) <= 824, 'the fitted duration never overflows the viewport');
  // A brand new, empty timeline must not divide by zero or blow past the zoom ceiling.
  const empty = fitPxPerSec(0, 800);
  assert.ok(empty >= MIN_PPS && empty <= MAX_PPS, `empty fit stayed in range: ${empty}`);
  assert.equal(fitPxPerSec(1e9, 800), MIN_PPS, 'an absurd duration floors at the min zoom');
});

test('zoomAbout keeps the instant under the cursor pinned, in and out', () => {
  const pps = 40, scrollLeft = 200, cursorPx = 300;
  const anchorBefore = pxToTime(cursorPx + scrollLeft, pps);   // 12.5s
  for (const factor of [1.25, 1 / 1.25, 4, 2]) {
    const z = zoomAbout(pps, factor, cursorPx, scrollLeft);
    const anchorAfter = pxToTime(cursorPx + z.scrollLeft, z.pxPerSec);
    assert.ok(z.scrollLeft > 0, `precondition: ${factor} still needs a scroll`);
    assert.ok(Math.abs(anchorAfter - anchorBefore) < 1e-6, `anchor held at ×${factor}: ${anchorAfter} vs ${anchorBefore}`);
  }
});

test('zoomAbout gives up the anchor rather than scrolling before t=0', () => {
  // Zooming far out can put the anchored instant left of the viewport's origin. There is
  // no negative scroll, so the anchor is deliberately surrendered and the view pins to
  // the start — the alternative is a scrollLeft the element would silently clamp anyway.
  const z = zoomAbout(40, 0.25, 300, 200);
  assert.equal(z.pxPerSec, 10);
  assert.equal(z.scrollLeft, 0, 'pinned to the start, never negative');
});

test('zoomAbout clamps at the range ends and cannot scroll past the start', () => {
  const atMax = zoomAbout(MAX_PPS, 4, 100, 0);
  assert.equal(atMax.pxPerSec, MAX_PPS, 'zooming in at the ceiling is a no-op zoom');
  const atMin = zoomAbout(MIN_PPS, 0.25, 100, 0);
  assert.equal(atMin.pxPerSec, MIN_PPS);
  assert.equal(atMin.scrollLeft, 0, 'zooming out at t=0 pins to the start, not a negative scroll');
});

// ── rebuild-vs-restyle memo ───────────────────────────────────────────────────

test('tracksKey is stable across GEOMETRY edits and changes on STRUCTURE edits', () => {
  const boxes = [clip('a', 0, 3), clip('b', 3, 2), overlay('o', 1, 1), scenery('s')];
  const base = tracksKey(boxes, cfg);

  // Moving and trimming must NOT rebuild the rows — that is the whole point of the key.
  const moved = boxes.map((b) => (b.id === 'o' ? { ...b, start: 2.5 } : b));
  assert.equal(tracksKey(moved, cfg), base, 'a move does not change the row structure');
  const trimmed = boxes.map((b) => (b.id === 'a' ? { ...b, dur: 1.2 } : b));
  assert.equal(tracksKey(trimmed, cfg), base, 'a trim does not change the row structure');

  // Adding, removing, re-laning or un-timing a box MUST rebuild.
  assert.notEqual(tracksKey([...boxes, clip('c', 5, 1)], cfg), base, 'an added clip rebuilds');
  assert.notEqual(tracksKey(boxes.slice(1), cfg), base, 'a removed clip rebuilds');
  assert.notEqual(tracksKey(boxes.map((b) => (b.id === 'o' ? { ...b, lane: 'seq' } : b)), cfg), base, 'a lane change rebuilds');
  assert.notEqual(tracksKey(boxes.map((b) => (b.id === 'o' ? { ...b, start: '' } : b)), cfg), base, 'un-timing a box rebuilds');
});

test('tracksKey tolerates a hostile array without throwing', () => {
  assert.equal(tracksKey([] as Box[], cfg), '');
  assert.equal(typeof tracksKey([undefined, null, {}] as unknown as Box[], cfg), 'string');
  assert.equal(typeof tracksKey(null as unknown as Box[], cfg), 'string');
});

// ── snapping + seams ──────────────────────────────────────────────────────────

test('snapCandidates offers zero, every clip edge, the playhead and the nearby seconds', () => {
  const boxes = [clip('a', 0, 3), clip('b', 3, 2), overlay('o', 10, 1)];
  const cands = snapCandidates(boxes, cfg, 4.25, 10.4);
  for (const expect of [0, 3, 5, 10, 11, 4.25]) {
    assert.ok(cands.includes(expect), `offers ${expect} (got ${JSON.stringify(cands)})`);
  }
  // Bounded around the pointer, NOT every whole second up to the max.
  assert.ok(cands.every((c) => c <= 12.001), 'no candidate far past the pointer');
  assert.ok(cands.length < 20, `stays small: ${cands.length}`);
  assert.ok(cands.every((c) => c >= 0), 'never negative');
});

test('snapCandidates excludes the dragged clip, so it cannot snap to where it already is', () => {
  const boxes = [clip('a', 0, 3), clip('b', 3, 2)];
  const withA = snapCandidates(boxes, cfg, 0, 0.2);
  const withoutA = snapCandidates(boxes, cfg, 0, 0.2, 'a');
  assert.ok(withA.includes(3), 'a\'s end is a candidate for other drags');
  // 3 is also b's start, so it survives; what must go is a's own pair being counted twice.
  assert.ok(withoutA.length < withA.length, 'the dragged clip contributed fewer edges');
});

test('junctionAt finds the seam between adjacent clips, within a PIXEL tolerance', () => {
  const boxes = [clip('a', 0, 3), clip('b', 3, 2), clip('c', 5, 2)];
  const pps = 40;   // 8px tolerance = 0.2s

  const hit = junctionAt(boxes, cfg, 3.1, pps, 8);
  assert.deepEqual(hit, { aId: 'a', bId: 'b', t: 3 });
  assert.equal(junctionAt(boxes, cfg, 4.0, pps, 8), null, 'mid-clip is not a seam');
  assert.deepEqual(junctionAt(boxes, cfg, 5.15, pps, 8), { aId: 'b', bId: 'c', t: 5 });

  // The tolerance is in PIXELS, so zooming out widens it in seconds.
  assert.equal(junctionAt(boxes, cfg, 3.4, pps, 8), null, 'out of range at 40px/s');
  assert.ok(junctionAt(boxes, cfg, 3.4, 4, 8), 'the same time IS in range at 4px/s');
});

test('junctionAt returns null when there is no seam to find', () => {
  assert.equal(junctionAt([clip('a', 0, 3)], cfg, 0, 40, 8), null, 'a lone clip has no seam');
  assert.equal(junctionAt([], cfg, 0, 40, 8), null);
  assert.equal(junctionAt([clip('a', 0, 3), clip('b', 3, 2)], cfg, 3, 0, 8), null, 'a zero zoom cannot resolve one');
});

// ── keyboard containment ──────────────────────────────────────────────────────

test('isTextControl catches every surface the user types into', () => {
  const mk = (tag: string): HTMLElement => dom.window.document.createElement(tag);
  assert.equal(isTextControl(mk('input')), true);
  assert.equal(isTextControl(mk('textarea')), true);
  assert.equal(isTextControl(mk('select')), true);
  assert.equal(isTextControl(mk('button')), false);
  assert.equal(isTextControl(mk('div')), false);
  assert.equal(isTextControl(null), false);
  assert.equal(isTextControl(undefined), false);
  const ce = mk('div');
  Object.defineProperty(ce, 'isContentEditable', { value: true });
  assert.equal(isTextControl(ce), true, 'a contenteditable is a text control');
});

test('panelKeysActive: the panel owns keys only when it owns the interaction', () => {
  const root = dom.window.document.createElement('div');
  const inside = dom.window.document.createElement('button');
  const field = dom.window.document.createElement('input');
  root.append(inside, field);
  const outside = dom.window.document.createElement('button');
  dom.window.document.body.append(root, outside);

  assert.equal(panelKeysActive(root, inside, false), true, 'focus inside the panel');
  assert.equal(panelKeysActive(root, null, true), true, 'pointer over the panel');
  assert.equal(panelKeysActive(root, outside, false), false, 'focus on the canvas is the canvas\'s keys');
  assert.equal(panelKeysActive(root, null, false), false, 'neither focused nor hovered');
  // The critical one: typing in the panel's OWN numeric field must not fire shortcuts.
  assert.equal(panelKeysActive(root, field, true), false, 'typing beats hovering');
  assert.equal(panelKeysActive(root, field, false), false, 'typing beats focus containment');
  assert.equal(panelKeysActive(null, inside, true), false, 'no panel, no keys');
});

// ── density heuristics ────────────────────────────────────────────────────────

test('clampPanelH keeps the panel between its floor and half the stage', () => {
  assert.equal(clampPanelH(10, 1000), MIN_PANEL_H);
  assert.equal(clampPanelH(200, 1000), 200);
  assert.equal(clampPanelH(900, 1000), 500, 'never more than half the stage');
  // A stage shorter than twice the floor still yields the floor, not something smaller.
  assert.equal(clampPanelH(200, 100), MIN_PANEL_H);
  assert.equal(clampPanelH(NaN, 1000), MIN_PANEL_H);
});

test('tickStep picks the smallest step that keeps ruler labels ≥60px apart', () => {
  for (const pps of [4, 12, 40, 137, 600]) {
    const step = tickStep(pps);
    assert.ok(step * pps >= 60 || step === 600, `${step}s at ${pps}px/s is legible`);
  }
  assert.equal(tickStep(600), 0.1, 'zoomed right in, tenths');
  assert.equal(tickStep(60), 1);
  assert.ok(tickStep(4) >= 15, 'zoomed right out, coarse steps');
  assert.ok(tickStep(0) > 0, 'a degenerate zoom still yields a usable step');
});

test('frameCountFor stays bounded at both ends of a bar width', () => {
  assert.equal(frameCountFor(0), 1, 'a sliver still asks for one frame');
  assert.equal(frameCountFor(-100), 1);
  assert.equal(frameCountFor(1e6), 24, 'a huge bar is capped, not a decode storm');
  const mid = frameCountFor(400);
  assert.ok(mid > 1 && mid <= 24, `a normal bar asks for a few frames: ${mid}`);
  // Monotonic: a wider bar never asks for fewer frames.
  let prev = 0;
  for (const w of [0, 40, 120, 400, 1200, 5000]) {
    const n = frameCountFor(w);
    assert.ok(n >= prev, `monotonic at ${w}px`);
    prev = n;
  }
});

test('packSeqRow re-exports the magnetic pack: gapless from zero, in row order', () => {
  const packed = packSeqRow([clip('a', 9, 3), clip('b', 40, 2), overlay('o', 1, 1)], cfg);
  const seq = packed.filter((b) => b.lane === 'seq');
  assert.deepEqual(seq.map((b) => [b.id, b.start, b.dur]), [['a', 0, 3], ['b', 3, 2]]);
  assert.equal(packed.length, 3, 'the overlay is still there');
});

// ── the controller: one write per gesture ─────────────────────────────────────

interface Harness {
  commits: Box[][];
  boxes: Box[];
  root: HTMLElement;
  panel: { destroy(): void; setOpen(v: boolean): void; isOpen(): boolean };
  bar(id: string): HTMLElement;
  reserves: number[];
  /** Fire the runtime notification a real commit would have caused. */
  notify(): void;
  teardown(): void;
}

/**
 * Mount the real panel on a jsdom stage. Rects are stubbed because jsdom has no
 * layout: the track viewport sits at x=0 and every bar is given the geometry the
 * panel's own restyle would have produced, so the gesture math reads real numbers.
 */
function mount(initial: Box[], pxPerSecHint = 40): Harness {
  const doc = dom.window.document;
  const stageEl = doc.createElement('div');
  const canvasEl = doc.createElement('div');
  stageEl.appendChild(canvasEl);
  doc.body.appendChild(stageEl);
  stageEl.getBoundingClientRect = (() => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })) as never;

  const commits: Box[][] = [];
  const reserves: number[] = [];
  let boxes = initial.map((b) => ({ ...b }));
  let selected: string[] = [];
  const selListeners = new Set<() => void>();
  const subs = new Set<() => void>();

  const panel = initTimelinePanel({
    stageEl, canvasEl,
    runtime: { subscribe: (fn: () => void) => { subs.add(fn); return () => subs.delete(fn); } },
    host: {},
    blockId: 'boxes',
    cfg,
    getBoxes: () => boxes,
    commit: (next: Box[]) => { commits.push(next.map((b) => ({ ...b }))); boxes = next.map((b) => ({ ...b })); },
    selection: {
      get: () => selected,
      set: (ids: string[]) => { selected = ids; for (const f of selListeners) f(); },
      onChange: (cb: () => void) => { selListeners.add(cb); return () => { selListeners.delete(cb); }; },
    },
    reserve: (px: number) => { reserves.push(px); },
  } as never);

  // Stub the track viewport BEFORE opening: the panel fits its zoom to clientWidth on
  // first open, and jsdom reports 0 (which would leave the default zoom in place and make
  // every distance below unverifiable). 224px of viewport over a 5s timeline fits to
  // exactly (224 - 24) / 5 = 40px per second, which is what `bar()` lays the rects out at.
  const root = stageEl.querySelector('.tl-panel') as HTMLElement;
  const tracks = root.querySelector('.tl-tracks') as HTMLElement;
  tracks.getBoundingClientRect = (() => ({ left: 0, top: 0, width: 224, height: 120, right: 224, bottom: 120, x: 0, y: 0, toJSON: () => ({}) })) as never;
  Object.defineProperty(tracks, 'clientWidth', { value: 24 + 5 * pxPerSecHint, configurable: true });
  panel.setOpen(true);

  const bar = (id: string): HTMLElement => {
    const el = root.querySelector(`.tl-clip[data-id="${id}"]`) as HTMLElement;
    assert.ok(el, `bar for ${id} exists`);
    const b = boxes.find((x) => x.id === id)!;
    const left = Number(b.start) * pxPerSecHint;
    const width = Number(b.dur) * pxPerSecHint;
    el.getBoundingClientRect = (() => ({ left, right: left + width, width, top: 0, bottom: 40, height: 40, x: left, y: 0, toJSON: () => ({}) })) as never;
    return el;
  };

  return {
    commits, root, panel, bar, reserves,
    notify() { for (const f of subs) f(); },
    get boxes() { return boxes; },
    teardown() { try { panel.destroy(); } catch { /* already gone */ } stageEl.remove(); },
  } as Harness;
}

/** A pointer event jsdom can build (it has no PointerEvent constructor). */
function pointer(type: string, clientX: number, extra: Record<string, unknown> = {}): Event {
  const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 20 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'button', { value: 0 });
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(e, k, { value: v });
  return e;
}

test('panel mounts as a stage child, outside the canvas, tagged [data-export-hide]', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const stage = h.root.parentElement!;
    assert.equal(h.root.className, 'tl-panel');
    assert.ok(h.root.hasAttribute('data-export-hide'), 'never walked into an SVG/PDF export');
    const canvas = stage.firstElementChild as HTMLElement;
    assert.equal(canvas.contains(h.root), false, 'the panel is a SIBLING of the canvas, never inside it');
    assert.ok(h.reserves.length > 0 && h.reserves[0]! > 0, 'opening reserved a stage band');
  } finally { h.teardown(); }
});

test('a move drag on an OVERLAY commits exactly once, on pointerup', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), overlay('o', 1, 1)]);
  try {
    const el = h.bar('o');
    // Press in the BODY of the bar (past the trim edge zone), then drag right.
    const grabAt = 40 + EDGE_PX + 4;
    el.dispatchEvent(pointer('pointerdown', grabAt));
    assert.equal(h.commits.length, 0, 'pointerdown alone writes nothing');

    for (const x of [grabAt + 10, grabAt + 40, grabAt + 80, grabAt + 120]) {
      h.root.dispatchEvent(pointer('pointermove', x));
      assert.equal(h.commits.length, 0, `pointermove at ${x} writes nothing`);
    }

    h.root.dispatchEvent(pointer('pointerup', grabAt + 120, { altKey: true }));
    assert.equal(h.commits.length, 1, 'EXACTLY one write for the whole gesture');

    const written = h.commits[0]!.find((b) => b.id === 'o')!;
    // 120px at 40px/s = +3s, from a start of 1s. Alt bypasses snapping so the
    // arithmetic is checkable exactly.
    assert.equal(written.start, 4, 'the drag distance became the new start');
    assert.equal(written.dur, 1, 'a move never changes the length');
    // Nothing else moved.
    assert.deepEqual(h.commits[0]!.filter((b) => b.lane === 'seq').map((b) => [b.id, b.start]), [['a', 0], ['b', 3]]);
  } finally { h.teardown(); }
});

test('a press with no movement commits nothing at all', () => {
  const h = mount([clip('a', 0, 3), overlay('o', 1, 1)]);
  try {
    const el = h.bar('o');
    const at = 40 + EDGE_PX + 4;
    el.dispatchEvent(pointer('pointerdown', at));
    el.dispatchEvent(pointer('pointermove', at + 1));   // under the 2px slop
    h.root.dispatchEvent(pointer('pointerup', at + 1));
    assert.equal(h.commits.length, 0, 'a click selects, it does not edit');
  } finally { h.teardown(); }
});

test('a cancelled drag commits nothing', () => {
  const h = mount([clip('a', 0, 3), overlay('o', 1, 1)]);
  try {
    const el = h.bar('o');
    const at = 40 + EDGE_PX + 4;
    el.dispatchEvent(pointer('pointerdown', at));
    h.root.dispatchEvent(pointer('pointermove', at + 100));
    h.root.dispatchEvent(pointer('pointercancel', at + 100));
    assert.equal(h.commits.length, 0, 'pointercancel abandons the gesture');
    // And a later stray pointerup must not resurrect it.
    h.root.dispatchEvent(pointer('pointerup', at + 100));
    assert.equal(h.commits.length, 0);
  } finally { h.teardown(); }
});

test('a trim drag on a clip edge commits exactly once and keeps the row gapless', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const el = h.bar('a');
    // Grab within EDGE_PX of the bar's right edge (3s × 40px/s = 120px).
    const at = 120 - 2;
    el.dispatchEvent(pointer('pointerdown', at));
    h.root.dispatchEvent(pointer('pointermove', at - 40));
    assert.equal(h.commits.length, 0);
    h.root.dispatchEvent(pointer('pointerup', at - 40, { altKey: true }));
    assert.equal(h.commits.length, 1, 'EXACTLY one write for the trim');

    const seq = h.commits[0]!.filter((b) => b.lane === 'seq');
    assert.equal(Number(seq.find((b) => b.id === 'a')!.dur), 2, 'shortened by 40px = 1s');
    assert.equal(Number(seq.find((b) => b.id === 'b')!.start), 2, 'the row repacked gapless behind it');
  } finally { h.teardown(); }
});

test('a reorder drag on the seq row commits exactly once and lands in the right slot', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const el = h.bar('a');
    // Grab a's middle (60px = 1.5s) and drag past b's midpoint (4s = 160px).
    el.dispatchEvent(pointer('pointerdown', 60));
    for (const x of [100, 150, 200]) {
      h.root.dispatchEvent(pointer('pointermove', x));
      assert.equal(h.commits.length, 0, `pointermove to ${x} writes nothing`);
    }
    h.root.dispatchEvent(pointer('pointerup', 200, { altKey: true }));
    assert.equal(h.commits.length, 1, 'EXACTLY one write for the reorder');

    const seq = h.commits[0]!.filter((b) => b.lane === 'seq');
    // b, then a — and repacked gapless, which is the whole point of the magnetic row.
    assert.deepEqual(
      seq.map((b) => [b.id, b.start, b.dur]).sort((x, y) => Number(x[1]) - Number(y[1])),
      [['b', 0, 2], ['a', 2, 3]],
    );
  } finally { h.teardown(); }
});

test('a reorder drag that does not clear a midpoint commits nothing', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const el = h.bar('a');
    el.dispatchEvent(pointer('pointerdown', 60));
    h.root.dispatchEvent(pointer('pointermove', 90));   // 2.25s: still short of b's 4s midpoint
    h.root.dispatchEvent(pointer('pointerup', 90, { altKey: true }));
    assert.equal(h.commits.length, 0, 'the index never changed, so there is nothing to write');
  } finally { h.teardown(); }
});

test('closing the panel releases the stage reserve', () => {
  const h = mount([clip('a', 0, 3)]);
  try {
    assert.ok(h.reserves.some((r) => r > 0), 'open reserved');
    h.panel.setOpen(false);
    assert.equal(h.reserves[h.reserves.length - 1], 0, 'close released the band');
    assert.equal(h.panel.isOpen(), false);
  } finally { h.teardown(); }
});


/** Let jsdom run its rAF callbacks (paint + scheduleSync are both rAF-coalesced). */
function frames(n = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = (): void => { if (--left <= 0) resolve(); else dom.window.requestAnimationFrame(step); };
    dom.window.requestAnimationFrame(step);
  });
}

// ── leaked-state regressions ──────────────────────────────────────────────────

test('a reorder clears is-drop-target on release — a stale ring cannot outlive the drag', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const el = h.bar('a');
    el.dispatchEvent(pointer('pointerdown', 60));
    h.root.dispatchEvent(pointer('pointermove', 200));
    await frames();
    const marked = () => Array.from(h.root.querySelectorAll('.tl-clip.is-drop-target')).map((n) => (n as HTMLElement).dataset.id);
    assert.deepEqual(marked(), ['b'], 'the clip the drop would displace is highlighted during the drag');
    h.root.dispatchEvent(pointer('pointerup', 200, { altKey: true }));
    // A reorder leaves array order and lanes alone, so tracksKey is unchanged and the
    // next sync takes the restyle branch — nothing will ever rebuild this class away.
    assert.deepEqual(marked(), [], 'and it is gone the instant the pointer lifts');
  } finally { h.teardown(); }
});

test('closing the panel under a live resize drag cannot re-reserve the stage band', async () => {
  const h = mount([clip('a', 0, 3)]);
  try {
    const handle = h.root.querySelector('.tl-handle') as HTMLElement;
    handle.dispatchEvent(pointer('pointerdown', 100));
    h.root.dispatchEvent(pointer('pointermove', 100));
    await frames();
    h.panel.setOpen(false);                       // Escape is reachable mid-drag
    assert.equal(h.reserves[h.reserves.length - 1], 0, 'closing released the band');
    // Whatever the pointer does next must not re-reserve behind a hidden panel.
    h.root.dispatchEvent(pointer('pointermove', 60));
    h.root.dispatchEvent(pointer('pointerup', 60));
    await frames();
    assert.equal(h.reserves[h.reserves.length - 1], 0, 'still released');
    assert.equal(h.root.hidden, true);
  } finally { h.teardown(); }
});

test('a lost pointer capture does not wedge the panel into ignoring the model forever', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    h.bar('a').dispatchEvent(pointer('pointerdown', 60));
    h.root.dispatchEvent(new dom.window.Event('lostpointercapture', { bubbles: true }));
    // With the gesture abandoned, a model change must reach the panel again.
    h.boxes.push(overlay('o', 1, 1) as never);
    h.notify();
    await frames(3);
    assert.ok(h.root.querySelector('.tl-clip[data-id="o"]'), 'the new row was picked up');
  } finally { h.teardown(); }
});

test('deleting the focused clip keeps focus inside the panel, so the keyboard stays alive', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const el = h.bar('a');
    el.dispatchEvent(pointer('pointerdown', 60));
    h.root.dispatchEvent(pointer('pointerup', 60));
    el.focus();
    assert.equal(dom.window.document.activeElement, el);
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    assert.equal(h.commits.length, 1, 'the delete committed');
    h.notify();
    await frames(3);
    const active = dom.window.document.activeElement as HTMLElement;
    assert.ok(h.root.contains(active), `focus stayed in the panel (was ${active.tagName})`);
  } finally { h.teardown(); }
});
