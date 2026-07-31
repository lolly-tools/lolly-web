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
 * The thumbnail pass is covered at the level jsdom can honestly reach: which BRANCH
 * each clip kind takes (waveform / filmstrip / tiled still / the card's own fill), the
 * classification off the live canvas that chooses it, the tiling arithmetic, and that a
 * gesture aborts a queued pass. The canvas 2D context is a recorder and the bitmaps are
 * fakes, because node has no raster — see the browser checklist below.
 *
 * NOT covered here (browser-only): that the pictures actually LOOK right (a real decode,
 * a real drawImage, a Lottie's live <svg> rasterising, CORS tainting), layout-derived
 * geometry (jsdom reports 0 for every rect, so the tests below stub the two rects the
 * gesture math reads and the two sizes the thumb pass reads), the ResizeObserver refit,
 * the <dialog> junction modal, and anything the sequence clock does with real media.
 *
 * Run directly:  node --test shells/web/src/views/timeline-panel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  isPaintedColor, thumbMode, canRasterBox, appearanceSig,
  MIN_PPS, MAX_PPS, MIN_PANEL_H, ONE_LANE_H, EDGE_PX, EDGE_PX_COARSE, TAKE_TIMING,
  MAX_NODE_RASTERS_PER_PASS, MAX_THUMB_PASSES,
} = await import('./timeline-panel.ts');
// The trim readout's formatters, asserted against the badge the panel paints (the
// numbers themselves are covered in tests/timeline-math.test.ts).
const { fmtDelta, fmtDur } = await import('./timeline-math.ts');
// The SAME module instance the panel holds (a dynamic import of an already-evaluated
// module is the same record), so the seam installed here is the one it calls.
const { _setNodeRasterer, clearClipThumbCache } = await import('../lib/clip-thumbs.ts');

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

test('clampPanelH floors above the measured chrome so the tracks can never be crushed to zero', () => {
  // Desktop-ish: one bar row, chrome well under MIN_PANEL_H — the constant still rules.
  assert.equal(clampPanelH(10, 1000, 70), MIN_PANEL_H, 'chrome below the floor changes nothing');
  // Phone-ish: .tl-bar has wrapped and a clip is selected, so the chrome alone (124px)
  // exceeds MIN_PANEL_H. Dragging the grip all the way down must still leave a lane.
  assert.equal(clampPanelH(10, 1000, 124), 124 + ONE_LANE_H);
  assert.ok(clampPanelH(10, 1000, 124) - 124 >= ONE_LANE_H, 'at least one lane survives the floor');
  // The floor also wins over a stage too short to halve into it.
  assert.equal(clampPanelH(500, 200, 124), 124 + ONE_LANE_H);
  // Absent/garbage chrome degrades to the two-argument behaviour rather than throwing.
  assert.equal(clampPanelH(10, 1000, NaN), MIN_PANEL_H);
  assert.equal(clampPanelH(10, 1000), MIN_PANEL_H);
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

// ── what a bar paints (the branch, not the pixels) ───────────────────────────

test('isPaintedColor: "no background" is rgba(0,0,0,0), and must not light up has-thumbs', () => {
  assert.equal(isPaintedColor('rgba(0, 0, 0, 0)'), false, 'the computed value of no background');
  assert.equal(isPaintedColor('transparent'), false);
  assert.equal(isPaintedColor(''), false);
  assert.equal(isPaintedColor('rgba(20, 24, 29, 0.01)'), false, 'an invisible sliver of alpha is not a fill');
  assert.equal(isPaintedColor('rgb(20, 24, 29)'), true);
  assert.equal(isPaintedColor('rgba(20, 24, 29, 0.5)'), true);
  assert.equal(isPaintedColor('#14181d'), true);
  assert.equal(isPaintedColor('rgb(0 0 0 / 60%)'), true, 'the space-separated form is still a colour');
});

test('thumbMode: every clip kind picks its own picture, and a card falls back to its fill', () => {
  // The regression this exists to stop: before it, ONLY audio and video painted, so a
  // row of cards, images and tool clips was a row of identical coloured rectangles.
  assert.equal(thumbMode('audio', 'a.mp3', ''), 'waveform');
  assert.equal(thumbMode('video', 'a.mp4', ''), 'filmstrip');
  assert.equal(thumbMode('image', 'a.png', ''), 'still', 'an image box tiles one still');
  assert.equal(thumbMode('image', 'data:image/svg+xml,x', ''), 'still', 'a tool clip is an <img> like any other');
  assert.equal(thumbMode('lottie', 'anim.json', ''), 'still');
  // No media at all: the box's own colour, which is what it actually paints on frame.
  assert.equal(thumbMode('', '', 'rgb(20, 24, 29)'), 'fill');
  assert.equal(thumbMode('', '', 'rgba(0, 0, 0, 0)'), 'none', 'a transparent text box stays plain');
  assert.equal(thumbMode('', '', ''), 'none');
  // A media kind with no resolved url yet is not a picture — it falls back like a card.
  assert.equal(thumbMode('image', '', 'rgb(1, 2, 3)'), 'fill');
  assert.equal(thumbMode('video', '', ''), 'none');
});

test('thumbMode: a box worth photographing beats BOTH the flat fill and painting nothing', () => {
  // The gap this closes: a frame — a card, a text box, a pen shape, a composed group —
  // has no media element, so it used to be one flat rectangle of its own background,
  // or (transparent text, and EVERY kind:'path' box, whose fill the hook forces to
  // transparent) literally nothing at all. A row of frames read as a row of blanks.
  assert.equal(thumbMode('', '', 'rgb(20, 24, 29)', true), 'node', 'a photograph beats a flat fill');
  assert.equal(thumbMode('', '', 'rgba(0, 0, 0, 0)', true), 'node', 'and beats painting nothing');
  // A decoded asset still wins: it is cheaper AND more faithful than a DOM photograph,
  // and a tool clip's <img> IS the compose render, not a screenshot of a tag.
  assert.equal(thumbMode('image', 'data:image/svg+xml,x', '', true), 'still');
  assert.equal(thumbMode('audio', 'a.mp3', '', true), 'waveform');
  assert.equal(thumbMode('video', 'v.mp4', '', true), 'filmstrip');
});

test('canRasterBox: photographs what has ink, declines what would come back blank', () => {
  const doc = dom.window.document;
  const box = (html: string): HTMLElement => {
    const el = doc.createElement('div');
    el.innerHTML = html;
    return el;
  };
  // A text card: transparent, but there is something to see.
  assert.equal(canRasterBox(box('<div class="lolly-box-text">Hello</div>'), 'rgba(0, 0, 0, 0)'), true);
  // A card: an opaque background is enough on its own.
  assert.equal(canRasterBox(box(''), 'rgb(20, 24, 29)'), true);
  // A pen shape: hooks.js forces kind:'path' boxes to fill:'transparent', so the
  // computed background says "nothing here" while the <svg> says otherwise.
  assert.equal(canRasterBox(box('<svg class="lolly-box-path"></svg>'), 'rgba(0, 0, 0, 0)'), true);
  // Nothing to photograph: a shot would cost a full dom-to-image call to produce a
  // blank bitmap, so the bar stays on 'none'.
  assert.equal(canRasterBox(box(''), 'rgba(0, 0, 0, 0)'), false);
  assert.equal(canRasterBox(box('<div class="lolly-box-text">   </div>'), ''), false, 'whitespace is not text');
  assert.equal(canRasterBox(null, 'rgb(20, 24, 29)'), false);
  // Past the subtree ceiling we decline rather than build it — the MAX_SVG_MARKUP
  // idiom. The limit is passed explicitly so this does not pin the constant's value.
  const big = box('<div class="lolly-box-text">Hello</div>');
  for (let i = 0; i < 12; i++) big.appendChild(doc.createElement('span'));
  assert.equal(canRasterBox(big, 'rgb(20, 24, 29)', 100), true, 'under the given ceiling');
  assert.equal(canRasterBox(big, 'rgb(20, 24, 29)', 5), false, 'over it, declined outright');
});

test('appearanceSig: a drag never invalidates a picture that has not changed a pixel', () => {
  // THE point of the signature. A drag rewrites start/dur on every pointermove; keying
  // the raster cache on the whole row would throw the photograph away and retake it at
  // the end of every gesture, on every bar the drag rippled.
  const a = { id: 'a', start: 0, dur: 2, clipIn: 0, speed: 1, lane: 'seq', bg: '#123', text: 'Hi' };
  const dragged = { ...a, start: 7.25, dur: 3, clipIn: 1.5, speed: 2, lane: '' };
  assert.equal(appearanceSig(a, cfg), appearanceSig(dragged, cfg));
  // Transitions are timing too — a fade length changes when the bar plays, not how it
  // looks at rest.
  assert.equal(appearanceSig(a, cfg), appearanceSig({ ...a, enter: 'fade', exitMs: 400 }, cfg));

  // Anything that changes the PICTURE changes the signature.
  assert.notEqual(appearanceSig(a, cfg), appearanceSig({ ...a, bg: '#456' }, cfg));
  assert.notEqual(appearanceSig(a, cfg), appearanceSig({ ...a, text: 'Bye' }, cfg));

  // The id is deliberately absent: two boxes that look identical may share one raster,
  // and one dom-to-image shot.
  assert.equal(appearanceSig(a, cfg), appearanceSig({ ...a, id: 'b' }, cfg));

  // Insertion order must not matter — the same row built by a seed and by a patch is
  // the same picture.
  const reordered = { text: 'Hi', bg: '#123', lane: 'seq', speed: 1, clipIn: 0, dur: 2, start: 0, id: 'a' };
  assert.equal(appearanceSig(a, cfg), appearanceSig(reordered, cfg));

  // null / undefined / '' are one "unauthored" state, not three.
  assert.equal(appearanceSig({ bg: null }, cfg), appearanceSig({ bg: '' }, cfg));
  assert.equal(appearanceSig({ bg: undefined }, cfg), appearanceSig({ bg: '' }, cfg));
  assert.equal(appearanceSig(undefined, cfg), '');
});

test('packSeqRow re-exports the magnetic pack: gapless from zero, in row order', () => {
  const packed = packSeqRow([clip('a', 9, 3), clip('b', 40, 2), overlay('o', 1, 1)], cfg);
  const seq = packed.filter((b) => b.lane === 'seq');
  assert.deepEqual(seq.map((b) => [b.id, b.start, b.dur]), [['a', 0, 3], ['b', 3, 2]]);
  assert.equal(packed.length, 3, 'the overlay is still there');
});

// ── the controller: one write per gesture ─────────────────────────────────────

/**
 * The add-kinds a HOST TOOL declares. Deliberately NOT sequence-studio's real list:
 * `widget` is a kind no module knows about, so a menu that renders it is a menu reading
 * the manifest rather than a hardcoded switch.
 */
const ADD_KINDS = [
  { id: 'clip', label: 'Clip' },
  { id: 'audio', label: 'Sound' },
  { id: 'widget', label: 'Widget' },
];

interface Harness {
  commits: Box[][];
  boxes: Box[];
  root: HTMLElement;
  /** The stage the panel is docked in — where `tl-*` / `fc-seek` cross the modules. */
  stageEl: HTMLElement;
  /** Every ids array the panel handed to `selection.set`, in order. */
  selSets: string[][];
  /** The tool canvas the panel reads media/mute state off. */
  canvasEl: HTMLElement;
  panel: { destroy(): void; setOpen(v: boolean): void; isOpen(): boolean };
  bar(id: string): HTMLElement;
  /** Drive the shared canvas selection, exactly as free-canvas would. */
  select(ids: string[]): void;
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
function mount(
  initial: Box[],
  pxPerSecHint = 40,
  addKinds: Array<{ id: string; label?: string; seed?: Record<string, unknown> }> = ADD_KINDS,
  extra: { host?: unknown; capabilities?: string[]; assetField?: string; linkField?: string } = {},
): Harness {
  const doc = dom.window.document;
  const stageEl = doc.createElement('div');
  const canvasEl = doc.createElement('div');
  stageEl.appendChild(canvasEl);
  doc.body.appendChild(stageEl);
  stageEl.getBoundingClientRect = (() => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })) as never;

  const commits: Box[][] = [];
  const reserves: number[] = [];
  const selSets: string[][] = [];
  let boxes = initial.map((b) => ({ ...b }));
  let selected: string[] = [];
  let setSelection = (_ids: string[]): void => { /* replaced below, once the panel owns it */ };
  const selListeners = new Set<() => void>();
  const subs = new Set<() => void>();

  const panel = initTimelinePanel({
    stageEl, canvasEl,
    runtime: {
      subscribe: (fn: () => void) => { subs.add(fn); return () => subs.delete(fn); },
      ...(extra.capabilities ? { manifest: { capabilities: extra.capabilities } } : {}),
    },
    host: extra.host ?? {},
    blockId: 'boxes',
    // `linkField` is the manifest's OPT-IN to detach/re-attach. Absent by default, so
    // every existing test still exercises a tool that never offers it.
    cfg: extra.linkField ? { ...cfg, linkField: extra.linkField } : cfg,
    getBoxes: () => boxes,
    commit: (next: Box[]) => { commits.push(next.map((b) => ({ ...b }))); boxes = next.map((b) => ({ ...b })); },
    selection: {
      get: () => selected,
      set: setSelection = (ids: string[]) => { selSets.push([...ids]); selected = ids; for (const f of selListeners) f(); },
      onChange: (cb: () => void) => { selListeners.add(cb); return () => { selListeners.delete(cb); }; },
    },
    reserve: (px: number) => { reserves.push(px); },
    addKinds,
    ...(extra.assetField ? { assetField: extra.assetField } : {}),
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
    commits, root, panel, bar, reserves, canvasEl, stageEl, selSets,
    select: (ids: string[]) => setSelection(ids),
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
    await frames(3);
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
    await frames(3);
    h.panel.setOpen(false);                       // Escape is reachable mid-drag
    assert.equal(h.reserves[h.reserves.length - 1], 0, 'closing released the band');
    // Whatever the pointer does next must not re-reserve behind a hidden panel.
    h.root.dispatchEvent(pointer('pointermove', 60));
    h.root.dispatchEvent(pointer('pointerup', 60));
    await frames(3);
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

// ── promotion / demotion: timing is reachable for ANY box ─────────────────────
//
// The regression these pin: the `text` / `image` / `lottie` / `tool` add-kinds seed
// neither a lane nor a start, so the box is scenery — and before this the ONLY way to
// give one a time was to hand-edit the ?boxes= URL. The inspector gated on `bars`
// (timed clips only) and the scenery chip did nothing but select.

/** The inspector control sitting under a given field label. */
function field(root: HTMLElement, label: string): HTMLInputElement {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.tl-inspector .tl-field'));
  const r = rows.find((x) => x.querySelector('.field-label')?.textContent === label);
  assert.ok(r, `the inspector has a "${label}" field (got ${JSON.stringify(rows.map((x) => x.querySelector('.field-label')?.textContent))})`);
  return r!.querySelector('.field-input, .field-select') as HTMLInputElement;
}

/** Type into a field the way a user leaving it does: value, then `change`. */
function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

const timingBtn = (root: HTMLElement): HTMLButtonElement => {
  const b = root.querySelector('.tl-inspector .tl-timing') as HTMLButtonElement;
  assert.ok(b, 'the inspector offers the timed ⇄ always-on switch');
  return b;
};

test('the inspector opens for an UNTIMED box, with empty Start/Length and the transitions', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), scenery('s')]);
  try {
    assert.ok(h.root.querySelector('.tl-chip[data-id="s"]'), 'precondition: s is a scenery chip, not a bar');
    assert.equal(h.root.querySelector('.tl-clip[data-id="s"]'), null, 'precondition: s has no bar');
    assert.equal(h.root.querySelectorAll('.tl-inspector .tl-field').length, 0, 'nothing selected, nothing shown');

    h.select(['s']);
    const start = field(h.root, 'Start');
    const len = field(h.root, 'Length');
    assert.equal(start.value, '', 'Start is EMPTY, not a misleading 0');
    assert.equal(len.value, '', 'Length is EMPTY, not a misleading 0');
    assert.equal(start.placeholder, '—');
    // The animate controls are authorable before the box is timed.
    assert.ok(field(h.root, 'Animate in'), 'Animate in is reachable');
    assert.ok(field(h.root, 'Animate out'), 'Animate out is reachable');
    assert.equal(timingBtn(h.root).textContent, 'Add to the timeline');
    // Playback-only fields stay out of the way until there is something playing.
    assert.equal(h.root.querySelector('.tl-inspector .tl-mute'), null, 'no mute on a box with no span');
  } finally { h.teardown(); }
});

test('typing a Start promotes an untimed box in EXACTLY ONE commit, onto an overlay lane', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), scenery('s')]);
  try {
    const before = tracksKey(h.boxes, cfg);
    h.select(['s']);
    type(field(h.root, 'Start'), '2');
    assert.equal(h.commits.length, 1, 'ONE commit — one undo step for the whole promotion');

    const written = h.commits[0]!.find((b) => b.id === 's')!;
    assert.equal(written.start, 2, 'the typed start landed');
    // Documented default: no media on the canvas, so the length is DEFAULT_CLIP_S — the
    // same 3 s the magnetic pack gives a clip it cannot measure.
    assert.equal(written.dur, 3, 'the length defaulted to the pack default');
    assert.equal(written.lane, '', 'promoted onto an OVERLAY lane, never onto the magnetic row');
    // The seq row is untouched: promotion must not repack anyone else.
    assert.deepEqual(h.commits[0]!.filter((b) => b.lane === 'seq').map((b) => [b.id, b.start, b.dur]), [['a', 0, 3], ['b', 3, 2]]);

    assert.notEqual(tracksKey(h.boxes, cfg), before, 'the row STRUCTURE changed, so the panel must rebuild');
    h.notify();
    await frames(3);
    assert.ok(h.root.querySelector('.tl-clip[data-id="s"]'), 'and it now has a bar on a lane');
    assert.equal(h.root.querySelector('.tl-chip[data-id="s"]'), null, 'it left the scenery strip');
  } finally { h.teardown(); }
});

