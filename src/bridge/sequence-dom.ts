// SPDX-License-Identifier: MPL-2.0
/**
 * sequence-dom.ts — putting a timed composition's LIVE DOM at a given time.
 *
 * The single implementation of the phase-1 attribute contract as applied to real
 * elements: which `.lolly-box` is on screen at `t`, and what transform/opacity an
 * enter/exit transition composes on top of that box's AUTHORED inline styles. Two
 * very different callers need exactly this and must never disagree:
 *
 *   • views/sequence-clock.ts — the preview playhead (scrub + play), which imports
 *     everything below rather than owning it. This module was carved OUT of the
 *     clock; the clock re-exports the whole surface, so its public API is unchanged.
 *   • bridge/export.ts renderLive — "Record live" films the real DOM in real time,
 *     and nothing else advances a sequence stage while it does, so the capture has
 *     to drive the playhead itself (`driveSequenceTime`). Without it a live take is
 *     one held frame.
 *
 * The same applier also backs the planned contact-sheet export (`cuts=N`), which
 * walks t across the sequence snapshotting the DOM — hence the general session API
 * rather than anything capture-shaped.
 *
 * NOT the same thing as sequence-plan.ts. That module resolves a layer's state for
 * the CANVAS compositor (a draw plan of numbers, no DOM writes); this one mutates
 * live elements. The two are pinned to each other by tests/sequence-plan.test.ts,
 * which asserts the numeric parity rather than trusting a comment.
 *
 * EVERY WRITE IS REVERSIBLE. One class and two inline properties per box, with the
 * authored values captured before the first write and handed back verbatim on
 * restore (declaration-identical, not byte-identical: writing through
 * CSSStyleDeclaration re-serialises the whole `style` attribute).
 *
 * Composition, not clobbering: a box carries authored inline styles from the tool
 * hook — `transform:rotate(-4deg)`, `opacity:0.8`. An entrance animation adds to
 * those, never replaces them:
 *
 *     translate(dx,dy)  <authored...>  rotate(animRot)  scale(sc)
 *
 * which multiplies out to the same matrix order the video compositor uses
 * (`translate -> rotate(authored+anim) -> scale`), so a scrubbed preview, a live
 * take and a composited render agree. The transition maths itself is IMPORTED from
 * lib/transitions.ts — never re-derived here.
 */

import { recTransition, isTransitionKind, type TransitionKind } from '../lib/transitions.ts';
// The clamps are the bridge-side declarations in sequence-plan.ts (themselves
// mirroring the tool hook + timeline-math). Importing them rather than restating
// them is the point of this module existing.
import { MIN_SPEED, MAX_SPEED, MIN_TRANSITION_MS, MAX_TRANSITION_MS } from './sequence-plan.ts';

export { MIN_SPEED, MAX_SPEED, MIN_TRANSITION_MS, MAX_TRANSITION_MS };

// ── attribute readers (pure) ────────────────────────────────────────────────

