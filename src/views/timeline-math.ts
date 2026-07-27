// timeline-math.ts — DOM-free time math for the timeline panel (Fable timeline, phase 2).
//
// Sibling of free-canvas-math.ts: that module owns the SPATIAL half of a `boxes`
// block input (x/y/w/h/rot in native px), this one owns the TEMPORAL half
// (start/dur/clipIn/speed/lane in seconds). Same contract, same habits — it reads a
// FLAT array of box rows plus a `cfg` naming the sub-fields that carry timing, it is
// pure (returns NEW boxes / arrays, never mutates), and it never touches the DOM, so
// every interaction edge case is unit-testable at the repo root rather than trapped
// inside the panel controller.
//
// Units: SECONDS everywhere in this module's inputs and box fields (that is what the
// manifest's time fields store). The ONE exception is deriveDuration, which returns
// MILLISECONDS because it must return the byte-identical number to the tool hook's
// seqDurationMs — the derived length the hook already stamps on the artboard as
// data-seq-ms. Getting those two to disagree is a real bug we have already hit once,
// so the clamps below are written to mirror the hook's line for line:
//
//   layout-studio/hooks.js: num / clamp / isFiniteNum / startSeconds / seqDurationMs
//
// Lanes: a box is on the SEQ lane (the magnetic, gapless row) when lane === 'seq'.
// A box with a finite `start` but no lane is an OVERLAY (free-floating in time). A box
// with neither is SCENERY — always visible, never timed, and invisible to every
// function here.

import { num, type Box } from './free-canvas-math.ts';

export type { Box };

/** Which sub-fields of a box carry its timing (from the input's `canvas` flag). */
export interface TimeCfg {
  startField: string;
  durField: string;
  clipInField: string;
  speedField: string;
  enterField: string;
  exitField: string;
  enterMsField: string;
  exitMsField: string;
  muteField: string;
  laneField: string;
  idField: string;
}

/** A box's timing, resolved. `start`/`dur` stay null when unauthored (scenery / open-ended). */
export interface BoxTiming {
  start: number | null;
  dur: number | null;
  clipIn: number;
  speed: number;
  lane: '' | 'seq';
}

/** Result of {@link snapTime}: the (possibly snapped) time, and which candidate won. */
export interface SnapTimeResult {
  t: number;
  snapped: number | null;
}

/** A box's media length in seconds, when the caller knows it (probe/metadata). */
export type MediaDurFn = (box: Box, index: number) => number | null | undefined;

// ── constants (kept in lockstep with layout-studio/hooks.js) ───────────────────

/** Ceiling for every authored time value, seconds. Mirrors the hook's MAX_TIME_S. */
export const MAX_TIME_S = 3600;
/** Floor for a clip's on-timeline duration, seconds. Mirrors the hook's dur clamp. */
export const MIN_DUR = 0.1;
/** Length given to a seq clip that has no duration and no known media length. */
export const DEFAULT_CLIP_S = 3;
/** Fallback sequence length when something is timed but nothing has a duration. */
export const DEFAULT_SEQ_S = 5;
/** Default snap threshold, in SCREEN pixels (the free-canvas SNAP_PX convention). */
export const SNAP_PX = 6;
/**
 * Playback-rate range. THE source of truth: the hook clamps to it, sequence-clock
 * re-exports these two (rather than declaring its own pair), and every writer here
 * clamps through them. Two functions that must agree share their clamp helpers.
 */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

// One clamp, shared by the attribute-facing readers and the derived-duration
// function, so the two can never drift apart (they did once; that is why this is a
// single exported helper rather than two inline expressions).
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** Round to milliseconds. Time fields are authored in seconds; 3dp is the wire's resolution. */
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Round to 2dp — the speed field's resolution (mirrors the hook's f2). */
const f2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Does `v` parse to a finite number at all, as opposed to num()'s "finite, or fall
 * back"? This is what distinguishes an authored 0 from an empty field: start:''
 * means scenery, start:0 means "enters at the top". Mirrors the hook's isFiniteNum.
 */