test('typing only a Length promotes at the PLAYHEAD, still one commit', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), scenery('s')]);
  try {
    h.select(['s']);
    type(field(h.root, 'Length'), '1.5');
    assert.equal(h.commits.length, 1, 'ONE commit');
    const written = h.commits[0]!.find((b) => b.id === 's')!;
    // The clock has never been seeked in this harness, so the playhead is at 0 — which
    // is the documented default for a Length-only promotion.
    assert.equal(written.start, 0, 'start defaulted to the playhead');
    assert.equal(written.dur, 1.5, 'the typed length landed');
  } finally { h.teardown(); }
});

test('leaving the empty Start field untouched promotes nothing', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), scenery('s')]);
  try {
    h.select(['s']);
    // Tabbing through a field fires `change` in some browsers; an empty field must not
    // be read as "start at 0" and quietly time the box.
    type(field(h.root, 'Start'), '');
    type(field(h.root, 'Length'), '');
    assert.equal(h.commits.length, 0, 'an untouched empty field writes nothing');
  } finally { h.teardown(); }
});

test('the scenery chip\'s + button promotes straight from the strip, one commit', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), scenery('s')]);
  try {
    const add = h.root.querySelector('.tl-chip-add[data-id="s"]') as HTMLElement;
    assert.ok(add, 'the chip carries a promote affordance');
    add.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(h.commits.length, 1, 'ONE commit from the chip too');
    const written = h.commits[0]!.find((b) => b.id === 's')!;
    assert.equal(written.start, 0, 'placed at the playhead');
    assert.equal(written.dur, 3, 'with the default length');
    h.notify();
    await frames(3);
    assert.ok(h.root.querySelector('.tl-clip[data-id="s"]'), 'it is on a lane');
  } finally { h.teardown(); }
});

test('a timed OVERLAY demotes back to scenery in one commit — "always on" is not a trap', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), overlay('o', 1, 1)]);
  try {
    const before = tracksKey(h.boxes, cfg);
    h.select(['o']);
    const toggle = timingBtn(h.root);
    assert.equal(toggle.textContent, 'Make always on', 'a timed box offers the reverse');
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(h.commits.length, 1, 'ONE commit');

    const written = h.commits[0]!.find((b) => b.id === 'o')!;
    assert.equal(written.start, '', 'start CLEARED — an empty field, never a 0');
    assert.equal(written.dur, '');
    assert.equal(written.lane, '');
    assert.notEqual(tracksKey(h.boxes, cfg), before, 'un-timing changes the row structure');

    h.notify();
    await frames(3);
    assert.ok(h.root.querySelector('.tl-chip[data-id="o"]'), 'it is back in the scenery strip');
    assert.equal(h.root.querySelector('.tl-clip[data-id="o"]'), null, 'and its bar is gone');
  } finally { h.teardown(); }
});

test('demoting a SEQ clip closes the gap it leaves, inside the same commit', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), clip('c', 5, 1)]);
  try {
    h.select(['a']);
    timingBtn(h.root).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(h.commits.length, 1, 'ONE commit');
    const seq = h.commits[0]!.filter((b) => b.lane === 'seq');
    assert.deepEqual(
      seq.map((b) => [b.id, b.start, b.dur]),
      [['b', 0, 2], ['c', 2, 1]],
      'the magnetic row repacked gapless from zero',
    );
    assert.equal(h.commits[0]!.find((b) => b.id === 'a')!.start, '', 'and a is scenery');
  } finally { h.teardown(); }
});

test('a promoted box round-trips: promote, demote, and the model is scenery again', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), scenery('s')]);
  try {
    h.select(['s']);
    type(field(h.root, 'Start'), '4');
    assert.equal(h.commits.length, 1);
    // The inspector re-rendered against the now-timed box, so the switch flipped.
    const toggle = timingBtn(h.root);
    assert.equal(toggle.textContent, 'Make always on');
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(h.commits.length, 2, 'one commit each way, never a compound step');
    const written = h.commits[1]!.find((b) => b.id === 's')!;
    assert.equal(written.start, '');
    assert.equal(written.dur, '');
  } finally { h.teardown(); }
});

// ── the `+` menu and the tl-add seam ──────────────────────────────────────────
//
// The complaint these pin (Andy, 2026-07-27): "I have no way to add audio outside of
// the export menu, I'd like it in the timeline." The panel does not create boxes — it
// dispatches `tl-add` with an add-kind id and the playhead, and free-canvas's create
// pipeline does the rest. What is checked here is the CONTRACT: the kinds come from the
// manifest, and the time is the live playhead.

const click = (el: Element): void => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); };

/** Every `tl-add` that bubbles out of the panel, in order. */
function recordAdds(h: Harness): Array<{ kind: string; atMs: number }> {
  const seen: Array<{ kind: string; atMs: number }> = [];
  h.root.parentElement!.addEventListener('tl-add', (e) => {
    seen.push((e as CustomEvent).detail as { kind: string; atMs: number });
  });
  return seen;
}

/** The body-mounted menu currently open, if any. */
const openMenu = (cls = '.tl-menu'): HTMLElement | null => dom.window.document.querySelector(cls);
const menuLabels = (el: HTMLElement | null): string[] =>
  Array.from(el?.querySelectorAll('.folder-menu-item') ?? []).map((n) => n.textContent?.trim() ?? '');

/** Move the playhead by scrubbing the ruler (Alt bypasses snapping, so it is exact). */
function seekTo(h: Harness, sec: number, pxPerSecHint = 40): void {
  const ruler = h.root.querySelector('.tl-ruler') as HTMLElement;
  const x = sec * pxPerSecHint;
  ruler.dispatchEvent(pointer('pointerdown', x, { altKey: true }));
  h.root.dispatchEvent(pointer('pointerup', x, { altKey: true }));
}

test('the + menu lists the TOOL\'s declared add-kinds, not a hardcoded set', () => {
  const h = mount([clip('a', 0, 3)]);
  try {
    const add = h.root.querySelector('.tl-tools .tl-add') as HTMLButtonElement;
    assert.ok(add, 'the tool group carries an add button');
    assert.equal(add.hidden, false);
    assert.equal(add.getAttribute('aria-haspopup'), 'menu');
    click(add);
    const menu = openMenu();
    assert.ok(menu, 'clicking opens a menu');
    assert.deepEqual(menuLabels(menu), ['Clip', 'Sound', 'Widget'],
      'exactly the manifest\'s kinds, in its order — including one no module knows about');
    assert.equal(add.getAttribute('aria-expanded'), 'true');
  } finally { h.teardown(); }
});

test('a tool with no add-kinds gets no + button rather than an empty menu', () => {
  const h = mount([clip('a', 0, 3)], 40, []);
  try {
    assert.equal((h.root.querySelector('.tl-tools .tl-add') as HTMLButtonElement).hidden, true);
  } finally { h.teardown(); }
});

test('choosing a kind dispatches tl-add with that kind and the CURRENT playhead', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const adds = recordAdds(h);
    seekTo(h, 2.5);
    click(h.root.querySelector('.tl-tools .tl-add')!);
    const audio = Array.from(openMenu()!.querySelectorAll('.folder-menu-item'))
      .find((n) => n.textContent?.trim() === 'Sound');
    assert.ok(audio, 'AUDIO is one click away from the timeline — the whole point');
    click(audio!);
    assert.deepEqual(adds, [{ kind: 'audio', atMs: 2500 }], 'the kind id and the playhead, in ms');
    assert.equal(h.commits.length, 0, 'the panel never creates the box itself');
    assert.equal(openMenu(), null, 'and the menu closed behind the choice');
  } finally { h.teardown(); }
});

test('the empty-sequence dropslot still works — it dispatches tl-add for a clip', () => {
  // Overlay only: the seq row is empty, which is the only time the slot renders.
  const h = mount([overlay('o', 1, 1)]);
  try {
    const adds = recordAdds(h);
    const slot = h.root.querySelector('.tl-dropslot') as HTMLElement;
    assert.ok(slot, 'an empty seq row still offers "Add a clip"');
    click(slot);
    assert.deepEqual(adds, [{ kind: 'clip', atMs: 0 }]);
  } finally { h.teardown(); }
});

// ── the bar / chip context menu ───────────────────────────────────────────────

/** Right-click an element the way a browser does. */
function rightClick(el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 300 }));
}

