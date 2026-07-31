// SPDX-License-Identifier: MPL-2.0
/**
 * timeline-panel.ts — the docked timeline editor for a `boxes` block that carries the
 * phase-1 time model (plans/fable-timeline-phase-2.md §2).
 *
 * Three hard rules shape everything below, and every one of them exists because the
 * alternative has already bitten this codebase:
 *
 *  1. NO EDITING ARITHMETIC LIVES HERE. Every model mutation goes through
 *     ./timeline-math.ts (packSeq / moveSeqClip / removeAndRipple / trimClip /
 *     splitAll / joinClips / detachAudio / reattachAudio / snapTime / deriveDuration /
 *     fmtTime). The panel converts pixels to
 *     seconds and hands seconds to that module. If a gesture needs a new clamp, the
 *     clamp belongs in timeline-math beside the one it must agree with — never
 *     re-derived here, where it would silently drift from the tool hook.
 *  2. THE MODEL IS WRITTEN EXACTLY ONCE PER GESTURE. While a pointer is down the panel
 *     mutates only its OWN DOM (bar left/width, playhead, snapline). `commit()` fires
 *     on pointerup, yielding one coalesced undo step — identical to the canvas gesture
 *     contract. `runtime.setInput` is never called mid-drag.
 *  3. KEYS ARE BOUND ON THE PANEL ROOT, never on window. free-canvas.ts already owns
 *     the window keydown channel (Delete/arrows/Escape on the selected boxes); a second
 *     window listener would fight it. The containment guard (`panelKeysActive`) is the
 *     page-filmstrip.ts pattern, exported so it is unit-testable.
 *
 * The playhead is NOT ours: ./sequence-clock.ts owns time, reads timing only from the
 * live canvas DOM, and never writes the model. The panel asks it to seek and listens to
 * `onTick` to move a line. Filmstrips/waveforms/stills come from ../lib/clip-thumbs.ts,
 * whose cache OWNS the returned ImageBitmaps — so every bitmap is drawn into the bar's
 * own <canvas> SYNCHRONOUSLY on receipt and never retained across an await or a repaint.
 * EVERY bar gets a picture: a filmstrip, a waveform, one tiled still (image / Lottie /
 * tool clip), or — with no media at all — a photograph of the box itself (a frame, a
 * card, a text box, a pen shape), over its own fill as the immediate underlay. That
 * last mode is the expensive one, so it is budgeted per pass and cached by APPEARANCE
 * rather than by identity; see `thumbMode` / `canRasterBox` / `appearanceSig` below.
 *
 * Repaint law (the chromeKey precedent): a full row rebuild happens only when the box
 * SET or a lane assignment changes (`tracksKey`). Everything else — dragging, trimming,
 * zooming, scrolling, the playhead — is style writes against a cached `pxPerSec`.
 */

import { t } from '../i18n.ts';
import { icon, type IconName } from '../lib/icons.ts';
import { announce } from '../a11y.ts';
import { playSfx } from '../lib/sfx.ts';
import { mountModal } from '../components/modal.ts';
import { mountBodyPopover, pointAnchor, type PopoverAnchor } from '../components/body-popover.ts';
import {
  filmstrip, peaks, stillFrames, nodeStill, nodeKey, peekNodeRaster, nodeRasterPending,
  nodeRasterFailed, onNodeShotSettled, releaseClipThumbs, onIdle,
  MAX_NODE_RASTER_NODES,
} from '../lib/clip-thumbs.ts';
import { TRANSITIONS, TRANSITION_KINDS, isTransitionKind } from '../lib/transitions.ts';
import { MAX_TRANSITION_MS, MIN_TRANSITION_MS, createSequenceClock, type SequenceClock } from './sequence-clock.ts';
import {
  DEFAULT_CLIP_S, MAX_TIME_S, MIN_DUR, MIN_TRIM_BAR_PX,
  boxTiming, deriveDuration, edgeZonePx, fmtDelta, fmtDur, fmtTime, indexOfId, isTimed,
  dropIndexAt, moveOverlay, moveSeqClip, packSeq, removeAndRipple, rippleOverlays, seqBoxes,
  setClipIn, setDuration, setSpeed,
  detachAudio, isThroughEdit, joinClips, reattachAudio, splitAll,
  snapTime, trimClip,
  type Box, type MediaDurFn, type TimeCfg,
} from './timeline-math.ts';
import { prefersReducedMotion } from '../lib/a11y-prefs.ts';
import type { AssetRef, AudioLevel, RecorderAPI, RecordSession } from '@lolly-tools/core/host-v1';
import { isTypingTarget } from '../lib/typing-target.ts';
import '../styles/parts/timeline.css';

// ── local structural types (kept minimal so free-canvas can pass its own objects) ──

/**
 * Just the slice of the tool runtime the panel needs: repaint notifications, plus a
 * READ-ONLY peek at the manifest's declared capabilities. The panel offers no
 * device-capture affordance to a tool that has not declared it needs one — the
 * manifest is the contract every other shell gates on (a CLI/TUI refuses to mount a
 * `microphone` tool at all), so the panel reads the same field rather than assuming
 * that "the web shell can record" means "this tool may".
 */
export interface TimelineRuntime {
  subscribe(fn: () => void): (() => void) | void;
  manifest?: { capabilities?: readonly string[] } | null;
}

/**
 * Just the slice of the host bridge the panel needs. `recorder` is the optional v1.17
 * capture API: absent on a shell that cannot record, in which case the mic affordance
 * is never rendered (see `canRecordVoiceover`).
 */
export interface TimelineHost {
  log?(level: string, msg: string): void;
  recorder?: RecorderAPI;
  /** The user-asset store, for retiring a take that a RE-take has superseded — and only
   *  once the replacement has been committed to the model (see finishTake). */
  assets?: { _deleteUserAsset?(id: string): Promise<void> };
}

/** The canvas selection seam, threaded from free-canvas (selection is keyed by box id). */
export interface TimelineSelection {
  get(): string[];
  set(ids: string[]): void;
  onChange(cb: () => void): () => void;
}

/**
 * One entry of the tool's OWN `canvas.addKinds` (free-canvas's `AddKind`, structurally).
 * The panel never hardcodes the list: sequence-studio declares clip/card/text/image/
 * lottie/audio/tool, and the next timed tool will declare something else entirely. Only
 * `id` and `label` are read here — the `seed` is free-canvas's business.
 */
export interface TimelineAddKind {
  id: string;
  label?: string;
  /**
   * The manifest's own seed for this kind — free-canvas's `AddKind.seed`, already
   * threaded here structurally. Read for exactly one thing: a take recorded in the
   * panel is born from the AUDIO kind's seed, so the box the panel inserts is
   * field-for-field the box the rail's "Audio" add-kind would have made. The panel
   * still never invents a kind of its own.
   */
  seed?: Record<string, unknown>;
}

/** The detail of the `tl-add` event the panel dispatches (the cross-module seam). */
export interface TimelineAddDetail {
  /** An addKind id from the manifest. */
  kind: string;
  /** Playhead time, ms — where the created box must START. */
  atMs: number;
}

export interface TimelinePanelOpts {
  stageEl: HTMLElement;
  canvasEl: HTMLElement;
  runtime: TimelineRuntime;
  host: TimelineHost;
  blockId: string;
  cfg: TimeCfg;
  getBoxes(): Box[];
  /** The free-canvas single write path — the ONLY way this module touches the model. */
  commit(next: Box[]): void;
  selection: TimelineSelection;
  onDirty?(id: string): void;
  /** Sets --stage-reserve-bottom on the stage + re-fits the canvas. 0 releases it. */
  reserve(px: number): void;
  /**
   * The tool manifest's `canvas.addKinds`, threaded by free-canvas. Populates the
   * panel's own `+` menu; each choice dispatches `tl-add` and free-canvas owns the
   * rest of the create pipeline. Omitted/empty hides the button entirely.
   */
  addKinds?: TimelineAddKind[];
  /**
   * The box sub-field that carries an asset ref (free-canvas's `cv.imageField`). Only
   * the record-in-place take writes one, and free-canvas does not thread it today, so
   * it is optional: `assetField()` falls back to sniffing an existing row for a ref,
   * then to the conventional `image`. Passing it explicitly is always better.
   */
  assetField?: string;
}

export interface TimelinePanel {
  destroy(): void;
  setOpen(open: boolean): void;
  isOpen(): boolean;
  /**
   * The scenery ⇄ timed writers, exposed so the CANVAS context menu (and free-canvas's
   * timeline-initiated create path) drive the SAME two functions the panel's own
   * inspector, chip and context menu use. There is exactly one implementation of each;
   * everything else is a door onto it. Both are one commit, one undo step.
   *
   * `dur: null` — passed explicitly, distinct from omitting it — means "author no
   * length": the caller knows the box's media length is not knowable yet. See promote's
   * own doc for why that is not the same as the default.
   */
  promote(id: string, want?: { start?: number; dur?: number | null }): void;
  demote(id: string): void;
}

// ── tunables ──────────────────────────────────────────────────────────────────

/** Panel height floor, px (§2 docking clamp). */
export const MIN_PANEL_H = 112;
/** Panel height on first open, px. Session-local; never persisted. */
export const DEFAULT_PANEL_H = 190;
/** One ordinary lane plus its gap — the least a tracks area can usefully show. */
export const ONE_LANE_H = 34;
/** Gap between the reserved band and the fitted canvas (the deck-editor's +6). */
export const RESERVE_PAD = 6;
/** Zoom floor/ceiling and the per-click step. */
export const MIN_PPS = 4;
export const MAX_PPS = 600;
export const ZOOM_STEP = 1.25;
/**
 * Edge-trim hit zone, px each side, for a PRECISE pointer (mouse / trackpad).
 *
 * The HIT size and the VISUAL size are deliberately different numbers: the grip drawn
 * inside `.tl-edge` stays a 3px hairline (a fat handle on a 40px bar is the bar), while
 * the zone that responds is this wide. IMG.LY ship the same split on their mobile
 * timeline — "more than twice as wide as the visual appearance suggests".
 *
 * Was 8, which was under every published floor. See EDGE_PX_COARSE for the one that
 * actually has a standard behind it; this one is the pointer that can be precise.
 */
export const EDGE_PX = 10;
/**
 * Edge-trim hit zone for a COARSE pointer (finger / pen), px each side.
 *
 * 24 is WCAG 2.5.8's target-size floor (AA), and the smallest of the three standards
 * in play — Apple asks 44pt, Material 48dp. Those two are about a target you TAP; this
 * is a target you press and drag along one axis, where the other axis is the full lane
 * height, so the AA floor is the honest number rather than the ambitious one.
 *
 * Picked per EVENT from `e.pointerType`, not from a media query: a touch laptop reports
 * `pointer: coarse` for the whole document while the user is on the trackpad, and
 * `matchMedia` is also absent under jsdom. The event knows exactly which finger arrived.
 */
export const EDGE_PX_COARSE = 24;
/** Seam (junction) hit zone, px each side. */
export const SEAM_PX = 8;
/**
 * Snap tolerance, screen px, by pointer kind. The module default in timeline-math
 * (SNAP_PX = 6) stays where it is — that is the value every OTHER caller of snapTime
 * gets; these two are the panel's own gesture tolerances, raised because a snap you
 * cannot land is a snap that does not exist, and a finger is not a cursor.
 */
export const SNAP_PX_FINE = 8;
export const SNAP_PX_COARSE = 12;
/** Arrow-key step: one frame at 30fps; Shift steps a whole second. */
export const FRAME_S = 1 / 30;
/** Keyboard trim step multiplier when Shift is held (`,`/`.` nudge the focused edge). */
export const TRIM_SHIFT_FRAMES = 10;
/** Filmstrip frames are never packed tighter than this, px. */
const MIN_FRAME_PX = 40;

/**
 * Voiceover take limits. `maxMs` mirrors record-control's audio cap (10 minutes) — a
 * runaway take is a runaway upload, and the panel warns before it lands. `countInMs`
 * is one beat of the 3-2-1 count-in.
 *
 * MUTABLE on purpose, like the engine's HOOK_BUDGET_MS: a jsdom test drives the whole
 * take through in one tick by zeroing the count-in, rather than sleeping 1.8 s.
 */
export const TAKE_TIMING = { countInMs: 600, maxMs: 10 * 60 * 1000, warnMs: 5000 };

// ── pure helpers (exported: these are what the unit tests reach) ───────────────

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const finite = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
};

/** Seconds → panel pixels at the current zoom. */
export function timeToPx(tSec: number, pxPerSec: number): number {
  return finite(tSec, 0) * finite(pxPerSec, 0);
}

/** Panel pixels → seconds at the current zoom. Zero/negative zoom reads as 0s. */
export function pxToTime(px: number, pxPerSec: number): number {
  const pps = finite(pxPerSec, 0);
  return pps > 0 ? finite(px, 0) / pps : 0;
}

/**
 * A viewport clientX → timeline seconds, given the track viewport's left edge and its
 * horizontal scroll. One function so the ruler, the bars and every gesture agree.
 */
export function clientToTime(clientX: number, rectLeft: number, scrollLeft: number, pxPerSec: number): number {
  return Math.max(0, pxToTime(finite(clientX, 0) - finite(rectLeft, 0) + finite(scrollLeft, 0), pxPerSec));
}

/** Clamp a zoom level into the supported range. */
export function clampPxPerSec(pps: number): number {
  return clamp(finite(pps, MIN_PPS), MIN_PPS, MAX_PPS);
}

/** The zoom that makes `durSec` exactly fill `widthPx` (with a little breathing room). */
export function fitPxPerSec(durSec: number, widthPx: number): number {
  const d = Math.max(0.5, finite(durSec, 0));
  const w = Math.max(80, finite(widthPx, 0)) - 24;
  return clampPxPerSec(w / d);
}

/**
 * Zoom about a cursor: the timeline instant under `cursorPx` (offset from the track
 * viewport's left edge) stays under the cursor afterwards. Returns the new zoom AND the
 * scroll that preserves the anchor — the caller applies both together.
 */
export function zoomAbout(pxPerSec: number, factor: number, cursorPx: number, scrollLeft: number): { pxPerSec: number; scrollLeft: number } {
  const pps = clampPxPerSec(pxPerSec);
  const next = clampPxPerSec(pps * finite(factor, 1));
  const anchor = pxToTime(finite(cursorPx, 0) + finite(scrollLeft, 0), pps);
  return { pxPerSec: next, scrollLeft: Math.max(0, timeToPx(anchor, next) - finite(cursorPx, 0)) };
}

/**
 * The identity of the panel's ROW STRUCTURE: box ids, their lane, and whether they are
 * timed at all. Geometry (start/dur) is deliberately absent — moving or trimming a clip
 * must restyle, never rebuild. The chromeKey precedent, applied to tracks.
 */
export function tracksKey(boxes: Box[], cfg: TimeCfg): string {
  const rows = Array.isArray(boxes) ? boxes : [];
  const parts: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i];
    if (!b) continue;
    const id = b[cfg.idField];
    const timing = boxTiming(b, cfg);
    parts.push(`${id == null ? '' : String(id)}:${timing.lane}:${isTimed(b, cfg) ? 1 : 0}`);
  }
  return parts.join('|');
}

/**
 * The times a drag may snap to: every clip edge, the playhead, and the whole seconds
 * NEAR the pointer. Bounded on purpose — emitting every whole second up to MAX_TIME_S
 * would hand snapTime a 3,600-entry array on every pointermove.
 */
export function snapCandidates(
  boxes: Box[],
  cfg: TimeCfg,
  playheadSec: number,
  aroundSec: number,
  excludeId?: string,
): number[] {
  const rows = Array.isArray(boxes) ? boxes : [];
  const out: number[] = [0];
  for (const b of rows) {
    if (!b) continue;
    const id = b[cfg.idField];
    if (excludeId != null && id != null && String(id) === String(excludeId)) continue;
    const timing = boxTiming(b, cfg);
    if (timing.lane !== 'seq' && timing.start === null) continue;
    const s = timing.start ?? 0;
    out.push(s);
    if (timing.dur !== null) out.push(s + timing.dur);
  }
  const ph = finite(playheadSec, 0);
  if (ph >= 0) out.push(ph);
  const centre = Math.round(finite(aroundSec, 0));
  for (let s = centre - 2; s <= centre + 2; s++) if (s >= 0) out.push(s);
  return out;
}

/**
 * The seam between two ADJACENT seq clips near `tSec`, if the pointer is within
 * `hitPx` of one. Seams are where junction transitions (cut / crossfade) are authored;
 * `a` is the clip that ends there, `b` the one that starts there.
 */
export function junctionAt(
  boxes: Box[],
  cfg: TimeCfg,
  tSec: number,
  pxPerSec: number,
  hitPx: number = SEAM_PX,
): { aId: string; bId: string; t: number } | null {
  const row = seqBoxes(Array.isArray(boxes) ? boxes : [], cfg);
  const pps = finite(pxPerSec, 0);
  if (row.length < 2 || !(pps > 0)) return null;
  const tol = Math.max(0, finite(hitPx, SEAM_PX)) / pps;
  const at = finite(tSec, 0);
  let best: { aId: string; bId: string; t: number } | null = null;
  let bestD = Infinity;
  for (let i = 0; i < row.length - 1; i++) {
    const a = row[i]!;
    const b = row[i + 1]!;
    const aId = a[cfg.idField];
    const bId = b[cfg.idField];
    if (aId == null || aId === '' || bId == null || bId === '') continue;
    const seam = boxTiming(b, cfg).start ?? 0;
    const d = Math.abs(seam - at);
    if (d <= tol && d < bestD) { best = { aId: String(aId), bId: String(bId), t: seam }; bestD = d; }
  }
  return best;
}

/** Is `el` something the user types into? Typing must never trigger a shortcut. */
export function isTextControl(el: Element | null | undefined): boolean {
  if (!el) return false;
  // isTypingTarget descends shadow roots: a focused jelly field reports its HOST as
  // the active element, and the host is neither an INPUT nor contentEditable.
  return isTypingTarget(el);
}

/**
 * The keyboard containment guard (page-filmstrip.ts:83-94, adapted). Shortcuts fire only
 * when the panel owns the interaction — focus inside it, or the pointer over it — and
 * never while a text control has focus, including the panel's own numeric fields.
 */
export function panelKeysActive(root: HTMLElement | null, active: Element | null, hovered: boolean): boolean {
  if (!root) return false;
  if (isTextControl(active)) return false;
  return Boolean(hovered || (active && root.contains(active)));
}

/**
 * Clamp a dragged panel height into the docking range ([floor, half the stage]).
 *
 * The floor has to clear the panel's OWN chrome, which is why `chromeH` exists: at
 * ≤720px `.tl-bar` wraps into three rows (transport / tools / inspector) where desktop
 * fits one, so the flat 112px that still leaves ~42px of track on desktop leaves none
 * at all on a phone — the resize grip could crush `.tl-tracks` to zero height and the
 * panel became 100% chrome showing no timeline. Callers that can measure their live
 * chrome pass it; the two-argument form keeps the original behaviour exactly.
 */
export function clampPanelH(h: number, stageH: number, chromeH = 0): number {
  const floor = Math.max(MIN_PANEL_H, Math.round(finite(chromeH, 0)) + ONE_LANE_H);
  const hi = Math.max(floor, Math.floor(finite(stageH, 0) * 0.5));
  return clamp(Math.round(finite(h, floor)), floor, hi);
}

/** Ruler tick spacing (seconds) for a zoom level — the smallest step ≥ 60px apart. */
export function tickStep(pxPerSec: number): number {
  const pps = Math.max(0.0001, finite(pxPerSec, 1));
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s * pps >= 60) return s;
  return steps[steps.length - 1]!;
}

/** How many filmstrip frames a bar of `widthPx` wants (bounded both ends). */
export function frameCountFor(widthPx: number): number {
  return clamp(Math.round(finite(widthPx, 0) / MIN_FRAME_PX), 1, 24);
}

/**
 * Is this pointer a coarse one — i.e. does it need the WCAG-floor hit target?
 *
 * Written as an ALLOW-LIST of the two coarse kinds rather than "anything that is not a
 * mouse", so an absent/unknown `pointerType` (jsdom builds MouseEvents; some browsers
 * report '' for a synthetic event) falls back to the PRECISE zone. Guessing coarse for
 * an unknown pointer is the dangerous direction: it steals 24px of every bar's body
 * from the move gesture on hardware that never needed it.
 */
export function isCoarsePointer(pointerType: string | undefined): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

/** The trim hit zone a pointer of this kind is entitled to, before the bar's own cap. */
export function edgeBase(pointerType: string | undefined): number {
  return isCoarsePointer(pointerType) ? EDGE_PX_COARSE : EDGE_PX;
}

// ── the controller ────────────────────────────────────────────────────────────

type GestureKind = 'trim' | 'move' | 'reorder' | 'seek' | 'resize';

interface Gesture {
  kind: GestureKind;
  id: string;
  pointerId: number;
  el: HTMLElement | null;
  /** Pointer x/y at pointerdown, viewport coords. */
  x0: number;
  y0: number;
  /** Latest pointer position — written SYNCHRONOUSLY in pointermove, read on pointerup. */
  x: number;
  y: number;
  alt: boolean;
  /**
   * The pointer kind that STARTED the gesture. Captured once rather than re-read per
   * move, because the hit zone that opened the gesture and the snap tolerance that
   * steers it must be the same pointer's numbers from pointerdown to pointerup.
   */
  pointerType: string;
  edge?: 'in' | 'out';
  /** Trim only: the limit signal has already been spoken for this gesture. */
  limitSaid?: boolean;
  /** Snapshot of the timing at pointerdown, so the drag is always absolute, never accumulated. */
  start0: number;
  dur0: number;
  /** Seq reorder only. */
  index0: number;
  index: number;
  /** Panel resize only. */
  h0: number;
  moved: boolean;
}

