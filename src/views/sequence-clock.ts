// SPDX-License-Identifier: MPL-2.0
/**
 * sequence-clock.ts — the playhead (Fable timeline, phase 2 §3).
 *
 * One mounted composition's *time*: where the playhead is, what that means for
 * every timed box on the live canvas, and — while playing — a conductor that keeps
 * the <video>s, the Lottie players and the wall clock in step.
 *
 * THE ONE RULE THIS MODULE LIVES BY: it is a READER. Timing comes exclusively from
 * the DOM the tool hook already stamped (`data-t-start` & friends on each
 * `.lolly-box`, `data-seq-ms` on the `[data-sequence]` artboard). It never reads the
 * input model, never calls `runtime.setInput`, never runs a hook and never writes
 * innerHTML. Everything it *does* write — one class and two inline properties per
 * box — is captured first and restored exactly on `destroy()`, so removing the clock
 * leaves every declaration as it found it. That is what lets a scrub run at
 * 60 Hz with zero re-renders and zero undo-stack entries.
 *
 * Composition, not clobbering: a box carries AUTHORED inline styles from the hook —
 * `transform:rotate(-4deg)`, `opacity:0.8`. An entrance animation must add to those,
 * never replace them, so the authored string is captured once per element and the
 * animation is rebuilt around it every frame (declaration-identical, not byte-identical:
 * writing through CSSStyleDeclaration re-serialises the whole `style` attribute, so
 * nothing downstream may diff innerHTML and expect a match):
 *
 *     translate(dx,dy)  <authored…>  rotate(animRot)  scale(sc)
 *
 * which multiplies out to the same matrix order the video compositor uses in
 * bridge/export.ts (`translate → rotate(authored+anim) → scale`), so a scrubbed
 * preview and the rendered file agree. The transition maths itself is IMPORTED from
 * lib/transitions.ts — never re-derived here.
 *
 * Master clock is `AudioContext.currentTime`, not `performance.now()`: audio is the
 * one media element that cannot be nudged without an audible artefact, so everything
 * else is slaved to its timebase. Videos free-run and are re-seeked only when they
 * drift past ~80 ms.
 *
 * Seeks are strictly serialised per element (the Safari rule — a seek issued while
 * another is in flight is silently cancelled, so scrubbing returns a lottery of
 * frames). The queue is the shared, already-tested one from lib/clip-thumbs.ts; this
 * module adds only what playback needs on top: latest-wins scrub throttling and a
 * single confirm-and-nudge retry when a decoder lands short of the requested time.
 *
 * BROWSER-ONLY SURFACES (deliberately isolated behind injectable seams so the rest is
 * unit-testable in jsdom): `AudioContext`, `requestVideoFrameCallback`,
 * `requestAnimationFrame`, and real layout for box sizes.
 */

import { recTransition, isTransitionKind, type TransitionKind } from '../lib/transitions.ts';
import { createSeekQueue, type SeekableEl } from '../lib/clip-thumbs.ts';
import { lottiePlayerFor } from './lottie-mount.ts';
// The rate range is timeline-math's (a pure, DOM-free module): the tool hook, the
// panel's writers and this reader must clamp identically, so there is exactly one
// declaration of it. Re-exported below so this module's own surface is unchanged.
import { MIN_SPEED, MAX_SPEED } from './timeline-math.ts';

// ── tunables ────────────────────────────────────────────────────────────────

/** Per-seek confirmation budget while scrubbing/drift-correcting. */
export const SEEK_CONFIRM_MS = 300;
/** A landed frame further than this from the request earns one nudge. 1.5 frames @30. */
export const SEEK_TOLERANCE_S = 1.5 / 30;
/** How far past the target the single nudge asks for. A quarter of a frame @30. */
export const SEEK_NUDGE_S = 0.25 / 30;
/** While the pointer is down, at most one seek request per element per this long. */
export const SCRUB_THROTTLE_MS = 100;
/** Playback drift past this (seconds) triggers a corrective re-seek. */
export const DRIFT_TOLERANCE_S = 0.08;
/** How far short of a source's own end the last held frame sits. */
export const MEDIA_END_EPS_S = 0.04;
/** Clamps mirroring the tool hook's own attribute clamps. */
export { MIN_SPEED, MAX_SPEED };
// MIN_/MAX_TRANSITION_MS are re-exported below, from the module that now owns the
// applier — one declaration, same names on this module's surface as before.