test('right-clicking a scenery chip offers promotion, and it is ONE commit', () => {
  const h = mount([clip('a', 0, 3), scenery('s')]);
  try {
    rightClick(h.root.querySelector('.tl-chip[data-id="s"]')!);
    const menu = openMenu('.tl-ctx-menu');
    assert.ok(menu, 'a context menu opened');
    assert.deepEqual(menuLabels(menu), ['Add to the timeline', 'Delete'],
      'an untimed box is offered a time, not a split');
    click(menu!.querySelector('.folder-menu-item')!);
    assert.equal(h.commits.length, 1, 'ONE commit — the same promote() the inspector calls');
    const written = h.commits[0]!.find((b) => b.id === 's')!;
    assert.equal(written.start, 0, 'placed at the playhead');
    assert.equal(written.dur, 3, 'with the pack default length');
    assert.equal(written.lane, '', 'on an overlay lane, never the magnetic row');
    assert.equal(openMenu('.tl-ctx-menu'), null, 'the menu closed');
  } finally { h.teardown(); }
});

test('right-clicking a timed bar offers split + demote + delete, and demote is ONE commit', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), overlay('o', 1, 1)]);
  try {
    rightClick(h.bar('o'));
    const menu = openMenu('.tl-ctx-menu');
    assert.deepEqual(menuLabels(menu), ['Split at playhead', 'Make always on', 'Delete']);
    const demote = Array.from(menu!.querySelectorAll('.folder-menu-item'))
      .find((n) => n.textContent?.trim() === 'Make always on')!;
    click(demote);
    assert.equal(h.commits.length, 1, 'ONE commit — demote(), not a second implementation');
    const written = h.commits[0]!.find((b) => b.id === 'o')!;
    assert.equal(written.start, '', 'start CLEARED to empty, never a 0');
    assert.equal(written.dur, '');
    assert.equal(written.lane, '');
  } finally { h.teardown(); }
});

test('the context menu selects what it acts on, and Delete removes exactly that box', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    rightClick(h.bar('b'));
    assert.deepEqual(h.root.querySelector('.tl-clip[data-id="b"]')?.getAttribute('aria-selected'), 'true',
      'right-click selected the bar it opened on');
    const del = Array.from(openMenu('.tl-ctx-menu')!.querySelectorAll('.folder-menu-item'))
      .find((n) => n.textContent?.trim() === 'Delete')!;
    click(del);
    assert.equal(h.commits.length, 1, 'ONE commit');
    assert.deepEqual(h.commits[0]!.map((b) => b.id), ['a'], 'only b went');
  } finally { h.teardown(); }
});

test('right-clicking INSIDE a multi-selection collapses it to the clicked box', () => {
  // Every item in this menu acts on the right-clicked box alone. Leaving three bars
  // painted as selected while "Make always on" demotes one of them shows a state that
  // never existed, and the user's next act is an undo of something they did not do.
  const h = mount([clip('a', 0, 3), clip('b', 3, 2), overlay('o', 1, 1)]);
  try {
    h.select(['a', 'b', 'o']);
    rightClick(h.bar('b'));
    assert.deepEqual(
      Array.from(h.root.querySelectorAll('.tl-clip[aria-selected="true"]')).map((n) => (n as HTMLElement).dataset.id),
      ['b'],
      'the selection collapsed to the box the menu is about',
    );
    const demote = Array.from(openMenu('.tl-ctx-menu')!.querySelectorAll('.folder-menu-item'))
      .find((n) => n.textContent?.trim() === 'Make always on')!;
    click(demote);
    assert.equal(h.commits.length, 1, 'ONE commit');
    assert.equal(h.commits[0]!.find((b) => b.id === 'b')!.start, '', 'and only b was demoted');
    assert.equal(h.commits[0]!.find((b) => b.id === 'a')!.start, 0, 'a is untouched');
  } finally { h.teardown(); }
});

test('the context menu is keyboard reachable (Shift+F10) and Escape closes it', () => {
  const h = mount([clip('a', 0, 3), scenery('s')]);
  try {
    const el = h.bar('a');
    el.focus();
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    assert.ok(openMenu('.tl-ctx-menu'), 'Shift+F10 opens the menu on the focused bar');
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(openMenu('.tl-ctx-menu'), null, 'Escape closes it — the standing repo rule');
    assert.equal(h.commits.length, 0, 'opening and closing a menu edits nothing');
  } finally { h.teardown(); }
});