const cssEscape = (v: string): string => (
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(v)
    : String(v).replace(/["\\\]]/g, '\\$&')
);

interface BoxMedia {
  url: string;
  kind: 'video' | 'audio' | 'image' | 'lottie' | '';
  dur: number | null;
  /**
   * The live node the picture is already decoded in — the `<img>` on the canvas, or
   * a Lottie's mounted `<svg>`. Handed to clip-thumbs so a bar's still is drawn from
   * what is on screen instead of costing a second fetch + decode of the same asset.
   * Never retained across a repaint: a rebuild aborts the thumb pass that holds it.
   */
  el?: Element | null;
}

/** What a bar's canvas should paint, given what the box turned out to be. */
export type ThumbMode = 'waveform' | 'filmstrip' | 'still' | 'node' | 'fill' | 'none';

/**
 * How many dom-to-image shots ONE idle pass may start. Cache hits are free and
 * unlimited (they paint synchronously); only misses spend the budget, in bar order.
 * A twenty-frame timeline therefore fills in over four passes instead of stalling.
 */
export const MAX_NODE_RASTERS_PER_PASS = 6;
/**
 * Extra idle passes a single scheduling may chain, to finish work the budget deferred
 * — and to catch the OTHER late arrival: a Lottie whose player has not mounted its
 * <svg> by the first pass. Nothing else ever re-runs a pass (they fire on rebuild,
 * gesture-end, zoom, fit and an appearance change only), so without this a slow Lottie
 * bar stayed blank forever.
 *
 * Six, not three: three passes bounded a scheduling at 18 shots, so a twenty-frame
 * sequence had two bars that could never be reached at all. The chain still terminates
 * — a pass that leaves nothing pending does not queue the next, an in-flight bar no
 * longer counts as pending (nodeRasterPending) and a bar that failed once is retired
 * (nodeRasterFailed) — so this is a ceiling, not a schedule.
 */
export const MAX_THUMB_PASSES = 6;

/**
 * Is a computed CSS colour actually going to leave a mark?
 *
 * `getComputedStyle().backgroundColor` reports the "no background" case as
 * `rgba(0, 0, 0, 0)`, which paints an invisible rectangle and would light up
 * `has-thumbs` (and its label scrim) for a bar that shows nothing.
 */
export function isPaintedColor(css: string): boolean {
  const v = String(css ?? '').trim().toLowerCase();
  if (!v || v === 'transparent' || v === 'none' || v === 'initial' || v === 'unset') return false;
  const m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const parts = (m[1] as string).split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 4) {
      const raw = parts[3] as string;
      // A computed value is always numeric, but the modern space-separated syntax
      // allows a percentage and this predicate also reads authored colours.
      const a = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
      return Number.isFinite(a) ? a > 0.02 : true;
    }
  }
  return true;
}

/**
 * The branch every bar takes. Pure, and the whole point of it: before this, only
 * audio and video bars painted anything, so a timeline of cards and tool clips was
 * a row of identical coloured rectangles.
 *
 * Order is the design, not an accident:
 *
 *   • A decoded ASSET wins over everything. It is both cheaper (one <img> decode, or
 *     a straight reuse of the element already on screen) and more faithful than a
 *     photograph of the DOM — and a tool clip must keep taking `still`, because that
 *     <img> IS the compose render, not a screenshot of a tag.
 *   • `node` sits above `fill`, because a photograph of the box is strictly more
 *     information about the same box than its background colour is.
 *   • `node` sits above `none` TOO, which is the point of the whole branch: a text
 *     card and every pen shape (the tool hook forces `kind:'path'` boxes to a
 *     transparent fill) painted nothing at all before it existed.
 *
 * `canRaster` defaults to false so every existing call site — and every pinned row of
 * the table this function is tested against — keeps its exact previous answer.
 */
export function thumbMode(kind: string, url: string, fill: string, canRaster = false): ThumbMode {
  if (url) {
    if (kind === 'audio') return 'waveform';
    if (kind === 'video') return 'filmstrip';
    if (kind === 'image' || kind === 'lottie') return 'still';
  }
  if (canRaster) return 'node';
  return isPaintedColor(fill) ? 'fill' : 'none';
}

/**
 * Is this box worth photographing, and cheap enough to?
 *
 * Called ONCE per bar, in the thumb pass's read phase, and only for a box that turned
 * out to have no media — `querySelectorAll`/`textContent` force no layout, so it is
 * safe there and nowhere near the paint phase.
 *
 * Declining is the important half. An empty, transparent, textless box would cost a
 * full dom-to-image shot to produce a blank bitmap, so it stays on `none`; and a box
 * with a pathological subtree is refused outright rather than allowed to eat the
 * pass's whole budget (the MAX_SVG_MARKUP / MAX_AUDIO_DECODE_BYTES idiom — decline,
 * don't build it).
 */
export function canRasterBox(
  box: HTMLElement | null | undefined,
  fill: string,
  maxNodes: number = MAX_NODE_RASTER_NODES,
): boolean {
  if (!box) return false;
  if ((box.querySelectorAll?.('*').length ?? 0) > maxNodes) return false;
  if (isPaintedColor(fill)) return true;                    // a card / a coloured frame
  // A pen shape: hooks.js forces every `kind:'path'` box to fill:'transparent', so the
  // computed background says "nothing here" while the <svg> inside says otherwise.
  if (box.querySelector?.('.lolly-box-path')) return true;
  return !!box.querySelector?.('.lolly-box-text')?.textContent?.trim();
}

/**
 * The APPEARANCE identity of a box — everything that decides what its photograph looks
 * like, and nothing that decides where its bar sits.
 *
 * TIMING fields are excluded deliberately: a drag rewrites start/dur on every
 * pointermove, and re-keying on those would throw away a picture that has not changed
 * one pixel and retake it at the end of every gesture. `idField` is excluded too — two
 * boxes that look identical may legitimately share one raster (and one shot).
 *
 * O(row keys), against O(subtree bytes) for anything derived from the DOM. The box DOM
 * is a pure function of (model row, brand/theme, fonts), so the caller appends the two
 * environment terms it already has in hand — the box's computed background and the
 * document's theme stamp — rather than this module reaching for them. Same shape as
 * the `tracksKey` precedent above.
 *
 * Joined on U+0001, written as an escape — no authored field value contains it.
 */
/**
 * One field's contribution to an appearance signature.
 *
 * `String(v)` is wrong for the structured halves of `InputValue` — a token reference
 * `{ref,value}`, an asset ref, a blocks array — every one of which stringifies to
 * `[object Object]`. Two boxes differing ONLY in such a field would then share a
 * signature, hence a cache key, hence (via `share()`) one photograph served to both.
 * Today's sequence-studio schema keeps its colours and paths as strings, so this is
 * hardening rather than a fix, but the signature is the cache identity for an open
 * `Record<string, InputValue>` and the failure would be silent and wrong.
 */
function sigValue(v: unknown): string {
  if (typeof v !== 'object') return String(v);
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '[cyclic]';   // never thrown by an input value, but a signature must not throw
  }
}

export function appearanceSig(box: Box | undefined, cfg: TimeCfg): string {
  const b = box || {};
  const skip = new Set<string>([
    cfg.idField,
    cfg.startField, cfg.durField, cfg.clipInField, cfg.speedField,
    cfg.enterField, cfg.exitField, cfg.enterMsField, cfg.exitMsField,
    cfg.laneField,
  ]);
  const parts: string[] = [];
  for (const k of Object.keys(b)) {
    if (skip.has(k)) continue;
    const v = b[k];
    // null / undefined / '' are the same "unauthored" state as far as paint goes, so
    // they must collapse to one signature rather than three.
    parts.push(`${k}=${v == null ? '' : sigValue(v)}`);
  }
  // Sorted, so two rows built by different code paths (a seed vs. a patch) that carry
  // the same fields in a different insertion order share a picture.
  parts.sort();
  return parts.join('\u0001');
}

