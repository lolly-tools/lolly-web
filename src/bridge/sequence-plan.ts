// SPDX-License-Identifier: MPL-2.0
/**
 * sequence-plan.ts — the PURE PLANNER behind deterministic sequence export
 * (Fable timeline, phase 3 §0.0 "DESIGN REQUIREMENT added by the spike").
 *
 * Node cannot run WebCodecs and Playwright's bundled Chromium has no proprietary
 * codecs, so anything that lives inside the compositor is browser-only and, in
 * practice, untested. This module therefore holds the ENTIRE correctness surface of
 * a sequence render — stage parsing, activity windows, junction crossfade alpha,
 * `clipIn + (t − start) × speed` source mapping, the fixed-fps timestamp grid, the
 * silent-truncation guard and error normalisation — with no canvas, no WebCodecs, no
 * media element and no mediabunny anywhere in it. The executor that consumes a plan
 * is a thin loop of `ctx.save()` / `drawImage` / `ctx.restore()` calls with no
 * decisions of its own.
 *
 * It reads a DOM node, but only ever `getAttribute`, `style.*`, `querySelector` and
 * `className` — everything jsdom implements — so the whole module runs headlessly
 * under `node:test`.
 *
 * PARITY IS THE POINT. The preview (views/sequence-clock.ts) and the exported file
 * must agree pixel for pixel, so:
 *   • the transition maths is IMPORTED from lib/transitions.ts, never re-derived;
 *   • the activity window is the same half-open `[start, start + dur)`;
 *   • enter/exit progress, the "whichever is further from rest wins" pick and the
 *     open-ended-box exit suppression are the same readings `transitionAt` takes;
 *   • the composed rotation is `authored + animation`, matching the CSS order
 *     `translate → rotate(authored) → rotate(anim) → scale` that the clock writes
 *     and the canvas order `translate → rotate(authored + anim) → scale` that the
 *     compositor issues.
 * tests/sequence-plan.test.ts asserts that parity against the real sequence-clock
 * functions rather than trusting this comment.
 *
 * DELIBERATELY NOT imported: views/sequence-clock.ts. This is bridge code; the
 * bridge does not depend on the views layer (no bridge module does today), and the
 * clock drags in the lottie mount + the seek queue. The overlap is ~40 lines of
 * attribute reading, and the test file pins the two implementations together.
 */

import { recTransition, isTransitionKind, type TransitionKind } from '../lib/transitions.ts';

// ── clamps (mirroring the tool hook + timeline-math, so nothing can disagree) ──

/** Ceiling for any authored time value, ms. Mirrors timeline-math's MAX_TIME_S. */
export const MAX_TIME_MS = 3_600_000;
/** Playback-rate range, mirroring timeline-math MIN_SPEED/MAX_SPEED. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
/** Transition-length range, mirroring sequence-clock's MIN/MAX_TRANSITION_MS. */
export const MIN_TRANSITION_MS = 100;
export const MAX_TRANSITION_MS = 3000;
/** The enter/exit length a box gets when it declares a kind but no duration. */
export const DEFAULT_TRANSITION_MS = 400;

/**
 * How far short of `computeDuration()` a decode may land before it counts as
 * truncated. Two output frames: one covers the ordinary "the last packet's
 * presentation time is a frame before the container's stated end" rounding, the
 * second absorbs a container whose duration is a hair long. Three or more would
 * start hiding real truncation, which is the whole thing this guard exists to catch.
 */
export const TRUNCATION_TOLERANCE_FRAMES = 2;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ── the parsed stage ────────────────────────────────────────────────────────

