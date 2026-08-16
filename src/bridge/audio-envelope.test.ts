// SPDX-License-Identifier: MPL-2.0
/**
 * audio-envelope - the shared bed-duck gain math behind §6.1's export mixing
 * (tool audio + a mix-in bed). The real graphs run only in a browser, so the
 * envelope is proven headlessly the way an OfflineAudioContext would evaluate
 * it: bedDuckEnvelope's events are rendered to samples via envelopeGainAt (a
 * faithful set/linear-ramp evaluator) and the RMS of the head, centre and tail
 * windows is asserted against the configured levels - full at the top and tail,
 * the centre level under the primary span, ramps (never steps) between.
 *
 * Run directly:  node --test shells/web/src/bridge/audio-envelope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bedDuckEnvelope, envelopeGainAt, scheduleGainEvents,
  MIX_RAMP_SEC, CENTRE_LOW, type GainEvent,
} from './audio-envelope.ts';

/** RMS of the envelope over [from, to), sampled at 1 kHz - the "tiny mix" render. */
function rms(events: GainEvent[], from: number, to: number): number {
  const rate = 1000;
  let sum = 0, n = 0;
  for (let t = from; t < to; t += 1 / rate) { const g = envelopeGainAt(events, t); sum += g * g; n++; }
  return Math.sqrt(sum / Math.max(1, n));
}

const near = (a: number, b: number, eps = 0.02): void =>
  assert.ok(Math.abs(a - b) < eps, `expected ~${b}, got ${a}`);

test('top/tail: bed full at head and tail, centre level under the primary span', () => {
  // A 20 s clip whose primary (narration) plays 3 s → 12 s, centre = low.
  const events = bedDuckEnvelope({ clipSec: 20, centre: CENTRE_LOW, spans: [{ from: 3, to: 12 }] });
  // Windows chosen clear of the 0.8 s boundary ramps.
  near(rms(events, 0, 2.9), 1);                    // head - full
  near(rms(events, 3 + MIX_RAMP_SEC, 12 - MIX_RAMP_SEC), CENTRE_LOW);   // centre - low
  near(rms(events, 12.1, 20), 1);                  // tail - full
  // The three windows genuinely differ the way the levels say they must.
  assert.ok(rms(events, 0, 2.9) > 4 * rms(events, 4, 11));
});

test('centre off silences the bed under the span; full leaves it flat', () => {
  const off = bedDuckEnvelope({ clipSec: 20, centre: 0, spans: [{ from: 3, to: 12 }] });
  near(rms(off, 4, 11), 0);
  near(rms(off, 13, 20), 1);
  const full = bedDuckEnvelope({ clipSec: 20, centre: 1, spans: [{ from: 3, to: 12 }] });
  near(rms(full, 0, 20), 1, 0.001);                // no duck events at all
  assert.equal(full.length, 1);                    // just the opening set
});

test('boundaries are ramps, never steps', () => {
  const events = bedDuckEnvelope({ clipSec: 20, centre: 0.2, spans: [{ from: 3, to: 12 }] });
  // Mid-ramp the gain sits strictly between the levels.
  const down = envelopeGainAt(events, 3 + MIX_RAMP_SEC / 2);
  const up = envelopeGainAt(events, 12 - MIX_RAMP_SEC / 2);
  assert.ok(down > 0.25 && down < 0.95, `down ramp mid ${down}`);
  assert.ok(up > 0.25 && up < 0.95, `up ramp mid ${up}`);
  // And the largest jump between adjacent 1 ms samples is ramp-sized, not a step.
  let maxJump = 0;
  for (let t = 0; t < 20; t += 0.001) {
    maxJump = Math.max(maxJump, Math.abs(envelopeGainAt(events, t + 0.001) - envelopeGainAt(events, t)));
  }
  assert.ok(maxJump < 0.01, `max per-ms jump ${maxJump}`);
});