export function isFiniteNum(v: unknown): boolean {
  if (v == null || v === '') return false;
  const x = typeof v === 'number' ? v : parseFloat(v as string);
  return Number.isFinite(x);
}

// ── readers ───────────────────────────────────────────────────────────────────

/** Read a box's timing, tolerant of stringy/absent/hostile fields. */
export function boxTiming(box: Box | undefined, cfg: TimeCfg): BoxTiming {
  const b = box || {};
  const start = isFiniteNum(b[cfg.startField]) ? clamp(num(b[cfg.startField], 0), 0, MAX_TIME_S) : null;
  const dur = isFiniteNum(b[cfg.durField]) ? clamp(num(b[cfg.durField], 0), MIN_DUR, MAX_TIME_S) : null;
  return {
    start,
    dur,
    clipIn: clamp(num(b[cfg.clipInField], 0), 0, MAX_TIME_S),
    speed: f2(clamp(num(b[cfg.speedField], 1), 0.25, 4)),
    lane: b[cfg.laneField] === 'seq' ? 'seq' : '',
  };
}

/** True when the box participates in the timeline at all (i.e. is not scenery). */
export function isTimed(box: Box | undefined, cfg: TimeCfg): boolean {
  const t = boxTiming(box, cfg);
  return t.lane === 'seq' || t.start !== null;
}

/**
 * The sequence's total derived length in MILLISECONDS — byte-identical to the tool
 * hook's seqDurationMs for the same boxes (the panel's ruler and the artboard's
 * data-seq-ms must agree exactly). `dur` is TIMELINE seconds (the author's own trim,
 * already reflecting any speed change), so it is never multiplied by speed here.
 */
export function deriveDuration(boxes: Box[], cfg: TimeCfg): number {
  const rows = Array.isArray(boxes) ? boxes : [];
  let timed = 0;
  let max = 0;
  let anyDur = false;
  for (const b of rows) {
    if (!b) continue;
    const t = boxTiming(b, cfg);
    if (t.lane !== 'seq' && t.start === null) continue;
    timed++;
    if (t.dur === null) continue;
    anyDur = true;
    const end = ((t.start ?? 0) + t.dur) * 1000;
    if (end > max) max = end;
  }
  if (anyDur) return Math.round(max);
  return timed ? DEFAULT_SEQ_S * 1000 : 0;
}

/** Indices of the seq-lane boxes, in play order: by start, ties broken by array index. */
function seqIndices(boxes: Box[], cfg: TimeCfg): number[] {
  const rows = Array.isArray(boxes) ? boxes : [];
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && boxTiming(rows[i], cfg).lane === 'seq') out.push(i);
  }
  // A seq clip with no authored start has not been packed yet — park it at the end
  // rather than at 0, so an appended clip lands after the existing row.
  const key = (i: number): number => boxTiming(rows[i], cfg).start ?? Number.POSITIVE_INFINITY;
  return out.sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka === kb) return a - b;   // Infinity === Infinity, so ties stay index-ordered
    return ka < kb ? -1 : 1;
  });
}

/** The seq-lane boxes, in play order (by start, ties by array index). */
export function seqBoxes(boxes: Box[], cfg: TimeCfg): Box[] {
  return seqIndices(boxes, cfg).map((i) => boxes[i]!);
}

/** Index of the row carrying `id`, or -1. Matches on the cfg id field only. */
export function indexOfId(boxes: Box[], cfg: TimeCfg, id: string): number {
  const rows = Array.isArray(boxes) ? boxes : [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]?.[cfg.idField];
    if (v != null && v !== '' && String(v) === String(id)) return i;
  }
  return -1;
}

// ── writers ───────────────────────────────────────────────────────────────────

