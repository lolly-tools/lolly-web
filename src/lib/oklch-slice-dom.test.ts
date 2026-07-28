// SPDX-License-Identifier: MPL-2.0
/*
 * oklch-slice.ts — the chart's markup and its drag/click/add contract.
 *
 * Run directly:  node --test shells/web/src/lib/oklch-slice-dom.test.ts
 *
 * The geometry is pinned separately (oklch-slice.test.ts, pure functions). What
 * this file covers is the part that only exists once there is a DOM: that dots
 * land where the geometry says, that a drag moves ONLY the two channels the
 * plane has axes for, and that a press which doesn't travel is a click rather
 * than a zero-distance recolour.
 *
 * jsdom has no canvas 2D context, so `paintSliceChart` is out of scope here —
 * it bails on `getContext('2d')` returning null, which is also what makes it
 * safe to call in this environment. The fill it would paint is verified against
 * the engine directly in tests/gamut.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
// The wiring uses pointer capture, which jsdom does not implement.
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};
dom.window.Element.prototype.hasPointerCapture = function () { return false; };

const { renderSliceChart, wireSliceChart, updateSliceDot } = await import('./oklch-slice.ts');
const { SLICE_C_MAX } = await import('./oklch-slice-geom.ts');
const { hexToOklch } = await import('@lolly/engine');
import type { SliceChartState } from './oklch-slice.ts';

const PLOT = { left: 0, top: 0, width: 400, height: 250 };

/** Mount a chart and give its plot a real box (jsdom lays nothing out). */
function mount(state: SliceChartState, dots: { idx: number; hex: string; label: string }[]) {
  const root = document.getElementById('mount')!;
  root.innerHTML = renderSliceChart(state, dots, { editable: true });
  const plot = root.querySelector('[data-okls-plot]') as HTMLElement;
  plot.getBoundingClientRect = () => ({
    ...PLOT, right: PLOT.width, bottom: PLOT.height, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  return { root, plot };
}

/** A pointer event at a fraction of the plot box. */
function pointer(type: string, fx: number, fy: number, target?: Element): void {
  const ev = new dom.window.Event(type, { bubbles: true, cancelable: true }) as unknown as
    Record<string, unknown>;
  ev.clientX = fx * PLOT.width;
  ev.clientY = fy * PLOT.height;
  ev.pointerId = 1;
  (target ?? document.querySelector('[data-okls-plot]')!)
    .dispatchEvent(ev as unknown as Event);
}

interface Oklch { l: number; c: number; h: number }

const HANDLERS = (state: SliceChartState, hexes: Record<number, string>) => {
  const calls = {
    recolor: [] as { idx: number; o: Oklch }[],
    commit: 0,
    pick: [] as number[],
    add: [] as Oklch[],
  };
  return {
    calls,
    h: {
      stateOf: () => state,
      hexOf: (idx: number) => hexes[idx] ?? '#888888',
      onRecolor: (idx: number, o: Oklch) => calls.recolor.push({ idx, o }),
      onCommit: () => { calls.commit++; },
      onPick: (idx: number) => calls.pick.push(idx),
      onAdd: (seed: Oklch) => calls.add.push(seed),
    },
  };
};

test('dots render at the position the geometry gives them', () => {
  // #2f7d4f is oklch(0.5289 0.10565 154.407).
  const state: SliceChartState = { plane: 'lc', fixed: 154.407, cMax: SLICE_C_MAX };
  const { root } = mount(state, [{ idx: 0, hex: '#2f7d4f', label: 'Green' }]);
  const dot = root.querySelector('[data-okls-idx="0"]') as HTMLElement;
  assert.ok(dot, 'the dot is rendered');
  // x = c / cMax = 0.10565 / 0.4 = 26.4%; y = 1 - l = 47.1%.
  assert.ok(Math.abs(parseFloat(dot.style.left) - 26.41) < 0.1, `left ${dot.style.left}`);
  assert.ok(Math.abs(parseFloat(dot.style.top) - 47.11) < 0.1, `top ${dot.style.top}`);
  assert.equal(dot.dataset.hex, '#2F7D4F');
  // Sliced at its own hue, so no fade.
  assert.equal(dot.style.getPropertyValue('--off'), '0.000');
});

test('a dot off the current plane is marked as off it, in the DOM and to AT', () => {
  const state: SliceChartState = { plane: 'lc', fixed: 30 };
  const { root } = mount(state, [{ idx: 0, hex: '#2f7d4f', label: 'Green' }]);
  const dot = root.querySelector('[data-okls-idx="0"]') as HTMLElement;
  assert.ok(Number(dot.style.getPropertyValue('--off')) > 0.4, 'green is far from hue 30');
  assert.match(dot.getAttribute('aria-label')!, /off this slice/);
});

test('a drag moves only the plane’s two channels, keeping the swatch’s own hue', () => {
  const state: SliceChartState = { plane: 'lc', fixed: 30, cMax: SLICE_C_MAX };
  const hexes = { 0: '#2f7d4f' }; // a green, on a red-hue plane
  const { root, plot } = mount(state, [{ idx: 0, hex: hexes[0], label: 'Green' }]);
  const { calls, h } = HANDLERS(state, hexes);
  const off = wireSliceChart(root, h);

  const dot = root.querySelector('[data-okls-idx="0"]')!;
  pointer('pointerdown', 0.5, 0.5, dot);
  pointer('pointermove', 0.25, 0.2);   // x = chroma 0.1, y = lightness 0.8
  pointer('pointerup', 0.25, 0.2);

  assert.equal(calls.recolor.length, 1, 'one recolour');
  const o = calls.recolor[0]!.o;
  assert.ok(Math.abs(o.c - 0.1) < 1e-6, `chroma from x: ${o.c}`);
  assert.ok(Math.abs(o.l - 0.8) < 1e-6, `lightness from y: ${o.l}`);
  // The plane is at hue 30, but the swatch is green — its own hue must survive.
  assert.ok(o.h > 120 && o.h < 170, `hue kept from the swatch, not the plane: ${o.h}`);
  assert.equal(calls.commit, 1, 'the drag committed once, on release');
  assert.equal(calls.pick.length, 0, 'a drag is not a click');
  off();
});

test('a press that does not travel is a click, not a zero-distance recolour', () => {
  const state: SliceChartState = { plane: 'lc', fixed: 30 };
  const { root } = mount(state, [{ idx: 3, hex: '#c02020', label: 'Red' }]);
  const { calls, h } = HANDLERS(state, { 3: '#c02020' });
  const off = wireSliceChart(root, h);

  const dot = root.querySelector('[data-okls-idx="3"]')!;
  pointer('pointerdown', 0.5, 0.5, dot);
  pointer('pointermove', 0.503, 0.503); // inside the 4px click threshold
  pointer('pointerup', 0.503, 0.503);

  assert.deepEqual(calls.pick, [3]);
  assert.equal(calls.recolor.length, 0);
  assert.equal(calls.commit, 0);
  off();
});

test('clicking empty space adds a swatch at that colour, on the current plane', () => {
  const state: SliceChartState = { plane: 'ch', fixed: 0.7, cMax: SLICE_C_MAX };
  const { root } = mount(state, []);
  const { calls, h } = HANDLERS(state, {});
  const off = wireSliceChart(root, h);

  pointer('pointerdown', 0.25, 0.5);
  pointer('pointerup', 0.25, 0.5);

  assert.equal(calls.add.length, 1);
  const seed = calls.add[0]!;
  // 'ch': x is hue (0.25 → 90°), y is chroma with the max at the top
  // (0.5 → half of cMax), and the fixed channel is the plane's lightness.
  assert.ok(Math.abs(seed.h - 90) < 1e-6, `hue from x: ${seed.h}`);
  assert.ok(Math.abs(seed.c - SLICE_C_MAX / 2) < 1e-6, `chroma from y: ${seed.c}`);
  assert.ok(Math.abs(seed.l - 0.7) < 1e-6, `lightness from the plane: ${seed.l}`);
  off();
});

test('updateSliceDot moves and recolours a dot without a re-render', () => {
  const state: SliceChartState = { plane: 'lc', fixed: 145, cMax: SLICE_C_MAX };
  const { root } = mount(state, [{ idx: 0, hex: '#2f7d4f', label: 'Green' }]);
  const dot = root.querySelector('[data-okls-idx="0"]') as HTMLElement;
  const before = dot.style.left;

  updateSliceDot(root, 0, '#e8f5ec', state); // much lighter, much less chroma
  assert.notEqual(dot.style.left, before, 'it moved');
  assert.equal(dot.dataset.hex, '#E8F5EC');
  assert.ok(dot.classList.contains('is-light'), 'a pale dot gets the light outline');
  assert.equal(dot.style.getPropertyValue('--dot'), '#e8f5ec');

  // The SAME element, not a replacement — a drag depends on it surviving.
  assert.equal(root.querySelector('[data-okls-idx="0"]'), dot);
});

test('the chart announces the plane and the value it is sliced at', () => {
  const { root } = mount({ plane: 'lc', fixed: 145 }, []);
  const label = root.querySelector('[data-okls-plot]')!.getAttribute('aria-label')!;
  assert.match(label, /Lightness × Chroma/);
  assert.match(label, /hue 145°/);

  const { root: r2 } = mount({ plane: 'ch', fixed: 0.7 }, []);
  assert.match(r2.querySelector('[data-okls-plot]')!.getAttribute('aria-label')!, /lightness 70%/);
});

test('a drag holds the AUTHORED fixed channel, not a gamut-mapped bake of it', () => {
  // The shake this pins: on the chroma × hue plane the held channel is LIGHTNESS,
  // and it used to be recovered from `hexOf` — which in Colour Lab is the subject's
  // sRGB bake. Outside sRGB that bake has a different lightness from the colour
  // being described, so every frame of a drag re-derived the plane from a colour
  // that was not the subject, the dot left the pointer, and the next frame
  // re-derived it from the new bake. It only misbehaved past the gamut boundary.
  const state: SliceChartState = { plane: 'ch', fixed: 0.5, cMax: SLICE_C_MAX };
  const { root } = mount(state, [{ idx: 0, hex: '#ff0000', label: 'Wide red' }]);
  // A wide-gamut red: L 0.72. Its sRGB bake is a DIFFERENT lightness — that gap is
  // the whole bug, so assert the fixture actually has one before relying on it.
  const authored = { l: 0.72, c: 0.31, h: 29 };
  // hexToOklch is nullable (a bad hex ⇒ null); this literal is fine, so pin it once.
  const baked = hexToOklch('#ff0000')!;
  assert.ok(Math.abs(baked.l - authored.l) > 0.01,
    `the fixture's bake really does differ in lightness: ${baked.l} vs ${authored.l}`);

  const { calls, h } = HANDLERS(state, { 0: '#ff0000' });
  const off = wireSliceChart(root, { ...h, oklchOf: () => authored });
  const dot = root.querySelector('[data-okls-idx="0"]')!;
  pointer('pointerdown', 0.5, 0.5, dot);
  pointer('pointermove', 0.3, 0.4);
  pointer('pointerup', 0.3, 0.4);

  assert.equal(calls.recolor.length, 1);
  const o = calls.recolor[0]!.o;
  assert.ok(Math.abs(o.l - authored.l) < 1e-9, `lightness held at the authored value: ${o.l}`);
  assert.notEqual(o.l, baked.l);
  // And the two moving channels still come straight off the pointer.
  assert.ok(Math.abs(o.h - 0.3 * 360) < 1e-6, `hue from x: ${o.h}`);
  assert.ok(Math.abs(o.c - 0.6 * SLICE_C_MAX) < 1e-6, `chroma from y: ${o.c}`);
  off();
});

test('without oklchOf the hex is still the fallback, so hex-native callers are unchanged', () => {
  // The brand editor's swatches genuinely ARE hex, so nothing there needed to change.
  const state: SliceChartState = { plane: 'ch', fixed: 0.5, cMax: SLICE_C_MAX };
  const { root } = mount(state, [{ idx: 0, hex: '#2f7d4f', label: 'Green' }]);
  const { calls, h } = HANDLERS(state, { 0: '#2f7d4f' });
  const off = wireSliceChart(root, h);
  const dot = root.querySelector('[data-okls-idx="0"]')!;
  pointer('pointerdown', 0.5, 0.5, dot);
  pointer('pointermove', 0.3, 0.4);
  pointer('pointerup', 0.3, 0.4);
  assert.equal(calls.recolor.length, 1);
  assert.ok(Math.abs(calls.recolor[0]!.o.l - hexToOklch('#2f7d4f')!.l) < 1e-9,
    'lightness held at the hex’s own lightness');
  off();
});