test('volume scales both the full and centre levels; fades wrap the envelope', () => {
  const events = bedDuckEnvelope({
    clipSec: 20, volume: 0.5, centre: 0.2, spans: [{ from: 5, to: 12 }], fadeIn: 1, fadeOut: 2,
  });
  near(envelopeGainAt(events, 0), 0);              // fade-in starts silent
  near(rms(events, 1.1, 4.9), 0.5);                // head at volume
  near(rms(events, 6, 11), 0.1);                   // centre = volume x centre
  near(rms(events, 13, 17.9), 0.5);                // tail back at volume
  near(envelopeGainAt(events, 20), 0);             // fade-out lands at silence
});

test('spans merge when the gap is too short for the bed to come back up', () => {
  const events = bedDuckEnvelope({
    clipSec: 30, centre: 0.2, spans: [{ from: 3, to: 10 }, { from: 10.5, to: 20 }],
  });
  // The 0.5 s gap (< 2 ramps) never returns to full - one continuous duck.
  near(rms(events, 10, 10.6), 0.2, 0.05);
  // A generous gap does return to full between spans.
  const apart = bedDuckEnvelope({
    clipSec: 30, centre: 0.2, spans: [{ from: 3, to: 8 }, { from: 15, to: 20 }],
  });
  near(rms(apart, 9.5, 13.5), 1);
});

test('a span shorter than the ramp pair still ducks, with proportional ramps', () => {
  const events = bedDuckEnvelope({ clipSec: 20, centre: 0, spans: [{ from: 5, to: 6 }] });
  near(envelopeGainAt(events, 5.5), 0);            // the duck bottom is reached
  near(envelopeGainAt(events, 4.9), 1);
  near(envelopeGainAt(events, 6.1), 1);
});

test('spans are clamped into the clip and out of the fade-out region', () => {
  const events = bedDuckEnvelope({
    clipSec: 10, centre: 0.2, fadeOut: 2, spans: [{ from: 6, to: 40 }],
  });
  // fs = 8: the bed is back at full when the fade-out begins, then fades.
  near(envelopeGainAt(events, 8), 1);
  near(envelopeGainAt(events, 10), 0);
});

test('scheduleGainEvents maps events onto setValueAtTime / linearRampToValueAtTime at t0', () => {
  const calls: [string, number, number][] = [];
  const g = {
    setValueAtTime: (v: number, t: number) => calls.push(['set', v, t]),
    linearRampToValueAtTime: (v: number, t: number) => calls.push(['ramp', v, t]),
  };
  scheduleGainEvents(g, [
    { t: 0, v: 1, ramp: false }, { t: 3, v: 1, ramp: false }, { t: 3.8, v: 0.2, ramp: true },
  ], 10);
  assert.deepEqual(calls, [['set', 1, 10], ['set', 1, 13], ['ramp', 0.2, 13.8]]);
});

test('tiny mix render: bed + primary reads as the §6.1 use case', () => {
  // Bed (constant 1.0 source through the envelope) mixed with a primary
  // narration over its span. What the user hears: music at the top, voice over
  // a low bed through the middle, music again at the tail - and with centre off,
  // the middle is the voice alone.
  const span = { from: 3, to: 12 };
  const low = bedDuckEnvelope({ clipSec: 20, centre: CENTRE_LOW, spans: [span] });
  const off = bedDuckEnvelope({ clipSec: 20, centre: 0, spans: [span] });
  near(rms(low, 0, 2.9), 1);                       // head: music alone, full
  near(rms(low, 4, 11), CENTRE_LOW);               // centre: bed at the low level under the voice
  near(rms(low, 12.1, 20), 1);                     // tail: music alone, full
  // Centre off: the voice (0.8 amplitude, mixed on top) is all that remains.
  const rate = 1000;
  let sum = 0, n = 0;
  for (let t = 4; t < 11; t += 1 / rate) {
    const mixed = envelopeGainAt(off, t) + 0.8;    // bed sample + voice sample
    sum += mixed * mixed; n++;
  }
  near(Math.sqrt(sum / n), 0.8);
  // Head vs centre vs tail genuinely differ per the levels, both selects.
  assert.ok(rms(low, 0, 2.9) > 4 * rms(low, 4, 11) && rms(off, 4, 11) < 0.01);
});