/** Patch a box, preserving object identity when nothing actually changes. */
function withFields(box: Box, patch: Record<string, number | string>): Box {
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (box[k] !== patch[k]) { changed = true; break; }
  }
  return changed ? { ...box, ...patch } : box;
}

/**
 * The media safety net, shared by every writer that can move an in-point, a length
 * or a rate: each field independently in range, the in-point inside the file, and —
 * once everything is on the millisecond grid — the out-point inside the file too.
 *
 * Extracted so `trimClip`, `setClipIn` and `setSpeed` cannot drift: the invariant
 * `clipIn + dur * speed <= media` is unrecoverable when violated (the player seeks
 * past the source duration and the bar plays nothing), so exactly one function is
 * allowed to decide what it means.
 *
 * Ordering is deliberate: snap to the grid BEFORE the final room check, because
 * these are the numbers that actually get STORED — checking un-rounded values and
 * rounding afterwards lets a half-millisecond (x speed) overrun back in. clipIn is
 * floored, which can only move the in-point earlier, i.e. always inside the file.
 */
function fitToMedia(
  start: number, dur: number, clipIn: number, speed: number, media: number | null,
): { start: number; dur: number; clipIn: number } {
  let s = clamp(num(start, 0), 0, MAX_TIME_S);
  let c = clamp(num(clipIn, 0), 0, MAX_TIME_S);
  let d = clamp(num(dur, MIN_DUR), MIN_DUR, MAX_TIME_S);
  // Clamping `dur` alone cannot express "clipIn is past the end".
  if (media != null) c = Math.min(c, Math.max(0, media - MIN_DUR * speed));
  s = r3(s);
  c = Math.floor(c * 1000) / 1000;
  d = r3(d);
  if (media != null) {
    // Room left in the file, floored to the grid. The MIN_DUR floor wins when the media
    // is shorter than one minimum-length clip at this speed (a 0.15 s file at 4x cannot
    // fill 0.1 s of timeline) — the clip stays legal and the player simply runs out.
    const room = Math.floor(((media - c) / speed) * 1000) / 1000;
    if (d > room) d = clamp(room, MIN_DUR, MAX_TIME_S);
  }
  return { start: s, dur: d, clipIn: c };
}

/**
 * Lay the given seq order out gapless from 0 (`order` = row indices in play order).
 * A clip with no duration takes its media length when the caller knows it, else
 * DEFAULT_CLIP_S — packing NEVER leaves a null dur on the seq row.
 */
function packOrder(boxes: Box[], cfg: TimeCfg, order: number[], mediaDur?: MediaDurFn): Box[] {
  const starts = new Map<number, number>();
  const durs = new Map<number, number>();
  let cursor = 0;
  for (const i of order) {
    const b = boxes[i];
    if (!b) continue;
    const t = boxTiming(b, cfg);
    let d = t.dur;
    if (d === null) {
      const m = mediaDur?.(b, i);
      d = typeof m === 'number' && Number.isFinite(m) && m > 0 ? clamp(m, MIN_DUR, MAX_TIME_S) : DEFAULT_CLIP_S;
    }
    // ONE rounding grid. The cursor advances by the duration we actually STORE, not
    // by the unrounded one: accumulating `d` while storing r3(d) makes start[i] and
    // start[i-1] + dur[i-1] disagree by up to a millisecond per adjacency, which is a
    // visible gap/overlap on a row whose whole contract is "gapless".
    // The ceiling truncates the last clip instead of letting the cursor saturate and
    // stack every remaining clip at MAX_TIME_S with its full duration.
    const room = MAX_TIME_S - cursor;
    const dr = clamp(r3(Math.min(d, room)), MIN_DUR, MAX_TIME_S);
    starts.set(i, cursor);
    durs.set(i, dr);
    cursor = clamp(r3(cursor + dr), 0, MAX_TIME_S);
  }
  return boxes.map((b, i) => {
    if (!b || !starts.has(i)) return b;
    return withFields(b, { [cfg.startField]: starts.get(i)!, [cfg.durField]: durs.get(i)! });
  });
}