test('destroying the panel takes its body-mounted menus with it', () => {
  const h = mount([clip('a', 0, 3)]);
  try {
    click(h.root.querySelector('.tl-tools .tl-add')!);
    assert.ok(openMenu(), 'precondition: a menu is up');
  } finally { h.teardown(); }
  assert.equal(openMenu(), null, 'no orphan popover left on <body>');
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

// ── record-in-place voiceover (track C) ───────────────────────────────────────
//
// The panel's mic button opens a real host.recorder session, runs the playhead
// through the take, and lands the result as an audio box. What is asserted below is
// the OUTPUT: the committed Box[], the asset actually written to the host's user
// store, and the panel's own DOM. The host bridge is a stand-in (as `commit` already
// is) because it is the shell boundary this module talks through.
//
// BROWSER-ONLY, not covered here: whether the microphone permission prompt appears
// where a real user expects it, whether the take's audio is audible/clean, whether
// muting the composition actually stops sound reaching the mic, and the waveform the
// inserted bar paints (canvas 2D + a real decode). Those need a device.

/** The add-kinds a timed tool declares, WITH the manifest's audio seed. */
const AUDIO_KINDS = [
  { id: 'clip', label: 'Clip' },
  { id: 'audio', label: 'Sound', seed: { kind: 'audio' } },
];

interface FakeRecorder {
  host: unknown;
  /** Live microphone references held by the meter — must be 0 after every path. */
  meterRefs(): number;
  sessions(): number;
  cancels(): number;
  uploads(): Map<string, { type?: string; meta?: Record<string, unknown> }>;
  /** Let a gated (`gateMeter`) permission prompt resolve. */
  grant(): void;
  /** Let a held (`holdUpload`) asset write finish. */
  finishUpload(): void;
}

/**
 * A host bridge with a v1.17 recorder and a user-asset store, both in memory.
 *
 * `gateMeter` models the REAL meter's refcount contract (bridge/recorder.ts): the count is
 * taken synchronously, a follower shares the leader's in-flight `getUserMedia` promise, and
 * every resolved start owes exactly one stop. That contract is the only way to catch a take
 * whose continuation resumes after it was abandoned.
 * `holdUpload` keeps an asset write in flight so a save can be abandoned mid-flight.
 */
function fakeHost(opts: { deny?: boolean; bytes?: number; gateMeter?: boolean; holdUpload?: boolean } = {}): FakeRecorder {
  let refs = 0;
  let sessions = 0;
  let cancels = 0;
  let open = false;
  let starting: Promise<void> | null = null;
  let grant = (): void => { /* replaced when a gated start is in flight */ };
  let finishUpload = (): void => { /* replaced when a held upload is in flight */ };
  const uploads = new Map<string, { type?: string; meta?: Record<string, unknown> }>();
  const host = {
    log: () => { /* quiet */ },
    recorder: {
      isAvailable: () => true,
      meter: {
        start: async () => {
          if (opts.deny) { const e = new Error('denied') as Error & { name: string }; e.name = 'NotAllowedError'; throw e; }
          refs++;
          if (!opts.gateMeter || open) return;
          if (!starting) {
            starting = new Promise<void>((res) => { grant = () => { open = true; starting = null; res(); }; });
          }
          await starting;
        },
        stop: () => { refs = Math.max(0, refs - 1); if (refs === 0) open = false; },
        subscribe: () => () => { /* no levels in jsdom */ },
      },
      record: async () => {
        sessions++;
        return {
          subscribe: () => () => { /* no levels in jsdom */ },
          stop: async () => new Blob([new Uint8Array(opts.bytes ?? 2048)], { type: 'audio/webm;codecs=opus' }),
          cancel: () => { cancels++; },
        };
      },
      still: async () => new Blob([]),
    },
    assets: {
      get: async (id: string) => ({
        source: 'user', id, type: uploads.get(id)?.type ?? 'audio', format: 'webm',
        url: `blob:${id}`, meta: uploads.get(id)?.meta,
      }),
      _uploadUserAsset: async (record: { id: string; type?: string; meta?: Record<string, unknown> }) => {
        if (opts.holdUpload) await new Promise<void>((res) => { finishUpload = res; });
        uploads.set(record.id, record);
      },
      _deleteUserAsset: async (id: string) => { uploads.delete(id); },
    },
  };
  return {
    host, meterRefs: () => refs, sessions: () => sessions, cancels: () => cancels, uploads: () => uploads,
    grant: () => grant(), finishUpload: () => finishUpload(),
  };
}

/** Resolve when the panel announces it has reached `phase`. */
function takeReaches(root: HTMLElement, phase: string): Promise<void> {
  return new Promise((resolve) => {
    const on = (e: Event): void => {
      if ((e as CustomEvent).detail?.phase !== phase) return;
      root.removeEventListener('tl-take', on);
      resolve();
    };
    root.addEventListener('tl-take', on);
  });
}

/**
 * Paint the canvas boxes the clock (and the take's mute pass) reads. `data-seq-ms` is
 * what makes the clock playable at all — it refuses to run a zero-length sequence.
 */
function paintCanvasBoxes(h: Harness): HTMLElement[] {
  h.canvasEl.setAttribute('data-seq-ms', '10000');
  return h.boxes.map((b) => {
    const el = dom.window.document.createElement('div');
    el.className = 'lolly-box';
    el.setAttribute('data-box-id', String(b.id));
    h.canvasEl.appendChild(el);
    return el;
  });
}

/** Freeze the wall clock the take measures itself against. */
function fakeClock(): { set(ms: number): void; restore(): void } {
  const real = globalThis.performance.now;
  let at = 100000;
  globalThis.performance.now = () => at;
  return { set: (ms: number) => { at = ms; }, restore: () => { globalThis.performance.now = real; } };
}

test('the mic button needs a recording host and an audio add-kind — NOT a manifest capability', () => {
  // No recording host: the shipped default for every shell that cannot capture audio.
  const plain = mount([clip('a', 0, 3)], 40, AUDIO_KINDS);
  try {
    assert.equal((plain.root.querySelector('.tl-mic') as HTMLElement).hidden, true, 'no host.recorder → no button');
  } finally { plain.teardown(); }

  // A capable shell but no audio add-kind: a take would have no box to become.
  const noAudio = mount([clip('a', 0, 3)], 40, [{ id: 'clip', label: 'Clip' }], { host: fakeHost().host });
  try {
    assert.equal((noAudio.root.querySelector('.tl-mic') as HTMLElement).hidden, true, 'no audio add-kind → no button');
  } finally { noAudio.teardown(); }

  // Capable shell + audio vocabulary and NO declared capability — the shipping
  // sequence-studio manifest. Progressive enhancement, like host.media's live camera:
  // declaring `microphone` would mean "cannot run without a mic", which hides the tool
  // from the TUI gallery and drops it from the CLI smoke gate. Nothing opens the mic
  // until the button is pressed, so its presence risks no permission prompt.
  const ready = mount([clip('a', 0, 3)], 40, AUDIO_KINDS, { host: fakeHost().host });
  try {
    const mic = ready.root.querySelector('.tl-mic') as HTMLElement;
    assert.equal(mic.hidden, false, 'host + audio kind → the button is offered');
    assert.equal(mic.getAttribute('aria-pressed'), 'false');
  } finally { ready.teardown(); }
});

test('a completed take inserts ONE audio box at the playhead, with the MEASURED length', async () => {
  const fake = fakeHost();
  const clock = fakeClock();
  const countIn = TAKE_TIMING.countInMs;
  TAKE_TIMING.countInMs = 0;
  const h = mount([clip('a', 0, 5)], 40, AUDIO_KINDS, { host: fake.host, capabilities: ['microphone'] });
  const painted = paintCanvasBoxes(h);
  try {
    seekTo(h, 2);                        // the playhead sits at 2s (the shared ruler helper)
    const mic = h.root.querySelector('.tl-mic') as HTMLButtonElement;

    const live = takeReaches(h.root, 'recording');
    click(mic);
    await live;

    assert.equal(mic.getAttribute('aria-pressed'), 'true', 'the button reads as live');
    assert.equal((h.root.querySelector('.tl-rec') as HTMLElement).hidden, false, 'the take HUD is up');
    assert.equal(h.root.querySelector('.tl-play')?.getAttribute('aria-label'), 'Pause',
      'the playhead RUNS during the take — the transport says so');
    assert.ok(painted.every((el) => el.getAttribute('data-t-mute') === '1'),
      'the composition is silenced in the clock\'s own vocabulary while recording');
    assert.equal(h.commits.length, 0, 'nothing is written to the model until the take lands');

    clock.set(104200);                   // 4.2 s of take
    const done = takeReaches(h.root, 'idle');
    click(mic);
    await done;

    assert.equal(h.commits.length, 1, 'ONE commit for the insertion — one undo step');
    const next = h.commits[0]!;
    assert.equal(next.length, 2, 'exactly one box was added');
    const box = next.find((b) => b.id !== 'a')!;
    assert.equal(box.kind, 'audio', 'born from the manifest\'s audio add-kind seed');
    assert.equal(box.start, 2, 'placed where the playhead was when the take began');
    assert.equal(box.dur, 4.2, 'the MEASURED elapsed length, not the blob\'s');

    const ref = box.image as { id: string; type: string };
    assert.match(ref.id, /^user\/recording\/\d+\.webm$/, 'stored as a durable user asset');
    const stored = fake.uploads().get(ref.id)!;
    assert.equal(stored.type, 'audio', 'typed audio, not a silent video');
    assert.equal(stored.meta?.durationMs, 4200,
      'meta.durationMs is what becomes data-audio-dur — without it the box cannot be trimmed');

    assert.equal(fake.meterRefs(), 0, 'the sound-check microphone reference was released');
    assert.ok(painted.every((el) => !el.hasAttribute('data-t-mute')), 'the composition is audible again');
    assert.equal((h.root.querySelector('.tl-rec') as HTMLElement).hidden, true, 'the HUD is gone');
    assert.equal(mic.getAttribute('aria-pressed'), 'false');
  } finally { h.teardown(); TAKE_TIMING.countInMs = countIn; clock.restore(); }
});

test('re-taking over a selected take REPLACES its asset in one commit', async () => {
  const fake = fakeHost();
  const clock = fakeClock();
  const countIn = TAKE_TIMING.countInMs;
  TAKE_TIMING.countInMs = 0;
  const existing: Box = {
    id: 'vo', start: 1, dur: 3, lane: '', clipIn: 1.5, kind: 'audio',
    image: { source: 'user', id: 'user/recording/1.webm', type: 'audio', url: 'blob:old' } as never,
  };
  const h = mount([clip('a', 0, 5), existing], 40, AUDIO_KINDS, { host: fake.host, capabilities: ['microphone'] });
  try {
    h.select(['vo']);
    const mic = h.root.querySelector('.tl-mic') as HTMLButtonElement;
    assert.equal(mic.getAttribute('aria-label'), 'Record over this take',
      'the button says what the next press will do');

    const live = takeReaches(h.root, 'recording');
    click(mic);
    await live;
    clock.set(101800);
    const done = takeReaches(h.root, 'idle');
    click(mic);
    await done;

    assert.equal(h.commits.length, 1, 'ONE commit for the replacement — one undo step');
    const next = h.commits[0]!;
    assert.equal(next.length, 2, 'no box was added; the existing one was rewritten');
    const box = next.find((b) => b.id === 'vo')!;
    const ref = box.image as { id: string };
    assert.notEqual(ref.id, 'user/recording/1.webm', 'the asset was swapped');
    assert.equal(box.dur, 1.8, 'and re-fitted to the new take\'s measured length');
    assert.equal(box.clipIn, 0, 'the old trim-in pointed into audio that no longer exists');
    assert.equal(box.start, 1, 'the box stays where it was');
    assert.equal(fake.uploads().has('user/recording/1.webm'), false, 'the superseded take was retired');
  } finally { h.teardown(); TAKE_TIMING.countInMs = countIn; clock.restore(); }
});

test('a denied microphone leaves no recording state and says so', async () => {
  const fake = fakeHost({ deny: true });
  const h = mount([clip('a', 0, 3)], 40, AUDIO_KINDS, { host: fake.host, capabilities: ['microphone'] });
  const painted = paintCanvasBoxes(h);
  try {
    const mic = h.root.querySelector('.tl-mic') as HTMLButtonElement;
    const done = takeReaches(h.root, 'idle');
    click(mic);
    await done;

    assert.equal(mic.getAttribute('aria-pressed'), 'false', 'the button is not stuck in the pressed state');
    assert.equal(mic.disabled, false, 'and it is pressable again');
    assert.equal((h.root.querySelector('.tl-rec') as HTMLElement).hidden, true, 'no HUD left behind');
    const note = h.root.querySelector('.tl-rec-note') as HTMLElement;
    assert.equal(note.hidden, false);
    assert.match(note.textContent || '', /Microphone blocked/, 'the user is told what happened');
    assert.equal(fake.sessions(), 0, 'no recorder session was ever opened');
    assert.equal(fake.meterRefs(), 0, 'no microphone reference is held');
    assert.equal(h.commits.length, 0, 'nothing was written to the model');
    assert.ok(painted.every((el) => !el.hasAttribute('data-t-mute')), 'the composition was never left muted');
  } finally { h.teardown(); }
});

test('destroying the panel mid-take releases the microphone and writes nothing', async () => {
  const fake = fakeHost();
  const countIn = TAKE_TIMING.countInMs;
  TAKE_TIMING.countInMs = 0;
  const h = mount([clip('a', 0, 3)], 40, AUDIO_KINDS, { host: fake.host, capabilities: ['microphone'] });
  const painted = paintCanvasBoxes(h);
  try {
    const live = takeReaches(h.root, 'recording');
    click(h.root.querySelector('.tl-mic')!);
    await live;
    assert.equal(fake.sessions(), 1, 'precondition: a session is running');

    h.panel.destroy();

    assert.equal(fake.cancels(), 1, 'the session was cancelled, not left running');
    assert.equal(fake.meterRefs(), 0, 'no microphone reference survived the panel');
    assert.ok(painted.every((el) => !el.hasAttribute('data-t-mute')), 'the canvas was handed back unmuted');
    assert.equal(h.commits.length, 0, 'an abandoned take writes nothing');
    await frames(3);
    assert.equal(h.commits.length, 0, 'and still nothing a few frames later');
  } finally { h.teardown(); TAKE_TIMING.countInMs = countIn; }
});

test('pressing the mic through a slow permission prompt never leaves a microphone reference held', async () => {
  // The leak that a phase STRING cannot catch. Press 1 opens the prompt; press 2 abandons
  // that take while the prompt is still up; press 3 starts a fresh one. When the permission
  // finally lands, take 1's continuation resumes and sees a phase of 'countin' — take 3's.
  // Identity, not phase, has to decide, and each continuation may release only the meter
  // reference it took itself: the real meter tears the mic down at refcount 0 ONLY, so a
  // single unbalanced reference keeps the browser's recording indicator lit until reload.
  const fake = fakeHost({ gateMeter: true });
  const countIn = TAKE_TIMING.countInMs;
  TAKE_TIMING.countInMs = 0;
  const h = mount([clip('a', 0, 3)], 40, AUDIO_KINDS, { host: fake.host });
  try {
    const mic = h.root.querySelector('.tl-mic') as HTMLButtonElement;
    click(mic);                       // press 1 — waiting on the prompt
    await frames(1);
    click(mic);                       // press 2 — abandoned mid-prompt
    await frames(1);
    click(mic);                       // press 3 — a new take, same in-flight prompt

    const live = takeReaches(h.root, 'recording');
    fake.grant();
    await live;
    assert.equal(fake.sessions(), 1, 'exactly ONE recorder session — never two at once');

    const done = takeReaches(h.root, 'idle');
    click(mic);
    await done;
    await frames(2);
    assert.equal(fake.meterRefs(), 0, 'every meter reference was balanced — the mic is off');
    assert.equal(h.commits.length, 1, 'and one take landed, not two');
  } finally { h.teardown(); TAKE_TIMING.countInMs = countIn; }
});

test('a re-take abandoned while it saves keeps the OLD recording and commits nothing', async () => {
  // Storing the new take must not delete the take it replaces until the model has been
  // patched: abandon the save in between and the box is left pointing at an asset that no
  // longer exists. Nor may the pending insert land in a panel the user has already closed.
  const fake = fakeHost({ holdUpload: true });
  const clock = fakeClock();
  const countIn = TAKE_TIMING.countInMs;
  TAKE_TIMING.countInMs = 0;
  const existing: Box = {
    id: 'vo', start: 1, dur: 3, lane: '', clipIn: 0, kind: 'audio',
    image: { source: 'user', id: 'user/recording/111.webm', type: 'audio', url: 'blob:old' } as never,
  };
  const h = mount([clip('a', 0, 5), existing], 40, AUDIO_KINDS, { host: fake.host });
  fake.uploads().set('user/recording/111.webm', { type: 'audio' });   // the take already on disk
  try {
    h.select(['vo']);
    const live = takeReaches(h.root, 'recording');
    click(h.root.querySelector('.tl-mic')!);
    await live;
    clock.set(101500);
    click(h.root.querySelector('.tl-mic')!);   // stop → the upload is now held
    await frames(2);

    h.panel.setOpen(false);                    // the user closes the timeline mid-save
    fake.finishUpload();
    await frames(4);

    assert.equal(h.commits.length, 0, 'an abandoned save commits nothing');
    assert.equal(fake.uploads().has('user/recording/111.webm'), true,
      'and the recording it would have replaced is still there');
    assert.equal(fake.meterRefs(), 0, 'no microphone reference survived');
  } finally { h.teardown(); TAKE_TIMING.countInMs = countIn; clock.restore(); }
});

test('a VIDEO in the user/recording namespace is never offered as a take to record over', () => {
  // The record tool and screen capture mint `user/recording/<ts>.mp4` VIDEO assets through
  // the same store. Matching on the id prefix alone would offer to record over one — and
  // the replace path patches the box to an audio ref and deletes the source file.
  const fake = fakeHost();
  const shot: Box = {
    id: 'screen', start: 0, dur: 4, lane: 'seq', clipIn: 0, kind: 'clip',
    image: { source: 'user', id: 'user/recording/222.mp4', type: 'video', url: 'blob:vid' } as never,
  };
  const h = mount([shot], 40, AUDIO_KINDS, { host: fake.host });
  try {
    h.select(['screen']);
    const mic = h.root.querySelector('.tl-mic') as HTMLButtonElement;
    assert.equal(mic.getAttribute('aria-label'), 'Record a voiceover',
      'a screen/camera recording is not one of our takes — recording adds a box, never overwrites it');
  } finally { h.teardown(); }
});

// ── thumbnails: the branch each bar actually takes ────────────────────────────

/**
 * Fill the canvas with the markup each box kind really renders (sequence-studio's
 * hooks.js, verbatim in shape): an audio marker div, a <video>, a Lottie MARKER with
 * its mounted <svg>, a plain <img>, and a card that is nothing but a background.
 * This is what `mediaOf` reads — the panel classifies boxes off the LIVE CANVAS, not
 * off the model, because the hook is what resolved the asset ref to a URL.
 */
function paintMediaBoxes(h: Harness, media: Record<string, string>): void {
  h.canvasEl.setAttribute('data-seq-ms', '10000');
  for (const b of h.boxes) {
    const el = dom.window.document.createElement('div');
    el.className = 'lolly-box';
    el.setAttribute('data-box-id', String(b.id));
    el.innerHTML = media[String(b.id)] ?? '';
    h.canvasEl.appendChild(el);
  }
}

interface CtxOp { op: string; args: unknown[] }

/**
 * jsdom has no layout and no 2D context, which is exactly the two things a thumb pass
 * needs. Give every bar a size and every canvas a RECORDING context, so what the pass
 * decided is observable. The drawing itself is still a browser fact — what is asserted
 * here is which branch ran and with what.
 */
async function withThumbStubs(fn: (ops: Map<HTMLCanvasElement, CtxOp[]>) => Promise<void>): Promise<void> {
  const w = dom.window as unknown as {
    Element: { prototype: Element };
    HTMLCanvasElement: { prototype: HTMLCanvasElement };
  };
  const ops = new Map<HTMLCanvasElement, CtxOp[]>();
  const elProto = w.Element.prototype;
  const saved = ['clientWidth', 'clientHeight'].map((k) => [k, Object.getOwnPropertyDescriptor(elProto, k)] as const);
  // Bars only: `tracks.clientWidth` is an own property set by mount() and still wins.
  for (const [k, size] of [['clientWidth', 120], ['clientHeight', 34]] as const) {
    Object.defineProperty(elProto, k, {
      configurable: true,
      get(this: Element) { return this.classList?.contains('tl-clip') ? size : 0; },
    });
  }
  const canvasProto = w.HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  const realGetContext = canvasProto.getContext;
  canvasProto.getContext = function (this: HTMLCanvasElement) {
    const log: CtxOp[] = ops.get(this) ?? [];
    ops.set(this, log);
    const rec = (op: string) => (...args: unknown[]): void => { log.push({ op, args }); };
    return {
      scale: rec('scale'), clearRect: rec('clearRect'), fillRect: rec('fillRect'),
      drawImage: rec('drawImage'),
      set fillStyle(v: string) { log.push({ op: 'fillStyle', args: [v] }); },
      get fillStyle() { return '#000'; },
    };
  } as never;
  try {
    // AWAITED inside the try, not returned out of it: a synchronous finally would put
    // the real descriptors back before the deferred pass this exists to observe ran.
    await fn(ops);
  } finally {
    canvasProto.getContext = realGetContext as never;
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(elProto, k, desc);
      else delete (elProto as unknown as Record<string, unknown>)[k];
    }
  }
}

const thumbCanvas = (h: Harness, id: string): HTMLCanvasElement =>
  h.root.querySelector(`.tl-clip[data-id="${id}"] canvas.tl-clip-thumbs`) as HTMLCanvasElement;

/** Wait past the thumb pass's idle timeout (onIdle's setTimeout fallback in node). */
const thumbPass = (): Promise<void> => new Promise((r) => setTimeout(r, 120));

test('every clip kind is classified off the live canvas — including a Lottie and a tool clip', async () => {
  const h = mount([clip('img', 0, 1), clip('tool', 1, 1), clip('anim', 2, 1), clip('card', 3, 1), overlay('snd', 0, 2)]);
  try {
    paintMediaBoxes(h, {
      img: '<img class="lolly-box-img" src="https://x.test/photo.png">',
      // A tool clip is a compose render: an ordinary <img> holding a data: URL.
      tool: '<img class="lolly-box-img" src="data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E">',
      // The Lottie MARKER also carries .lolly-box-img — a naive `img.lolly-box-img`
      // lookup misses it (it is a div), which is why it gets its own branch.
      anim: '<div class="lolly-box-img lolly-box-lottie" data-lottie-src="anim.json"><svg viewBox="0 0 100 50"></svg></div>',
      card: '',
      snd: '<div class="lolly-box-audio" data-audio-src="bed.mp3" data-audio-dur="4000"></div>',
    });
    // Force the rebuild that re-reads the canvas (the boxes were painted after mount).
    h.panel.setOpen(false);
    h.panel.setOpen(true);

    assert.equal(h.bar('img').dataset.kind, 'image');
    assert.equal(h.bar('tool').dataset.kind, 'image', 'a tool clip needs no kind of its own');
    assert.equal(h.bar('anim').dataset.kind, 'lottie', 'an animation is no longer an untyped clip');
    assert.equal(h.bar('card').dataset.kind, 'clip', 'no media: the lane kind, as before');
    assert.equal(h.bar('snd').dataset.kind, 'audio');
    // The label follows the same classification.
    assert.equal(h.bar('anim').querySelector('.tl-clip-label')?.textContent, 'Animation');
    assert.equal(h.bar('img').querySelector('.tl-clip-label')?.textContent, 'Image');
  } finally { h.teardown(); }
});

test('a card bar paints its own fill IMMEDIATELY, and an inkless box still paints nothing', async () => {
  // The underlay half of node mode. The fill goes down synchronously, before any await,
  // so a frame bar is never blank while its photograph is being taken — and because the
  // upgrade overwrites the same canvas and `has-thumbs` is only ever ADDED, there is no
  // flash between the two. The photograph itself is the next test; here there is no
  // rasteriser installed and no createImageBitmap, so the capture bails and the
  // underlay is all that ever lands.
  await withThumbStubs(async (ops) => {
    const h = mount([clip('card', 0, 2), clip('ghost', 2, 2)]);
    try {
      paintMediaBoxes(h, { card: '', ghost: '' });
      // The card's fill is the same inline background the box paints on the frame.
      const cardBox = h.canvasEl.querySelector('[data-box-id="card"]') as HTMLElement;
      cardBox.style.background = 'rgb(20, 24, 29)';
      h.panel.setOpen(false);
      h.panel.setOpen(true);
      await thumbPass();

      const card = ops.get(thumbCanvas(h, 'card')) ?? [];
      assert.deepEqual(card.filter((o) => o.op === 'fillStyle').map((o) => o.args[0]), ['rgb(20, 24, 29)'],
        'the bar is filled with the box’s own colour, not a made-up one');
      assert.equal(card.some((o) => o.op === 'fillRect'), true);
      assert.equal(h.bar('card').classList.contains('has-thumbs'), true, 'so the label gets its scrim');

      // A box with no media, no fill, no text and no shape is left alone: photographing
      // it would cost a full dom-to-image call to produce a blank bitmap, and an
      // invisible rectangle must not claim has-thumbs (which would dress the label in a
      // scrim over nothing).
      assert.equal(ops.has(thumbCanvas(h, 'ghost')), false, 'no context was even asked for');
      assert.equal(h.bar('ghost').classList.contains('has-thumbs'), false);
    } finally { h.teardown(); }
  });
});

/**
 * Node mode end to end, with the dom-to-image shot faked through `_setNodeRasterer`.
 *
 * There is no rasteriser in node at all, so the seam is the only way to reach the
 * branch — what is asserted is the panel's USE of it (which bars ask, how many, when it
 * re-asks, what happens when it fails), never what the picture looks like.
 *
 * `createImageBitmap` is the other platform piece jsdom lacks: `captureNode` bails
 * before it even looks at the rasterer without one.
 */
async function withNodeRaster(
  shot: (el: HTMLElement, targetH: number) => Promise<{ width: number; height: number } | null>,
  fn: (calls: string[]) => Promise<void>,
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const hadCib = Object.hasOwn(g, 'createImageBitmap');
  const prevCib = g.createImageBitmap;
  g.createImageBitmap = async (cv: { width: number; height: number }) => ({ width: cv.width, height: cv.height, close(): void { /* fake */ } });
  const calls: string[] = [];
  _setNodeRasterer(async (el, targetH) => {
    calls.push(String((el as HTMLElement).getAttribute?.('data-box-id') ?? ''));
    return (await shot(el as HTMLElement, targetH)) as HTMLCanvasElement | null;
  });
  // The LRU is module-global and node rasters are keyed by APPEARANCE, not by id — two
  // tests with identically-shaped boxes would otherwise share a cached picture.
  clearClipThumbCache();
  try {
    await fn(calls);
  } finally {
    _setNodeRasterer(null);
    clearClipThumbCache();
    if (hadCib) g.createImageBitmap = prevCib; else delete g.createImageBitmap;
  }
}

/** A fake shot: a landscape canvas twice as wide as the requested bar height. */
const okShot = async (_el: HTMLElement, targetH: number): Promise<{ width: number; height: number }> =>
  ({ width: targetH * 2, height: targetH });

test('a frame bar upgrades from its fill to a photograph of the box', async () => {
  await withNodeRaster(okShot, async (calls) => {
    await withThumbStubs(async (ops) => {
      const h = mount([clip('card', 0, 2)]);
      try {
        paintMediaBoxes(h, { card: '' });
        (h.canvasEl.querySelector('[data-box-id="card"]') as HTMLElement).style.background = 'rgb(20, 24, 29)';
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        await thumbPass();
        await thumbPass();                     // the shot is async; let it land

        const card = ops.get(thumbCanvas(h, 'card')) ?? [];
        assert.deepEqual(calls, ['card'], 'the box itself was photographed, not the bar');
        assert.equal(card.some((o) => o.op === 'fillRect'), true, 'the underlay went down first');
        // Tiled, not stretched — one bitmap, the same arithmetic as a still: a 68×34
        // picture on a 120px bar is two tiles.
        const draws = card.filter((o) => o.op === 'drawImage');
        assert.deepEqual(draws.map((o) => o.args.slice(1)), [[0, 0, 68, 34], [68, 0, 68, 34]]);
        assert.equal(h.bar('card').classList.contains('has-thumbs'), true);
      } finally { h.teardown(); }
    });
  });
});

test('a TRANSPARENT text box and a pen shape get pictures — before this they painted nothing', async () => {
  await withNodeRaster(okShot, async (calls) => {
    await withThumbStubs(async (ops) => {
      // Rows that differ in APPEARANCE, not just in id: the signature deliberately
      // leaves the id out, so two boxes that look identical share one shot (and one
      // cache entry) — which is right, but would hide the second bar here.
      const h = mount([
        { ...clip('words', 0, 2), text: 'Chapter one' },
        { ...clip('shape', 2, 2), kind: 'path', d: 'M0 0 L10 10' },
      ]);
      try {
        // No background on either: a text box's default fill is '' and hooks.js FORCES
        // every kind:'path' box to fill:'transparent'. Both used to reach 'none'.
        paintMediaBoxes(h, {
          words: '<div class="lolly-box-text">Chapter one</div>',
          shape: '<svg class="lolly-box-path"><path d="M0 0 L10 10"/></svg>',
        });
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        await thumbPass();
        await thumbPass();

        assert.deepEqual(calls.slice().sort(), ['shape', 'words']);
        for (const id of ['words', 'shape']) {
          const log = ops.get(thumbCanvas(h, id)) ?? [];
          assert.equal(log.some((o) => o.op === 'fillRect'), false, `${id}: nothing to underlay — it is transparent`);
          assert.equal(log.some((o) => o.op === 'drawImage'), true, `${id}: got a picture`);
          assert.equal(h.bar(id).classList.contains('has-thumbs'), true, `${id}: scrim`);
        }
      } finally { h.teardown(); }
    });
  });
});

test('a failed photograph leaves the underlay standing rather than blanking the bar', async () => {
  await withNodeRaster(async () => null, async (calls) => {
    await withThumbStubs(async (ops) => {
      const h = mount([clip('card', 0, 2), clip('words', 2, 2)]);
      try {
        paintMediaBoxes(h, { card: '', words: '<div class="lolly-box-text">Chapter one</div>' });
        (h.canvasEl.querySelector('[data-box-id="card"]') as HTMLElement).style.background = 'rgb(20, 24, 29)';
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        await thumbPass();
        await thumbPass();

        assert.equal(calls.length > 0, true, 'it did try');
        const card = ops.get(thumbCanvas(h, 'card')) ?? [];
        assert.deepEqual(card.filter((o) => o.op === 'fillStyle').map((o) => o.args[0]), ['rgb(20, 24, 29)']);
        assert.equal(card.some((o) => o.op === 'drawImage'), false, 'no picture, but the fill survived');
        assert.equal(h.bar('card').classList.contains('has-thumbs'), true);
        // The transparent one has nothing to fall back TO, so it stays undressed — a
        // scrim over an empty canvas would be worse than no scrim.
        assert.equal(h.bar('words').classList.contains('has-thumbs'), false);
      } finally { h.teardown(); }
    });
  });
});

test('a crowded timeline is bounded: the pass budget refuses to queue one shot per bar', async () => {
  // The stall this prevents: sixty frames × one uncancellable dom-to-image call each,
  // serialised behind one lock. Only MAX_NODE_RASTERS_PER_PASS misses are started per
  // pass, and at most MAX_THUMB_PASSES passes chain, so one scheduling can never spend
  // more than the product — the row past that keeps its fill until the next gesture.
  await withNodeRaster(okShot, async (calls) => {
    await withThumbStubs(async () => {
      // Each box must LOOK different, or the shared-run dedup would collapse sixty
      // asks into one shot and prove nothing about the budget.
      const many = Array.from({ length: 60 }, (_, i) => ({ ...clip(`f${i}`, i, 1), bg: `rgb(1, 2, ${i})` }));
      const h = mount(many);
      try {
        paintMediaBoxes(h, {});
        for (let i = 0; i < 60; i++) {
          (h.canvasEl.querySelector(`[data-box-id="f${i}"]`) as HTMLElement).style.background = `rgb(1, 2, ${i})`;
        }
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        for (let i = 0; i < 12; i++) await thumbPass();   // well past every chained pass

        assert.ok(calls.length > 0, 'some frames did get pictures');
        assert.ok(calls.length <= MAX_NODE_RASTERS_PER_PASS * MAX_THUMB_PASSES,
          `bounded work: ${calls.length} shots for 60 bars`);
        assert.ok(calls.length < 60, 'a sixty-frame row never queues sixty shots');
        assert.equal(new Set(calls).size, calls.length, 'and never the same box twice');
      } finally { h.teardown(); }
    });
  });
});

test('a twenty-frame row CONVERGES: every bar is photographed, once, without a gesture', async () => {
  // The other half of the bound, and the one that was broken. Two compounding bugs made
  // a twenty-frame row give up part-finished: the chain capped at 3 passes × 6 = 18
  // shots, and — worse — a continuation pass counted bars whose shot was still IN
  // FLIGHT as misses, so it re-spent its whole budget on them and the bars it was
  // queued to reach were skipped again, pass after pass. Nothing else re-runs a pass,
  // so those bars stayed blank until the user happened to drag something.
  await withNodeRaster(okShot, async (calls) => {
    await withThumbStubs(async () => {
      const many = Array.from({ length: 20 }, (_, i) => ({ ...clip(`f${i}`, i, 1), bg: `rgb(3, 4, ${i})` }));
      const h = mount(many);
      try {
        paintMediaBoxes(h, {});
        for (let i = 0; i < 20; i++) {
          (h.canvasEl.querySelector(`[data-box-id="f${i}"]`) as HTMLElement).style.background = `rgb(3, 4, ${i})`;
        }
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        for (let i = 0; i < 12; i++) await thumbPass();

        assert.equal(new Set(calls).size, 20, `every frame got its own photograph (${calls.length} shots)`);
        assert.equal(calls.length, 20, 'and none was taken twice');
      } finally { h.teardown(); }
    });
  });
});

test('a box that cannot be photographed is retired, not retried on every pass forever', async () => {
  // A tainted canvas (a cross-origin image with no CORS headers) or a subtree that runs
  // past NODE_RASTER_TIMEOUT_MS comes back with nothing, every time. Before the failure
  // was remembered, the six bars in front spent the whole budget re-learning it on every
  // pass of every scheduling, and the bars behind them were never reached at all.
  const failShot = async (): Promise<null> => null;
  await withNodeRaster(failShot, async (calls) => {
    await withThumbStubs(async () => {
      const h = mount([clip('bad', 0, 2), clip('good', 2, 2)]);
      try {
        paintMediaBoxes(h, { bad: '', good: '' });
        for (const id of ['bad', 'good']) {
          (h.canvasEl.querySelector(`[data-box-id="${id}"]`) as HTMLElement).style.background = 'rgb(9, 9, 9)';
        }
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        for (let i = 0; i < 6; i++) await thumbPass();
        const first = calls.length;
        assert.ok(first > 0 && first <= 2, `one attempt per bar, not per pass (${first})`);

        // A fresh scheduling (what any drag, zoom or fit does) must not re-open it.
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        for (let i = 0; i < 4; i++) await thumbPass();
        assert.equal(calls.length, first, 'a hopeless bar costs exactly one shot, ever');
      } finally { h.teardown(); }
    });
  });
});

test('editing a card’s text re-photographs its bar — a stale picture would LIE about the box', async () => {
  // `tracksKey` is id/lane/timed only, so a text or colour edit took the restyle branch
  // and never re-ran a thumb pass: the bar went on showing a photograph of the old
  // words indefinitely. Timing is excluded from the appearance key on purpose, so this
  // must NOT fire for a drag — the case below.
  await withNodeRaster(okShot, async (calls) => {
    await withThumbStubs(async () => {
      const h = mount([{ ...clip('card', 0, 2), text: 'Chapter one' }]);
      try {
        paintMediaBoxes(h, { card: '<div class="lolly-box-text">Chapter one</div>' });
        (h.canvasEl.querySelector('[data-box-id="card"]') as HTMLElement).style.background = 'rgb(20, 24, 29)';
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        await thumbPass();
        assert.equal(calls.length, 1);

        // A drag: the model row's timing moved, its appearance did not.
        h.boxes[0]!.start = 1;
        h.notify();
        await frames(2);
        await thumbPass();
        assert.equal(calls.length, 1, 'a drag re-uses the picture it already has');

        // The sidebar edit.
        h.boxes[0]!.text = 'Chapter two';
        h.notify();
        await frames(2);
        await thumbPass();
        assert.equal(calls.length, 2, 'new words, new photograph');
      } finally { h.teardown(); }
    });
  });
});

test('a second pass reuses the cached photograph, and a DRAG does not invalidate it', async () => {
  await withNodeRaster(okShot, async (calls) => {
    await withThumbStubs(async () => {
      const h = mount([clip('card', 0, 2)]);
      try {
        paintMediaBoxes(h, { card: '' });
        (h.canvasEl.querySelector('[data-box-id="card"]') as HTMLElement).style.background = 'rgb(20, 24, 29)';
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        await thumbPass();
        await thumbPass();
        assert.equal(calls.length, 1);

        // An unchanged rebuild: the LRU answers, no shot.
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        await thumbPass();
        await thumbPass();
        assert.equal(calls.length, 1, 'the cache served it');

        // A drag rewrites start/dur on the row. The picture has not changed one pixel,
        // and re-shooting every bar a ripple touched is exactly what appearanceSig
        // exists to prevent.
        h.boxes[0]!.start = 5;
        h.boxes[0]!.dur = 3;
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        await thumbPass();
        await thumbPass();
        assert.equal(calls.length, 1, 'moving a clip is not a new picture');

        // Recolouring the box IS a new picture.
        (h.canvasEl.querySelector('[data-box-id="card"]') as HTMLElement).style.background = 'rgb(90, 10, 10)';
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        await thumbPass();
        await thumbPass();
        assert.equal(calls.length, 2, 'a repaint of the box is a repaint of the bar');
      } finally { h.teardown(); }
    });
  });
});

test('a gesture aborts a queued pass before a single photograph is taken', async () => {
  await withNodeRaster(okShot, async (calls) => {
    await withThumbStubs(async () => {
      const h = mount([clip('card', 0, 2)]);
      try {
        paintMediaBoxes(h, { card: '' });
        (h.canvasEl.querySelector('[data-box-id="card"]') as HTMLElement).style.background = 'rgb(9, 9, 9)';
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        h.bar('card').dispatchEvent(pointer('pointerdown', 40 + EDGE_PX + 4));
        await thumbPass();
        assert.deepEqual(calls, [], 'a drag must never compete with a dom-to-image shot');

        h.root.dispatchEvent(pointer('pointerup', 40 + EDGE_PX + 4));
        await thumbPass();
        await thumbPass();
        assert.deepEqual(calls, ['card'], 'and the pass after the gesture does take it');
      } finally { h.teardown(); }
    });
  });
});

test('an export suspends node rasters entirely, and caches nothing while it holds them', async () => {
  // dom-to-image-more keeps MODULE-GLOBAL options / url cache / sandbox iframe and
  // clears them at the end of ANY call, so a thumbnail shot overlapping an export
  // corrupts both pictures. Nothing is cached while suspended either, or the bar would
  // remember the blank forever.
  const { suspendNodeRasters } = await import('../lib/clip-thumbs.ts');
  await withNodeRaster(okShot, async (calls) => {
    await withThumbStubs(async () => {
      const h = mount([clip('card', 0, 2)]);
      const release = suspendNodeRasters();
      try {
        paintMediaBoxes(h, { card: '' });
        (h.canvasEl.querySelector('[data-box-id="card"]') as HTMLElement).style.background = 'rgb(20, 24, 29)';
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        await thumbPass();
        await thumbPass();
        assert.deepEqual(calls, [], 'the export owns the rasteriser');

        release();
        h.panel.setOpen(false);
        h.panel.setOpen(true);
        await thumbPass();
        await thumbPass();
        assert.deepEqual(calls, ['card'], 'and the bar retries once it is free');
      } finally { release(); h.teardown(); }
    });
  });
});

test('a thumb pass is idle-scheduled and a gesture aborts it before anything paints', async () => {
  await withThumbStubs(async (ops) => {
    const h = mount([clip('card', 0, 2)]);
    try {
      paintMediaBoxes(h, { card: '' });
      (h.canvasEl.querySelector('[data-box-id="card"]') as HTMLElement).style.background = 'rgb(9, 9, 9)';
      h.panel.setOpen(false);
      h.panel.setOpen(true);
      // Nothing has painted yet: the pass is deferred, never run inside the rebuild.
      assert.equal(ops.size, 0, 'the pass waits for an idle moment');

      // A drag begins. abortThumbs() runs on pointerdown, so the queued pass is dropped
      // rather than competing with the gesture for the main thread.
      const el = h.bar('card');
      el.dispatchEvent(pointer('pointerdown', 40 + EDGE_PX + 4));
      await thumbPass();
      assert.equal(ops.size, 0, 'the aborted pass never touched a canvas');

      // Releasing schedules a fresh pass, which does paint.
      h.root.dispatchEvent(pointer('pointerup', 40 + EDGE_PX + 4));
      await thumbPass();
      assert.equal(ops.size, 1, 'the pass after the gesture runs');
      assert.equal(h.bar('card').classList.contains('has-thumbs'), true);
    } finally { h.teardown(); }
  });
});

test('an image bar TILES one still across its width rather than stretching it', async () => {
  await withThumbStubs(async (ops) => {
    // A decoded picture and a bitmap factory — the two platform pieces jsdom lacks. The
    // TILING is the panel's own arithmetic, and that is what is asserted.
    const g = globalThis as Record<string, unknown>;
    const hadCib = Object.hasOwn(g, 'createImageBitmap');
    const prevCib = g.createImageBitmap;
    g.createImageBitmap = async (cv: HTMLCanvasElement) => ({ width: cv.width, height: cv.height, close(): void { /* fake */ } });
    const h = mount([clip('shot', 0, 3)]);
    try {
      paintMediaBoxes(h, { shot: '<img class="lolly-box-img" src="https://x.test/tiled-still.png">' });
      const img = h.canvasEl.querySelector('img') as HTMLImageElement;
      Object.defineProperty(img, 'complete', { value: true });
      Object.defineProperty(img, 'naturalWidth', { value: 100 });
      Object.defineProperty(img, 'naturalHeight', { value: 50 });
      h.panel.setOpen(false);
      h.panel.setOpen(true);
      await thumbPass();
      await thumbPass();                       // the capture is async; let it land

      const bar = thumbCanvas(h, 'shot');
      const draws = (ops.get(bar) ?? []).filter((o) => o.op === 'drawImage');
      // A 100×50 picture at a 34px bar height is a 68px tile, so a 120px bar shows two.
      assert.deepEqual(draws.map((o) => o.args.slice(1)), [[0, 0, 68, 34], [68, 0, 68, 34]],
        'consecutive tiles at the asset’s own aspect — never one stretched thumbnail');
      assert.equal(h.bar('shot').classList.contains('has-thumbs'), true);
    } finally {
      h.teardown();
      if (hadCib) g.createImageBitmap = prevCib; else delete g.createImageBitmap;
    }
  });
});

// ── THE ONE RULE: selecting in the timeline keeps the selection LIVE ──────────
//
// free-canvas.ts's header states it verbatim. The panel owns exactly one half:
// "selecting in the timeline moves the playhead so the selection stays live" — the
// converse (time rewriting the selection) is the Premiere failure and is deliberately
// NOT implemented. `selectAndReveal` is the single writer; every route into a
// selection goes through it, so what is checked below is the behaviour, not a call.
//
// The clock applies a seek on the next frame, so the assertions read the playhead
// element the tick paints rather than reaching into the clock.

// `frames()` (above) is what lets the clock's rAF-coalesced apply pass — and the
// onTick fan-out that paints the playhead — actually run.
const playheadPx = (h: Harness): number =>
  parseFloat((h.root.querySelector('.tl-playhead') as HTMLElement).style.left || '0');

test('clicking a clip the playhead is NOT inside moves the playhead to it, once', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    await frames(3);
    assert.equal(playheadPx(h), 0, 'precondition: the playhead is at 0s, inside clip a');
    h.selSets.length = 0;

    const el = h.bar('b');                       // 3s → 5s, i.e. 120px → 200px
    el.dispatchEvent(pointer('pointerdown', 120 + EDGE_PX + 4));
    h.root.dispatchEvent(pointer('pointerup', 120 + EDGE_PX + 4));
    await frames(3);

    assert.deepEqual(h.selSets, [['b']], 'the selection was written exactly once');
    assert.equal(playheadPx(h), 120, 'and the picture moved to the top of clip b (3s × 40px/s)');
    assert.equal(h.commits.length, 0, 'revealing is not an edit — nothing reached the model');
  } finally { h.teardown(); }
});