// ── the public contract ─────────────────────────────────────────────────────

/** The playhead, as the timeline panel consumes it. */
export interface SequenceClock {
  /** Current playhead position, ms. Updates synchronously on `seek`. */
  t(): number;
  /** Sequence length in ms, read from the live DOM's `data-seq-ms`. 0 when untimed. */
  duration(): number;
  /** Move the playhead. rAF-coalesced; `scrubbing` throttles the video seeks. */
  seek(tMs: number, opts?: { scrubbing?: boolean }): void;
  play(): void;
  pause(): void;
  playing(): boolean;
  /** Re-assert the current time after the canvas innerHTML was rebuilt. */
  reapply(): void;
  /** Subscribe to applied frames (play or scrub). Returns an unsubscribe. */
  onTick(cb: (tMs: number) => void): () => void;
  /** Stop everything and restore every inline style/mute flag this clock touched. */
  destroy(): void;
}

/** The (optional) host slice this module uses — logging only. */
export interface ClockHost {
  log?(level: string, msg: string): void;
}

export interface SequenceClockOpts {
  canvasEl: HTMLElement;
  host?: ClockHost;
  /** Test seam: schedule a frame. Defaults to rAF (setTimeout where absent). */
  raf?: (cb: () => void) => number;
  /** Test seam: cancel a scheduled frame. */
  caf?: (handle: number) => void;
  /** Test seam: monotonic ms — scrub throttling and the fallback playback timebase. */
  now?: () => number;
}

// ── the DOM applier: IMPORTED, never re-derived ─────────────────────────────
//
// The half-open activity window, the transition resolution and the composition with
// each box's authored transform/opacity used to live here. They now live in
// bridge/sequence-dom.ts, because a second caller needs exactly them: export.ts's
// "Record live" has to advance this same playhead over the real DOM while a
// MediaRecorder films it (nothing else moves a sequence stage), and the planned
// contact-sheet export walks the same applier across t. Two copies of this
// arithmetic drifting apart is the specific bug class this codebase keeps getting
// bitten by, so there is one copy and the clock is one of its two users.
//
// views -> bridge is the ordinary direction (bridge -> views is the forbidden edge).
// Everything is re-exported, so this module's public surface is unchanged.
export {
  readTiming, endOf, isActiveAt, transitionAt, composeTransform, composeOpacity,
  createAuthoredStore, applyTimeToElements, OFF_CLASS,
  MIN_TRANSITION_MS, MAX_TRANSITION_MS,
} from '../bridge/sequence-dom.ts';
export type { Timing, TransitionAt, AuthoredStore, ApplyCtx } from '../bridge/sequence-dom.ts';

import {
  readTiming, isActiveAt, createAuthoredStore, applyTimeToElements, OFF_CLASS,
  type Timing,
} from '../bridge/sequence-dom.ts';

// ── per-video seek queue ────────────────────────────────────────────────────

/** A queued, throttled, never-overlapping seeker for one media element. */
export interface VideoSeeker {
  /** Ask for a position (seconds). Latest-wins; throttled while `scrubbing`. */
  request(tSec: number, opts?: { scrubbing?: boolean }): void;
  /** True while a seek is awaiting confirmation. Never true for two at once. */
  inFlight(): boolean;
  /** How many nudge retries this seeker has issued (diagnostics + tests). */
  nudges(): number;
  destroy(): void;
}

/** The element slice a seeker needs. Duck-typed so a test can pass a plain object. */
export interface SeekableMedia extends SeekableEl {
  currentTime: number;
}

export interface SeekerDeps {
  /** Confirm the seek landed; resolves the presented time (or null). */
  waitFrame(el: SeekableMedia, signal?: AbortSignal): Promise<number | null>;
  now?(): number;
  /** Schedule the trailing scrub flush. Returns a canceller. */
  schedule?(fn: () => void, ms: number): () => void;
}

