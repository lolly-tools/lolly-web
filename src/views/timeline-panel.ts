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
 *     splitBox / snapTime / deriveDuration / fmtTime). The panel converts pixels to
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
 * `onTick` to move a line. Filmstrips/waveforms come from ../lib/clip-thumbs.ts, whose
 * cache OWNS the returned ImageBitmaps — so every bitmap is drawn into the bar's own
 * <canvas> SYNCHRONOUSLY on receipt and never retained across an await or a repaint.
 *
 * Repaint law (the chromeKey precedent): a full row rebuild happens only when the box
 * SET or a lane assignment changes (`tracksKey`). Everything else — dragging, trimming,
 * zooming, scrolling, the playhead — is style writes against a cached `pxPerSec`.
 */

import { t } from '../i18n.ts';
import { icon } from '../lib/icons.ts';
import { announce } from '../a11y.ts';
import { mountModal } from '../components/modal.ts';
import { filmstrip, peaks, onIdle } from '../lib/clip-thumbs.ts';
import { TRANSITIONS, TRANSITION_KINDS, isTransitionKind } from '../lib/transitions.ts';
import { MAX_TRANSITION_MS, MIN_TRANSITION_MS, createSequenceClock, type SequenceClock } from './sequence-clock.ts';
import {
  DEFAULT_CLIP_S, MAX_TIME_S, MIN_DUR, SNAP_PX,
  boxTiming, deriveDuration, fmtTime, indexOfId, isTimed,
  dropIndexAt, moveOverlay, moveSeqClip, packSeq, removeAndRipple, rippleOverlays, seqBoxes,
  setClipIn, setDuration, setSpeed,
  snapTime, splitBox, trimClip,
  type Box, type MediaDurFn, type TimeCfg,
} from './timeline-math.ts';
import '../styles/parts/timeline.css';

// ── local structural types (kept minimal so free-canvas can pass its own objects) ──

/** Just the slice of the tool runtime the panel needs: repaint notifications. */
export interface TimelineRuntime {
  subscribe(fn: () => void): (() => void) | void;
}

/** Just the slice of the host bridge the panel needs. */
export interface TimelineHost {
  log?(level: string, msg: string): void;
}

/** The canvas selection seam, threaded from free-canvas (selection is keyed by box id). */
export interface TimelineSelection {
  get(): string[];
  set(ids: string[]): void;
  onChange(cb: () => void): () => void;
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
}

export interface TimelinePanel {
  destroy(): void;
  setOpen(open: boolean): void;
  isOpen(): boolean;
}

// ── tunables ──────────────────────────────────────────────────────────────────

/** Panel height floor, px (§2 docking clamp). */
export const MIN_PANEL_H = 112;
/** Panel height on first open, px. Session-local; never persisted. */
export const DEFAULT_PANEL_H = 190;
/** Gap between the reserved band and the fitted canvas (the deck-editor's +6). */
export const RESERVE_PAD = 6;
/** Zoom floor/ceiling and the per-click step. */
export const MIN_PPS = 4;
export const MAX_PPS = 600;
export const ZOOM_STEP = 1.25;
/** Edge-trim hit zone, px each side (§3.2 asks for ~8). */
export const EDGE_PX = 8;
/** Seam (junction) hit zone, px each side. */
export const SEAM_PX = 8;
/** Arrow-key step: one frame at 30fps; Shift steps a whole second. */
export const FRAME_S = 1 / 30;
/** Filmstrip frames are never packed tighter than this, px. */
const MIN_FRAME_PX = 40;

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
  const node = el as HTMLElement;
  if (node.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName || '');
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

/** Clamp a dragged panel height into the docking range ([112, half the stage]). */
export function clampPanelH(h: number, stageH: number): number {
  const hi = Math.max(MIN_PANEL_H, Math.floor(finite(stageH, 0) * 0.5));
  return clamp(Math.round(finite(h, MIN_PANEL_H)), MIN_PANEL_H, hi);
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
  edge?: 'in' | 'out';
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
  kind: 'video' | 'audio' | 'image' | '';
  dur: number | null;
}

