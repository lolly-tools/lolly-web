// SPDX-License-Identifier: MPL-2.0
/**
 * mix-window.test.ts - plans/156 Phase B Step B1, the make-or-break NODE proof
 * (§5 STOP-5).
 *
 * The ONE claim proven here: `mixWindow` concatenated over the 4800-sample audio
 * chunk grid equals a single whole-range `mixWindow` call SAMPLE-FOR-SAMPLE
 * (bit-exact). That is what makes the windowing stateless/correct - if a window
 * edge were not sample-aligned, or phase/envelope were evaluated window-relative
 * instead of at the absolute sample index, the seams would differ and this test
 * would fail.
 *
 * This deliberately does NOT compare against an OfflineAudioContext: OAC is
 * browser-only, and the analytic-vs-OAC RMS check is a later browser step
 * (plans/156 §2). Node-prove only the concat == whole identity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bedDuckEnvelope } from './audio-envelope.ts';
import { mixWindow, MIX_WINDOW_RATE, type MixSpec } from './mix-window.ts';

const RATE = MIX_WINDOW_RATE;
const WINDOW = 4800; // 0.1s @ 48k - the mux's own chunk grid (plans/156 §1).

/** Deterministic non-trivial stereo PCM: two decorrelated tones per channel. */
function synthStereo(nSamples: number, seed: number): Float32Array[] {
  const l = new Float32Array(nSamples);
  const r = new Float32Array(nSamples);
  const fL = 110 + seed * 37;
  const fR = 173 + seed * 41;
  for (let i = 0; i < nSamples; i++) {
    const t = i / RATE;
    l[i] = 0.6 * Math.sin(2 * Math.PI * fL * t) + 0.1 * Math.sin(2 * Math.PI * (fL * 3.1) * t + seed);
    r[i] = 0.55 * Math.sin(2 * Math.PI * fR * t + 0.5) + 0.12 * Math.sin(2 * Math.PI * (fR * 2.7) * t);
  }
  return [l, r];
}

/** Concatenate mixWindow over the 4800 grid into full-length channel buffers. */
function concatOverGrid(spec: MixSpec, total: number): [Float32Array, Float32Array] {
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let w0 = 0; w0 < total; w0 += WINDOW) {
    const w1 = Math.min(w0 + WINDOW, total);
    const [wl, wr] = mixWindow(spec, w0, w1);
    left.set(wl, w0);
    right.set(wr, w0);
  }
  return [left, right];
}

/** Bit-exact typed-array equality (Object.is per element catches -0 and NaN). */
function assertSampleForSample(a: Float32Array, b: Float32Array, label: string): void {
  assert.equal(a.length, b.length, `${label}: length`);
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) {
      assert.fail(`${label}: sample ${i} differs: whole=${a[i]} concat=${b[i]}`);
    }
  }
}

test('mixWindow: concat over the 4800 grid == whole-range call, sample-for-sample', () => {
  // A few seconds, with a partial final window (total not a multiple of 4800) so
  // the seam-at-the-tail case is covered too.
  const total = WINDOW * 25 + 1234; // 121234 samples ≈ 2.53s
  const totalSec = total / RATE;

  // Clips with INTEGER-MS starts (start_c = round(startMs·48) lands exactly).
  const clips = [
    { pcm: synthStereo(Math.round(1.0 * RATE), 1), startMs: 0 },     // [0, 1.0s)
    { pcm: synthStereo(Math.round(0.7 * RATE), 2), startMs: 500 },   // [0.5s, 1.2s) overlaps A
    { pcm: synthStereo(Math.round(1.2 * RATE), 3), startMs: 1500 },  // [1.5s, 2.7s) runs past end
  ];

  // Clip-time span windows where sequence audio plays (drives the duck).
  const spans = [
    { from: 0, to: 1.2 },
    { from: 1.5, to: totalSec },
  ];

  // Primary bed: whole-timeline loop of a short buffer, ducked under the spans.
  const bedPrimary = {
    pcm: synthStereo(Math.round(0.3 * RATE), 7), // 14400-sample loop
    events: bedDuckEnvelope({
      clipSec: totalSec,
      volume: 0.9,
      centre: 0.25,
      spans,
      fadeIn: 0.2,
      fadeOut: 0.3,
      rampSec: 0.25,
    }),
    offsetSample: 0,
    startSample: 0,
  };

  // Second bed with a non-zero loop in-point, to exercise phase wrapping.
  const bedMixIn = {
    pcm: synthStereo(Math.round(0.5 * RATE), 11), // 24000-sample buffer
    events: bedDuckEnvelope({
      clipSec: totalSec,
      volume: 0.4,
      centre: 0.5,
      spans: [{ from: 0, to: totalSec }],
      rampSec: 0.8,
    }),
    offsetSample: Math.round(0.13 * RATE), // 6240-sample in-point → loop [6240, 24000)
    startSample: 0,
  };

  const spec: MixSpec = { clips, beds: [bedPrimary, bedMixIn], rate: RATE };

  const [wholeL, wholeR] = mixWindow(spec, 0, total);
  const [concatL, concatR] = concatOverGrid(spec, total);

  assertSampleForSample(wholeL, concatL, 'left');
  assertSampleForSample(wholeR, concatR, 'right');

  // Sanity: the mix is actually non-trivial (not an all-zero identity).
  let energy = 0;
  for (let i = 0; i < wholeL.length; i++) energy += wholeL[i]! * wholeL[i]!;
  assert.ok(energy > 1, `expected a non-trivial mix, got energy ${energy}`);
});

test('mixWindow: identity holds with clips only (no beds)', () => {
  const total = WINDOW * 10 + 777;
  const clips = [
    { pcm: synthStereo(Math.round(0.4 * RATE), 5), startMs: 123 },
    { pcm: synthStereo(Math.round(0.4 * RATE), 6), startMs: 456 },
  ];
  const spec: MixSpec = { clips, beds: [], rate: RATE };

  const [wholeL, wholeR] = mixWindow(spec, 0, total);
  const [concatL, concatR] = concatOverGrid(spec, total);
  assertSampleForSample(wholeL, concatL, 'clips-only left');
  assertSampleForSample(wholeR, concatR, 'clips-only right');
});

test('mixWindow: identity holds with a single bed only (no clips)', () => {
  const total = WINDOW * 8;
  const totalSec = total / RATE;
  const spec: MixSpec = {
    clips: [],
    beds: [{
      pcm: synthStereo(Math.round(0.25 * RATE), 9),
      events: bedDuckEnvelope({ clipSec: totalSec, volume: 1, fadeIn: 0.1, fadeOut: 0.1 }),
      offsetSample: 1000,
      startSample: 0,
    }],
    rate: RATE,
  };

  const [wholeL, wholeR] = mixWindow(spec, 0, total);
  const [concatL, concatR] = concatOverGrid(spec, total);
  assertSampleForSample(wholeL, concatL, 'bed-only left');
  assertSampleForSample(wholeR, concatR, 'bed-only right');
});