/**
 * Serialised seeking for one element — the Safari rule made mechanical.
 *
 * Two seeks in flight on one element is not "slower", it is WRONG: WebKit cancels
 * the earlier one and the frame you get back is whichever the decoder felt like. So
 * the underlying queue (shared with lib/clip-thumbs.ts, already tested there) never
 * runs two, and this wrapper adds the two things playback needs:
 *
 *   • scrub throttling — at most one request per SCRUB_THROTTLE_MS while the pointer
 *     is down, ALWAYS with a trailing flush so the final position of a drag lands
 *     even if it arrived inside the throttle window;
 *   • one nudge — decoders routinely land on the nearest keyframe rather than the
 *     requested time. If the confirmed frame is more than SEEK_TOLERANCE_S away we
 *     ask once more, a quarter-frame past the target. ONCE: a decoder that cannot
 *     hit the time will not hit it on the third try either, and a retry loop on a
 *     long-GOP file is a hang.
 */
export function createVideoSeeker(el: SeekableMedia, deps: SeekerDeps): VideoSeeker {
  const queue = createSeekQueue(el, (target, signal) => deps.waitFrame(target as SeekableMedia, signal));
  const now = deps.now || (() => Date.now());
  const schedule = deps.schedule || ((fn, ms) => {
    const h = setTimeout(fn, ms) as unknown as number;
    return () => clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
  });

  let want: number | null = null;
  let cancelTrailing: (() => void) | null = null;
  let lastIssued = Number.NEGATIVE_INFINITY;
  let nudgeCount = 0;
  let dead = false;
  let generation = 0;

  function issue(t: number): void {
    if (dead) return;
    lastIssued = now();
    const mine = ++generation;
    void queue.seek(t, { supersede: true }).then((landed) => {
      if (dead || landed == null) return;
      // A newer target has been issued since: nudging toward THIS one would fight it.
      // The generation check is the load-bearing one — `pending()` is NOT enough,
      // because the queue's pump shifts the next job off SYNCHRONOUSLY before this
      // `.then` microtask runs, so by now the newer seek is in flight (pending 0)
      // and a nudge toward the stale target would be queued behind it and land LAST.
      if (mine !== generation) return;
      // Belt and braces for anything queued or in flight from another caller.
      if (want !== null || queue.pending() > 0 || queue.inFlight()) return;
      if (Math.abs(landed - t) <= SEEK_TOLERANCE_S) return;
      nudgeCount++;
      // Deliberately NOT supersede: this is a follow-up to a seek that already
      // completed, and it must not evict a scrub request that lands beside it.
      void queue.seek(t + SEEK_NUDGE_S);
    });
  }

  return {
    request(tSec, opts) {
      if (dead || !Number.isFinite(tSec)) return;
      const t = Math.max(0, tSec);
      if (!opts?.scrubbing) {
        // Not a scrub (pointer-up, playback drift correction, a keyboard step): this
        // is authoritative, so drop any trailing flush and go now.
        want = null;
        cancelTrailing?.();
        cancelTrailing = null;
        issue(t);
        return;
      }
      const since = now() - lastIssued;
      if (since >= SCRUB_THROTTLE_MS && !cancelTrailing) { want = null; issue(t); return; }
      want = t;
      if (!cancelTrailing) {
        const wait = Math.max(0, SCRUB_THROTTLE_MS - since);
        cancelTrailing = schedule(() => {
          cancelTrailing = null;
          const w = want;
          want = null;
          if (w != null) issue(w);
        }, wait);
      }
    },
    inFlight: () => queue.inFlight(),
    nudges: () => nudgeCount,
    destroy() {
      dead = true;
      cancelTrailing?.();
      cancelTrailing = null;
      want = null;
      queue.clear();
    },
  };
}

/**
 * Real confirmation that a seek presented a frame: rVFC where it exists (its
 * `mediaTime` is the frame actually on screen, unlike `currentTime` which is merely
 * what we asked for), the `seeked` event racing alongside for engines that skip rVFC
 * on a paused element, and a hard timeout so a stalled decoder cannot wedge the queue.
 *
 * Browser-only by nature; the seeker takes it as a dependency so tests inject a fake.
 */
// An intersection, not an `extends`: newer lib.dom declares both members as REQUIRED on
// HTMLVideoElement, and re-declaring them optional in a subinterface is a TS2430 conflict.
// Intersecting keeps the widening additive for older lib versions and conflict-free for new ones.
type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?(cb: (now: number, meta: { mediaTime?: number }) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
};