test('clicking a clip the playhead is ALREADY inside costs no seek at all', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    await frames(3);
    const el = h.bar('a');
    el.dispatchEvent(pointer('pointerdown', EDGE_PX + 4));
    h.root.dispatchEvent(pointer('pointerup', EDGE_PX + 4));
    await frames(3);
    assert.equal(playheadPx(h), 0, 'the commonest case by far, and it moves nothing');
  } finally { h.teardown(); }
});

test('while PLAYING, selecting a clip never yanks the playhead — that would be a jump cut', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    await frames(3);
    // The clock refuses to play an untimed canvas (it reads its length off the live
    // DOM, not off the model), so give the artboard the length the tool hook stamps.
    h.canvasEl.setAttribute('data-seq-ms', '5000');
    (h.root.querySelector('.tl-play') as HTMLElement).click();   // clock.play()
    await frames(3);
    const at = playheadPx(h);

    const el = h.bar('b');
    el.dispatchEvent(pointer('pointerdown', 120 + EDGE_PX + 4));
    h.root.dispatchEvent(pointer('pointerup', 120 + EDGE_PX + 4));
    await frames(3);

    assert.deepEqual(h.selSets.at(-1), ['b'], 'the selection still followed the press');
    assert.ok(playheadPx(h) >= at && playheadPx(h) < 120,
      `the playhead kept running from ${at}px instead of jumping to 120px (was ${playheadPx(h)}px)`);
  } finally {
    (h.root.querySelector('.tl-play') as HTMLElement).click();   // stop the rAF loop
    h.teardown();
  }
});