/** Make the seq row gapless from 0. Returns a NEW array; untouched rows keep identity. */
export function packSeq(boxes: Box[], cfg: TimeCfg, mediaDur?: MediaDurFn): Box[] {
  const rows = Array.isArray(boxes) ? boxes : [];
  return packOrder(rows, cfg, seqIndices(rows, cfg), mediaDur);
}

/**
 * Shift overlays that were anchored inside a seq clip's OLD span so they stay with
 * that clip. v1 rule: an overlay whose start fell inside [start, end) of a seq clip
 * in `before` moves by that clip's start delta in `after`. HALF-OPEN — an overlay
 * sitting exactly on a clip's old END belongs to the NEXT clip, not this one.
 *
 * Applied inside moveSeqClip / removeAndRipple / trimClip; callers never call it
 * directly (calling it with a `before` that is not the pre-mutation array would
 * double-apply the shift).
 */
export function rippleOverlays(before: Box[], after: Box[], cfg: TimeCfg): Box[] {
  const prev = Array.isArray(before) ? before : [];
  const next = Array.isArray(after) ? after : [];
  // Old spans, in play order, of every seq clip that has a resolvable extent.
  const spans: { id: string; start: number; end: number }[] = [];
  for (const i of seqIndices(prev, cfg)) {
    const b = prev[i]!;
    const t = boxTiming(b, cfg);
    const id = b[cfg.idField];
    if (id == null || id === '' || t.dur === null) continue;
    spans.push({ id: String(id), start: t.start ?? 0, end: (t.start ?? 0) + t.dur });
  }
  if (!spans.length) return next.map((b) => b);
  // Where those clips ended up.
  const moved = new Map<string, number>();
  for (const i of seqIndices(next, cfg)) {
    const b = next[i]!;
    const id = b[cfg.idField];
    if (id == null || id === '') continue;
    moved.set(String(id), boxTiming(b, cfg).start ?? 0);
  }
  return next.map((b) => {
    if (!b) return b;
    const t = boxTiming(b, cfg);
    if (t.lane === 'seq' || t.start === null) return b;   // seq clips and scenery are not overlays
    const span = spans.find((s) => t.start! >= s.start && t.start! < s.end);
    if (!span) return b;
    const now = moved.get(span.id);
    if (now == null) return b;                             // its anchor clip is gone — stay put
    const delta = now - span.start;
    if (!Number.isFinite(delta) || delta === 0) return b;
    return withFields(b, { [cfg.startField]: clamp(r3(t.start + delta), 0, MAX_TIME_S) });
  });
}

/**
 * Reorder a seq clip to `newIndex` within the seq row (a drag on the magnetic row),
 * then repack and ripple the overlays. Array order (z-order) is untouched — order on
 * the seq row is expressed purely through `start`.
 */
export function moveSeqClip(boxes: Box[], cfg: TimeCfg, id: string, newIndex: number, mediaDur?: MediaDurFn): Box[] {
  const rows = Array.isArray(boxes) ? boxes : [];
  const order = seqIndices(rows, cfg);
  const target = indexOfId(rows, cfg, id);
  const from = order.indexOf(target);
  if (target < 0 || from < 0) return rows.map((b) => b);
  const to = clamp(Math.round(num(newIndex, 0)), 0, order.length - 1);
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, target);
  return rippleOverlays(rows, packOrder(rows, cfg, next, mediaDur), cfg);
}

/**
 * Where a seq clip dragged to `tSec` would land in the row order: past a clip's MIDPOINT
 * means past that clip. The dragged clip does not displace itself, so crossing its own
 * midpoint is not a move.
 *
 * Editing arithmetic, so it lives here with moveSeqClip rather than inline in the drag
 * handler that previews it. The preview and the commit read the same index by construction.
 */
