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

import { radiiOf, fitRect, plateShotFrame, plateWindowDemands } from './sequence-render.ts';
import { EMPTY_KF_TRACK, kfTrackOf, sequenceDrawPlan, type SeqLayer } from './sequence-plan.ts';
import { parseDropShadows, spillPad } from '../lib/canvas-blur.ts';

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
  // The named list grew with the read/restore seam (plans/104 §6 point 0) — what the
  // contract pins is that OFF_CLASS comes from the applier, not that it comes alone.
  assert.match(render, /import\s*\{[^}]*\bOFF_CLASS\b[^}]*\}\s*from\s*'\.\/sequence-dom\.ts'/,
    'OFF_CLASS must be imported from the DOM applier, never restated as a literal');
  assert.match(render, /classList\.remove\(OFF_CLASS\)/, 'the raster must clear it');
  assert.match(render, /classList\.add\(OFF_CLASS\)/, 'and put it back');
  // sequence-dom.ts owns the name now (the clock was refactored onto it and
  // re-exports it, so the preview and every exporter still agree on one literal).
  assert.match(read('./sequence-dom.ts'), /export const OFF_CLASS = 'seq-off'/,
    'the applier owns the name');
  assert.match(read('../views/sequence-clock.ts'), /OFF_CLASS,?[\s\S]{0,200}from '\.\.\/bridge\/sequence-dom\.ts'/,
    'and the clock takes it from there rather than declaring a second one');
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