export function initTimelinePanel(opts: TimelinePanelOpts): TimelinePanel {
  const { stageEl, canvasEl, runtime, host, blockId, cfg, getBoxes, commit, selection, onDirty, reserve } = opts;
  const addKinds: TimelineAddKind[] = Array.isArray(opts.addKinds) ? opts.addKinds.filter((k) => k && k.id) : [];

  let open = false;
  let disposed = false;
  let panelH = DEFAULT_PANEL_H;
  let pxPerSec = 60;
  let fitPending = true;
  let gesture: Gesture | null = null;
  let lastKey = '\u0000';           // deliberately unmatchable, so the first sync rebuilds
  // Ditto, for what a bar's PICTURE depends on rather than what its ROW does (see sync).
  let lastAppearance = String.fromCharCode(0);
  let focusedId = '';
  let snapOn = true;
  let thumbAbort: AbortController | null = null;
  let cancelIdle: (() => void) | null = null;
  let syncScheduled = false;
  let syncMissed = false;    // a model change arrived mid-gesture; replay it on release
  let moveScheduled = false;

  const bars = new Map<string, HTMLElement>();
  /**
   * The scenery strip's chips, id → the chip BUTTON (its pill wrapper is the parent).
   * A sibling of `bars` on purpose: together they are "every box the panel is showing",
   * which is exactly the set the inspector may open on. Before this map existed the
   * inspector keyed off `bars` alone, so selecting an untimed box showed nothing at all
   * and there was no route from "always on" to "timed" anywhere in the UI.
   */
  const chips = new Map<string, HTMLElement>();

  // ── DOM ─────────────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.className = 'tl-panel';
  root.setAttribute('data-export-hide', '');   // export-safety: never walked into an SVG/PDF
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', t('Timeline'));
  root.tabIndex = -1;
  root.hidden = true;

  const handle = document.createElement('div');
  handle.className = 'tl-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.setAttribute('aria-label', t('Resize timeline'));
  handle.tabIndex = 0;

  const bar = document.createElement('div');
  bar.className = 'tl-bar';

  const btn = (cls: string, label: string, glyph: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `tl-btn ${cls}`;
    b.setAttribute('aria-label', label);
    b.setAttribute('data-tip', label);
    b.innerHTML = glyph;
    return b;
  };
  // Every glyph now comes from the registry (lib/icons.ts). The `.tl-glyph` CSS
  // drawings this file used to emit for pause / scissors / plus existed only because
  // those three had no registry entry and a hand-inlined 24×24 <svg> here trips the R3
  // primitive guard; zoom in/out were a bare `+`/`−` rather than magnifiers. All five
  // are real entries now, so there is one source of truth for icon shape again.

  const playBtn = btn('tl-play', t('Play'), icon('play'));
  const timeEl = document.createElement('span');
  timeEl.className = 'tl-time';
  timeEl.setAttribute('aria-live', 'off');

  const addBtn = btn('tl-add', t('Add to the timeline'), icon('plus'));
  addBtn.setAttribute('aria-haspopup', 'menu');
  addBtn.setAttribute('aria-expanded', 'false');
  // No declared kinds means the host tool has no create pipeline to arm — the button
  // would open an empty menu, so it is not rendered at all.
  addBtn.hidden = !addKinds.length;
  const splitBtn = btn('tl-split', t('Split at playhead'), icon('scissors'));
  const snapBtn = btn('tl-snap', t('Snap to edges'), icon('pin'));
  snapBtn.setAttribute('aria-pressed', 'true');
  const zoomOutBtn = btn('tl-zoom-out', t('Zoom out'), icon('zoomOut'));
  const zoomInBtn = btn('tl-zoom-in', t('Zoom in'), icon('zoomIn'));
  const fitBtn = btn('tl-fit', t('Fit to view'), icon('resize'));

  // ── record-in-place voiceover (track C) ──────────────────────────────────────
  // The button is only rendered when the SHELL can capture audio and the TOOL has
  // declared it needs a microphone; see canRecordVoiceover for why both.
  const micBtn = btn('tl-mic', t('Record a voiceover'), icon('mic'));
  micBtn.hidden = true;   // decided below, once the capability check has run

  /** The take HUD: a live level meter and the elapsed clock, shown only during a take. */
  const rec = document.createElement('div');
  rec.className = 'tl-rec';
  rec.hidden = true;
  const recDot = document.createElement('span');
  recDot.className = 'tl-rec-dot';
  recDot.setAttribute('aria-hidden', 'true');
  const recTime = document.createElement('span');
  recTime.className = 'tl-rec-time';
  // Silent to a screen reader: the elapsed number changes 60 times a second, and the
  // spoken cues that matter (start, the 5-second warning, stop) are announce()d.
  recTime.setAttribute('aria-hidden', 'true');
  const recMeter = document.createElement('span');
  recMeter.className = 'tl-rec-meter';
  recMeter.setAttribute('aria-hidden', 'true');
  const recFill = document.createElement('span');
  recFill.className = 'tl-rec-fill';
  recMeter.appendChild(recFill);
  rec.append(recDot, recTime, recMeter);
  /** Permission/again messages. A live region, so a denial is spoken as well as shown. */
  const recNote = document.createElement('span');
  recNote.className = 'tl-rec-note';
  recNote.setAttribute('role', 'status');
  recNote.hidden = true;

  const transport = document.createElement('div');
  transport.className = 'tl-transport';
  transport.append(playBtn, timeEl);
  const tools = document.createElement('div');
  tools.className = 'tl-tools';
  tools.append(addBtn, micBtn, splitBtn, snapBtn, zoomOutBtn, zoomInBtn, fitBtn);
  const inspector = document.createElement('div');
  inspector.className = 'tl-inspector';
  bar.append(transport, tools, rec, recNote, inspector);

  const ruler = document.createElement('div');
  ruler.className = 'tl-ruler';
  ruler.setAttribute('role', 'slider');
  ruler.setAttribute('aria-label', t('Playhead'));
  ruler.setAttribute('aria-valuemin', '0');
  ruler.tabIndex = 0;
  const rulerInner = document.createElement('div');
  rulerInner.className = 'tl-ruler-inner';
  ruler.appendChild(rulerInner);

  const tracks = document.createElement('div');
  tracks.className = 'tl-tracks';
  const inner = document.createElement('div');
  inner.className = 'tl-tracks-inner';
  const laneWrap = document.createElement('div');
  laneWrap.className = 'tl-lanes';
  laneWrap.setAttribute('role', 'listbox');
  laneWrap.setAttribute('aria-label', t('Clips'));
  laneWrap.setAttribute('aria-orientation', 'horizontal');
  // Shift-click toggles, so the listbox must say so.
  laneWrap.setAttribute('aria-multiselectable', 'true');
  const scenery = document.createElement('div');
  scenery.className = 'tl-scenery';
  const playhead = document.createElement('div');
  playhead.className = 'tl-playhead';
  const snapline = document.createElement('div');
  snapline.className = 'tl-snapline';
  snapline.hidden = true;
  /**
   * The ghost EXTENT: how far this clip could reach in either direction before it runs
   * out of source. Shown for the length of a trim gesture only (FCP's "available media"
   * idea, drawn rather than implied).
   *
   * A panel-level element positioned in timeline pixels, NOT a child of the bar —
   * `.tl-clip` is `overflow: hidden`, so a child could never paint the one thing this
   * element exists to show, which is the media that is currently OUTSIDE the bar.
   *
   * Solid 1px outline, not dashed: dashed borders in this shell mean "drop area".
   */
  const extent = document.createElement('div');
  extent.className = 'tl-clip-extent';
  extent.hidden = true;
  extent.setAttribute('aria-hidden', 'true');
  /**
   * The trim readout: absolute duration plus a signed delta, anchored at the edge being
   * dragged (Final Cut's pairing — the absolute number is what you are aiming for, the
   * delta is what you have done). aria-hidden because it changes every frame; the
   * spoken version is one announce() on release.
   */
  const trimBadge = document.createElement('div');
  trimBadge.className = 'tl-trim-badge';
  trimBadge.hidden = true;
  trimBadge.setAttribute('aria-hidden', 'true');
  inner.append(laneWrap, scenery, extent, playhead, snapline, trimBadge);
  tracks.appendChild(inner);

  root.append(handle, bar, ruler, tracks);
  stageEl.appendChild(root);

  const clock: SequenceClock = createSequenceClock({ canvasEl, host });

  // ── model plumbing (every write funnels through here) ───────────────────────

  /** The one write path. Called at most once per gesture, on pointerup. */
  function write(next: Box[]): void {
    onDirty?.(blockId);
    commit(next);
  }

  /** Set fields on one box. A VALUE write — no arithmetic, by design (see header). */
  function patchBox(boxes: Box[], id: string, patch: Record<string, Box[string]>): Box[] {
    const i = indexOfId(boxes, cfg, id);
    if (i < 0) return boxes;
    return boxes.map((b, k) => (k === i ? { ...b!, ...patch } : b));
  }

  /** The canvas element rendering a box, if it is on screen. */
  function boxEl(id: string): HTMLElement | null {
    if (!id) return null;
    return canvasEl.querySelector<HTMLElement>(`.lolly-box[data-box-id="${cssEscape(id)}"]`);
  }

  /**
   * The media length a DETACHED sound borrows from the clip it came from.
   *
   * A detached audio box is a REFERENCE — same asset ref, same URL — but the tool hook
   * only stamps `data-audio-dur` when the ASSET carries a `meta.durationMs`, and a video
   * file's ref usually does not (its length is discovered by decoding it). The partner
   * video element has already decoded, and `video.duration` is the same number the
   * sound's own source runs for. Without this a detached sound is unclamped: you can
   * drag its out-edge past the end of the file into silence, and "fit to media" cannot
   * work — the exact hole `data-audio-dur` exists to close for a library track.
   *
   * Reads the partner's <video> DIRECTLY rather than recursing through mediaOf, so a
   * mutually-linked pair can never loop.
   */
  function linkedMediaDur(id: string): number | null {
    const link = cfg.linkField;
    if (!link) return null;
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0) return null;
    const partner = rows[i]![link];
    if (partner == null || partner === '') return null;
    const video = boxEl(String(partner))?.querySelector<HTMLVideoElement>('video.lolly-box-video');
    const d = Number(video?.duration);
    return Number.isFinite(d) && d > 0 ? d : null;
  }

  /**
   * A box's media, read from the LIVE CANVAS rather than the model: the hook has already
   * resolved the asset ref to a URL there, and a decoded <video> also knows its real
   * duration — which is exactly what trimClip's media clamp wants.
   */
  function mediaOf(id: string): BoxMedia {
    const el = boxEl(id);
    if (!el) return { url: '', kind: '', dur: null };
    const audio = el.querySelector<HTMLElement>('.lolly-box-audio[data-audio-src]');
    if (audio) {
      // An audio box has no media element to ask for .duration, so the tool hook
      // stamps the source's length from the asset's own metadata. This is what lets
      // a sound be trimmed PRECISELY: trimClip clamps clipIn + dur*speed against it,
      // "fit to media" works, and promote defaults the length to the track rather
      // than to a flat 3s. Absent (a procedural bed has no fixed length) reads back
      // as null, which is the old unclamped behaviour.
      const ms = Number(audio.getAttribute('data-audio-dur'));
      return {
        url: audio.getAttribute('data-audio-src') || '',
        kind: 'audio',
        dur: Number.isFinite(ms) && ms > 0 ? ms / 1000 : linkedMediaDur(id),
      };
    }
    const video = el.querySelector<HTMLVideoElement>('video.lolly-box-video');
    if (video) {
      const d = Number(video.duration);
      return { url: video.currentSrc || video.src || '', kind: 'video', dur: Number.isFinite(d) && d > 0 ? d : null };
    }
    // A Lottie is a MARKER div, not an <img>: the shell's lottie-mount enhancer builds
    // a live <svg> inside it. Checked before the <img> branch because the marker also
    // carries .lolly-box-img (it inherits the same position/size rules). Its picture is
    // that mounted <svg> — absent until the player has painted, which just means the
    // bar stays plain until the next thumb pass.
    const lottie = el.querySelector<HTMLElement>('.lolly-box-lottie[data-lottie-src]');
    if (lottie) {
      return { url: lottie.getAttribute('data-lottie-src') || '', kind: 'lottie', dur: null, el: lottie.querySelector('svg') };
    }
    // Plain images AND tool clips: a tool-as-clip resolves through host.compose to a
    // data: URL and lands here as an ordinary <img>, so it needs no branch of its own.
    const img = el.querySelector<HTMLImageElement>('img.lolly-box-img');
    if (img) return { url: img.currentSrc || img.src || '', kind: 'image', dur: null, el: img };
    return { url: '', kind: '', dur: null };
  }

  const mediaDur: MediaDurFn = (b) => {
    const id = b?.[cfg.idField];
    return id == null || id === '' ? null : mediaOf(String(id)).dur;
  };

  /** A bar's human label: the box's own text if it has any, else its media kind. */
  function labelFor(id: string): string {
    const el = boxEl(id);
    const txt = el?.querySelector<HTMLElement>('.lolly-box-text')?.textContent?.trim();
    if (txt) return txt.length > 48 ? `${txt.slice(0, 47)}…` : txt;
    const kind = mediaOf(id).kind;
    if (kind === 'video') return t('Video');
    if (kind === 'audio') return t('Audio');
    if (kind === 'image') return t('Image');
    if (kind === 'lottie') return t('Animation');
    return t('Clip');
  }

  const durationSec = (): number => deriveDuration(getBoxes(), cfg) / 1000;

  // ── geometry ────────────────────────────────────────────────────────────────

  /** Where a box's bar sits, in seconds. Open-ended clips run to the sequence end. */
  function span(b: Box, total: number): { start: number; dur: number } {
    const timing = boxTiming(b, cfg);
    const start = timing.start ?? 0;
    const dur = timing.dur ?? Math.max(MIN_DUR, total - start);
    return { start, dur };
  }

  /** Every TIMED box whose span contains `at` (seconds). Scenery is always on and is
   *  never listed — it has no span to leave. */
  function activeIdsAt(boxes: Box[], at: number): string[] {
    const total = durationSec();
    const out: string[] = [];
    for (const b of boxes) {
      if (!b || !isTimed(b, cfg)) continue;
      const { start, dur } = span(b, total);
      if (at >= start && at < start + dur) out.push(String(b[cfg.idField] ?? ''));
    }
    return out;
  }

  // ── the one selection writer (free-canvas.ts's header states the rule) ────────
  //
  // "Selecting in the timeline moves the playhead so the selection stays live."
  //
  // The rule is one-directional on purpose. TIME never rewrites the selection — that
  // is the Premiere failure ("the selection jumps back to the clip under the playhead
  // and I wind up making changes to the wrong clip") — but SELECTION may move time,
  // because the alternative is a selected clip the canvas cannot show and therefore
  // cannot edit. So every route into `selection.set` inside this panel comes through
  // here instead, and the canvas's off-playhead banner becomes a state you can only
  // reach the long way round (scrub away from your own selection).
  //
  // Three refusals, each load-bearing:
  //   • `{ reveal: false }` — a Shift-extend. Revealing on the SECOND of two clips
  //     picks one arbitrarily and moves the picture out from under the first.
  //   • playing — a seek mid-playback is a jump-cut nobody asked for, and during
  //     playback the selection is going in and out of frame by definition.
  //   • already live — the commonest case by far, and it must cost nothing.
  function selectAndReveal(ids: string[], opts?: { reveal?: boolean }): void {
    selection.set(ids);
    if (opts?.reveal === false || disposed || clock.playing()) return;
    const id = ids[0];
    if (!id) return;
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0 || !isTimed(rows[i]!, cfg)) return;      // scenery is always on screen
    const { start, dur } = span(rows[i]!, durationSec());
    const at = clock.t() / 1000;
    if (at >= start && at < start + dur) return;
    clock.seek(start * 1000);
    announce(t('Moved the playhead to this clip'));
  }

  function applyBarGeometry(el: HTMLElement, start: number, dur: number): void {
    el.style.left = `${timeToPx(start, pxPerSec)}px`;
    el.style.width = `${Math.max(2, timeToPx(dur, pxPerSec))}px`;
  }

  // ── rows ────────────────────────────────────────────────────────────────────

  function makeBar(id: string, lane: '' | 'seq'): HTMLElement {
    const el = document.createElement('div');
    el.className = `tl-clip${lane === 'seq' ? ' tl-clip-seq' : ''}`;
    el.dataset.id = id;
    el.dataset.lane = lane;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.tabIndex = -1;
    const cv = document.createElement('canvas');
    cv.className = 'tl-clip-thumbs';
    cv.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'tl-clip-label';
    const inEdge = document.createElement('span');
    inEdge.className = 'tl-edge tl-edge-in';
    inEdge.dataset.edge = 'in';
    const outEdge = document.createElement('span');
    outEdge.className = 'tl-edge tl-edge-out';
    outEdge.dataset.edge = 'out';
    el.append(cv, label, inEdge, outEdge);
    return el;
  }

  /** Full row rebuild — only when `tracksKey` changed. */
  function rebuild(boxes: Box[]): void {
    const scrollLeft = tracks.scrollLeft;
    // Every bar is about to be destroyed. If one of them had focus, the browser sends
    // focus to <body> — and since the key handler is bound on `root`, that kills the
    // keyboard for the rest of the session (delete a clip, then no shortcut works).
    // Remember it and restore focus onto the new roving bar below.
    const hadFocus = root.contains(document.activeElement) && !!(document.activeElement as HTMLElement | null)?.closest('.tl-clip');
    bars.clear();
    chips.clear();
    laneWrap.textContent = '';
    scenery.textContent = '';

    const total = durationSec();
    const seq = seqBoxes(boxes, cfg);
    const seqIds = new Set(seq.map((b) => String(b[cfg.idField] ?? '')));

    // Overlay lanes first (one row each), then the magnetic seq row.
    for (const b of boxes) {
      if (!b) continue;
      const id = b[cfg.idField];
      if (id == null || id === '') continue;
      const timing = boxTiming(b, cfg);
      if (timing.lane === 'seq' || timing.start === null) continue;
      const lane = document.createElement('div');
      lane.className = 'tl-lane';
      // Presentational: a listbox may only own options, and these rows are pure
      // layout. Flattening them keeps every `role="option"` bar owned by the listbox.
      lane.setAttribute('role', 'presentation');
      lane.dataset.lane = 'overlay';
      const el = makeBar(String(id), '');
      bars.set(String(id), el);
      lane.appendChild(el);
      laneWrap.appendChild(lane);
    }

    const seqLane = document.createElement('div');
    seqLane.className = 'tl-lane tl-lane-seq';
    seqLane.setAttribute('role', 'presentation');
    seqLane.dataset.lane = 'seq';
    if (!seq.length) {
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'tl-dropslot';
      slot.textContent = t('Add a clip');
      // Pointer affordance only — a button is not a legal child of a listbox. The
      // keyboard/AT route to the same thing is the canvas rail's add-clip control.
      slot.setAttribute('aria-hidden', 'true');
      slot.tabIndex = -1;
      // free-canvas owns the add-kind pipeline; ask for a clip rather than reaching in.
      // This used to dispatch its own `tl-add-clip`; it now goes through the SAME
      // `tl-add` seam the `+` menu uses, so there is one event and one listener.
      slot.addEventListener('click', () => emitAdd('clip'));
      seqLane.appendChild(slot);
    }
    for (const b of seq) {
      const id = String(b[cfg.idField] ?? '');
      if (!id) continue;
      const el = makeBar(id, 'seq');
      bars.set(id, el);
      seqLane.appendChild(el);
    }
    // Seam chips between adjacent seq clips (the junction affordance).
    for (let i = 0; i < seq.length - 1; i++) {
      const aId = String(seq[i]![cfg.idField] ?? '');
      const bId = String(seq[i + 1]![cfg.idField] ?? '');
      if (!aId || !bId) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tl-seam';
      chip.dataset.a = aId;
      chip.dataset.b = bId;
      // Pointer affordance only (see .tl-dropslot): the same transition is authored
      // from the inspector's Animate in / Animate out fields, which ARE in the tab order.
      chip.setAttribute('aria-hidden', 'true');
      chip.tabIndex = -1;
      chip.setAttribute('data-tip', t('Transition between clips'));
      seqLane.appendChild(chip);
    }
    laneWrap.appendChild(seqLane);

    // Scenery: everything untimed, as a collapsed strip of chips.
    const untimed = boxes.filter((b) => b && !isTimed(b, cfg));
    if (untimed.length) {
      const label = document.createElement('span');
      label.className = 'tl-scenery-label';
      label.textContent = t('Always on');
      scenery.appendChild(label);
      for (const b of untimed) {
        const id = String(b![cfg.idField] ?? '');
        if (!id) continue;
        // A pill of TWO buttons rather than one: the label selects (which now opens a
        // real inspector), and the `+` promotes the box onto an overlay lane. A button
        // inside a button is not legal HTML, hence the wrapper — the pill's border and
        // background live on the group so the two halves read as one control.
        const group = document.createElement('span');
        group.className = 'tl-chip-group';
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tl-chip';
        chip.dataset.id = id;
        chip.textContent = labelFor(id);
        // The chip IS the selection state for a box with no bar, so it says so.
        chip.setAttribute('aria-pressed', 'false');
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'tl-chip-add';
        add.dataset.id = id;
        add.innerHTML = icon('plus');
        const addLabel = t('Add to the timeline');
        add.setAttribute('aria-label', `${addLabel}: ${labelFor(id)}`);
        // `title`, not [data-tip]: the bubble primitive is a ::after drawn ABOVE the
        // button, and this one lives inside the .tl-tracks scroller, which clips. A
        // native tooltip is browser-drawn and cannot be sliced by an ancestor.
        add.title = addLabel;
        group.append(chip, add);
        chips.set(id, chip);
        scenery.appendChild(group);
      }
    }
    scenery.hidden = !untimed.length;

    restyle(boxes, total, seqIds);
    tracks.scrollLeft = scrollLeft;
    // restyle → updateRovingTabindex has just picked the surviving focus target.
    if (hadFocus) (bars.get(focusedId) ?? root).focus?.();
  }

  /** Cheap pass: geometry, labels, selection state. No node churn. */
  function restyle(boxes: Box[], total = durationSec(), seqIds?: Set<string>): void {
    const sel = new Set(selection.get());
    const seqSet = seqIds ?? new Set(seqBoxes(boxes, cfg).map((b) => String(b[cfg.idField] ?? '')));
    for (const b of boxes) {
      if (!b) continue;
      const id = String(b[cfg.idField] ?? '');
      const el = id ? bars.get(id) : null;
      if (!el) continue;
      const { start, dur } = span(b, total);
      applyBarGeometry(el, start, dur);
      // labelFor and mediaOf each walk the canvas; call them ONCE per box per pass.
      const text = labelFor(id);
      const label = el.querySelector<HTMLElement>('.tl-clip-label');
      if (label && label.textContent !== text) label.textContent = text;
      const timing = boxTiming(b, cfg);
      const isSel = sel.has(id);
      el.classList.toggle('is-selected', isSel);
      const muted = b[cfg.muteField] === true || b[cfg.muteField] === 'true';
      el.classList.toggle('is-muted', muted);
      // A/V link. The muted side is the picture (its sound is elsewhere); the other side
      // is the sound itself. The `is-muted` hatch already reads as "silenced" on the
      // video, so this adds the one thing the hatch cannot say: WHERE the sound went.
      const linked = !!cfg.linkField && !!b[cfg.linkField!];
      el.classList.toggle('is-linked', linked);
      let linkEl = el.querySelector<HTMLElement>('.tl-clip-link');
      if (linked && !linkEl) {
        linkEl = document.createElement('span');
        linkEl.className = 'tl-clip-link';
        linkEl.innerHTML = icon('link');
        el.appendChild(linkEl);
      }
      if (linkEl) {
        linkEl.hidden = !linked;
        const tip = muted ? t('Sound is on its own lane') : t('Sound detached from this clip');
        if (linkEl.title !== tip) linkEl.title = tip;
      }
      el.setAttribute('aria-selected', isSel ? 'true' : 'false');
      el.dataset.kind = mediaOf(id).kind || (seqSet.has(id) ? 'clip' : 'overlay');
      // Too narrow to carry two trim zones (see MIN_TRIM_BAR_PX): hide the grips and
      // say where the precise route is, rather than offering a target that would eat
      // the whole bar. Read off the width we just WROTE — asking the DOM for
      // offsetWidth here would force a layout per bar per keystroke.
      const tight = timeToPx(dur, pxPerSec) < MIN_TRIM_BAR_PX;
      el.classList.toggle('is-tight', tight);
      const base = `${text} · ${fmtTime(start)} → ${fmtTime(start + dur)}`;
      el.title = tight
        ? `${base} · ${t('This clip is too narrow to trim here. Zoom in, or set its Length in the panel.')}`
        : base;
      if (timing.speed !== 1) el.dataset.speed = String(timing.speed);
      else delete el.dataset.speed;
    }
    // Scenery chips carry the same selected state a bar does — otherwise selecting an
    // untimed box changes the inspector with nothing on screen to say which box it is.
    for (const [id, chip] of chips) {
      const isSel = sel.has(id);
      chip.classList.toggle('is-selected', isSel);
      chip.setAttribute('aria-pressed', isSel ? 'true' : 'false');
    }
    // Seam chips ride the clip edges.
    for (const chip of Array.from(laneWrap.querySelectorAll<HTMLElement>('.tl-seam'))) {
      const bId = chip.dataset.b || '';
      const i = indexOfId(boxes, cfg, bId);
      const timing = i >= 0 ? boxTiming(boxes[i]!, cfg) : null;
      const at = timing?.start ?? 0;
      chip.style.left = `${timeToPx(at, pxPerSec)}px`;
      const a = indexOfId(boxes, cfg, chip.dataset.a || '');
      const aBox = a >= 0 ? boxes[a]! : null;
      const faded = Boolean(aBox && isTransitionKind(aBox[cfg.exitField]) && aBox[cfg.exitField] !== 'none')
        || Boolean(i >= 0 && isTransitionKind(boxes[i]![cfg.enterField]) && boxes[i]![cfg.enterField] !== 'none');
      chip.classList.toggle('is-fade', faded);
      // THROUGH EDIT — a cut whose two sides are still contiguous, i.e. a split nobody
      // has committed to yet. Final Cut's hairline marker, and the single mechanism in
      // the whole survey that makes cutting non-frightening: you can see at a glance
      // which seams are decisions and which are just "I cut here and changed nothing".
      // Computed HERE rather than in rebuild's seam pass, because contiguity dies to a
      // trim or a transition edit, neither of which changes tracksKey.
      // The MARK is the whole affordance, exactly as Final Cut does it — the tip still
      // says what clicking does (open the junction), because that is still what it does;
      // the junction dialog is where the Join action appears.
      chip.classList.toggle('is-through', isThroughEdit(boxes, cfg, chip.dataset.a || '', bId, sameSource));
    }
    inner.style.width = `${Math.max(tracks.clientWidth, timeToPx(total, pxPerSec) + 24)}px`;
    // A rebuild mints fresh bars, so the keyboard's armed edge has to be re-painted or
    // it silently disarms visually while still being armed in state.
    paintFocusedEdge();
    updateRuler(total);
    updateRovingTabindex();
    renderInspector(boxes);
    // The mic's label follows the selection (record vs record-over), so it repaints
    // with everything else rather than needing its own observer.
    syncMicBtn();
  }

  let rulerKey = '\u0000';
  function updateRuler(total = durationSec()): void {
    const step = tickStep(pxPerSec);
    ruler.setAttribute('aria-valuemax', String(Math.round(total * 10) / 10));
    setRulerNow(clock.t());
    // The tick strip only depends on these three. restyle() runs on every sidebar
    // keystroke, every selection change and every ResizeObserver callback, and
    // rebuilding ~600 elements per keystroke at MAX_PPS is what "cheap pass" is not.
    const key = `${step}|${Math.round(total * 1000)}|${Math.round(pxPerSec * 1000)}`;
    if (key === rulerKey) return;
    rulerKey = key;
    rulerInner.textContent = '';
    rulerInner.style.width = `${Math.max(0, timeToPx(total, pxPerSec) + 24)}px`;
    for (let s = 0; s <= total + step; s += step) {
      const tick = document.createElement('span');
      tick.className = 'tl-tick';
      tick.style.left = `${timeToPx(s, pxPerSec)}px`;
      const lab = document.createElement('span');
      lab.className = 'tl-tick-label';
      lab.textContent = fmtTime(s);
      tick.appendChild(lab);
      rulerInner.appendChild(tick);
    }
  }

  /**
   * The slider's value, written only when the announced tenth actually changes: the
   * ruler is focusable, and rewriting aria-valuenow/valuetext on every clock tick
   * makes a screen reader announce continuously through playback.
   */
  let rulerNow = Number.NaN;
  function setRulerNow(tMs: number): void {
    const tenth = Math.round((tMs / 1000) * 10) / 10;
    if (tenth === rulerNow) return;
    rulerNow = tenth;
    ruler.setAttribute('aria-valuenow', String(tenth));
    ruler.setAttribute('aria-valuetext', fmtTime(tMs / 1000));
  }

  function updatePlayhead(tMs: number): void {
    // Read first, write after: reading scrollLeft between style writes forces a
    // synchronous layout on every one of the 60 ticks a second.
    const scrollLeft = tracks.scrollLeft;
    const x = timeToPx(tMs / 1000, pxPerSec);
    playhead.style.left = `${x}px`;
    timeEl.textContent = `${fmtTime(tMs / 1000)} / ${fmtTime(durationSec())}`;
    setRulerNow(tMs);
    rulerInner.style.transform = `translateX(${-scrollLeft}px)`;
  }

  function updateRovingTabindex(): void {
    const list = Array.from(bars.values());
    if (!list.length) return;
    if (!focusedId || !bars.has(focusedId)) {
      const sel = selection.get().find((id) => bars.has(id));
      focusedId = sel || String(list[0]!.dataset.id || '');
    }
    for (const el of list) el.tabIndex = el.dataset.id === focusedId ? 0 : -1;
  }

  // ── promotion / demotion (scenery ⇄ timed) ──────────────────────────────────

  /**
   * Give an UNTIMED box (scenery: no lane, no start — what the `text` / `image` /
   * `lottie` / `tool` add-kinds seed) a place on the timeline, in ONE commit.
   *
   * The defaults, spelled out because they are a product decision, not arithmetic:
   *   • START, when the caller does not name one, is the PLAYHEAD. "Put it where I am
   *     looking" is the mental model the rest of the panel already teaches (split and
   *     seek both work off the playhead), and it is the only anchor that is on screen.
   *   • LENGTH, when the caller does not name one, is the box's OWN authored duration
   *     first (a `card` add-kind seeds 2.5 s; clobbering it would make a card promoted
   *     here disagree with the identical card added from the rail), then its media
   *     duration when the live canvas knows it (a video or audio box plays in full),
   *     else DEFAULT_CLIP_S — the same 3 s the magnetic pack hands a clip it cannot
   *     measure, so a promoted box and a packed one never disagree.
   *   • `dur: null`, passed EXPLICITLY, means "author no length at all". That is the
   *     free-canvas create path: it promotes a box born milliseconds ago, before its
   *     asset picker has even opened, so mediaOf() cannot know a length yet and
   *     freezing DEFAULT_CLIP_S in would pin a 45 s audio track to 3 s and destroy the
   *     seq row's derive-from-media rule permanently. Left unauthored, packSeq fills a
   *     seq clip from its media later and an overlay stays open-ended to the sequence
   *     end — exactly what the same box added from the CANVAS already does.
   *   • The box lands on an OVERLAY lane, never on the magnetic seq row: seq membership
   *     is a separate, deliberate choice (it repacks the whole row), and silently
   *     joining the spine because someone typed a start would move other clips.
   *
   * NO clamping arithmetic lives here. `moveOverlay` owns the start clamp and the
   * millisecond grid; `setDuration` owns the length clamp and the media fit. Both are
   * pure, so composing them on the intermediate array is ONE undo step, not two — and
   * a promoted start lands on exactly the value a drag to the same time would.
   */
  function promote(id: string, want?: { start?: number; dur?: number | null }): void {
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (!id || i < 0) return;
    const media = mediaOf(id).dur;
    const start = want?.start ?? clock.t() / 1000;
    const own = boxTiming(rows[i]!, cfg).dur;
    const dur = want && 'dur' in want ? want.dur : (own ?? media ?? DEFAULT_CLIP_S);
    const moved = moveOverlay(rows, cfg, id, start);
    const next = dur == null ? moved : setDuration(moved, cfg, id, dur, media, mediaDur);
    // Both writers keep row IDENTITY for every row they did not change, so an
    // all-identical array means this promote had nothing to write — a seq-lane clip,
    // whose start the magnetic spine owns and whose length is derived. Skip the commit
    // rather than spend an undo step on a no-op.
    if (next.some((b, k) => b !== rows[k])) write(next);
    focusedId = id;
    selectAndReveal([id]);
    announce(t('Added to the timeline'));
  }

  /**
   * The reverse: take a timed box back to scenery ("always on"), in ONE commit, so that
   * state stays reachable instead of being a one-way trap.
   *
   * `start: ''` — not 0 — is what makes it scenery: boxTiming reads an authored 0 as
   * "enters at the top of the sequence" and only an EMPTY field as untimed. This is a
   * VALUE write, which is exactly what patchBox is for.
   */
  function demote(id: string): void {
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0) return;
    const wasSeq = boxTiming(rows[i]!, cfg).lane === 'seq';
    const cleared = patchBox(rows, id, {
      [cfg.startField]: '', [cfg.durField]: '', [cfg.laneField]: '',
    });
    // Pulling a clip off the magnetic row leaves a hole. Close it the way a delete
    // does — same pack, same overlay ripple — inside the same commit.
    write(wasSeq ? rippleOverlays(rows, packSeq(cleared, cfg, mediaDur), cfg) : cleared);
    focusedId = '';
    selectAndReveal([id]);
    announce(t('Now always on'));
  }

  // ── menus: the `+` add menu and the bar/chip context menu ───────────────────
  //
  // Both are mountBodyPopover instances (components/body-popover.ts) rather than a
  // bespoke menu: that shell already owns Escape, outside-pointerdown dismissal, the
  // focus trap, aria-expanded upkeep and teardown on a route change. The panel is
  // docked at the BOTTOM of the stage, so the placement below flips the menu upwards
  // when there is no room under the anchor.

  /** Kind id → a registry glyph. A Map, never an object, so no prototype key can hit. */
  const KIND_ICON = new Map<string, IconName>([
    ['clip', 'filmStrip'], ['video', 'filmStrip'], ['audio', 'music'], ['image', 'image'],
    ['text', 'font'], ['card', 'box'], ['box', 'box'], ['lottie', 'sparkle'], ['tool', 'tool'],
  ]);

  function menuPosition(el: HTMLDivElement, anchor: PopoverAnchor): void {
    const r = anchor.getBoundingClientRect();
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    // Align to the anchor's NEAR edge — left under ltr, right under rtl (body-popover's
    // own default is right-aligned for the same reason). Aligning to `left` in Arabic
    // opens the menu away from the button that spawned it.
    const rtl = document.documentElement.dir === 'rtl';
    const near = rtl ? r.right - pw : r.left;
    const left = Math.max(8, Math.min(near, vw - pw - 12));
    const top = r.bottom + 6 + ph > vh - 8 ? Math.max(8, r.top - ph - 6) : r.bottom + 6;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  /**
   * One menu row. Same markup + classes as the projects/folder menus, so no new CSS —
   * except `sub`, a second line in the plainer register for an action whose NAME cannot
   * carry its meaning ("Detach audio" says what, not what for). The two lines live in
   * one column so the icon still centres against the pair.
   */
  function menuItem(
    label: string, glyph: IconName, run: () => void,
    opts?: { danger?: boolean; sub?: string },
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `folder-menu-item${opts?.danger ? ' folder-menu-item--danger' : ''}${opts?.sub ? ' tl-menu-item--sub' : ''}`;
    b.setAttribute('role', 'menuitem');
    b.innerHTML = icon(glyph);
    const span = document.createElement('span');
    span.className = 'tl-menu-label';
    span.textContent = label;   // textContent, so a manifest label can never inject markup
    b.appendChild(span);
    if (opts?.sub) {
      const wrap = document.createElement('span');
      wrap.className = 'tl-menu-stack';
      const sub = document.createElement('span');
      sub.className = 'tl-menu-sub';
      sub.textContent = opts.sub;
      b.replaceChild(wrap, span);
      wrap.append(span, sub);
    }
    b.addEventListener('click', run);
    return b;
  }

  /**
   * The cross-module seam (see the panel's contract with free-canvas): the panel never
   * creates a box itself — it names an add-kind and the time it wants, and free-canvas's
   * create pipeline does the rest. `atMs` is the PLAYHEAD, because a box added from the
   * timeline must land timed where the user is looking, which is the opposite default
   * from the canvas `+` (that one makes scenery).
   */
  function emitAdd(kind: string): void {
    const detail: TimelineAddDetail = { kind, atMs: clock.t() };
    root.dispatchEvent(new CustomEvent('tl-add', { bubbles: true, detail }));
  }

  const addMenu = mountBodyPopover(addBtn, (el, pop) => {
    el.textContent = '';
    let first: HTMLElement | null = null;
    for (const k of addKinds) {
      // The label is the MANIFEST's, exactly as the canvas add-menu shows it — the
      // panel must not second-guess a tool's own vocabulary or hardcode the list.
      const item = menuItem(k.label || k.id, KIND_ICON.get(k.id) ?? 'plus', () => {
        pop.close();
        emitAdd(k.id);
      });
      el.appendChild(item);
      first = first ?? item;
    }
    return first;
  }, { className: 'folder-menu tl-menu', ariaLabel: t('Add to the timeline'), position: menuPosition });

  // ── the bar / chip context menu ─────────────────────────────────────────────

  /** A virtual anchor at the right-click point; `delegate` carries the keyboard route. */
  const ctxPoint = pointAnchor();
  let ctxId = '';

  const ctxMenu = mountBodyPopover(ctxPoint, (el, pop) => {
    const rows = getBoxes();
    const i = ctxId ? indexOfId(rows, cfg, ctxId) : -1;
    if (i < 0) {
      // mountBodyPopover appends, positions and focus-traps whatever this render leaves
      // behind — a null return only means "don't move focus", not "don't open". Bail out
      // of the open itself, or a box that vanished between openCtxMenu's check and here
      // paints an empty, focus-trapped card. Unreachable today (openCtxMenu re-checks in
      // the same tick); one microtask is the cheap insurance against that ever deferring.
      queueMicrotask(() => pop.close());
      return null;
    }
    const timed = isTimed(rows[i]!, cfg);
    el.textContent = '';
    const act = (fn: () => void) => () => { pop.close(); fn(); };
    if (timed) {
      // Exactly the writers that already exist — the context menu is a second DOOR onto
      // them, never a second implementation (see promote/demote above).
      el.appendChild(menuItem(t('Split at playhead'), 'scissors', act(() => { selectAndReveal([ctxId]); splitAtPlayhead(); })));
      // Join is offered only where it is REAL: a cut whose two sides are still perfectly
      // contiguous, on either side of this clip. Everywhere else the item is absent
      // rather than disabled — a menu of greyed-out rows teaches nothing.
      const join = throughNeighbour(ctxId, rows);
      if (join) el.appendChild(menuItem(t('Join clips'), 'link', act(() => joinAt(join.aId, join.bId))));
      const partner = partnerOf(ctxId, rows);
      if (partner) {
        el.appendChild(menuItem(t('Re-attach audio'), 'volumeOn', act(() => reattachAudioAt(ctxId)),
          { sub: t('Puts the sound back on the clip it came from.') }));
      } else if (canDetach(ctxId)) {
        el.appendChild(menuItem(t('Detach audio'), 'volumeOff', act(() => detachAudioAt(ctxId)),
          { sub: t('Puts the sound on its own lane so you can move and trim it separately.') }));
      }
      el.appendChild(menuItem(t('Make always on'), 'layers', act(() => demote(ctxId))));
    } else {
      el.appendChild(menuItem(t('Add to the timeline'), 'plus', act(() => promote(ctxId))));
    }
    el.appendChild(menuItem(t('Delete'), 'trash', act(() => deleteBox(ctxId)), { danger: true }));
    return el.querySelector<HTMLElement>('.folder-menu-item');
  }, { className: 'folder-menu tl-menu tl-ctx-menu', ariaLabel: t('Clip actions'), position: menuPosition });

  /**
   * Open the context menu on one box. Right-click SELECTS first (free-canvas's
   * contextMenuAt does the same), so whatever the menu acts on is also what the
   * inspector and the canvas chrome are showing.
   *
   * The selection COLLAPSES to the clicked box, even when it was already part of a
   * multi-selection: every item in this menu is per-box and acts on `ctxId` alone, so
   * leaving three bars painted as selected while "Make always on" demotes one of them
   * shows the user a state that never existed — and the next act is an undo of
   * something they did not think they did. Free-canvas's sibling menu resolves the
   * same tension the other way (it disables per-box items on a multi-selection); here
   * collapsing is better, because the box under the pointer is unambiguous.
   */
  function openCtxMenu(id: string, x: number, y: number, delegate: HTMLElement | null): void {
    if (!id || indexOfId(getBoxes(), cfg, id) < 0) return;
    ctxId = id;
    const sel = selection.get();
    if (sel.length !== 1 || sel[0] !== id) selectAndReveal([id]);
    if (bars.has(id)) { focusedId = id; updateRovingTabindex(); }
    ctxPoint.x = x;
    ctxPoint.y = y;
    ctxPoint.delegate = delegate;
    ctxMenu.close();
    ctxMenu.open();
  }

  function onContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    const el = target?.closest<HTMLElement>('.tl-clip, .tl-chip, .tl-chip-add');
    const id = el?.dataset.id || '';
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    openCtxMenu(id, e.clientX, e.clientY, null);
  }

  /** The keyboard route (Menu key / Shift+F10) — a pointer-only menu is not reachable. */
  function openCtxForFocused(): void {
    const active = document.activeElement as HTMLElement | null;
    const el = (root.contains(active) ? active?.closest<HTMLElement>('.tl-clip, .tl-chip') : null)
      || bars.get(focusedId)
      || null;
    const id = el?.dataset.id || '';
    if (!el || !id) return;
    const r = el.getBoundingClientRect();
    openCtxMenu(id, r.left, r.bottom, el);
  }

  // ── the selected-clip inspector (precision + a11y fallback for every gesture) ──

  let inspectorKey = '\u0000';

  function renderInspector(boxes: Box[]): void {
    // Bars AND chips: an untimed box has no bar, and gating on `bars` alone is what
    // made "always on" a dead end — selecting a scenery chip rendered an empty bar and
    // there was no field anywhere in the UI that could give the box a time.
    const ids = selection.get().filter((id) => bars.has(id) || chips.has(id));
    const id = ids.length === 1 ? ids[0]! : '';
    const i = id ? indexOfId(boxes, cfg, id) : -1;
    const box = i >= 0 ? boxes[i]! : null;
    const key = box ? `${id}|${JSON.stringify([box[cfg.startField], box[cfg.durField], box[cfg.clipInField], box[cfg.speedField], box[cfg.enterField], box[cfg.exitField], box[cfg.enterMsField], box[cfg.exitMsField], box[cfg.muteField]])}` : '';
    if (key === inspectorKey) return;
    inspectorKey = key;
    inspector.textContent = '';
    if (!box) return;
    const timing = boxTiming(box, cfg);

    const row = (labelText: string, control: HTMLElement): HTMLElement => {
      const wrap = document.createElement('label');
      wrap.className = 'field-row field-row--inline tl-field';
      const lab = document.createElement('span');
      lab.className = 'field-label';
      lab.textContent = labelText;
      wrap.append(lab, control);
      return wrap;
    };
    /**
     * A numeric field. `value === null` means UNAUTHORED — the field renders empty with
     * a placeholder rather than a misleading 0 (an untimed box does not start at zero,
     * it has no start at all), and an empty field that is left empty commits nothing.
     */
    const numField = (
      value: number | null, step: number, min: number, onCommit: (v: number) => void, placeholder?: string,
    ): HTMLInputElement => {
      const el = document.createElement('input');
      el.className = 'field-input tl-num';
      el.type = 'number';
      el.step = String(step);
      el.min = String(min);
      el.max = String(MAX_TIME_S);
      if (value === null) {
        el.value = '';
        if (placeholder) el.placeholder = placeholder;
      } else {
        el.value = String(Math.round(value * 1000) / 1000);
      }
      el.addEventListener('change', () => {
        const raw = el.value.trim();
        if (value === null && raw === '') return;   // nothing typed, nothing to promote
        onCommit(finite(raw, value ?? 0));
      });
      return el;
    };
    const kindSelect = (value: unknown, onCommit: (v: string) => void): HTMLSelectElement => {
      const el = document.createElement('select');
      el.className = 'field-select tl-select';
      for (const k of TRANSITION_KINDS) {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = t(TRANSITIONS[k]);
        el.appendChild(o);
      }
      el.value = isTransitionKind(value) ? value : 'none';
      el.addEventListener('change', () => onCommit(el.value));
      return el;
    };

    const timed = isTimed(box, cfg);

    if (!timed) {
      // ── UNTIMED (scenery) ───────────────────────────────────────────────────
      // Start and Length are the promotion route: this is the ONLY place in the UI a
      // text/image/lottie/tool box could ever be given a time without hand-editing the
      // ?boxes= URL. Both render EMPTY — a 0 would claim the box starts at the top of
      // the sequence, which is a different (and authored) state.
      const hint = t('Type a time to place this on the timeline');
      const untimedStart = numField(null, 0.1, 0, (v) => promote(id, { start: v }), '—');
      untimedStart.title = hint;
      inspector.appendChild(row(t('Start'), untimedStart));
      const untimedLen = numField(null, 0.1, MIN_DUR, (v) => promote(id, { dur: v }), '—');
      untimedLen.title = hint;
      inspector.appendChild(row(t('Length'), untimedLen));
    } else {
      // ── TIMED ───────────────────────────────────────────────────────────────
      // Numeric start / duration / trim-in.
      //
      // A seq clip's start is DERIVED by the pack (reorder it to move it), so the field is
      // disabled rather than writable-but-ignored: the old shape committed the unchanged
      // array, which dirtied the session and pushed an empty step onto the undo stack.
      const startField = numField(timing.start ?? 0, 0.1, 0, (v) => {
        write(moveOverlay(getBoxes(), cfg, id, v));
      });
      if (timing.lane === 'seq') {
        startField.disabled = true;
        startField.title = t('Set by the clip order. Drag the clip along the sequence row to move it.');
      }
      inspector.appendChild(row(t('Start'), startField));
      // Length is ABSOLUTE (`setDuration`), seeded from the span the bar actually shows.
      // The old shape seeded from `timing.dur ?? 0` and committed a DELTA against it,
      // so on an open-ended clip — which displays as `total - start` and read 0 — typing
      // 5 landed on trimClip's own 3 s fallback + 5 = 8 s.
      inspector.appendChild(row(t('Length'), numField(span(box, durationSec()).dur, 0.1, MIN_DUR, (v) => {
        write(setDuration(getBoxes(), cfg, id, v, mediaOf(id).dur, mediaDur));
      })));
      // Trim in and Speed go through the clamped setters, NOT patchBox: a raw write puts
      // clipIn + dur x speed past the end of the source, which the player cannot recover
      // from (it seeks past duration and the bar plays nothing).
      inspector.appendChild(row(t('Trim in'), numField(timing.clipIn, 0.1, 0, (v) => {
        write(setClipIn(getBoxes(), cfg, id, v, mediaOf(id).dur, mediaDur));
      })));

      // Speed.
      const speed = document.createElement('select');
      speed.className = 'field-select tl-select';
      for (const v of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]) {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = `×${v}`;
        speed.appendChild(o);
      }
      speed.value = String(timing.speed);
      speed.addEventListener('change', () => write(setSpeed(getBoxes(), cfg, id, finite(speed.value, 1), mediaOf(id).dur, mediaDur)));
      inspector.appendChild(row(t('Speed'), speed));
    }

    // Enter / exit + their durations. Authorable either side of the timed line: a box
    // that is always on can still be given the transition it will use once it is timed,
    // and the fields are plain value writes, so nothing here depends on a bar existing.
    inspector.appendChild(row(t('Animate in'), kindSelect(box[cfg.enterField], (v) => write(patchBox(getBoxes(), id, { [cfg.enterField]: v })))));
    inspector.appendChild(row(t('In (ms)'), numField(finite(box[cfg.enterMsField], 400), 50, 100, (v) => write(patchBox(getBoxes(), id, { [cfg.enterMsField]: Math.round(clamp(v, MIN_TRANSITION_MS, MAX_TRANSITION_MS)) })))));
    inspector.appendChild(row(t('Animate out'), kindSelect(box[cfg.exitField], (v) => write(patchBox(getBoxes(), id, { [cfg.exitField]: v })))));
    inspector.appendChild(row(t('Out (ms)'), numField(finite(box[cfg.exitMsField], 400), 50, 100, (v) => write(patchBox(getBoxes(), id, { [cfg.exitMsField]: Math.round(clamp(v, MIN_TRANSITION_MS, MAX_TRANSITION_MS)) })))));

    // Mute — a playback concern, so only on something that plays.
    if (timed) {
      const muted = box[cfg.muteField] === true || box[cfg.muteField] === 'true';
      const mute = btn('tl-mute', muted ? t('Unmute clip') : t('Mute clip'), icon(muted ? 'volumeOff' : 'volumeOn'));
      mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
      mute.addEventListener('click', () => write(patchBox(getBoxes(), id, { [cfg.muteField]: muted ? '' : 'true' })));
      inspector.appendChild(mute);
    }

    // The timed ⇄ always-on switch. Both directions, always, from the keyboard as well
    // as the pointer: this is the affordance that makes "always on" a state rather than
    // a trap, and the promotion route for anyone who would rather press than type.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tl-timing';
    const toggleLabel = timed ? t('Make always on') : t('Add to the timeline');
    toggle.textContent = toggleLabel;
    // `title` for the same reason as the chip's `+`: .tl-inspector is an overflow
    // scroller, so a [data-tip] bubble drawn above the control would be clipped.
    toggle.title = timed
      ? t('Clear the timing so this box is on screen for the whole sequence')
      : t('Place this box on the timeline at the playhead');
    toggle.addEventListener('click', () => (timed ? demote(id) : promote(id)));
    inspector.appendChild(toggle);
  }

  // ── thumbnails (cache-owned bitmaps: draw synchronously, never retain) ───────

  /** Everything one bar's paint needs, gathered in the read pass. */
  interface ThumbJob {
    id: string;
    el: HTMLElement;
    w: number;
    h: number;
    /** Device-pixel ratio, read ONCE per pass rather than once per bar. */
    dpr: number;
    media: BoxMedia;
    /** The bar's resolved foreground colour — canvas 2D silently ignores currentColor. */
    ink: string;
    /** The BOX's own computed background, for the no-media fallback. */
    fill: string;
    /**
     * The live `.lolly-box`, and its model row. Both resolved HERE, in the read pass:
     * `paintThumbs` used to re-scan `getBoxes()` with `indexOfId` per bar, which is
     * O(bars × boxes) and — now that node mode needs the row for its cache key too —
     * would have been paid twice.
     */
    box: HTMLElement | null;
    row: Box | null;
    /** Appearance identity for a node raster. Empty when the bar cannot take one. */
    sig: string;
    /** May this bar photograph its box at all (subtree size, and is there any ink)? */
    canRaster: boolean;
    /** May it do so THIS pass, or has the per-pass shot budget already gone? */
    allowRaster: boolean;
  }

  function scheduleThumbs(): void {
    cancelIdle?.();
    cancelIdle = null;
    abortThumbs();
    if (!open || disposed) return;
    const ac = new AbortController();
    thumbAbort = ac;
    queueThumbPass(ac, 0);
  }

  /**
   * One idle pass, and — when it left work behind — the next.
   *
   * The continuation reuses the SAME AbortController rather than going back through
   * `scheduleThumbs`, which would abort the shots this pass has just started. Every
   * external abort still kills the chain dead: the queued callback checks the signal,
   * and `scheduleThumbs`/`destroy` cancel the pending idle handle outright.
   */
  function queueThumbPass(ac: AbortController, pass: number): void {
    cancelIdle = onIdle(() => {
      cancelIdle = null;
      if (ac.signal.aborted || disposed) return;
      // READ every bar first, THEN paint — one style/layout pass for the whole panel.
      // Interleaving clientWidth/getComputedStyle reads with canvas size writes forces
      // a synchronous layout PER BAR, which is what this two-phase shape exists to stop.
      // getComputedStyle joined the read phase when the card fallback landed: it is the
      // most expensive read here, so it must not be the one call left inside the paint.
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle : null;
      const dpr = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1));
      // The model rows, indexed ONCE. Also the two environment terms a node raster's
      // signature needs beyond the row: the theme stamp (a theme flip repaints every
      // box without touching a single field) is one attribute read for the whole pass,
      // and the box's own computed background is already being read per bar below.
      const rowsById = new Map<string, Box>();
      for (const b of getBoxes()) {
        const rid = b?.[cfg.idField];
        if (rid != null && rid !== '') rowsById.set(String(rid), b);
      }
      const themeStamp = document.documentElement?.getAttribute('data-theme') ?? '';

      const jobs: ThumbJob[] = [];
      for (const [id, el] of bars) {
        const box = boxEl(id);
        const media = mediaOf(id);
        const fill = (box && cs ? cs(box).backgroundColor : '') || '';
        // Only a box with NO media is a candidate: an <img>/<video>/Lottie/audio box
        // has a real picture to decode, which is both cheaper and more faithful than
        // a photograph of the tag holding it. Skipping the predicate here also keeps
        // its querySelectorAll off every media bar.
        const canRaster = !media.kind && canRasterBox(box, fill);
        const row = rowsById.get(id) ?? null;
        jobs.push({
          id,
          el,
          w: el.clientWidth,
          h: el.clientHeight,
          dpr,
          media,
          ink: (cs ? cs(el).color : '') || '#888',
          fill,
          box,
          row,
          sig: canRaster ? `${appearanceSig(row ?? undefined, cfg)}\u0001${fill}\u0001${themeStamp}` : '',
          canRaster,
          allowRaster: false,
        });
      }

      // The hard bound. Only work that would START a shot spends the budget, in bar
      // order (document order, i.e. left to right); everything past it keeps its fill
      // underlay and is retried on the next pass rather than queueing a seventh
      // uncancellable shot behind six others. Three kinds of bar are free:
      //
      //   • a cache HIT paints synchronously out of the LRU and costs nothing;
      //   • a bar already IN FLIGHT joins the running shot (`share()` dedups it) — this
      //     is what makes the retry chain converge, because the shots are serialised and
      //     a continuation pass fires long before its predecessor's six have landed;
      //   • a bar whose shot already FAILED is retired, not retried forever.
      //
      // The `w > 8` term mirrors paintThumbs' own guard: a sliver bar paints nothing at
      // all, so granting it a shot would spend the pass's budget on an invisible bar.
      let budget = MAX_NODE_RASTERS_PER_PASS;
      let deferred = 0;
      for (const job of jobs) {
        if (!job.sig || !job.box || !(job.h > 8) || !(job.w > 8)) continue;
        const key = nodeKey(job.sig, Math.round(job.h * dpr));
        if (nodeRasterFailed(key)) continue;
        if (peekNodeRaster(key) || nodeRasterPending(key)) { job.allowRaster = true; continue; }
        if (budget > 0) { budget--; job.allowRaster = true; }
        else deferred++;
      }

      for (const job of jobs) paintThumbs(job, ac.signal);

      // A Lottie whose player has not mounted its <svg> yet is the other kind of
      // unfinished work: `captureStill` would fall back to loading the .json as an
      // <img>, which yields nothing, and no gesture is coming to re-trigger a pass.
      let pending = deferred;
      for (const job of jobs) if (job.media.kind === 'lottie' && !job.media.el) pending++;
      if (pending > 0 && pass + 1 < MAX_THUMB_PASSES) queueThumbPass(ac, pass + 1);
    }, 400);
  }

  function abortThumbs(): void {
    thumbAbort?.abort();
    thumbAbort = null;
  }

  function paintThumbs(job: ThumbJob, signal: AbortSignal): void {
    const { el, w, h, dpr, media } = job;
    const cv = el.querySelector<HTMLCanvasElement>('canvas.tl-clip-thumbs');
    if (!cv) return;
    if (!(w > 8) || !(h > 8)) return;
    const mode = thumbMode(media.kind, media.url, job.fill, job.canRaster);
    // Nothing to say about this box: leave the bar's kind tint alone rather than
    // sizing a canvas that would only be cleared.
    if (mode === 'none') return;

    // Sizing a canvas RESETS its bitmap — assigning `cv.width` clears it even when the
    // value is unchanged — so it is deferred behind whoever actually has something to
    // draw. That matters for exactly one bar: a transparent node bar (every text card,
    // every pen shape) whose raster is a cache MISS this pass. Sizing it eagerly wiped
    // the picture it was already showing and left it blank until the shot landed, so
    // zooming a long timeline made thumbnails flicker out. Nothing else changes: every
    // other branch sizes immediately, exactly as before.
    let ctx2d: CanvasRenderingContext2D | null = null;
    let sizedOnce = false;
    const sized = (): CanvasRenderingContext2D | null => {
      if (sizedOnce) return ctx2d;
      sizedOnce = true;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      ctx2d = cv.getContext('2d');
      ctx2d?.scale(dpr, dpr);
      return ctx2d;
    };

    /** One bitmap, repeated across the bar at its own aspect ratio. */
    const drawTiled = (c: CanvasRenderingContext2D, bm: ImageBitmap): void => {
      c.clearRect(0, 0, w, h);
      const tile = bm.height > 0 ? Math.max(6, (bm.width / bm.height) * h) : h;
      for (let x = 0; x < w; x += tile) c.drawImage(bm, x, 0, tile, h);
      el.classList.add('has-thumbs');
    };

    // The box's own background, flat across the bar. It is honest — it IS the colour
    // that box paints on the frame — and it costs one fillRect, which is why it is
    // also the UNDERLAY a node raster upgrades from (below).
    const paintFill = (): void => {
      const ctx = sized();
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = job.fill;
      ctx.fillRect(0, 0, w, h);
      el.classList.add('has-thumbs');
    };

    // No media, and nothing worth photographing (or a subtree too big to photograph
    // cheaply): the colour is all there is to say.
    if (mode === 'fill') {
      paintFill();
      return;
    }

    // A FRAME: a card, a text box, a pen shape, a composed group. No media element to
    // decode, so the picture is a photograph of the box itself.
    //
    // Three states, and none of them ever un-paints. The fill underlay goes down
    // SYNCHRONOUSLY, before any await, so there is no blank frame and — because the
    // upgrade overwrites the same canvas inside one synchronous `.then` body, and
    // `has-thumbs` is only ever added — no flash either. A declined, deferred, failed,
    // timed-out or aborted raster simply leaves the underlay standing.
    //
    // ONE bitmap, tiled, exactly like a still: a node-mode box cannot animate by
    // construction (any <video>/<img>/Lottie/audio child would have classified it as
    // media instead, and this tool has no box nesting — an animated neighbour is a
    // SIBLING with its own bar), so N rasters would buy N identical pictures. The trim
    // window below is skipped for the same reason: there is no time axis here.
    if (mode === 'node') {
      if (isPaintedColor(job.fill)) paintFill();
      if (!job.allowRaster || !job.box || !job.sig) return;
      nodeStill(job.sig, job.box, { h: Math.round(h * dpr) }, signal).then((frames) => {
        const bm = frames[0];
        if (signal.aborted || !bm) return;
        // OWNERSHIP CONTRACT (as below): cache-owned bitmap, drawn synchronously here
        // and never held past this callback. `sized()` is a no-op if the underlay
        // already sized the canvas, and is the FIRST touch of it when there was none.
        const ctx = sized();
        if (!ctx) return;
        drawTiled(ctx, bm);
      }).catch(() => { /* clip-thumbs never rejects; belt and braces */ });
      return;
    }

    // Every remaining mode has a picture coming, so the canvas is sized now — same
    // point in the paint as before this was a closure.
    const ctx = sized();
    if (!ctx) return;

    // The trim window, needed by both of the TIME-WINDOWED branches (a still has no
    // time axis, and a card has no media at all). It used to be computed only for the
    // filmstrip, so a waveform was drawn over the WHOLE track and stretched to fit the
    // bar: trimming an audio clip squeezed the same picture instead of showing the part
    // that plays, and the two halves of a split clip drew identical waveforms.
    const box0 = job.row;
    const timing0 = box0 ? boxTiming(box0, cfg) : null;
    const clipIn0 = timing0?.clipIn ?? 0;
    // The length must come from span(), NOT from `timing.dur ?? 0`. An OPEN-ENDED box
    // (no authored dur — which is what the default music bed is, and what any box
    // promoted with only a Start becomes) has a null dur meaning "run to the end of the
    // sequence". Defaulting that to 0 collapses the window to zero width, and
    // windowPeaks correctly answers with silence — so the waveform was still drawn, but
    // flat at the 0.02 floor: a hairline that reads as no waveform at all. span() is the
    // one place that resolves the effective length, and every other geometry read in
    // this panel already goes through it.
    const eff0 = box0 ? span(box0, durationSec()) : null;
    const out0 = clipIn0 + (eff0?.dur ?? 0) * (timing0?.speed ?? 1);

    if (mode === 'waveform') {
      const buckets = Math.max(8, Math.min(600, Math.round(w / 2)));
      peaks(media.url, buckets, signal, { fromSec: clipIn0, toSec: out0 }).then((data) => {
        if (signal.aborted || !data.length) return;
        // Synchronous draw on receipt — the array is cache-owned, never mutated or kept.
        ctx.clearRect(0, 0, w, h);
        // Canvas 2D has no `currentColor` — assigning it is silently IGNORED and the
        // waveform paints default black, invisible on a dark clip. `ink` is that cascade
        // resolved to a real colour (in the read pass), so the bars follow the theme.
        ctx.fillStyle = job.ink;
        const bw = w / data.length;
        for (let i = 0; i < data.length; i++) {
          const amp = Math.max(0.02, Math.min(1, data[i]!));
          const bh = amp * (h - 4);
          ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh);
        }
        el.classList.add('has-thumbs');
      }).catch(() => { /* clip-thumbs never rejects; belt and braces */ });
      return;
    }
    // One picture, TILED across the bar — an image, a Lottie's live frame, or a tool
    // clip's compose render. Tiled rather than stretched for the same reason the video
    // branch draws a strip: a long bar must read as a length of film, and a single
    // stretched thumbnail reads as a smear. One bitmap serves every bar width, so the
    // decode happens once per (asset, device-pixel height) and zooming re-uses it.
    if (mode === 'still') {
      stillFrames(media.url, { h: Math.round(h * dpr) }, signal, media.el).then((frames) => {
        const bm = frames[0];
        if (signal.aborted || !bm) return;
        // OWNERSHIP CONTRACT (as below): cache-owned bitmap, drawn synchronously here
        // and never held past this callback.
        drawTiled(ctx, bm);
      }).catch(() => { /* see above */ });
      return;
    }

    if (mode !== 'filmstrip') {
      // Exhaustiveness guard. Every other mode returns above, so TypeScript narrows
      // `mode` to `never` here — which makes ADDING a ThumbMode without a branch a
      // compile error instead of a bar that silently paints nothing. That is exactly
      // how a new mode would fail: quietly, on one clip kind, in a browser only.
      const unhandled: never = mode;
      void unhandled;
      return;
    }
    filmstrip(media.url, { count: frameCountFor(w), h, clipInSec: clipIn0, clipOutSec: out0 }, signal).then((frames) => {
      if (signal.aborted || !frames.length) return;
      // OWNERSHIP CONTRACT: these ImageBitmaps belong to the clip-thumbs LRU. Draw them
      // into our own canvas right here, synchronously, and drop the references — never
      // hold one across an await or a repaint, and never close() one.
      ctx.clearRect(0, 0, w, h);
      let x = 0;
      for (const bm of frames) {
        const fw = bm.height > 0 ? (bm.width / bm.height) * h : h;
        ctx.drawImage(bm, x, 0, fw, h);
        x += fw;
        if (x >= w) break;
      }
      el.classList.add('has-thumbs');
    }).catch(() => { /* see above */ });
  }

  // ── sync (runtime.subscribe → rAF-coalesced, skipped mid-gesture) ────────────

  /**
   * Every box's appearance, in one string. Changing it is what re-runs a thumb pass.
   *
   * Deliberately the same signature the raster cache is keyed on, so the two agree by
   * construction: if this string moved, at least one bar's `nodeKey` moved too and the
   * pass will retake exactly that picture (every other bar is a cache hit and free).
   * O(rows × fields) once per model change, alongside `tracksKey`'s own walk.
   */
  function appearanceKey(boxes: Box[]): string {
    const parts: string[] = [];
    for (const b of boxes) parts.push(`${b?.[cfg.idField] ?? ''}${appearanceSig(b, cfg)}`);
    return parts.join('');
  }

  function scheduleSync(): void {
    if (syncScheduled || disposed) return;
    syncScheduled = true;
    requestAnimationFrame(() => {
      syncScheduled = false;
      if (disposed) return;
      // Mid-gesture the panel owns the DOM, so the sync is DEFERRED, never dropped:
      // dropping it lost a sidebar edit made while scrubbing until the next unrelated
      // change. `sync()` at the end of the gesture picks it up.
      if (gesture) { syncMissed = true; return; }
      sync();
    });
  }

  function sync(): void {
    if (!open || disposed) return;
    syncMissed = false;
    const boxes = getBoxes();
    const key = tracksKey(boxes, cfg);
    // What a bar's PICTURE depends on, which is a different question from what its
    // ROW depends on. `tracksKey` is id/lane/timed only, so editing a card's text or
    // its colour took the restyle branch and the bar kept photographing the old words
    // indefinitely — a thumbnail that actively lies is worse than the flat fill it
    // replaced. Timing is excluded (see appearanceSig), so a drag does not re-key.
    const akey = appearanceKey(boxes);
    const looksDifferent = akey !== lastAppearance;
    lastAppearance = akey;
    if (key !== lastKey) {
      lastKey = key;
      rebuild(boxes);
      scheduleThumbs();
    } else {
      restyle(boxes);
      if (looksDifferent) scheduleThumbs();
    }
    if (fitPending && tracks.clientWidth > 0) {
      fitPending = false;
      pxPerSec = fitPxPerSec(durationSec(), tracks.clientWidth);
      restyle(boxes);
      scheduleThumbs();
    }
    updatePlayhead(clock.t());
  }

  // ── gestures ────────────────────────────────────────────────────────────────

  function tracksRectLeft(): number {
    return tracks.getBoundingClientRect().left;
  }

  function timeAt(clientX: number): number {
    return clientToTime(clientX, tracksRectLeft(), tracks.scrollLeft, pxPerSec);
  }

  function showSnapline(tSec: number | null): void {
    if (tSec === null) { snapline.hidden = true; return; }
    snapline.hidden = false;
    snapline.style.left = `${timeToPx(tSec, pxPerSec)}px`;
  }

  /**
   * The snap candidate currently engaged, so a NEWLY engaged snap can be felt as well
   * as seen. Reset by endGesture; null means "nothing is snapped right now".
   */
  let snappedAt: number | null = null;

  /** Snap a raw time unless Alt is held (the universal bypass). */
  function maybeSnap(raw: number, alt: boolean, excludeId?: string): number {
    if (!snapOn || alt) { showSnapline(null); snappedAt = null; return raw; }
    const cands = snapCandidates(getBoxes(), cfg, clock.t() / 1000, raw, excludeId);
    // A finger cannot land on a 6px window. The tolerance follows the pointer that
    // started the gesture (the module default stays 6 for every other caller).
    const px = isCoarsePointer(gesture?.pointerType) ? SNAP_PX_COARSE : SNAP_PX_FINE;
    const r = snapTime(raw, cands, pxPerSec, px);
    showSnapline(r.snapped);
    // Newly engaged, on a pointer with no cursor to watch: a 8ms tick is the only
    // feedback a thumb over the bar can actually receive. Reduced motion turns it off —
    // the pref is about involuntary sensation, not only about pixels moving.
    if (r.snapped !== null && r.snapped !== snappedAt && isCoarsePointer(gesture?.pointerType)
      && !prefersReducedMotion() && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(8); } catch { /* a denied/absent vibrator is not an error */ }
    }
    snappedAt = r.snapped;
    return r.t;
  }

  /** The `.tl-edge` element of one bar, by side. */
  function edgeEl(barEl: HTMLElement | null, edge: 'in' | 'out' | null | undefined): HTMLElement | null {
    if (!barEl || !edge) return null;
    return barEl.querySelector<HTMLElement>(`.tl-edge[data-edge="${edge}"]`);
  }

  /** Vertical offset of `el` inside `inner`, walking the offsetParent chain. */
  function offsetIn(el: HTMLElement): number {
    let y = 0;
    let n: HTMLElement | null = el;
    while (n && n !== inner) {
      y += n.offsetTop || 0;
      n = n.offsetParent as HTMLElement | null;
    }
    return y;
  }

  function beginGesture(e: PointerEvent, g: Omit<Gesture, 'x' | 'y' | 'moved' | 'alt' | 'pointerId' | 'pointerType'>): void {
    gesture = {
      ...g,
      x: e.clientX, y: e.clientY, moved: false, alt: e.altKey,
      pointerId: e.pointerId, pointerType: e.pointerType || '',
    };
    abortThumbs();
    try { (g.el ?? root).setPointerCapture(e.pointerId); } catch { /* jsdom / no capture */ }
    root.classList.add('is-dragging');
    if (g.kind === 'trim') beginTrimChrome(gesture);
  }

  /**
   * The three edge states, armed. Every class added here comes off in endGesture — the
   * single teardown — and never at a call site, matching the `is-drop-target` discipline.
   */
  function beginTrimChrome(g: Gesture): void {
    if (!g.el) return;
    g.el.classList.add('is-trimming');
    edgeEl(g.el, g.edge)?.classList.add('is-active');
    // The badge's VERTICAL place is fixed for the gesture — a trim never moves a bar
    // between lanes — so it is measured once here rather than per frame. Reading
    // offsetTop/offsetHeight inside the rAF that has just written every bar's geometry
    // is a forced synchronous layout, sixty times a second, for a number that cannot
    // have changed.
    const top = offsetIn(g.el);
    // The first lane has nothing above it but the scroller's edge, so the badge hangs
    // below the bar there instead of being clipped.
    const below = top < 24;
    const lift = isCoarsePointer(g.pointerType) ? 44 : 0;   // clear of a thumb
    trimBadge.classList.toggle('is-below', below);
    trimBadge.style.top = `${below ? top + (g.el.offsetHeight || 0) + lift : top - lift}px`;
    trimBadge.hidden = false;
    trimBadge.textContent = '';
    showExtent(g);
  }

  /**
   * The reachable span of the clip being trimmed, in timeline seconds, drawn as a ghost
   * behind/around the bar: `[start - clipIn/speed, start + (media - clipIn)/speed]`.
   * Only when the media length is known — a card, a Lottie or a procedural bed has no
   * "end of the source" to draw.
   */
  function showExtent(g: Gesture): void {
    extent.hidden = true;
    if (!g.el) return;
    const media = mediaOf(g.id).dur;
    if (media == null || !(media > 0)) return;
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, g.id);
    if (i < 0) return;
    const timing = boxTiming(rows[i]!, cfg);
    const speed = timing.speed || 1;
    const from = Math.max(0, g.start0 - timing.clipIn / speed);
    const to = g.start0 + (media - timing.clipIn) / speed;
    if (!(to > from)) return;
    extent.style.left = `${timeToPx(from, pxPerSec)}px`;
    extent.style.width = `${Math.max(2, timeToPx(to - from, pxPerSec))}px`;
    extent.style.top = `${offsetIn(g.el)}px`;
    extent.style.height = `${g.el.offsetHeight || 0}px`;
    extent.hidden = false;
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.tl-btn, .tl-dropslot, .tl-chip-group, .tl-inspector, .tl-seam')) return;

    if (target.closest('.tl-handle')) {
      e.preventDefault();
      beginGesture(e, { kind: 'resize', id: '', el: handle, x0: e.clientX, y0: e.clientY, start0: 0, dur0: 0, index0: 0, index: 0, h0: panelH });
      return;
    }
    if (target.closest('.tl-ruler')) {
      e.preventDefault();
      const at = maybeSnap(timeAt(e.clientX), e.altKey);
      clock.seek(at * 1000, { scrubbing: true });
      beginGesture(e, { kind: 'seek', id: '', el: ruler, x0: e.clientX, y0: e.clientY, start0: 0, dur0: 0, index0: 0, index: 0, h0: panelH });
      return;
    }

    const barEl = target.closest<HTMLElement>('.tl-clip');
    if (!barEl) return;
    const id = barEl.dataset.id || '';
    if (!id) return;
    e.preventDefault();

    // Selection follows the press (Shift toggles), so the canvas chrome tracks the bar.
    const cur = selection.get();
    // Shift-extend never reveals: with two clips selected there is no single one to
    // put the picture on, and moving it out from under the first is a worse answer.
    if (e.shiftKey) selectAndReveal(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id], { reveal: false });
    else {
      // A/V-linked pair: pressing either half selects both, so a move or a delete keeps
      // picture and sound together. Alt selects just the one — the shell's established
      // "solo this box" idiom, and the reason there is no global "linked selection"
      // toggle to find and remember.
      const partner = e.altKey ? '' : partnerOf(id);
      selectAndReveal(partner ? [id, partner] : [id]);
    }
    focusedId = id;
    updateRovingTabindex();
    barEl.focus?.();

    const boxes = getBoxes();
    const i = indexOfId(boxes, cfg, id);
    if (i < 0) return;
    const total = durationSec();
    const { start, dur } = span(boxes[i]!, total);
    const lane = boxTiming(boxes[i]!, cfg).lane;

    const rect = barEl.getBoundingClientRect();
    // The zone is decided per EVENT (finger vs cursor) and then capped by the bar's own
    // width, so two zones can never meet and a narrow bar offers none at all. All of
    // that arithmetic lives in timeline-math's edgeZonePx; this reads its answer.
    const zone = edgeZonePx(rect.width, edgeBase(e.pointerType));
    const edge: 'in' | 'out' | null = zone <= 0
      ? null
      : e.clientX - rect.left <= zone
        ? 'in'
        : rect.right - e.clientX <= zone ? 'out' : null;

    const base = { id, el: barEl, x0: e.clientX, y0: e.clientY, start0: start, dur0: dur, h0: panelH };
    if (edge) {
      beginGesture(e, { ...base, kind: 'trim', edge, index0: 0, index: 0 });
      return;
    }
    if (lane === 'seq') {
      const order = seqBoxes(boxes, cfg).map((b) => String(b[cfg.idField] ?? ''));
      const idx = order.indexOf(id);
      beginGesture(e, { ...base, kind: 'reorder', index0: idx, index: idx });
      return;
    }
    beginGesture(e, { ...base, kind: 'move', index0: 0, index: 0 });
  }

  function onPointerMove(e: PointerEvent): void {
    const g = gesture;
    if (!g) return;
    // Synchronous state capture, rAF-coalesced painting: pointerup must never depend on
    // whether the last frame ran.
    g.x = e.clientX;
    g.y = e.clientY;
    g.alt = e.altKey;
    if (Math.abs(g.x - g.x0) > 2 || Math.abs(g.y - g.y0) > 2) g.moved = true;
    if (moveScheduled) return;
    moveScheduled = true;
    requestAnimationFrame(() => {
      moveScheduled = false;
      if (!gesture || disposed) return;
      paintGesture(gesture);
    });
  }

  /**
   * The panel's non-track chrome — grip + bar + ruler — MEASURED rather than derived
   * from a constant, because `.tl-bar` wraps to two or three rows below 720px depending
   * on how many tool buttons the host declared and whether a clip is selected (the
   * inspector row only exists with a selection). This is what clampPanelH's floor is
   * built from, so the grip can never drag `.tl-tracks` down to nothing.
   */
  function chromeH(): number {
    return Math.round(
      handle.getBoundingClientRect().height + bar.getBoundingClientRect().height + ruler.getBoundingClientRect().height,
    );
  }

  /**
   * The trim readout, anchored at the edge under the pointer. Its row was decided in
   * beginTrimChrome; per frame this writes only the horizontal place and the words.
   */
  function paintTrimBadge(g: Gesture, edgeTime: number, dur: number): void {
    trimBadge.hidden = false;
    trimBadge.textContent = `${fmtDur(dur)}  ${fmtDelta(dur - g.dur0)}`;
    trimBadge.style.left = `${timeToPx(edgeTime, pxPerSec)}px`;
  }

  /** Live preview — PANEL DOM ONLY. The model is untouched until pointerup. */
  function paintGesture(g: Gesture): void {
    if (g.kind === 'resize') {
      const stageH = stageEl.getBoundingClientRect().height || 0;
      panelH = clampPanelH(g.h0 + (g.y0 - g.y), stageH, chromeH());
      root.style.height = `${panelH}px`;
      reserve(panelH + RESERVE_PAD);
      return;
    }
    if (g.kind === 'seek') {
      const at = maybeSnap(timeAt(g.x), g.alt);
      clock.seek(at * 1000, { scrubbing: true });
      return;
    }
    const el = g.el;
    if (!el) return;
    const deltaSec = pxToTime(g.x - g.x0, pxPerSec);
    // Preview by running the REAL writer on a throwaway array and drawing its answer.
    // Duplicating the clamps here is what made the bar preview a 5 s trim on a 2 s
    // source and then snap back to 2 s on release: the inline version knew about
    // MIN_DUR but not about the media length. The writers are pure, so this costs one
    // array map per rAF frame and can never drift from the commit.
    //
    // EVERY bar, not just the dragged one: trimming a seq clip ripples the whole row,
    // and Premiere 26's answer (the downstream bars move WITH the drag rather than
    // jumping on release) is free here — the throwaway array already holds their new
    // starts. The seam chips ride the same numbers, exactly as restyle positions them.
    const previewRows = (rows: Box[]): void => {
      const total = durationSec();
      for (const [id, node] of bars) {
        const i = indexOfId(rows, cfg, id);
        if (i < 0) continue;
        const { start, dur } = span(rows[i]!, total);
        applyBarGeometry(node, start, dur);
      }
      for (const chip of Array.from(laneWrap.querySelectorAll<HTMLElement>('.tl-seam'))) {
        const i = indexOfId(rows, cfg, chip.dataset.b || '');
        if (i < 0) continue;
        chip.style.left = `${timeToPx(boxTiming(rows[i]!, cfg).start ?? 0, pxPerSec)}px`;
      }
    };
    if (g.kind === 'move') {
      previewRows(moveOverlay(getBoxes(), cfg, g.id, maybeSnap(g.start0 + deltaSec, g.alt, g.id)));
      return;
    }
    if (g.kind === 'trim') {
      const raw = g.edge === 'in' ? g.start0 + deltaSec : g.start0 + g.dur0 + deltaSec;
      const snapped = maybeSnap(raw, g.alt, g.id);
      const d = g.edge === 'in' ? snapped - g.start0 : snapped - (g.start0 + g.dur0);
      const rows = trimClip(getBoxes(), cfg, g.id, g.edge ?? 'out', d, mediaOf(g.id).dur, mediaDur);
      previewRows(rows);
      const i = indexOfId(rows, cfg, g.id);
      if (i < 0) return;
      const achieved = span(rows[i]!, durationSec());
      // THE LIMIT SIGNAL. Requested vs achieved, using the writer's OWN answer — no
      // clamp is duplicated here, which is the whole point: `fitToMedia` stays the only
      // authority on where a clip runs out of source, and this just notices that it
      // said no. Without it a drag past the end of the media looks like a dead pointer.
      //
      // Compared on the DURATION, never on the edge's absolute time: the seq row is
      // magnetic, so a successful trim-in repacks the clip back to the same `start` it
      // had, and an absolute comparison would report a limit on every single one. Both
      // edges change the length by exactly the delta they achieved, on both lanes.
      const achievedD = g.edge === 'in' ? g.dur0 - achieved.dur : achieved.dur - g.dur0;
      const limit = Math.abs(achievedD - d) > 0.001;
      edgeEl(el, g.edge)?.classList.toggle('is-limit', limit);
      if (limit && !g.limitSaid) {
        g.limitSaid = true;
        // Direction, not edge: held back from moving the edge EARLIER is the head of the
        // source, from moving it LATER is the tail. (A clip stopped by the MIN_DUR floor
        // rather than by the file reports through the same pair — the visual signal is
        // exactly right either way, and these are the nearest true words we have.)
        announce(achievedD > d ? t('Start of the source') : t('End of the source'));
      }
      const at = g.edge === 'in' ? achieved.start : achieved.start + achieved.dur;
      paintTrimBadge(g, at, achieved.dur);
      return;
    }
    if (g.kind === 'reorder') {
      // Lift the bar and let the row show where it would land. The drop index comes from
      // the pointer's time position against the CURRENT starts.
      el.classList.add('is-dragging');
      el.style.transform = `translateX(${g.x - g.x0}px)`;
      const order = seqBoxes(getBoxes(), cfg);
      g.index = dropIndexAt(getBoxes(), cfg, timeAt(g.x), g.id);
      // Highlight the clip the drop would displace: the one currently sitting at the
      // target index. Nothing is highlighted while the index is unchanged, so the row
      // stays quiet until the drag would actually reorder something.
      const targetId = g.index === g.index0 ? '' : String(order[g.index]?.[cfg.idField] ?? '');
      for (const [id, node] of bars) node.classList.toggle('is-drop-target', !!targetId && id !== g.id && id === targetId);
      el.dataset.dropIndex = String(g.index);
    }
  }

  /**
   * THE one teardown for a gesture, whatever ended it — pointerup, pointercancel, a
   * lost capture, or the panel closing under a drag. Every transient the gesture
   * painted is cleared HERE, so no exit path can leak one:
   *   • `is-drop-target` lives on OTHER bars, and a reorder does not change tracksKey,
   *     so a rebuild will never clean it up — a stale ring would sit on a clip for the
   *     rest of the session;
   *   • the dragged bar's lift transform and dropIndex;
   *   • the three trim states (`is-trimming` on the bar, `is-active`/`is-limit` on the
   *     edge), the readout badge and the ghost extent — added in beginTrimChrome and
   *     removed ONLY here, so no exit path can strand a red edge on a clip;
   *   • the pointer capture.
   * It also replays a model change that arrived mid-gesture and was dropped.
   */
  function endGesture(g: Gesture | null): void {
    gesture = null;
    snappedAt = null;
    root.classList.remove('is-dragging');
    showSnapline(null);
    if (g) {
      try { (g.el ?? root).releasePointerCapture?.(g.pointerId); } catch { /* never captured */ }
      if (g.el) {
        g.el.classList.remove('is-dragging');
        g.el.style.transform = '';
        delete g.el.dataset.dropIndex;
      }
    }
    for (const node of bars.values()) node.classList.remove('is-drop-target', 'is-trimming');
    for (const e of Array.from(laneWrap.querySelectorAll<HTMLElement>('.tl-edge'))) {
      e.classList.remove('is-active', 'is-limit');
    }
    trimBadge.hidden = true;
    extent.hidden = true;
    // The KEYBOARD trim focus is a persistent state, not a gesture transient; the sweep
    // above cannot tell the two apart, so re-assert it rather than leaving the user's
    // chosen edge unmarked after an unrelated drag.
    paintFocusedEdge();
    // A model change that arrived mid-gesture was deferred, not dropped. Replay it.
    if (syncMissed) scheduleSync();
  }

  function onPointerUp(e: PointerEvent): void {
    const g = gesture;
    if (!g) return;
    endGesture(g);

    // These two branches write nothing to the model, so they must run the sync a
    // mid-gesture model change (a sidebar edit made while scrubbing) never got.
    if (g.kind === 'resize') { reserve(panelH + RESERVE_PAD); sync(); scheduleThumbs(); return; }
    if (g.kind === 'seek') { const at = maybeSnap(timeAt(g.x), g.alt); clock.seek(at * 1000); sync(); scheduleThumbs(); return; }
    if (!g.moved) { sync(); scheduleThumbs(); return; }

    // ── the ONE model write of the gesture ────────────────────────────────────
    const boxes = getBoxes();
    const deltaSec = pxToTime(g.x - g.x0, pxPerSec);
    const alt = e.altKey || g.alt;
    if (g.kind === 'move') {
      // moveOverlay owns the clamp AND the ms rounding, so a drag and the inspector's
      // Start field land on exactly the same value for the same time.
      write(moveOverlay(boxes, cfg, g.id, maybeSnap(g.start0 + deltaSec, alt, g.id)));
    } else if (g.kind === 'trim') {
      const raw = g.edge === 'in' ? g.start0 + deltaSec : g.start0 + g.dur0 + deltaSec;
      const snapped = maybeSnap(raw, alt, g.id);
      const d = g.edge === 'in' ? snapped - g.start0 : snapped - (g.start0 + g.dur0);
      const next = trimClip(boxes, cfg, g.id, g.edge ?? 'out', d, mediaOf(g.id).dur, mediaDur);
      write(next);
      // The badge was aria-hidden throughout (sixty updates a second is not speech);
      // this is its ONE spoken form, and it reports what actually landed, not what was
      // asked for — so a drag the media refused says so by simply reading back short.
      const j = indexOfId(next, cfg, g.id);
      if (j >= 0) {
        const now = span(next[j]!, durationSec()).dur;
        announce(t('{name}: {dur}, trimmed {delta}', {
          name: labelFor(g.id), dur: fmtDur(now), delta: fmtDelta(now - g.dur0),
        }));
      }
    } else if (g.kind === 'reorder') {
      // Re-derive from the FINAL pointer position rather than trusting g.index: that one
      // is written by paintGesture, which is rAF-coalesced, so the last pointermove of a
      // fast drag may never have painted. Same discipline as move/trim above — pointerup
      // never depends on whether a frame ran.
      const index = dropIndexAt(boxes, cfg, timeAt(g.x), g.id);
      if (index !== g.index0) write(moveSeqClip(boxes, cfg, g.id, index, mediaDur));
      else sync();
    }
    showSnapline(null);
    scheduleThumbs();
  }

  function onPointerCancel(): void {
    if (!gesture) return;
    const g = gesture;
    endGesture(g);
    // A cancelled resize still left the panel at its dragged height; re-assert the
    // reserve so the artboard and the panel agree.
    if (g.kind === 'resize') reserve(open ? panelH + RESERVE_PAD : 0);
    sync();
  }

  // ── transport + tools ───────────────────────────────────────────────────────

  /**
   * The button is a PROJECTION of the clock's state, never a record of what we last
   * asked for: the clock also pauses itself at end-of-sequence and on `visibilitychange`,
   * and it has no play-state callback to tell us. So this runs on every tick as well as
   * on the click, and is a no-op unless the state actually differs.
   */
  let playBtnPlaying: boolean | null = null;
  function syncPlayBtn(): void {
    const on = clock.playing();
    if (on === playBtnPlaying) return;
    playBtnPlaying = on;
    playBtn.innerHTML = on ? icon('pause') : icon('play');
    const label = on ? t('Pause') : t('Play');
    playBtn.setAttribute('aria-label', label);
    playBtn.setAttribute('data-tip', label);
  }

  function togglePlay(): void {
    if (clock.playing()) clock.pause(); else clock.play();
    syncPlayBtn();
  }

  function zoom(factor: number, cursorPx?: number): void {
    const cx = cursorPx ?? tracks.clientWidth / 2;
    const z = zoomAbout(pxPerSec, factor, cx, tracks.scrollLeft);
    pxPerSec = z.pxPerSec;
    abortThumbs();
    restyle(getBoxes());
    tracks.scrollLeft = z.scrollLeft;
    updatePlayhead(clock.t());
    scheduleThumbs();
  }

  // ── Pinch to zoom ───────────────────────────────────────────────────────────
  // TOUCH events, not pointer events, deliberately. `.tl-tracks` keeps `touch-action:
  // pan-x pan-y` so ONE finger still pans a long sequence natively (the panel itself is
  // `touch-action: none`, so without that opt-out a phone cannot reach past the fold at
  // all). Under that value the browser claims a TWO-finger gesture as a pan and fires
  // pointercancel on both pointers, which would kill a pointer-based pinch part-way
  // through; a non-passive touchmove can preventDefault that pan and keep the gesture,
  // without giving up single-finger scrolling. The zoom itself goes through the same
  // zoom() → zoomAbout() path as the wheel and the buttons, so every route anchors on
  // its cursor and clamps to [MIN_PPS, MAX_PPS] identically.
  let pinchDist = 0;
  const touchGap = (t: TouchList): number => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);

  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 2) { pinchDist = 0; return; }
    pinchDist = touchGap(e.touches);
    // A pinch is never also a clip drag. Whatever single-finger gesture the first touch
    // started, drop it here rather than letting the second finger scale the timeline
    // while the first keeps dragging a bar under it.
    if (gesture) endGesture(gesture);
  }
  function onTouchMove(e: TouchEvent): void {
    if (e.touches.length !== 2 || pinchDist <= 0) return;
    const gap = touchGap(e.touches);
    if (gap <= 0) return;
    e.preventDefault();
    const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2;
    zoom(gap / pinchDist, midX - tracks.getBoundingClientRect().left);
    pinchDist = gap;
  }
  function onTouchEnd(e: TouchEvent): void { if (e.touches.length < 2) pinchDist = 0; }

  function fit(): void {
    pxPerSec = fitPxPerSec(durationSec(), tracks.clientWidth);
    abortThumbs();
    restyle(getBoxes());
    tracks.scrollLeft = 0;
    updatePlayhead(clock.t());
    scheduleThumbs();
  }

  /** Does this box's span contain `at`? (Open-ended clips run to the sequence end.) */
  function spanContains(b: Box, at: number, total = durationSec()): boolean {
    if (!b || !isTimed(b, cfg)) return false;
    const { start, dur } = span(b, total);
    return at > start && at < start + dur;
  }

  /**
   * SPLIT — one operation, three doors (the toolbar blade, `s`, and the context menu),
   * and one scope rule shared by all of them.
   *
   * Scope, in the order Premiere and Descript both resolve it:
   *   1. every SELECTED clip the playhead is inside — so a deliberate multi-selection
   *      cuts through all of it in one press, and one undo takes the whole thing back;
   *   2. failing that, the seq clip under the playhead — the "I just want to cut here"
   *      case, which must not require selecting anything first;
   *   3. failing that, say so and write nothing.
   *
   * `everything: true` is the Shift+S variant: every timed clip the playhead is inside,
   * on every lane, IGNORING the selection.
   *
   * Two things make this cheap to undo. The cut is SNAPPED first, so a press within a
   * few pixels of an existing edit lands exactly on it and then fails the "already at a
   * cut" test as an equality rather than a float comparison (Premiere's razor snaps for
   * the same reason). And `splitAll` returns the input array by IDENTITY when nothing
   * landed, so a no-op costs no commit and no undo entry at all.
   */
  function splitAtPlayhead(opts?: { everything?: boolean }): void {
    const boxes = getBoxes();
    const total = durationSec();
    // Snap BEFORE deciding scope: the snapped instant is the one the cut is tested
    // against, so "inside this clip" and "where the cut lands" can never disagree.
    //
    // NOT through maybeSnap — the playhead is one of its own candidates, so snapping
    // the playhead would always find itself at distance 0 and change nothing. Passing a
    // negative playhead drops that candidate (snapCandidates guards on `ph >= 0`) and
    // leaves the clip edges and whole seconds, which is exactly what a razor should
    // land on. It also draws no snapline: there is no drag here to give feedback about.
    const raw = clock.t() / 1000;
    const at = snapOn
      ? snapTime(raw, snapCandidates(boxes, cfg, -1, raw), pxPerSec, SNAP_PX_FINE).t
      : raw;
    let ids: string[];
    if (opts?.everything) {
      ids = boxes.filter((b) => spanContains(b, at, total)).map((b) => String(b[cfg.idField] ?? ''));
    } else {
      ids = selection.get().filter((id) => {
        const i = indexOfId(boxes, cfg, id);
        return i >= 0 && spanContains(boxes[i]!, at, total);
      });
      if (!ids.length) {
        const under = seqBoxes(boxes, cfg).find((b) => spanContains(b, at, total));
        if (under) ids = [String(under[cfg.idField] ?? '')];
      }
    }
    ids = ids.filter(Boolean);
    if (!ids.length) { announce(t('Move the playhead inside a clip to split it')); return; }
    const { next, split } = splitAll(boxes, cfg, ids, at, mintId);
    // Identity, not deep equality: nothing was cut, so nothing is written and the undo
    // stack is untouched. The commonest way here is a second press at the same instant.
    if (next === boxes) { announce(t('The playhead is already at a cut')); return; }
    write(next);
    // Select the right-hand halves — what you carry on editing after a cut is the part
    // ahead of the playhead, and the panel's one selection writer keeps it on screen.
    if (split.length) selectAndReveal(split);
    announce(split.length > 1 ? t('Split {n} clips', { n: String(split.length) }) : t('Clip split'));
  }

  // ── A/V link: detach audio, re-attach, and the through-edit join ─────────────
  //
  // Detach is deliberately NOT Final Cut's: theirs is one-way, and "there's no way to
  // resync a clip, except for Undo" is the single most-cited complaint in the survey.
  // This is the Premiere/Resolve model — a persistent link, written on BOTH boxes, so
  // the sound can go back where it came from from either side. All of the arithmetic is
  // in timeline-math (`detachAudio` / `reattachAudio`); everything here is the gate.

  /** The id this box is A/V-linked to, or '' (no link field, no value, or a dangling id). */
  function partnerOf(id: string, rows: Box[] = getBoxes()): string {
    const link = cfg.linkField;
    if (!link || !id) return '';
    const i = indexOfId(rows, cfg, id);
    if (i < 0) return '';
    const v = rows[i]![link];
    const other = v == null ? '' : String(v);
    return other && indexOfId(rows, cfg, other) >= 0 ? other : '';
  }

  /**
   * May this clip's sound be pulled onto its own lane? Four gates, all of them "does
   * this even mean anything here" rather than policy:
   *   • the TOOL declares a link sub-field (sequence-studio does; layout-studio does
   *     not, and gets no affordance at all rather than a broken one);
   *   • the tool has an `audio` add-kind — the vocabulary a detached sound is born into,
   *     exactly the check the microphone button already makes;
   *   • the box is actually a video (an image has no sound; a sound is already detached);
   *   • and it is not linked already.
   */
  function canDetach(id: string): boolean {
    if (!cfg.linkField || !audioKind() || !id) return false;
    if (partnerOf(id)) return false;
    return mediaOf(id).kind === 'video';
  }

  function detachAudioAt(id: string): void {
    if (!id) return;
    if (!canDetach(id)) { announce(t('This clip has no sound to detach')); return; }
    const next = detachAudio(getBoxes(), cfg, id, mintId, audioKind()?.seed as Box | undefined);
    if (!next) { announce(t('This clip has no sound to detach')); return; }
    write(next);
    announce(t('Audio detached'));
  }

  function reattachAudioAt(id: string): void {
    if (!id || !cfg.linkField) return;
    // Read the partner BEFORE the write: pressed from the SOUND's side, `id` is the box
    // that is about to be removed, and a selection left pointing at a deleted row is how
    // the inspector ends up describing something that no longer exists.
    const partner = partnerOf(id);
    const next = reattachAudio(getBoxes(), cfg, id, mediaDur);
    // The one refusal worth explaining: the group exists but nothing in it is muted, so
    // the user un-muted the picture by hand and we cannot tell the two sides apart.
    if (!next) { announce(t('Un-mute the video before re-attaching its sound')); return; }
    const survivor = indexOfId(next, cfg, id) >= 0 ? id : (indexOfId(next, cfg, partner) >= 0 ? partner : '');
    write(next);
    if (survivor) { focusedId = survivor; selectAndReveal([survivor]); }
    announce(t('Audio re-attached'));
  }

  /**
   * Are two clips the same source? Injected into `isThroughEdit`, which must not know
   * what an asset is. Compared on the ref's ID (its identity), never the whole object —
   * two refs to the same asset can differ in resolved url/meta.
   */
  const sameSource = (a: Box, b: Box): boolean => {
    const field = assetFieldName();
    const idOf = (x: Box): unknown => {
      const v = x?.[field];
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as { id?: unknown }).id ?? null : null;
    };
    return JSON.stringify(idOf(a) ?? null) === JSON.stringify(idOf(b) ?? null);
  };

  /** The neighbour `id` forms a through edit with, and which side of it `id` is on. */
  function throughNeighbour(id: string, rows: Box[] = getBoxes()): { aId: string; bId: string } | null {
    const row = seqBoxes(rows, cfg).map((b) => String(b[cfg.idField] ?? ''));
    const at = row.indexOf(id);
    if (at < 0) return null;
    const prev = at > 0 ? row[at - 1]! : '';
    const next = at + 1 < row.length ? row[at + 1]! : '';
    // FCP accepts a ONE-SIDED selection: pressing Join on either half of a through edit
    // joins that edit. The clip's own out-edge is tried first, so a clip between two
    // through edits joins forwards — the direction the playhead is travelling.
    if (next && isThroughEdit(rows, cfg, id, next, sameSource)) return { aId: id, bId: next };
    if (prev && isThroughEdit(rows, cfg, prev, id, sameSource)) return { aId: prev, bId: id };
    return null;
  }

  function joinAt(aId: string, bId: string): void {
    const next = joinClips(getBoxes(), cfg, aId, bId, mediaDur);
    if (!next) return;
    write(next);
    selectAndReveal([aId]);
    announce(t('Clips joined'));
  }

  /** Ids are the tool's contract; mint one that cannot collide with an existing row. */
  function mintId(): string {
    const used = new Set(getBoxes().map((b) => String(b?.[cfg.idField] ?? '')));
    let n = used.size + 1;
    let id = `b${n}`;
    while (used.has(id)) { n++; id = `b${n}`; }
    return id;
  }

  /**
   * Remove one box, rippling the row behind it. `target` names it (the context menu);
   * with no argument it is the focused/selected bar (the Delete key). Scenery is
   * deletable too — it has a chip rather than a bar, and no reason to be undeletable.
   */
  function deleteBox(target?: string): void {
    const id = target || focusedId || selection.get()[0] || '';
    if (!id || !(bars.has(id) || chips.has(id))) return;
    // Hand focus to a neighbour rather than nowhere: `updateRovingTabindex` re-picks
    // when the id is gone, and rebuild() restores focus onto whatever it picked.
    const order = Array.from(bars.keys());
    const at = order.indexOf(id);
    if (at >= 0) focusedId = order[at + 1] || order[at - 1] || '';
    // Say what was actually removed. Scenery has a chip, not a bar, and the panel's own
    // UI never calls it a clip — announcing "Clip removed" for an always-on image is the
    // one place the vocabulary would slip, and it slips only for screen-reader users.
    const wasClip = bars.has(id);
    write(removeAndRipple(getBoxes(), cfg, id, mediaDur));
    selectAndReveal(focusedId ? [focusedId] : []);
    announce(wasClip ? t('Clip removed') : t('Removed'));
  }

  // ── keyboard trim (`[` / `]` pick an edge, `,` / `.` nudge it, `e` snaps it) ──
  //
  // The best affordance in the whole survey for an editor that has to be approachable:
  // it needs no pointer precision at all, it works at any zoom (including one where the
  // bar is too narrow to carry a hit zone), and "trim to the playhead" is the operation
  // people actually want most of the time — you are already looking at the frame.
  //
  // Each command is ONE write() = one undo step; holding a key coalesces through
  // tool-history's 500ms window exactly like a held arrow on the canvas.

  /** Which edge the keyboard is aimed at, or null. Cleared by the first Escape. */
  let focusedEdge: 'in' | 'out' | null = null;

  /** The clip a keyboard trim would act on: the focused bar, else the selected one. */
  function trimTargetId(): string {
    if (focusedId && bars.has(focusedId)) return focusedId;
    return selection.get().find((x) => bars.has(x)) || '';
  }

  /** Paint `.is-active` for the keyboard's chosen edge, and nowhere else. */
  function paintFocusedEdge(): void {
    // A live trim gesture OWNS the edge chrome (beginTrimChrome → endGesture). Anything
    // that repaints mid-drag must not wipe the active/limit state out from under it.
    if (gesture?.kind === 'trim') return;
    const target = focusedEdge ? trimTargetId() : '';
    for (const [id, node] of bars) {
      for (const el of Array.from(node.querySelectorAll<HTMLElement>('.tl-edge'))) {
        el.classList.toggle('is-active', !!target && id === target && el.dataset.edge === focusedEdge);
      }
    }
  }

  function focusEdge(edge: 'in' | 'out'): void {
    if (!trimTargetId()) return;
    focusedEdge = edge;
    paintFocusedEdge();
    announce(edge === 'in' ? t('Trim the start') : t('Trim the end'));
  }

  /**
   * Nudge the focused edge by `deltaSec`. One write, one undo step.
   *
   * `lead` prefixes the spoken readout rather than being announce()d separately —
   * announce() replaces the live region's text, so two calls in one turn means the
   * first one is never heard.
   */
  function trimBy(deltaSec: number, lead = ''): void {
    const id = trimTargetId();
    if (!id || !focusedEdge) return;
    const boxes = getBoxes();
    const i = indexOfId(boxes, cfg, id);
    if (i < 0) return;
    const before = span(boxes[i]!, durationSec()).dur;
    const next = trimClip(boxes, cfg, id, focusedEdge, deltaSec, mediaOf(id).dur, mediaDur);
    write(next);
    const j = indexOfId(next, cfg, id);
    const now = j >= 0 ? span(next[j]!, durationSec()).dur : before;
    const said = t('{name}: {dur}, trimmed {delta}', {
      name: labelFor(id), dur: fmtDur(now), delta: fmtDelta(now - before),
    });
    announce(lead ? `${lead} ${said}` : said);
  }

  /** Pull the focused edge to the playhead — the no-dragging trim. */
  function trimToPlayhead(): void {
    const id = trimTargetId();
    if (!id || !focusedEdge) return;
    const boxes = getBoxes();
    const i = indexOfId(boxes, cfg, id);
    if (i < 0) return;
    const { start, dur } = span(boxes[i]!, durationSec());
    trimBy(clock.t() / 1000 - (focusedEdge === 'in' ? start : start + dur), t('Trim to the playhead'));
  }

  // ── record-in-place voiceover (track C) ─────────────────────────────────────
  //
  // Press the mic, get a 3-2-1 count-in, then perform AGAINST THE PICTURE: the panel
  // runs the playhead through the take, so what you narrate is what you were watching.
  // On stop the blob becomes a durable user asset and lands as an audio box at the
  // time the take started — one commit, one undo step, trimmable immediately.
  //
  // Four things here are load-bearing and each has already cost someone an afternoon:
  //
  //  1. THE LENGTH IS MEASURED, NEVER READ OFF THE BLOB. A fresh MediaRecorder blob
  //     reports duration Infinity or 0 (record-control.ts's `data-clip-ms` note says
  //     the same thing from the video side), so the elapsed wall-clock between "the
  //     recorder said go" and "the user pressed stop" IS the duration — and it is
  //     stored as the asset's `meta.durationMs`, because that is what the tool hook
  //     stamps as `data-audio-dur` and therefore the only thing `mediaOf` can clamp a
  //     trim against. A take stored without it cannot be trimmed properly.
  //  2. THE COMPOSITION IS SILENCED BY ATTRIBUTE, not by touching media elements.
  //     sequence-clock reads `data-t-mute="1"` off the live canvas DOM on EVERY frame
  //     for both videos (element.muted) and audio boxes (they are simply not
  //     scheduled). Setting `video.muted` directly would be overwritten by the clock's
  //     next frame; setting the attribute is speaking the clock's own language, so
  //     nothing fights and the model is never written. Re-asserted per tick, since a
  //     repaint mints fresh box elements.
  //  3. EVERY EXIT PATH GOES THROUGH endTake(). A leaked microphone is the worst
  //     outcome available here: the browser shows a recording indicator with no way
  //     for the user to trace it. Denial, an abort mid-count-in, a hidden tab, closing
  //     the panel, destroy() — all of them land in the same teardown.
  //  4. THE INSERT IS ONE COMMIT, composed from the SAME writers a drag uses
  //     (moveOverlay + setDuration on the intermediate array). No new clamping
  //     arithmetic lives in this view — see the module header.

  type TakePhase = 'idle' | 'countin' | 'recording' | 'saving';

  let takePhase: TakePhase = 'idle';
  let takeSession: RecordSession | null = null;
  let takeLevelOff: (() => void) | null = null;
  /** Microphone METER references this panel currently holds. A COUNT, not a boolean:
   *  `recorder.meter` is refcounted, so every resolved `start()` owes exactly one
   *  `stop()`. A boolean cannot describe "a start resolved after the take that asked for
   *  it was abandoned, while a newer take holds its own reference" — and an unbalanced
   *  count is unrecoverable: the browser's recording indicator stays lit until reload. */
  let takeMeterRefs = 0;
  /** Identity of the take in flight. Every await in the take driver is resumed by a
   *  continuation that may belong to an ABANDONED take, and the phase string cannot tell
   *  them apart (an abandoned take's continuation sees a NEWER take's 'countin' and
   *  proceeds as if it were live — two sessions, one leaked meter reference). Compare
   *  this instead: it is bumped by every start and every teardown. */
  let takeSeq = 0;
  /** Playhead seconds at the instant the recorder actually started. */
  let takeStartSec = 0;
  /** performance.now() at the same instant — the duration's only honest source. */
  let takeStartedAt = 0;
  let takeTimer = 0;
  let takeCountTimer = 0;
  let takeWarned = false;
  /** Elapsed ms at the last mute re-assertion (see tickTake). */
  let lastMuteAt = 0;
  /** A re-take replaces THIS box's asset instead of inserting a new one. */
  let takeReplaceId = '';
  /** The canvas boxes this take stamped `data-t-mute` onto (and must unstamp). */
  const takeMuted = new Set<HTMLElement>();
  let noteTimer = 0;

  /**
   * Read the phase through a function, never the closed-over variable, inside the
   * async take driver: TypeScript narrows `takePhase` at the top of `startTake` and
   * cannot see that an awaited call reassigned it, so a direct comparison after an
   * await is a compile error (and, worse, would read as dead code).
   */
  const phase = (): TakePhase => takePhase;

  const now = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now() : Date.now());

  /** The manifest's audio add-kind — the seed a recorded take is born from. */
  const audioKind = (): TimelineAddKind | undefined => addKinds.find((k) => k.id === 'audio');

  /**
   * PROGRESSIVE ENHANCEMENT, deliberately not a manifest capability — the same call
   * `host.media`'s live camera makes: the button appears when the running shell can
   * actually record and the tool has somewhere to put a take, and is absent otherwise.
   * Two questions, both answered here:
   *   - `host.recorder` + `isAvailable('audio')`: can THIS SHELL capture audio at all (a
   *     CLI cannot, and neither can a browser outside a secure context);
   *   - the audio add-kind: does the tool have an audio vocabulary — with no audio kind
   *     there is no box for a take to become.
   * No permission prompt is risked by the button existing: nothing opens the mic until it
   * is pressed. Declaring `microphone` on the manifest instead would say "this tool cannot
   * run without a microphone", and other shells enforce exactly that: the TUI hides such a
   * tool from its gallery (shells/tui/src/tool-support.ts) and the CLI smoke gate skips it
   * (shells/cli/src/smoke.ts). An optional voiceover must never cost a timed tool its
   * headless support, so sequence-studio declares no capability for it.
   */
  function canRecordVoiceover(): boolean {
    const r = host.recorder;
    if (!r || typeof r.isAvailable !== 'function' || !audioKind()) return false;
    try { return r.isAvailable('audio'); } catch { return false; }
  }

  /**
   * The field on a box that carries an asset ref. See TimelinePanelOpts.assetField.
   * Memoised once found: a tool's field vocabulary cannot change under a mount, and
   * this is reached from `restyle` (every keystroke). The FALLBACK is deliberately not
   * cached — a composition with no assets yet may grow one.
   */
  let assetFieldCache = '';
  function assetFieldName(): string {
    if (opts.assetField) return opts.assetField;
    if (assetFieldCache) return assetFieldCache;
    for (const b of getBoxes()) {
      if (!b) continue;
      for (const [k, v] of Object.entries(b)) {
        if (k === cfg.idField || !v || typeof v !== 'object' || Array.isArray(v)) continue;
        const ref = v as { id?: unknown; source?: unknown; url?: unknown };
        if (typeof ref.id === 'string' && (typeof ref.source === 'string' || typeof ref.url === 'string')) {
          assetFieldCache = k;
          return k;
        }
      }
    }
    return 'image';
  }

  /** The asset ref a box carries, if any. */
  function refOf(id: string): { id?: unknown; source?: unknown; type?: unknown } | null {
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0) return null;
    const v = rows[i]![assetFieldName()];
    return v && typeof v === 'object' && !Array.isArray(v) ? v as { id?: unknown } : null;
  }

  /**
   * A box holding a previous VOICEOVER take — the one a re-take is allowed to overwrite.
   *
   * The id namespace alone is not enough: the record tool and screen capture mint their
   * takes as `user/recording/<ts>.mp4|webm` through the same `storeRecordingAsset`. Pick
   * one of those videos into a clip and the id test would offer to "record over this
   * take", turning a video clip into an audio box and DELETING the user's recording. So
   * the asset's type decides, with the live box's own media as the fallback for a ref
   * persisted without one.
   */
  function isTakeBox(id: string): boolean {
    const ref = refOf(id);
    const refId = ref?.id;
    if (typeof refId !== 'string' || !refId.startsWith('user/recording/')) return false;
    if (typeof ref?.type === 'string') return ref.type === 'audio';
    return mediaOf(id).kind === 'audio';
  }

  function setNote(msg: string): void {
    if (noteTimer) { clearTimeout(noteTimer); noteTimer = 0; }
    recNote.textContent = msg;
    recNote.hidden = !msg;
    // Transient by design: a stale error sitting in the bar reads as a current one.
    if (msg) noteTimer = setTimeout(() => { recNote.textContent = ''; recNote.hidden = true; noteTimer = 0; }, 8000) as unknown as number;
  }

  function setPhase(next: TakePhase): void {
    if (takePhase === next) return;
    takePhase = next;
    // A DOM seam rather than a callback: free-canvas may want to know one day, and a
    // jsdom test can await the take without reaching into module state.
    root.dispatchEvent(new CustomEvent('tl-take', { bubbles: true, detail: { phase: next } }));
  }

  function syncMicBtn(): void {
    if (micBtn.hidden) return;
    const live = takePhase === 'recording' || takePhase === 'countin';
    // At rest the label says what the NEXT press will do, which depends on the
    // selection: with one of our own takes selected, recording replaces it.
    const sel = takePhase === 'idle' ? selection.get() : [];
    const overTake = sel.length === 1 && !!sel[0] && isTakeBox(sel[0]);
    const label = takePhase === 'saving' ? t('Saving the take…')
      : live ? t('Stop recording')
        : overTake ? t('Record over this take') : t('Record a voiceover');
    micBtn.setAttribute('aria-label', label);
    micBtn.setAttribute('data-tip', label);
    micBtn.setAttribute('aria-pressed', live ? 'true' : 'false');
    micBtn.classList.toggle('is-recording', takePhase === 'recording');
    micBtn.disabled = takePhase === 'saving';
  }

  function paintLevel(level: AudioLevel): void {
    // dBFS, not raw amplitude: speech sits around 0.05–0.2 linear, which is invisible
    // on a linear bar. −60 dB → 0, 0 dB → full.
    const db = 20 * Math.log10(Math.max(1e-4, finite(level?.rms, 0)));
    const v = clamp((db + 60) / 60, 0, 1);
    recFill.style.width = `${Math.round(v * 100)}%`;
    rec.classList.toggle('is-hot', !!level?.clipping);
  }

  /** Silence the composition for the take, in the clock's own vocabulary (see note 2). */
  function muteComposition(): void {
    for (const el of Array.from(canvasEl.querySelectorAll<HTMLElement>('.lolly-box'))) {
      if (el.getAttribute('data-t-mute') === '1') continue;   // authored mute: leave it
      el.setAttribute('data-t-mute', '1');
      takeMuted.add(el);
    }
  }

  function restoreComposition(): void {
    for (const el of takeMuted) {
      try { el.removeAttribute('data-t-mute'); } catch { /* detached by a repaint */ }
    }
    takeMuted.clear();
  }

  /** Release `n` held meter references (all of them by default). Never releases more
   *  than are held — over-stopping would tear the mic out from under another holder. */
  function stopMeter(n = takeMeterRefs): void {
    for (let i = Math.min(n, takeMeterRefs); i > 0; i--) {
      takeMeterRefs--;
      try { host.recorder?.meter.stop(); } catch { /* already released */ }
    }
  }

  /** THE one teardown, whatever ended the take (see note 3). Idempotent. */
  function endTake(): void {
    // Anything still in flight for this take (a meter/session that opens later, a save
    // that has not committed) is now stale and must not touch the panel again.
    takeSeq++;
    if (takeTimer) { cancelAnimationFrame(takeTimer); takeTimer = 0; }
    if (takeCountTimer) { clearTimeout(takeCountTimer); takeCountTimer = 0; }
    try { takeLevelOff?.(); } catch { /* already unsubscribed */ }
    takeLevelOff = null;
    stopMeter();
    const session = takeSession;
    takeSession = null;
    // Only reachable on an abort path — stopTake() has already consumed its session.
    if (session) { try { session.cancel(); } catch { /* already released */ } }
    restoreComposition();
    takeReplaceId = '';
    takeWarned = false;
    recFill.style.width = '0%';
    recTime.textContent = '';
    rec.hidden = true;
    rec.classList.remove('is-countin', 'is-hot');
    setPhase('idle');
    syncMicBtn();
  }

  /** Abandon a take without keeping any audio. */
  function cancelTake(note?: string): void {
    if (takePhase === 'idle') return;
    const wasLive = takePhase === 'recording';
    endTake();
    if (wasLive && !disposed) { clock.pause(); syncPlayBtn(); }
    if (note) setNote(note);
    if (wasLive) announce(t('Recording cancelled'));
  }

  function failTake(err: unknown): void {
    const name = (err as { name?: string } | null)?.name || '';
    endTake();
    const msg = name === 'NotAllowedError' || name === 'SecurityError'
      ? t('Microphone blocked. Allow microphone access for this site, then try again.')
      : name === 'NotFoundError'
        ? t('No microphone found.')
        : t('Could not start recording.');
    setNote(msg);
    announce(msg, { assertive: true });
    host.log?.('warn', `timeline voiceover: ${name || String(err)}`);
  }

  /** The 3-2-1 beat. Resolves early if the take was abandoned while it ran. */
  function countIn(): Promise<void> {
    return new Promise<void>((resolve) => {
      let n = 3;
      const step = (): void => {
        takeCountTimer = 0;
        if (phase() !== 'countin' || disposed) { resolve(); return; }
        if (n <= 0) { resolve(); return; }
        recTime.textContent = String(n);
        n--;
        try { playSfx('click'); } catch { /* audio layer muted or unavailable */ }
        takeCountTimer = setTimeout(step, Math.max(0, TAKE_TIMING.countInMs)) as unknown as number;
      };
      step();
    });
  }

  /** The elapsed clock, the cap, and the mute re-assertion — one rAF loop. */
  function tickTake(): void {
    takeTimer = 0;
    if (phase() !== 'recording' || disposed) return;
    const el = now() - takeStartedAt;
    recTime.textContent = fmtTime(el / 1000);
    const left = TAKE_TIMING.maxMs - el;
    if (!takeWarned && left <= TAKE_TIMING.warnMs) {
      takeWarned = true;
      announce(t('Recording stops in 5 seconds.'), { assertive: true });
    }
    if (el >= TAKE_TIMING.maxMs) { void stopTake(); return; }
    // A repaint mid-take mints fresh box elements, which arrive unmuted. Re-silence
    // them a few times a second rather than every frame — this walks the canvas.
    if (el - lastMuteAt > 250) { lastMuteAt = el; muteComposition(); }
    takeTimer = requestAnimationFrame(tickTake);
  }

  async function startTake(): Promise<void> {
    if (takePhase !== 'idle' || disposed || !open) return;
    const recorder = host.recorder;
    if (!recorder) return;
    // This take's identity for the rest of the function. `stale()` is the ONLY correct
    // post-await guard: a continuation that fails it belongs to an abandoned take and
    // must clean up only what IT acquired — never call endTake(), which would tear down
    // whichever take is live now.
    const seq = ++takeSeq;
    const stale = (): boolean => seq !== takeSeq || disposed;
    // A re-take is decided BEFORE anything opens: exactly one selected box, and it must
    // already hold a take of ours. Anything else inserts a new box.
    const sel = selection.get();
    takeReplaceId = sel.length === 1 && sel[0] && isTakeBox(sel[0]) ? sel[0] : '';
    setNote('');
    setPhase('countin');
    rec.hidden = false;
    rec.classList.add('is-countin');
    recTime.textContent = '';
    syncMicBtn();

    // The sound check is where the PERMISSION PROMPT happens, deliberately before the
    // count-in: a denial then costs a click, not a performance. It also gives the user
    // a live level to check before the first beat.
    try {
      await recorder.meter.start();
      takeMeterRefs++;
    } catch (err) {
      // A rejected start() took no reference (the meter drops it itself). Only report
      // the failure if this take is still the live one.
      if (!stale()) failTake(err);
      return;
    }
    if (stale()) { stopMeter(1); return; }
    takeLevelOff = recorder.meter.subscribe(paintLevel);

    // A re-take performs against the same picture as the take it replaces.
    if (takeReplaceId) {
      const rows = getBoxes();
      const i = indexOfId(rows, cfg, takeReplaceId);
      const at = i >= 0 ? boxTiming(rows[i]!, cfg).start : null;
      if (at != null) clock.seek(at * 1000);
    }
    announce(t('Microphone live. Counting in.'));
    await countIn();
    if (stale()) { stopMeter(1); return; }
    if (phase() !== 'countin') { endTake(); return; }

    let session: RecordSession;
    try {
      session = await recorder.record({ audio: true, video: false, maxMs: TAKE_TIMING.maxMs });
    } catch (err) {
      if (stale()) { stopMeter(1); return; }
      failTake(err);
      return;
    }
    // Abandoned while the recorder was opening: the session exists, so release it.
    if (stale()) {
      try { session.cancel(); } catch { /* already released */ }
      stopMeter(1);
      return;
    }
    if (phase() !== 'countin') {
      try { session.cancel(); } catch { /* already released */ }
      endTake();
      return;
    }

    takeSession = session;
    setPhase('recording');
    rec.classList.remove('is-countin');
    // The raw sound-check stream has done its job; the take's own levels drive the
    // meter from here, so the second microphone reference is released immediately.
    try { takeLevelOff?.(); } catch { /* already unsubscribed */ }
    takeLevelOff = null;
    stopMeter(1);   // exactly the one reference this take took, never another holder's
    takeLevelOff = session.subscribe(paintLevel);

    takeStartSec = clock.t() / 1000;
    takeStartedAt = now();
    lastMuteAt = 0;
    muteComposition();
    if (!clock.playing()) { clock.play(); syncPlayBtn(); }
    syncMicBtn();
    announce(t('Recording. Press the microphone button again to stop.'));
    tickTake();
  }

  async function stopTake(): Promise<void> {
    if (phase() !== 'recording') return;
    const seq = takeSeq;
    const session = takeSession;
    const takeMs = Math.max(0, Math.round(now() - takeStartedAt));
    takeSession = null;
    setPhase('saving');
    if (takeTimer) { cancelAnimationFrame(takeTimer); takeTimer = 0; }
    syncMicBtn();
    setNote(t('Saving the take…'));

    let blob: Blob | null = null;
    try { blob = session ? await session.stop() : null; }
    catch (err) { host.log?.('warn', `timeline voiceover: stop failed — ${String(err)}`); }

    // Picture and sound go back to how we found them BEFORE the storage round-trip, so
    // a slow upload never leaves the composition muted and the playhead running.
    restoreComposition();
    if (!disposed) {
      clock.pause();
      syncPlayBtn();
      clock.seek(takeStartSec * 1000);   // rewind to the top of the take, ready to hear it
    }

    try { await finishTake(blob, takeMs, seq); }
    catch (err) {
      // Storage-full carries a user-ready message (assets.ts's STORAGE_FULL) and every
      // other upload in the app surfaces it verbatim — swallowing it behind "could not be
      // saved" leaves the user with no reason and no way to make room.
      // A `code` marks the user-ready ones (STORAGE_FULL and the cap errors) — the same
      // test picker.ts's upload handler uses.
      const coded = (err as { code?: unknown; message?: string } | null);
      setNote(coded?.code && coded.message ? coded.message : t('The take could not be saved.'));
      host.log?.('warn', `timeline voiceover: save failed — ${String(err)}`);
    } finally {
      // The progress note is transient state, not a result: clear it unless something
      // downstream replaced it with a real message.
      if (recNote.textContent === t('Saving the take…')) setNote('');
      endTake();
    }
  }

  async function finishTake(blob: Blob | null, takeMs: number, seq: number): Promise<void> {
    if (!blob?.size) { setNote(t('That take was empty. Nothing was recorded.')); return; }
    // MediaRecorder hands back the container it could encode, never necessarily the
    // one asked for, so read the blob rather than assuming.
    const ext: 'mp4' | 'webm' = /mp4|mpeg|m4a/i.test(blob.type || '') ? 'mp4' : 'webm';
    // Lazy, for picker.ts's own reason: it pulls in the picker CSS chunk, and a take is
    // the only thing in this panel that ever needs it.
    const { storeRecordingAsset } = await import('./picker.ts');
    const replaceId = takeReplaceId;
    const prevRef = replaceId ? refOf(replaceId)?.id : undefined;
    const prevId = typeof prevRef === 'string' ? prevRef : undefined;
    const ref = await storeRecordingAsset(
      host as unknown as Parameters<typeof storeRecordingAsset>[0],
      // NO prevId here: storeRecordingAsset deletes the asset it is handed as part of the
      // store, i.e. BEFORE the model is patched. Abandon the save between those two steps
      // (navigate away, close the panel) and the old recording is gone while the box still
      // points at it. The delete happens below, after the commit has landed.
      blob, ext, undefined, undefined,
      // The measured length, not the blob's — see note 1. This is what becomes
      // `data-audio-dur` and therefore what a trim can clamp against.
      { audio: true, durationMs: takeMs },
    );
    // The take was abandoned while the bytes were being stored (the panel closed, the
    // timeline was toggled off, destroy()). Commit nothing — an audio box arriving in a
    // panel the user has left is an undo step for a take they cancelled — and leave the
    // replaced asset alone. The orphan take is harmless; a deleted one is not.
    if (disposed || seq !== takeSeq) return;
    insertTake(ref, takeMs / 1000);
    // Committed. Only now is the superseded recording safe to drop.
    if (replaceId && prevId && prevId !== ref.id && prevId.startsWith('user/recording/')) {
      try { await host.assets?._deleteUserAsset?.(prevId); } catch { /* orphan take is harmless */ }
    }
  }

  /**
   * The take lands on the timeline — ONE commit either way (see note 4).
   *
   * A new take is born from the manifest's audio add-kind seed, placed by `moveOverlay`
   * and sized by `setDuration`, both composed on the intermediate array so the two
   * writers cost one undo step between them. A re-take patches the asset in place and
   * re-fits the length in the same array, and clears `clipIn` — a trim-in measured
   * against the OLD recording points into audio that no longer exists.
   */
  function insertTake(ref: AssetRef, durSec: number): void {
    const field = assetFieldName();
    const rows = getBoxes();
    if (takeReplaceId && indexOfId(rows, cfg, takeReplaceId) >= 0) {
      const id = takeReplaceId;
      const patched = patchBox(rows, id, { [field]: ref as unknown as Box[string], [cfg.clipInField]: 0 });
      write(setDuration(patched, cfg, id, durSec, durSec, mediaDur));
      focusedId = id;
      selectAndReveal([id]);
      announce(t('Take replaced'));
      return;
    }
    const id = mintId();
    const box: Box = {
      ...(audioKind()?.seed as Box | undefined),
      [cfg.idField]: id,
      [field]: ref as unknown as Box[string],
    };
    const placed = moveOverlay([...rows, box], cfg, id, takeStartSec);
    write(setDuration(placed, cfg, id, durSec, durSec, mediaDur));
    focusedId = id;
    selectAndReveal([id]);
    announce(t('Voiceover added to the timeline'));
  }

  /** The button: press to start, press again to stop. */
  function toggleTake(): void {
    if (takePhase === 'recording') { void stopTake(); return; }
    if (takePhase === 'countin') { cancelTake(); return; }
    if (takePhase === 'saving') return;
    void startTake();
  }

  /**
   * A backgrounded tab STOPS the take rather than dropping it: the clock pauses itself
   * on `visibilitychange`, so the picture the user was performing against is gone —
   * but the audio recorded up to that point is theirs, and losing it silently would be
   * worse than a short take. Nothing keeps running either way.
   */
  function onVisibility(): void {
    if (typeof document === 'undefined' || !document.hidden || takePhase === 'idle') return;
    if (takePhase === 'recording') void stopTake();
    else if (takePhase === 'countin') cancelTake(t('Recording cancelled: the tab went to the background.'));
  }

  // ── junction (seam) transitions ─────────────────────────────────────────────

  function openJunction(aId: string, bId: string): void {
    const boxes = getBoxes();
    const ai = indexOfId(boxes, cfg, aId);
    const bi = indexOfId(boxes, cfg, bId);
    if (ai < 0 || bi < 0) return;
    const curMs = Math.round(clamp(finite(boxes[bi]![cfg.enterMsField], 400), MIN_TRANSITION_MS, MAX_TRANSITION_MS));
    const isCut = !isTransitionKind(boxes[bi]![cfg.enterField]) || boxes[bi]![cfg.enterField] === 'none';
    // A through edit gets its own way out: this cut has changed nothing, so the useful
    // action here is not "which transition" but "put it back". Offered only where it is
    // real — the same predicate that draws the seam's hairline.
    const through = isThroughEdit(boxes, cfg, aId, bId, sameSource);
    const html = `<form method="dialog" class="tl-junction">
      <h2 class="tl-junction-title">${t('Transition between clips')}</h2>
      <div class="tl-junction-kinds">
        <button type="button" class="btn tl-junction-kind${isCut ? ' is-active' : ''}" data-act="cut">${t('Cut')}</button>
        <button type="button" class="btn tl-junction-kind${isCut ? '' : ' is-active'}" data-act="xfade">${t('Crossfade')}</button>
      </div>
      <label class="field-row field-row--inline tl-junction-dial">
        <span class="field-label">${t('Length (ms)')}</span>
        <input class="field-input tl-num" type="number" min="${MIN_TRANSITION_MS}" max="${MAX_TRANSITION_MS}" step="50" value="${curMs}" data-act="ms">
      </label>
      <div class="tl-junction-actions">${through ? `<button type="button" class="btn tl-junction-join" data-act="join">${t('Join clips')}</button>` : ''}<button type="button" class="btn btn--primary" data-act="done">${t('Done')}</button></div>
    </form>`;
    const modal = mountModal<void>(html, {
      className: 'modal tl-junction-modal',
      ariaLabel: t('Transition between clips'),
      initialFocus: (el) => el.querySelector<HTMLElement>('[data-act="xfade"]'),
    });
    const msInput = modal.el.querySelector<HTMLInputElement>('[data-act="ms"]');
    /** Live kind, read off the buttons, so Done commits what the dialog is showing. */
    const isCutNow = (): boolean => !!modal.el.querySelector('[data-act="cut"]')?.classList.contains('is-active');
    const apply = (kind: 'cut' | 'xfade'): void => {
      const ms = Math.round(clamp(finite(msInput?.value, curMs), MIN_TRANSITION_MS, MAX_TRANSITION_MS));
      const rows = getBoxes();
      // Crossfade v1 is MODEL-FREE: no overlap is stored. A.exit + B.enter both fade for
      // `ms`, straddling the cut; the compositor reads the pair. Cut clears both.
      const patched = patchBox(
        patchBox(rows, aId, kind === 'cut' ? { [cfg.exitField]: 'none' } : { [cfg.exitField]: 'fade', [cfg.exitMsField]: ms }),
        bId,
        kind === 'cut' ? { [cfg.enterField]: 'none' } : { [cfg.enterField]: 'fade', [cfg.enterMsField]: ms },
      );
      write(patched);
    };
    modal.el.addEventListener('click', (ev) => {
      const act = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'join') { modal.close(); joinAt(aId, bId); }
      else if (act === 'cut') { apply('cut'); modal.close(); }
      else if (act === 'xfade') { apply('xfade'); modal.close(); }
      else if (act === 'done') {
        // Done must COMMIT the dialog's state, not discard it: editing only the length
        // of an existing crossfade and pressing Done wrote nothing at all.
        apply(isCutNow() ? 'cut' : 'xfade');
        modal.close();
      }
    });
  }

  // ── keyboard (panel-scoped; NEVER window — free-canvas owns that channel) ────

  let hovered = false;

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (!panelKeysActive(root, document.activeElement, hovered)) return;
    const total = durationSec();
    const stepS = e.shiftKey ? 1 : FRAME_S;
    switch (e.key) {
      case ' ': case 'Spacebar': {
        // A focused <button> activates on Space by itself (click on keyup). Let it —
        // handling it here as well would toggle playback twice.
        if ((e.target as HTMLElement | null)?.closest('button')) return;
        e.preventDefault(); e.stopPropagation(); togglePlay(); return;
      }
      case 'ArrowLeft':
        e.preventDefault(); e.stopPropagation(); clock.seek(Math.max(0, clock.t() - stepS * 1000)); return;
      case 'ArrowRight':
        e.preventDefault(); e.stopPropagation(); clock.seek(Math.min(total * 1000, clock.t() + stepS * 1000)); return;
      case 'ArrowUp': case 'ArrowDown': {
        e.preventDefault(); e.stopPropagation();
        const list = Array.from(bars.keys());
        if (!list.length) return;
        const at = Math.max(0, list.indexOf(focusedId));
        const next = list[clamp(at + (e.key === 'ArrowDown' ? 1 : -1), 0, list.length - 1)]!;
        focusedId = next;
        selectAndReveal([next]);
        updateRovingTabindex();
        bars.get(next)?.focus();
        return;
      }
      case 'Home': e.preventDefault(); e.stopPropagation(); clock.seek(0); return;
      case 'End': e.preventDefault(); e.stopPropagation(); clock.seek(total * 1000); return;
      // Split: `s` cuts what is in scope (selection, else the clip under the playhead);
      // Shift+S cuts EVERY timed clip the playhead is inside, on every lane, ignoring
      // the selection. Both are one write, so both are one undo.
      case 's': case 'S':
        e.preventDefault(); e.stopPropagation();
        splitAtPlayhead(e.shiftKey ? { everything: true } : undefined); return;
      // Shift+D detaches (or re-attaches) the clip's sound. Bare letters and Shift+letter
      // are the only unclaimed key space here: every canonical NLE chord for this
      // (Cmd/Ctrl+B, Cmd/Ctrl+Shift+B, Cmd/Ctrl+K) collides with a browser binding whose
      // preventDefault is unreliable, and a shortcut that silently does nothing is worse
      // than one that has to be learned from the panel's own menu.
      case 'd': case 'D': {
        if (!e.shiftKey) return;
        e.preventDefault(); e.stopPropagation();
        const id = trimTargetId();
        if (!id) return;
        if (partnerOf(id)) reattachAudioAt(id); else detachAudioAt(id);
        return;
      }
      // Trim, from the keyboard. `[` / `]` aim at an edge; `,` / `.` walk it a frame at
      // a time (Shift: ten); `e` pulls it to the playhead. Bare letters and punctuation
      // deliberately — every canonical NLE trim chord collides with a browser binding
      // whose preventDefault() is unreliable, and a shortcut that silently does nothing
      // is worse than one the user has to learn.
      case '[': e.preventDefault(); e.stopPropagation(); focusEdge('in'); return;
      case ']': e.preventDefault(); e.stopPropagation(); focusEdge('out'); return;
      case ',': case '<':
        e.preventDefault(); e.stopPropagation();
        trimBy(-(e.shiftKey ? TRIM_SHIFT_FRAMES : 1) * FRAME_S); return;
      case '.': case '>':
        e.preventDefault(); e.stopPropagation();
        trimBy((e.shiftKey ? TRIM_SHIFT_FRAMES : 1) * FRAME_S); return;
      case 'e': case 'E': e.preventDefault(); e.stopPropagation(); trimToPlayhead(); return;
      case '+': case '=': e.preventDefault(); e.stopPropagation(); zoom(ZOOM_STEP); return;
      case '-': case '_': e.preventDefault(); e.stopPropagation(); zoom(1 / ZOOM_STEP); return;
      case 'f': case 'F': e.preventDefault(); e.stopPropagation(); fit(); return;
      case 'Delete': case 'Backspace': e.preventDefault(); e.stopPropagation(); deleteBox(); return;
      // The menu key and Shift+F10 are the platform's context-menu keys. Without them
      // "Send to timeline" / "Make always on" would be pointer-only affordances.
      case 'ContextMenu': e.preventDefault(); e.stopPropagation(); openCtxForFocused(); return;
      case 'F10': if (!e.shiftKey) return; e.preventDefault(); e.stopPropagation(); openCtxForFocused(); return;
      // The Escape LADDER, narrowest mode first: (1) an armed keyboard trim edge,
      // (2) a live take — mid-recording Escape is the "stop, I fluffed it" key, and
      // closing the panel out from under a live microphone is not what the press meant
      // — (3) the panel itself. Each rung is a mode the user entered deliberately, so
      // each one gets its own press.
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        if (focusedEdge) { focusedEdge = null; paintFocusedEdge(); return; }
        if (takePhase !== 'idle') { cancelTake(); return; }
        setOpen(false); return;
      default:
    }
  }

  function onWheel(e: WheelEvent): void {
    if (!(e.ctrlKey || e.altKey || e.metaKey)) return;
    e.preventDefault();
    const cursorPx = e.clientX - tracksRectLeft();
    zoom(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, cursorPx);
  }

  // ── wiring ──────────────────────────────────────────────────────────────────

  playBtn.addEventListener('click', togglePlay);
  // Re-click closes, the way every other disclosure in the shell behaves.
  addBtn.addEventListener('click', () => { if (addMenu.isOpen()) addMenu.close(true); else addMenu.open(); });
  micBtn.addEventListener('click', toggleTake);
  micBtn.hidden = !canRecordVoiceover();
  syncMicBtn();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  // Shift-click the blade is the pointer twin of Shift+S: cut everything the playhead
  // is inside. Same one write, same one undo step.
  splitBtn.addEventListener('click', (e) => splitAtPlayhead(e.shiftKey ? { everything: true } : undefined));
  snapBtn.addEventListener('click', () => {
    snapOn = !snapOn;
    snapBtn.setAttribute('aria-pressed', snapOn ? 'true' : 'false');
    snapBtn.classList.toggle('is-active', snapOn);
  });
  snapBtn.classList.add('is-active');
  zoomInBtn.addEventListener('click', () => zoom(ZOOM_STEP));
  zoomOutBtn.addEventListener('click', () => zoom(1 / ZOOM_STEP));
  fitBtn.addEventListener('click', fit);

  laneWrap.addEventListener('click', (e) => {
    const seam = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tl-seam');
    if (seam) { openJunction(seam.dataset.a || '', seam.dataset.b || ''); return; }
    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tl-chip');
    if (chip?.dataset.id) selectAndReveal([chip.dataset.id]);
  });
  scenery.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    // The `+` half of the pill promotes straight from the strip — no need to select
    // first and then find a field. One commit, exactly like the inspector route.
    const add = target?.closest<HTMLElement>('.tl-chip-add');
    if (add?.dataset.id) { promote(add.dataset.id); return; }
    const chip = target?.closest<HTMLElement>('.tl-chip');
    if (chip?.dataset.id) selectAndReveal([chip.dataset.id]);
  });
  laneWrap.addEventListener('dblclick', (e) => {
    const at = timeAt((e as MouseEvent).clientX);
    const j = junctionAt(getBoxes(), cfg, at, pxPerSec);
    if (j) openJunction(j.aId, j.bId);
  });

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerCancel);
  // A capture lost to a browser gesture (or a pointerup the panel never saw) would
  // otherwise leave `gesture` set forever, which silently turns scheduleSync and the
  // ResizeObserver refit into permanent no-ops.
  root.addEventListener('lostpointercapture', onPointerCancel);
  root.addEventListener('keydown', onKey);
  root.addEventListener('contextmenu', onContextMenu);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('pointerenter', () => { hovered = true; });
  root.addEventListener('pointerleave', () => { hovered = false; });
  tracks.addEventListener('scroll', () => { rulerInner.style.transform = `translateX(${-tracks.scrollLeft}px)`; }, { passive: true });
  // Only touchmove is non-passive — it is the one that has to preventDefault the pan.
  tracks.addEventListener('touchstart', onTouchStart, { passive: true });
  tracks.addEventListener('touchmove', onTouchMove, { passive: false });
  tracks.addEventListener('touchend', onTouchEnd, { passive: true });
  tracks.addEventListener('touchcancel', onTouchEnd, { passive: true });

  const unsubRuntime = runtime.subscribe(() => { scheduleSync(); });
  const unsubSelection = selection.onChange(() => {
    if (disposed || !open) return;
    restyle(getBoxes());
  });
  /**
   * `tl-time` — the panel→canvas half of the one rule's seam (free-canvas.ts's header).
   * Same CustomEvent-on-the-stage pattern as `tl-add` / `tl-take`, deliberately: the
   * canvas needs to repaint its chrome when the set of ON-SCREEN boxes changes, and it
   * must NOT repaint sixty times a second while a clip merely plays through.
   *
   * So the fire is gated on a string signature of (playing, active ids). A tick inside
   * one clip produces the same string and costs one comparison; a cut, a seek across a
   * boundary, or pressing play produces a new one and fires exactly once.
   */
  let lastTimeKey = '\u0000';       // unmatchable, so the first tick always announces
  function emitTime(tMs: number): void {
    if (disposed) return;
    const playing = clock.playing();
    const activeIds = activeIdsAt(getBoxes(), tMs / 1000);
    const key = `${playing ? 1 : 0}|${activeIds.join(',')}`;
    if (key === lastTimeKey) return;
    lastTimeKey = key;
    root.dispatchEvent(new CustomEvent('tl-time', { bubbles: true, detail: { atMs: tMs, activeIds, playing } }));
  }
  const unsubTick = clock.onTick((tMs) => { updatePlayhead(tMs); syncPlayBtn(); emitTime(tMs); });

  /**
   * `fc-seek` — the canvas→panel half. The off-playhead banner's "Go to it" asks for a
   * time; the clock is ours, so the seek is ours. Untrusted detail (anything can
   * dispatch a CustomEvent), hence the finite/non-negative coercion.
   */
  function onFcSeek(e: Event): void {
    if (disposed) return;
    const d = (e as CustomEvent).detail as { atMs?: unknown } | null | undefined;
    const raw = typeof d?.atMs === 'number' ? d.atMs : Number.NaN;
    clock.seek(Number.isFinite(raw) ? Math.max(0, raw) : 0);
  }
  stageEl.addEventListener('fc-seek', onFcSeek);
  /**
   * A thumbnail shot has to un-hide an off-playhead box (see clip-thumbs' node section)
   * and puts `.seq-off` back when it is done — but that restore is a GUESS taken up to
   * a second and a half earlier, and the user may have scrubbed onto that very box in
   * the meantime, leaving the ACTIVE frame `display:none` until the next seek. The
   * clock is the only authority on which boxes are on screen, so it gets the last word
   * after every shot. Cheap: `reapply()` is one pass of class/style writes, and this
   * only fires for a box that actually carried the class.
   */
  const unsubShot = onNodeShotSettled(() => {
    if (disposed) return;
    try { clock.reapply(); } catch { /* the clock is gone; the panel is going with it */ }
  });

  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (open && !gesture) { restyle(getBoxes()); updatePlayhead(clock.t()); } })
    : null;
  ro?.observe(stageEl);

  // ── open / close / destroy ──────────────────────────────────────────────────

  function setOpen(next: boolean): void {
    if (disposed || next === open) return;
    open = next;
    root.hidden = !open;
    if (open) {
      const stageH = stageEl.getBoundingClientRect().height || 0;
      panelH = clampPanelH(panelH, stageH, chromeH());
      root.style.height = `${panelH}px`;
      reserve(panelH + RESERVE_PAD);
      lastKey = '\u0000';
      fitPending = true;
      sync();
      clock.reapply();
      root.focus?.();
    } else {
      // A hidden panel has no visible mic button, no meter and no elapsed clock, so a
      // take cannot survive the close: the microphone would stay open with nothing on
      // screen to say so.
      cancelTake();
      // End any gesture FIRST: Escape is reachable mid-drag, and a live resize keeps
      // calling reserve() on every subsequent pointermove — leaving the artboard
      // shrunk behind a hidden panel until the tool is destroyed.
      endGesture(gesture);
      // The menus are body-mounted, so hiding the panel does not hide them.
      addMenu.close();
      ctxMenu.close();
      clock.pause();
      syncPlayBtn();   // a paused clock emits no ticks, so project the state now
      abortThumbs();
      cancelIdle?.();
      cancelIdle = null;
      reserve(0);
    }
  }

  function destroy(): void {
    if (disposed) return;
    // BEFORE `disposed` flips: cancelTake's teardown is deliberately allowed to touch
    // the clock, and a take that outlived the panel is a microphone nobody can stop.
    cancelTake();
    disposed = true;
    if (noteTimer) { clearTimeout(noteTimer); noteTimer = 0; }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    endGesture(gesture);
    // Body-mounted: these outlive root.remove() unless they are closed explicitly.
    try { addMenu.close(); } catch { /* never opened */ }
    try { ctxMenu.close(); } catch { /* never opened */ }
    try { clock.pause(); } catch { /* already gone */ }
    abortThumbs();
    cancelIdle?.();
    cancelIdle = null;
    try { unsubShot(); } catch { /* already gone */ }
    // The decoded pictures outlive the panel otherwise: nothing else in the web shell
    // consumes this cache (picker.ts imports `onIdle` alone), so up to CACHE_LIMIT
    // ImageBitmaps — filmstrips of dozens each, plus every frame's node raster — would
    // sit there with no DOM referencing them until some other editor happened to evict
    // them. Also detaches the probe <video> and closes the decode context.
    try { releaseClipThumbs(); } catch { /* nothing decoded this session */ }
    try { unsubTick(); } catch { /* already gone */ }
    try { unsubSelection?.(); } catch { /* already gone */ }
    try { unsubRuntime?.(); } catch { /* already gone */ }
    try { ro?.disconnect(); } catch { /* already gone */ }
    try { stageEl.removeEventListener('fc-seek', onFcSeek); } catch { /* stage detached */ }
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerup', onPointerUp);
    root.removeEventListener('pointercancel', onPointerCancel);
  root.removeEventListener('lostpointercapture', onPointerCancel);
    root.removeEventListener('keydown', onKey);
    root.removeEventListener('contextmenu', onContextMenu);
    root.removeEventListener('wheel', onWheel);
    tracks.removeEventListener('touchstart', onTouchStart);
    tracks.removeEventListener('touchmove', onTouchMove);
    tracks.removeEventListener('touchend', onTouchEnd);
    tracks.removeEventListener('touchcancel', onTouchEnd);
    try { clock.destroy(); } catch { /* already gone */ }
    reserve(0);
    root.remove();
    bars.clear();
    chips.clear();
    host.log?.('debug', 'timeline panel destroyed');
  }

  return { destroy, setOpen, isOpen: () => open, promote, demote };
}

/**
 * Repack the seq row — exposed for free-canvas's create path, which drops a new clip
 * onto the magnetic lane and needs it gapless before the next paint. Thin on purpose:
 * the arithmetic is timeline-math's.
 */
export function packSeqRow(boxes: Box[], cfg: TimeCfg): Box[] {
  return packSeq(boxes, cfg);
}