export function dropIndexAt(boxes: Box[], cfg: TimeCfg, tSec: number, draggedId: string): number {
  const order = seqBoxes(Array.isArray(boxes) ? boxes : [], cfg);
  if (!order.length) return 0;
  const at = num(tSec, 0);
  // COUNT the other clips the pointer is now past, rather than reading off a row
  // position: moveSeqClip splices the dragged clip out BEFORE inserting it, so the
  // target index is measured against the row without it. Reading `i + 1` off the
  // current row instead overshoots by one for every rightward drag.
  let idx = 0;
  for (const b of order) {
    if (String(b?.[cfg.idField] ?? '') === String(draggedId)) continue;
    const t = boxTiming(b, cfg);
    if (at >= (t.start ?? 0) + (t.dur ?? 0) / 2) idx++;
  }
  return clamp(idx, 0, order.length - 1);
}

/**
 * Move an OVERLAY (non-magnetic) box to an absolute start time — the plain drag on any
 * lane that is not the seq row. No repack and no ripple: an overlay's start is authored
 * directly, and nothing is anchored to it.
 *
 * This exists so the panel's drag does not hand-roll the clamp and the ms rounding: the
 * inspector's Start field and a pointer drag MUST land on the same value for the same
 * time, and they did not while the drag rounded inline and skipped MAX_TIME_S entirely.
 *
 * A seq-lane box is returned unchanged — its start is derived by the pack, so writing
 * one directly would be overwritten on the next repack (use moveSeqClip instead).
 */
export function moveOverlay(boxes: Box[], cfg: TimeCfg, id: string, atSec: number): Box[] {
  const rows = Array.isArray(boxes) ? boxes : [];
  const i = indexOfId(rows, cfg, id);
  if (i < 0) return rows.map((b) => b);
  if (boxTiming(rows[i], cfg).lane === 'seq') return rows.map((b) => b);
  const at = clamp(r3(num(atSec, 0)), 0, MAX_TIME_S);
  return rows.map((b, k) => (k === i ? withFields(b!, { [cfg.startField]: at }) : b));
}

/**
 * Delete a box. Removing a seq clip closes the gap (repack) and ripples the overlays
 * that were anchored to the clips that moved; overlays anchored inside the DELETED
 * clip's span stay where they are (their anchor no longer exists).
 */
export function removeAndRipple(boxes: Box[], cfg: TimeCfg, id: string, mediaDur?: MediaDurFn): Box[] {
  const rows = Array.isArray(boxes) ? boxes : [];
  const i = indexOfId(rows, cfg, id);
  if (i < 0) return rows.map((b) => b);
  const wasSeq = boxTiming(rows[i], cfg).lane === 'seq';
  const culled = rows.filter((_, k) => k !== i);
  if (!wasSeq) return culled;
  return rippleOverlays(rows, packSeq(culled, cfg, mediaDur), cfg);
}

/**
 * Trim one edge of a clip by `deltaSec` (positive = drag right, later in time).
 *
 *   edge 'in'  — start += d; dur -= d; clipIn += d * speed  (the media's out point is
 *                invariant under a trim-in, which is exactly why clipIn moves by
 *                d * speed rather than d).
 *   edge 'out' — dur += d.
 *
 * Clamps: clipIn >= 0, start >= 0, dur >= MIN_DUR, and — when the media length is
 * known — clipIn + dur * speed <= mediaDurSec (you cannot trim past the end of the
 * file). On the seq lane the row is repacked afterwards so it stays gapless, and the
 * overlays anchored to the clips that moved ripple with them.
 */