/** What one `.lolly-box` on a `[data-sequence]` artboard is, to the exporter. */
export interface SeqLayer {
  el: HTMLElement;
  /** DOM order — this IS the z order, exactly as the browser paints it. */
  idx: number;
  /** ms */
  startMs: number;
  /** ms. An open-ended box gets the rest of the sequence (see `openEnded`). */
  durMs: number;
  /** ms into the source media at the clip's in-point. */
  clipInMs: number;
  /** Playback-rate multiplier, 0.25–4. */
  speed: number;
  mute: boolean;
  enter: TransitionKind | null;
  enterMs: number;
  exit: TransitionKind | null;
  exitMs: number;
  lane: '' | 'seq';
  kind: 'static' | 'video' | 'lottie' | 'audio';
  /** Native px, straight off the inline style — the renderRecord read. */
  rect: { x: number; y: number; w: number; h: number; rot: number };
  /** Authored inline opacity, 0–1 (1 when unset). */
  opacity: number;
  /** Authored `mix-blend-mode`, '' when unset. */
  blend: string;
  /** Authored `border-radius`, '' when unset. */
  radius: string;
  /** Authored `clip-path`, '' when unset. */
  clipPath: string;
  /**
   * True when the box declared no `data-t-dur` — scenery, or a clip that simply
   * runs to the end of the sequence. NOT in the phase-3 sketch's interface, but
   * required for parity: sequence-clock suppresses the exit transition of a box
   * whose `dur` is null (its end moves as the composition is edited, so it has no
   * stable tail to fade into), and `durMs` alone cannot express that.
   */
  openEnded: boolean;
}

export interface SequenceStage {
  layers: SeqLayer[];
  /** Sequence length, ms. 0 when the composition declares nothing timed. */
  totalMs: number;
}