test('contract: both mix graphs consume the ONE bed-duck envelope (§6.1)', () => {
  // The bed's gain automation lives once, in audio-envelope.ts — a bed must duck
  // identically under a tool's own audio (export.ts) and under a sequence's audio
  // boxes (this module). Restating the ramp scheduling in either graph is how the
  // two exports drift apart.
  const seq = strip(read('./sequence-render.ts'));
  assert.match(seq, /import\s*\{\s*bedDuckEnvelope, scheduleGainEvents[\s\S]{0,40}from '\.\/audio-envelope\.ts'/,
    'the sequence bed takes the envelope from audio-envelope.ts');
  assert.doesNotMatch(seq, /linearRampToValueAtTime/,
    'no hand-scheduled ramps left in the sequence mix');
  const exp = strip(read('./export.ts'));
  assert.match(exp, /import \{ bedDuckEnvelope, scheduleGainEvents \} from '\.\/audio-envelope\.ts'/,
    'the export mix-in bed takes the same envelope');
  // The per-span duck: mixSequenceAudio hands connectBed the sequence's own audio
  // spans (bed back to full BETWEEN clips), not one min..max window.
  assert.match(seq, /\{ level: duckLevel, spans \}/, 'duck carries the spans themselves');
  // And the offline WebCodecs bed render threads the mix-in track through.
  assert.match(exp, /renderMusicBed\(opts\.audio!\.url[\s\S]{0,240}opts\.audio!\.mix\)/,
    'renderMusicBed receives opts.audio.mix');
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

// ── plate capture: pad + the filter rule (plans/104 §5.5) ──────────────────

test('plateShotFrame: pad 0 is byte-for-byte the shot this file has always taken', () => {
  // THE FLOOR. A document that uses no depth must export the bytes it exported before
  // any of plans/104 existed, and the plate is where that starts: same canvas size,
  // same transform string, character for character.
  assert.deepEqual(plateShotFrame(640, 360, 2), { width: 1280, height: 720, transform: 'scale(2)' });
  assert.deepEqual(plateShotFrame(640, 360, 2, 0), { width: 1280, height: 720, transform: 'scale(2)' });
  // Rounding is on the FINAL device size, exactly as before (0.5px boxes round once).
  assert.deepEqual(plateShotFrame(101.5, 50.5, 1), { width: 102, height: 51, transform: 'scale(1)' });
  // A degenerate box still yields a canvas — a 0×0 raster is a lost plate.
  assert.equal(plateShotFrame(0.1, 0.1, 0.001).width, 1);
});

test('plateShotFrame: a pad grows the canvas by 2·pad·S and offsets the clone INSIDE the scale', () => {
  const f = plateShotFrame(640, 360, 2, 24);
  assert.equal(f.width, (640 + 48) * 2);
  assert.equal(f.height, (360 + 48) * 2);
  // `scale(S) translate(p,p)` maps x to S·(x + p): the pad stays in ELEMENT px and the
  // box lands p·S device px in, so the plate's origin is (-p,-p) in box space. The
  // other order — translate outside the scale — would offset by p device px and the
  // padding would not line up with the canvas at any S but 1.
  assert.equal(f.transform, 'scale(2) translate(24px, 24px)');
});

test('plateShotFrame: a hostile pad is no pad, never a NaN-sized canvas', () => {
  for (const bad of [Number.NaN, -12, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(plateShotFrame(640, 360, 2, bad),
      { width: 1280, height: 720, transform: 'scale(2)' }, `pad ${bad}`);
  }
});

// ── plate geometry, asked of the planner (plans/104 §5.5) ───────────────────

function demandLayer(over: Partial<SeqLayer> = {}): SeqLayer {
  return {
    el: null as never,
    idx: 0,
    startMs: 0, durMs: 1000, clipInMs: 0, speed: 1, mute: false,
    enter: null, enterMs: 0, exit: null, exitMs: 0, enterEase: '', exitEase: '',
    lane: 'seq', kind: 'static',
    rect: { x: 0, y: 0, w: 200, h: 120, rot: 0 },
    opacity: 1, blend: '', radius: '', clipPath: '', openEnded: false, frameScene: false,
    z: 0, kf: EMPTY_KF_TRACK, blur: 0, shadowFilter: '',
    ...over,
  };
}

const GRID = [0, 250, 500, 750];

test('plateWindowDemands: a document with no effects asks for nothing extra', () => {
  // The byte-identity floor, expressed as geometry: pad 0 means `plateShotFrame` is
  // the shot it always was, and maxEff 1 means `S * 1` is exactly `S`.
  const d = plateWindowDemands([demandLayer(), demandLayer({ idx: 1, kind: 'video' })], GRID, 1000);
  assert.deepEqual(d.get(0), { pad: 0, maxEff: 1 });
  assert.deepEqual(d.get(1), { pad: 0, maxEff: 1 });
});

test('plateWindowDemands: the pad is the layer\'s own spill, in stage px', () => {
  const shadow = 'drop-shadow(0px 12px 24px #00000055)';
  const d = plateWindowDemands([
    demandLayer({ idx: 0, blur: 5, z: 60 }),
    demandLayer({ idx: 1, shadowFilter: shadow, z: 60 }),
  ], GRID, 1000);
  assert.equal(d.get(0)?.pad, spillPad(5), 'blur: three sigmas');
  assert.equal(d.get(1)?.pad, spillPad(0, parseDropShadows(shadow)), 'shadow: its own reach');
});

test('BYTE-IDENTITY FLOOR: a pre-104 blur/shadow asks for NO pad — its plate still carries it', () => {
  // `shadow: content` and an authored `blur` are pre-104 vocabulary. On a box with no
  // depth, ownership does not move (`ownsLayerFx`): the plate is shot with its filter
  // on, clipped at the box edge exactly as it always was, and the compositor applies
  // nothing. So there is nothing to make room for, and the shot geometry is the one
  // that shipped.
  const d = plateWindowDemands([
    demandLayer({ idx: 0, blur: 5 }),
    demandLayer({ idx: 1, shadowFilter: 'drop-shadow(0px 12px 24px #00000055)' }),
  ], GRID, 1000);
  assert.deepEqual(d.get(0), { pad: 0, maxEff: 1 });
  assert.deepEqual(d.get(1), { pad: 0, maxEff: 1 });
});

test('plateWindowDemands: the pad is the WINDOW MAXIMUM, taken from the planner\'s own blur', () => {
  // A `b` channel that ramps the blur up mid-clip: the plate has to be sized for the
  // widest moment, not for the value at t=0 — and the number comes from the same
  // `sequenceDrawPlan` the executor will read, never from a second derivation.
  const track = kfTrackOf('t0_b0*t1000_b20');
  const d = plateWindowDemands([demandLayer({ kf: track })], GRID, 1000);
  const at750 = sequenceDrawPlan([demandLayer({ kf: track })], 750, 1000)[0];
  assert.ok((at750?.blur ?? 0) > 0, 'the fixture really does ramp');
  assert.equal(d.get(0)?.pad, spillPad(at750?.blur ?? 0),
    'the widest frame on the grid sets the pad');
});

test('plateWindowDemands: a lifted layer asks for more resolution than a flat one', () => {
  // P0 has no camera, so the only way to get an eff above 1 is authored depth — which
  // is exactly the machinery P1 will drive from the camera instead.
  const flat = plateWindowDemands([demandLayer()], GRID, 1000, { stageW: 1920, stageH: 1080 });
  const lifted = plateWindowDemands([demandLayer({ z: 600 })], GRID, 1000, { stageW: 1920, stageH: 1080 });
  assert.equal(flat.get(0)?.maxEff, 1);
  assert.ok((lifted.get(0)?.maxEff ?? 0) > 1,
    `a box 600px off the board is magnified (got ${lifted.get(0)?.maxEff})`);
});

test('contract: every PLANNED layer is photographed clean, and the stage background is not', () => {
  // §5.5: `PlanItem.blur` is the WHOLE blur (authored + kf `b` + DOF) and the executor
  // applies it, so a plate that still carried the element's own filter would blur
  // twice. The stage background is not a planned layer — no PlanItem carries its alpha
  // or its blur — so it keeps both, exactly as it always kept its opacity.
  const src = strip(read('./sequence-render.ts'));
  assert.match(src, /neutralFilter\?:\s*boolean/, 'the shot can be asked for a clean plate');
  // THE NEUTRALISED SET AND THE READ SET ARE THE SAME SET. `readLayer` splits
  // `styleProp(el, 'filter')` — `el.style.getPropertyValue`, inline by construction —
  // so a filter arriving from a tool's `styles.css` never reaches `SeqLayer.blur` and
  // nobody would re-apply it. Writing `filter: none` here DOES out-specify a class, so
  // it would delete that effect from the plate as well: silently lost, where before
  // this feature it was baked in and exported. `removeProperty` takes exactly the
  // declaration the planner owns and nothing else.
  assert.match(src, /if \(ropts\.neutralFilter\) \{[\s\S]{0,900}el\.style\.removeProperty\('filter'\)/,
    'and that is what it does — the INLINE declaration only, which is the one the planner read');
  assert.ok(!/el\.style\.filter = 'none'/.test(src),
    'never `filter: none`, which would out-specify (and lose) a stylesheet-authored filter');
  assert.match(src, /const plateOpts: RasterOpts = \{ opaque: true, neutralFilter: neutralOf\(L\.idx\), pad: padOf\(L\.idx\) \};/,
    'one plate recipe, shared by every planned layer; both of its numbers are per-layer (§5.5)');
  const bgAt = src.indexOf('bgRaster = await rasterBox(stageEl');
  const optsAt = src.indexOf('const plateOpts');
  assert.ok(bgAt > 0 && optsAt > bgAt, 'the background shot is taken before, and without, the plate recipe');
  // The live (lottie) re-shot is a drop-in replacement for the static plate, so it has
  // to be framed identically — same opacity, same filter rule, same pad, same scale.
  assert.match(src, /rasterBox\(entry\.box, scaleOf\(layerIdx\), \[\], \{[\s\S]{0,140}opaque: true, neutralFilter: neutralOf\(layerIdx\), pad: padOf\(layerIdx\),/,
    'the per-frame lottie plate matches the static one it replaces');
  assert.match(src, /makeLiveRaster\(liveBoxes, plateScaleOf, padOf, neutralOf\)/,
    'and is handed the same per-layer pad, scale and ownership the static plates were shot at');
  // §5.4: a camera is a pose over time. `drawItem` already refuses to draw one; the
  // plates loop must refuse to photograph its marker div in the first place.
  assert.match(src, /L\.kind !== 'audio' && L\.kind !== 'camera'/,
    'a camera contributes no plate, exactly as an audio bed contributes none');
});

test('contract: the whole render runs inside the authored-DOM scope (plans/104 §6 point 0)', () => {
  // `parseSequenceStage` reads each box's rotation, opacity and blur off its INLINE
  // STYLE, and the preview clock has been writing exactly those. The scope has to wrap
  // the parse AND the plates AND the frame loop (the hybrid lottie path re-photographs
  // its box from inside it), which is why the body is a second function.
  const src = strip(read('./sequence-render.ts'));
  assert.match(src, /import \{ OFF_CLASS, withAuthoredDom \} from '\.\/sequence-dom\.ts'/,
    'the scope comes from the applier that owns the writes, never a local restore');
  assert.match(src, /export async function renderSequence\([\s\S]{0,400}return await withAuthoredDom\(node as HTMLElement, \(\) => renderSequenceAuthored\(/,
    'renderSequence is the scope and nothing else');
  const bodyAt = src.indexOf('async function renderSequenceAuthored(');
  assert.ok(bodyAt > 0, 'the body is a separate function so the scope cannot be partial');
  assert.ok(src.indexOf('parseSequenceStage(node as HTMLElement)', bodyAt) > bodyAt,
    'and the parse is inside it');
  assert.match(read('./sequence-dom.ts'), /export async function withAuthoredDom/,
    'sequence-dom.ts owns the seam');
});
