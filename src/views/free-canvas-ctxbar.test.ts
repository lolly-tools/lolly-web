// SPDX-License-Identifier: MPL-2.0
/**
 * Where the editor's contextual bar lands - the pure geometry of `ctxTopBand` +
 * `centreCtxBar`, plus the CSS contracts the placement leans on.
 *
 * The bar used to float ABOVE (or inside) the selection, which put it right over the very
 * artwork being dragged or resized. It is pinned to the TOP chrome row now - on the line
 * with the back pill (top-left) and the zoom HUD (top-right) - centred in the band between
 * them so all three read as one row and none can overlap another. On a narrow phone the
 * bar is capped to that band and scrolls its controls into reach (see the `.fc-ctxbar`
 * overflow) rather than dropping down over the canvas. Every assertion below is one half
 * of that contract: the band never runs into the chrome, and a too-wide bar pins to the
 * band's left edge instead of pushing past it.
 *
 * Not covered here, because jsdom has no layout: the entrance animation, the frozen
 * placement during a drag, the measured blocker rects (`ctxBarBlockers` reads real
 * getBoundingClientRects), and the actual scroll. Verified by hand in a browser.
 *
 * Run directly:  node --test shells/web/src/views/free-canvas-ctxbar.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ctxTopBand, centreCtxBar } from './free-canvas.ts';

const STAGE = { w: 1000, h: 700 };
// The two pieces of fixed chrome, in stage coordinates: the back pill top-left (← Home)
// and the zoom HUD top-right (− 48% + Fit ☀ 🔇).
const HOME = { left: 10, top: 10, right: 120, bottom: 48 };
const HUD = { left: 700, top: 10, right: 990, bottom: 48 };

/** Do these two boxes touch at all? The bar keeps a gap, so plain overlap is the floor. */
const overlaps = (a: { left: number; right: number; top: number; bottom: number },
                  b: { left: number; right: number; top: number; bottom: number }): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
/** The bar as it actually paints: `max-width` caps it to the band, so a too-wide bar shows
 *  band-width and scrolls the rest - its painted right edge is never past `hi`. */
const paintedBox = (bw: number, band: { lo: number; hi: number; top: number }, h = 40) => {
  const pos = centreCtxBar(bw, band);
  return { left: pos.left, right: pos.left + Math.min(bw, band.hi - band.lo), top: pos.top, bottom: pos.top + h };
};

// ══ the band ══════════════════════════════════════════════════════════════════

test('the band runs between the back pill and the zoom HUD, on their line', () => {
  const band = ctxTopBand(STAGE, [HOME, HUD]);
  assert.equal(band.lo, HOME.right + 8, 'starts one gap right of the back pill');
  assert.equal(band.hi, HUD.left - 8, 'ends one gap left of the zoom HUD');
  assert.equal(band.top, 10, 'aligned to the chrome row, not the stage edge');
});

test('with no chrome the band spans the whole padded top', () => {
  assert.deepEqual(ctxTopBand(STAGE, []), { lo: 6, hi: 994, top: 6 });
});

test('only the zoom HUD present bounds the right and leaves the left at the pad', () => {
  const band = ctxTopBand(STAGE, [HUD]);
  assert.equal(band.lo, 6);
  assert.equal(band.hi, HUD.left - 8);
});

test('only the back pill present bounds the left and leaves the right at the pad', () => {
  const band = ctxTopBand(STAGE, [HOME]);
  assert.equal(band.lo, HOME.right + 8);
  assert.equal(band.hi, 994);
});

test('the band aligns its top to the TOPMOST chrome, never to zero', () => {
  const band = ctxTopBand(STAGE, [{ ...HOME, top: 12, bottom: 50 }, { ...HUD, top: 8, bottom: 46 }]);
  assert.equal(band.top, 8, 'the higher of the two pills');
});

// ══ centring in the band ══════════════════════════════════════════════════════

test('a bar that fits centres in the band', () => {
  const band = ctxTopBand(STAGE, [HOME, HUD]);   // lo 128, hi 692, room 564
  const pos = centreCtxBar(420, band);
  assert.equal(pos.top, band.top);
  assert.equal(pos.left, 128 + Math.round((564 - 420) / 2), 'centred in the free span');
});

test('a bar too wide for the band pins to its left edge and scrolls the rest', () => {
  const band = ctxTopBand(STAGE, [HOME, HUD]);   // room 564
  const pos = centreCtxBar(900, band);
  assert.equal(pos.left, band.lo, 'left never intrudes the back pill');
  // Capped to the band by max-width, so the painted right edge lands on `hi`, never past
  // it into the zoom HUD - the overflow is what scrolls, not the bar's footprint.
  assert.ok(paintedBox(900, band).right <= band.hi, 'painted footprint stays clear of the HUD');
});