test('Shift-extending a selection does not seek — there is no single clip to reveal', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    await frames(3);
    const a = h.bar('a');
    a.dispatchEvent(pointer('pointerdown', EDGE_PX + 4));
    h.root.dispatchEvent(pointer('pointerup', EDGE_PX + 4));
    await frames(3);
    assert.equal(playheadPx(h), 0);

    const b = h.bar('b');
    b.dispatchEvent(pointer('pointerdown', 120 + EDGE_PX + 4, { shiftKey: true }));
    h.root.dispatchEvent(pointer('pointerup', 120 + EDGE_PX + 4, { shiftKey: true }));
    await frames(3);

    assert.deepEqual(h.selSets.at(-1), ['a', 'b'], 'both clips are selected');
    assert.equal(playheadPx(h), 0, 'and the picture stayed under the FIRST of them');
  } finally { h.teardown(); }
});

// ── the `tl-time` seam: an ACTIVE-SET change, never a tick ────────────────────

test('tl-time fires when the active set changes and stays silent inside one clip', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    await frames(3);
    const seen: Array<{ atMs: number; activeIds: string[]; playing: boolean }> = [];
    h.stageEl.addEventListener('tl-time', (e) => { seen.push((e as CustomEvent).detail); });

    // Four seeks, all inside clip a. `fc-seek` is the canvas→panel half of the seam,
    // so this drives the panel exactly as the off-playhead banner's button does.
    for (const atMs of [400, 900, 1500, 2900]) {
      h.stageEl.dispatchEvent(new dom.window.CustomEvent('fc-seek', { bubbles: true, detail: { atMs } }));
      await frames(3);
    }
    assert.equal(seen.length, 0, 'sixty ticks a second inside one clip must not repaint the canvas');
    assert.equal(playheadPx(h), 2.9 * 40, '…but the playhead really did move');

    h.stageEl.dispatchEvent(new dom.window.CustomEvent('fc-seek', { bubbles: true, detail: { atMs: 3500 } }));
    await frames(3);
    assert.equal(seen.length, 1, 'crossing the cut fires exactly once');
    assert.deepEqual(seen[0]!.activeIds, ['b']);
    assert.equal(seen[0]!.atMs, 3500);
    assert.equal(seen[0]!.playing, false);
  } finally { h.teardown(); }
});