export function trimClip(
  boxes: Box[],
  cfg: TimeCfg,
  id: string,
  edge: 'in' | 'out',
  deltaSec: number,
  mediaDurSec: number | null,
  mediaDur?: MediaDurFn,
): Box[] {
  const rows = Array.isArray(boxes) ? boxes : [];
  const i = indexOfId(rows, cfg, id);
  if (i < 0) return rows.map((b) => b);
  const box = rows[i]!;
  const t = boxTiming(box, cfg);
  const order = seqIndices(rows, cfg);
  const media = typeof mediaDurSec === 'number' && Number.isFinite(mediaDurSec) && mediaDurSec > 0 ? mediaDurSec : null;
  const speed = t.speed;
  const start0 = t.start ?? 0;
  // An open-ended clip still has to trim against something concrete.
  const dur0 = t.dur ?? (media != null ? clamp(media / speed, MIN_DUR, MAX_TIME_S) : DEFAULT_CLIP_S);
  const clipIn0 = t.clipIn;
  const d = num(deltaSec, 0);

  let start = start0;
  let dur = dur0;
  let clipIn = clipIn0;

  if (edge === 'in') {
    // Delta window: can't push past MIN_DUR on the right, can't pull the source's
    // in-point below 0 or the clip before t=0 on the left.
    // The right-hand stop is the smaller of "leave MIN_DUR on the timeline" and — when
    // the media length is known — "leave MIN_DUR of FILE past the new in-point". Without
    // the second term a clip that already overhangs its media (or a big drag on a short
    // file) walks clipIn past the end of the file, and the safety net below can only
    // shrink `dur`, so the violation is unrecoverable: the player then seeks past
    // duration and the bar plays nothing.
    const hiTimeline = dur0 - MIN_DUR;
    const hiMedia = media != null ? (media - clipIn0) / speed - MIN_DUR : Number.POSITIVE_INFINITY;
    const hi = Math.min(hiTimeline, hiMedia);
    const lo = Math.max(-clipIn0 / speed, -start0);
    const dd = clamp(d, Math.min(lo, hi), Math.max(lo, hi));
    start = start0 + dd;
    dur = dur0 - dd;
    clipIn = clipIn0 + dd * speed;
  } else {
    const hi = media != null ? Math.max(MIN_DUR, (media - clipIn0) / speed) : MAX_TIME_S;
    dur = clamp(dur0 + d, Math.min(MIN_DUR, hi), hi);
  }

  // Final safety net — the shared one, so a trim, a Trim-in edit and a speed change
  // all land on identical numbers for identical inputs.
  ({ start, dur, clipIn } = fitToMedia(start, dur, clipIn, speed, media));

  const patched = rows.map((b, k) => (k === i
    ? withFields(b!, { [cfg.startField]: start, [cfg.durField]: dur, [cfg.clipInField]: clipIn })
    : b));
  if (t.lane !== 'seq') return patched;
  // Repack against the PRE-trim order: a trim-in moves `start` later, which must not
  // be allowed to reshuffle the magnetic row under the user's pointer. Both edges
  // ripple — trimming either edge of a seq clip shifts every later clip, and an
  // overlay anchored to one of those has to travel with it.
  return rippleOverlays(rows, packOrder(patched, cfg, order, mediaDur), cfg);
}

/**
 * Set a clip's in-point (Trim in) or its playback rate, holding the media invariant.
 *
 * These exist because the two inspector fields USED to write raw values straight
 * through `patchBox`, which bypassed every clamp `trimClip` exists to hold: setting
 * Trim in to 3.9 s on a 4 s clip, or the rate to x4 on a 4 s clip cut to 4 s, both
 * put the out-point past the end of the file with `dur` never compensated. Same
 * safety net as a trim, same rounding, same repack — one shared helper decides.
 *
 * An OPEN-ENDED clip (no authored dur) keeps its open end: only the field the user
 * touched is written, so "runs to the end of the sequence" is not silently
 * materialised into a fixed length by editing the trim point.
 */
