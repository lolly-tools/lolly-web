// SPDX-License-Identifier: MPL-2.0
/**
 * Where the editor's contextual bar lands — the pure geometry of `placeCtxBar`, plus the
 * two CSS contracts the placement leans on.
 *
 * The rule it replaced was `top = max(6, selectionTop - 48)` with `left` clamped to the
 * stage width and nothing else. Every assertion below is a failure that rule produced in
 * a screen recording of the Sequence Studio:
 *   • a full-frame scene box has its top edge AT the stage top, so `max(6, …)` parked the
 *     bar in the top band — which the zoom HUD owns — and the width clamp knew nothing
 *     about the HUD, so the two pills butted together and the HUD sliced the bar's
 *     coordinate readout down to a stray digit;
 *   • the back pill occupies the other end of that same band, so "just move it left" is
 *     not an answer on its own.
 *
 * Not covered here, because jsdom has no layout: the entrance animation, the frozen
 * placement during a drag, and the measured blocker rects (`ctxBarBlockers` reads real
 * getBoundingClientRects). Verified by hand in a browser.
 *
 * Run directly:  node --test shells/web/src/views/free-canvas-ctxbar.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { placeCtxBar } from './free-canvas.ts';

const STAGE = { w: 1000, h: 700 };
const BAR = { w: 420, h: 40 };
// The two pieces of fixed chrome, in stage coordinates: the zoom HUD top-right
// (− 48% + Fit ☀ 🔇) and the back pill top-left (← Home).
const HUD = { left: 700, top: 10, right: 990, bottom: 48 };
const HOME = { left: 10, top: 10, right: 120, bottom: 48 };

/** Do these two boxes touch at all? The bar keeps a gap, so plain overlap is the floor. */
const overlaps = (a: { left: number; top: number; right: number; bottom: number },
                  b: { left: number; top: number; right: number; bottom: number }): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const barBox = (p: { left: number; top: number }, bar = BAR) =>
  ({ left: p.left, top: p.top, right: p.left + bar.w, bottom: p.top + bar.h });

// ══ the classic case ══════════════════════════════════════════════════════════

test('a mid-canvas selection keeps the bar above it, centred', () => {
  const pos = placeCtxBar({ left: 400, top: 300, right: 600, bottom: 500 }, BAR, STAGE, [HUD, HOME]);
  assert.equal(pos.placement, 'above');
  assert.equal(pos.top, 300 - 8 - 40, 'one gap above the selection\'s top edge');
  assert.equal(pos.left, 500 - BAR.w / 2, 'centred on the selection');
});

test('a selection near the left edge slides the bar back on-stage rather than off it', () => {
  const pos = placeCtxBar({ left: 0, top: 300, right: 60, bottom: 400 }, BAR, STAGE, [HUD, HOME]);
  assert.equal(pos.left, 6, 'clamped to the stage pad');
  assert.equal(pos.placement, 'above');
});

// ══ the full-frame scene box (the reported defect) ════════════════════════════

test('a full-frame selection flips the bar INSIDE its top edge instead of into the top band', () => {
  const pos = placeCtxBar({ left: 0, top: 0, right: 1000, bottom: 700 }, BAR, STAGE, [HUD, HOME]);
  assert.notEqual(pos.placement, 'above', 'there is no room above a selection that starts at the stage top');
  assert.ok(pos.top >= 8, 'it sits inside the selection, not pinned to the stage edge');
});

test('the bar never overlaps the zoom HUD or the back pill', () => {
  // The three shapes that used to collide: the full-frame box, a wide box whose top is
  // in the HUD's band, and a box tucked into the top-right corner under the HUD itself.
  const sels = [
    { left: 0, top: 0, right: 1000, bottom: 700 },
    { left: 40, top: 20, right: 960, bottom: 300 },
    { left: 640, top: 4, right: 980, bottom: 200 },
  ];
  for (const sel of sels) {
    const pos = placeCtxBar(sel, BAR, STAGE, [HUD, HOME]);
    const box = barBox(pos);
    assert.equal(overlaps(box, HUD), false, `clear of the zoom HUD for ${JSON.stringify(sel)}`);
    assert.equal(overlaps(box, HOME), false, `clear of the back pill for ${JSON.stringify(sel)}`);
    assert.ok(box.left >= 6 && box.right <= STAGE.w - 6, 'still on-stage');
    assert.ok(box.top >= 6 && box.bottom <= STAGE.h - 6, 'still on-stage vertically');
  }
});

test('a narrow bar slides sideways into the gap between the pills rather than dropping down', () => {
  const narrow = { w: 300, h: 40 };
  const pos = placeCtxBar({ left: 0, top: 0, right: 1000, bottom: 700 }, narrow, STAGE, [HUD, HOME]);
  assert.equal(pos.placement, 'inside');
  const box = barBox(pos, narrow);
  assert.equal(overlaps(box, HUD), false);
  assert.equal(overlaps(box, HOME), false);
  assert.ok(box.top < HUD.bottom, 'it stays on the HUD\'s line — the shift was horizontal, not a drop');
});

test('a bar too wide to fit beside the chrome drops BELOW the occupied band', () => {
  const wide = { w: 860, h: 40 };
  const pos = placeCtxBar({ left: 0, top: 0, right: 1000, bottom: 700 }, wide, STAGE, [HUD, HOME]);
  assert.equal(pos.placement, 'below');
  assert.ok(pos.top >= HUD.bottom, 'clear under the whole top band');
  assert.equal(overlaps(barBox(pos, wide), HUD), false);
  assert.equal(overlaps(barBox(pos, wide), HOME), false);
});