function num(raw: string | null, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** A style property, read defensively — a synthetic element may have no `style`. */
function styleProp(el: HTMLElement, prop: string): string {
  try {
    const v = el.style?.getPropertyValue?.(prop);
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

function stylePx(el: HTMLElement, prop: string): number {
  const v = parseFloat(styleProp(el, prop));
  return Number.isFinite(v) ? v : 0;
}

/** The `rotate(Ndeg)` term of an inline transform — the renderRecord regex. */
export function rotationOf(transform: string): number {
  const m = /rotate\(\s*(-?[\d.]+)deg\s*\)/.exec(transform || '');
  const v = m ? parseFloat(m[1] as string) : 0;
  return Number.isFinite(v) ? v : 0;
}

function hasClass(el: HTMLElement, cls: string): boolean {
  try {
    if (el.classList?.contains?.(cls)) return true;
  } catch {
    /* synthetic element */
  }
  return Boolean(el.querySelector?.(`.${cls}`));
}

/**
 * What kind of thing this box paints.
 *
 * `video` also matches a box whose `<video>` has already been swapped for a frozen
 * still by export.ts's `snapshotMotion` — that swap copies the video's className, so
 * `.lolly-box-video` survives it. Ordering matters: an audio box carries a marker
 * div and nothing else, and must never fall through to `static`.
 */
export function layerKind(el: HTMLElement): SeqLayer['kind'] {
  if (hasClass(el, 'lolly-box-audio') || el.querySelector?.('[data-audio-src]')) return 'audio';
  if (hasClass(el, 'lolly-box-lottie') || el.querySelector?.('[data-lottie-src]')) return 'lottie';
  if (el.querySelector?.('video') || hasClass(el, 'lolly-box-video')) return 'video';
  return 'static';
}

/**
 * Read one `.lolly-box` into a SeqLayer.
 *
 * Tolerant of EVERYTHING. Every one of these attributes is reachable from a
 * hand-authored URL, so the answer must always be a legal layer rather than a NaN
 * that poisons a 900-frame render half way through.
 */
export function readLayer(el: HTMLElement, idx: number, totalMs: number): SeqLayer {
  const startRaw = el.getAttribute?.('data-t-start') ?? null;
  const durRaw = el.getAttribute?.('data-t-dur') ?? null;
  const durNum = durRaw == null || durRaw === '' ? Number.NaN : parseFloat(durRaw);
  const openEnded = !Number.isFinite(durNum);
  const startMs = clamp(num(startRaw, 0), 0, MAX_TIME_MS);
  const enter = el.getAttribute?.('data-t-enter') ?? null;
  const exit = el.getAttribute?.('data-t-exit') ?? null;
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0;
  return {
    el,
    idx,
    startMs,
    // An open-ended box (scenery, or a clip with no authored length) runs to the end
    // of the sequence — the same reading sequence-clock's endOf takes.
    durMs: openEnded ? Math.max(0, total - startMs) : clamp(durNum, 0, MAX_TIME_MS),
    clipInMs: clamp(num(el.getAttribute?.('data-clip-in') ?? null, 0), 0, MAX_TIME_MS),
    speed: clamp(num(el.getAttribute?.('data-t-speed') ?? null, 1), MIN_SPEED, MAX_SPEED),
    mute: (el.getAttribute?.('data-t-mute') ?? null) === '1',
    enter: isTransitionKind(enter) ? enter : null,
    enterMs: clamp(num(el.getAttribute?.('data-t-enter-ms') ?? null, DEFAULT_TRANSITION_MS), MIN_TRANSITION_MS, MAX_TRANSITION_MS),
    exit: isTransitionKind(exit) ? exit : null,
    exitMs: clamp(num(el.getAttribute?.('data-t-exit-ms') ?? null, DEFAULT_TRANSITION_MS), MIN_TRANSITION_MS, MAX_TRANSITION_MS),
    lane: (el.getAttribute?.('data-t-lane') ?? null) === 'seq' ? 'seq' : '',
    kind: layerKind(el),
    rect: {
      x: stylePx(el, 'left'),
      y: stylePx(el, 'top'),
      w: Math.max(0, stylePx(el, 'width')),
      h: Math.max(0, stylePx(el, 'height')),
      rot: rotationOf(styleProp(el, 'transform')),
    },
    opacity: clamp(num(styleProp(el, 'opacity') || null, 1), 0, 1),
    blend: styleProp(el, 'mix-blend-mode'),
    radius: styleProp(el, 'border-radius'),
    clipPath: styleProp(el, 'clip-path'),
    openEnded,
  };
}

/**
 * Parse a render target into a sequence stage, or null when it isn't one.
 *
 * "Is one" means the node, or a descendant, carries `[data-sequence]` — the
 * all-or-nothing marker the tool hook stamps on the artboard when the composition
 * has anything timed at all. Everything below is read from THAT element, not from
 * `node`, so an export wrapper around the artboard changes nothing.
 */
export function parseSequenceStage(node: HTMLElement): SequenceStage | null {
  if (!node) return null;
  const stage = node.matches?.('[data-sequence]')
    ? node
    : (node.querySelector?.('[data-sequence]') as HTMLElement | null);
  if (!stage) return null;
  const msEl = stage.matches?.('[data-seq-ms]')
    ? stage
    : (stage.querySelector?.('[data-seq-ms]') as HTMLElement | null)
      ?? (node.querySelector?.('[data-seq-ms]') as HTMLElement | null);
  const rawMs = num(msEl?.getAttribute?.('data-seq-ms') ?? null, 0);
  const totalMs = rawMs > 0 ? Math.min(rawMs, MAX_TIME_MS) : 0;
  const els = stage.querySelectorAll ? [...stage.querySelectorAll<HTMLElement>('.lolly-box')] : [];
  return { layers: els.map((el, i) => readLayer(el, i, totalMs)), totalMs };
}

/**
 * The same stage, re-resolved against a different length.
 *
 * Only OPEN-ENDED layers change: they have no authored duration, so "runs to the end
 * of the sequence" has to be re-read against the new end (that is exactly what
 * readLayer did with the parsed `data-seq-ms`). A bounded clip keeps its authored
 * span — a longer total gives whatever the composition shows past its last clip, a
 * shorter one simply stops rendering before the tail, because the frame grid the
 * caller builds from `totalMs` is what decides how far the render goes.
 */
export function withTotalMs(stage: SequenceStage, totalMs: number): SequenceStage {
  const total = Math.round(clamp(totalMs, 0, MAX_TIME_MS));
  if (!(total > 0) || total === stage.totalMs) return stage;
  return {
    totalMs: total,
    layers: stage.layers.map(l => (l.openEnded ? { ...l, durMs: Math.max(0, total - l.startMs) } : l)),
  };
}

/**
 * Honour an explicit export-bar duration.
 *
 * The rule (Fable timeline): the clip's length IS the timeline's length, unless the
 * user directly intervened on this export. The shell flags that intervention with
 * `durationUserSet` — set when, and only when, the user actually edited the duration
 * field — and the sequence tool's own beforeExport leaves `opts.duration` alone in
 * that case instead of overwriting it with the derived length. Without the flag the
 * stage keeps the length it declared in `data-seq-ms`, so the export tracks the
 * timeline automatically.
 */
export function applyDurationOverride(
  stage: SequenceStage,
  opts: { duration?: unknown; durationUserSet?: unknown } | null | undefined,
): SequenceStage {
  if (!opts || opts.durationUserSet !== true) return stage;
  const secs = typeof opts.duration === 'number' ? opts.duration : parseFloat(String(opts.duration ?? ''));
  if (!Number.isFinite(secs) || secs <= 0) return stage;
  return withTotalMs(stage, secs * 1000);
}

// ── the draw plan ───────────────────────────────────────────────────────────

/** One layer's fully-resolved state at one instant. The executor just draws it. */
export interface PlanItem {
  /**
   * The layer, with `durMs` resolved against the totalMs the plan was asked for
   * (an open-ended box is handed back as a copy carrying the span it actually ran
   * for). `layer.el` is always the original element reference.
   */
  layer: SeqLayer;
  /**
   * Position inside the layer's own source media, seconds — `clipIn + local × speed`.
   * null for a `static` layer (there is no source to seek).
   */
  sourceSec: number | null;
  /** Authored opacity × the transition's alpha, 0–1. */
  alpha: number;
  /** Transition translation, px (applied OUTSIDE the rotation, like the clock). */
  dx: number;
  dy: number;
  /** Transition scale about the box centre. */
  scale: number;
  /** Authored rotation + the transition's, degrees. */
  rot: number;
}

const IDENTITY = { dx: 0, dy: 0, sc: 1, alpha: 1, rot: 0 } as const;

/** A layer's nominal end, ms — before any crossfade extension. */
export function endOf(layer: SeqLayer): number {
  return layer.startMs + layer.durMs;
}

/**
 * The junction crossfades a set of layers IMPLIES, as `layer.idx → extra ms`.
 *
 * Phase 2 stores no overlap in the model: a crossfade is authored as
 * `A.exit = 'fade'`, `B.enter = 'fade'` on two GAPLESS neighbours in the seq lane,
 * and its length is `min(A.exitMs, B.enterMs)` "straddling the cut". The preview
 * cannot show that (a DOM box that has left its window is `display:none`), so the
 * export derives it here: A stays alive for that long past the cut, fading out,
 * while B fades in over the same window — so at the midpoint the two alphas are
 * equal and neither clip is ever fully absent.
 *
 * Both sides use the SAME derived length, which is what makes the alphas cross;
 * B's own longer `enterMs`, if it has one, does not stretch the handover.
 *
 * The length is ALSO clamped to `B.durMs`. Nothing else bounds it: the two
 * transition lengths are independent of the clips they belong to, so a 1000 ms
 * `exitMs` handing over to a 200 ms clip would keep A alive 800 ms past the end of
 * the very clip it was handing over to — and `recTransition`'s alpha holds at
 * exactly 1.0 for the first 40 % of a fade, so A would reappear at FULL opacity on
 * top of whatever came after B. Since B starts where A ends, clamping to `B.durMs`
 * is also what keeps the tail inside the sequence.
 *
 * Adjacency is `A.end === B.start` within a 1 ms tolerance, because the authored
 * times are rounded to milliseconds by the tool hook.
 */
export function crossfadeJunctions(layers: SeqLayer[]): { aIdx: number; bIdx: number; ms: number }[] {
  const out: { aIdx: number; bIdx: number; ms: number }[] = [];
  const seq = layers.filter((l) => l.lane === 'seq' && l.durMs > 0).sort((a, b) => a.startMs - b.startMs || a.idx - b.idx);
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i] as SeqLayer;
    const b = seq[i + 1] as SeqLayer;
    if (a.exit !== 'fade' || b.enter !== 'fade') continue;
    if (a.openEnded) continue;                      // no stable tail to hand over from
    if (Math.abs(endOf(a) - b.startMs) > 1) continue;
    const ms = Math.min(a.exitMs, b.enterMs, b.durMs);
    if (ms > 0) out.push({ aIdx: a.idx, bIdx: b.idx, ms });
  }
  return out;
}

/** The outgoing side of every junction crossfade: `layer.idx → extra ms of life`. */
export function crossfadeExtensions(layers: SeqLayer[]): Map<number, number> {
  return new Map(crossfadeJunctions(layers).map((j) => [j.aIdx, j.ms]));
}

/** Where a layer's picture actually stops, ms — its end plus any crossfade tail. */
function liveEndOf(layer: SeqLayer, extendMs: number): number {
  return endOf(layer) + extendMs;
}

/**
 * The animation state of an ACTIVE layer at `tMs`, or null when it is at rest.
 *
 * Identical in every respect to sequence-clock's `transitionAt` — enter forward from
 * the head, exit backward into the tail, whichever is further from rest wins, exits
 * suppressed on an open-ended box — except for the crossfade case, where A's exit is
 * DEFERRED into the extension window past the cut instead of running before it, and
 * B's enter is shortened to the handover length so the two alphas cross.
 */
function transitionOf(layer: SeqLayer, tMs: number, extendMs: number, xfadeEnterMs: number | null): { kind: TransitionKind; p: number } | null {
  const local = tMs - layer.startMs;
  const enterMs = xfadeEnterMs ?? layer.enterMs;
  let enterP = 1;
  if (layer.enter && layer.enter !== 'none' && enterMs > 0 && local < enterMs) {
    enterP = clamp(local / enterMs, 0, 1);
  }
  let exitP = 1;
  if (extendMs > 0) {
    // Crossfade tail: at rest right up to the cut, then out across the handover.
    const past = tMs - endOf(layer);
    if (past >= 0) exitP = clamp(1 - past / extendMs, 0, 1);
  } else if (layer.exit && layer.exit !== 'none' && !layer.openEnded && layer.exitMs > 0) {
    const remain = endOf(layer) - tMs;
    if (remain < layer.exitMs) exitP = clamp(remain / layer.exitMs, 0, 1);
  }
  if (enterP >= 1 && exitP >= 1) return null;
  return enterP <= exitP
    ? { kind: layer.enter as TransitionKind, p: enterP }
    : { kind: (extendMs > 0 ? 'fade' : layer.exit) as TransitionKind, p: exitP };
}

/**
 * Everything visible at `tMs`, in z (DOM) order.
 *
 * Audio layers ARE included while they are active — the mix needs their span and
 * their `sourceSec` — but they paint nothing: an executor must skip
 * `item.layer.kind === 'audio'` when drawing, exactly as the clock skips writing a
 * transform for one.
 */
export function sequenceDrawPlan(layers: SeqLayer[], tMs: number, totalMs: number): PlanItem[] {
  const t = Number.isFinite(tMs) ? tMs : 0;
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0;
  // An OPEN-ENDED box runs to the end of the sequence, and the caller's totalMs is
  // the authority on where that is — a parse-time duration can be stale (the stage
  // was re-rendered, or the exporter padded the tail). Re-derive rather than trust.
  const spanOf = (l: SeqLayer): SeqLayer =>
    l.openEnded && total > 0 ? { ...l, durMs: Math.max(0, total - l.startMs) } : l;
  const spans = layers.map(spanOf);
  const junctions = crossfadeJunctions(spans);
  const ext = new Map(junctions.map((j) => [j.aIdx, j.ms]));
  // B's enter is clamped to the handover length at a crossfade junction, so the two
  // alphas cross rather than B taking its own (possibly longer) time to arrive.
  const xfadeEnter = new Map(junctions.map((j) => [j.bIdx, j.ms]));
  const out: PlanItem[] = [];
  for (const layer of spans) {
    const extendMs = ext.get(layer.idx) ?? 0;
    // A zero-length window is empty — an open-ended box in an untimed composition
    // (totalMs 0), or a clip trimmed to nothing, is never on screen.
    if (layer.durMs <= 0 && extendMs <= 0) continue;
    if (t < layer.startMs || t >= liveEndOf(layer, extendMs)) continue;
    const tr = layer.kind === 'audio' ? null : transitionOf(layer, t, extendMs, xfadeEnter.get(layer.idx) ?? null);
    const off = tr ? recTransition(tr.kind, tr.p, layer.rect.w, layer.rect.h) : IDENTITY;
    const local = Math.max(0, t - layer.startMs);
    out.push({
      layer,
      sourceSec: layer.kind === 'static' ? null : (layer.clipInMs + local * layer.speed) / 1000,
      alpha: clamp(layer.opacity * off.alpha, 0, 1),
      dx: off.dx,
      dy: off.dy,
      scale: off.sc,
      rot: layer.rect.rot + off.rot,
    });
  }
  return out;
}

// ── the frame grid ──────────────────────────────────────────────────────────

/**
 * The output frame times, ms: `n × 1000 / fps` for n in [0, ceil(totalMs/1000 × fps)).
 *
 * Written as `(n * 1000) / fps` rather than `n * (1000 / fps)` so the grid is exact
 * on every whole second at 24/25/30/60 fps instead of accumulating a float drift
 * that eventually costs a frame at the end of a long sequence.
 */
export function frameTimestamps(totalMs: number, fps: number): number[] {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return [];
  if (!Number.isFinite(fps) || fps <= 0) return [];
  const count = Math.ceil((totalMs / 1000) * fps - 1e-9);
  const out: number[] = [];
  for (let n = 0; n < count; n++) out.push((n * 1000) / fps);
  return out;
}

/** Which frames of one output grid a layer is on screen for, and what it decodes. */
export interface FrameWindow {
  /** First grid index the layer is live at, -1 when it never is. */
  first: number;
  /** Last grid index the layer is live at, -1 when it never is. */
  last: number;
  /**
   * The SOURCE times (SECONDS) this layer's decoder will be asked for, ascending —
   * one per live frame. Empty for a `static` layer (there is nothing to seek).
   */
  span: number[];
}

/**
 * A layer's activity window against ONE EXPLICIT GRID.
 *
 * The grid is a parameter rather than something re-derived from `(fps, totalMs)`
 * because the orchestrator does not always walk the whole grid: a gif/apng export
 * is capped to `maxVideoFrames()`. When the window and the loop disagree, provider
 * lifetime, the overlap budget and — worst — the truncation verdict are all computed
 * against frames that were never rendered, and a perfectly complete export dies as
 * SEQ_TRUNCATED after every frame has already been encoded. One grid, one window,
 * one answer; and phase 2.5's contact sheet gets to pass its own sparse grid.
 *
 * `extraMs` is the layer's crossfade tail from `crossfadeExtensions`, if any: those
 * frames are composited too, so their samples must be decoded too.
 */
export function activeFrameWindow(layer: SeqLayer, grid: number[], extraMs = 0): FrameWindow {
  const extend = Number.isFinite(extraMs) && extraMs > 0 ? extraMs : 0;
  const end = liveEndOf(layer, extend);
  const span: number[] = [];
  let first = -1;
  let last = -1;
  for (let i = 0; i < grid.length; i++) {
    const t = grid[i] as number;
    if (t < layer.startMs) continue;
    if (t >= end) break;
    if (first < 0) first = i;
    last = i;
    if (layer.kind !== 'static') span.push((layer.clipInMs + (t - layer.startMs) * layer.speed) / 1000);
  }
  return { first, last, span };
}

/**
 * The SOURCE times (SECONDS) this layer's decoder will be asked for, ascending.
 *
 * This is the list to hand straight to mediabunny's `samplesAtTimestamps()`: it is
 * monotonically sorted by construction (speed is always positive), so the sink takes
 * its optimised path and decodes each packet at most once — spike rule 2.
 *
 * A convenience over `activeFrameWindow` for the full grid; the orchestrator uses
 * the window directly so its loop and its span can never be built from different
 * grids.
 */
export function activeSpanTimestamps(layer: SeqLayer, fps: number, totalMs: number, extraMs = 0): number[] {
  return activeFrameWindow(layer, frameTimestamps(totalMs, fps), extraMs).span;
}

// ── error normalisation (spike rule 8) ──────────────────────────────────────

/** Every failure this pipeline is allowed to report. */
export const SEQ_ERROR_CODES = Object.freeze([
  'SEQ_UNSUPPORTED_MEDIA',
  'SEQ_DECODE_FAILED',
  'SEQ_TRUNCATED',
  'SEQ_NO_CODEC',
  'SEQ_TOO_HEAVY',
  'SEQ_ABORTED',
] as const);

export type SeqErrorCode = (typeof SEQ_ERROR_CODES)[number];

export interface CodedError {
  code: SeqErrorCode;
  message: string;
}

function isSeqCode(v: unknown): v is SeqErrorCode {
  return typeof v === 'string' && (SEQ_ERROR_CODES as readonly string[]).includes(v);
}

/** An Error carrying one of our codes, so a throw survives `toCodedError` intact. */
export class SequenceError extends Error {
  readonly code: SeqErrorCode;
  constructor(code: SeqErrorCode, message: string) {
    super(message);
    this.name = 'SequenceError';
    this.code = code;
  }
}

export function sequenceError(code: SeqErrorCode, message: string): SequenceError {
  return new SequenceError(code, message);
}

function nameOf(e: object): string {
  const n = (e as { name?: unknown }).name;
  if (typeof n === 'string' && n) return n;
  const ctor = (e as { constructor?: { name?: unknown } }).constructor;
  return typeof ctor?.name === 'string' ? ctor.name : '';
}

function messageOf(e: object): string {
  const m = (e as { message?: unknown }).message;
  if (typeof m === 'string' && m) return m;
  try {
    return String(e);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Normalise ANY throw from the sequence pipeline into one coded shape.
 *
 * Three flavours arrive here (spike rule 8) and none of them can be tested with
 * `instanceof`: mediabunny's typed errors come from a lazily-imported chunk, WebCodecs
 * throws `DOMException` (absent in Node entirely), and plain `Error`s carry their
 * meaning only in the message. So this matches on NAMES and message shape — which is
 * also what makes it unit-testable without a browser.
 */
export function toCodedError(e: unknown): CodedError {
  if (e == null) return { code: 'SEQ_DECODE_FAILED', message: 'Unknown error' };
  if (typeof e === 'string') return { code: 'SEQ_DECODE_FAILED', message: e };
  if (typeof e !== 'object') return { code: 'SEQ_DECODE_FAILED', message: String(e) };

  const code = (e as { code?: unknown }).code;
  if (isSeqCode(code)) return { code, message: messageOf(e) };

  const name = nameOf(e);
  const msg = messageOf(e);
  const low = `${name} ${msg}`.toLowerCase();

  // mediabunny's typed errors.
  if (name === 'UnsupportedInputFormatError') return { code: 'SEQ_UNSUPPORTED_MEDIA', message: msg };
  if (name === 'InputDisposedError') return { code: 'SEQ_ABORTED', message: msg };

  // WebCodecs / DOM.
  if (name === 'AbortError') return { code: 'SEQ_ABORTED', message: msg };
  if (name === 'NotSupportedError') return { code: 'SEQ_NO_CODEC', message: msg };
  if (name === 'QuotaExceededError') return { code: 'SEQ_TOO_HEAVY', message: msg };
  if (name === 'EncodingError' || name === 'OperationError' || name === 'InvalidStateError' || name === 'DataError') {
    return { code: 'SEQ_DECODE_FAILED', message: msg };
  }

  // Plain Errors, where only the wording carries the meaning.
  if (/truncat|unexpected end|incomplete file/.test(low)) return { code: 'SEQ_TRUNCATED', message: msg };
  if (/abort|cancell?ed/.test(low)) return { code: 'SEQ_ABORTED', message: msg };
  if (/out of memory|allocation failed|too (large|heavy|many)/.test(low)) return { code: 'SEQ_TOO_HEAVY', message: msg };
  if (/codec|not supported|unsupported|cannot be decoded/.test(low)) return { code: 'SEQ_NO_CODEC', message: msg };
  return { code: 'SEQ_DECODE_FAILED', message: msg };
}

// ── the silent-truncation guard (spike rule 7) ──────────────────────────────

export interface ReconcileInput {
  /** The span that was asked for, seconds — already clamped to what the source can
   *  actually answer (see `sourceFrameSec` for why the end is fuzzy). */
  expectedSec: number;
  /** How many frames the decode actually yielded. */
  decodedFrames: number;
  /** The last decoded sample's timestamp, seconds, zero-based on the span. */
  lastTsSec: number;
  /** The rate the span was sampled at, in the SOURCE's own time domain. */
  fps: number;
  /**
   * How many samples the executor actually asked the provider for.
   *
   * `decodedFrames` counts DRAWS, and the executor legitimately skips them: a fully
   * transparent box, a zero-size box, the first frame of a fade (whose alpha is
   * exactly 0). Counting a skipped draw as a missing frame turns a hidden
   * audio-only clip into a whole-export SEQ_TRUNCATED. Omit to fall back to "assume
   * the whole span was asked for"; 0 means nothing was asked and nothing can be
   * concluded.
   */
  requestedFrames?: number;
  /**
   * Requests that landed past the source's own duration — a clip trimmed longer
   * than its media, which the timeline permits and which is NOT truncation.
   */
  unreachableFrames?: number;
  /**
   * The source's own frame interval, seconds, when it is known.
   *
   * The tolerance below is in span frames, but the error it has to absorb is one
   * SOURCE frame: `lastTsSec` is the decoded sample's presentation time, which lags
   * the requested time by up to the source's frame interval. Without this a 12 fps
   * screen recording, or any clip slowed below 0.5x (which samples the source
   * FASTER than the output rate), reports a shortfall it does not have.
   */
  sourceFrameSec?: number;
}

/**
 * Did the decode actually cover the clip, or did it quietly stop early?
 *
 * A truncated container decodes a CLEAN, short iteration with no error at all, so a
 * try/catch proves nothing — the only evidence is arithmetic. Two independent
 * signals are checked and the worse one wins: the last presented timestamp (which
 * catches a decode that stopped mid-file) and the answer count (which catches a
 * decode that skipped packets while still reaching the end).
 *
 * Tolerance is TRUNCATION_TOLERANCE_FRAMES span frames plus one source frame — see
 * those two fields.
 */
export function reconcileDecoded(opts: ReconcileInput): { ok: boolean; shortfallSec: number } {
  const fps = Number.isFinite(opts.fps) && opts.fps > 0 ? opts.fps : 30;
  const frame = 1 / fps;
  const expected = Number.isFinite(opts.expectedSec) && opts.expectedSec > 0 ? opts.expectedSec : 0;
  if (expected <= 0) return { ok: true, shortfallSec: 0 };
  const requested = Number.isFinite(opts.requestedFrames as number)
    ? Math.max(0, Math.trunc(opts.requestedFrames as number))
    : null;
  // The executor never asked this provider for anything (an invisible layer kept
  // only for its audio). Silence is the correct answer, not evidence of a bad file.
  if (requested === 0) return { ok: true, shortfallSec: 0 };
  const frames = Number.isFinite(opts.decodedFrames) && opts.decodedFrames > 0 ? opts.decodedFrames : 0;
  const lastTs = Number.isFinite(opts.lastTsSec) && opts.lastTsSec > 0 ? opts.lastTsSec : 0;
  const unreachable = Number.isFinite(opts.unreachableFrames as number)
    ? Math.max(0, Math.trunc(opts.unreachableFrames as number))
    : 0;
  const srcFrame = Number.isFinite(opts.sourceFrameSec as number) && (opts.sourceFrameSec as number) > 0
    ? (opts.sourceFrameSec as number)
    : 0;
  // The final frame is PRESENTED one frame before the source's end, so a complete
  // decode reaches `expected - frame`, not `expected`.
  const byTs = expected - (lastTs + frame);
  // Unanswered REQUESTS, in seconds — the direct measure of a file that stopped
  // answering. Requests the source could never answer (past its end) don't count.
  const byCount = requested != null
    ? (requested - unreachable - frames) * frame
    : expected - frames * frame;
  const shortfallSec = Math.max(0, byTs, byCount);
  const tolerance = TRUNCATION_TOLERANCE_FRAMES * frame + srcFrame + 1e-9;
  return { ok: shortfallSec <= tolerance, shortfallSec };
}