export function waitSeekConfirmed(el: SeekableMedia, signal?: AbortSignal, timeoutMs = SEEK_CONFIRM_MS): Promise<number | null> {
  const v = el as unknown as RvfcVideo;
  if (typeof v.addEventListener !== 'function') return Promise.resolve(el.currentTime);
  return new Promise((resolve) => {
    let done = false;
    let handle = 0;
    const cleanup = (): void => {
      clearTimeout(timer);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onFail);
      signal?.removeEventListener('abort', onFail);
      if (handle) { try { v.cancelVideoFrameCallback?.(handle); } catch { /* already gone */ } }
    };
    const finish = (value: number | null): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };
    const onSeeked = (): void => finish(v.currentTime);
    const onFail = (): void => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof v.requestVideoFrameCallback === 'function') {
      try {
        handle = v.requestVideoFrameCallback((_now, meta) => {
          finish(typeof meta?.mediaTime === 'number' ? meta.mediaTime : v.currentTime);
        });
      } catch { handle = 0; }
    }
    v.addEventListener('seeked', onSeeked, { once: true });
    v.addEventListener('error', onFail, { once: true });
    if (signal?.aborted) { finish(null); return; }
    signal?.addEventListener('abort', onFail, { once: true });
  });
}

// ── the clock ───────────────────────────────────────────────────────────────

interface VideoRec {
  seeker: VideoSeeker;
  /** The element's own `muted` before we touched it, restored on pause/destroy. */
  mutedWas: boolean | null;
  playing: boolean;
}

type AudioCtxCtor = new () => AudioContext;

