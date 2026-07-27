// SPDX-License-Identifier: MPL-2.0
/**
 * sequence-render — the parts of the compositor that can be proven in Node.
 *
 * The executor itself is browser-only (canvas, WebCodecs, dom-to-image), and it is
 * covered by the Playwright tier in tests/sequence-render.browser.test.ts. What can
 * be checked headlessly is (a) the pure geometry helpers and (b) the CROSS-FILE
 * CONTRACTS this module depends on but does not own — each of which was a shipped
 * defect, and each of which is invisible to the type checker.
 *
 * Run with: node --test shells/web/src/bridge/sequence-render.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { radiiOf, fitRect } from './sequence-render.ts';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// ── cross-file contracts (each one was a defect) ────────────────────────────

test('contract: the raster pass clears the phase-2 clock\'s off-playhead class', () => {
  // The compositor photographs the LIVE artboard. sequence-clock leaves OFF_CLASS
  // (display:none, via styles/parts/timeline.css) on every box outside the playhead
  // window, and dom-to-image copies the computed style wholesale — so without this
  // every clip but the scrubbed one exports blank.
  const render = strip(read('./sequence-render.ts'));
  assert.match(render, /import\s*\{\s*OFF_CLASS\s*\}\s*from\s*'\.\.\/views\/sequence-clock\.ts'/,
    'OFF_CLASS must be imported from the clock, never restated as a literal');
  assert.match(render, /classList\.remove\(OFF_CLASS\)/, 'the raster must clear it');
  assert.match(render, /classList\.add\(OFF_CLASS\)/, 'and put it back');
  const clock = read('../views/sequence-clock.ts');
  assert.match(clock, /export const OFF_CLASS = 'seq-off'/, 'the clock still owns the name');
  assert.match(read('../styles/parts/timeline.css'), /\.seq-off\s*\{[^}]*display:\s*none/,
    'the class only matters because the stylesheet hides it');
});

test('contract: a frozen snapshotMotion still is marked, and the compositor hides it', () => {
  // On the ZIP path renderFormat's motion guard sees the OUTER format ('zip'), so
  // every <video> has already been swapped for a frozen <img> by the time the mp4
  // sub-render runs. Captured into the box's "over" plate it would sit on top of
  // every decoded frame — a zipped mp4 of a sequence would be a static picture.
  assert.match(strip(read('./export.ts')), /setAttribute\('data-motion-still', '1'\)/,
    'snapshotMotion must mark the still it inserts');
  assert.match(strip(read('./sequence-render.ts')), /querySelectorAll\('\[data-motion-still\]'\)/,
    'the compositor must hide it while rasterising the box');
});

test('contract: the frame cap applies to every buffered path, not just gif/apng', () => {
  // The MediaRecorder fallback pushes an ImageBitmap per frame, so it needs the same
  // ceiling; the streaming muxer holds no frames, so it must NOT have one. That
  // means the codec pick has to happen before the budget is decided.
  const src = strip(read('./sequence-render.ts'));
  const pickAt = src.indexOf('pickWebCodecsVideo(format');
  const capAt = src.indexOf('const cap = maxVideoFrames()');
  const windowAt = src.indexOf('activeFrameWindow(L,');
  assert.ok(pickAt > 0 && capAt > pickAt, 'the encoder pick must precede the frame cap');
  assert.ok(windowAt > capAt, 'activity windows must be derived AFTER the cap, from the capped grid');
  assert.match(src, /activeFrameWindow\(L, usedGrid,/, 'one grid for the loop and the windows');
});

// ── the pure geometry helpers ───────────────────────────────────────────────

test('radiiOf reads the border-radius shorthand in unscaled box px', () => {
  assert.deepEqual(radiiOf('', 100, 100), [0, 0, 0, 0]);
  assert.deepEqual(radiiOf('0', 100, 100), [0, 0, 0, 0]);
  assert.deepEqual(radiiOf('12px', 100, 100), [12, 12, 12, 12]);
  assert.deepEqual(radiiOf('10px 20px', 100, 100), [10, 20, 10, 20]);
  assert.deepEqual(radiiOf('50%', 100, 100), [50, 50, 50, 50]);
  // The elliptical form collapses to its horizontal radii rather than throwing.
  assert.deepEqual(radiiOf('20px / 40px', 100, 100), [20, 20, 20, 20]);
  // A pill: CSS shrinks every radius by one common factor when a pair overflows.
  const pill = radiiOf('9999px', 200, 80);
  assert.ok(pill.every((r) => Math.abs(r - 40) < 1e-6), `pill radii ${pill}`);
});

test('fitRect places media the way object-fit does', () => {
  assert.deepEqual(fitRect('fill', '', 100, 50, 200, 200), { x: 0, y: 0, w: 200, h: 200 });
  assert.deepEqual(fitRect('contain', '', 100, 50, 200, 200), { x: 0, y: 50, w: 200, h: 100 });
  assert.deepEqual(fitRect('cover', '', 100, 50, 200, 200), { x: -100, y: 0, w: 400, h: 200 });
  assert.deepEqual(fitRect('none', '', 100, 50, 200, 200), { x: 50, y: 75, w: 100, h: 50 });
  assert.deepEqual(fitRect('scale-down', '', 100, 50, 200, 200), { x: 50, y: 75, w: 100, h: 50 });
  // object-position moves the fitted rect, and unknown tokens fall back to centre.
  assert.equal(fitRect('contain', 'left top', 100, 50, 200, 200).y, 0);
  // Pinning shipped behaviour, not CSS: a SINGLE token is applied to both axes here,
  // where CSS would read `25%` as x:25% y:center. A known, unreported deviation —
  // the box editor only ever authors the two-token and keyword forms.
  assert.equal(fitRect('contain', '25%', 100, 50, 200, 200).y, 25);
  assert.equal(fitRect('contain', 'nonsense', 100, 50, 200, 200).y, 50);
  // A source with no known size falls back to the box rather than dividing by zero.
  assert.deepEqual(fitRect('contain', '', 0, 0, 200, 100), { x: 0, y: 0, w: 200, h: 100 });
});