test('a junk fc-seek detail seeks to zero rather than to NaN', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    await frames(3);
    h.stageEl.dispatchEvent(new dom.window.CustomEvent('fc-seek', { bubbles: true, detail: { atMs: 3500 } }));
    await frames(3);
    assert.equal(playheadPx(h), 140);
    for (const detail of [{ atMs: 'soon' }, { atMs: Number.NaN }, { atMs: -5 }, null]) {
      h.stageEl.dispatchEvent(new dom.window.CustomEvent('fc-seek', { bubbles: true, detail }));
      await frames(3);
      assert.equal(playheadPx(h), 0, `detail ${JSON.stringify(detail)} landed at 0`);
      h.stageEl.dispatchEvent(new dom.window.CustomEvent('fc-seek', { bubbles: true, detail: { atMs: 3500 } }));
      await frames(3);
    }
  } finally { h.teardown(); }
});

test('destroying the panel takes the fc-seek listener with it', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  await frames(3);
  const stage = h.stageEl;
  h.teardown();
  // No clock, no listener: this must be inert rather than throw on a dead clock.
  stage.dispatchEvent(new dom.window.CustomEvent('fc-seek', { bubbles: true, detail: { atMs: 1000 } }));
});

// ── TRIM v2: bigger targets, three states, a limit signal, ripple and a readout ──
//
// The arithmetic is timeline-math's and is unit-tested at the repo root (trimClip,
// edgeZonePx, fmtDur, fmtDelta). What is pinned HERE is the wiring only the panel can
// get wrong: which pointer gets which hit zone, that the LIMIT signal reads the
// writer's own answer rather than a second copy of the clamp, that the readout says
// what actually landed, that the ripple is live rather than deferred to release — and
// that none of it broke "the model is written exactly once per gesture".
//
// Every mounted row set below totals FIVE seconds, because that is the length `mount`
// fits its 224px viewport to in order to land on exactly 40px per second.

test('the trim hit zone follows the POINTER: 20px in is a trim by finger, a move by mouse', async () => {
  // A 2s overlay at 40px/s spans 40px → 120px. The press is 20px inside its left edge:
  // outside the 10px cursor zone, well inside the 24px touch zone.
  for (const [pointerType, wantDur] of [['touch', 1], ['mouse', 2]] as const) {
    const h = mount([clip('a', 0, 5), overlay('o', 1, 2)]);
    try {
      const el = h.bar('o');
      el.dispatchEvent(pointer('pointerdown', 60, { pointerType }));
      h.root.dispatchEvent(pointer('pointermove', 100, { pointerType }));
      await frames(3);
      h.root.dispatchEvent(pointer('pointerup', 100, { pointerType, altKey: true }));

      assert.equal(h.commits.length, 1, `${pointerType}: exactly one write`);
      const o = h.commits[0]!.find((b) => b.id === 'o')!;
      assert.equal(Number(o.start), 2, `${pointerType}: the in point moved a second either way`);
      assert.equal(Number(o.dur), wantDur, pointerType === 'touch'
        ? 'a finger 20px in grabbed the EDGE, so the clip got shorter'
        : 'a cursor 20px in grabbed the BODY, so the clip only moved');
    } finally { h.teardown(); }
  }
});

test('a bar too narrow to carry two zones offers none — and says where to trim instead', () => {
  // 0.5s at 40px/s = 20px, under MIN_TRIM_BAR_PX. Pressing its very first pixel must
  // still be a grab, or the clip could never be moved again at this zoom.
  const h = mount([clip('a', 0, 5), overlay('o', 1, 0.5)]);
  try {
    const el = h.bar('o');
    assert.ok(el.classList.contains('is-tight'), 'the bar is marked, so the CSS can drop the grips');
    assert.match(el.title, /too narrow to trim/, 'and its title points at the precise route');
    el.dispatchEvent(pointer('pointerdown', 40));
    h.root.dispatchEvent(pointer('pointermove', 80));
    h.root.dispatchEvent(pointer('pointerup', 80, { altKey: true }));
    const o = h.commits[0]!.find((b) => b.id === 'o')!;
    assert.equal(Number(o.dur), 0.5, 'the length is untouched: that press was a move, not a trim');
    assert.equal(Number(o.start), 2);
    assert.equal(h.bar('a').classList.contains('is-tight'), false, 'a normal bar is not marked');
  } finally { h.teardown(); }
});

test('dragging past the end of the source flags the LIMIT and commits the clamped value', async () => {
  const h = mount([clip('a', 0, 5), overlay('o', 0, 2)]);
  try {
    // A 3-second source behind a 2-second clip: exactly 1s of headroom, then the wall.
    paintMediaBoxes(h, { o: '<div class="lolly-box-audio" data-audio-src="vo.mp3" data-audio-dur="3000"></div>' });
    const el = h.bar('o');
    const outEdge = el.querySelector('.tl-edge[data-edge="out"]') as HTMLElement;

    el.dispatchEvent(pointer('pointerdown', 78));          // within 10px of the 80px right edge
    assert.ok(el.classList.contains('is-trimming'), 'the clip announces the mode');
    assert.ok(outEdge.classList.contains('is-active'), 'and the edge under the pointer lights up');
    assert.equal(outEdge.classList.contains('is-limit'), false, 'nothing has been refused yet');

    h.root.dispatchEvent(pointer('pointermove', 158));     // +80px = +2s, i.e. 1s past the source
    await frames(3);
    assert.ok(outEdge.classList.contains('is-limit'), 'the writer refused, so the edge says so');

    h.root.dispatchEvent(pointer('pointerup', 158, { altKey: true }));
    assert.equal(h.commits.length, 1, 'still exactly one write');
    assert.equal(Number(h.commits[0]!.find((b) => b.id === 'o')!.dur), 3, 'clamped to the media, not to the drag');
    assert.equal(el.classList.contains('is-trimming'), false, 'and every trim state comes off on release');
    assert.equal(outEdge.classList.contains('is-limit'), false);
    assert.equal(outEdge.classList.contains('is-active'), false);
    assert.equal((h.root.querySelector('.tl-trim-badge') as HTMLElement).hidden, true);
    assert.equal((h.root.querySelector('.tl-clip-extent') as HTMLElement).hidden, true);
  } finally { h.teardown(); }
});

test('a SUCCESSFUL trim-in on the magnetic row is not mistaken for a limit', async () => {
  // The seq row repacks gapless from 0, so a trim-in leaves `start` exactly where it
  // was and takes the frame off the LENGTH instead. Comparing the edge's absolute time
  // against the request would therefore report "end of the source" on every trim-in
  // that worked — which is why the limit test compares durations.
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const el = h.bar('a');
    const inEdge = el.querySelector('.tl-edge[data-edge="in"]') as HTMLElement;
    el.dispatchEvent(pointer('pointerdown', 2));                          // a's in edge
    h.root.dispatchEvent(pointer('pointermove', 42, { altKey: true }));   // +40px = +1s
    await frames(3);
    assert.equal(inEdge.classList.contains('is-limit'), false, 'the writer said yes, so no limit');
    assert.equal(el.style.width, '80px', 'and the clip really did lose a second');
    h.root.dispatchEvent(pointer('pointerup', 42, { altKey: true }));
    const a = h.commits[0]!.find((x) => x.id === 'a')!;
    assert.equal(Number(a.dur), 2);
    assert.equal(Number(a.start), 0, 'the magnetic row pinned the start, exactly as designed');
    assert.equal(Number(a.clipIn), 1, 'the second came off the source instead');
  } finally { h.teardown(); }
});

test('the trim badge reads the ACHIEVED duration and a signed delta', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const badge = h.root.querySelector('.tl-trim-badge') as HTMLElement;
    assert.equal(badge.hidden, true, 'invisible until a trim starts');
    const el = h.bar('a');
    el.dispatchEvent(pointer('pointerdown', 118));                        // a's out edge (3s = 120px)
    assert.equal(badge.hidden, false);
    h.root.dispatchEvent(pointer('pointermove', 78, { altKey: true }));   // -40px = -1s
    await frames(3);
    assert.equal(badge.textContent, `${fmtDur(2)}  ${fmtDelta(-1)}`);
    assert.equal(badge.textContent, '2.0s  -1.0s', 'and that is what it literally says');
    assert.equal(h.commits.length, 0, 'a readout is not a write');
    h.root.dispatchEvent(pointer('pointerup', 78, { altKey: true }));
    assert.equal(badge.hidden, true);
  } finally { h.teardown(); }
});

test('a seq trim RIPPLES live: the downstream bar moves during the drag, not on release', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const a = h.bar('a');
    const b = h.bar('b');
    assert.equal(b.style.left, '120px', 'precondition: b starts where a ends');
    a.dispatchEvent(pointer('pointerdown', 118));
    h.root.dispatchEvent(pointer('pointermove', 78, { altKey: true }));
    await frames(3);
    assert.equal(b.style.left, '80px', 'b followed a’s new out point mid-drag');
    assert.equal(h.commits.length, 0, 'and the model has still not been touched');
    h.root.dispatchEvent(pointer('pointerup', 78, { altKey: true }));
    assert.equal(h.commits.length, 1);
    assert.equal(Number(h.commits[0]!.find((x) => x.id === 'b')!.start), 2, 'the commit agrees with the preview');
  } finally { h.teardown(); }
});

/** Arm the panel's keyboard the way a pointer would: hover the panel, focus a bar. */
function armKeys(h: Harness, id: string, atPx: number): HTMLElement {
  h.root.dispatchEvent(new dom.window.Event('pointerenter'));
  const el = h.bar(id);
  el.dispatchEvent(pointer('pointerdown', atPx));
  h.root.dispatchEvent(pointer('pointerup', atPx));
  el.focus();
  h.commits.length = 0;
  return el;
}
const press = (el: HTMLElement, key: string, extra: Record<string, unknown> = {}): void => {
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
};

test('keyboard trim: `[` / `]` arm an edge and `,` / `.` walk it ONE frame, one write each', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const el = armKeys(h, 'a', 60);
    press(el, '[');
    assert.ok((el.querySelector('.tl-edge[data-edge="in"]') as HTMLElement).classList.contains('is-active'),
      'the in edge is armed, and visibly so');

    press(el, '.');
    assert.equal(h.commits.length, 1, 'exactly one write per press');
    // One frame at 30fps off the IN edge. The seq row is magnetic, so `start` stays 0
    // and the frame comes off the LENGTH; the source in-point takes it instead.
    const a1 = h.commits[0]!.find((x) => x.id === 'a')!;
    assert.equal(Number(a1.dur), 2.967);
    assert.equal(Number(a1.clipIn), 0.033, 'a trim-in consumed a frame of the source');
    assert.equal(Number(a1.start), 0, 'the magnetic row still starts at zero');
    assert.equal(Number(h.commits[0]!.find((x) => x.id === 'b')!.start), 2.967, 'and b rippled with it');

    press(el, ']');
    assert.ok((el.querySelector('.tl-edge[data-edge="out"]') as HTMLElement).classList.contains('is-active'));
    assert.equal((el.querySelector('.tl-edge[data-edge="in"]') as HTMLElement).classList.contains('is-active'), false,
      'only one edge is ever armed');

    press(el, ',');
    assert.equal(h.commits.length, 2);
    assert.equal(Number(h.commits[1]!.find((x) => x.id === 'a')!.dur), 2.934, 'the out edge came back a frame');

    press(el, '.', { shiftKey: true });
    assert.equal(h.commits.length, 3, 'Shift is ten frames — still one write');
    assert.equal(Number(h.commits[2]!.find((x) => x.id === 'a')!.dur), 3.267);
  } finally { h.teardown(); }
});

test('keyboard trim: `e` pulls the armed edge to the playhead; with nothing armed it writes nothing', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    await frames(3);
    const el = armKeys(h, 'a', 60);
    press(el, 'e');
    assert.equal(h.commits.length, 0, 'no edge is armed, so there is nothing to trim');

    h.stageEl.dispatchEvent(new dom.window.CustomEvent('fc-seek', { bubbles: true, detail: { atMs: 2000 } }));
    await frames(3);
    press(el, ']');
    press(el, 'e');
    assert.equal(h.commits.length, 1);
    assert.equal(Number(h.commits[0]!.find((x) => x.id === 'a')!.dur), 2, 'the out edge landed on the playhead');
  } finally { h.teardown(); }
});

test('Escape unarms the trim edge BEFORE it closes the panel', () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    const el = armKeys(h, 'a', 60);
    press(el, ']');
    const outEdge = el.querySelector('.tl-edge[data-edge="out"]') as HTMLElement;
    assert.ok(outEdge.classList.contains('is-active'));

    press(el, 'Escape');
    assert.equal(outEdge.classList.contains('is-active'), false, 'the first Escape unarmed the edge');
    assert.equal(h.panel.isOpen(), true, 'and did NOT close the panel out from under it');

    press(el, 'Escape');
    assert.equal(h.panel.isOpen(), false, 'the second Escape closes it, exactly as it always did');
  } finally { h.teardown(); }
});