function fitAndPatch(
  boxes: Box[], cfg: TimeCfg, id: string,
  next: { clipIn?: number; speed?: number; dur?: number },
  mediaDurSec: number | null, mediaDur?: MediaDurFn,
): Box[] {
  const rows = Array.isArray(boxes) ? boxes : [];
  const i = indexOfId(rows, cfg, id);
  if (i < 0) return rows.map((b) => b);
  const box = rows[i]!;
  const t = boxTiming(box, cfg);
  const order = seqIndices(rows, cfg);
  const media = typeof mediaDurSec === 'number' && Number.isFinite(mediaDurSec) && mediaDurSec > 0 ? mediaDurSec : null;
  const speed = next.speed != null ? clamp(f2(num(next.speed, t.speed)), MIN_SPEED, MAX_SPEED) : t.speed;
  const clipIn = next.clipIn != null ? Math.max(0, num(next.clipIn, t.clipIn)) : t.clipIn;
  const dur0 = next.dur != null
    ? clamp(num(next.dur, MIN_DUR), MIN_DUR, MAX_TIME_S)
    : t.dur ?? (media != null ? clamp(media / speed, MIN_DUR, MAX_TIME_S) : DEFAULT_CLIP_S);
  const fit = fitToMedia(t.start ?? 0, dur0, clipIn, speed, media);

  const patch: Record<string, number | string> = {};
  if (next.dur != null) patch[cfg.durField] = fit.dur;
  if (next.clipIn != null) patch[cfg.clipInField] = fit.clipIn;
  else if (fit.clipIn !== t.clipIn) patch[cfg.clipInField] = fit.clipIn;
  if (next.speed != null) patch[cfg.speedField] = speed;
  // Only compensate a length the user actually authored — never invent one.
  if (t.dur != null && fit.dur !== t.dur) patch[cfg.durField] = fit.dur;

  const patched = rows.map((b, k) => (k === i ? withFields(b!, patch) : b));
  if (t.lane !== 'seq') return patched;
  return rippleOverlays(rows, packOrder(patched, cfg, order, mediaDur), cfg);
}

/**
 * Set a clip's on-timeline length ABSOLUTELY, seconds.
 *
 * Absolute rather than a delta on purpose: the inspector's Length field cannot know
 * what basis `trimClip` would pick for an OPEN-ENDED clip (it falls back to the media
 * length, else DEFAULT_CLIP_S), so seeding the field from the visible span and
 * committing `typed - visible` produced a length that was neither. Typing 5 now
 * yields 5 s, clamped against the media exactly like a trim of the out edge.
 */
export function setDuration(
  boxes: Box[], cfg: TimeCfg, id: string, durSec: number,
  mediaDurSec: number | null, mediaDur?: MediaDurFn,
): Box[] {
  return fitAndPatch(boxes, cfg, id, { dur: clamp(num(durSec, MIN_DUR), MIN_DUR, MAX_TIME_S) }, mediaDurSec, mediaDur);
}

/** Set the clip's in-point into its source, seconds. Clamped against the media. */
export function setClipIn(
  boxes: Box[], cfg: TimeCfg, id: string, valueSec: number,
  mediaDurSec: number | null, mediaDur?: MediaDurFn,
): Box[] {
  return fitAndPatch(boxes, cfg, id, { clipIn: clamp(num(valueSec, 0), 0, MAX_TIME_S) }, mediaDurSec, mediaDur);
}

/** Set the clip's playback rate. Clamped to [MIN_SPEED, MAX_SPEED] and to the media. */
export function setSpeed(
  boxes: Box[], cfg: TimeCfg, id: string, speedRaw: number,
  mediaDurSec: number | null, mediaDur?: MediaDurFn,
): Box[] {
  return fitAndPatch(boxes, cfg, id, { speed: speedRaw }, mediaDurSec, mediaDur);
}

/**
 * Split a clip at `tSec` (absolute timeline seconds). Returns null — no split — when
 * t is not strictly inside (start + MIN_DUR, end - MIN_DUR), so a split can never
 * mint a sub-minimum sliver, and null when the clip has no resolvable end.
 *
 * The transitions belong to the OUTER edges of the original clip: A keeps its enter
 * and loses its exit, B keeps its exit and loses its enter. B's source in-point
 * advances by the media time consumed by A — (t - start) * speed. B is inserted
 * immediately after A so z-order is preserved, and its id comes from the injected
 * `mintId` (this module never invents ids).
 */