test('the painted bar never overlaps the back pill or the zoom HUD, at any width', () => {
  const band = ctxTopBand(STAGE, [HOME, HUD]);
  for (const bw of [120, 300, 420, 564, 700, 1200]) {
    const box = paintedBox(bw, band);
    assert.equal(overlaps(box, HOME), false, `clear of the back pill at ${bw}px`);
    assert.equal(overlaps(box, HUD), false, `clear of the zoom HUD at ${bw}px`);
  }
});

// ══ degenerate inputs ═════════════════════════════════════════════════════════

test('an unmeasurable stage returns a padded strip instead of a band from zeroes', () => {
  // A display:none stage, a pre-layout ResizeObserver delivery, jsdom.
  assert.deepEqual(ctxTopBand({ w: 0, h: 0 }, [HUD]), { lo: 6, hi: 6, top: 6 });
});

test('chrome that leaves no gap never inverts the band - hi clamps up to lo', () => {
  const band = ctxTopBand({ w: 300, h: 700 }, [
    { left: 0, top: 8, right: 160, bottom: 48 },
    { left: 150, top: 8, right: 300, bottom: 48 },
  ]);
  assert.ok(band.hi >= band.lo, 'a zero-or-negative span, never a flipped one');
  assert.equal(centreCtxBar(200, band).left, band.lo, 'the bar still pins to lo and scrolls');
});

// ══ the CSS contracts the placement depends on ════════════════════════════════

const css = readFileSync(new URL('../styles/parts/editor.css', import.meta.url), 'utf8');
const ctxRule = css.match(/^\.fc-ctxbar\s*\{[^}]*\}/m);

test('the bar scrolls its controls into reach - the one-row overflow the top-pin leans on', () => {
  assert.ok(ctxRule, 'editor.css declares .fc-ctxbar');
  assert.match(ctxRule![0], /overflow-x:\s*auto/, 'a horizontal scroll for a bar wider than the band');
  assert.match(ctxRule![0], /max-width:/, 'capped so the scroll has something to clip against');
  assert.match(ctxRule![0], /scrollbar-width:\s*none/, 'the scrollbar itself is hidden');
});

test('the entrance animation fills BACKWARDS, never forwards', () => {
  // A transform that survives the animation makes the bar the containing block for its
  // colour popover's position:fixed and throws the swatches off-screen - a bug already
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

test('the ctx bar reveals instantly and fades out on a delay; the rail never auto-hides', () => {
  // The rail's auto-hide came out 2026-08-28 (it annoyed more than it calmed, and it
  // kept the rail out of every capture) - the toolbar is always visible now, so only
  // the ctx bar keeps the anti-flicker hysteresis.
  const base = css.match(/^\.fc-ctxbar\s*\{[^}]*\}/m);
  assert.ok(base, 'editor.css declares .fc-ctxbar');
  // The duration may be a literal or a motion token (plans/172: .18s is var(--dur-2));
  // the DELAY stays literal here - it is this bar's own hysteresis, not a shared speed.
  assert.match(base![0], /transition:\s*opacity[^;]*(?:0?\.\d+s|var\(--dur-\d\))\s*ease\s+0\.\d+s/,
    '.fc-ctxbar hides on a delay');
  assert.match(css, /\.tool-stage:hover \.fc-ctxbar,[\s\S]{0,120}?transition-delay:\s*0s/,
    'the ctx bar\'s reveal cancels the delay');
  const rail = css.match(/^\.fc-toolbar\s*\{[^}]*\}/m);
  assert.ok(rail, 'editor.css declares .fc-toolbar');
  assert.doesNotMatch(rail![0], /opacity:\s*0/, 'the rail must not auto-hide at rest');
  assert.ok(!/\.tool-stage:hover \.fc-toolbar/.test(css), 'no hover reveal is left for the rail');
});

test('the rail does NOT try to keep a `[hidden]` button laid out', () => {
  // This test used to assert the opposite. The rail's vertical jump (a gated button
  // appearing re-centres the whole palette) was "fixed" by collapsing the button to
  // zero height instead of removing it - which cannot work and must not:
  //   • `[hidden] { display: none !important }` in parts/a11y.css out-ranks any
  //     `display` a sheet asks for, so the collapse never applied in a browser at all;
  //   • `hidden` means "not rendered AND not in the accessibility tree", which a
  //     laid-out zero-height button is not.
  // styles/hidden-attribute-guard.test.ts fails the build on that mistake app-wide;
  // this is the local restatement, so the same idea cannot come back in this sheet.
  assert.match(css, /\.fc-btn\[hidden\]\s*\{[^}]*display:\s*none/, 'the plain rule survives');
  assert.equal(css.match(/\.fc-toolbar \.fc-btn\[hidden\]\s*\{[^}]*\}/), null,
    'the rail must not override [hidden] - gate with a class + inert if it needs to stay laid out');
});