export function initTimelinePanel(opts: TimelinePanelOpts): TimelinePanel {
  const { stageEl, canvasEl, runtime, host, blockId, cfg, getBoxes, commit, selection, onDirty, reserve } = opts;

  let open = false;
  let disposed = false;
  let panelH = DEFAULT_PANEL_H;
  let pxPerSec = 60;
  let fitPending = true;
  let gesture: Gesture | null = null;
  let lastKey = '\u0000';           // deliberately unmatchable, so the first sync rebuilds
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
  // Glyphs: registry icons where lib/icons.ts has one, and a CSS-drawn `.tl-glyph`
  // where it does not (pause / scissors / plus). A hand-inlined 24×24 <svg> here would
  // trip the R3 primitive guard, and adding to the registry is another agent's file.
  const glyph = (name: string): string => `<span class="tl-glyph" data-glyph="${name}" aria-hidden="true"></span>`;

  const playBtn = btn('tl-play', t('Play'), icon('play'));
  const timeEl = document.createElement('span');
  timeEl.className = 'tl-time';
  timeEl.setAttribute('aria-live', 'off');

  const splitBtn = btn('tl-split', t('Split at playhead'), glyph('scissors'));
  const snapBtn = btn('tl-snap', t('Snap to edges'), icon('pin'));
  snapBtn.setAttribute('aria-pressed', 'true');
  const zoomOutBtn = btn('tl-zoom-out', t('Zoom out'), icon('minus'));
  const zoomInBtn = btn('tl-zoom-in', t('Zoom in'), glyph('plus'));
  const fitBtn = btn('tl-fit', t('Fit to view'), icon('resize'));

  const transport = document.createElement('div');
  transport.className = 'tl-transport';
  transport.append(playBtn, timeEl);
  const tools = document.createElement('div');
  tools.className = 'tl-tools';
  tools.append(splitBtn, snapBtn, zoomOutBtn, zoomInBtn, fitBtn);
  const inspector = document.createElement('div');
  inspector.className = 'tl-inspector';
  bar.append(transport, tools, inspector);

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
  inner.append(laneWrap, scenery, playhead, snapline);
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
  function patchBox(boxes: Box[], id: string, patch: Record<string, string | number>): Box[] {
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
   * A box's media, read from the LIVE CANVAS rather than the model: the hook has already
   * resolved the asset ref to a URL there, and a decoded <video> also knows its real
   * duration — which is exactly what trimClip's media clamp wants.
   */
  function mediaOf(id: string): BoxMedia {
    const el = boxEl(id);
    if (!el) return { url: '', kind: '', dur: null };
    const audio = el.querySelector<HTMLElement>('.lolly-box-audio[data-audio-src]');
    if (audio) return { url: audio.getAttribute('data-audio-src') || '', kind: 'audio', dur: null };
    const video = el.querySelector<HTMLVideoElement>('video.lolly-box-video');
    if (video) {
      const d = Number(video.duration);
      return { url: video.currentSrc || video.src || '', kind: 'video', dur: Number.isFinite(d) && d > 0 ? d : null };
    }
    const img = el.querySelector<HTMLImageElement>('img.lolly-box-img');
    if (img) return { url: img.currentSrc || img.src || '', kind: 'image', dur: null };
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
      slot.addEventListener('click', () => {
        // free-canvas owns the add-kind pipeline; ask for a clip rather than reaching in.
        root.dispatchEvent(new CustomEvent('tl-add-clip', { bubbles: true }));
      });
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
        add.innerHTML = glyph('plus');
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
      el.classList.toggle('is-muted', b[cfg.muteField] === true || b[cfg.muteField] === 'true');
      el.setAttribute('aria-selected', isSel ? 'true' : 'false');
      el.dataset.kind = mediaOf(id).kind || (seqSet.has(id) ? 'clip' : 'overlay');
      el.title = `${text} · ${fmtTime(start)} → ${fmtTime(start + dur)}`;
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
    }
    inner.style.width = `${Math.max(tracks.clientWidth, timeToPx(total, pxPerSec) + 24)}px`;
    updateRuler(total);
    updateRovingTabindex();
    renderInspector(boxes);
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
   *   • LENGTH, when the caller does not name one, is the box's own media duration when
   *     the live canvas knows it (a video or audio box plays in full), else
   *     DEFAULT_CLIP_S — the same 3 s the magnetic pack hands a clip it cannot measure,
   *     so a promoted box and a packed one never disagree.
   *   • The box lands on an OVERLAY lane, never on the magnetic seq row: seq membership
   *     is a separate, deliberate choice (it repacks the whole row), and silently
   *     joining the spine because someone typed a start would move other clips.
   *
   * NO clamping arithmetic lives here. `moveOverlay` owns the start clamp and the
   * millisecond grid; `setDuration` owns the length clamp and the media fit. Both are
   * pure, so composing them on the intermediate array is ONE undo step, not two — and
   * a promoted start lands on exactly the value a drag to the same time would.
   */
  function promote(id: string, want?: { start?: number; dur?: number }): void {
    const rows = getBoxes();
    if (!id || indexOfId(rows, cfg, id) < 0) return;
    const media = mediaOf(id).dur;
    const start = want?.start ?? clock.t() / 1000;
    const dur = want?.dur ?? (media != null ? media : DEFAULT_CLIP_S);
    write(setDuration(moveOverlay(rows, cfg, id, start), cfg, id, dur, media, mediaDur));
    focusedId = id;
    selection.set([id]);
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
    selection.set([id]);
    announce(t('Now always on'));
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

  function scheduleThumbs(): void {
    cancelIdle?.();
    cancelIdle = null;
    abortThumbs();
    if (!open || disposed) return;
    const ac = new AbortController();
    thumbAbort = ac;
    cancelIdle = onIdle(() => {
      cancelIdle = null;
      if (ac.signal.aborted || disposed) return;
      // READ every bar's box first, THEN paint. Interleaving clientWidth reads with
      // canvas size writes forces one synchronous layout per bar.
      const sizes: Array<[string, HTMLElement, number, number]> = [];
      for (const [id, el] of bars) sizes.push([id, el, el.clientWidth, el.clientHeight]);
      for (const [id, el, w, h] of sizes) paintThumbs(id, el, w, h, ac.signal);
    }, 400);
  }

  function abortThumbs(): void {
    thumbAbort?.abort();
    thumbAbort = null;
  }

  function paintThumbs(id: string, el: HTMLElement, w: number, h: number, signal: AbortSignal): void {
    const cv = el.querySelector<HTMLCanvasElement>('canvas.tl-clip-thumbs');
    if (!cv) return;
    if (!(w > 8) || !(h > 8)) return;
    const media = mediaOf(id);
    if (!media.url) return;
    const dpr = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1));
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    if (media.kind === 'audio') {
      const buckets = Math.max(8, Math.min(600, Math.round(w / 2)));
      peaks(media.url, buckets, signal).then((data) => {
        if (signal.aborted || !data.length) return;
        // Synchronous draw on receipt — the array is cache-owned, never mutated or kept.
        ctx.clearRect(0, 0, w, h);
        // Canvas 2D has no `currentColor` — assigning it is silently IGNORED and the
        // waveform paints default black, invisible on a dark clip. Resolve the cascade
        // to a real colour instead, so the bars follow the theme like every other mark.
        ctx.fillStyle = (typeof getComputedStyle === 'function' ? getComputedStyle(el).color : '') || '#888';
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
    if (media.kind !== 'video') return;
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    const timing = i >= 0 ? boxTiming(rows[i]!, cfg) : null;
    const clipIn = timing?.clipIn ?? 0;
    const out = clipIn + (timing?.dur ?? 0) * (timing?.speed ?? 1);
    filmstrip(media.url, { count: frameCountFor(w), h, clipInSec: clipIn, clipOutSec: out }, signal).then((frames) => {
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
    if (key !== lastKey) {
      lastKey = key;
      rebuild(boxes);
      scheduleThumbs();
    } else {
      restyle(boxes);
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

  /** Snap a raw time unless Alt is held (the universal bypass). */
  function maybeSnap(raw: number, alt: boolean, excludeId?: string): number {
    if (!snapOn || alt) { showSnapline(null); return raw; }
    const cands = snapCandidates(getBoxes(), cfg, clock.t() / 1000, raw, excludeId);
    const r = snapTime(raw, cands, pxPerSec, SNAP_PX);
    showSnapline(r.snapped);
    return r.t;
  }

  function beginGesture(e: PointerEvent, g: Omit<Gesture, 'x' | 'y' | 'moved' | 'alt' | 'pointerId'>): void {
    gesture = { ...g, x: e.clientX, y: e.clientY, moved: false, alt: e.altKey, pointerId: e.pointerId };
    abortThumbs();
    try { (g.el ?? root).setPointerCapture(e.pointerId); } catch { /* jsdom / no capture */ }
    root.classList.add('is-dragging');
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
    if (e.shiftKey) selection.set(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
    else if (!cur.includes(id) || cur.length !== 1) selection.set([id]);
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
    const edge: 'in' | 'out' | null = e.clientX - rect.left <= EDGE_PX
      ? 'in'
      : rect.right - e.clientX <= EDGE_PX ? 'out' : null;

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

  /** Live preview — PANEL DOM ONLY. The model is untouched until pointerup. */
  function paintGesture(g: Gesture): void {
    if (g.kind === 'resize') {
      const stageH = stageEl.getBoundingClientRect().height || 0;
      panelH = clampPanelH(g.h0 + (g.y0 - g.y), stageH);
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
    const previewSpan = (rows: Box[]): void => {
      const i = indexOfId(rows, cfg, g.id);
      if (i < 0) return;
      const { start, dur } = span(rows[i]!, durationSec());
      applyBarGeometry(el, start, dur);
    };
    if (g.kind === 'move') {
      previewSpan(moveOverlay(getBoxes(), cfg, g.id, maybeSnap(g.start0 + deltaSec, g.alt, g.id)));
      return;
    }
    if (g.kind === 'trim') {
      const raw = g.edge === 'in' ? g.start0 + deltaSec : g.start0 + g.dur0 + deltaSec;
      const snapped = maybeSnap(raw, g.alt, g.id);
      const d = g.edge === 'in' ? snapped - g.start0 : snapped - (g.start0 + g.dur0);
      previewSpan(trimClip(getBoxes(), cfg, g.id, g.edge ?? 'out', d, mediaOf(g.id).dur, mediaDur));
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
   *   • the pointer capture.
   * It also replays a model change that arrived mid-gesture and was dropped.
   */
  function endGesture(g: Gesture | null): void {
    gesture = null;
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
    for (const node of bars.values()) node.classList.remove('is-drop-target');
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
      write(trimClip(boxes, cfg, g.id, g.edge ?? 'out', d, mediaOf(g.id).dur, mediaDur));
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
    playBtn.innerHTML = on ? glyph('pause') : icon('play');
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

  function fit(): void {
    pxPerSec = fitPxPerSec(durationSec(), tracks.clientWidth);
    abortThumbs();
    restyle(getBoxes());
    tracks.scrollLeft = 0;
    updatePlayhead(clock.t());
    scheduleThumbs();
  }

  /** Split the selected clip (else the seq clip under the playhead) at the playhead. */
  function splitAtPlayhead(): void {
    const boxes = getBoxes();
    const at = clock.t() / 1000;
    const sel = selection.get().filter((id) => bars.has(id));
    let id = sel.length === 1 ? sel[0]! : '';
    if (!id) {
      for (const b of seqBoxes(boxes, cfg)) {
        const timing = boxTiming(b, cfg);
        const s = timing.start ?? 0;
        if (timing.dur !== null && at > s && at < s + timing.dur) { id = String(b[cfg.idField] ?? ''); break; }
      }
    }
    if (!id) { announce(t('Nothing to split at the playhead')); return; }
    const next = splitBox(boxes, cfg, id, at, mintId);
    if (!next) { announce(t('Move the playhead inside a clip to split it')); return; }
    write(next);
    // Select the right-hand half — it is the row immediately after the original.
    const i = indexOfId(next, cfg, id);
    const b = i >= 0 ? next[i + 1] : null;
    const bId = b ? String(b[cfg.idField] ?? '') : '';
    if (bId) selection.set([bId]);
    announce(t('Clip split'));
  }

  /** Ids are the tool's contract; mint one that cannot collide with an existing row. */
  function mintId(): string {
    const used = new Set(getBoxes().map((b) => String(b?.[cfg.idField] ?? '')));
    let n = used.size + 1;
    let id = `b${n}`;
    while (used.has(id)) { n++; id = `b${n}`; }
    return id;
  }

  function deleteFocused(): void {
    const id = focusedId || selection.get()[0] || '';
    if (!id || !bars.has(id)) return;
    // Hand focus to a neighbour rather than nowhere: `updateRovingTabindex` re-picks
    // when the id is gone, and rebuild() restores focus onto whatever it picked.
    const order = Array.from(bars.keys());
    const at = order.indexOf(id);
    focusedId = order[at + 1] || order[at - 1] || '';
    write(removeAndRipple(getBoxes(), cfg, id, mediaDur));
    selection.set(focusedId ? [focusedId] : []);
    announce(t('Clip removed'));
  }

  // ── junction (seam) transitions ─────────────────────────────────────────────

  function openJunction(aId: string, bId: string): void {
    const boxes = getBoxes();
    const ai = indexOfId(boxes, cfg, aId);
    const bi = indexOfId(boxes, cfg, bId);
    if (ai < 0 || bi < 0) return;
    const curMs = Math.round(clamp(finite(boxes[bi]![cfg.enterMsField], 400), MIN_TRANSITION_MS, MAX_TRANSITION_MS));
    const isCut = !isTransitionKind(boxes[bi]![cfg.enterField]) || boxes[bi]![cfg.enterField] === 'none';
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
      <div class="tl-junction-actions"><button type="button" class="btn btn--primary" data-act="done">${t('Done')}</button></div>
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
      if (act === 'cut') { apply('cut'); modal.close(); }
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
        selection.set([next]);
        updateRovingTabindex();
        bars.get(next)?.focus();
        return;
      }
      case 'Home': e.preventDefault(); e.stopPropagation(); clock.seek(0); return;
      case 'End': e.preventDefault(); e.stopPropagation(); clock.seek(total * 1000); return;
      case 's': case 'S': e.preventDefault(); e.stopPropagation(); splitAtPlayhead(); return;
      case '+': case '=': e.preventDefault(); e.stopPropagation(); zoom(ZOOM_STEP); return;
      case '-': case '_': e.preventDefault(); e.stopPropagation(); zoom(1 / ZOOM_STEP); return;
      case 'f': case 'F': e.preventDefault(); e.stopPropagation(); fit(); return;
      case 'Delete': case 'Backspace': e.preventDefault(); e.stopPropagation(); deleteFocused(); return;
      case 'Escape': e.preventDefault(); e.stopPropagation(); setOpen(false); return;
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
  splitBtn.addEventListener('click', splitAtPlayhead);
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
    if (chip?.dataset.id) selection.set([chip.dataset.id]);
  });
  scenery.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    // The `+` half of the pill promotes straight from the strip — no need to select
    // first and then find a field. One commit, exactly like the inspector route.
    const add = target?.closest<HTMLElement>('.tl-chip-add');
    if (add?.dataset.id) { promote(add.dataset.id); return; }
    const chip = target?.closest<HTMLElement>('.tl-chip');
    if (chip?.dataset.id) selection.set([chip.dataset.id]);
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
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('pointerenter', () => { hovered = true; });
  root.addEventListener('pointerleave', () => { hovered = false; });
  tracks.addEventListener('scroll', () => { rulerInner.style.transform = `translateX(${-tracks.scrollLeft}px)`; }, { passive: true });

  const unsubRuntime = runtime.subscribe(() => { scheduleSync(); });
  const unsubSelection = selection.onChange(() => {
    if (disposed || !open) return;
    restyle(getBoxes());
  });
  const unsubTick = clock.onTick((tMs) => { updatePlayhead(tMs); syncPlayBtn(); });

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
      panelH = clampPanelH(panelH, stageH);
      root.style.height = `${panelH}px`;
      reserve(panelH + RESERVE_PAD);
      lastKey = '\u0000';
      fitPending = true;
      sync();
      clock.reapply();
      root.focus?.();
    } else {
      // End any gesture FIRST: Escape is reachable mid-drag, and a live resize keeps
      // calling reserve() on every subsequent pointermove — leaving the artboard
      // shrunk behind a hidden panel until the tool is destroyed.
      endGesture(gesture);
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
    disposed = true;
    endGesture(gesture);
    try { clock.pause(); } catch { /* already gone */ }
    abortThumbs();
    cancelIdle?.();
    cancelIdle = null;
    try { unsubTick(); } catch { /* already gone */ }
    try { unsubSelection?.(); } catch { /* already gone */ }
    try { unsubRuntime?.(); } catch { /* already gone */ }
    try { ro?.disconnect(); } catch { /* already gone */ }
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerup', onPointerUp);
    root.removeEventListener('pointercancel', onPointerCancel);
  root.removeEventListener('lostpointercapture', onPointerCancel);
    root.removeEventListener('keydown', onKey);
    root.removeEventListener('wheel', onWheel);
    try { clock.destroy(); } catch { /* already gone */ }
    reserve(0);
    root.remove();
    bars.clear();
    chips.clear();
    host.log?.('debug', 'timeline panel destroyed');
  }

  return { destroy, setOpen, isOpen: () => open };
}

/**
 * Repack the seq row — exposed for free-canvas's create path, which drops a new clip
 * onto the magnetic lane and needs it gapless before the next paint. Thin on purpose:
 * the arithmetic is timeline-math's.
 */
export function packSeqRow(boxes: Box[], cfg: TimeCfg): Box[] {
  return packSeq(boxes, cfg);
}
