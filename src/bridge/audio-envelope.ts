// SPDX-License-Identifier: MPL-2.0
/**
 * The bed-duck gain envelope - pure scheduling math shared by the two Web Audio
 * mix graphs: bridge/export.ts's looped-bed path (live AudioContext and the
 * WebCodecs OfflineAudioContext bed render) and bridge/sequence-render.ts's
 * OfflineAudioContext mix. The rule (plans/41-tts-stt-programme.md §6.1): a mix-in
 * bed plays at FULL volume wherever the primary audio (a tool's own clip, or a
 * sequence's audio boxes) is silent - before it starts and after it ends, the
 * top-and-tail intro/outro - and glides to a user-set CENTRE level underneath
 * it. Boundaries are always linear ramps (setValueAtTime/linearRampToValueAtTime
 * consumers), never hard steps.
 *
 * Deliberately dependency-free: sequence-render.ts must not import export.ts
 * (that would drag the whole rasteriser into its lazy chunk), so the one copy of
 * this math lives here and both graphs consume it.
 */

/** A window (seconds, clip time) over which the primary audio is playing. */
export interface DuckSpan { from: number; to: number }

/** The optional mix-in track riding a primary export audio selection. */
export interface ExportAudioMixIn {
  id?: string;
  url: string;
  /** Bed gain 0..1 while the primary track plays; full gain outside its extent
   *  (the top/tail intro-outro). The popup's off/low/full select: 0 / 0.2 / 1. */
  centre?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/**
 * The export bar's audio selection - THE one declaration of this shape (memory
 * export-settings-fragmentation: fields are added here once; bridge/export.ts's
 * ExportOpts and views/tool.ts's RunExportOpts both reference it). Without `mix`
 * it is the single track today's readers always understood; with `mix` the
 * primary is a tool's own audio and the mix-in bed ducks under it.
 */
export interface ExportAudio {
  id?: string;
  url: string;
  fadeIn?: number;
  fadeOut?: number;
  volume?: number;
  /** Legacy single-track duck level (the "Duck to" control, footage-under-bed). */
  duck?: number;
  /** In-point into the SOURCE, seconds (the tool's data-audio-start contract). */
  start?: number;
  /** Optional second track mixed in around/under the primary (§6.1). */
  mix?: ExportAudioMixIn;
}

/** One automation event, seconds from envelope t0.
 *  ramp=false → setValueAtTime; ramp=true → linearRampToValueAtTime (a ramp
 *  ENDING at `t`, starting from the previous event). */
export interface GainEvent { t: number; v: number; ramp: boolean }

/** Boundary ramp length, seconds - the bed glides between full and centre. */
export const MIX_RAMP_SEC = 0.8;

/** The "low" centre level of the export card's off/low/full select. */
export const CENTRE_LOW = 0.2;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Build the bed's whole gain timeline: fade in → full → (per primary span) ramp
 * down to volume·centre, hold, ramp back to full → fade out. Spans are clamped
 * into the clip (and out of the fade-out region, so the bed is back at full for
 * an authored outro fade), merged when the gap between them is too short for the
 * bed to meaningfully return to full, and spans shorter than the ramp pair use
 * proportionally shorter ramps so the duck is always honoured without a step.
 * centre ≥ 1 (or no spans) degrades to the plain fade envelope.
 */
export function bedDuckEnvelope(o: {
  clipSec: number;
  volume?: number;
  /** Bed gain multiplier 0..1 while a primary span plays; 1 = no duck. */
  centre?: number;
  spans?: DuckSpan[];
  fadeIn?: number;
  fadeOut?: number;
  rampSec?: number;
}): GainEvent[] {
  const vol = clamp01(o.volume ?? 1);
  const centre = clamp01(o.centre ?? 1);
  const ramp = Math.max(0.05, o.rampSec ?? MIX_RAMP_SEC);
  const fadeIn = Math.max(0, o.fadeIn ?? 0);
  const fadeOut = Math.max(0, o.fadeOut ?? 0);
  const clip = Math.max(0, o.clipSec);

  const events: GainEvent[] = [];
  if (fadeIn > 0) { events.push({ t: 0, v: 0, ramp: false }, { t: fadeIn, v: vol, ramp: true }); }
  else events.push({ t: 0, v: vol, ramp: false });

  // Where the fade-out begins (the bed must be back at full by here) - the same
  // `clip > fadeIn` guard the legacy single-window envelope used.
  const wantFadeOut = fadeOut > 0 && clip > fadeIn;
  const fs = wantFadeOut ? Math.max(fadeIn, clip - fadeOut) : clip;

  if (centre < 1) {
    // Clamp into [0, fs], drop empties, sort, merge overlaps and near-misses
    // (a gap shorter than a down+up ramp pair never reaches full anyway).
    const spans = (o.spans ?? [])
      .map(s => ({ from: Math.min(Math.max(0, s.from), fs), to: Math.min(Math.max(0, s.to), fs) }))
      .filter(s => s.to - s.from > 0.05)
      .sort((a, b) => a.from - b.from);
    const merged: DuckSpan[] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.from - last.to < ramp * 2) last.to = Math.max(last.to, s.to);
      else merged.push({ ...s });
    }
    const low = vol * centre;
    for (const s of merged) {
      // Never fight the fade-in ramp: the duck starts once the fade has landed.
      const a = Math.max(s.from, fadeIn);
      if (s.to - a <= 0.1) continue;
      const r = Math.min(ramp, (s.to - a) / 2);
      events.push(
        { t: a, v: vol, ramp: false },
        { t: a + r, v: low, ramp: true },
        { t: s.to - r, v: low, ramp: false },
        { t: s.to, v: vol, ramp: true },
      );
    }
  }

  if (wantFadeOut) events.push({ t: fs, v: vol, ramp: false }, { t: clip, v: 0, ramp: true });
  return events;
}

/** The subset of AudioParam the scheduler touches - fakeable in Node tests. */
export interface GainParamLike {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}

/** Apply an envelope to a gain param, offset to t0 (ctx.currentTime). */
export function scheduleGainEvents(g: GainParamLike, events: GainEvent[], t0: number): void {
  for (const e of events) {
    if (e.ramp) g.linearRampToValueAtTime(e.v, t0 + e.t);
    else g.setValueAtTime(e.v, t0 + e.t);
  }
}

/**
 * Evaluate an envelope at time t exactly as Web Audio would (a set holds, a ramp
 * interpolates linearly from the previous event). Assumes the event list starts
 * with a set at t=0, which bedDuckEnvelope guarantees. Used by tests to render a
 * tiny mix headlessly and by nothing on the hot path.
 */
export function envelopeGainAt(events: GainEvent[], t: number): number {
  let curV = events.length && !events[0]!.ramp ? events[0]!.v : 1;
  let curT = 0;
  for (const e of events) {
    if (t < e.t) {
      if (!e.ramp) return curV;
      const span = e.t - curT;
      return span > 0 ? curV + (e.v - curV) * ((t - curT) / span) : e.v;
    }
    curV = e.v;
    curT = e.t;
  }
  return curV;
}