test('an empty top band leaves the flip exactly where it always was', () => {
  // The drop is a response to chrome, never a tax on tools that have none: with no
  // blockers a full-frame selection gets the bar one gap inside its own top edge.
  const pos = placeCtxBar({ left: 0, top: 0, right: 1000, bottom: 700 }, BAR, STAGE, []);
  assert.deepEqual(pos, { left: 290, top: 8, placement: 'inside' });
});

// ══ degenerate inputs ═════════════════════════════════════════════════════════

test('an unmeasurable stage keeps the anchored placement instead of clamping to zeroes', () => {
  // A display:none stage, a pre-layout ResizeObserver delivery, jsdom: clamping against
  // a 0×0 stage would slam the bar into the corner and lose the anchor entirely.
  const pos = placeCtxBar({ left: 400, top: 300, right: 600, bottom: 500 }, BAR, { w: 0, h: 0 }, [HUD]);
  assert.deepEqual(pos, { left: 290, top: 252, placement: 'above' });
});

test('a stage shorter than the bar still yields an on-stage top', () => {
  const pos = placeCtxBar({ left: 0, top: 0, right: 200, bottom: 200 }, BAR, { w: 1000, h: 30 }, []);
  assert.ok(pos.top >= 6, 'never negative, however little room there is');
});

test('a rotated selection is placed off its AABB, so the corners never poke through the bar', () => {
  // The caller hands in the rotation-aware union (groupAABBNative), so this is really a
  // statement that placeCtxBar has no opinion of its own about rotation.
  const a = placeCtxBar({ left: 300, top: 200, right: 500, bottom: 400 }, BAR, STAGE, []);
  const b = placeCtxBar({ left: 280, top: 180, right: 520, bottom: 420 }, BAR, STAGE, []);
  assert.equal(a.left, b.left, 'both centre on 400');
  assert.ok(b.top < a.top, 'the wider AABB pushes the bar further up');
});

// ══ the CSS contracts the placement depends on ════════════════════════════════

const css = readFileSync(new URL('../styles/parts/editor.css', import.meta.url), 'utf8');

test('the entrance animation fills BACKWARDS, never forwards', () => {
  // A transform that survives the animation makes the bar the containing block for its
  // colour popover's position:fixed and throws the swatches off-screen — a bug already
  // fixed once in this file, which is why the bar is centred with `left` and not a
  // translateX. `backwards` fills only the delay; the computed transform is `none` again
  // the moment the run ends.
  const rule = css.match(/\.fc-ctxbar\.fc-ctxbar-enter\s*\{[^}]*\}/);
  assert.ok(rule, 'editor.css declares the entrance');
  assert.match(rule![0], /\bbackwards\b/);
  assert.doesNotMatch(rule![0], /\bforwards\b|\bboth\b/);
});

test('the readout reserves its width, so the bar cannot breathe mid-drag', () => {
  const rule = css.match(/^\.fc-readout\s*\{[^}]*\}/m);
  assert.ok(rule, 'editor.css declares .fc-readout');
  assert.match(rule![0], /min-width:\s*\d+ch/, 'a ch-based floor');
  assert.match(rule![0], /font-variant-numeric:\s*tabular-nums/, 'which only means anything with fixed-width digits');
});

test('both bars reveal instantly and fade out on a delay (the anti-flicker hysteresis)', () => {
  for (const sel of ['\\.fc-toolbar', '\\.fc-ctxbar']) {
    const base = css.match(new RegExp(`^${sel}\\s*\\{[^}]*\\}`, 'm'));
    assert.ok(base, `editor.css declares ${sel}`);
    assert.match(base![0], /transition:\s*opacity[^;]*0\.\d+s\s*ease\s+0\.\d+s/,
      `${sel} hides on a delay`);
  }
  assert.match(css, /\.tool-stage:hover \.fc-toolbar,[\s\S]{0,120}?transition-delay:\s*0s/,
    'the rail\'s reveal cancels the delay');
  assert.match(css, /\.tool-stage:hover \.fc-ctxbar,[\s\S]{0,120}?transition-delay:\s*0s/,
    'the ctx bar\'s reveal cancels the delay');
});

test('the rail does NOT try to keep a `[hidden]` button laid out', () => {
  // This test used to assert the opposite. The rail's vertical jump (a gated button
  // appearing re-centres the whole palette) was "fixed" by collapsing the button to
  // zero height instead of removing it — which cannot work and must not:
  //   • `[hidden] { display: none !important }` in parts/a11y.css out-ranks any
  //     `display` a sheet asks for, so the collapse never applied in a browser at all;
  //   • `hidden` means "not rendered AND not in the accessibility tree", which a
  //     laid-out zero-height button is not.
  // styles/hidden-attribute-guard.test.ts fails the build on that mistake app-wide;
  // this is the local restatement, so the same idea cannot come back in this sheet.
  assert.match(css, /\.fc-btn\[hidden\]\s*\{[^}]*display:\s*none/, 'the plain rule survives');
  assert.equal(css.match(/\.fc-toolbar \.fc-btn\[hidden\]\s*\{[^}]*\}/), null,
    'the rail must not override [hidden] — gate with a class + inert if it needs to stay laid out');
});