export function createSequenceClock(opts: SequenceClockOpts): SequenceClock {
  const { canvasEl, host } = opts;
  const g = globalThis as typeof globalThis & { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor };
  const raf = opts.raf
    || (typeof requestAnimationFrame === 'function'
      ? (cb: () => void): number => requestAnimationFrame(() => cb())
      : (cb: () => void): number => setTimeout(cb, 16) as unknown as number);
  const caf = opts.caf
    || (typeof cancelAnimationFrame === 'function'
      ? (h: number): void => cancelAnimationFrame(h)
      : (h: number): void => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  const nowMs = opts.now
    || (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? (): number => performance.now()
      : (): number => Date.now());

  const store = createAuthoredStore();
  const videos = new Map<HTMLVideoElement, VideoRec>();
  const ticks = new Set<(tMs: number) => void>();

  let tMs = 0;
  let scrubbing = false;
  let frame = 0;            // pending apply frame
  let loop = 0;             // pending playback frame
  let isPlaying = false;
  let ctx: AudioContext | null = null;
  let t0 = 0;               // ctx.currentTime at playhead 0 (audio timebase)
  let wall0 = 0;            // nowMs() at playhead 0 (fallback timebase)
  let dead = false;

  const log = (level: string, msg: string): void => { try { host?.log?.(level, msg); } catch { /* logging is never fatal */ } };

  // ── DOM reads ─────────────────────────────────────────────────────────────

  function boxes(): HTMLElement[] {
    return [...canvasEl.querySelectorAll<HTMLElement>('[data-t-start]')];
  }

  function seqMs(): number {
    const el = canvasEl.matches?.('[data-seq-ms]')
      ? canvasEl
      : canvasEl.querySelector<HTMLElement>('[data-seq-ms]');
    if (!el) return 0;
    const v = parseFloat(el.getAttribute('data-seq-ms') || '');
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  // ── media plumbing ────────────────────────────────────────────────────────

  function seekerFor(video: HTMLVideoElement): VideoRec {
    let rec = videos.get(video);
    if (!rec) {
      rec = {
        seeker: createVideoSeeker(video, { waitFrame: (el, signal) => waitSeekConfirmed(el, signal) }),
        mutedWas: null,
        playing: false,
      };
      videos.set(video, rec);
    }
    return rec;
  }

  /** Put a video back exactly as found: paused where we started it, muted as authored. */
  function releaseVideo(video: HTMLVideoElement, rec: VideoRec): void {
    if (rec.playing) { try { video.pause(); } catch { /* detached */ } rec.playing = false; }
    if (rec.mutedWas != null) { try { video.muted = rec.mutedWas; } catch { /* detached */ } rec.mutedWas = null; }
  }

  function driveMedia(el: HTMLElement, timing: Timing, sourceMs: number, active: boolean): void {
    const video = el.querySelector('video');
    if (video) {
      const rec = seekerFor(video);
      // Clamp against the SOURCE's own length. A clip can legitimately be trimmed
      // longer than its media (dur is clamped to MAX_TIME_S, never to the file), and
      // without this the element pins at its end while the target keeps climbing —
      // drift stays above tolerance and a corrective seek is issued EVERY frame for
      // the rest of the clip. Past the end we hold the last frame instead.
      const rawSec = sourceMs / 1000;
      const mediaEnd = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const pastEnd = mediaEnd > 0 && rawSec >= mediaEnd;
      const targetSec = pastEnd ? Math.max(0, mediaEnd - MEDIA_END_EPS_S) : rawSec;
      if (!active) {
        releaseVideo(video, rec);
      } else if (isPlaying) {
        // Free-run: the element's own clock is the smoothest thing available, so we
        // only intervene on drift. Rate follows the clip's speed so a 2× clip plays
        // 2× rather than being re-seeked 60 times a second.
        if (rec.mutedWas == null) { rec.mutedWas = video.muted; }
        const wantMuted = !!timing.mute;
        if (video.muted !== wantMuted) video.muted = wantMuted;   // no per-frame write
        try { video.playbackRate = timing.speed; } catch { /* rate out of engine range */ }
        const drift = Math.abs((video.currentTime || 0) - targetSec);
        if (!pastEnd && drift > DRIFT_TOLERANCE_S) rec.seeker.request(targetSec);
        if (!rec.playing) {
          rec.playing = true;
          try { void video.play()?.catch(() => { /* autoplay policy — silent */ }); } catch { /* detached */ }
        }
      } else {
        if (rec.playing) { try { video.pause(); } catch { /* detached */ } rec.playing = false; }
        // Past the source end the target no longer moves, so only ask once.
        if (!pastEnd || Math.abs((video.currentTime || 0) - targetSec) > DRIFT_TOLERANCE_S) {
          rec.seeker.request(targetSec, { scrubbing });
        }
      }
      return;
    }
    // Lottie: the player is mounted asynchronously by lottie-mount, so it is simply
    // absent for the first frames after a repaint — that is a no-op, not an error.
    // goToAndStop(value, isFrame=false) takes MILLISECONDS of the animation's own
    // timeline, which is exactly what `sourceMs` is (clipIn + local × speed).
    const marker = el.matches?.('[data-lottie-src]') ? el : el.querySelector('[data-lottie-src]');
    if (marker) {
      const player = lottiePlayerFor(marker);
      if (player && active) { try { player.goToAndStop(sourceMs, false); } catch { /* player mid-teardown */ } }
    }
    // Audio boxes (.lolly-box-audio) have no visual and no element to drive — the
    // mix is phase 3. Nothing to do here on purpose.
  }

  // ── the apply pass ────────────────────────────────────────────────────────

  function applyNow(): void {
    if (dead) return;
    const els = boxes();
    store.prune(new Set(els));
    // Never let one bad element kill the frame: an exception escaping the rAF
    // callback would strand playback with `isPlaying === true`, videos still
    // playing and mute flags unrestored. Log and carry on — the release pass and
    // the subscriber fan-out below MUST still run.
    try {
      applyTimeToElements(els, tMs, { seqMs: seqMs(), store, media: driveMedia });
    } catch (err) {
      log('warn', `sequence-clock: frame failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    // Videos a repaint orphaned: PAUSE and un-mute them before dropping the record.
    // `releaseVideo` is the only path that restores `muted` and stops playback, so
    // skipping it leaves a detached element playing its audio until GC — one more
    // overlapping soundtrack per repaint during playback.
    for (const [video, rec] of [...videos]) {
      if (!canvasEl.contains(video)) { releaseVideo(video, rec); rec.seeker.destroy(); videos.delete(video); }
    }
    for (const cb of [...ticks]) { try { cb(tMs); } catch { /* a bad subscriber never stops the clock */ } }
  }

  function schedule(): void {
    if (dead || frame) return;
    frame = raf(() => { frame = 0; applyNow(); });
  }

  // ── playback ──────────────────────────────────────────────────────────────

  function audioCtx(): AudioContext | null {
    if (ctx) return ctx;
    const Ctor = g.AudioContext || g.webkitAudioContext;
    if (!Ctor) return null;
    try { ctx = new Ctor(); } catch { ctx = null; }
    return ctx;
  }

  /**
   * Elapsed playback time, ms. The AudioContext is the master timebase — but ONLY
   * while it is actually running. A context refused by the autoplay policy (or one
   * whose `resume()` never settles) has a frozen `currentTime`, which would freeze
   * the playhead forever with `playing()` still true and the rAF loop still burning
   * a full apply pass per frame. And the old no-context fallback added a fixed 16 ms
   * per frame, so the sequence played at 2× on a 120 Hz display and in slow motion
   * under load. Both cases now fall back to real elapsed wall time, and the two
   * baselines are kept in step so a context that starts running mid-play takes over
   * without a jump.
   */
  function elapsedMs(): number {
    const c = ctx;
    if (c && c.state === 'running') {
      const v = (c.currentTime - t0) * 1000;
      wall0 = nowMs() - v;
      return v;
    }
    const v = nowMs() - wall0;
    if (c) t0 = c.currentTime - v / 1000;
    return v;
  }

  function tick(): void {
    if (dead || !isPlaying) return;
    const dur = duration();
    let next = tMs;
    try { next = elapsedMs(); } catch { /* a dying context must not strand playback */ }
    if (dur > 0 && next >= dur) {
      tMs = dur;
      applyNow();
      pause();          // hold at the end, the editor convention
      return;
    }
    tMs = Math.max(0, next);
    try {
      applyNow();
    } finally {
      // Rescheduling in `finally`: playback must survive a frame that threw.
      if (isPlaying && !dead) loop = raf(tick);
    }
  }

  function pause(): void {
    if (!isPlaying) return;
    isPlaying = false;
    if (loop) { caf(loop); loop = 0; }
    for (const [video, rec] of videos) releaseVideo(video, rec);
    try { void ctx?.suspend?.(); } catch { /* context already closed */ }
    applyNow();          // settle every box at the held position
  }

  function duration(): number { return seqMs(); }

  function onVisibility(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') pause();
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  const clock: SequenceClock = {
    t: () => tMs,
    duration,
    seek(next, o) {
      if (dead) return;
      const dur = duration();
      const v = Number.isFinite(next) ? Math.max(0, next) : 0;
      tMs = dur > 0 ? Math.min(v, dur) : v;
      scrubbing = !!o?.scrubbing;
      if (isPlaying) {                                   // keep playback in step
        if (ctx) t0 = ctx.currentTime - tMs / 1000;
        wall0 = nowMs() - tMs;
      }
      schedule();
    },
    play() {
      if (dead || isPlaying) return;
      const dur = duration();
      // Nothing timed = nothing to play. Without this the playhead would climb
      // forever (tick's end-of-sequence ceiling needs dur > 0) while the canvas
      // never changed.
      if (dur <= 0) return;
      if (tMs >= dur) tMs = 0;                 // at the end: Space replays from the top
      const c = audioCtx();
      if (c) { try { void c.resume?.(); } catch { /* resume is best-effort */ } }
      t0 = c ? c.currentTime - tMs / 1000 : 0;
      wall0 = nowMs() - tMs;
      if (!c) log('warn', 'sequence-clock: no AudioContext — playback falls back to frame stepping');
      isPlaying = true;
      scrubbing = false;
      applyNow();
      loop = raf(tick);
    },
    pause,
    playing: () => isPlaying,
    reapply() {
      if (dead) return;
      // The canvas was rebuilt: every element the store remembers is detached, so
      // there is nothing to restore — just forget them and paint the new nodes.
      store.prune(new Set(boxes()));
      applyNow();
    },
    onTick(cb) {
      ticks.add(cb);
      return () => { ticks.delete(cb); };
    },
    destroy() {
      if (dead) return;
      dead = true;
      isPlaying = false;
      if (frame) { caf(frame); frame = 0; }
      if (loop) { caf(loop); loop = 0; }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      for (const [video, rec] of videos) { releaseVideo(video, rec); rec.seeker.destroy(); }
      videos.clear();
      // Every class and inline property this clock ever wrote, undone.
      for (const el of boxes()) el.classList.remove(OFF_CLASS);
      store.restoreAll();
      ticks.clear();
      try { void ctx?.close?.(); } catch { /* already closed */ }
      ctx = null;
    },
  };

  return clock;
}