export function splitBox(boxes: Box[], cfg: TimeCfg, id: string, tSec: number, mintId: () => string): Box[] | null {
  const rows = Array.isArray(boxes) ? boxes : [];
  const i = indexOfId(rows, cfg, id);
  if (i < 0) return null;
  const box = rows[i]!;
  const t = boxTiming(box, cfg);
  if (t.dur === null) return null;               // open-ended: no end to split against
  const start = t.start ?? 0;
  const end = start + t.dur;
  const at = num(tSec, NaN);
  if (!Number.isFinite(at)) return null;
  if (!(at > start + MIN_DUR && at < end - MIN_DUR)) return null;

  // Snap the cut to the millisecond grid ONCE and derive both halves from it, so
  // A.dur + B.dur === the original duration exactly. Rounding the two halves
  // independently leaves them summing to ±1 ms of the original, which on the seq lane
  // (never repacked after a split, by contract) is a real gap or overlap against the
  // next clip. The playhead's time is pointer-px ÷ pxPerSec, so a cut that is not
  // already on the grid is the normal case, not the exotic one.
  const aDur = r3(at - start);
  const bStart = r3(start + aDur);
  const bDur = r3(end - bStart);
  // Rounding can shave a hair off a cut made right against the MIN_DUR guard; refuse
  // rather than mint a sub-minimum sliver.
  if (aDur < MIN_DUR || bDur < MIN_DUR) return null;

  const a = withFields(box, { [cfg.durField]: aDur, [cfg.exitField]: 'none' });
  const b: Box = {
    ...box,
    [cfg.idField]: mintId(),
    [cfg.startField]: bStart,
    [cfg.durField]: bDur,
    [cfg.clipInField]: clamp(r3(t.clipIn + aDur * t.speed), 0, MAX_TIME_S),
    [cfg.enterField]: 'none',
  };
  const out = rows.slice();
  out.splice(i, 1, a, b);
  return out;
}

// ── snapping + formatting ─────────────────────────────────────────────────────

/**
 * Snap a time to the nearest candidate within `snapPx` SCREEN pixels (clip edges, the
 * playhead, whole seconds — the caller assembles the list). The threshold is in
 * screen space so snapping feels identical at every zoom level, the same convention
 * free-canvas uses for its spatial guides.
 */
export function snapTime(tSec: number, candidates: number[], pxPerSec: number, snapPx: number = SNAP_PX): SnapTimeResult {
  const t = num(tSec, 0);
  const pps = num(pxPerSec, 0);
  const px = num(snapPx, SNAP_PX);
  if (!(pps > 0) || !(px > 0) || !Array.isArray(candidates)) return { t, snapped: null };
  const tol = px / pps;
  let best: number | null = null;
  let bestD = Infinity;
  for (const raw of candidates) {
    const c = typeof raw === 'number' ? raw : parseFloat(raw as unknown as string);
    if (!Number.isFinite(c)) continue;
    const dd = Math.abs(c - t);
    if (dd <= tol && dd < bestD) { best = c; bestD = dd; }
  }
  return best === null ? { t, snapped: null } : { t: best, snapped: best };
}

/**
 * Format seconds as a transport readout: `m:ss.d`, growing to `h:mm:ss.d` past an
 * hour. Rounds to tenths BEFORE splitting the fields so 59.99 reads "1:00.0" rather
 * than "0:60.0".
 */
export function fmtTime(sec: number): string {
  const v = num(sec, 0);
  const neg = v < 0;
  const tenths = Math.round(Math.abs(v) * 10);
  const d = tenths % 10;
  const total = (tenths - d) / 10;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n));
  const body = h > 0 ? `${h}:${pad(m)}:${pad(s)}.${d}` : `${m}:${pad(s)}.${d}`;
  return neg && tenths > 0 ? '-' + body : body;
}