test('the CSS trim zones are the SAME numbers the hit test uses', () => {
  // The stylesheet has carried a "keep these in step" comment since the panel shipped,
  // with nothing behind it. A hit target wider or narrower than the thing it paints is
  // the exact defect this work item exists to fix, so it is pinned rather than trusted.
  const css = readFileSync(new URL('../styles/parts/timeline.css', import.meta.url), 'utf8');
  // The declaration may be a bare length or edgeZonePx's cap written as min(Npx, 33%);
  // either way the first pixel value in it is the base zone.
  const rest = /\.tl-edge\s*\{[^}]*\bwidth:[^;]*?(\d+)px/.exec(css);
  assert.ok(rest, '.tl-edge declares a width');
  assert.equal(Number(rest![1]), EDGE_PX, `.tl-edge width matches EDGE_PX (${EDGE_PX})`);

  const coarse = /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.tl-edge\s*\{[^}]*\bwidth:[^;]*?(\d+)px/.exec(css);
  assert.ok(coarse, 'the coarse-pointer block overrides .tl-edge');
  assert.equal(Number(coarse![1]), EDGE_PX_COARSE, `the coarse override matches EDGE_PX_COARSE (${EDGE_PX_COARSE})`);

  // Dashed borders in this shell mean "drop area" and nothing else; the reachable-media
  // ghost is not one.
  const extent = /\.tl-clip-extent\s*\{[^}]*\}/.exec(css);
  assert.ok(extent, '.tl-clip-extent is styled');
  assert.ok(!/dashed/.test(extent![0]), 'the reachable-media ghost is a SOLID outline');
});

// ── split v2: scope, boundaries, the through edit and Join ─────────────────────
//
// The whole point of `splitAll` is the UNDO shape: N clips cut at one instant is ONE
// model write, and a cut that lands on an existing edit is ZERO. Both are asserted on
// `commits`, which is the module's actual output.

test('Shift+S splits every clip the playhead is inside, in EXACTLY ONE commit', async () => {
  // Three overlays stacked over the same instant plus a seq clip — four cuts, one write.
  // 5s total, so the harness's stubbed viewport fits to exactly 40px per second and
  // `seekTo` lands on the instant it names.
  const h = mount([clip('a', 0, 5), overlay('o1', 0, 5), overlay('o2', 0, 5)]);
  try {
    await frames(2);
    seekTo(h, 2);
    await frames(2);
    h.commits.length = 0;
    h.root.dispatchEvent(new dom.window.Event('pointerenter'));
    press(h.root, 'S', { shiftKey: true });
    assert.equal(h.commits.length, 1, 'ONE write for the whole command = ONE undo step');
    const out = h.commits[0]!;
    assert.equal(out.length, 6, 'three clips became six');
    for (const id of ['a', 'o1', 'o2']) assert.equal(Number(out.find((b) => b.id === id)!.dur), 2, `${id} left half`);
    assert.equal(new Set(out.map((b) => String(b.id))).size, 6, 'every minted id is distinct');
  } finally { h.teardown(); }
});

test('a split at an existing cut writes NOTHING — no undo entry for a no-op', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    await frames(2);
    // Exactly on the seam between a and b. Nothing here can split (the playhead is on
    // both clips' boundaries), so the command must cost no commit at all.
    seekTo(h, 3);
    await frames(2);
    h.commits.length = 0;
    h.root.dispatchEvent(new dom.window.Event('pointerenter'));
    press(h.root, 's');
    assert.equal(h.commits.length, 0, 'ZERO commits — the playhead is already at a cut');
    press(h.root, 'S', { shiftKey: true });
    assert.equal(h.commits.length, 0, 'and the same for the split-everything variant');
  } finally { h.teardown(); }
});

test('a plain `s` splits the SELECTION when the playhead is inside it, else the clip under it', async () => {
  const h = mount([clip('a', 0, 5), overlay('o', 0, 5)]);
  try {
    await frames(2);
    seekTo(h, 2);
    await frames(2);
    h.select(['o']);
    h.commits.length = 0;
    h.root.dispatchEvent(new dom.window.Event('pointerenter'));
    press(h.root, 's');
    assert.equal(h.commits.length, 1);
    assert.equal(h.commits[0]!.length, 3, 'only the SELECTED overlay was cut, not the seq clip too');
    assert.equal(Number(h.commits[0]!.find((b) => b.id === 'o')!.dur), 2);
    assert.equal(Number(h.commits[0]!.find((b) => b.id === 'a')!.dur), 5, 'the seq clip is untouched');
  } finally { h.teardown(); }
});

test('a fresh cut marks the seam as a THROUGH edit, and Join puts the clip back', async () => {
  const h = mount([clip('a', 0, 3), clip('b', 3, 2)]);
  try {
    await frames(2);
    seekTo(h, 2);
    await frames(2);
    h.commits.length = 0;
    h.root.dispatchEvent(new dom.window.Event('pointerenter'));
    press(h.root, 's');
    assert.equal(h.commits.length, 1, 'the cut landed');
    const beforeJoin = h.commits[0]!.map((x) => ({ ...x }));
    h.notify();
    await frames(3);

    const through = Array.from(h.root.querySelectorAll('.tl-seam.is-through'));
    assert.equal(through.length, 1, 'exactly the new cut is drawn as a through edit');
    const newId = String(beforeJoin[1]!.id);
    assert.deepEqual([(through[0] as HTMLElement).dataset.a, (through[0] as HTMLElement).dataset.b], ['a', newId]);

    // Join, from the clip context menu (the one-sided route).
    rightClick(h.bar('a'));
    const join = Array.from(openMenu('.tl-ctx-menu')!.querySelectorAll('.folder-menu-item'))
      .find((n) => n.textContent?.trim() === 'Join clips');
    assert.ok(join, 'Join is offered on a through edit');
    click(join!);
    assert.equal(h.commits.length, 2, 'ONE more commit');
    assert.deepEqual(
      h.commits[1]!.map((x) => [x.id, x.start, x.dur]),
      [['a', 0, 3], ['b', 3, 2]],
      'the clip is whole again',
    );
  } finally { h.teardown(); }
});

test('Join is NOT offered at a seam that is a real decision', async () => {
  // Two different sources butted together: adjacent, but never one clip.
  const h = mount([
    { id: 'a', start: 0, dur: 2, lane: 'seq', clipIn: 0, speed: 1, image: { id: 'one.mp4' } as never },
    { id: 'b', start: 2, dur: 2, lane: 'seq', clipIn: 0, speed: 1, image: { id: 'two.mp4' } as never },
  ], 40, ADD_KINDS, { assetField: 'image' });
  try {
    await frames(2);
    assert.equal(h.root.querySelectorAll('.tl-seam.is-through').length, 0, 'no hairline on a real cut');
    rightClick(h.bar('a'));
    assert.equal(menuLabels(openMenu('.tl-ctx-menu')).includes('Join clips'), false,
      'and the menu does not offer it either — absent, not greyed out');
  } finally { h.teardown(); }
});

// ── detach / re-attach audio ──────────────────────────────────────────────────

/** Paint a live canvas where `id` is a decoded <video>, so mediaOf() calls it a video. */
function paintVideo(h: Harness, id: string, durSec = 8): void {
  h.canvasEl.setAttribute('data-seq-ms', '10000');
  for (const b of h.boxes) {
    const el = dom.window.document.createElement('div');
    el.className = 'lolly-box';
    el.setAttribute('data-box-id', String(b.id));
    if (String(b.id) === id) {
      el.innerHTML = '<video class="lolly-box-video" src="clip.mp4"></video>';
      const v = el.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(v, 'duration', { value: durSec, configurable: true });
    }
    h.canvasEl.appendChild(el);
  }
}

/** Open the context menu on a bar and read the labels the panel put in it. */
function ctxLabels(h: Harness, id: string): string[] {
  rightClick(h.bar(id));
  const out = menuLabels(openMenu('.tl-ctx-menu'));
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  return out;
}

test('Detach audio needs BOTH the manifest link field and an audio add-kind', () => {
  // 1. link field declared, audio kind declared, and the box really is a video → offered.
  const yes = mount([clip('v', 0, 4)], 40, ADD_KINDS, { linkField: 'linkOf' });
  try {
    paintVideo(yes, 'v');
    yes.panel.setOpen(false); yes.panel.setOpen(true);
    assert.ok(ctxLabels(yes, 'v').some((l) => l.startsWith('Detach audio')), 'offered');
  } finally { yes.teardown(); }

  // 2. no audio add-kind: there is no vocabulary for a detached sound to be born into.
  const noKind = mount([clip('v', 0, 4)], 40, [{ id: 'clip', label: 'Clip' }], { linkField: 'linkOf' });
  try {
    paintVideo(noKind, 'v');
    noKind.panel.setOpen(false); noKind.panel.setOpen(true);
    assert.equal(ctxLabels(noKind, 'v').some((l) => l.startsWith('Detach audio')), false);
  } finally { noKind.teardown(); }

  // 3. no link field: the tool never opted in, so the feature does not exist here.
  const noField = mount([clip('v', 0, 4)]);
  try {
    paintVideo(noField, 'v');
    noField.panel.setOpen(false); noField.panel.setOpen(true);
    assert.equal(ctxLabels(noField, 'v').some((l) => l.startsWith('Detach audio')), false);
  } finally { noField.teardown(); }

  // 4. link field, audio kind — but the box has no video to take a sound off.
  const noVideo = mount([clip('card', 0, 4)], 40, ADD_KINDS, { linkField: 'linkOf' });
  try {
    assert.equal(ctxLabels(noVideo, 'card').some((l) => l.startsWith('Detach audio')), false);
  } finally { noVideo.teardown(); }
});

test('detach then re-attach returns the model to its pre-detach shape', async () => {
  const h = mount([clip('v', 0, 4), clip('w', 4, 2)], 40, ADD_KINDS, { linkField: 'linkOf' });
  try {
    paintVideo(h, 'v');
    h.panel.setOpen(false); h.panel.setOpen(true);
    const before = h.boxes.map((b) => ({ ...b }));

    rightClick(h.bar('v'));
    const detach = Array.from(openMenu('.tl-ctx-menu')!.querySelectorAll('.folder-menu-item'))
      .find((n) => n.textContent?.trim().startsWith('Detach audio'))!;
    click(detach);
    assert.equal(h.commits.length, 1, 'detach is ONE commit');
    const detached = h.commits[0]!;
    assert.equal(detached.length, 3, 'one new box');
    const sound = detached.find((b) => !before.some((x) => x.id === b.id))!;
    assert.equal(sound.lane, '', 'on an overlay lane');
    assert.equal(String(sound.linkOf), 'v');
    assert.equal(String(detached.find((b) => b.id === 'v')!.linkOf), String(sound.id));
    assert.equal(detached.find((b) => b.id === 'v')!.mute, true, 'the picture is silenced');

    h.notify();
    await frames(3);
    // Re-attach from the VIDEO's side.
    rightClick(h.bar('v'));
    const back = Array.from(openMenu('.tl-ctx-menu')!.querySelectorAll('.folder-menu-item'))
      .find((n) => n.textContent?.trim().startsWith('Re-attach audio'))!;
    assert.ok(back, 'the same menu now offers the inverse');
    click(back);
    assert.equal(h.commits.length, 2, 're-attach is ONE commit');
    // Back to the shape we started from: same ids, same timing, no link, not muted.
    assert.deepEqual(
      h.commits[1]!.map((b) => [b.id, b.start, b.dur, b.lane, b.mute ?? '', b.linkOf ?? '']),
      before.map((b) => [b.id, b.start, b.dur, b.lane, '', '']),
    );
  } finally { h.teardown(); }
});

test('Shift+D detaches from the keyboard, and again to put it back', async () => {
  const h = mount([clip('v', 0, 4)], 40, ADD_KINDS, { linkField: 'linkOf' });
  try {
    paintVideo(h, 'v');
    h.panel.setOpen(false); h.panel.setOpen(true);
    const el = armKeys(h, 'v', 60);
    press(el, 'd');
    assert.equal(h.commits.length, 0, 'a bare `d` is not the shortcut — nothing happens');
    press(el, 'D', { shiftKey: true });
    assert.equal(h.commits.length, 1, 'Shift+D detached');
    assert.equal(h.commits[0]!.length, 2);
    h.notify();
    await frames(3);
    press(h.bar('v'), 'D', { shiftKey: true });
    assert.equal(h.commits.length, 2, 'and again re-attached');
    assert.equal(h.commits[1]!.length, 1);
  } finally { h.teardown(); }
});

test('clicking a linked bar selects BOTH halves; Alt-click selects just the one', async () => {
  const h = mount([
    { id: 'v', start: 0, dur: 4, lane: 'seq', mute: true, linkOf: 's' },
    { id: 's', start: 0, dur: 4, lane: '', linkOf: 'v' },
  ], 40, ADD_KINDS, { linkField: 'linkOf' });
  try {
    await frames(2);
    // The link badge is painted on both halves, and the video side says where it went.
    assert.ok(h.bar('v').classList.contains('is-linked'));
    assert.ok(h.bar('s').classList.contains('is-linked'));
    assert.equal(h.bar('v').querySelector('.tl-clip-link')?.getAttribute('title'), 'Sound is on its own lane');
    assert.equal(h.bar('s').querySelector('.tl-clip-link')?.getAttribute('title'), 'Sound detached from this clip');

    h.selSets.length = 0;
    const el = h.bar('v');
    el.dispatchEvent(pointer('pointerdown', 20));
    h.root.dispatchEvent(pointer('pointerup', 20));
    assert.deepEqual(h.selSets.at(-1), ['v', 's'], 'picture and sound travel together');

    h.selSets.length = 0;
    el.dispatchEvent(pointer('pointerdown', 20, { altKey: true }));
    h.root.dispatchEvent(pointer('pointerup', 20, { altKey: true }));
    assert.deepEqual(h.selSets.at(-1), ['v'], 'Alt is the established "just this one" idiom');
    assert.equal(h.commits.length, 0, 'selecting edits nothing');
  } finally { h.teardown(); }
});