/** One box's timing as the hook stamped it. Milliseconds, except `speed`. */
export interface Timing {
  /** ms */
  start: number;
  /** ms, or null for an open-ended box (no `data-t-dur`). */
  dur: number | null;
  /** ms into the source media at the clip's in-point. */
  clipIn: number;
  /** Playback rate multiplier, 0.25–4. */
  speed: number;
  enter: TransitionKind | null;
  enterMs: number;
  exit: TransitionKind | null;
  exitMs: number;
  /**
   * The authored geometry curve for each preset, as written — a preset name or a CSS
   * cubic-bezier. '' when unauthored, and lib/transitions.ts answers an unparseable
   * one with the preset's own built-in curve, so this is deliberately NOT validated
   * here: there is one validator, and it is the module that consumes it.
   */
  enterEase: string;
  exitEase: string;
  /** True when the box declared `data-t-mute="1"` (its audio stays silent). */
  mute: boolean;
  lane: 'seq' | '';
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function attrNum(el: Element, name: string, fallback: number): number {
  const raw = el.getAttribute(name);
  if (raw == null || raw === '') return fallback;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Read a box's timing off its attributes. Tolerant of everything — a hand-authored
 * URL can put any string in any of these, and the answer must still be a legal
 * Timing rather than a NaN that poisons the playhead.
 */
export function readTiming(el: Element): Timing {
  const durRaw = el.getAttribute('data-t-dur');
  const durNum = durRaw == null || durRaw === '' ? NaN : parseFloat(durRaw);
  const enter = el.getAttribute('data-t-enter');
  const exit = el.getAttribute('data-t-exit');
  return {
    start: Math.max(0, attrNum(el, 'data-t-start', 0)),
    dur: Number.isFinite(durNum) ? Math.max(0, durNum) : null,
    clipIn: Math.max(0, attrNum(el, 'data-clip-in', 0)),
    speed: clamp(attrNum(el, 'data-t-speed', 1), MIN_SPEED, MAX_SPEED),
    enter: isTransitionKind(enter) ? enter : null,
    enterMs: clamp(attrNum(el, 'data-t-enter-ms', 400), MIN_TRANSITION_MS, MAX_TRANSITION_MS),
    exit: isTransitionKind(exit) ? exit : null,
    exitMs: clamp(attrNum(el, 'data-t-exit-ms', 400), MIN_TRANSITION_MS, MAX_TRANSITION_MS),
    enterEase: el.getAttribute('data-t-enter-ease') || '',
    exitEase: el.getAttribute('data-t-exit-ease') || '',
    mute: el.getAttribute('data-t-mute') === '1',
    lane: el.getAttribute('data-t-lane') === 'seq' ? 'seq' : '',
  };
}

/**
 * A box's end in ms. An open-ended box (no authored duration) runs to the end of the
 * sequence — the same reading the tool hook takes when it derives `data-seq-ms`.
 */
export function endOf(timing: Timing, seqMs: number): number {
  if (timing.dur != null) return timing.start + timing.dur;
  return Math.max(timing.start, Number.isFinite(seqMs) && seqMs > 0 ? seqMs : timing.start);
}

/**
 * Is the box on screen at `tMs`? HALF-OPEN `[start, start + dur)` — the frame at
 * exactly `start + dur` belongs to whatever comes next, which is what makes a
 * gapless seq row cut cleanly instead of flashing both clips for one frame.
 */
export function isActiveAt(timing: Timing, tMs: number, seqMs: number): boolean {
  const end = endOf(timing, seqMs);
  // A zero-length box is never on screen (its half-open span is empty), except the
  // degenerate open-ended-at-the-very-end case, which `end > start` already excludes.
  return tMs >= timing.start && tMs < end;
}

/** Which transition is mid-flight at `tMs`, and how far through it is (1 = at rest). */
export interface TransitionAt {
  kind: TransitionKind;
  /** Progress 0→1, in recTransition's convention (0 = fully out, 1 = at rest). */
  p: number;
  /**
   * The authored geometry curve of the phase that WON, so a caller never has to
   * re-derive which of the two eases applies from the kind it was handed (enter and
   * exit can name the same kind, and at a crossfade the kind is not either field's).
   * '' — the unauthored case — is exactly what recTransition ignores.
   */
  ease: string;
}

/**
 * The animation state of an ACTIVE box at `tMs`, or null when it is simply at rest.
 *
 * Enter runs forward from the clip's head; exit runs backward into its tail. When a
 * clip is shorter than its two transitions the windows overlap, and the one that is
 * further from rest wins — the same "whichever is smaller" reading the compositor
 * takes with `min(headP, 1 - exitP)` in bridge/export.ts, resolved to a single kind
 * because a DOM box can only carry one transform.
 */
export function transitionAt(timing: Timing, tMs: number, seqMs: number): TransitionAt | null {
  const local = tMs - timing.start;
  const end = endOf(timing, seqMs);
  let enterP = 1;
  if (timing.enter && timing.enter !== 'none' && local < timing.enterMs) {
    enterP = clamp(local / timing.enterMs, 0, 1);
  }
  let exitP = 1;
  // An open-ended box has no tail to exit into (its end is the sequence's, which
  // moves as the composition is edited), so exits only apply to a bounded box.
  if (timing.exit && timing.exit !== 'none' && timing.dur != null) {
    const remain = end - tMs;
    if (remain < timing.exitMs) exitP = clamp(remain / timing.exitMs, 0, 1);
  }
  if (enterP >= 1 && exitP >= 1) return null;
  return enterP <= exitP
    ? { kind: timing.enter as TransitionKind, p: enterP, ease: timing.enterEase }
    : { kind: timing.exit as TransitionKind, p: exitP, ease: timing.exitEase };
}

// ── style composition (pure) ────────────────────────────────────────────────

const n3 = (v: number): string => String(Math.round(v * 1000) / 1000);

/**
 * Build the inline transform for an animating box: the animation's translation
 * OUTSIDE the authored transform, its extra rotation and scale INSIDE it.
 *
 * List order is outermost-first in CSS, so this multiplies out to
 * `translate → rotate(authored + anim) → scale`, matching the compositor's canvas
 * order exactly (bridge/export.ts drawObject). Putting the animation's rotate after
 * the authored one is what keeps a box the user rotated by hand spinning about its
 * own centre rather than swinging around the authored angle.
 */
export function composeTransform(authored: string, tr: { dx: number; dy: number; sc: number; rot: number }): string {
  const parts: string[] = [];
  if (tr.dx || tr.dy) parts.push(`translate(${n3(tr.dx)}px, ${n3(tr.dy)}px)`);
  const auth = (authored || '').trim();
  if (auth && auth !== 'none') parts.push(auth);
  if (tr.rot) parts.push(`rotate(${n3(tr.rot)}deg)`);
  if (tr.sc !== 1) parts.push(`scale(${n3(tr.sc)})`);
  return parts.join(' ');
}

/** Multiply an authored opacity string by the animation's alpha. */
export function composeOpacity(authored: string, alpha: number): string {
  const base = authored === '' || authored == null ? 1 : parseFloat(authored);
  const b = Number.isFinite(base) ? base : 1;
  return String(Math.round(clamp(b * alpha, 0, 1) * 10000) / 10000);
}

// ── the authored-style store ────────────────────────────────────────────────

interface Authored {
  transform: string;
  opacity: string;
  /** Layout size, measured BEFORE any transform was written (rects lie afterwards). */
  w: number;
  h: number;
  /** Last strings we wrote, so a steady frame costs zero style writes. */
  lastTransform: string | null;
  lastOpacity: string | null;
  /** Audio boxes render nothing visible — never worth a transform. */
  audio: boolean;
}

/**
 * Remembers each touched element's original inline transform/opacity so every write
 * is reversible. Keyed by element, so an innerHTML rebuild (which mints brand-new
 * nodes) can never hand a stale authored value to a fresh box — `prune` simply drops
 * the entries whose elements are gone.
 */
export interface AuthoredStore {
  get(el: HTMLElement): Authored;
  /** Put one element back exactly as it was found. */
  restore(el: HTMLElement): void;
  /** Put everything back and forget it. */
  restoreAll(): void;
  /** Forget entries for elements not in `keep` (they were destroyed by a repaint). */
  prune(keep: Set<HTMLElement>): void;
  size(): number;
}

function measure(el: HTMLElement): { w: number; h: number } {
  // offsetWidth/Height is the UNTRANSFORMED layout box; getBoundingClientRect is not
  // (it returns the transformed bbox, which would feed our own animation back into
  // itself frame after frame). jsdom reports 0 for both, hence the style fallback.
  const w = el.offsetWidth || parseFloat(el.style.width) || 0;
  const h = el.offsetHeight || parseFloat(el.style.height) || 0;
  return { w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0 };
}

export function createAuthoredStore(): AuthoredStore {
  const map = new Map<HTMLElement, Authored>();
  const put = (el: HTMLElement, rec: Authored): void => {
    // Restoring an EMPTY authored value must remove the property, not set it to '',
    // or the box keeps a `transform:;` declaration it never had. Both writes are
    // skipped when the value already matches: touching a CSSStyleDeclaration
    // re-serialises the whole `style` attribute, and a no-op restore should not even
    // reflow the attribute string.
    if (el.style.transform !== rec.transform) {
      if (rec.transform) el.style.transform = rec.transform; else el.style.removeProperty('transform');
    }
    if (el.style.opacity !== rec.opacity) {
      if (rec.opacity) el.style.opacity = rec.opacity; else el.style.removeProperty('opacity');
    }
    rec.lastTransform = null;
    rec.lastOpacity = null;
  };
  return {
    get(el) {
      let rec = map.get(el);
      if (!rec) {
        const size = measure(el);
        rec = {
          transform: el.style.transform || '',
          opacity: el.style.opacity || '',
          w: size.w,
          h: size.h,
          lastTransform: null,
          lastOpacity: null,
          audio: !!el.querySelector('.lolly-box-audio'),
        };
        map.set(el, rec);
      } else if (!rec.w || !rec.h) {
        // First measurement happened before layout (a box measured during the same
        // frame it was painted). Re-measure until it answers, but only while we have
        // written nothing — after that the rect would include our own transform.
        if (rec.lastTransform == null) {
          const size = measure(el);
          if (size.w) rec.w = size.w;
          if (size.h) rec.h = size.h;
        }
      }
      return rec;
    },
    restore(el) {
      const rec = map.get(el);
      if (rec) put(el, rec);
    },
    restoreAll() {
      for (const [el, rec] of map) put(el, rec);
      map.clear();
    },
    prune(keep) {
      for (const el of [...map.keys()]) if (!keep.has(el)) map.delete(el);
    },
    size: () => map.size,
  };
}

// ── applyTime, against a plain element list ─────────────────────────────────

/** Everything applyTime needs beyond the elements themselves. */
export interface ApplyCtx {
  /** Sequence length in ms (for open-ended boxes and the exit tail). */
  seqMs: number;
  store: AuthoredStore;
  /**
   * Called once per timed box after its visual state is settled, so the caller can
   * drive that box's media (a <video>'s currentTime, a Lottie player's frame).
   * `sourceMs` is the position INSIDE the media: `clipIn + local * speed`.
   */
  media?(el: HTMLElement, timing: Timing, sourceMs: number, active: boolean): void;
}

/** The class the panel's stylesheet turns into `display:none`. */
export const OFF_CLASS = 'seq-off';

/**
 * The class lib/clip-thumbs.ts parks a box under while it photographs it for a timeline
 * thumbnail — `transform: translate(-200vw,-200vw) !important` in timeline.css. A shot
 * has to lift `seq-off` to photograph anything, and parking is what keeps the un-hidden
 * box off the live artboard for the ~100ms-1.5s that takes.
 */
export const SHOT_CLASS = 'tl-shot';

/**
 * Stamped by a thumbnail shot on every element whose `seq-off` it borrowed, carrying the
 * shot's own token. It is the LEASE on that element's visibility: while it is present the
 * shot owns the class (so a tick mid-shot must not re-hide the box it is reading), and
 * the applier revokes the lease — attribute and park both — the moment it wants that box
 * on screen, which is the shot's signal to stand down instead of re-hiding it.
 *
 * Without the lease the playhead could be scrubbed ONTO a parked box: the applier removed
 * `seq-off`, believed the scene live, and the park kept it 200vw off the viewport for the
 * rest of the shot — a black stage that popped back when the shot finally settled.
 */
export const BORROW_ATTR = 'data-tl-borrowed';

/**
 * Take a box's visibility back off any thumbnail shot holding it.
 *
 * `closest` rather than the element itself because the park is on the BOX while the
 * borrow may have been taken on a descendant: un-parking the ancestor is what actually
 * puts the pixels back on the artboard.
 */
export function releaseShotBorrow(el: HTMLElement): void {
  const parked = el.closest?.(`.${SHOT_CLASS}`) as HTMLElement | null;
  parked?.classList.remove(SHOT_CLASS);
  if (el.hasAttribute?.(BORROW_ATTR)) el.removeAttribute(BORROW_ATTR);
}

/**
 * Put every timed element into the state it should be in at `tMs`.
 *
 * Exported taking an explicit element list so the whole visual contract — the
 * half-open window, the composition with authored styles, the restore on leaving a
 * transition — is unit-testable without a clock, an AudioContext or a live canvas.
 */
export function applyTimeToElements(els: HTMLElement[], tMs: number, ctx: ApplyCtx): void {
  for (const el of els) {
    const timing = readTiming(el);
    const rec = ctx.store.get(el);
    const active = isActiveAt(timing, tMs, ctx.seqMs);
    // Class-only visibility. We deliberately do NOT also write `style.visibility`:
    // it is a property the tool's own boxCss is free to author, and a belt-and-braces
    // write there would be indistinguishable from the author's on restore. The class
    // is the whole contract; timeline.css owns what it means.
    // This pass is the AUTHORITY on visibility, including over a thumbnail shot that
    // borrowed it: making a box active revokes the lease and un-parks it in the same
    // breath, so the scene under the playhead is on the artboard now, not when the shot
    // gets round to settling. Going the other way the shot keeps what it borrowed — it is
    // parked offscreen anyway, and re-hiding it here would photograph the blank the
    // borrow exists to prevent — and its own restore puts `seq-off` back.
    if (active) { el.classList.remove(OFF_CLASS); releaseShotBorrow(el); }
    else if (!el.hasAttribute?.(BORROW_ATTR)) el.classList.add(OFF_CLASS);

    const tr = active && !rec.audio ? transitionAt(timing, tMs, ctx.seqMs) : null;
    if (tr) {
      const off = recTransition(tr.kind, tr.p, rec.w, rec.h, tr.ease);
      const transform = composeTransform(rec.transform, off);
      const opacity = composeOpacity(rec.opacity, off.alpha);
      if (transform !== rec.lastTransform) {
        if (transform) el.style.transform = transform; else el.style.removeProperty('transform');
        rec.lastTransform = transform;
      }
      if (opacity !== rec.lastOpacity) {
        el.style.opacity = opacity;
        rec.lastOpacity = opacity;
      }
    } else if (rec.lastTransform !== null || rec.lastOpacity !== null) {
      // Left the window (or went off screen): hand the authored styles straight back.
      ctx.store.restore(el);
    }

    if (ctx.media) {
      const local = Math.max(0, tMs - timing.start);
      ctx.media(el, timing, timing.clipIn + local * timing.speed, active);
    }
  }
}

// ── a whole stage, at a time ────────────────────────────────────────────────

/**
 * The `[data-sequence]` artboard inside (or at) `root`, or null when the render
 * target is not a timed composition. Same reading as sequence-plan's
 * `parseSequenceStage`, so "is a sequence" means one thing everywhere.
 */
export function sequenceStageOf(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  return root.matches?.('[data-sequence]')
    ? root
    : (root.querySelector?.('[data-sequence]') as HTMLElement | null);
}

/** The declared sequence length in ms (`data-seq-ms`), or 0 when untimed. */
export function sequenceDurationMs(root: HTMLElement | null): number {
  const stage = sequenceStageOf(root) ?? root;
  if (!stage) return 0;
  const el = stage.matches?.('[data-seq-ms]')
    ? stage
    : (stage.querySelector?.('[data-seq-ms]') as HTMLElement | null)
      ?? (root?.querySelector?.('[data-seq-ms]') as HTMLElement | null);
  const v = parseFloat(el?.getAttribute('data-seq-ms') || '');
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** A reversible run of applications against one root. Reuse it across frames. */
export interface SequenceTimeSession {
  /** Put every timed box into the state it should be in at `tMs`. */
  apply(tMs: number): void;
  /** The stage's declared length, ms (re-read each call — a repaint can change it). */
  durationMs(): number;
  /** Hand every touched element its authored class/styles back, and forget them. */
  restore(): void;
}

/**
 * Open a session over `root`.
 *
 * A session, not a bare function, because the authored styles have to be remembered
 * ACROSS frames: capturing them per call would re-capture our own animated transform
 * on frame 2 and bake it in. `restore()` is what makes the DOM byte-for-byte the
 * caller's again — always call it in a `finally`.
 */
export function createSequenceTime(root: HTMLElement, opts: { media?: ApplyCtx['media'] } = {}): SequenceTimeSession {
  const store = createAuthoredStore();
  const boxes = (): HTMLElement[] => {
    const stage = sequenceStageOf(root) ?? root;
    return [...stage.querySelectorAll<HTMLElement>('[data-t-start]')];
  };
  return {
    apply(tMs) {
      const els = boxes();
      // A repaint mints new nodes; dropping the dead entries keeps the store from
      // handing a stale authored value to a fresh box at the same position.
      store.prune(new Set(els));
      applyTimeToElements(els, tMs, {
        seqMs: sequenceDurationMs(root),
        store,
        ...(opts.media ? { media: opts.media } : {}),
      });
    },
    durationMs: () => sequenceDurationMs(root),
    restore() {
      // The class is not part of the authored-style store (it is applied, not
      // composed), so it has to be lifted separately — the same two-step the preview
      // clock's destroy() does. Leaving it behind hides every box that was off screen
      // at the last applied frame: a live capture would end with a blank canvas.
      // Any in-flight shot's lease goes with it: this session is done asserting
      // visibility, so a restore arriving afterwards must not re-hide anything.
      for (const el of boxes()) { el.classList.remove(OFF_CLASS); releaseShotBorrow(el); }
      store.restoreAll();
    },
  };
}

// Sessions opened by the free-function form below, keyed by root so repeated calls
// keep composing against the SAME captured authored styles.
const AD_HOC = new WeakMap<HTMLElement, SequenceTimeSession>();

/**
 * Put `root`'s composition at `tMs`. The convenience form of `createSequenceTime`
 * for callers that just want to step time (a contact sheet walking t across the
 * sequence): the session is remembered per root, so the authored styles are captured
 * once. Pair it with `restoreSequenceTime(root)` when finished.
 */
export function applySequenceTime(root: HTMLElement, tMs: number): void {
  let s = AD_HOC.get(root);
  if (!s) { s = createSequenceTime(root); AD_HOC.set(root, s); }
  s.apply(tMs);
}

/** Undo every `applySequenceTime` write on `root`. A no-op if there were none. */
export function restoreSequenceTime(root: HTMLElement): void {
  const s = AD_HOC.get(root);
  if (s) { s.restore(); AD_HOC.delete(root); }
}

/** A playhead someone else's clock is pacing. See `driveSequenceTime`. */
export interface SequenceDriver {
  /** Begin at t=0 and advance in real time. Idempotent. */
  start(): void;
  /** Stop advancing and restore the DOM. Idempotent, safe before `start`. */
  stop(): void;
}

/** Frames per second the live driver steps the DOM at. */
export const DRIVE_FPS = 30;

/**
 * Advance `root`'s playhead in REAL TIME for `durationMs`, then hold the last frame.
 *
 * Paced by setTimeout against a wall clock, deliberately NOT rAF — the same rule the
 * rest of the export path follows: rAF stops entirely in a backgrounded tab, which
 * would strand a live capture on one frame (the exact bug this exists to fix). Each
 * tick reads the clock rather than counting frames, so a throttled timer skips
 * ahead instead of drifting into slow motion.
 */
export function driveSequenceTime(
  root: HTMLElement,
  o: {
    durationMs: number;
    fps?: number;
    /** Test seam: monotonic ms. */
    now?: () => number;
    /** Test seam: returns a canceller. */
    schedule?: (fn: () => void, ms: number) => () => void;
  },
): SequenceDriver {
  const session = createSequenceTime(root);
  const now = o.now ?? (typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now());
  const schedule = o.schedule ?? ((fn, ms) => {
    const h = setTimeout(fn, ms) as unknown as number;
    return () => clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
  });
  const step = 1000 / Math.max(1, o.fps ?? DRIVE_FPS);
  const total = Math.max(0, o.durationMs);
  let cancel: (() => void) | null = null;
  let running = false;
  let t0 = 0;

  const tick = (): void => {
    cancel = null;
    if (!running) return;
    const t = now() - t0;
    // Past the end we hold the final frame rather than snapping back to 0 or
    // clearing the stage: a recorder still rolling must keep seeing the composition.
    try { session.apply(Math.min(t, total)); } catch { /* one bad frame never kills the take */ }
    if (t >= total) { running = false; return; }
    cancel = schedule(tick, step);
  };

  return {
    start() {
      if (running) return;
      running = true;
      t0 = now();
      tick();
    },
    stop() {
      running = false;
      if (cancel) { cancel(); cancel = null; }
      session.restore();
    },
  };
}
