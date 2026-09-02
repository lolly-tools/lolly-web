// SPDX-License-Identifier: MPL-2.0
/**
 * timeline-panel.ts - the docked timeline editor for a `boxes` block that carries the
 * phase-1 time model (plans/53-fable-timeline-phase-2.md section 2).
 *
 * Three hard rules shape everything below, and every one of them exists because the
 * alternative has already bitten this codebase:
 *
 *  1. NO EDITING ARITHMETIC LIVES HERE. Every model mutation goes through
 *     ./timeline-math.ts (packSeq / moveSeqClip / removeAndRipple / trimClip /
 *     splitAll / joinClips / detachAudio / reattachAudio / snapTime / deriveDuration /
 *     fmtTime). The panel converts pixels to
 *     seconds and hands seconds to that module. If a gesture needs a new clamp, the
 *     clamp belongs in timeline-math beside the one it must agree with - never
 *     re-derived here, where it would silently drift from the tool hook.
 *  2. THE MODEL IS WRITTEN EXACTLY ONCE PER GESTURE. While a pointer is down the panel
 *     mutates only its OWN DOM (bar left/width, playhead, snapline). `commit()` fires
 *     on pointerup, yielding one coalesced undo step - identical to the canvas gesture
 *     contract. `runtime.setInput` is never called mid-drag.
 *  3. KEYS ARE BOUND ON THE PANEL ROOT, never on window. free-canvas.ts already owns
 *     the window keydown channel (Delete/arrows/Escape on the selected boxes); a second
 *     window listener would fight it. The containment guard (`panelKeysActive`) is the
 *     page-filmstrip.ts pattern, exported so it is unit-testable.
 *
 * The playhead is NOT ours: ./sequence-clock.ts owns time, reads timing only from the
 * live canvas DOM, and never writes the model. The panel asks it to seek and listens to
 * `onTick` to move a line. Filmstrips/waveforms/stills come from ../lib/clip-thumbs.ts,
 * whose cache OWNS the returned ImageBitmaps - so every bitmap is drawn into the bar's
 * own <canvas> SYNCHRONOUSLY on receipt and never retained across an await or a repaint.
 * EVERY bar gets a picture: a filmstrip, a waveform, one tiled still (image / Lottie /
 * tool clip), or - with no media at all - a photograph of the box itself (a frame, a
 * card, a text box, a pen shape), over its own fill as the immediate underlay. That
 * last mode is the expensive one, so it is budgeted per pass and cached by APPEARANCE
 * rather than by identity; see `thumbMode` / `canRasterBox` / `appearanceSig` below.
 *
 * Repaint law (the chromeKey precedent): a full row rebuild happens only when the box
 * SET or a lane assignment changes (`tracksKey`). Everything else - dragging, trimming,
 * zooming, scrolling, the playhead - is style writes against a cached `pxPerSec`.
 */

import { t, tRaw } from '../i18n.ts';
import { icon, type IconName } from '../lib/icons.ts';
import { announce } from '../a11y.ts';
import { playSfx } from '../lib/sfx.ts';
import { edgeDockWidth } from '../lib/edge-dock.ts';
import { mountModal, type ModalHandle } from '../components/modal.ts';
import { mountBodyPopover, pointAnchor, type PopoverAnchor } from '../components/body-popover.ts';
import {
  filmstrip, frameAt, peaks, stillFrames, nodeStill, nodeKey, peekNodeRaster, nodeRasterPending,
  nodeRasterFailed, onNodeShotSettled, releaseClipThumbs, onIdle, svgMarkup, withBorrowedVisibility,
  setAuthoredPoseSeam, MAX_NODE_RASTER_NODES,
} from '../lib/clip-thumbs.ts';
// The vector twin vocabulary. Imported for its markup builders ONLY: the panel must
// never gain a static edge to bridge/export.ts (vector-paint imports nothing at all,
// which is why the shared pieces live there), so the two twins that DO need the walker
// reach it through a dynamic import inside the producer.
import {
  escXml, n3, parseSvgRoot, rectBody, stillTilePx, svgDoc, tileBody, waveformPathD,
  type VectorTwin, type VectorTwinCanvas,
} from '../lib/vector-paint.ts';
import {
  TRANSITIONS, TRANSITION_KINDS, DEFAULT_TRANSITION, isTransitionKind, EASINGS, easingToWire,
  SPLIT_TIERS, SPLIT_ORDERS, isSplitTier, isSplitOrder, MAX_SPLIT_STAGGER_MS,
  HOLD_FX, isHoldFx, MIN_HOLD_RATE, MAX_HOLD_RATE,
} from '../lib/transitions.ts';
// The keyframe wire's own vocabulary. The panel does EDITING GLUE only - every keyframe
// NUMBER comes from the engine module or from timeline-math's kf* primitives, and what
// is imported here is exactly the vocabulary a control has to speak to offer a choice:
// the preset tokens the ease picker lists, the two adapters that carry one token to and
// from the shared easing editor's CSS wire, and `parseKf` for "how many poses are on
// this track" - never a `split('*')` of its own.
import {
  KF_CAMERA_CHANNELS, KF_CLAMPS, KF_EASE_TOKENS, KF_HOLD_EASE, KF_Z_FIELD_CLAMP,
  kfEaseCss, kfEaseName, kfEaseToken, parseKf,
} from '../../../../engine/src/keyframes.ts';
import type { KfChannel, KfPose, KfTrack } from '../../../../engine/src/keyframes.ts';
import { mountEasingEditor, type EasingEditorHandle } from '../components/easing-editor.ts';
import {
  MAX_TRANSITION_MS, MIN_TRANSITION_MS, createSequenceClock,
  authoredStyleOf, borrowAuthoredPose,
  type SequenceClock,
} from './sequence-clock.ts';
import {
  DEFAULT_CLIP_S, MAX_TIME_S, MIN_DUR, MIN_TRIM_BAR_PX, ONION_MAX_STEPS,
  boxTiming, deriveDuration, edgeZonePx, fmtDelta, fmtDur, fmtTime, indexOfId, isTimed,
  onionNeighbours,
  dropIndexAt, moveOverlay, moveSeqClip, packSeq, removeAndRipple, rippleOverlays, seqBoxes,
  // Marquee/multi-drag batch movers (plans/54 timeline; drag-select + move-many).
  groupDropIndex, moveOverlays, moveSeqClips, staggerOverlays,
  setClipIn, setDuration, setSpeed,
  detachAudio, isThroughEdit, joinClips, reattachAudio, restackOverlay, splitAll,
  snapTime, trimClip,
  // The keyframe surface's arithmetic (plans/104 section 8). EVERY number the diamonds, the
  // latch and the CRUD list need is one of these - the panel converts a pointer to an
  // intent and hands the intent over.
  type LaneDrop,
  clearKfTrack, kfBoxTrack, kfDiamondAt, kfDiamondTimes, kfDuplicateMs, kfFormatChannel,
  kfKeyAt, kfLocalMs, kfLocalSec, kfPoseAt, kfSeekDiamond, kfSlideMs, kfTimelineSec, kfWriteMs,
  kfTrackDelete, kfTrackDuplicate, kfTrackRetime, kfTrackSetEase, rescaleKfTrack, setKfTrack, writeKfPose,
  type Box, type MediaDurFn, type TimeCfg,
} from './timeline-math.ts';
import { prefersReducedMotion } from '../lib/a11y-prefs.ts';
// Engine-owned cue grouping (the analysePcm precedent): captions grouped here
// break at the same words a headless render would break at.
import { groupWordsToCues } from '../../../../engine/src/captions.ts';
import { integratedLoudness } from '../../../../engine/src/audio-loudness.ts';
import { FX_PRESETS } from '../../../../engine/src/audio-fx.ts';
import { captionGroup, cueSpansOnTimeline, isCaptionGroup, transcriptWordsOf, ttsWordsOf } from './timeline-captions.ts';
// Transcript-driven editing (plans/174): delete a row cuts that media, strike a
// row greys it. All arithmetic lives in the pure transcript-edit.ts; this panel
// is opened from here so it can reuse this module's getBoxes/write/clock/cfg.
import { openTranscriptPanel } from './transcript-panel.ts';
import { removedSpansTimeline, originalToEdited, editedToOriginal } from './transcript-edit.ts';
// The transcription rung as a background job (plans/124 section 9, WP-F): the
// consent sheet enqueues and closes, the global toast owns progress and cancel,
// and a finished transcript outlives the panel.
import { startTranscribeJob, stashedTranscript } from '../lib/stt-job.ts';
import { fmtBytes } from '../lib/format.ts';
import type { AssetRef, AudioLevel, HostV1, RecorderAPI, RecordSession, SpeechAPI, SpeechWordTiming } from '@lolly-tools/core/host-v1';
import type { VideoJobHost } from '../lib/video-jobs.ts';
import { isTypingTarget } from '../lib/typing-target.ts';
import '../styles/parts/timeline.css';

// ── local structural types (kept minimal so free-canvas can pass its own objects) ──

/**
 * Just the slice of the tool runtime the panel needs: repaint notifications, plus a
 * READ-ONLY peek at the manifest's declared capabilities. The panel offers no
 * device-capture affordance to a tool that has not declared it needs one - the
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
  /** The optional speech bridge (v1.96 synthesis, v1.99 transcription) - behind the
   *  "Script a voiceover" button and the transcription arm of Generate subtitles.
   *  Feature-detected like `recorder`, never capability-gated. */
  speech?: SpeechAPI;
  /** The optional on-device background remover (v1.103). Not required to OFFER the clip
   *  context menu's "Remove background…" (the shared video-job dialog also has a model-free
   *  colour-key method), but carried on the host so the dialog can use the model method
   *  when a model is staged. Feature-detected like `speech`, never capability-gated. */
  matte?: NonNullable<HostV1['matte']>;
  /** The user-asset store, for retiring a take that a RE-take has superseded - and only
   *  once the replacement has been committed to the model (see finishTake) - plus `get`,
   *  which resolves a box's persisted ref back to a LIVE one (fresh object URL and full
   *  meta) for the subtitle path. */
  assets?: {
    _deleteUserAsset?(id: string): Promise<void>;
    get?(id: string): Promise<AssetRef | null>;
    /** "Export frame": persist a native-resolution PNG grabbed at the playhead
     *  as a new user asset (mirrors MatteAssetRecordInput/UpscaleAssetRecordInput -
     *  the shape every on-device-transform dialog already saves through). */
    _uploadUserAsset?(record: {
      id: string;
      type: AssetRef['type'];
      format: string;
      blob?: Blob;
      version?: string;
      width?: number;
      height?: number;
      meta?: Record<string, unknown>;
    }): Promise<void>;
    /** The meta-only ANNOTATION write (bridge/assets.ts) - how a finished
     *  transcription is filed onto the clip's own record, so a second
     *  "Generate subtitles" reads it back instead of inferring again. */
    _updateUserAssetMeta?(id: string, meta: Record<string, unknown>, patch?: { aiGenerated?: 'full' | 'partial' }): Promise<void>;
  };
  /** "Export frame"'s second half: the same PNG bytes, offered as a plain download. */
  export?: {
    download(blob: Blob, filename: string): Promise<void>;
  };
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
 * `id` and `label` are read here - the `seed` is free-canvas's business.
 */
export interface TimelineAddKind {
  id: string;
  label?: string;
  /**
   * The manifest's own seed for this kind - free-canvas's `AddKind.seed`, already
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
  /** Playhead time, ms - where the created box must START. */
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
  /** The free-canvas single write path - the ONLY way this module touches the model. */
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
  /**
   * The box sub-field carrying rendered text (free-canvas's `cv.textField`).
   * Only Generate subtitles writes it - each cue becomes a text box - so a tool
   * that declares no text field simply never offers the action.
   */
  textField?: string;
}

export interface TimelinePanel {
  destroy(): void;
  setOpen(open: boolean): void;
  isOpen(): boolean;
  /**
   * Panel-owned selection (the adapter mirrors it to the canvas), revealing the first
   * id's clip. The editor-state path (plans/176 v1) routes ids here when the panel is
   * up, so a camera id - no canvas footprint - still reaches the Camera inspector
   * group the way a click on its Always-on chip does.
   */
  selectAndReveal(ids: string[], opts?: { reveal?: boolean }): void;
  /** The playhead in authored seconds - the read half of `seek`. */
  time(): number;
  /**
   * The scenery ⇄ timed writers, exposed so the CANVAS context menu (and free-canvas's
   * timeline-initiated create path) drive the SAME two functions the panel's own
   * inspector, chip and context menu use. There is exactly one implementation of each;
   * everything else is a door onto it. Both are one commit, one undo step.
   *
   * `dur: null` - passed explicitly, distinct from omitting it - means "author no
   * length": the caller knows the box's media length is not knowable yet. See promote's
   * own doc for why that is not the same as the default.
   */
  promote(id: string, want?: { start?: number; dur?: number | null }): void;
  demote(id: string): void;
  /**
   * PLAYHEAD-CONTEXTUAL WRITES, the canvas half (plans/104 section 8).
   *
   * The panel owns the clock and therefore owns the only honest answer to "is this
   * box parked on one of its own keyframes right now". free-canvas asks that at its
   * single pointerup commit and, for the ids that come back, hands the gesture's
   * delta here instead of moving the box - which is what makes a drag on a diamond
   * pose THAT keyframe while a drag anywhere else moves the clip, with no mode, no
   * record-arm and no second gesture to learn.
   *
   * Two calls rather than one so the caller keeps its own writers: `kfPoseIds` is a
   * question (no writes, no side effects), `kfPoseWrite` is a pure transform of a
   * boxes array. Neither commits - the caller composes both halves of a mixed
   * selection into ONE array and makes ONE commit, so a multi-select is one undo step.
   */
  kfPoseIds(ids: readonly string[]): string[];
  /**
   * `mode` is the same distinction `writeKfPose` documents: `'add'` folds a DELTA into
   * the pose the box is already striking (a drag's dx/dy, a rotate's degrees), `'set'`
   * writes the value itself. Resize is the one canvas gesture that is absolute - a
   * dragged handle produces the box's new WIDTH, not a change to it - so it is the
   * caller that knows which reading applies (section 5.2, the P1 w/h reversal).
   */
  kfPoseWrite(boxes: Box[], ids: readonly string[], delta: KfPose, mode?: 'add' | 'set'): Box[];
  /**
   * CAMERA MODE, entered by SELECTION and never by a toggle (plans/104 section 8): the id of
   * the camera a canvas gesture is currently aimed at, or '' when none is.
   *
   * True when the panel is open, exactly one box is selected, it is a camera, and the
   * playhead is inside its window - every one of which is something the user can see
   * on screen. free-canvas asks before it starts a marquee on the empty stage (that
   * drag becomes a camera pan) and before it lets a plain wheel through (that wheel
   * becomes a dolly). Cmd/Ctrl-wheel and Space+drag are the VIEW's and stay the
   * view's: "move the shot" and "move my view" have to stay separable.
   */
  cameraModeId(): string;
  /**
   * The camera gesture's delta, folded into the camera's own track - pure, like
   * `kfPoseWrite`, so the caller commits once on release (a drag) or once per pause (a
   * wheel). Returns the array unchanged when no camera is armed, or when the camera
   * has an authored MOVE and the playhead is off every diamond (section 8's latch, applied to
   * the camera: see `cameraPoseAtSec`).
   */
  cameraWrite(boxes: Box[], delta: KfPose): Box[];
  /**
   * The tilt the camera WOULD hold if a shift-drag of `(dRx, dRy)` degrees committed now
   * - the current pose plus the delta, clamped to the control band (`KF_TILT_CONTROL`),
   * read at the latch. Pure; null when no camera is armed. Drives the canvas tilt HUD: a
   * camera drag previews NOTHING on the stage (section 8 commits on release), so this absolute
   * readout is the only live feedback the gesture has, and the clamp lives here so the
   * HUD can never show an angle the write would not actually reach.
   */
  cameraTiltPreview(boxes: Box[], dRx: number, dRy: number): { rx: number; ry: number } | null;
  /**
   * "+Keyframe", the ACTION (plans/104 section 8's M2.5 revision: "TWO homes, one action").
   *
   * The panel's own transport button, the canvas contextual bar's diamond and the `K`
   * shortcut are three doors onto this one function - there is no second copy of the
   * rules anywhere. It reads the shared selection itself, so a caller passes nothing:
   * a timed box is keyed at the playhead; an UNTIMED one is promoted onto the timeline
   * and keyed in the SAME array, so the whole thing is one commit and one undo step.
   * Boxes with nothing to pose (audio, until plan 101) fall out; an empty selection
   * writes nothing at all.
   */
  addKeyframe(): void;
  /**
   * The SCOPE half of that action, as a question - which of these ids "+Keyframe"
   * would actually key. free-canvas's contextual-bar diamond asks it for its own
   * enabled state, so the two homes of one action share one ENABLEMENT rule as well as
   * one writer: the panel's rule reads the live canvas as well as the model (a box
   * carrying an audio asset is a sound whatever its `kind` says), which a caller
   * re-deriving from the model alone cannot see - it would offer a button that then
   * writes nothing and says nothing.
   *
   * Pure: no writes, no DOM mutation, no announce.
   */
  keyframableIds(ids: readonly string[]): string[];
  /**
   * Park the playhead at an AUTHORED time in seconds - the `_t` deep link's door, and
   * the same seek the ruler makes. A non-finite or negative time parks at 0.
   */
  seek(sec: number): void;
}

// ── tunables ──────────────────────────────────────────────────────────────────

/** Panel height floor, px (section 2 docking clamp). */
export const MIN_PANEL_H = 112;
/** Panel height on first open, px. Session-local; never persisted. */
export const DEFAULT_PANEL_H = 190;
/** One ordinary lane plus its gap - the least a tracks area can usefully show. */
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
 * timeline - "more than twice as wide as the visual appearance suggests".
 *
 * Was 8, which was under every published floor. See EDGE_PX_COARSE for the one that
 * actually has a standard behind it; this one is the pointer that can be precise.
 */
export const EDGE_PX = 10;
/**
 * Edge-trim hit zone for a COARSE pointer (finger / pen), px each side.
 *
 * 24 is WCAG 2.5.8's target-size floor (AA), and the smallest of the three standards
 * in play - Apple asks 44pt, Material 48dp. Those two are about a target you TAP; this
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
 * (SNAP_PX = 6) stays where it is - that is the value every OTHER caller of snapTime
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
 * Voiceover take limits. `maxMs` mirrors record-control's audio cap (10 minutes) - a
 * runaway take is a runaway upload, and the panel warns before it lands. `countInMs`
 * is one beat of the 3-2-1 count-in.
 *
 * MUTABLE on purpose, like the engine's HOOK_BUDGET_MS: a jsdom test drives the whole
 * take through in one tick by zeroing the count-in, rather than sleeping 1.8 s.
 */
export const TAKE_TIMING = { countInMs: 600, maxMs: 10 * 60 * 1000, warnMs: 5000 };

/**
 * The depth SLIDER's travel (plans/104 section 5.3). NOT a clamp: `KF_Z_FIELD_CLAMP` is the
 * engine's, it is what every write is held to, and it is deliberately wider than this.
 *
 * 0–300 is the band section 5.3 calls tasteful - at P = 1200 it spans eff 1.00–1.33, with the
 * 1.05–1.2 lift landing mid-travel and "Lift layers"' 0/40/80 stagger in the first
 * fifth. Deeper moves belong to the camera dolly, not to a per-box depth, so the slider
 * stops where taste does while the NUMBER beside it still accepts the whole field range
 * (−300…900, negative = sunken). A test pins this inside the engine's clamp.
 */
export const KF_Z_SLIDER: readonly [number, number] = Object.freeze([0, 300] as const);

/**
 * The TILT controls' travel (P2) - the same kind of promise `KF_Z_SLIDER` makes, and
 * made for an essential reason rather than for taste alone.
 *
 * `KF_CLAMPS.rx/ry` is ±180 because it is a WIRE clamp: a hand-edited share link may
 * say anything and the parser has to hold it to something. It is not a control range,
 * and wiring the Tilt X / Tilt Y fields straight to it (which is what P2 first did)
 * put a reachable value on the other side of an invariant the plan path depends on.
 * `buildPlan`'s depth sort is by resolved `z`, and that reproduces a perspective render
 * only while `κ = cos(rx)·cos(ry) > 0` - past a quarter turn the sign flips, the far
 * layer becomes the one painted last, and a "lifted" layer SHRINKS. At `rx = −120`
 * three layers at z 0/100/200 come out fully opaque, view-axis depths 1200/1250/1300,
 * painted in exactly the wrong order, with the behind-camera guard never engaging
 * because `D = P − κζ` GROWS with ζ once κ < 0.
 *
 * ±75 keeps `κ ≥ cos(75°)² = 0.067 > 0` for every combination of the two, so the sort
 * is correct by construction everywhere a control or a gesture can reach - and it is
 * generous for the pictures the presets are built from (Surface glide's −40°, Orbit's
 * ±25°, Depthfield's own −38°). Past ~75° a screen-parallel plane is nearly edge-on
 * and there is no artwork left to look at, so nothing is being withheld.
 *
 * The wire stays ±180 (a link that says 120 still parses and still renders - it is
 * simply not something the UI will author), exactly as `z`'s wire stays ±12000 while
 * its slider stops at 300. `timeline-panel.test.ts` pins the containment.
 */
export const KF_TILT_CONTROL: readonly [number, number] = Object.freeze([-75, 75] as const);

/** The two channels `KF_TILT_CONTROL` governs, for `kfPoseAt`'s channel list. */
const TILT_CHANNELS: readonly KfChannel[] = Object.freeze(['rx', 'ry'] as const);

/**
 * The camera moves that write keyframes (plans/104 section 8, section 12 Q8) - stored EXPANDED.
 *
 * Each `track` is the plan's own literal wire sketch, parsed by the ENGINE's `parseKf`
 * on the way in and re-serialised on the way out, so a preset is indistinguishable from
 * a hand-authored move the moment it lands: no preset name is stored anywhere, nothing
 * downstream has to resolve one, and every key is editable, retimeable and deletable
 * like any other (plan 101's rule, which this plan inherits).
 *
 * The first five exercise v1 channels only. **Surface glide and Orbit are P2's** and
 * are the first two that author `rx`/`ry`; both obey THE RESOLUTION RULE (Andy,
 * 2026-08-12, binding on every generated animation): *"elements lift off and rest back
 * down on the page; the animations showing them falling apart need to close out with it
 * all coming together."* Their last keyframe IS the rest pose - every channel the track
 * touches returns to its default - so the move is a departure that comes home rather
 * than a shot that ends stranded at an angle. `tests/keyframes-tilt.test.ts` asserts it
 * by evaluating each tilt track at its own end.
 *
 * ⚑ MEASURED, NOT FIXED HERE: the five P1 presets above predate that rule and do NOT
 * obey it - `push-in` ends at `z −220`, `pull-back` at `z 0` (it does), `pan-across` at
 * `x 140`, `rise` at `y −120, z −80`, `reveal` at rest. Bringing `push-in`, `pan-across`
 * and `rise` home would change what three shipped moves MEAN (a push-in that pushes back
 * out is a different shot), which is a product call and not a P2 one. Flagged for Andy
 * with the numbers rather than changed in passing.
 *
 * ⚑ THE DOLLY SIGN IS INVERTED FROM section 8's SKETCHES, and deliberately. The engine's own
 * projection is `eff = P / (P − (z − camZ))` (`projectDepth`), so a camera whose `z`
 * GROWS is a camera moving AWAY: a layer at z = 0 under camZ = 220 renders at
 * eff = 1200/1420 = 0.845, i.e. smaller. section 8's sketch for "Push in" ends at z 220 and
 * would therefore pull back, and "Pull back" would push in - the two sketches are each
 * other's. section 4.3's own Vertigo derivation agrees with the formula and not with the
 * sketches (`camZ = P·(1/c − 1) + z_s` puts camZ BELOW the subject plane to magnify
 * it, and names camZ ≈ −600 for the recipe), so the sketch is what is wrong here. The
 * FORM of every preset is kept exactly as authored - the same instants, the same
 * eases, the same start-or-end-at-rest structure - with the dolly's sign flipped so
 * that each move does what its name says. Flagged for the plan to correct section 8.
 *
 * The labels go through `t()` HERE, at module scope, for the reason PANEL_SHORTCUTS
 * states: literal `t('…')` call sites are what scripts/translate.ts's corpus scan
 * extracts, and a `t(preset.label)` at render time would need every name hand-listed
 * in extra-keys.spa.json instead.
 *
 * The `track` times are AUTHORED absolutes (4–5.2 s); `applyCameraPreset` rescales them
 * to the scene's own duration (`rescaleKfTrack`, audit A1#5) so a move fits any clip.
 */
/**
 * The shortest a rescaled preset may become - a floor under `applyCameraPreset`'s scene
 * scale so a pathologically brief scene compresses the move to a fast glide rather than a
 * single-frame strobe. Only bites below 0.8 s, which no real flythrough scene reaches.
 */
const PRESET_MIN_MS = 800;

export const KF_CAMERA_PRESETS: ReadonlyArray<{ id: string; label: string; track: string; icon: IconName }> = [
  { id: 'push-in', label: t('Push in'), track: 't0_z0*t4000_eo_z-220', icon: 'zoomIn' },
  { id: 'pull-back', label: t('Pull back'), track: 't0_z-220*t4000_eio_z0', icon: 'zoomOut' },
  { id: 'pan-across', label: t('Pan across'), track: 't0_x-140*t4000_el_x140', icon: 'move' },
  { id: 'rise', label: t('Rise'), track: 't0_y120_z-40*t4000_eo_y-120_z-80', icon: 'arrowsV' },
  { id: 'reveal', label: t('Reveal'), track: 't0_z-260_a0.5_f200*t3500_eo_z0_a0', icon: 'eye' },
  // ── P2: the two tilt moves ────────────────────────────────────────────────
  //
  // SURFACE GLIDE is the signature move. section 9's re-sequencing verdict said: "what I'm
  // seeing show up are all top-down views, not angled glides along the surface of
  // the image, POV style". The acceptance phrase was "to feel INSIDE the landscape
  // of the image". The move opens down among the lifted surfaces: `rx −40` pitches
  // the camera so the near edge sits at the bottom of frame and the far edge
  // recedes to a horizon. The focus plane sits out at z 160 with the aperture open,
  // so the flat board is soft and only the lifted layers are sharp. It then drifts
  // laterally (per the P4 study: "the camera NEVER sits still") and RESOLVES: pitch,
  // both pans, focus, and aperture all land on 0 at 5.2s, the same instant the
  // shipped Screenshot-flythrough template settles on. It is linear out of the
  // first key, because a drift that eases is a drift that wobbles, and ease-out
  // into the second key, so the shot lands rather than stops.
  //
  // ⚑ NO DOLLY. This is a MEASURED decision, not an omission. A `camZ` push was
  // tried and removed: on the affine tier camZ is a pure magnification, but under a
  // pitch it also DISPLACES, because it moves the aim point along the world z axis
  // instead of along the camera's own view axis. Measured on the P1 demo scene,
  // adding `z −180` to the opening key lifted every layer about 130px up the frame
  // on top of the magnification, and pushed two of the four lifted cards clean off
  // the top edge (card B to y −110 on a 540-tall stage). A signature preset must
  // not open with half the artwork out of frame. Dollying ALONG the view axis under
  // tilt is the right fix, but it is a projection change, not a preset one. Noted
  // for P2b.
  //
  // ORBIT is no longer inert. It shipped disabled at P1 with the reason "Needs tilt
  // (coming)". That reason no longer applies as of this milestone: the engine's
  // camera model ORBITS its aim point rather than swivelling in place (see
  // `surfaceMatrix`), so a keyframed `ry` IS an orbit: the camera swings around the
  // artwork while the centre of frame stays put. This codebase's rule is not to
  // leave a control dimmed behind a reason that has stopped being true. The move
  // swings right, past the front, to the left, and settles square, returning like
  // its sibling move, with a shallow `rx` through the arc so it reads as an orbit
  // rather than a horizontal wipe.
  { id: 'surface-glide', label: t('Surface glide'), track: 't0_el_x-120_y60_rx-40_f160_a0.8*t2600_eo_x-40_y36_rx-24_f90_a0.4*t5200_x0_y0_rx0_f0_a0', icon: 'plane' },
  { id: 'orbit', label: t('Orbit'), track: 't0_el_rx-14_ry34*t2600_es_rx-14_ry-34*t5200_rx0_ry0', icon: 'refresh' },
];

/** One row of the shortcuts sheet - and one branch of `onKey`. */
export interface PanelShortcut {
  /** What the sheet prints in the keys column. Key NAMES, deliberately untranslated. */
  keys: string;
  /** What the key does. */
  label: string;
  /** Second line, for a modifier that changes the same key's behaviour. */
  hint?: string;
  /**
   * Every literal `KeyboardEvent.key` this row handles, with the modifier that arms
   * it. This is the MACHINE half of the row: the drift guard in timeline-panel.test.ts
   * drives each one through `onKey` and asserts it was handled, and checks the reverse
   * direction against a literal list of `onKey`'s case labels - so a shortcut cannot
   * be added without documenting it, or documented without existing.
   *
   * Empty for a modifier-only row (Alt), which has no keydown branch of its own.
   *
   * `altKey` is the ONE chord this panel binds, and it is documented rather than
   * hidden: Alt+←/→ (previous/next keyframe) reuses the arrow keys the bare press
   * already owns, because "the same key, one step coarser" is the only mapping that
   * needs no second thing to remember - and Alt is already this panel's modifier
   * vocabulary (it bypasses snapping everywhere else, i.e. it always means "not the
   * ordinary reading of this gesture").
   */
  events: Array<{ key: string; shiftKey?: boolean; altKey?: boolean }>;
}

/**
 * The panel's keyboard, written ONCE.
 *
 * Users learn splitting and trimming by shortcut - every canonical NLE chord for those
 * (Cmd/Ctrl+B, Cmd/Ctrl+Shift+B, Cmd/Ctrl+K) collides with a browser binding whose
 * preventDefault() is unreliable, and a shortcut that silently does nothing is worse
 * than one that has to be learned. So the panel binds bare letters and Shift+letter,
 * which nothing fights for - and that trade only holds if the list is SHOWN. This
 * constant is both the sheet (`?`) and the contract `onKey` is written against.
 *
 * Labels go through `t()` here, at module scope, on purpose: this is a lazily imported
 * view, so the catalog has long since loaded by the time it evaluates, and switching
 * language reloads the page (i18n.ts's switchLang). Literal `t('…')` call sites are
 * also what scripts/translate.ts extracts - a `t(row.label)` at render time would need
 * every string hand-listed in extra-keys.spa.json instead.
 */
export const PANEL_SHORTCUTS: PanelShortcut[] = [
  { keys: 'Space', label: t('Play or pause'), events: [{ key: ' ' }, { key: 'Spacebar' }] },
  { keys: '← →', label: t('Move the playhead'), events: [{ key: 'ArrowLeft' }, { key: 'ArrowRight' }] },
  { keys: 'Home  End', label: t('Jump to the start or the end'), events: [{ key: 'Home' }, { key: 'End' }] },
  { keys: '↑ ↓', label: t('Select the previous or next clip'), events: [{ key: 'ArrowUp' }, { key: 'ArrowDown' }] },
  { keys: '[  ]', label: t('Select the in or out edge'), events: [{ key: '[' }, { key: ']' }] },
  {
    keys: ',  .', label: t('Nudge the selected edge'), hint: t('Hold Shift for ten frames'),
    events: [{ key: ',' }, { key: '.' }, { key: '<' }, { key: '>' }],
  },
  {
    keys: 'Alt + ← →', label: t('Previous or next keyframe'),
    events: [{ key: 'ArrowLeft', altKey: true }, { key: 'ArrowRight', altKey: true }],
  },
  { keys: 'K', label: t('+Keyframe'), hint: t('Adds or updates the pose at the playhead'), events: [{ key: 'k' }] },
  { keys: 'E', label: t('Trim to the playhead'), events: [{ key: 'e' }] },
  { keys: 'S', label: t('Split at playhead'), events: [{ key: 's' }] },
  { keys: 'Shift + S', label: t('Split every clip at the playhead'), events: [{ key: 'S', shiftKey: true }] },
  { keys: 'Shift + D', label: t('Detach audio'), events: [{ key: 'D', shiftKey: true }] },
  {
    keys: 'O', label: t('Onion skin'), hint: t('Hold Shift for its options'),
    events: [{ key: 'o' }, { key: 'O', shiftKey: true }],
  },
  { keys: 'Alt', label: t('Hold to turn snapping off'), events: [] },
  { keys: '+  −', label: t('Zoom'), events: [{ key: '+' }, { key: '-' }, { key: '=' }, { key: '_' }] },
  { keys: 'F', label: t('Fit to view'), events: [{ key: 'f' }] },
  { keys: 'Delete', label: t('Delete the clip'), events: [{ key: 'Delete' }, { key: 'Backspace' }] },
  { keys: 'Shift + F10', label: t('Open the clip menu'), events: [{ key: 'F10', shiftKey: true }, { key: 'ContextMenu' }] },
  { keys: '?', label: t('Keyboard shortcuts'), events: [{ key: '?' }] },
  { keys: 'Esc', label: t('Step back, then close'), events: [{ key: 'Escape' }] },
];

// ── pure helpers (exported: these are what the unit tests reach) ───────────────

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const finite = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The middle dot between two readings inside ONE inspector chip. A separator, not a
 * word - no `t()`, and it must never be built by concatenating a translated fragment
 * either side of it, which is how a summary turns into an untranslatable sentence.
 * (Between two SEPARATE chips the sheet draws a `border-inline-start` instead, which is
 * why that rule is logical rather than a physical left border: see parts/timeline.css.)
 */
const CHIP_SEP = ' · ';

/**
 * The Animate segment's WHOLE collapsed reading: the two kind names, `Rise · Fade`.
 *
 * section 8's M2.6 pass, verbatim: "Chips must not duplicate the popup's contents… ANIMATE's
 * chip drops the ms/curve dump - kind names only". M2.5 printed
 * `In: Rise · 400ms · Ease out` beside `Out: Cut (no animation)`, which is every field
 * of the group re-rendered as text on the door of the group - so the door taught the
 * user nothing they would not read one press later, at twice the width. The segment is
 * a door with at most one glance token; the popup is where the details live.
 *
 * A CUT contributes NOTHING rather than a placeholder: "Rise · Cut (no animation)" is a
 * summary that spends half its width on the absence of an animation, and an em dash in
 * its place is a token that has to be learned. Both directions cut → no chip at all,
 * which is exactly how the segment reads a box that has never been animated. The
 * vocabulary is the SAME registry the `<select>`s a press away are built from
 * (`TRANSITIONS`), so the chip can never name a kind by a word the control does not use.
 */
function animateSummary(enter: unknown, exit: unknown): string[] {
  const name = (v: unknown): string => {
    const k = isTransitionKind(v) ? v : DEFAULT_TRANSITION;
    return k === 'none' ? '' : t(TRANSITIONS[k]);
  };
  const parts = [name(enter), name(exit)].filter(Boolean);
  // ONE chip, not two: `setSummary` draws a separator rule between chips, and a single
  // reading split across two of them would read as two facts.
  return parts.length ? [parts.join(CHIP_SEP)] : [];
}

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
 * scroll that preserves the anchor - the caller applies both together.
 */
export function zoomAbout(pxPerSec: number, factor: number, cursorPx: number, scrollLeft: number): { pxPerSec: number; scrollLeft: number } {
  const pps = clampPxPerSec(pxPerSec);
  const next = clampPxPerSec(pps * finite(factor, 1));
  const anchor = pxToTime(finite(cursorPx, 0) + finite(scrollLeft, 0), pps);
  return { pxPerSec: next, scrollLeft: Math.max(0, timeToPx(anchor, next) - finite(cursorPx, 0)) };
}

/**
 * The identity of the panel's ROW STRUCTURE: box ids, their lane, whether they are
 * timed at all, and - for a tool with a group field - their group, because grouped
 * overlays SHARE a lane row (see rebuild's collapse), so regrouping is a structure
 * change. Geometry (start/dur) is deliberately absent - moving or trimming a clip
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
    const group = cfg.groupField ? b[cfg.groupField] : undefined;
    parts.push(`${id == null ? '' : String(id)}:${timing.lane}:${isTimed(b, cfg) ? 1 : 0}:${group == null ? '' : String(group)}`);
  }
  return parts.join('|');
}

/**
 * The times a drag may snap to: every clip edge, the playhead, and the whole seconds
 * NEAR the pointer. Bounded on purpose - emitting every whole second up to MAX_TIME_S
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
 * when the panel owns the interaction - focus inside it, or the pointer over it - and
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
 * at all on a phone - the resize grip could crush `.tl-tracks` to zero height and the
 * panel became 100% chrome showing no timeline. Callers that can measure their live
 * chrome pass it; the two-argument form keeps the original behaviour exactly.
 */
export function clampPanelH(h: number, stageH: number, chromeH = 0): number {
  const floor = Math.max(MIN_PANEL_H, Math.round(finite(chromeH, 0)) + ONE_LANE_H);
  const hi = Math.max(floor, Math.floor(finite(stageH, 0) * 0.5));
  return clamp(Math.round(finite(h, floor)), floor, hi);
}

/** Ruler tick spacing (seconds) for a zoom level - the smallest step ≥ 60px apart. */
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
 * Is this pointer a coarse one - i.e. does it need the WCAG-floor hit target?
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

type GestureKind = 'trim' | 'move' | 'reorder' | 'seek' | 'resize' | 'kf' | 'marquee';

interface Gesture {
  kind: GestureKind;
  id: string;
  pointerId: number;
  el: HTMLElement | null;
  /** Pointer x/y at pointerdown, viewport coords. */
  x0: number;
  y0: number;
  /** Latest pointer position - written SYNCHRONOUSLY in pointermove, read on pointerup. */
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
  /**
   * Diamond drag only (`kind === 'kf'`): the keyframe's LOCAL ms at pointerdown, and
   * the dot being dragged. Absolute-from-the-snapshot like `start0`/`dur0`, so a
   * retime is never accumulated across frames.
   */
  kfT0?: number;
  kfDot?: HTMLElement | null;
  /** Snapshot of the timing at pointerdown, so the drag is always absolute, never accumulated. */
  start0: number;
  dur0: number;
  /** Seq reorder only. */
  index0: number;
  index: number;
  /** Overlay vertical drag (plans/165 Slice C-tracks): the resolved lane drop, and
   *  the overlay rows' geometry, cached at the first vertical breach of the drag. */
  laneDrop?: LaneDrop | null;
  laneRects?: { el: HTMLElement; anchor: string; members: string[]; top: number; bottom: number }[];
  /** Panel resize only. */
  h0: number;
  moved: boolean;
  /** Marquee only: the drag ADDS to the current selection (Shift/Cmd held). */
  additive?: boolean;
  /** move/reorder only: when >1, drag the whole selection as a batch (one undo step).
   *  moveOverlays/moveSeqClips each act on the same-lane members and ignore the rest. */
  groupIds?: string[];
  /** move/reorder only: a plain press on an already-multi-selected clip keeps the set
   *  for a possible group drag; if it turns out to be a click (no move), collapse to this
   *  one clip on release (the standard "click one of a selection" behaviour). */
  collapseOnClick?: boolean;
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
   * The live node the picture is already decoded in - the `<img>` on the canvas, or
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
 * - and to catch the OTHER late arrival: a Lottie whose player has not mounted its
 * <svg> by the first pass. Nothing else ever re-runs a pass (they fire on rebuild,
 * gesture-end, zoom, fit and an appearance change only), so without this a slow Lottie
 * bar stayed blank forever.
 *
 * Six, not three: three passes bounded a scheduling at 18 shots, so a twenty-frame
 * sequence had two bars that could never be reached at all. The chain still terminates
 * - a pass that leaves nothing pending does not queue the next, an in-flight bar no
 * longer counts as pending (nodeRasterPending) and a bar that failed once is retired
 * (nodeRasterFailed) - so this is a ceiling, not a schedule.
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
 *     photograph of the DOM - and a tool clip must keep taking `still`, because that
 *     <img> IS the compose render, not a screenshot of a tag.
 *   • `node` sits above `fill`, because a photograph of the box is strictly more
 *     information about the same box than its background colour is.
 *   • `node` sits above `none` TOO, which is the point of the whole branch: a text
 *     card and every pen shape (the tool hook forces `kind:'path'` boxes to a
 *     transparent fill) painted nothing at all before it existed.
 *
 * `canRaster` defaults to false so every existing call site - and every pinned row of
 * the table this function is tested against - keeps its exact previous answer.
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
 * out to have no media - `querySelectorAll`/`textContent` force no layout, so it is
 * safe there and nowhere near the paint phase.
 *
 * Declining is the important half. An empty, transparent, textless box would cost a
 * full dom-to-image shot to produce a blank bitmap, so it stays on `none`; and a box
 * with a pathological subtree is refused outright rather than allowed to eat the
 * pass's whole budget (the MAX_SVG_MARKUP / MAX_AUDIO_DECODE_BYTES idiom - decline,
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
 * The APPEARANCE identity of a box - everything that decides what its photograph looks
 * like, and nothing that decides where its bar sits.
 *
 * TIMING fields are excluded deliberately: a drag rewrites start/dur on every
 * pointermove, and re-keying on those would throw away a picture that has not changed
 * one pixel and retake it at the end of every gesture. `idField` is excluded too - two
 * boxes that look identical may legitimately share one raster (and one shot).
 *
 * O(row keys), against O(subtree bytes) for anything derived from the DOM. The box DOM
 * is a pure function of (model row, brand/theme, fonts), so the caller appends the two
 * environment terms it already has in hand - the box's computed background and the
 * document's theme stamp - rather than this module reaching for them. Same shape as
 * the `tracksKey` precedent above.
 *
 * Joined on U+0001, written as an escape - no authored field value contains it.
 */
/**
 * One field's contribution to an appearance signature.
 *
 * `String(v)` is wrong for the structured halves of `InputValue` - a token reference
 * `{ref,value}`, an asset ref, a blocks array - every one of which stringifies to
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

// ── onion-skin preference (device-local, absent = OFF) ────────────────────────
//
// A CHROME preference, not tool state: it changes what the editor draws over the
// artboard and never touches the model, so the "no localStorage for tool state" rule
// in CLAUDE.md does not apply. Direct precedent: projects.ts's view/sort modes and
// multi-edit.ts's zoom. Every access is wrapped, because a private-mode browser throws
// on the property access itself, not only on the call.
//
// ABSENCE is the off state - there is no `on: false` record. That keeps the default
// unambiguous (nothing stored, nothing drawn) and means turning it off leaves no
// residue for a future version to misread.
const ONION_KEY = 'lolly:onion';

interface OnionPref { mode: 'outline' | 'filled'; before: number; after: number; opacity: number }

/** Turning it on with nothing stored: outlines, one scene either side, full strength. */
const ONION_DEFAULT: OnionPref = { mode: 'outline', before: 1, after: 1, opacity: 1 };

const onionStep = (v: unknown): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? (n < 0 ? 0 : n > ONION_MAX_STEPS ? ONION_MAX_STEPS : n) : 1;
};
const onionOpacity = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 1;
};

function readOnionPref(): OnionPref | null {
  try {
    const raw = localStorage.getItem(ONION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<OnionPref> | null;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    // Coerced field by field: a hand-edited or half-migrated record must degrade to a
    // usable preference, never to a crash or to a mode nothing draws.
    return {
      mode: o.mode === 'filled' ? 'filled' : 'outline',
      before: onionStep(o.before), after: onionStep(o.after), opacity: onionOpacity(o.opacity),
    };
  } catch { return null; /* storage off, or junk in the slot */ }
}

function writeOnionPref(pref: OnionPref | null): void {
  try {
    if (pref) localStorage.setItem(ONION_KEY, JSON.stringify(pref));
    else localStorage.removeItem(ONION_KEY);
  } catch { /* storage off */ }
}

/**
 * Disclosure, since section 8's M2.5 revision: the inspector strip carries only the SEGMENTS
 * (icon + label + the resolved value chips, at a constant width), and an open group's
 * body is a body-mounted popover ABOVE the transport.
 *
 * There is therefore no per-group open MAP any more, and its absence is the point:
 *
 *   • ONE popover at a time - opening a second group swaps, the way a menu bar does.
 *     A map of independently-open groups cannot express that, and the strip it used to
 *     describe (bodies inline, side by side) is exactly what the revision removed.
 *   • DEFAULT ALL-SHUT. Nothing auto-discloses on selection: a popover that opens
 *     itself over the canvas because you clicked a box is a popover you have to close.
 *   • Still UI state and still session-local - it lives in `openGroup` inside the panel
 *     closure below, never in the model (plans/104 section 8: "never a model field") and never
 *     in storage. A group left open is a working posture, not a setting.
 */

/** Unique `aria-controls` targets: the inspector is rebuilt constantly, ids must not collide. */
let groupBodySeq = 0;

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
  let onionPref: OnionPref | null = readOnionPref();
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
  /**
   * A button that says what it does IN WORDS, with the glyph beside the text rather
   * than instead of it.
   *
   * The panel's `btn()` above is the TOOLBAR recipe - a 24px target in a row of
   * peers, where the icon is the whole control and the label lives in `aria-label` +
   * a tooltip. That is the wrong register inside the inspector, where an action
   * arrives alone in a disclosed group with nothing beside it to give it context:
   * "+Keyframe" and "Animate" are decisions, and a decision gets a word. Built ON
   * `btn` (never beside it) so there is still exactly one place that mints the icon
   * markup and the accessible name.
   */
  const actionBtn = (cls: string, label: string, glyph: IconName): HTMLButtonElement => {
    const b = btn(`tl-action ${cls}`, label, icon(glyph));
    // The text IS the label now, so the hover bubble would just repeat it.
    b.removeAttribute('data-tip');
    const span = document.createElement('span');
    span.className = 'tl-action-label';
    span.textContent = label;
    b.appendChild(span);
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
  // No declared kinds means the host tool has no create pipeline to arm - the button
  // would open an empty menu, so it is not rendered at all.
  addBtn.hidden = !addKinds.length;
  const splitBtn = btn('tl-split', t('Split at playhead'), icon('scissors'));
  const snapBtn = btn('tl-snap', t('Snap to edges'), icon('pin'));
  snapBtn.setAttribute('aria-pressed', 'true');
  // Onion skin - OFF by default, and the button says so before anything is clicked.
  // A long-press / right-click on it opens the options popover (see onionMenu).
  const onionBtn = btn('tl-onion', t('Onion skin'), icon('filmStrip'));
  onionBtn.setAttribute('aria-pressed', 'false');
  onionBtn.setAttribute('aria-haspopup', 'dialog');
  const zoomOutBtn = btn('tl-zoom-out', t('Zoom out'), icon('zoomOut'));
  const zoomInBtn = btn('tl-zoom-in', t('Zoom in'), icon('zoomIn'));
  const fitBtn = btn('tl-fit', t('Fit to view'), icon('resize'));
  // The sheet. Bare letters are the only key space the browser leaves alone, so the
  // panel's shortcuts are unguessable by design - this is where they stop being so.
  const keysBtn = btn('tl-keys', t('Keyboard shortcuts'), icon('keyboard'));
  keysBtn.setAttribute('aria-haspopup', 'dialog');

  // ── record-in-place voiceover (track C) ──────────────────────────────────────
  // The button is only rendered when the SHELL can capture audio and the TOOL has
  // declared it needs a microphone; see canRecordVoiceover for why both.
  const micBtn = btn('tl-mic', t('Record a voiceover'), icon('mic'));
  micBtn.hidden = true;   // decided below, once the capability check has run
  // Scripted voiceover - the mic's typed twin: opens the Script-audio dialog
  // (views/script-audio.ts, on-device TTS) and commits the saved clip at the
  // playhead exactly like a finished take. Feature-detected on `host.speech`,
  // the same progressive-capability terms as the mic (see canRecordVoiceover).
  const scriptBtn = btn('tl-script', t('Script a voiceover'), icon('speech'));
  scriptBtn.hidden = true;   // decided below, beside the mic's check

  /**
   * "+Keyframe" - one of its TWO homes (plans/104 section 8's M2.5 revision).
   *
   * It sits at the END of the left cluster, AFTER the keyboard sheet (section 8's M2.6 pass:
   * "the transport diamond moves to after the keyboard icon"). M2.5 put it fourth,
   * among `+` / mic / script on the reasoning that it is the fourth thing this panel
   * can ADD - but on the built strip that reading did not survive contact: the three
   * additive buttons all put something NEW on a track, and a diamond poses a box that
   * is already there, so it read as an interruption mid-cluster. The other home is the
   * canvas's selected-object contextual bar (views/free-canvas.ts), and both call the
   * SAME exported action - `addKeyframeAction` below - so there is one writer, one set
   * of rules and one undo step however the press arrived.
   *
   * DISABLED, never hidden, when the selection has nothing keyframable in it: a
   * control that vanishes teaches nothing, and this one's whole job is to be the
   * answer to "how do I animate this". `aria-disabled` rather than the `disabled`
   * property, so it keeps its place in the tab order and can still explain itself.
   * A tool whose manifest declares no `kf` sub-field never grows the button at all - 
   * the same progressive-capability gate the `+` and the mic already carry.
   */
  const kfBtn = btn('tl-kf-btn', t('+Keyframe'), icon('keyframe'));
  kfBtn.hidden = !cfg.kfField;

  // Transcript-driven editing (plans/174). Same progressive gate as the rest: a
  // tool that declares no `ignored` sub-field never grows the button. Clicking
  // opens the right-docked Transcript panel for the selected clip (or, if it has
  // no timings yet, offers the same on-device transcription the captions use).
  const transcriptBtn = btn('tl-transcript', t('Edit transcript'), icon('transcript'));
  transcriptBtn.hidden = !cfg.ignoredField;

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
  // `kfBtn` LAST - the end of the left cluster, after the keyboard sheet (section 8's M2.6).
  tools.append(addBtn, micBtn, scriptBtn, transcriptBtn, splitBtn, snapBtn, onionBtn, zoomOutBtn, zoomInBtn, fitBtn, keysBtn, kfBtn);
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
   * A panel-level element positioned in timeline pixels, NOT a child of the bar - 
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
   * dragged (Final Cut's pairing - the absolute number is what you are aiming for, the
   * delta is what you have done). aria-hidden because it changes every frame; the
   * spoken version is one announce() on release.
   */
  const trimBadge = document.createElement('div');
  trimBadge.className = 'tl-trim-badge';
  trimBadge.hidden = true;
  trimBadge.setAttribute('aria-hidden', 'true');
  /** The rubber-band selection rectangle (drag-select on empty lane space). Positioned
   *  in timeline-content pixels inside `inner`, so it scrolls with the bars. */
  const marquee = document.createElement('div');
  marquee.className = 'tl-marquee';
  marquee.hidden = true;
  marquee.setAttribute('aria-hidden', 'true');
  inner.append(laneWrap, scenery, extent, playhead, snapline, trimBadge, marquee);
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

  /** Set fields on one box. A VALUE write - no arithmetic, by design (see header). */
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
   * A detached audio box is a REFERENCE - same asset ref, same URL - but the tool hook
   * only stamps `data-audio-dur` when the ASSET carries a `meta.durationMs`, and a video
   * file's ref usually does not (its length is discovered by decoding it). The partner
   * video element has already decoded, and `video.duration` is the same number the
   * sound's own source runs for. Without this a detached sound is unclamped: you can
   * drag its out-edge past the end of the file into silence, and "fit to media" cannot
   * work - the exact hole `data-audio-dur` exists to close for a library track.
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

  /** Struck-through / ignored (plans/174) - kept in the ruler, skipped everywhere else. */
  const boxIgnored = (b: Box | undefined): boolean =>
    !!b && !!cfg.ignoredField && (b[cfg.ignoredField] === true || b[cfg.ignoredField] === 'true');

  /**
   * A box's media, read from the LIVE CANVAS rather than the model: the hook has already
   * resolved the asset ref to a URL there, and a decoded <video> also knows its real
   * duration - which is exactly what trimClip's media clamp wants.
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
    // that mounted <svg> - absent until the player has painted, which just means the
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

  /** A bar's human label: the user's own name if one was set (rename), else the box's
   *  own text if it has any, else its media kind. */
  function labelFor(id: string): string {
    const el = boxEl(id);
    const rows = getBoxes();
    const ci = indexOfId(rows, cfg, id);
    // The user's own name wins over everything - that is what a rename is for.
    if (ci >= 0 && cfg.labelField) {
      const own = String(rows[ci]![cfg.labelField] ?? '').trim();
      if (own) return own.length > 48 ? `${own.slice(0, 47)}…` : own;
    }
    // A CAMERA next, and off the MODEL: it paints nothing, so every probe below reads
    // '' on it and its chip would have said "Clip" - the one thing a camera is not
    // (plans/104 section 5.4). This is the label the "Always on" scenery chip wears, which is
    // the whole affordance the implicit scene camera is discovered through.
    if (ci >= 0 && isCameraBox(rows[ci]!)) return t('Camera');
    const txt = el?.querySelector<HTMLElement>('.lolly-box-text')?.textContent?.trim();
    if (txt) return txt.length > 48 ? `${txt.slice(0, 47)}…` : txt;
    const kind = mediaOf(id).kind;
    if (kind === 'video') return t('Video');
    if (kind === 'audio') return t('Audio');
    if (kind === 'image') return t('Image');
    if (kind === 'lottie') return t('Animation');
    return t('Clip');
  }

  /**
   * Inline rename: swap the bar's label for a text input in place. Enter/blur commits
   * (an empty value CLEARS the name, so the derived label comes back), Escape cancels.
   * One write through the panel's own path; the label refresh rides the normal restyle.
   * Reached from a double-click on the bar and from its context menu.
   */
  function renameClip(id: string): void {
    if (!cfg.labelField) return;
    const el = bars.get(id);
    const label = el?.querySelector<HTMLElement>('.tl-clip-label');
    if (!el || !label || el.querySelector('.tl-clip-rename')) return;
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tl-clip-rename';
    input.value = String(rows[i]![cfg.labelField] ?? '').trim();
    input.placeholder = labelFor(id);
    input.setAttribute('aria-label', t('Rename'));
    input.maxLength = 120;
    let settled = false;
    const finish = (commitIt: boolean): void => {
      if (settled) return;
      settled = true;
      const v = input.value.trim();
      input.remove();
      label.hidden = false;
      if (commitIt && v !== String(getBoxes()[i]?.[cfg.labelField!] ?? '').trim()) {
        write(patchBox(getBoxes(), id, { [cfg.labelField!]: v }));
      }
      // Back onto the bar: its accessible name is its label span, so AT reads the
      // new name on the refocus - no separate announcement needed.
      el.focus?.();
    };
    // Typing must not reach the panel's roving-focus/shortcut keys, and a pointerdown
    // in the input must not start a bar drag.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(true));
    label.hidden = true;
    el.appendChild(input);
    input.focus();
    input.select();
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
   *  never listed - it has no span to leave. */
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
  // The rule is one-directional on purpose. TIME never rewrites the selection - that
  // is the Premiere failure ("the selection jumps back to the clip under the playhead
  // and I wind up making changes to the wrong clip") - but SELECTION may move time,
  // because the alternative is a selected clip the canvas cannot show and therefore
  // cannot edit. So every route into `selection.set` inside this panel comes through
  // here instead, and the canvas's off-playhead banner becomes a state you can only
  // reach the long way round (scrub away from your own selection).
  //
  // Three refusals, each essential:
  //   • `{ reveal: false }` - a Shift-extend. Revealing on the SECOND of two clips
  //     picks one arbitrarily and moves the picture out from under the first.
  //   • playing - a seek mid-playback is a jump-cut nobody asked for, and during
  //     playback the selection is going in and out of frame by definition.
  //   • already live - the commonest case by far, and it must cost nothing.
  function selectAndReveal(ids: string[], opts?: { reveal?: boolean }): void {
    selection.set(ids);
    if (opts?.reveal === false || disposed || clock.playing()) return;
    const id = ids[0];
    if (!id) return;
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0 || !isTimed(rows[i]!, cfg)) return;      // scenery is always on screen
    const { start, dur } = span(rows[i]!, durationSec());
    const at = toAuthoredMs(clock.t()) / 1000;
    if (at >= start && at < start + dur) return;
    seekAuthored(start * 1000);
    announce(t('Moved the playhead to this clip'));
  }

  function applyBarGeometry(el: HTMLElement, start: number, dur: number): void {
    el.style.left = `${timeToPx(start, pxPerSec)}px`;
    el.style.width = `${Math.max(2, timeToPx(dur, pxPerSec))}px`;
  }

  /**
   * The diamonds: one strip per ANIMATED clip, one dot per keyframe (plans/104 section 8).
   *
   * POINTER SUGAR, and the word is exact. A bar is `role="option"` inside a listbox,
   * where an interactive child is illegal - so these are `<span>`s, aria-hidden, out
   * of the tab order, and everything they can do (retime, duplicate, re-ease, delete)
   * is also a real labelled button in the inspector's Keyframes group. That list is
   * the keyboard and screen-reader route; this is the one you can grab.
   *
   * Positioned exactly like `.tl-seam`: an absolute `left` in bar-local pixels, with
   * the half-size offset in the SHEET's `margin`, never a `transform`. A transform on
   * a diamond would make its bar a containing block for the fixed-position popovers
   * the panel body-mounts (the trap documented on `.tl-panel`), and the seam chips
   * learned that first.
   *
   * On an `is-tight` bar the strip hides outright - the trim-grip precedent: a target
   * you cannot hit is worse than no target, and the inspector list still has every
   * keyframe. Reconciled in place (`restyle`'s no-churn law): the dots are re-used and
   * only their count changes with the track.
   *
   * `keyframable` is the caller's `isKeyframable` answer. A bar that is NOT keyframable
   * shows no diamonds even if its row carries a track: the inspector offers that box no
   * Keyframes group and "+Keyframe" refuses it, so dots would be the one affordance
   * pointing at a surface nothing else admits to (a sound with a hand-authored `kf=`
   * from a share URL is the only way to get one).
   */
  function syncDiamonds(el: HTMLElement, box: Box, tight: boolean, keyframable: boolean): void {
    const track = cfg.kfField && keyframable ? kfBoxTrack(box, cfg) : null;
    let strip = el.querySelector<HTMLElement>('.tl-kf-strip');
    if (!track?.length) { strip?.remove(); return; }
    const fresh = !strip;
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'tl-kf-strip';
      strip.setAttribute('aria-hidden', 'true');
      el.appendChild(strip);
    }
    strip.hidden = tight;
    while (strip.childElementCount > track.length) strip.lastElementChild?.remove();
    const grew = strip.childElementCount < track.length;
    while (strip.childElementCount < track.length) {
      const dot = document.createElement('span');
      dot.className = 'tl-kf-dot';
      // NO tabIndex, not even -1 (section 8's M2.6 low): this subtree is aria-hidden, and a
      // focusable node inside an aria-hidden subtree is the one combination that has no
      // honest reading - focus would land somewhere the accessibility tree says is not
      // there. `-1` keeps it out of the TAB order but leaves it programmatically
      // focusable, and a pointer press focuses it in some engines. Nothing needs it:
      // the dots are pointer sugar and the inspector list is the AT route.
      strip.appendChild(dot);
    }
    // A NEW dot is a BLANK dot - `is-selected` went with the node it replaced (or with
    // the whole row, on a `rebuild`). The latch's structural memo is keyed on the
    // ANSWER, which a row rebuild does not change, so it would skip the re-mark and the
    // enlarged diamond would silently vanish (section 8's M2.6 low: "enlarged-diamond mark
    // lost on row rebuild"). Resetting the memo is the whole fix - the next
    // `syncKfLatch` re-reads and re-marks - and it costs nothing on the common path,
    // because a repaint that mints no dot does not touch it.
    if (grew || fresh) kfLatchKey = '\u0000';
    for (let i = 0; i < track.length; i++) {
      const dot = strip.children[i] as HTMLElement;
      const k = track[i]!;
      dot.dataset.t = String(k.t);
      dot.style.left = `${timeToPx(kfLocalSec(k.t), pxPerSec)}px`;
      // `title`, not [data-tip]: the bubble primitive draws a ::after ABOVE the
      // element and this one lives inside the `.tl-tracks` scroller, which clips - 
      // the same reason the scenery chip's `+` uses a native tooltip.
      const tip = t('Keyframe @ {t}', { t: fmtTime(kfTimelineSec(box, cfg, k.t)) });
      if (dot.title !== tip) dot.title = tip;
    }
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

  /** Full row rebuild - only when `tracksKey` changed. */
  function rebuild(boxes: Box[]): void {
    const scrollLeft = tracks.scrollLeft;
    // Every bar is about to be destroyed. If one of them had focus, the browser sends
    // focus to <body> - and since the key handler is bound on `root`, that kills the
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

    // Overlay lanes first (one row each - except that overlays SHARING a group share
    // one row), then the magnetic seq row. The collapse is presentation only: the
    // boxes stay independent in the model, individually selectable and fully editable
    // on canvas - but 200 generated caption cues must not become 200 lane rows, and
    // grouped bars never overlap in time (cues are sequential), so side by side on one
    // row is both honest and readable. The lane-explosion decision, section 5 of the plan.
    const groupLanes = new Map<string, HTMLElement>();
    // REVERSE model order (plans/165 Slice C-tracks): array order is paint order,
    // and the NLE convention every editor teaches is that the TOP track is the
    // FRONTMOST layer - so the last overlay in the array takes the first row, and
    // the magnetic seq row stays the floor (video-track-one at the bottom). A
    // group row sits where its frontmost member does.
    for (let bi = boxes.length - 1; bi >= 0; bi--) {
      const b = boxes[bi];
      if (!b) continue;
      const id = b[cfg.idField];
      if (id == null || id === '') continue;
      const timing = boxTiming(b, cfg);
      if (timing.lane === 'seq' || timing.start === null) continue;
      const group = cfg.groupField ? String(b[cfg.groupField] ?? '') : '';
      let lane = group ? groupLanes.get(group) : undefined;
      if (!lane) {
        lane = document.createElement('div');
        lane.className = 'tl-lane';
        // Presentational: a listbox may only own options, and these rows are pure
        // layout. Flattening them keeps every `role="option"` bar owned by the listbox.
        lane.setAttribute('role', 'presentation');
        lane.dataset.lane = 'overlay';
        // The row's FRONTMOST member (first placed in reverse order) - what a
        // vertical bar drag restacks against.
        lane.dataset.anchor = String(id);
        if (group) {
          groupLanes.set(group, lane);
          // A generated caption row says what it is. Other groups keep an unlabelled
          // shared row - their bars already carry their own labels.
          if (isCaptionGroup(group)) {
            lane.classList.add('tl-lane-captions');
            const lab = document.createElement('span');
            lab.className = 'tl-lane-label';
            lab.setAttribute('aria-hidden', 'true');   // every bar in it is announced itself
            lab.textContent = t('Captions');
            lane.appendChild(lab);
          }
        }
        laneWrap.appendChild(lane);
      }
      const el = makeBar(String(id), '');
      bars.set(String(id), el);
      lane.appendChild(el);
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
      // Pointer affordance only - a button is not a legal child of a listbox. The
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
        // inside a button is not legal HTML, hence the wrapper - the pill's border and
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
    refreshRemoved(boxes);   // keep the ignored-span map current for the playhead/seek maps
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
      // Struck-through / ignored (plans/174): the RULER keeps it (unlike a delete), greyed
      // and struck, while playback and export skip it. The bar stays draggable/restorable.
      el.classList.toggle('is-ignored', boxIgnored(b));
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
      // Read once and shared with the diamond gate below - `mediaOf` is a live DOM
      // query, and this loop runs per bar per restyle.
      const mediaKind = mediaOf(id).kind;
      el.dataset.kind = mediaKind || (seqSet.has(id) ? 'clip' : 'overlay');
      // Too narrow to carry two trim zones (see MIN_TRIM_BAR_PX): hide the grips and
      // say where the precise route is, rather than offering a target that would eat
      // the whole bar. Read off the width we just WROTE - asking the DOM for
      // offsetWidth here would force a layout per bar per keystroke.
      const tight = timeToPx(dur, pxPerSec) < MIN_TRIM_BAR_PX;
      el.classList.toggle('is-tight', tight);
      syncDiamonds(el, b, tight, isKeyframable(b, id, mediaKind));
      const base = `${text} · ${fmtTime(start)} → ${fmtTime(start + dur)}`;
      el.title = tight
        ? `${base} · ${t('This clip is too narrow to trim here. Zoom in, or set its Length in the panel.')}`
        : base;
      if (timing.speed !== 1) el.dataset.speed = String(timing.speed);
      else delete el.dataset.speed;
    }
    // Scenery chips carry the same selected state a bar does - otherwise selecting an
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
      // THROUGH EDIT - a cut whose two sides are still contiguous, i.e. a split nobody
      // has committed to yet. Final Cut's hairline marker, and the single mechanism in
      // the whole survey that makes cutting non-frightening: you can see at a glance
      // which seams are decisions and which are just "I cut here and changed nothing".
      // Computed HERE rather than in rebuild's seam pass, because contiguity dies to a
      // trim or a transition edit, neither of which changes tracksKey.
      // The MARK is the whole affordance, exactly as Final Cut does it - the tip still
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
    // AFTER the row is built (it may have just been rebuilt from scratch, taking the
    // latch's marks with it) and after the diamonds have been re-laid: this reads the
    // playhead against what is now on screen. `renderInspector` resets the memo when
    // it rebuilds, so a repaint can never leave the header saying the wrong thing.
    syncKfLatch();
    syncKfCam();
    // The mic's label follows the selection (record vs record-over), so it repaints
    // with everything else rather than needing its own observer.
    syncMicBtn();
    // And so does "+Keyframe": it is enabled by what is SELECTED, which is one of the
    // two things that bring us here.
    syncKfBtn();
    // So does the blade's - its scope depends on the selection and on the model, which
    // are exactly the two things that bring us here. The other half (the playhead
    // crossing a clip boundary) rides `tl-time`, so neither costs a per-tick pass.
    syncSplitBtn();
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

  // ── ignored-clip time mapping (plans/174) ───────────────────────────────────
  // The hook compresses ignored SEQ clips out of the CANVAS/clock timebase (their
  // data-t-start/data-seq-ms drop the gap), but the RULER keeps them in place, greyed.
  // So the clock's compressed ("edited") time and the ruler's authored time need mapping.
  // INERT when nothing is struck: `removedMs` is empty, and both maps are the identity -
  // so a document with no strikes is byte-for-byte unchanged. The list is cached and
  // refreshed on every model sync (restyle), never recomputed per playhead tick.
  let removedMs: { start: number; end: number }[] = [];
  function refreshRemoved(boxes: Box[]): void {
    removedMs = cfg.ignoredField
      ? removedSpansTimeline(boxes, cfg).map((s) => ({ start: s.start * 1000, end: s.end * 1000 }))
      : [];
  }
  /** Clock (compressed/edited) ms → ruler (authored) ms. */
  const toAuthoredMs = (clockMs: number): number => editedToOriginal(removedMs, clockMs);
  /** Ruler (authored) ms → clock (compressed/edited) ms. */
  const toClockMs = (authoredMs: number): number => originalToEdited(removedMs, authoredMs);
  /** Seek the clock to an AUTHORED-time position (the ruler/model's own time). */
  const seekAuthored = (authoredMs: number, opts?: { scrubbing?: boolean }): void =>
    clock.seek(toClockMs(Math.max(0, authoredMs)), opts);

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
    // The fallback is COMPUTED, never written back: a rebuild can run against a
    // model the latest edit has not reached yet (bars briefly missing the id focus
    // was just moved to), and persisting the stand-in permanently re-aimed every
    // keyboard edit (Shift+D, [/]/e) at the FIRST bar while the selection painted
    // elsewhere. A stale focusedId self-heals on the next pass once its bar exists.
    const target = (focusedId && bars.has(focusedId))
      ? focusedId
      : (selection.get().find((id) => bars.has(id)) || String(list[0]!.dataset.id || ''));
    for (const el of list) el.tabIndex = el.dataset.id === target ? 0 : -1;
  }

  // ── promotion / demotion (scenery ⇄ timed) ──────────────────────────────────

  /**
   * Give an UNTIMED box (scenery: no lane, no start - what the `text` / `image` /
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
   *     else DEFAULT_CLIP_S - the same 3 s the magnetic pack hands a clip it cannot
   *     measure, so a promoted box and a packed one never disagree.
   *   • `dur: null`, passed EXPLICITLY, means "author no length at all". That is the
   *     free-canvas create path: it promotes a box born milliseconds ago, before its
   *     asset picker has even opened, so mediaOf() cannot know a length yet and
   *     freezing DEFAULT_CLIP_S in would pin a 45 s audio track to 3 s and destroy the
   *     seq row's derive-from-media rule permanently. Left unauthored, packSeq fills a
   *     seq clip from its media later and an overlay stays open-ended to the sequence
   *     end - exactly what the same box added from the CANVAS already does.
   *   • The box lands on an OVERLAY lane, never on the magnetic seq row: seq membership
   *     is a separate, deliberate choice (it repacks the whole row), and silently
   *     joining the spine because someone typed a start would move other clips.
   *
   * NO clamping arithmetic lives here. `moveOverlay` owns the start clamp and the
   * millisecond grid; `setDuration` owns the length clamp and the media fit. Both are
   * pure, so composing them on the intermediate array is ONE undo step, not two - and
   * a promoted start lands on exactly the value a drag to the same time would.
   */
  /**
   * The PURE half of {@link promote}: the promoted array, no commit and no side
   * effects. Split out for the one caller that must compose it with a second write - 
   * "+Keyframe" on an UNTIMED box, which promotes it and poses its first keyframe in
   * ONE commit and therefore one undo step (section 8's M2.5 revision). Everything about the
   * resolution - the playhead start, the authored → media → DEFAULT_CLIP_S length
   * ladder, the overlay lane - is documented on `promote` and lives HERE so neither
   * caller re-derives it.
   */
  function promoteRows(rows: Box[], id: string, want?: { start?: number; dur?: number | null }): Box[] {
    const i = indexOfId(rows, cfg, id);
    if (!id || i < 0) return rows;
    const media = mediaOf(id).dur;
    const start = want?.start ?? clock.t() / 1000;
    const own = boxTiming(rows[i]!, cfg).dur;
    let dur = want && 'dur' in want ? want.dur : (own ?? media ?? DEFAULT_CLIP_S);
    // "Author no length" means "run open-ended to the sequence end" - which is NOTHING
    // when the start is AT the end of an already-derived sequence. And the playhead
    // (the default start) parks exactly there after every play-through, so the ordinary
    // "+ then pick" flow was minting clips nobody could see, scrub to, or play. When the
    // open window would be empty, author a real length instead (the media's when the
    // canvas knows it, else the pack's own default) - the sequence extends to hold it,
    // which is what adding at the end means everywhere else. Gated on a sequence
    // EXISTING (duration > 0): on a doc with no derived length yet, unauthored is still
    // right - the hook's DEFAULT_SEQ_S fallback opens a window for it, and authoring
    // here is what would pin a 45s track to 3s before its picker ever opened.
    if (dur == null && clock.duration() > 0 && start * 1000 >= clock.duration() - 1) dur = own ?? media ?? DEFAULT_CLIP_S;
    const moved = moveOverlay(rows, cfg, id, start);
    return dur == null ? moved : setDuration(moved, cfg, id, dur, media, mediaDur);
  }

  function promote(id: string, want?: { start?: number; dur?: number | null }): void {
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (!id || i < 0) return;
    const next = promoteRows(rows, id, want);
    // Both writers keep row IDENTITY for every row they did not change, so an
    // all-identical array means this promote had nothing to write - a seq-lane clip,
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
   * `start: ''` - not 0 - is what makes it scenery: boxTiming reads an authored 0 as
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
    // does - same pack, same overlay ripple - inside the same commit.
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
    ['camera', 'camera'],
  ]);

  function menuPosition(el: HTMLDivElement, anchor: PopoverAnchor): void {
    const r = anchor.getBoundingClientRect();
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    // Align to the anchor's NEAR edge - left under ltr, right under rtl (body-popover's
    // own default is right-aligned for the same reason). Aligning to `left` in Arabic
    // opens the menu away from the button that spawned it.
    const rtl = document.documentElement.dir === 'rtl';
    const near = rtl ? r.right - pw : r.left;
    // Clamp to the CONTENT area, not the viewport: a docked column reserves inline-end
    // space (right in ltr, left in rtl), so keep the popover clear of it.
    const dockW = edgeDockWidth();
    const left = Math.max(8 + (rtl ? dockW : 0), Math.min(near, vw - pw - 12 - (rtl ? 0 : dockW)));
    const top = r.bottom + 6 + ph > vh - 8 ? Math.max(8, r.top - ph - 6) : r.bottom + 6;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  /**
   * One menu row. Same markup + classes as the projects/folder menus, so no new CSS - 
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
   * creates a box itself - it names an add-kind and the time it wants, and free-canvas's
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
      // The label is the MANIFEST's, exactly as the canvas add-menu shows it - the
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

  // ── onion skin (opt-in, OFF by default) ──────────────────────────────────────
  //
  // The panel owns the PREFERENCE and the emission; views/onion-skin.ts owns the
  // drawing and is lazily imported by free-canvas off the `tl-time` detail. Nothing
  // here touches the model, so nothing here is undoable - a view preference is not an
  // edit, and putting it on the undo stack would make Cmd-Z stop meaning "unmake that
  // change to my work".

  function syncOnionBtn(): void {
    const on = !!onionPref;
    onionBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    onionBtn.classList.toggle('is-active', on);
  }
  syncOnionBtn();

  /**
   * The ONE writer for the preference: persist, reflect on the button, and push a fresh
   * `tl-time` so the canvas repaints without waiting for the clock to move (a paused
   * timeline emits no ticks at all, which is exactly when someone is fiddling with these).
   */
  function setOnion(next: OnionPref | null, opts?: { speak?: boolean }): void {
    onionPref = next;
    writeOnionPref(next);
    syncOnionBtn();
    if (opts?.speak) announce(next ? t('Onion skin on') : t('Onion skin off'));
    emitTime(clock.t());
  }

  function toggleOnion(): void {
    setOnion(onionPref ? null : { ...ONION_DEFAULT }, { speak: true });
  }

  /** Change one option, turning the feature ON if it was off (the popover implies intent). */
  function patchOnion(patch: Partial<OnionPref>): void {
    setOnion({ ...(onionPref ?? ONION_DEFAULT), ...patch });
  }

  const onionMenu = mountBodyPopover(onionBtn, (el) => {
    el.textContent = '';
    const cur = onionPref ?? ONION_DEFAULT;

    const desc = document.createElement('p');
    desc.className = 'tl-onion-desc';
    desc.textContent = t('Show ghosts of the scenes either side of the playhead.');
    el.appendChild(desc);

    const row = (labelText: string, control: HTMLElement): HTMLElement => {
      const wrap = document.createElement('label');
      wrap.className = 'field-row field-row--inline tl-field tl-onion-row';
      const lab = document.createElement('span');
      lab.className = 'field-label';
      lab.textContent = labelText;
      wrap.append(lab, control);
      return wrap;
    };

    // Mode. A <select> rather than a pair of radios: two mutually exclusive labelled
    // choices is exactly what `.field-select` already is in this panel (the transition
    // kind picker), and forking radio styling here would be a second primitive for the
    // same job. Outlines first, because it is the default and the one that stays
    // legible over an opaque scene.
    const mode = document.createElement('select');
    mode.className = 'field-select tl-select';
    for (const [value, label] of [['outline', t('Outlines')], ['filled', t('Filled')]] as const) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      mode.appendChild(o);
    }
    mode.value = cur.mode;
    mode.addEventListener('change', () => patchOnion({ mode: mode.value === 'filled' ? 'filled' : 'outline' }));
    el.appendChild(row(t('Mode'), mode));

    // Before and after are configured INDEPENDENTLY (the Procreate Dreams pattern):
    // "two behind, none ahead" is a real way to work, and a single symmetric count
    // cannot express it.
    const stepper = (value: number, onCommit: (v: number) => void): HTMLInputElement => {
      const n = document.createElement('input');
      n.className = 'field-input tl-num tl-onion-step';
      n.type = 'number';
      n.min = '0';
      n.max = String(ONION_MAX_STEPS);
      n.step = '1';
      n.value = String(value);
      n.addEventListener('change', () => onCommit(Number(n.value)));
      return n;
    };
    el.appendChild(row(t('Scenes before'), stepper(cur.before, (v) => patchOnion({ before: onionStep(v) }))));
    el.appendChild(row(t('Scenes after'), stepper(cur.after, (v) => patchOnion({ after: onionStep(v) }))));

    const strength = document.createElement('input');
    strength.className = 'field-range';
    strength.type = 'range';
    strength.min = '10';
    strength.max = '100';
    strength.step = '5';
    strength.value = String(Math.round(cur.opacity * 100));
    // `input`, not `change`: the whole point of the slider is watching the ghosts fade.
    strength.addEventListener('input', () => patchOnion({ opacity: onionOpacity(Number(strength.value) / 100) }));
    el.appendChild(row(t('Ghost strength'), strength));

    return mode;
  }, {
    className: 'folder-menu tl-menu tl-onion-pop',
    role: 'dialog',
    ariaLabel: t('Onion skin options'),
    position: menuPosition,
  });

  // Plain click toggles; a long press or a right-click opens the options. Escape and the
  // focus restore come free from mountBodyPopover, which is why this is not hand-rolled.
  let onionHold: ReturnType<typeof setTimeout> | 0 = 0;
  let onionHeld = false;
  const cancelOnionHold = (): void => { if (onionHold) { clearTimeout(onionHold); onionHold = 0; } };
  onionBtn.addEventListener('pointerdown', () => {
    onionHeld = false;
    cancelOnionHold();
    onionHold = setTimeout(() => { onionHold = 0; onionHeld = true; onionMenu.open(); }, 500);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) onionBtn.addEventListener(ev, cancelOnionHold);
  onionBtn.addEventListener('click', () => {
    // The long press already did something; the click that ends it must not undo it.
    if (onionHeld) { onionHeld = false; return; }
    toggleOnion();
  });
  onionBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelOnionHold();
    if (onionMenu.isOpen()) onionMenu.close(true); else onionMenu.open();
  });

  // ── stagger starts (plans/175 WP-C - Jitter's right-click Stagger) ──────────
  //
  // One small anchored card: a gap in ms, Enter/Stagger applies. The maths is
  // timeline-math's staggerOverlays - this card is a door, never an implementation.

  /** The selection members a Stagger can act on: timed OVERLAY boxes (a seq clip's
   *  start is pack-derived, so the magnetic row is never dealt). */
  function staggerableIds(rows: Box[], ids: readonly string[]): string[] {
    return ids.filter((id) => {
      const i = indexOfId(rows, cfg, id);
      return i >= 0 && isTimed(rows[i]!, cfg) && boxTiming(rows[i]!, cfg).lane !== 'seq';
    });
  }

  const staggerPoint = pointAnchor();
  let staggerIds: string[] = [];
  let lastStaggerMs = 200;
  const staggerPop = mountBodyPopover(staggerPoint, (el) => {
    el.textContent = '';
    const label = document.createElement('label');
    label.className = 'tl-stagger-label';
    const caption = document.createElement('span');
    caption.textContent = t('Gap between starts (ms)');
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'field-input tl-num';
    input.min = '0';
    input.step = '50';
    input.value = String(lastStaggerMs);
    label.append(caption, input);
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn tl-stagger-apply';
    apply.textContent = t('Stagger');
    const go = (): void => {
      const ms = Math.max(0, Math.round(finite(input.value, lastStaggerMs)));
      lastStaggerMs = ms;
      write(staggerOverlays(getBoxes(), cfg, staggerIds, ms / 1000));
      staggerPop.close();
    };
    apply.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    el.append(label, apply);
    return input;
  }, { className: 'folder-menu tl-menu tl-stagger-pop', ariaLabel: t('Stagger starts'), position: menuPosition });

  function openStaggerPop(ids: string[]): void {
    staggerIds = ids;
    staggerPoint.x = ctxPoint.x;
    staggerPoint.y = ctxPoint.y;
    staggerPoint.delegate = ctxPoint.delegate;
    staggerPop.close();
    staggerPop.open();
  }

  // ── the bar / chip context menu ─────────────────────────────────────────────

  /** A virtual anchor at the right-click point; `delegate` carries the keyboard route. */
  const ctxPoint = pointAnchor();
  let ctxId = '';
  /** Non-null while the menu is acting on a KEPT multi-selection (plans/175 WP-C):
   *  the staggerable members, decided once in openCtxMenu so the open decision and
   *  the render can never disagree. */
  let ctxMulti: string[] | null = null;

  const ctxMenu = mountBodyPopover(ctxPoint, (el, pop) => {
    const rows = getBoxes();
    const i = ctxId ? indexOfId(rows, cfg, ctxId) : -1;
    if (i < 0) {
      // mountBodyPopover appends, positions and focus-traps whatever this render leaves
      // behind - a null return only means "don't move focus", not "don't open". Bail out
      // of the open itself, or a box that vanished between openCtxMenu's check and here
      // paints an empty, focus-trapped card. Unreachable today (openCtxMenu re-checks in
      // the same tick); one microtask is the cheap insurance against that ever deferring.
      queueMicrotask(() => pop.close());
      return null;
    }
    const timed = isTimed(rows[i]!, cfg);
    el.textContent = '';
    const act = (fn: () => void) => () => { pop.close(); fn(); };
    // A KEPT multi-selection (plans/175 WP-C) gets the selection-wide actions and
    // nothing else: mixing per-box rows in would act on one bar while several stay
    // painted selected - the exact state the collapse rule below exists to prevent.
    if (ctxMulti && ctxMulti.length >= 2) {
      const n = ctxMulti.length;
      el.appendChild(menuItem(t('Stagger starts…'), 'layers', act(() => openStaggerPop(ctxMulti ?? [])),
        { sub: t('Deals the {n} selected clips an even gap, each starting after the one before.', { n: String(n) }) }));
      return el.querySelector<HTMLElement>('.folder-menu-item');
    }
    if (timed) {
      // Exactly the writers that already exist - the context menu is a second DOOR onto
      // them, never a second implementation (see promote/demote above).
      el.appendChild(menuItem(t('Split at playhead'), 'scissors', act(() => { selectAndReveal([ctxId]); splitAtPlayhead(); })));
      // Video only, and absent (never greyed) otherwise - the same offered-only-
      // where-real rule as Join/Subtitles below.
      if (canExportFrame(ctxId)) {
        el.appendChild(menuItem(t('Export frame'), 'camera', act(() => { void exportFrameAt(ctxId); }),
          { sub: t('Saves the frame under the playhead as a PNG, at full resolution.') }));
      }
      // Remove background: make a transparent alternative asset for this video clip's
      // source on device (the shared video-job dialog, op 'matte'). Offered only where
      // it is real - the same video + staged-model gate the catalog detail modal uses.
      if (canVideoMatte(ctxId)) {
        el.appendChild(menuItem(t('Remove background…'), 'scissors', act(() => { void videoMatteAt(ctxId); }),
          { sub: t('Makes a transparent copy you can swap onto this track.') }));
      }
      // Join is offered only where it is REAL: a cut whose two sides are still perfectly
      // contiguous, on either side of this clip. Everywhere else the item is absent
      // rather than disabled - a menu of greyed-out rows teaches nothing.
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
      // Mute clip audio: a SECOND DOOR onto the inspector's mute toggle (the same
      // `cfg.muteField` write, never a second implementation - see the promote/demote
      // rule above). Offered only where there is sound to silence - a clip with its own
      // audio, or one of a detached-audio pair - the same offered-only-where-real rule
      // as Join/Detach above, never on a silent still.
      if (canDetach(ctxId) || partner) {
        const muted = rows[i]![cfg.muteField] === true || rows[i]![cfg.muteField] === 'true';
        el.appendChild(menuItem(muted ? t('Unmute clip') : t('Mute clip'), muted ? 'volumeOff' : 'volumeOn',
          act(() => write(patchBox(getBoxes(), ctxId, { [cfg.muteField]: muted ? '' : 'true' }))),
          { sub: t('Silences this clip’s own sound without removing it.') }));
      }
      // Subtitles, for a clip with sound - absent (never greyed) when no timing
      // source is reachable, the same offered-only-where-real rule as Join.
      if (canGenerateSubtitles(ctxId)) {
        el.appendChild(menuItem(t('Generate subtitles'), 'speech', act(() => { void generateSubtitles(ctxId); }),
          { sub: t('Adds timed caption boxes you can edit like any clip.') }));
      }
      el.appendChild(menuItem(t('Make always on'), 'layers', act(() => demote(ctxId))));
    } else {
      el.appendChild(menuItem(t('Add to the timeline'), 'plus', act(() => promote(ctxId))));
    }
    // Rename: the second door onto the double-click inline editor. Needs a BAR to
    // anchor the input, so a scenery chip (no bar) does not offer it.
    if (cfg.labelField && bars.has(ctxId)) {
      el.appendChild(menuItem(t('Rename'), 'tag', act(() => renameClip(ctxId))));
    }
    el.appendChild(menuItem(t('Delete'), 'trash', act(() => deleteBox(ctxId)), { danger: true }));
    return el.querySelector<HTMLElement>('.folder-menu-item');
  }, { className: 'folder-menu tl-menu tl-ctx-menu', ariaLabel: t('Clip actions'), position: menuPosition });

  /**
   * Open the context menu on one box. Right-click SELECTS first (free-canvas's
   * contextMenuAt does the same), so whatever the menu acts on is also what the
   * inspector and the canvas chrome are showing.
   *
   * The selection COLLAPSES to the clicked box when it was already part of a
   * multi-selection the menu cannot act on as one: the per-box items act on `ctxId`
   * alone, so leaving three bars painted as selected while "Make always on" demotes
   * one of them shows the user a state that never existed - and the next act is an
   * undo of something they did not think they did. Free-canvas's sibling menu
   * resolves the same tension the other way (it disables per-box items on a
   * multi-selection); here collapsing is better, because the box under the pointer
   * is unambiguous. The ONE exception (plans/175 WP-C): a selection of two or more
   * staggerable overlays is kept, and the menu offers only the selection-wide
   * actions - the painted bars and the acted-on set stay the same set.
   */
  function openCtxMenu(id: string, x: number, y: number, delegate: HTMLElement | null): void {
    if (!id || indexOfId(getBoxes(), cfg, id) < 0) return;
    ctxId = id;
    const sel = selection.get();
    // ONE exception to the collapse (plans/175 WP-C): a multi-selection that
    // contains the clicked box AND can act as one (two or more staggerable
    // overlays) is kept, and the menu offers the selection-wide actions instead
    // of the per-box ones. Everything else collapses, for the reason above.
    const multi = sel.length >= 2 && sel.includes(id) ? staggerableIds(getBoxes(), sel) : [];
    ctxMulti = multi.length >= 2 ? multi : null;
    if (!ctxMulti && (sel.length !== 1 || sel[0] !== id)) selectAndReveal([id]);
    if (bars.has(id)) { focusedId = id; updateRovingTabindex(); }
    ctxPoint.x = x;
    ctxPoint.y = y;
    ctxPoint.delegate = delegate;
    ctxMenu.close();
    ctxMenu.open();
  }

  /**
   * The diamond's own menu: the three things section 3 lists on the transport's right - 
   * EASING / DUPLICATE / DELETE - offered where the pointer already is.
   *
   * Pointer sugar again, and the same three actions are labelled buttons in the
   * inspector's list, so nothing here is the only way to reach anything.
   */
  const kfCtxPoint = pointAnchor();
  let kfCtxId = '';
  let kfCtxT = 0;

  const kfCtxMenu = mountBodyPopover(kfCtxPoint, (el, pop) => {
    const rows = getBoxes();
    const i = kfCtxId ? indexOfId(rows, cfg, kfCtxId) : -1;
    const key = i < 0 ? null : kfKeyAt(kfBoxTrack(rows[i]!, cfg), kfCtxT);
    if (!key) { queueMicrotask(() => pop.close()); return null; }
    el.textContent = '';
    const act = (fn: () => void) => () => { pop.close(); fn(); };
    // ONE SURFACE (section 8's M2.7): the curve editor is DOCKED in the Keyframes popup, so
    // this item opens that popup on this keyframe rather than spawning a second,
    // nested editor of its own - which is exactly what a left-click on the same
    // diamond already does. The item stays because a context menu that lists Duplicate
    // and Delete and not the third thing you can do to a keyframe is a menu with a
    // hole in it.
    el.appendChild(menuItem(t('Keyframe curve'), 'animate', act(() => openKeyframeAt(kfCtxId, kfCtxT))));
    el.appendChild(menuItem(t('Duplicate keyframe'), 'duplicate', act(() => duplicateKeyframe(kfCtxId, kfCtxT))));
    el.appendChild(menuItem(t('Delete keyframe'), 'trash', act(() => deleteKeyframe(kfCtxId, kfCtxT)), { danger: true }));
    return el.querySelector<HTMLElement>('.folder-menu-item');
  }, { className: 'folder-menu tl-menu tl-ctx-menu', ariaLabel: t('Keyframe actions'), position: menuPosition });

  function onContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    // The diamond first: it lives inside a bar, so the bar's menu would always win.
    const dot = target?.closest<HTMLElement>('.tl-kf-dot');
    const dotBar = dot?.closest<HTMLElement>('.tl-clip');
    if (dot && dotBar?.dataset.id && cfg.kfField) {
      const at = finite(dot.dataset.t, NaN);
      if (Number.isFinite(at)) {
        e.preventDefault();
        e.stopPropagation();
        kfCtxId = dotBar.dataset.id;
        kfCtxT = at;
        if (!selection.get().includes(kfCtxId)) selectAndReveal([kfCtxId]);
        kfCtxPoint.x = e.clientX;
        kfCtxPoint.y = e.clientY;
        kfCtxPoint.delegate = null;
        kfCtxMenu.close();
        kfCtxMenu.open();
        return;
      }
    }
    const el = target?.closest<HTMLElement>('.tl-clip, .tl-chip, .tl-chip-add');
    const id = el?.dataset.id || '';
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    openCtxMenu(id, e.clientX, e.clientY, null);
  }

  /** The keyboard route (Menu key / Shift+F10) - a pointer-only menu is not reachable. */
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

  /**
   * ENTERING is not the same as CHANGING. The inspector is a whole row of controls that
   * lands in a toolbar the user is already looking at, and watching it land is the
   * complaint that started this: three regions of chrome appeared between two adjacent
   * frames of a screen recording, one of them clipping a tool button, with nothing to
   * lead the eye. So the arrival is announced - `is-entering` runs one short fade and
   * rise - and ONLY the arrival: a field edit or a scrub rebuilds this row constantly,
   * and re-running the cue on every one of those is its own kind of noise.
   *
   * Reduced motion is honoured in the sheet rather than by withholding the class, so
   * the cue still exists for someone who asked for less movement - it just does not
   * move.
   */
  let inspectorShown = false;
  /**
   * WHICH box the inspector row currently describes. The group segments are built
   * inside `renderInspector` but pressed long afterwards, so a head's click handler
   * reads this rather than closing over an `id` that a later rebuild has replaced.
   */
  let inspectorId = '';
  let inspectorEnterT: ReturnType<typeof setTimeout> | null = null;

  /* ── the custom-easing popover ─────────────────────────────────────────────
     ONE instance for both directions: which box and which field it writes are
     `easeId` / `easeField`, set by the trigger before `open()`. The trigger itself
     cannot be the anchor - the inspector rebuilds its controls on every commit, so
     the `<select>` that opened this is a detached node moments later. `pointAnchor`
     with a `delegate` is the same shape openCtxMenu already uses for exactly that:
     the point supplies geometry, the delegate takes the focus restore.

     Body-mounted (via mountBodyPopover) rather than parented in the panel, because
     the panel is a fixed-position band whose descendants must never become the
     containing block for this card - the trap documented on `.tl-panel` and
     `.fc-toolbar`. Escape, the outside click and the focus restore come free with it. */
  const easePoint = pointAnchor();
  let easeId = '';
  let easeField = '';
  let easeEditor: EasingEditorHandle | null = null;

  const easeMenu = mountBodyPopover(easePoint, (el, pop) => {
    const rows = getBoxes();
    const i = easeId ? indexOfId(rows, cfg, easeId) : -1;
    if (i < 0 || !easeField) { queueMicrotask(() => pop.close()); return null; }
    easeEditor?.destroy();
    easeEditor = mountEasingEditor(el, {
      value: rows[i]![easeField],
      // The same one-commit / one-undo-step write every other field in this row makes.
      onCommit: (wire) => write(patchBox(getBoxes(), easeId, { [easeField]: wire })),
    });
    return easeEditor.focusTarget;
  }, {
    className: 'folder-menu tl-menu tl-ease-pop',
    role: 'dialog',
    ariaLabel: t('Custom easing curve'),
    position: menuPosition,
  });

  /** Open the curve editor for one box + one ease field, anchored under its trigger. */
  function openEaseEditor(id: string, field: string, trigger: HTMLElement): void {
    if (!id || !field || indexOfId(getBoxes(), cfg, id) < 0) return;
    easeId = id;
    easeField = field;
    const r = trigger.getBoundingClientRect();
    easePoint.x = r.left;
    easePoint.y = r.bottom;
    easePoint.delegate = trigger;
    easeMenu.close();
    easeMenu.open();
  }

  // ── the keyframe writers (one commit each, like every other panel writer) ────

  /** The playhead, in the seconds every kf helper speaks. */
  function playheadSec(): number {
    return clock.t() / 1000;
  }

  /**
   * CAN this box be keyframed at all (plans/104 section 8, M2.5) - the ONE rule, with five
   * readers: "+Keyframe"'s scope, the transport button's enabled state, the canvas
   * contextual bar's enabled state (through `keyframableIds` on the handle), the
   * inspector's Keyframes group, and the diamonds on the bar.
   *
   * Deliberately permissive: a box is keyframable timed or not, because the M2.5
   * revision made the button itself the door - an untimed box is promoted onto the
   * timeline and keyed in the same commit. Two exclusions, both named in section 8:
   *
   *   • `audio` - sound has no pose to strike; keyframed gain is plan 101's, and until
   *     it exists an audio clip in a mixed selection must fall out rather than be
   *     silently given an x/y/s/r/o track no evaluator reads. The kind is taken from
   *     the MODEL row and from the live canvas, because a box carrying an audio asset
   *     is an audio clip whatever its `kind` says. That second source is exactly why
   *     this is a function and not an inline `kind !== 'audio'` at each site: a model
   *     read alone offers the affordance to a box the writer then refuses.
   *   • a `camera` is keyframable (it exists only to be animated) but is never
   *     PROMOTED by "+Keyframe" - a camera is timed by construction, so that button's
   *     promote branch can only be reached by a content box.
   *
   * `mediaKind` is the caller's already-paid `mediaOf(id).kind` where it has one (the
   * restyle loop reads it a line earlier for `data-kind`); omit it and this reads the
   * live canvas itself.
   */
  function isKeyframable(row: Box | undefined, id: string, mediaKind?: string): boolean {
    if (!cfg.kfField || !row) return false;
    return String(row.kind ?? '') !== 'audio' && (mediaKind ?? mediaOf(id).kind) !== 'audio';
  }

  /** WHICH of the selected boxes "+Keyframe" would act on. */
  function kfActionIds(): string[] {
    if (!cfg.kfField) return [];
    const rows = getBoxes();
    return selection.get().filter((id) => isKeyframable(rows[indexOfId(rows, cfg, id)], id));
  }

  /**
   * THE "+Keyframe" action - one implementation, three doors (the transport button,
   * the canvas contextual bar, and `K`), which is the whole point of section 8's M2.5
   * revision: "TWO homes, one action".
   *
   * Add-or-update the full pose at the playhead on every keyframable selected box, in
   * ONE write, so a multi-select press is ONE undo step (section 8's gesture/commit law,
   * applied to a press). `writeKfPose` returns the array by identity for a box it
   * cannot key, so anything unkeyable simply falls out.
   *
   * AUTO-PROMOTION is the new half: a selected box with no time at all is promoted
   * onto an overlay lane and keyed **inside the same array**, so the commit below is
   * still one write and one ⌘Z takes both back. `promoteRows` is the panel's existing
   * resolution (playhead start, authored → media → DEFAULT_CLIP_S length), composed - 
   * never re-derived.
   */
  function addKeyframeAction(opts?: { speak?: boolean }): void {
    if (!cfg.kfField) return;
    const ids = kfActionIds();
    if (!ids.length) return;
    const at = playheadSec();
    const before = getBoxes();
    let next = before;
    // Where the FIRST written keyframe actually landed - which is the playhead unless
    // it sat outside the clip, in which case `kfWriteMs` clamped it to the clip's own
    // edge. Announcing the playhead there would name a time no keyframe exists at.
    let landed: number | null = null;
    let promoted = 0;
    for (const id of ids) {
      const i = indexOfId(next, cfg, id);
      if (i < 0) continue;
      // A camera is timed by construction; only a content box can be scenery here.
      if (!isTimed(next[i]!, cfg) && String(next[i]!.kind ?? '') !== 'camera') {
        // The CAPTURED playhead, not `promoteRows`'s own `clock.t()` fallback. Both
        // reads are the playhead, but they are two reads: while the transport is
        // playing the second one is later, so the clip would start after the time its
        // first keyframe is then written at - the pose lands at a non-zero local ms (or
        // gets clamped to the clip edge) instead of at the box's own t = 0, and the
        // announcement names a time no keyframe is at. One gesture, one instant.
        const grown = promoteRows(next, id, { start: at });
        if (grown !== next) { next = grown; promoted++; }
      }
      const step = writeKfPose(next, cfg, id, at, {}, 'set');
      if (step !== next && landed === null) {
        const j = indexOfId(next, cfg, id);
        if (j >= 0) landed = kfTimelineSec(next[j]!, cfg, kfWriteMs(next[j]!, cfg, at));
      }
      next = step;
    }
    if (next === before) return;
    write(next);
    if (!opts?.speak) return;
    // The promotion is the surprising half, so it is the half that is spoken: a box
    // that was "always on" a moment ago now has a start and a length.
    announce(promoted
      ? t('Added to the timeline. Keyframe at {t}', { t: fmtTime(landed ?? at) })
      : t('Keyframe at {t}', { t: fmtTime(landed ?? at) }));
  }

  /**
   * The transport button's enabled state, memoised on the ACHIEVED state rather than
   * on the selection: this runs on every repaint, and the attribute must not be
   * rewritten on each one. Disabled - `aria-disabled`, never `hidden` - is a real
   * state here: with nothing keyframable selected the button stays in place and its
   * tooltip says what would make it work.
   */
  let kfBtnKey = '\u0000';
  function syncKfBtn(): void {
    if (!cfg.kfField) return;
    const n = kfActionIds().length;
    const key = String(n);
    if (key === kfBtnKey) return;
    kfBtnKey = key;
    const tip = n === 0
      ? t('Select something on the canvas to keyframe it')
      : n === 1 ? t('+Keyframe') : t('+Keyframe on {n} objects', { n: String(n) });
    kfBtn.setAttribute('aria-disabled', n === 0 ? 'true' : 'false');
    kfBtn.setAttribute('aria-label', tip);
    kfBtn.setAttribute('data-tip', tip);
  }
  kfBtn.addEventListener('click', () => {
    if (kfBtn.getAttribute('aria-disabled') === 'true') return;
    addKeyframeAction({ speak: true });
  });

  /** The Animate door: a t = 0 pose, which is where an animation starts (section 8). */
  function animateBox(id: string): void {
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0 || !cfg.kfField) return;
    // t = 0 in the box's OWN time, which is its start on the timeline - not the
    // playhead. A door that opened onto a track whose only key sat wherever the
    // playhead happened to be would make the clip jump the moment it was animated.
    const next = writeKfPose(rows, cfg, id, kfTimelineSec(rows[i]!, cfg, 0), {}, 'set');
    if (next === rows) return;
    write(next);
    announce(t('Animating. Move the playhead and press K to add a pose.'));
  }

  /** One track's worth of edit, from the CRUD list or the diamond menu. */
  function writeTrack(id: string, edit: (track: KfTrack) => Parameters<typeof setKfTrack>[3]): void {
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0) return;
    write(setKfTrack(rows, cfg, id, edit(kfBoxTrack(rows[i]!, cfg))));
  }

  /**
   * Alt+←/→ - the playhead to the previous / next diamond of the SELECTED boxes.
   *
   * Same selection rule as the latch, for the same reason: the diamonds you can walk
   * are the ones you declared you were working on. Stops at the ends rather than
   * wrapping - a shortcut that silently teleports to the other end of a sequence is
   * how you lose your place.
   */
  function seekDiamond(dir: number): void {
    if (!cfg.kfField) return;
    const rows = getBoxes();
    const sel = selection.get();
    const to = kfSeekDiamond(rows, cfg, sel, playheadSec(), dir);
    if (to === null) {
      // "Last keyframe" on a box that HAS none is a lie about why nothing moved (section 8's
      // M2.6 low). Three different silences, and the shortcut has to name the right
      // one: nothing selected, nothing animated, or genuinely at the end of a track.
      const any = sel.some((id) => {
        const i = indexOfId(rows, cfg, id);
        return i >= 0 && kfDiamondTimes(rows[i]!, cfg).length > 0;
      });
      announce(!sel.length ? t('Select something on the canvas to keyframe it')
        : !any ? t('No keyframes')
          : dir > 0 ? t('Last keyframe') : t('First keyframe'));
      return;
    }
    seekAuthored(to * 1000);
    announce(t('Keyframe @ {t}', { t: fmtTime(to) }));
  }

  /**
   * Park the playhead on one keyframe and open the Keyframes popup on it (section 8's M2.7).
   *
   * Selection, playhead and popup in one press, in that order and deliberately: the
   * selection is what builds the inspector row this popup borrows its body from (so
   * the group must exist before it can be opened), and the seek comes after it because
   * `selectAndReveal` moves the playhead to the clip's start when the selection would
   * otherwise be off screen - which would land it beside the diamond rather than on it.
   *
   * Writes nothing. Opening a keyframe is a way of LOOKING at it, and section 8's whole model
   * is that nothing is keyed by accident.
   */
  function openKeyframeAt(id: string, atMs: number): void {
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0 || !cfg.kfField) return;
    if (!selection.get().includes(id)) selectAndReveal([id]);
    seekAuthored(kfTimelineSec(rows[i]!, cfg, atMs) * 1000);
    // The row is rebuilt by the selection change above (restyle → renderInspector), so
    // the segment this points at is the live one. On a box whose row offers no
    // Keyframes group (there is none - a diamond only exists where the group does)
    // `openGroupPopover` finds nothing and does nothing.
    openGroupPopover('keyframes', id);
    syncKfLatch();
  }

  /** Delete one keyframe, from wherever it was asked for. */
  function deleteKeyframe(id: string, atMs: number): void {
    writeTrack(id, (track) => kfTrackDelete(track, atMs));
    announce(t('Keyframe deleted'));
  }

  /** Copy one keyframe into the gap after it. */
  function duplicateKeyframe(id: string, atMs: number): void {
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0) return;
    const dur = span(rows[i]!, durationSec()).dur;
    writeTrack(id, (track) => kfTrackDuplicate(track, atMs, kfDuplicateMs(track, atMs, dur)));
  }

  // ── the camera (plans/104 section 5.4, section 8) ─────────────────────────────────────────
  //
  // A camera is an ordinary box of kind `camera` whose only job is to be animated.
  // The panel owns three things about it and nothing else: WHERE its pose is written
  // (this section), how it is offered (the Camera inspector group), and whether a
  // canvas gesture is currently aimed at it (`cameraModeId`). Every NUMBER is the
  // engine's - `resolveCamera` reads the same track this writes.

  const cameraKind = (): TimelineAddKind | undefined => addKinds.find((k) => k.id === 'camera');

  /** A box is a camera because its kind says so - the hooks' own rule (section 5.4). */
  function isCameraBox(b: Box | undefined): boolean {
    return !!b && String(b.kind ?? '') === 'camera';
  }

  /** The scene camera's id, or '' - the FIRST camera in the array (DOM order). */
  function sceneCameraId(rows: Box[]): string {
    for (const b of rows) if (isCameraBox(b)) return String(b?.[cfg.idField] ?? '');
    return '';
  }

  /**
   * THE IMPLICIT SCENE CAMERA (section 5.4's "default experience", the review's strongest UX
   * finding): the first depth interaction auto-creates ONE untimed camera box.
   *
   * PURE - it returns the array and the id, and commits nothing, so the gesture that
   * triggered it composes the camera and its own write into ONE commit and therefore
   * one undo step. That is the whole reason this is not a `write()`: lifting a box and
   * minting the camera that looks at it is one action to the user, and two ⌘Zs to undo
   * it would be a lie about what just happened.
   *
   * UNTIMED, deliberately: no `start` field, so it renders as an "Always on" scenery
   * chip whose inspector is the scene-camera panel - Depthfield's SCENE DEFAULTS. It
   * becomes a timed clip only when promoted (the existing timed ⇄ always-on switch),
   * and a SECOND camera is how you cut.
   *
   * It is born from the manifest's own `camera` add-kind seed where the tool declares
   * one, exactly as a recorded take is born from the audio seed - the panel never
   * invents a kind. With no seed it still mints `{kind:'camera'}`, because the wire is
   * the contract and the hooks key their marker off `kind` alone.
   *
   * No geometry: a camera has no canvas footprint (section 5.4), and a zero-size box is
   * exactly that - nothing to hit-test, nothing to marquee, nothing to paint.
   */
  function ensureSceneCameraRows(rows: Box[]): { rows: Box[]; id: string } {
    const found = sceneCameraId(rows);
    if (found) return { rows, id: found };
    const id = mintId(rows);
    const box: Box = {
      ...(cameraKind()?.seed as Box | undefined),
      kind: 'camera',
      [cfg.idField]: id,
    };
    return { rows: [...rows, box], id };
  }

  /**
   * WHERE a camera pose edit lands, in TIMELINE seconds - or null when it may not land
   * at all. The camera's reading of section 8's latch, and the one place that decides it.
   *
   * Three cases, in order:
   *   • parked ON a diamond → that keyframe. The ordinary latch rule.
   *   • a track of at most ONE key → that key (or t = 0 when there are none). A single
   *     key IS the scene default: evaluation clamp-holds before the first key and after
   *     the last, so with one key the camera holds that pose for the whole sequence.
   *     This is what makes the fresh implicit camera behave as SCENE DEFAULTS - pan it,
   *     dolly it, change its focus, and the whole shot moves - with no keyframe UI in
   *     the way and no auto-keying (section 8's "No auto-key" is about NEW diamonds; there is
   *     no new diamond here).
   *   • a real MOVE (two or more keys), off every diamond → null. Writing the first key
   *     of an authored move from a playhead parked somewhere else would change the shot
   *     everywhere except where the user is looking.
   */
  function cameraPoseAtSec(box: Box, atSec: number): number | null {
    const on = kfDiamondAt(box, cfg, atSec);
    if (on !== null) return atSec;
    const track = kfBoxTrack(box, cfg);
    if (track.length === 0) return kfTimelineSec(box, cfg, 0);
    if (track.length === 1) return kfTimelineSec(box, cfg, track[0]!.t);
    return null;
  }

  /**
   * Is a canvas gesture currently aimed at the camera (section 8: "camera mode is entered by
   * SELECTION, never a global toggle")? Returns the camera's id, or ''.
   *
   * Three conditions, all of them things the user can SEE: the panel is open (the same
   * reason `kfPoseIds` refuses a shut panel - with no playhead on screen there is no
   * arm), exactly one box is selected and it is a camera, and the playhead is inside
   * its window (a camera that is not running is not the camera you are looking
   * through). Clicking a box exits by ordinary selection semantics; there is nothing
   * to turn off.
   */
  function cameraModeId(): string {
    if (!open || !cfg.kfField) return '';
    const sel = selection.get();
    if (sel.length !== 1) return '';
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, sel[0]!);
    if (i < 0 || !isCameraBox(rows[i]!)) return '';
    const box = rows[i]!;
    if (isTimed(box, cfg)) {
      const { start, dur } = span(box, durationSec());
      const at = playheadSec();
      if (at < start || at >= start + dur) return '';
    }
    return sel[0]!;
  }

  /**
   * A camera gesture's delta, folded into whichever key `cameraPoseAtSec` resolved - 
   * pure, like `kfPoseWrite`, so the caller commits once on release.
   *
   * `'add'`, because a drag and a wheel are both "from wherever it already was": the
   * channels are absolute on a camera (a keyed channel REPLACES the base), but a
   * gesture's number is a change, and `writeKfPose` composes the two by evaluating the
   * pose at that instant first.
   *
   * WHICH IS ALSO WHY THE TILT BAND IS HELD HERE and not in the caller. `KF_TILT_CONTROL`
   * bounds the RESULT, and a shift-drag only ever supplies a delta - clamping the delta
   * would let three drags of +30° walk `rx` to 90 and past the sign change in `κ` that
   * the depth sort depends on. So the composed value is what gets held: re-evaluate the
   * pose the write is about to start from (the same `kfWriteMs` + `kfPoseAt` reading
   * `writeKfPose` itself takes, so the two cannot disagree about which key that is) and
   * shrink the delta to whatever the band still has room for. A drag that runs into the
   * end of the band simply stops turning, which is what every clamped control does.
   */
  function cameraWrite(boxes: Box[], delta: KfPose): Box[] {
    const id = cameraModeId();
    if (!id) return boxes;
    const i = indexOfId(boxes, cfg, id);
    if (i < 0) return boxes;
    const box = boxes[i]!;
    const at = cameraPoseAtSec(box, playheadSec());
    if (at === null) return boxes;
    return writeKfPose(boxes, cfg, id, at, holdTilt(box, at, delta), 'add');
  }

  /**
   * The tilt half of `cameraWrite`'s clamp - pure, and a no-op by identity on every
   * delta that carries no `rx`/`ry`, so the pan and dolly gestures are byte-unchanged.
   */
  function holdTilt(box: Box, atSec: number, delta: KfPose): KfPose {
    const drx = typeof delta.rx === 'number' ? delta.rx : 0;
    const dry = typeof delta.ry === 'number' ? delta.ry : 0;
    if (!drx && !dry) return delta;
    const from = kfPoseAt(box, cfg, kfWriteMs(box, cfg, atSec), TILT_CHANNELS);
    const held: KfPose = { ...delta };
    const [lo, hi] = KF_TILT_CONTROL;
    if (drx) held.rx = clamp(finite(from.rx, 0) + drx, lo, hi) - finite(from.rx, 0);
    if (dry) held.ry = clamp(finite(from.ry, 0) + dry, lo, hi) - finite(from.ry, 0);
    return held;
  }

  /**
   * The ABSOLUTE tilt a shift-drag of `(dRx, dRy)` degrees would produce - current pose
   * plus the delta, clamped to the same band `holdTilt` enforces, so the HUD and the
   * write can never disagree. Reads at the latch when the playhead is on/near a key, and
   * falls back to the playhead itself for an authored move parked off every diamond (the
   * gesture still previews an angle even where the commit will be refused). Pure.
   */
  function cameraTiltPreview(boxes: Box[], dRx: number, dRy: number): { rx: number; ry: number } | null {
    const id = cameraModeId();
    if (!id) return null;
    const i = indexOfId(boxes, cfg, id);
    if (i < 0) return null;
    const box = boxes[i]!;
    const at = cameraPoseAtSec(box, playheadSec());
    const from = kfPoseAt(box, cfg, kfWriteMs(box, cfg, at ?? playheadSec()), TILT_CHANNELS);
    const [lo, hi] = KF_TILT_CONTROL;
    return {
      rx: clamp(finite(from.rx, 0) + (Number.isFinite(dRx) ? dRx : 0), lo, hi),
      ry: clamp(finite(from.ry, 0) + (Number.isFinite(dRy) ? dRy : 0), lo, hi),
    };
  }

  /**
   * One camera preset, expanded onto the camera's own track in ONE commit - creating
   * the scene camera first if there is none (section 8: "inserting writes the camera's kf
   * track (creating the scene camera if absent) in one commit").
   *
   * `parseKf` is the engine's reader and `setKfTrack` re-serialises through the
   * engine's writer, so what lands is the canonical wire at the section 4.6 quanta - never
   * the literal string, which would put an unvalidated author's text on the wire.
   */
  function applyCameraPreset(preset: { label: string; track: string }): void {
    if (!cfg.kfField) return;
    const seeded = ensureSceneCameraRows(getBoxes());
    // A1#5 - a preset is AUTHORED at a fixed length (4–5.2 s); stretch or compress it so
    // the move fills THIS scene rather than overrunning it or parking the camera early.
    // A scene with no derived duration (a still with no clip timing) keeps the authored
    // length - `deriveDuration` returns 0, and `rescaleKfTrack` treats a 0 target as
    // "leave it", so nothing regresses. The floor keeps a sub-second scene from strobing.
    const sceneMs = deriveDuration(seeded.rows, cfg);
    const track = sceneMs > 0
      ? rescaleKfTrack(parseKf(preset.track), Math.max(PRESET_MIN_MS, sceneMs))
      : parseKf(preset.track);
    const next = setKfTrack(seeded.rows, cfg, seeded.id, track);
    write(next);
    selectAndReveal([seeded.id]);
    announce(t('Camera move: {name}', { name: preset.label }));
  }

  // ── the latch (plans/104 section 8) ────────────────────────────────────────────────
  //
  // ONE question, asked once per tick: is the playhead parked exactly on a diamond?
  // Everything downstream is a reading of that answer - the group header's wording,
  // whether the pose fields accept an edit, which list row is marked, which diamond
  // draws large, and (through `kfPoseIds`, below) whether a canvas drag writes a
  // keyframe or the base.
  //
  // It is deliberately NOT part of `inspectorKey`: the latch moves with the playhead,
  // sixty times a second while playing, and rebuilding a row of controls at that rate
  // would throw away the focus and the half-typed value of whoever was using them.
  // So the row is built from MODEL values and re-READ here, in place.

  interface KfPoseField {
    ch: KfChannel;
    el: HTMLInputElement;
    /** The range beside the number, on the one channel that has one (`z`). */
    slider?: HTMLInputElement | null;
    /**
     * The base channel this control writes off a diamond, when the tool actually
     * declares the field it falls back to. Absent means "nothing to write here" - which
     * is what `syncKfLatch` turns into an inert control, so a tool with no `zField` /
     * `rxField` / `ryField` never shows a live number that the commit would refuse.
     */
    base?: KfBaseChannel;
  }
  interface KfLatchRefs {
    id: string;
    /** "Scene pose" ⇄ "Keyframe @ 0:01.8". */
    state: HTMLElement;
    /** The pose controls - enabled only ON a diamond (except the ones with a `base`). */
    pose: KfPoseField[];
    /** The CRUD list, whose rows carry `data-t`. */
    list: HTMLElement;
    /**
     * The curve editor DOCKED in this popup (section 8's M2.7): the keyframe it is showing,
     * and the handle to tear down. Null when the row has no keyframes to ease.
     */
    dock: { atMs: number; editor: EasingEditorHandle | null; host: HTMLElement } | null;
  }
  let kfLatch: KfLatchRefs | null = null;
  let kfLatchKey = '\u0000';
  /** The live camera-channel controls of the row on screen, or null (section 8's Camera group). */
  let kfCam: { id: string; fields: KfPoseField[] } | null = null;
  let kfCamKey = '\u0000';

  /** The pose readout's own memo - see `syncKfLatch` for why the two are separate. */
  let kfPoseKey = '\u0000';

  /**
   * The three pose channels that have a BASE FIELD on the box, and the `cfg` key naming
   * it. A keyed value REPLACES the field for its segment (section 5.2 for `z`, P2.1 for
   * the tilt pair), which is what makes an off-diamond edit here an edit of the base
   * rather than an invented keyframe.
   */
  type KfBaseChannel = 'z' | 'rx' | 'ry';
  const kfBaseField = (ch: KfBaseChannel): string | undefined => cfg[`${ch}Field`];

  /**
   * The pose channels the inspector offers, and the form of each control.
   *
   * Six, and the reason they are these six: `x`/`y`/`r`/`w`/`h` are authored ON THE
   * CANVAS (drag, rotate and resize, redirected at free-canvas's single pointerup
   * commit), so duplicating them as number fields here would be a second, worse door
   * onto a gesture that already works. These are the ones with no canvas handle.
   *
   * `z` clamps to the FIELD range (`KF_Z_FIELD_CLAMP`), not the wider wire range: the
   * wire has to carry a camera dolly, a control does not, and a depth a user can
   * scrub to should stay inside the band the guard never has to rescue (section 5.1). It is
   * also the only one with a SLIDER.
   *
   * P2.1 put TILT X / TILT Y beside it, and they sit beside it deliberately: depth and
   * the two tilt angles are the three channels that describe where the card is in
   * space, and scale/opacity/blur are what it looks like once it is there. They take
   * `KF_TILT_CONTROL` (±75) for the camera rows' reason exactly - past a quarter turn
   * `κ` changes sign and the depth sort inverts - and they are BOX angles, so their
   * sense is CSS's own `rotateY(ry) rotateX(rx)`: a box `rx` and a camera `rx` tip the
   * picture in OPPOSITE directions (moving the camera down is moving the world up).
   */
  const KF_POSE_FIELDS: ReadonlyArray<{
    ch: KfChannel; label: string; step: number; range: readonly [number, number];
    /** Present on the ONE channel that also has a slider beside the number (`z`). */
    slider?: readonly [number, number];
    /**
     * The box sub-field this channel falls back to when the playhead is OFF every
     * diamond - section 8's "edits write the base". Three channels have one - depth and
     * the two tilt angles are properties of the BOX that a keyframe may override for a
     * segment - while scale/opacity/blur have no per-box base the pose row could write.
     */
    base?: KfBaseChannel;
  }> = [
    { ch: 'z', label: t('Depth'), step: 10, range: KF_Z_FIELD_CLAMP, slider: KF_Z_SLIDER, base: 'z' },
    { ch: 'rx', label: t('Tilt X'), step: 5, range: KF_TILT_CONTROL, base: 'rx' },
    { ch: 'ry', label: t('Tilt Y'), step: 5, range: KF_TILT_CONTROL, base: 'ry' },
    { ch: 's', label: t('Scale'), step: 0.05, range: KF_CLAMPS.s },
    { ch: 'o', label: t('Opacity'), step: 0.05, range: KF_CLAMPS.o },
    { ch: 'b', label: t('Blur'), step: 0.5, range: KF_CLAMPS.b },
  ];

  /**
   * The CAMERA's own channels, as the section 8 camera panel offers them - pose, tilt, focus,
   * aperture and perspective, each with the affordance chip Depthfield puts on the
   * same row (section 3's observed UI: DRAG for pan, SCROLL for the dolly).
   *
   * `p` is labelled as FOV STRENGTH and never "zoom": `eff(z = camZ) === 1` for every
   * value of p, so p changes the perspective, not the magnification - a dolly (`z`) is
   * what magnifies (section 4.3). Calling this control "zoom" is the one naming mistake this
   * feature can make, and the plan names it twice.
   *
   * P2 PUT THE TILT ROWS HERE (this is the seam the M2.5 comment reserved). They sit
   * between the pans and the dolly because that is the order a shot is set up in - where
   * the camera is, which way it is pointing, how far away it is - and they carry the
   * SHIFT-DRAG chip, the gesture section 8 reserved for them at M2.5 and P2 finally spends.
   *
   * The labels are TILT X / TILT Y, the reference tool's own words, and not "pitch"/
   * "yaw": those are the correct terms and nobody outside a flight sim uses them. Signs
   * are the engine's (`surfaceMatrix`): **negative Tilt X pitches the camera down over
   * the artwork** - the near edge to the bottom of frame, the far edge receding to a
   * horizon - which is the POV shot the Surface glide preset is built from. Positive
   * Tilt Y brings the right-hand edge nearer.
   *
   * Ranges come from the engine's own clamp table, never re-typed here - with the two
   * tilt rows the deliberate exception, held to `KF_TILT_CONTROL` (±75) rather than to
   * the ±180 WIRE clamp. That is not taste trimming: past a quarter turn `κ` changes
   * sign and `buildPlan`'s depth sort inverts, so ±180 on a control is a reachable
   * wrong picture. See `KF_TILT_CONTROL` for the derivation; `cameraWrite` holds the
   * shift-drag to the same band so the two doors onto tilt cannot disagree.
   */
  const KF_CAMERA_FIELDS: ReadonlyArray<{
    ch: KfChannel; label: string; step: number; range: readonly [number, number]; hint?: string;
  }> = [
    { ch: 'x', label: t('Pan X'), step: 10, range: KF_CLAMPS.x, hint: t('Drag') },
    { ch: 'y', label: t('Pan Y'), step: 10, range: KF_CLAMPS.y, hint: t('Drag') },
    { ch: 'rx', label: t('Tilt X'), step: 5, range: KF_TILT_CONTROL, hint: t('Shift-drag') },
    { ch: 'ry', label: t('Tilt Y'), step: 5, range: KF_TILT_CONTROL, hint: t('Shift-drag') },
    { ch: 'z', label: t('Dolly'), step: 10, range: KF_CLAMPS.z, hint: t('Scroll') },
    { ch: 'f', label: t('Focus'), step: 10, range: KF_CLAMPS.f },
    { ch: 'a', label: t('Aperture'), step: 0.05, range: KF_CLAMPS.a },
    { ch: 'p', label: t('FOV strength'), step: 50, range: KF_CLAMPS.p },
  ];

  /**
   * Build the Keyframes group's body for an ANIMATED box (or a camera).
   *
   * Order is the reading order of the feature: where am I (the latch), what can I
   * change here (the pose), what is on this track (the list), and how do I stop
   * (remove). The list is the KEYBOARD AND SCREEN-READER ROUTE to the diamonds - real
   * buttons with real labels - which is what lets the diamonds themselves stay
   * aria-hidden pointer sugar on a `role="option"` bar.
   */
  /**
   * The Depth control, surfaced DIRECTLY on a box that has no track yet (audit A5#1).
   *
   * Depth is a box PROPERTY (`cfg.zField`), not a keyframe: it is the one pose channel
   * with a base field of its own, so writing it off a diamond sets the box's own depth
   * (section 5.2 / section 8's "edits write the BASE") rather than minting a keyframe. It used to be
   * reachable only through the Keyframes pose row - i.e. only AFTER pressing Animate,
   * which a still, un-animated layer has no reason to do. Standing a lifted layer off the
   * board is the whole point of a flythrough's parallax, so it should not cost a keyframe
   * track to reach.
   *
   * This does NOT cross section 8's disclosure law: it writes the box's `z` field through the
   * SAME `ensureSceneCameraRows(patchBox(...))` path the pose row already uses off a
   * diamond - no track is created, exactly as setting position or size creates none, and
   * a box nobody touches keeps `zField` absent, so its export stays byte-identical. Only
   * rendered in the no-track branch; once a box has keyframes the pose row owns Depth (and
   * can key it), so there is never a second control disagreeing about where the value goes.
   */
  function buildDepthControl(group: InspectorGroup, id: string, box: Box): void {
    if (!cfg.zField) return;
    const field = cfg.zField;
    const cur = clamp(finite(box[field], 0), KF_Z_FIELD_CLAMP[0], KF_Z_FIELD_CLAMP[1]);

    const wrap = document.createElement('label');
    wrap.className = 'field-row field-row--inline tl-field tl-depth-row';
    const lab = document.createElement('span');
    lab.className = 'field-label';
    lab.textContent = t('Depth');

    const num = document.createElement('input');
    num.className = 'field-input tl-num tl-depth-num';
    num.type = 'number';
    num.step = '10';
    num.min = String(KF_Z_FIELD_CLAMP[0]);
    num.max = String(KF_Z_FIELD_CLAMP[1]);
    num.value = kfFormatChannel('z', cur);

    // The tasteful 0–300 travel of the pose row's own slider, while the number beside it
    // still takes the whole field range (negatives included) - both held to the engine's
    // `KF_Z_FIELD_CLAMP`, never re-typed here.
    const slider = document.createElement('input');
    slider.className = 'tl-kf-slider tl-depth-slider';
    slider.type = 'range';
    slider.min = String(KF_Z_SLIDER[0]);
    slider.max = String(KF_Z_SLIDER[1]);
    slider.step = '10';
    slider.setAttribute('aria-label', t('Depth'));
    slider.value = String(clamp(cur, KF_Z_SLIDER[0], KF_Z_SLIDER[1]));

    // One model write per gesture: `input` mirrors into the number continuously, `change`
    // fires once on release and is the one that commits - the pose row's own contract.
    const commit = (raw: number): void => {
      const v = clamp(raw, KF_Z_FIELD_CLAMP[0], KF_Z_FIELD_CLAMP[1]);
      num.value = kfFormatChannel('z', v);
      // The first depth interaction mints the scene camera in the SAME commit (section 5.4), so
      // one gesture stays one ⌘Z and the camera panel becomes reachable - identical to the
      // pose row's off-diamond base write.
      const seeded = ensureSceneCameraRows(patchBox(getBoxes(), id, { [field]: v }));
      write(seeded.rows);
    };
    slider.addEventListener('input', () => { num.value = kfFormatChannel('z', finite(slider.value, 0)); });
    slider.addEventListener('change', () => commit(finite(slider.value, 0)));
    num.addEventListener('change', () => {
      const raw = num.value.trim();
      if (raw === '') return;
      commit(finite(raw, 0));
    });

    wrap.append(lab, slider, num);
    group.body.appendChild(wrap);
  }

  function buildKeyframes(
    group: InspectorGroup, id: string, box: Box, track: KfTrack, isCam = false,
  ): void {
    const body = group.body;
    const dur = span(box, durationSec()).dur;

    // ── the latch line ────────────────────────────────────────────────────────
    // The READOUT only. Its "+Keyframe" button moved out to the transport and the
    // canvas contextual bar in section 8's M2.5 revision: one action wants one home per
    // surface, and a third copy inside a popover that has to be opened first is the
    // one nobody would find.
    const latch = document.createElement('div');
    latch.className = 'tl-kf-latch';
    const state = document.createElement('span');
    state.className = 'tl-kf-state';
    // No aria-live: this changes on every scrub, and narrating "Keyframe at 0:01.2,
    // scene pose, keyframe at 0:01.4…" through a drag is not information. The state
    // is spoken where it is ACTED on - the pose fields' own labels below carry it.
    state.textContent = t('No keyframe here');
    latch.append(state);
    body.appendChild(latch);

    // ── the pose ──────────────────────────────────────────────────────────────
    //
    // A CAMERA has none of these: its channels are pan / dolly / focus / aperture /
    // FOV strength, and they live in the Camera group (section 8's seam). Scale, opacity and
    // blur on a camera would be controls for something that paints nothing.
    //
    // The section 5.2 "size is not keyframable" tooltip is GONE, and its absence is the
    // point: the P1 reversal (Andy, 2026-08-12 - "I can't change width and height of
    // elements and have them tween") put `w`/`h` on the wire, and a resize ON a
    // diamond now writes them. Size is still authored on the CANVAS, like x/y/r, so it
    // earns no field here - but the standing claim that it could never be animated had
    // to go.
    const pose: KfPoseField[] = [];
    if (!isCam) {
      const poseWrap = document.createElement('div');
      poseWrap.className = 'tl-kf-pose';
      body.appendChild(poseWrap);
      for (const f of KF_POSE_FIELDS) {
        const el = document.createElement('input');
        el.className = 'field-input tl-num tl-kf-pose-num';
        el.type = 'number';
        el.step = String(f.step);
        el.min = String(f.range[0]);
        el.max = String(f.range[1]);
        el.dataset.ch = f.ch;
        // ONE writer behind BOTH controls on the row (the number, and on `z` the
        // slider beside it), so two doors onto one channel cannot disagree about
        // where the value lands.
        const commitChannel = (raw: number): void => {
          // RE-DERIVE THE LATCH AT COMMIT TIME, because `el.disabled` is not the guard
          // it looks like. `syncKfLatch` flips it on every clock tick; disabling a
          // FOCUSED input blurs it, and a browser commits the pending edit as `change`
          // on that blur - so a number typed while parked on a diamond could otherwise
          // land as a BRAND-NEW keyframe wherever the playhead had since travelled (a
          // ruler scrub `preventDefault()`s, so the field keeps focus throughout).
          // section 8's model is "nobody keyframes by accident".
          const rows = getBoxes();
          const j = indexOfId(rows, cfg, id);
          const at = playheadSec();
          if (j < 0) return;
          const on = kfDiamondAt(rows[j]!, cfg, at) !== null;
          // `min`/`max` are the SPINNER's range, not a validator: a typed value is
          // committed verbatim on `change`, so without this a Depth of 5000 reached
          // the engine's much wider WIRE clamp and stored a number the field's own
          // range says is impossible (section 5.1 names the inspector as a
          // `KF_Z_FIELD_CLAMP` site). Reflected back into the control, so the field
          // never disagrees with the model.
          const v = clamp(raw, f.range[0], f.range[1]);
          el.value = kfFormatChannel(f.ch, v);
          if (!on) {
            // OFF a diamond, section 8's rule is "edits write the BASE" - and depth and the
            // two tilt angles are the channels here that HAVE one: a keyed `z`/`rx`/`ry`
            // REPLACES the box's own field for its segment (section 5.2, P2.1), so the field
            // is exactly what it replaces. Every other channel is refused as before -
            // there is no keyframe to pose and nothing else to write, and minting one
            // would be the accident section 8 forbids. The field NAME comes off `cfg`
            // rather than being spelled here, so a tool that declares no `rxField` is the
            // same refusal as a tool that declares no `zField`.
            const field = f.base ? kfBaseField(f.base) : undefined;
            if (!field) {
              kfPoseKey = '\u0000';   // the memo would otherwise call the stale value current
              syncKfLatch();
              return;
            }
            // THE FIRST DEPTH OR TILT INTERACTION (section 5.4): posing a box in space mints
            // the scene camera in the SAME array, so one gesture stays one commit and one
            // ⌘Z. Both already project correctly without it (no camera box resolves to
            // the DEFAULT camera, never an identity) - the box is what makes the camera
            // panel reachable, not what makes depth or tilt work.
            const seeded = ensureSceneCameraRows(patchBox(rows, id, { [field]: v }));
            write(seeded.rows);
            return;
          }
          // 'set', not 'add': a typed number IS the value. The writer still composes a
          // FULL pose around it (every active channel evaluated at this instant), so a
          // diamond never becomes a partial one by being edited.
          // The SAME `rows`/`at` the latch check above was made against - re-reading
          // them here would be asking a second time whether this edit may land.
          write(writeKfPose(rows, cfg, id, at, { [f.ch]: v }, 'set'));
        };
        el.addEventListener('change', () => {
          const raw = el.value.trim();
          if (raw === '') return;
          commitChannel(finite(raw, 0));
        });
        const wrap = document.createElement('label');
        wrap.className = 'field-row field-row--inline tl-field tl-kf-pose-row';
        const lab = document.createElement('span');
        lab.className = 'field-label';
        lab.textContent = f.label;
        wrap.append(lab, el);
        // THE DEPTH SLIDER (section 5.3 - P1's headline control). Its travel is the tasteful
        // band 0–300 while the number beside it still takes the whole field range,
        // negatives included; both are held to `KF_Z_FIELD_CLAMP`, which is the
        // engine's and is never re-typed here. One model write per gesture: `input`
        // fires continuously and only mirrors into the number, `change` fires once on
        // release and is the one that writes.
        let slider: HTMLInputElement | null = null;
        if (f.slider) {
          slider = document.createElement('input');
          slider.className = 'tl-kf-slider';
          slider.type = 'range';
          slider.min = String(f.slider[0]);
          slider.max = String(f.slider[1]);
          slider.step = String(f.step);
          slider.dataset.ch = f.ch;
          slider.setAttribute('aria-label', f.label);
          const live = slider;
          live.addEventListener('input', () => { el.value = kfFormatChannel(f.ch, finite(live.value, 0)); });
          live.addEventListener('change', () => commitChannel(finite(live.value, 0)));
          wrap.insertBefore(live, el);
        }
        poseWrap.appendChild(wrap);
        // `base` only where the tool actually declares the field to fall back to: the
        // commit refuses on a missing `cfg` name, so a control that stayed live off a
        // diamond would be one the user can type into and watch snap back.
        pose.push({ ch: f.ch, el, slider, base: f.base && kfBaseField(f.base) ? f.base : undefined });
      }
    }

    // ── the list ──────────────────────────────────────────────────────────────
    const list = document.createElement('div');
    list.className = 'tl-kf-list';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', t('Keyframes'));
    for (const k of track) {
      const at = fmtTime(kfTimelineSec(box, cfg, k.t));
      const row = document.createElement('div');
      row.className = 'tl-kf-row';
      row.dataset.t = String(k.t);

      const time = document.createElement('input');
      time.className = 'field-input tl-num tl-kf-time';
      time.type = 'number';
      // The wire's own quantum is the millisecond (section 4.6), so the grid is milliseconds
      // and the step is a hundredth of a second - fine enough to place a beat, coarse
      // enough that the arrow keys are usable.
      time.step = '10';
      time.min = '0';
      time.value = String(k.t);
      // NAMED WITH ITS ROW, exactly as Duplicate and Delete already are. section 8 makes this
      // list the keyboard and screen-reader route to the diamonds (which is what lets
      // the diamonds themselves stay aria-hidden), so a four-key track that tabs as
      // "Keyframe time" four times identifies nothing: the row is the only thing that
      // distinguishes one control from the next, and the row has no label of its own.
      time.setAttribute('aria-label', t('Keyframe time in milliseconds at {t}', { t: at }));
      time.addEventListener('change', () => {
        writeTrack(id, (tr) => kfTrackRetime(tr, k.t, kfSlideMs(finite(time.value, k.t), 0, dur)));
      });

      const ease = kfEaseSelect(id, k.t, k.ease, at);

      const dup = btn('tl-kf-dup', t('Duplicate keyframe at {t}', { t: at }), icon('duplicate'));
      dup.addEventListener('click', () => duplicateKeyframe(id, k.t));
      const del = btn('tl-kf-del', t('Delete keyframe at {t}', { t: at }), icon('trash'));
      del.addEventListener('click', () => deleteKeyframe(id, k.t));

      row.append(time, ease, dup, del);
      list.appendChild(row);
    }
    body.appendChild(list);

    // ── the way out ───────────────────────────────────────────────────────────
    // Destructive, named with its own count, and one commit - so ⌘Z brings the whole
    // animation back. Disabling animation IS this: there is no stored flag to clear.
    // Absent on an empty track (a camera, before its first pose): there is nothing to
    // remove, and "Remove 0 keyframes" is a button that describes nothing.
    if (track.length) {
      const remove = actionBtn(
        'tl-kf-clear',
        track.length === 1 ? t('Remove 1 keyframe') : t('Remove {n} keyframes', { n: String(track.length) }),
        'trash',
      );
      remove.classList.add('is-danger');
      remove.addEventListener('click', () => {
        write(clearKfTrack(getBoxes(), cfg, id));
        announce(t('Keyframes removed'));
      });
      body.appendChild(remove);
    }

    // ── the curve, DOCKED (section 8's M2.7) ─────────────────────────────────────────
    //
    // "The curve editor docks INSIDE the Keyframes popup (top or bottom of it - one
    // surface, never a second nested popover)". So the per-keyframe ease `<select>`s in
    // the list above no longer carry a "Custom…" route: the plot IS the custom editor,
    // it is always here, and whatever method the latched keyframe holds is what it
    // draws - "they can use presets to learn". Dragging a handle commits a bezier,
    // which is what auto-switches that keyframe's select to Custom.
    //
    // It follows the LATCH like everything else in this popup: the curve it edits is
    // the curve out of the keyframe the playhead is parked on, and off a diamond it
    // says so rather than editing an arbitrary one. `syncKfDock` builds and rebuilds
    // it - never this function, which runs on a model change while the dock has to
    // follow the clock.
    //
    // The standalone editor is NOT retired: the Animate group's In/Out curves still
    // open it (a field, not a keyframe), and so does the diamond's own context menu,
    // which is a pointer route from a bar with no popup open.
    const dockHost = document.createElement('div');
    dockHost.className = 'tl-kf-dock';
    body.appendChild(dockHost);

    kfLatch = {
      id, state, pose, list,
      dock: track.length ? { atMs: Number.NaN, editor: null, host: dockHost } : null,
    };
    kfLatchKey = '\u0000';   // force the next sync: this row has never been read
    kfPoseKey = '\u0000';
  }

  /**
   * The docked curve editor, rebuilt only when the keyframe it is easing CHANGES.
   *
   * Mounting an easing editor costs an SVG, a rAF loop and a document listener, and the
   * latch is re-read on every clock tick - so this is memoised on the target keyframe's
   * own local ms (NaN meaning "nothing yet", which compares unequal to everything
   * including itself, so the first sync always builds).
   */
  function syncKfDock(refs: KfLatchRefs, box: Box, on: number | null): void {
    const d = refs.dock;
    if (!d) return;
    // ONLY WHILE THE POPUP IS SHOWING. The group's body stays in the document when the
    // group is shut (hidden, not detached), and the easing editor runs a rAF loop for
    // its motion strip which self-terminates only on DETACH - so mounting it into a
    // hidden body would leave an invisible animation painting for the life of the
    // session. `openGroupPopover`/`restoreGroupBody` reset the latch memo, so opening
    // the group builds it and closing it takes it down.
    const showing = openGroup?.gid === 'keyframes' && openGroup.id === refs.id;
    const want = !showing ? Number.POSITIVE_INFINITY : (on ?? Number.NEGATIVE_INFINITY);
    if (Object.is(d.atMs, want)) return;
    d.atMs = want;
    d.editor?.destroy();
    d.editor = null;
    d.host.textContent = '';
    if (!showing) return;
    if (on === null) {
      // The same sentence the pose fields carry, for the same reason and in the same
      // words: there is no keyframe here, so there is no curve to shape.
      const note = document.createElement('p');
      note.className = 'tl-kf-dock-note';
      note.textContent = t('Move the playhead onto a keyframe, or add one.');
      d.host.appendChild(note);
      return;
    }
    const key = kfKeyAt(kfBoxTrack(box, cfg), on);
    if (!key) return;
    if (key.ease === KF_HOLD_EASE) {
      // HOLD IS NOT A CURVE. Drawing the editor's fallback shape here would show a
      // motion this keyframe does not produce, which is the one thing a plot must
      // never do - so the dock says what hold means instead.
      const note = document.createElement('p');
      note.className = 'tl-kf-dock-note';
      note.textContent = t('Hold keeps this pose until the next keyframe. Pick another curve to shape it.');
      d.host.appendChild(note);
      return;
    }
    d.editor = mountEasingEditor(d.host, {
      // The ENGINE's adapters both ways: the wire token in, the CSS bezier the editor
      // speaks out (section 5.1 - "the adapter is mandatory", because the canonical ease wire
      // uses commas and the kf charset bans them).
      value: kfEaseCss(key.ease),
      onCommit: (wire) => writeTrack(refs.id, (tr) => kfTrackSetEase(tr, on, kfEaseToken(wire))),
    });
  }

  /**
   * The ease picker for ONE keyframe - the same vocabulary the transition picker uses.
   * `at` is the row's formatted time: its accessible name has to carry it for the same
   * reason the time field's does (see there).
   */
  function kfEaseSelect(id: string, atMs: number, ease: string, at: string): HTMLSelectElement {
    const el = document.createElement('select');
    el.className = 'field-select tl-select tl-kf-ease';
    el.setAttribute('aria-label', t('Keyframe curve at {t}', { t: at }));
    const opt = (v: string, label: string): void => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      el.appendChild(o);
    };
    for (const tok of KF_EASE_TOKENS) {
      // The engine names the curve; `EASINGS` gives that name its word. One
      // vocabulary, so a curve cannot be called two things in two places.
      const name = kfEaseName(tok);
      opt(tok, name && Object.hasOwn(EASINGS, name) ? t((EASINGS as Record<string, string>)[name]!) : tok);
    }
    opt(KF_HOLD_EASE, t('Hold'));
    // CUSTOM IS A STATE, NOT A ROUTE (section 8's M2.7). The transition picker's
    // "Custom…" opens a popover; this list is inside a popup that already has the
    // curve editor DOCKED in it, and a second nested editor is exactly what M2.7
    // replaced. So a keyframe whose ease is an authored bezier selects an option that
    // says so, and dragging a handle in the dock is what puts it there - the numbers
    // live in the dock's own readout, three lines below, rather than in this label.
    if (!KF_EASE_TOKENS.includes(ease as (typeof KF_EASE_TOKENS)[number]) && ease !== KF_HOLD_EASE) opt(ease, t('Custom'));
    el.value = ease;
    el.addEventListener('change', () => {
      writeTrack(id, (track) => kfTrackSetEase(track, atMs, el.value));
    });
    return el;
  }

  /**
   * Read the latch, once, and reflect it - the group header's wording, the pose
   * fields' values and enablement, the marked list row, the enlarged diamond.
   *
   * TWO memos, because the two halves change at different rates and the expensive one
   * must not be paid for the cheap one:
   *
   *   • `kfLatchKey` - the STRUCTURE. Keyed on the latch ANSWER (which selected box is
   *     parked on which diamond) plus the track, so scrubbing across a two-second gap
   *     asks this a hundred times and writes no DOM at all. The bars/dots walk, the
   *     header wording and the list marking live under it.
   *   • `kfPoseKey` - the POSE READOUT. Keyed on the playhead's own local millisecond,
   *     because section 8's M2.5 revision made these fields track it: off a diamond they now
   *     print the EVALUATED value at the playhead (the engine's `evaluateKf`, through
   *     `kfPoseAt` - the same arithmetic the preview and the export read), disabled.
   *     Four `<input>.value` writes per changed millisecond, and only while the
   *     Keyframes popover is actually built.
   */
  function syncKfLatch(): void {
    if (!cfg.kfField) return;
    const rows = getBoxes();
    const at = playheadSec();
    const sel = selection.get();
    const onOf = new Map<string, number | null>();
    for (const id of sel) {
      const i = indexOfId(rows, cfg, id);
      onOf.set(id, i < 0 ? null : kfDiamondAt(rows[i]!, cfg, at));
    }
    const refs = kfLatch;
    const i = refs ? indexOfId(rows, cfg, refs.id) : -1;
    const box = i >= 0 ? rows[i]! : null;
    const on = refs && box
      ? (onOf.has(refs.id) ? onOf.get(refs.id)! : kfDiamondAt(box, cfg, at))
      : null;
    const key = `${sel.map((id) => `${id}:${onOf.get(id) ?? ''}`).join(',')}|${refs?.id ?? ''}|${
      box && cfg.kfField ? String(box[cfg.kfField] ?? '') : ''}`;
    if (key !== kfLatchKey) {
      kfLatchKey = key;

      // The selected diamond draws large (section 3's observed-Depthfield note). Only on a
      // SELECTED bar: an unselected clip's diamonds are a picture of its animation, not
      // a control surface, and marking one of them would claim an edit target the
      // playhead does not actually own.
      for (const [id, el] of bars) {
        const strip = el.querySelector<HTMLElement>('.tl-kf-strip');
        if (!strip) continue;
        const dotOn = onOf.get(id) ?? null;
        for (const dot of Array.from(strip.children) as HTMLElement[]) {
          dot.classList.toggle('is-selected', dotOn !== null && dot.dataset.t === String(dotOn));
        }
      }

      if (refs && box) {
        refs.state.textContent = on === null
          ? t('No keyframe here')
          : t('Keyframe @ {t}', { t: fmtTime(kfTimelineSec(box, cfg, on)) });
        refs.state.classList.toggle('is-on', on !== null);
        for (const row of Array.from(refs.list.children) as HTMLElement[]) {
          row.classList.toggle('is-current', on !== null && row.dataset.t === String(on));
        }
        // The docked curve follows the same answer (section 8's M2.7). Inside the structural
        // memo, because mounting an editor is the most expensive thing this function
        // can do and the latch is what decides whether it has to happen at all.
        syncKfDock(refs, box, on);
      }
    }

    if (!refs || !box) return;
    // Where to READ the pose from: the diamond when parked on one, otherwise the
    // playhead itself. `kfPoseAt` evaluates the track through the engine, so an
    // off-diamond number is the value the box is actually striking at this instant - 
    // the same number the preview shows and the export writes.
    const readMs = on ?? kfLocalMs(box, cfg, at);
    // Every BASE field is in the memo, not just depth: off a diamond those rows read the
    // box's own field, so a tilt written from the canvas has to repaint the row the same
    // way a depth does.
    const poseKey = `${refs.id}|${on ?? ''}|${readMs}|${String(box[cfg.kfField] ?? '')}|${
      cfg.zField ? String(box[cfg.zField] ?? '') : ''}|${
      cfg.rxField ? String(box[cfg.rxField] ?? '') : ''}|${
      cfg.ryField ? String(box[cfg.ryField] ?? '') : ''}`;
    if (poseKey === kfPoseKey) return;
    kfPoseKey = poseKey;
    for (const f of refs.pose) {
      // EVALUATED, never blank (section 8's M2.5 point 3: blanking was honest but read as
      // broken). A disabled control showing the live value says "this is what it is
      // doing here, and there is no keyframe here to change it on" - which is the
      // truth. The memo above is keyed on `readMs`, so this genuinely tracks the
      // playhead rather than freezing at whatever the last diamond was.
      const v = kfPoseAt(box, cfg, readMs, [f.ch])[f.ch];
      const shown = typeof v === 'number' ? kfFormatChannel(f.ch, v) : '';
      if (f.el.value !== shown) f.el.value = shown;
      if (f.slider && f.slider.value !== shown) f.slider.value = shown;
      // OFF a diamond these are inert: there is no keyframe to pose, and an edit here
      // would have to invent one silently. "+Keyframe" is the one press that changes
      // that, and the title says so rather than leaving a dead control unexplained.
      //
      // EXCEPT DEPTH AND THE TWO TILT ANGLES (section 5.3, P1; P2.1): each has a base field
      // of its own, so off a diamond an edit there is not an invention - it is section 8's
      // "edits write the base", which is the whole reason the depth slider is usable on a
      // box that has never been keyframed at all. `base` is set on exactly the channels
      // that have one AND whose field this tool declares.
      const inert = on === null && !f.base;
      f.el.disabled = inert;
      f.el.title = inert ? t('Move the playhead onto a keyframe, or add one.') : '';
      if (f.slider) {
        f.slider.disabled = inert;
        f.slider.title = f.el.title;
      }
    }
  }

  /**
   * The CAMERA's channels, re-read on the same tick as the latch (section 8).
   *
   * Same readout law as the pose fields - the live EVALUATED pose, so the numbers are
   * what the shot is actually doing at this instant - but a different enablement rule,
   * because a camera's scene default IS a keyframe: `cameraPoseAtSec` has the three
   * cases, and this is just a picture of its answer.
   *
   * Its own memo, its own reference: the camera group can exist on a row whose
   * Keyframes group does not (a tool declaring a camera kind and no `kf` sub-field),
   * and the two are built in the opposite order from the one they sync in.
   */
  function syncKfCam(): void {
    const refs = kfCam;
    if (!refs || !cfg.kfField) return;
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, refs.id);
    if (i < 0) return;
    const box = rows[i]!;
    const at = playheadSec();
    const on = kfDiamondAt(box, cfg, at);
    const readMs = on ?? kfLocalMs(box, cfg, at);
    const key = `${refs.id}|${readMs}|${String(box[cfg.kfField] ?? '')}|${
      cfg.zField ? String(box[cfg.zField] ?? '') : ''}`;
    if (key === kfCamKey) return;
    kfCamKey = key;
    const writable = cameraPoseAtSec(box, at) !== null;
    const pose = kfPoseAt(box, cfg, readMs, KF_CAMERA_CHANNELS);
    for (const f of refs.fields) {
      const v = pose[f.ch];
      const shown = typeof v === 'number' ? kfFormatChannel(f.ch, v) : '';
      if (f.el.value !== shown) f.el.value = shown;
      f.el.disabled = !writable;
      f.el.title = writable ? '' : t('Move the playhead onto a keyframe, or add one.');
    }
  }

  /**
   * Build one inspector group: a SEGMENT for the strip (a disclosure button carrying
   * an icon, a text label and the resolved value chips) plus the body its fields live
   * in - which, since section 8's M2.5 revision, is NOT appended to the segment.
   *
   * The row this replaced was eleven labelled inputs in a horizontal overflow
   * scroller, and the keyframe row would have made it fourteen (plans/104 section 8,
   * "Inspector regrouping"). Grouping answered that; the M2.5 revision answers what
   * grouping left behind - an open group still had to fit its whole body INSIDE the
   * strip, which is why the ease pickers were truncated to "Ease in ar…". So the body
   * is now mounted in a popover ABOVE the transport and the segment keeps a constant
   * width whether it is open or shut.
   *
   * Three properties this shape has to keep, all of them contracts elsewhere:
   *
   *   • the body is hidden with the `hidden` PROPERTY while it is not in a popover, so
   *     a shut group leaves the accessibility tree as well as the picture - and no
   *     sheet may style `[hidden]` (styles/hidden-attribute-guard.test.ts fails the
   *     build for a rule that tries). Nothing here is display-toggled by class.
   *   • no `transform` / `filter` / `backdrop-filter` on the group or its body - the
   *     fixed-popover containing-block trap documented on `.tl-panel` and
   *     `.fc-toolbar`. It is now doubly essential: the body itself is reparented
   *     into a `position: fixed` popover, and the ease `<select>`s inside it open
   *     fixed popovers of their own. The caret rotation is on a LEAF `<svg>`, which is
   *     an ancestor of nothing.
   *   • the head is a real `<button>` with `aria-expanded`, keyboard reachable - the
   *     diamonds on the bars are aria-hidden pointer sugar, so the inspector is the AT
   *     route and it cannot become a div that listens for clicks.
   */
  interface InspectorGroup {
    /** The group wrapper (`.tl-group[data-group]`) - append it to the inspector. */
    root: HTMLElement;
    /** Where controls go. Reparented into the popover while this group is open. */
    body: HTMLElement;
    /** The disclosure control. Its accessible name is label + summary. */
    head: HTMLButtonElement;
    /** The group's own translated name - also the popover's accessible name. */
    label: string;
    /** Replace the value summary. Empty strings are dropped. */
    setSummary(parts: string[]): void;
    /** Is this group's body currently showing in the popover? */
    isOpen(): boolean;
  }

  /**
   * The live segments of the row just built, by group id - what the popover machinery
   * re-points itself at after a rebuild.
   */
  const groupsById = new Map<string, InspectorGroup>();

  /** Which group is showing, and for which box. Session UI state; never the model. */
  let openGroup: { gid: string; id: string } | null = null;
  /** The popover's own content host, so a rebuild can swap the body inside it. */
  let groupPopHost: HTMLElement | null = null;
  /**
   * A POINT anchor, not the head button: the inspector is rebuilt on every commit, so
   * the button that opened the popover is a detached node moments later. The point
   * supplies geometry and its `delegate` - re-pointed by `renderInspector` - receives
   * the focus restore and the `aria-expanded` upkeep. Exactly the pattern the ease
   * editor already uses, and the reason the M2 fix round established it.
   */
  const groupPoint = pointAnchor();

  /**
   * ABOVE the transport, never below it.
   *
   * The panel is docked at the BOTTOM of the stage and the bar is its top edge, so a
   * popover dropped under its anchor would open into the tracks it exists to edit (and
   * off the bottom of the window on a short viewport). Bottom-aligned to the panel's
   * own top edge, near-edge aligned to the anchor (left under ltr, right under rtl - 
   * `menuPosition`'s rule, for the same reason), and clamped into the viewport.
   */
  function groupPopPosition(el: HTMLDivElement, anchor: PopoverAnchor): void {
    const r = anchor.getBoundingClientRect();
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    const vw = window.innerWidth || 1024;
    const panelTop = root.getBoundingClientRect().top || (window.innerHeight || 768);
    const rtl = document.documentElement.dir === 'rtl';
    const near = rtl ? r.right - pw : r.left;
    // Clamp to the CONTENT area, not the viewport: a docked column reserves inline-end
    // space (right in ltr, left in rtl), so keep the popover clear of it.
    const dockW = edgeDockWidth();
    const left = Math.max(8 + (rtl ? dockW : 0), Math.min(near, vw - pw - 12 - (rtl ? 0 : dockW)));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(8, panelTop - ph - 8))}px`;
  }

  const groupPop = mountBodyPopover(groupPoint, (el) => {
    el.textContent = '';
    const host = document.createElement('div');
    host.className = 'tl-group-pop-body';
    el.appendChild(host);
    groupPopHost = host;
    const g = openGroup ? groupsById.get(openGroup.gid) : null;
    if (g) {
      g.body.hidden = false;
      host.appendChild(g.body);
      // WHICH group this is, not the constant "Clip settings" - every group opens
      // the same popover, so a dialog that always announces the same name never tells a
      // screen-reader user which one they just opened. Set after `open()` has already
      // stamped the fallback, so the constant only ever survives the (unreachable)
      // no-group case.
      el.setAttribute('aria-label', g.label);
    }
    // Focus the first real control, so a keyboard user lands ON the fields the press
    // revealed rather than on the popover box. `trapFocus` keeps them there until Esc.
    return host.querySelector<HTMLElement>('input, select, button, [tabindex]') ?? host;
  }, {
    className: 'folder-menu tl-menu tl-group-pop',
    role: 'dialog',
    ariaLabel: t('Clip settings'),
    position: groupPopPosition,
    // The bodies borrowed into this card carry the ease `<select>`s, and picking
    // "Custom…" opens a curve editor - a SIBLING popover on `document.body`, so
    // `menu.contains()` says false and the first press inside it would otherwise
    // dismiss this card mid-drag (and hide the very `<select>` the editor restores
    // focus to). `.tl-ease-pop` is the class both curve editors mount with.
    isInside: (n) => {
      const el = (n as Element | null)?.closest ? (n as Element) : ((n as ChildNode | null)?.parentElement ?? null);
      return !!el?.closest('.tl-ease-pop');
    },
    // EVERY route out - Escape, an outside press, a route change, the caller's own
    // close - lands here, which is what makes the borrowed body safe: the popover is
    // about to detach its element, and the group's live body is inside it.
    onClose: () => restoreGroupBody(),
  });

  /**
   * Put the borrowed body back in its segment (hidden) and forget the open state.
   *
   * Called from the popover's own `onClose`, so it runs however the popover was
   * dismissed. It must NOT call `groupPop.close()` - that is what called it.
   */
  function restoreGroupBody(): void {
    const g = openGroup ? groupsById.get(openGroup.gid) : null;
    if (g) {
      if (g.body.parentElement === groupPopHost) {
        g.body.hidden = true;
        g.root.appendChild(g.body);
      }
      g.root.classList.remove('is-open');
      g.head.setAttribute('aria-expanded', 'false');
    }
    openGroup = null;
    groupPopHost = null;
    // …and the moment it stops being true. Not a sync call: `restoreGroupBody` runs
    // from the popover's own close hook, sometimes mid-teardown, so it only invalidates
    // the memo and lets the next tick (or the next render) take the editor down.
    kfLatchKey = '\u0000';
    kfLatch?.dock?.editor?.destroy();
    if (kfLatch?.dock) { kfLatch.dock.editor = null; kfLatch.dock.atMs = Number.NaN; }
  }

  /** Shut the popover, whoever asked. Idempotent; `restoreGroupBody` runs underneath. */
  function closeGroupPopover(returnFocus = false): void {
    // The delegate is still needed by `close()` itself (aria-expanded, focus restore),
    // so it is cleared AFTER, not before.
    groupPop.close(returnFocus);
    groupPoint.delegate = null;
    // Belt and braces for the never-opened case, where `close()` returns early and the
    // hook above never runs.
    if (openGroup) restoreGroupBody();
  }

  /**
   * Aim the point at one segment.
   *
   * A `pointAnchor`'s rect is degenerate (`left === right === x`), so the NEAR edge has
   * to be chosen here rather than in the placement: under `dir=rtl` that is the
   * segment's right edge, which is what makes the card open towards the button that
   * spawned it in Arabic, Hebrew, Farsi and Urdu instead of away from it.
   */
  function aimGroupPoint(head: HTMLElement): void {
    const r = head.getBoundingClientRect();
    groupPoint.x = document.documentElement.dir === 'rtl' ? r.right : r.left;
    groupPoint.y = r.bottom;
    groupPoint.delegate = head;
  }

  /** Open ONE group's body in the popover, swapping out whatever was showing. */
  function openGroupPopover(gid: string, id: string): void {
    const g = groupsById.get(gid);
    if (!g) return;
    if (openGroup?.gid === gid) { closeGroupPopover(true); return; }
    closeGroupPopover();
    openGroup = { gid, id };
    aimGroupPoint(g.head);
    g.root.classList.add('is-open');
    groupPop.open();
    // The docked curve editor is mounted only while its popup is SHOWING (see
    // `syncKfDock`), and this is the moment that becomes true.
    kfLatchKey = '\u0000';
    syncKfLatch();
  }

  /**
   * After a rebuild: re-point the popover at the segment that replaced its anchor, and
   * move the freshly built body inside it. A field edit inside the popover commits,
   * which rebuilds the whole inspector row - without this the popover would be left
   * holding the DETACHED body of a row that no longer exists, and Escape would restore
   * focus to a node that is not in the document.
   */
  function resyncGroupPopover(id: string): void {
    if (!openGroup) return;
    const g = groupsById.get(openGroup.gid);
    // The selection moved on, or this box no longer offers the group (its track was
    // removed, its sound detached): there is nothing to re-point at, so shut.
    if (!g || openGroup.id !== id) { closeGroupPopover(); return; }
    if (!groupPopHost) { closeGroupPopover(); return; }
    aimGroupPoint(g.head);
    g.head.setAttribute('aria-expanded', 'true');
    g.root.classList.add('is-open');
    groupPopHost.textContent = '';
    g.body.hidden = false;
    groupPopHost.appendChild(g.body);
  }

  /** One group of the clip inspector. Shut by default, always. */
  function inspectorGroup(gid: string, labelText: string, glyph: IconName): InspectorGroup {
    const wrap = document.createElement('div');
    wrap.className = 'tl-group';
    wrap.dataset.group = gid;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'tl-group-head';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-haspopup', 'dialog');
    const bodyId = `tl-g-${gid}-${++groupBodySeq}`;
    head.setAttribute('aria-controls', bodyId);

    // Icon BESIDE the text, never instead of it: the glyph is decorative
    // (`icon()` stamps aria-hidden), and the button's accessible name is the label
    // plus whatever the summary currently reads.
    const ico = document.createElement('span');
    ico.className = 'tl-group-icon';
    ico.innerHTML = icon(glyph);
    const lab = document.createElement('span');
    lab.className = 'tl-group-label';
    lab.textContent = labelText;
    // ALWAYS shown now, which is what makes the segment a constant width: the chips are
    // the segment's whole reading, and the body they summarise is somewhere else.
    const chipRow = document.createElement('span');
    chipRow.className = 'tl-group-chips';
    const caret = document.createElement('span');
    caret.className = 'tl-group-caret';
    caret.innerHTML = icon('chevronDown');
    head.append(ico, lab, chipRow, caret);

    const body = document.createElement('div');
    body.className = 'tl-group-body';
    body.id = bodyId;
    body.hidden = true;
    wrap.append(head, body);

    const group: InspectorGroup = {
      root: wrap, body, head, label: labelText,
      setSummary(parts: string[]): void {
        chipRow.textContent = '';
        for (const p of parts) {
          if (!p) continue;
          const c = document.createElement('span');
          c.className = 'tl-group-chip';
          c.textContent = p;
          chipRow.appendChild(c);
        }
      },
      isOpen: () => openGroup?.gid === gid && !body.hidden,
    };
    groupsById.set(gid, group);

    head.addEventListener('click', () => {
      // Purely a UI disclosure: no write() anywhere on this path, and `inspectorKey`
      // never sees it (see its comment) - so this can never dirty the session.
      openGroupPopover(gid, inspectorId);
    });

    return group;
  }

  /**
   * The CAMERA group (plans/104 section 8) - the scene-camera panel, and the only place a
   * camera's pose is typed rather than dragged.
   *
   * Three parts, in the order a shot is set up: the preset MOVES (each one commit, each
   * expanded onto the track), the pose CHANNELS with their affordance chips, and
   * nothing else. The chips are the reference tool's own vocabulary - DRAG on the pans,
   * SHIFT-DRAG on the tilts, SCROLL on the dolly - and they are honest here because this
   * group is only ever shown while the camera is selected, which is exactly the
   * condition that arms those canvas gestures (`cameraModeId`).
   *
   * The presets are BUTTONS, not a nested menu: this body is already borrowed into a
   * body-mounted popover, and a menu opened from inside it would be a second popover
   * that the card's own outside-press dismissal would have to be taught about (the
   * `.tl-ease-pop` exemption exists for exactly that reason, and one exemption is
   * enough). A press here is one preset, one commit, one undo step.
   */
  function buildCameraGroup(id: string, box: Box): void {
    const g = inspectorGroup('camera', t('Camera'), 'camera');
    inspector.appendChild(g.root);
    // What the segment reads at a glance: how many poses this camera holds. A camera
    // with none is the scene default - one still shot - and says so.
    const n = kfBoxTrack(box, cfg).length;
    g.setSummary([
      n === 0 ? t('Not animated')
        : n === 1 ? t('1 keyframe') : t('{n} keyframes', { n: String(n) }),
    ]);

    const moves = document.createElement('div');
    moves.className = 'tl-cam-presets';
    moves.setAttribute('role', 'group');
    moves.setAttribute('aria-label', t('Camera moves'));
    for (const preset of KF_CAMERA_PRESETS) {
      const b = actionBtn(`tl-cam-preset tl-cam-${preset.id}`, preset.label, preset.icon);
      b.addEventListener('click', () => applyCameraPreset(preset));
      moves.appendChild(b);
    }
    // ORBIT USED TO LIVE HERE, hand-built and `aria-disabled` with the reason "Needs
    // tilt (coming)". P2 is that tilt, so it has moved into `KF_CAMERA_PRESETS` above
    // and comes out of the loop like every other move. The dimmed twin is GONE rather
    // than kept: a control explaining what it is waiting for is only honest while it is
    // still waiting, and this codebase's own rule about the raster allowlist applies
    // word for word - "don't leave a reason standing once it stops being true".
    g.body.appendChild(moves);

    const cam: KfPoseField[] = [];
    for (const f of KF_CAMERA_FIELDS) {
      const el = document.createElement('input');
      el.className = 'field-input tl-num tl-cam-num';
      el.type = 'number';
      el.step = String(f.step);
      el.min = String(f.range[0]);
      el.max = String(f.range[1]);
      el.dataset.ch = f.ch;
      el.addEventListener('change', () => {
        const raw = el.value.trim();
        if (raw === '') return;
        // Re-derived at commit time, exactly as the pose fields are and for the same
        // reason: `disabled` is a picture of the latch, not a guard on it.
        const rows = getBoxes();
        const j = indexOfId(rows, cfg, id);
        if (j < 0) return;
        const at = cameraPoseAtSec(rows[j]!, playheadSec());
        if (at === null) { kfCamKey = '\u0000'; syncKfCam(); return; }
        const v = clamp(finite(raw, 0), f.range[0], f.range[1]);
        el.value = kfFormatChannel(f.ch, v);
        write(writeKfPose(rows, cfg, id, at, { [f.ch]: v }, 'set'));
      });
      const wrap = document.createElement('label');
      wrap.className = 'field-row field-row--inline tl-field tl-cam-row';
      const lab = document.createElement('span');
      lab.className = 'field-label';
      lab.textContent = f.label;
      wrap.append(lab, el);
      if (f.hint) {
        // DECORATION, and marked as such: the gesture it names is on the canvas, the
        // control beside it does the same job for a keyboard, and a screen reader
        // reading "Pan X, drag" would be describing a mouse to someone not using one.
        const chip = document.createElement('span');
        chip.className = 'tl-cam-chip';
        chip.textContent = f.hint;
        chip.setAttribute('aria-hidden', 'true');
        wrap.appendChild(chip);
      }
      g.body.appendChild(wrap);
      cam.push({ ch: f.ch, el });
    }
    // The camera's channels ride the latch like every other live readout - but in a
    // reference of their own rather than inside `kfLatch`, because the Keyframes group
    // that owns that one is built AFTER this and is not guaranteed to exist at all (a
    // tool could declare a camera kind and no `kf` sub-field). One nullable ref, set
    // here, cleared on every inspector rebuild.
    kfCam = { id, fields: cam };
  }


  function renderInspector(boxes: Box[]): void {
    // Bars AND chips: an untimed box has no bar, and gating on `bars` alone is what
    // made "always on" a dead end - selecting a scenery chip rendered an empty bar and
    // there was no field anywhere in the UI that could give the box a time.
    const ids = selection.get().filter((id) => bars.has(id) || chips.has(id));
    const id = ids.length === 1 ? ids[0]! : '';
    const i = id ? indexOfId(boxes, cfg, id) : -1;
    const box = i >= 0 ? boxes[i]! : null;
    // MODEL VALUES ONLY - appended to, never trimmed. Group disclosure is session UI
    // state and deliberately absent: folding it in here would rebuild the whole row on
    // every toggle (throwing away the focus the user just pressed with), and would make
    // a repaint memo that is supposed to answer "did the MODEL change" answer something
    // else. The three added at the tail are what the regroup reads that the flat row
    // did not: the keyframe track and the box kind gate the Keyframes group's very
    // existence (plans/104 section 8). The A/V link no longer decides anything in this row - 
    // M2.6 sent detach / re-attach back to the clip context menu - but it STAYS in the
    // key, because this list is appended to and never trimmed: a spare entry costs one
    // string compare, and dropping one is how a row starts printing stale values the
    // day something reads that field again. `z` joins them for the same reason `kf`
    // did: the pose row shows the box's depth wherever no keyframe overrides it (section 5.2),
    // so a depth edit made anywhere else must repaint this row or it prints a stale
    // number. `mute` is what flips the speaker toggle's glyph and `aria-pressed`.
    const key = box ? `${id}|${JSON.stringify([box[cfg.startField], box[cfg.durField], box[cfg.clipInField], box[cfg.speedField], box[cfg.enterField], box[cfg.exitField], box[cfg.enterMsField], box[cfg.exitMsField], box[cfg.muteField], cfg.enterEaseField ? box[cfg.enterEaseField] : '', cfg.exitEaseField ? box[cfg.exitEaseField] : '', cfg.kfField ? box[cfg.kfField] : '', cfg.zField ? box[cfg.zField] : '', cfg.linkField ? box[cfg.linkField] : '', box.kind, cfg.gainField ? box[cfg.gainField] : '', cfg.splitField ? box[cfg.splitField] : '', cfg.staggerField ? box[cfg.staggerField] : '', cfg.splitOrderField ? box[cfg.splitOrderField] : '', cfg.holdField ? box[cfg.holdField] : '', cfg.holdRateField ? box[cfg.holdRateField] : '', cfg.panField ? box[cfg.panField] : '', cfg.duckField ? box[cfg.duckField] : '', cfg.pitchField ? box[cfg.pitchField] : '', cfg.varispeedField ? box[cfg.varispeedField] : '', cfg.fxField ? box[cfg.fxField] : ''])}` : '';
    if (key === inspectorKey) return;
    inspectorKey = key;
    inspectorId = id;
    inspector.textContent = '';
    // The segments about to be destroyed are the popover's anchor and its content. The
    // map is rebuilt below; `resyncGroupPopover` at the end of this function re-points
    // an open popover at the segment that replaced its anchor (or shuts it), which is
    // what makes editing a field inside the popover - a commit, hence a rebuild - not
    // close the popover under the user's hands.
    groupsById.clear();
    // The row about to be destroyed owned the latch's DOM. Drop the reference before
    // anything can read a detached node, and reset the memo so the rebuilt row is
    // re-read rather than assumed to still match. The DOCKED curve editor holds a rAF
    // loop and a document listener of its own, so it is torn down rather than dropped
    // (its own loop self-terminates when detached, but the listener does not).
    kfLatch?.dock?.editor?.destroy();
    kfLatch = null;
    kfLatchKey = '\u0000';
    kfPoseKey = '\u0000';
    kfCam = null;
    kfCamKey = '\u0000';
    // An empty row still claims the bar's 10px flex gap, which reads as an unexplained
    // notch beside the tool buttons once the selection is dropped. Take it out of the
    // layout instead, so the toolbar returns to exactly the shape it had before.
    inspector.hidden = !box;
    if (!box) {
      inspectorShown = false;
      if (inspectorEnterT) { clearTimeout(inspectorEnterT); inspectorEnterT = null; }
      inspector.classList.remove('is-entering');
      // Nothing selected, so there is no clip whose settings this could be showing.
      closeGroupPopover();
      return;
    }
    if (!inspectorShown) {
      inspectorShown = true;
      inspector.classList.remove('is-entering');
      if (inspectorEnterT) clearTimeout(inspectorEnterT);
      // A tick, not zero: the class has to land on a row the browser has already laid
      // out, or the animation is coalesced into the same style pass that built the row
      // and never plays at all.
      inspectorEnterT = setTimeout(() => {
        inspectorEnterT = null;
        inspector.classList.add('is-entering');
      }, 32);
    }
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
     * A numeric field. `value === null` means UNAUTHORED - the field renders empty with
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
    /**
     * The easing picker for one direction. Governs GEOMETRY ONLY - opacity keeps its
     * own fixed ramp (see the easing section of lib/transitions.ts), which is why there
     * is no fade curve offered anywhere here and must not be.
     *
     * UNAUTHORED IS A REAL STATE and it is the default one: the empty option means "the
     * curve this kind was born with", it is what an untouched box selects, and choosing
     * it changes nothing - a `<select>` fires no `change` for the value it already
     * shows, so simply rendering this row can never write a field. That property is the
     * whole reason the built-in is an option rather than an implied absence of one.
     *
     * `__custom` is a ROUTE, not a value: picking it snaps the box back to whatever was
     * authored and opens the curve editor, so the control never displays a state the
     * model is not in.
     */
    const easeSelect = (field: string, value: unknown): HTMLSelectElement => {
      const el = document.createElement('select');
      el.className = 'field-select tl-select tl-ease';
      el.dataset.field = field;
      const cur = easingToWire(value);
      const opt = (v: string, label: string): void => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        el.appendChild(o);
      };
      opt('', t('Built-in'));
      for (const [k, label] of Object.entries(EASINGS)) opt(k, t(label));
      // An authored bezier has no preset to select, so it brings its own option - and
      // shows the actual numbers, because "Custom" alone tells the user nothing about
      // the curve they are looking at.
      if (cur && !Object.hasOwn(EASINGS, cur)) opt(cur, cur);
      opt('__custom', t('Custom…'));
      el.value = cur;
      el.addEventListener('change', () => {
        const v = el.value;
        if (v === '__custom') {
          el.value = cur;               // the route was taken; the value did not change
          openEaseEditor(id, field, el);
          return;
        }
        write(patchBox(getBoxes(), id, { [field]: v }));
      });
      return el;
    };

    const timed = isTimed(box, cfg);

    // ── the groups ────────────────────────────────────────────────────────────
    //
    // A `camera` box swaps Time + Animate for the CAMERA group (plans/104 section 8, the P1
    // seam this function was left holding): pose channels - pan / dolly / focus /
    // aperture / FOV strength - each with the DRAG / SCROLL affordance chip the
    // reference tool puts on the same row. Keyframes and the timed ⇄ always-on switch
    // stay exactly as they are: a camera is timed like any other box, and its whole
    // purpose is animation.
    //
    // Why the two it replaces go: a camera's ENTER/EXIT transition is ignored by both
    // evaluators in v1 (section 5.4), so an Animate group on one is a control that writes a
    // field nothing reads; and its Time is the switch below plus the clip's own bar,
    // not a start/length pair - a camera has no media to trim and no speed to set.
    const isCamera = isCameraBox(box);

    // ── Camera ────────────────────────────────────────────────────────────────
    if (isCamera) buildCameraGroup(id, box);

    // ── Time ──────────────────────────────────────────────────────────────────
    // Shut, like every group since section 8's M2.5 revision - including on an UNTIMED box,
    // where Start and Length are still the typed promotion route (the `.tl-timing`
    // switch below is the one-press one). Auto-opening a popover over the canvas
    // because a box was selected is a popover the user has to dismiss.
    const timeG = isCamera ? null : inspectorGroup('time', t('Time'), 'clock');
    if (timeG) inspector.appendChild(timeG.root);

    if (timeG && !timed) {
      // ── UNTIMED (scenery) ───────────────────────────────────────────────────
      // Start and Length are the promotion route: this is the ONLY place in the UI a
      // text/image/lottie/tool box could ever be given a time without hand-editing the
      // ?boxes= URL. Both render EMPTY - a 0 would claim the box starts at the top of
      // the sequence, which is a different (and authored) state.
      const hint = t('Type a time to place this on the timeline');
      const untimedStart = numField(null, 0.1, 0, (v) => promote(id, { start: v }), '-');
      untimedStart.title = hint;
      timeG.body.appendChild(row(t('Start'), untimedStart));
      const untimedLen = numField(null, 0.1, MIN_DUR, (v) => promote(id, { dur: v }), '-');
      untimedLen.title = hint;
      timeG.body.appendChild(row(t('Length'), untimedLen));
      timeG.setSummary([t('Always on')]);
    } else if (timeG) {
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
      timeG.body.appendChild(row(t('Start'), startField));
      // Length is ABSOLUTE (`setDuration`), seeded from the span the bar actually shows.
      // The old shape seeded from `timing.dur ?? 0` and committed a DELTA against it,
      // so on an open-ended clip - which displays as `total - start` and read 0 - typing
      // 5 landed on trimClip's own 3 s fallback + 5 = 8 s.
      const shown = span(box, durationSec());
      timeG.body.appendChild(row(t('Length'), numField(shown.dur, 0.1, MIN_DUR, (v) => {
        write(setDuration(getBoxes(), cfg, id, v, mediaOf(id).dur, mediaDur));
      })));
      // Trim in and Speed go through the clamped setters, NOT patchBox: a raw write puts
      // clipIn + dur x speed past the end of the source, which the player cannot recover
      // from (it seeks past duration and the bar plays nothing).
      timeG.body.appendChild(row(t('Trim in'), numField(timing.clipIn, 0.1, 0, (v) => {
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
      timeG.body.appendChild(row(t('Speed'), speed));
      // The collapsed reading: where it starts, how long it runs, how fast - the three
      // numbers a clip is identified by. Formatted by timeline-math's own formatters
      // (`fmtTime` / `fmtDur`), the same ones the transport pill and the trim badge use,
      // so a summary can never disagree with the readout beside it. Trim-in stays behind
      // the disclosure: it is a property of the SOURCE, not of the clip's place in time.
      timeG.setSummary([fmtTime(timing.start ?? 0), fmtDur(shown.dur), `×${timing.speed}`]);
    }

    // ── Animate ───────────────────────────────────────────────────────────────
    // Enter / exit + their durations. Authorable either side of the timed line: a box
    // that is always on can still be given the transition it will use once it is timed,
    // and the fields are plain value writes, so nothing here depends on a bar existing.
    //
    // Never on a CAMERA: v1 ignores a camera box's enter/exit outright (section 5.4), so these
    // would be four controls writing fields no evaluator reads.
    const mediaKind = id ? mediaOf(id).kind : '';
    const audioFades = mediaKind === 'audio';
    const animG = isCamera ? null : inspectorGroup('animate', audioFades ? t('Fades') : t('Animate'), 'animate');
    if (animG) inspector.appendChild(animG.root);
    if (animG && audioFades) {
      // A sound has no picture for `rise` or `pop` to move: its in/out ARE fades
      // (plans/165 WP-2 - the mix reads any authored kind on an audio box as a fade,
      // and this writer only ever authors 'fade'). Duration-only rows; 0 clears the
      // kind so an unfaded box stays byte-identical to one written before this change.
      const fadeRow = (label: string, kindField: string, msField: string): void => {
        const cur = isTransitionKind(String(box[kindField] ?? '')) ? finite(box[msField], 400) : 0;
        animG.body.appendChild(row(label, numField(cur, 50, 100, (v) => {
          const ms = Math.round(clamp(v, 0, MAX_TRANSITION_MS));
          write(patchBox(getBoxes(), id, ms > 0
            ? { [kindField]: 'fade', [msField]: Math.max(MIN_TRANSITION_MS, ms) }
            : { [kindField]: '', [msField]: '' }));
        })));
      };
      fadeRow(t('Fade in'), cfg.enterField, cfg.enterMsField);
      fadeRow(t('Fade out'), cfg.exitField, cfg.exitMsField);
      const fi = isTransitionKind(String(box[cfg.enterField] ?? '')) ? finite(box[cfg.enterMsField], 400) : 0;
      const fo = isTransitionKind(String(box[cfg.exitField] ?? '')) ? finite(box[cfg.exitMsField], 400) : 0;
      animG.setSummary([fi > 0 || fo > 0 ? `${fmtDur(fi / 1000)} / ${fmtDur(fo / 1000)}` : t('No fades')]);
    }
    if (animG && !audioFades) {
      animG.body.appendChild(row(t('Animate in'), kindSelect(box[cfg.enterField], (v) => write(patchBox(getBoxes(), id, { [cfg.enterField]: v })))));
      animG.body.appendChild(row(t('In (ms)'), numField(finite(box[cfg.enterMsField], 400), 50, 100, (v) => write(patchBox(getBoxes(), id, { [cfg.enterMsField]: Math.round(clamp(v, MIN_TRANSITION_MS, MAX_TRANSITION_MS)) })))));
      // The curve sits beside its duration, not beside its kind: "how long" and "how it
      // moves over that time" are the pair a user tunes together. Offered only where the
      // manifest declares a field for it - a tool that never asked for authored easing is
      // not given a control that would write a sub-field it does not read.
      if (cfg.enterEaseField) animG.body.appendChild(row(t('In curve'), easeSelect(cfg.enterEaseField, box[cfg.enterEaseField])));
      animG.body.appendChild(row(t('Animate out'), kindSelect(box[cfg.exitField], (v) => write(patchBox(getBoxes(), id, { [cfg.exitField]: v })))));
      animG.body.appendChild(row(t('Out (ms)'), numField(finite(box[cfg.exitMsField], 400), 50, 100, (v) => write(patchBox(getBoxes(), id, { [cfg.exitMsField]: Math.round(clamp(v, MIN_TRANSITION_MS, MAX_TRANSITION_MS)) })))));
      if (cfg.exitEaseField) animG.body.appendChild(row(t('Out curve'), easeSelect(cfg.exitEaseField, box[cfg.exitEaseField])));
      // ── Split text (plans/175 WP-A): tier × stagger × order over the presets above ──
      // Manifest-gated like the ease rows, and only on a box that actually holds text.
      // '' (whole text) is the absence: an untouched box writes nothing, and the
      // stagger/order rows only appear once a tier is chosen (disclosure, not clutter).
      if (cfg.splitField && cfg.staggerField && cfg.textField
        && String(box[cfg.textField] ?? '').trim() !== '' && String(box.kind ?? '') !== 'frame') {
        const enumSelect = (
          entries: readonly (readonly [string, string])[], cur: string, onCommit: (v: string) => void,
        ): HTMLSelectElement => {
          const el = document.createElement('select');
          el.className = 'field-select tl-select';
          for (const [v, label] of entries) {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = label;
            el.appendChild(o);
          }
          el.value = cur;
          el.addEventListener('change', () => onCommit(el.value));
          return el;
        };
        const tierRaw = String(box[cfg.splitField] ?? '');
        const tier = isSplitTier(tierRaw) ? tierRaw : '';
        animG.body.appendChild(row(t('Animate text by'), enumSelect(
          [['', t('Whole text')], ...Object.entries(SPLIT_TIERS).map(([v, label]) => [v, t(label)] as const)],
          tier,
          (v) => write(patchBox(getBoxes(), id, { [cfg.splitField as string]: v })),
        )));
        if (tier) {
          animG.body.appendChild(row(t('Stagger (ms)'), numField(finite(box[cfg.staggerField], 60), 10, 0, (v) =>
            write(patchBox(getBoxes(), id, { [cfg.staggerField as string]: Math.round(clamp(v, 0, MAX_SPLIT_STAGGER_MS)) })))));
          if (cfg.splitOrderField) {
            const ordRaw = String(box[cfg.splitOrderField] ?? '');
            animG.body.appendChild(row(t('Text order'), enumSelect(
              Object.entries(SPLIT_ORDERS).map(([v, label]) => [v, t(label)] as const),
              isSplitOrder(ordRaw) ? ordRaw : '',
              (v) => write(patchBox(getBoxes(), id, { [cfg.splitOrderField as string]: v })),
            )));
          }
        }
      }
      // ── Hold effect (plans/175 WP-B): the Loop/Emphasis bucket beside In/Out ──
      // Manifest-gated like every optional row; any box kind can pulse - a CTA
      // sticker is the same feature as a heading. Frames are excluded, exactly as
      // the hook excludes them from the attribute.
      if (cfg.holdField && cfg.holdRateField && String(box.kind ?? '') !== 'frame') {
        const enumSelect = (
          entries: readonly (readonly [string, string])[], cur: string, onCommit: (v: string) => void,
        ): HTMLSelectElement => {
          const el = document.createElement('select');
          el.className = 'field-select tl-select';
          for (const [v, label] of entries) {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = label;
            el.appendChild(o);
          }
          el.value = cur;
          el.addEventListener('change', () => onCommit(el.value));
          return el;
        };
        const holdRaw = String(box[cfg.holdField] ?? '');
        const holdCur = isHoldFx(holdRaw) ? holdRaw : '';
        animG.body.appendChild(row(t('While on screen'), enumSelect(
          [['', t('Still')], ...Object.entries(HOLD_FX).map(([v, label]) => [v, t(label)] as const)],
          holdCur,
          (v) => write(patchBox(getBoxes(), id, { [cfg.holdField as string]: v })),
        )));
        if (holdCur) {
          animG.body.appendChild(row(t('Hold speed (cycles/sec)'), numField(finite(box[cfg.holdRateField], 1), 0.1, MIN_HOLD_RATE, (v) =>
            write(patchBox(getBoxes(), id, { [cfg.holdRateField as string]: Math.round(clamp(v, MIN_HOLD_RATE, MAX_HOLD_RATE) * 100) / 100 })))));
        }
      }
      animG.setSummary(animateSummary(box[cfg.enterField], box[cfg.exitField]));
      // A rebuild mints a new <select>, so an editor that is still open is anchored to a
      // detached node - its focus restore on Escape would land nowhere. Re-point the
      // delegate at the control that replaced it.
      if (easeMenu.isOpen() && easeId === id && easeField) {
        const live = Array.from(inspector.querySelectorAll<HTMLSelectElement>('.tl-ease'))
          .find((s) => s.dataset.field === easeField);
        if (live) easePoint.delegate = live;
      }
    }

    // ── Keyframes ─────────────────────────────────────────────────────────────
    //
    // THE DISCLOSURE LAW (plans/51:80, restated by plans/104 section 8): nobody keyframes by
    // accident. A camera exists only to be animated, so it always carries the group; a
    // content box earns it by already having a track. Every other box has no keyframe
    // affordance anywhere in the UI - not a disabled one, not an empty one. Animate is
    // DERIVED, never stored: the gate reads the track itself, so there is no second
    // source of truth to drift (section 8, "Animate is DERIVED, not stored").
    //
    // The body itself is built below. The DOOR is the form of it: a box with no
    // track and no camera kind gets ONE action ("Animate") behind a collapsed
    // disclosure, and nothing else - no diamonds on its bar, no latch, no list. A
    // camera is born disclosed, because a camera exists only to be animated.
    //
    // `isKeyframable` is the SAME gate "+Keyframe" uses, and it has to be: without it
    // a detached sound got the group and its Animate door, which wrote precisely the
    // x/y/s/r/o track the button refuses to write and no evaluator reads - a door onto
    // a room the rest of the UI says does not exist (section 8's disclosure law is explicit:
    // "Every other box has no keyframe affordance anywhere in the UI").
    const kfRaw = cfg.kfField ? String(box[cfg.kfField] ?? '') : '';
    if (cfg.kfField && isKeyframable(box, id)) {
      // parseKf is the engine's own reader (plans/104 section 5.1) - never a `split('*')` here.
      // It never throws, so a hand-edited share URL summarises as "No keyframes" rather
      // than taking the inspector down with it.
      const track = kfRaw ? parseKf(kfRaw) : null;
      const n = track ? track.length : 0;
      const kfG = inspectorGroup('keyframes', t('Keyframes'), 'keyframe');
      inspector.appendChild(kfG.root);
      kfG.setSummary([
        n === 0 ? t('Not animated')
          : n === 1 ? t('1 keyframe') : t('{n} keyframes', { n: String(n) }),
      ]);

      if (n === 0 && !isCamera) {
        // ── Depth, then the door ─────────────────────────────────────────────
        // Depth stands FIRST because it is what a lifted layer needs before it needs a
        // keyframe: set the parallax, THEN (optionally) animate it. It writes the box's
        // own `z` field, not a track (see `buildDepthControl`), so it is not a keyframe
        // affordance and does not violate section 8's disclosure law.
        buildDepthControl(kfG, id, box);
        // One action, one commit, one undo step. Enabling is DERIVED, not stored
        // (section 8): what it writes is a t = 0 pose, and the track's existence IS the
        // animated state from then on - there is no flag anywhere to drift.
        const door = actionBtn('tl-kf-animate', t('Animate'), 'keyframe');
        door.title = t('Adds a first pose at the start of this clip. Everything else stays where it is.');
        door.addEventListener('click', () => animateBox(id));
        kfG.body.appendChild(door);
      } else {
        // The curve editor is DOCKED in this body now (section 8's M2.7), so there is no
        // second popover anchored to a `<select>` this rebuild just detached - the
        // re-point the transition editor still needs above has nothing to re-point.
        // `syncKfLatch` rebuilds the dock against the row that replaced this one.
        buildKeyframes(kfG, id, box, track ?? parseKf(''), isCamera);
      }
    }

    // ── Sound: a TOGGLE, never a group ────────────────────────────────────────
    //
    // section 8's M2.6 pass: "SOUND stops being a popover group entirely… it becomes a
    // speaker/mute icon toggle on the strip (direct click flips mute - the NLE
    // convention), no popup." Mute is ONE bit, and a disclosure onto one switch is a
    // door onto a door: the M2.5 group cost a press, a popover mount and a "Sound on"
    // chip to say what a speaker glyph with `aria-pressed` says standing still.
    //
    // The A/V link went back to the CLIP CONTEXT MENU, its pre-M2 home (`ctxMenu`
    // above, which never stopped offering Re-attach / Detach) - plus the `Shift + D`
    // chord. Detaching a clip's audio is a structural edit that grows a second bar on
    // another lane; it is not a sibling of a mute switch, and it is not something the
    // inspector needs a permanent seat for.
    //
    // Mute is a playback concern, so it exists only on something that plays.
    //
    // VOLUME sits beside it on the same terms (plans/165 WP-1): a percent slider
    // writing the manifest's gain sub-field, shown only where the tool declares one
    // and the box actually carries sound. 100% = as recorded; up to 200% boosts the
    // RENDERED file - the preview element caps at 100%, which the title states so
    // the difference is a documented behaviour, not a surprise.
    if (timed && cfg.gainField && (mediaKind === 'audio' || mediaKind === 'video')) {
      const gf = cfg.gainField;
      const cur = clamp(finite(box[gf], 1), 0, 2);
      const wrap = document.createElement('label');
      wrap.className = 'field-row field-row--inline tl-field tl-volume-row';
      const lab = document.createElement('span');
      lab.className = 'field-label';
      lab.textContent = t('Volume');
      const slider = document.createElement('input');
      slider.className = 'tl-kf-slider tl-volume-slider';
      slider.type = 'range';
      slider.min = '0';
      slider.max = '200';
      slider.step = '5';
      slider.setAttribute('aria-label', t('Volume'));
      slider.value = String(Math.round(cur * 100));
      const num = document.createElement('input');
      num.className = 'field-input tl-num tl-volume-num';
      num.type = 'number';
      num.min = '0';
      num.max = '200';
      num.step = '5';
      num.value = String(Math.round(cur * 100));
      num.title = t('Percent of the recorded level. Above 100% boosts the exported file; the preview plays at 100%.');
      // One model write per gesture, the depth row's own contract: `input` mirrors
      // the number live, `change` commits once. 100% clears the field so an
      // untouched box stays byte-identical to one written before this change.
      const commit = (raw: number): void => {
        const pct = Math.round(clamp(raw, 0, 200));
        num.value = String(pct);
        slider.value = String(pct);
        write(patchBox(getBoxes(), id, { [gf]: pct === 100 ? '' : pct / 100 }));
      };
      slider.addEventListener('input', () => { num.value = slider.value; });
      slider.addEventListener('change', () => commit(finite(slider.value, 100)));
      num.addEventListener('change', () => commit(finite(num.value, 100)));
      wrap.append(lab, slider, num);
      // VOLUME KEYFRAMES (plans/165 WP-3): the diamond keys the row's current value
      // at the playhead, riding the SAME kf grammar as pose keys (`v` channel), so
      // split/trim/join rebase volume automation with zero extra code. Deliberately
      // NOT the pose popup: an audio box is excluded from pose keyframing by the
      // disclosure law, and volume is a property of the sound, so its authoring
      // affordance lives beside the volume it keys. Linear between keys, held past
      // the ends - the DAW convention.
      if (cfg.kfField) {
        const keyBtn = btn('tl-volume-key', t('Key volume at the playhead'), icon('keyframe'));
        keyBtn.removeAttribute('data-tip');
        keyBtn.title = t('Key volume at the playhead');
        keyBtn.addEventListener('click', () => {
          const rows = getBoxes();
          const bi = indexOfId(rows, cfg, id);
          if (bi < 0) return;
          const bx = rows[bi]!;
          const atMs = kfWriteMs(bx, cfg, clock.t() / 1000);
          const track = kfBoxTrack(bx, cfg);
          const val = clamp(finite(num.value, 100), 0, 200) / 100;
          const hit = track.findIndex((k) => k.t === atMs);
          const keys = hit >= 0
            ? track.map((k, j) => (j === hit ? { t: k.t, ease: k.ease, v: { ...k.v, v: val } } : k))
            : [...track, { t: atMs, ease: '', v: { v: val } }];
          // The key CAPTURES the row's level and the flat trim resets to neutral in
          // the SAME commit - otherwise the two multiply and the keyed level plays
          // double. From here the slider is a trim over the automation (the DAW
          // model); the rebuild snaps it back to 100%.
          write(patchBox(setKfTrack(rows, cfg, id, keys as never), id, { [gf]: '' }));
          announce(t('Volume keyframe set'));
        });
        wrap.appendChild(keyBtn);
        const vCount = kfBoxTrack(box, cfg).filter((k) => typeof k.v.v === 'number').length;
        if (vCount > 0) {
          const meta = document.createElement('span');
          meta.className = 'tl-volume-keys field-label';
          meta.textContent = vCount === 1 ? t('1 volume key') : t('{n} volume keys', { n: String(vCount) });
          const clearBtn = btn('tl-volume-clear', t('Clear volume keys'), icon('scissors'));
          clearBtn.removeAttribute('data-tip');
          clearBtn.title = t('Clear volume keys');
          clearBtn.addEventListener('click', () => {
            const rows = getBoxes();
            const bi = indexOfId(rows, cfg, id);
            if (bi < 0) return;
            const track = kfBoxTrack(rows[bi]!, cfg);
            const keys = track
              .map((k) => {
                const pose = { ...k.v } as Record<string, number>;
                delete pose.v;
                return { t: k.t, ease: k.ease, v: pose };
              })
              .filter((k) => Object.keys(k.v).length > 0);
            write(setKfTrack(rows, cfg, id, keys as never));
            announce(t('Volume keyframes cleared'));
          });
          wrap.append(meta, clearBtn);
        }
      }
      // PER-CLIP NORMALIZE (plans/101 section 2.5): measure the trimmed window's
      // BS.1770 integrated loudness and set Volume so the clip hits a -16 LUFS
      // reference, clamped to the row's own 0..200% range. One decode, one
      // commit; a decode is a click away, never per frame.
      const normBtn = btn('tl-volume-normalize', t('Normalize volume'), icon('sliders'));
      normBtn.removeAttribute('data-tip');
      normBtn.title = t('Measure this clip and set Volume so it plays at -16 LUFS.');
      normBtn.addEventListener('click', () => {
        void (async () => {
          const media = mediaOf(id);
          if (!media.url) { announce(t('Nothing to measure on this clip.'), { assertive: true }); return; }
          normBtn.disabled = true;
          try {
            const bytes = await (await fetch(media.url)).arrayBuffer();
            // Decode AT the mix rate: an OfflineAudioContext resamples to its own
            // rate, and the meter's K-weighting coefficients are 48 kHz-only.
            const octx = new OfflineAudioContext(2, 1, 48_000);
            const buf = await octx.decodeAudioData(bytes);
            const rows0 = getBoxes();
            const bx = rows0[indexOfId(rows0, cfg, id)] ?? box;
            const clipInSec = finite(bx[cfg.clipInField], 0);
            const durSec = finite(bx[cfg.durField], Number.NaN);
            const speed = finite(bx[cfg.speedField], 1);
            const from = Math.max(0, Math.min(buf.length, Math.round(clipInSec * 48_000)));
            const srcSpan = Number.isFinite(durSec) ? durSec * speed : buf.duration - clipInSec;
            const n = Math.max(0, Math.min(buf.length - from, Math.round(srcSpan * 48_000)));
            const chs: Float32Array[] = [];
            for (let c = 0; c < 2; c++) {
              chs.push(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).subarray(from, from + n));
            }
            const lkfs = integratedLoudness(chs);
            if (lkfs == null) { announce(t('This clip is silent - nothing to normalize.'), { assertive: true }); return; }
            const g = Math.max(0, Math.min(2, 10 ** ((-16 - lkfs) / 20)));
            write(patchBox(getBoxes(), id, { [gf]: Math.abs(g - 1) < 0.005 ? '' : Math.round(g * 100) / 100 }));
            announce(t('Volume normalized.'));
          } catch {
            announce(t('Could not measure this clip.'), { assertive: true });
          } finally {
            normBtn.disabled = false;
          }
        })();
      });
      wrap.appendChild(normBtn);
      inspector.appendChild(wrap);
    }
    // PAN (plans/165 WP-5): left/right balance, writing the manifest's pan sub-field.
    // Same one-commit discipline as the Volume row above; 0 clears the field so an
    // untouched box stays byte-identical. An audio box pans live through a real
    // StereoPannerNode; a video element cannot pan in preview, so its title says
    // where the pan applies.
    if (timed && cfg.panField && (mediaKind === 'audio' || mediaKind === 'video')) {
      const pf = cfg.panField;
      const cur = clamp(finite(box[pf], 0), -1, 1);
      const wrap = document.createElement('label');
      wrap.className = 'field-row field-row--inline tl-field tl-pan-row';
      const lab = document.createElement('span');
      lab.className = 'field-label';
      lab.textContent = t('Pan');
      const slider = document.createElement('input');
      slider.className = 'tl-kf-slider tl-pan-slider';
      slider.type = 'range';
      slider.min = '-100';
      slider.max = '100';
      slider.step = '5';
      slider.setAttribute('aria-label', t('Pan'));
      slider.value = String(Math.round(cur * 100));
      const num = document.createElement('input');
      num.className = 'field-input tl-num tl-pan-num';
      num.type = 'number';
      num.min = '-100';
      num.max = '100';
      num.step = '5';
      num.value = String(Math.round(cur * 100));
      num.title = mediaKind === 'audio'
        ? t('Left/right balance: -100 is hard left, 100 is hard right.')
        : t("Left/right balance: -100 is hard left, 100 is hard right. A video clip's sound pans in the exported file; the preview plays centred.");
      const commit = (raw: number): void => {
        const pct = Math.round(clamp(raw, -100, 100));
        num.value = String(pct);
        slider.value = String(pct);
        write(patchBox(getBoxes(), id, { [pf]: pct === 0 ? '' : pct / 100 }));
      };
      slider.addEventListener('input', () => { num.value = slider.value; });
      slider.addEventListener('change', () => commit(finite(slider.value, 0)));
      num.addEventListener('change', () => commit(finite(num.value, 0)));
      wrap.append(lab, slider, num);
      inspector.appendChild(wrap);
    }
    // DUCKING (plans/165 WP-6 v1): drop this track while any other clip's audio
    // plays - the export bed's own off/low behaviour, offered per audio box. A
    // select, not a slider: three honest levels beat a percent nobody can hear.
    // One write per change; the no-duck choice clears the field.
    if (timed && cfg.duckField && mediaKind === 'audio') {
      const df = cfg.duckField;
      const cur = finite(box[df], 1);
      const wrap = document.createElement('label');
      wrap.className = 'field-row field-row--inline tl-field tl-duck-row';
      const lab = document.createElement('span');
      lab.className = 'field-label';
      lab.textContent = t('Under other audio');
      const sel = document.createElement('select');
      sel.className = 'field-select field-select--sm tl-duck-select';
      sel.setAttribute('aria-label', t('Under other audio'));
      sel.title = t("Lower this track while any other clip's audio plays.");
      const opt = (v: string, label: string): void => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        sel.appendChild(o);
      };
      opt('', t('No change'));
      opt('0.2', t('Quieter'));
      opt('0', t('Silent'));
      sel.value = cur >= 1 ? '' : cur <= 0 ? '0' : '0.2';
      sel.addEventListener('change', () => {
        write(patchBox(getBoxes(), id, { [df]: sel.value === '' ? '' : Number(sel.value) }));
      });
      wrap.append(lab, sel);
      inspector.appendChild(wrap);
    }
    // EFFECT (plans/101 section 3.4): the preset rack. Each choice WRITES the
    // expanded chain (never the preset name), so a later preset re-tune can
    // never change what an already-shared link sounds like. A chain that no
    // preset produced reads back as Custom and is left alone until the user
    // picks something else - hand-authored grammar survives the round-trip.
    if (timed && cfg.fxField && (mediaKind === 'audio' || mediaKind === 'video')) {
      const ff = cfg.fxField;
      const cur = String(box[ff] ?? '');
      const wrap = document.createElement('label');
      wrap.className = 'field-row field-row--inline tl-field tl-fx-row';
      const lab = document.createElement('span');
      lab.className = 'field-label';
      lab.textContent = t('Effect');
      const sel = document.createElement('select');
      sel.className = 'field-select field-select--sm tl-fx-select';
      sel.setAttribute('aria-label', t('Effect'));
      sel.title = mediaKind === 'audio'
        ? t("How this clip's sound is treated in the mix.")
        : t("How this clip's sound is treated in the mix. A video clip's effect applies in the exported file; the preview plays it untreated.");
      const PRESET_LABELS: [string, string][] = [
        ['voice-cleanup', t('Voice cleanup')],
        ['voice-clarity', t('Voice clarity')], ['warm', t('Warm')], ['bright', t('Bright')],
        ['telephone', t('Telephone')], ['muffled', t('Muffled')], ['radio', t('Radio')],
        ['lo-fi', t('Lo-fi')], ['echo', t('Echo')], ['room', t('Room')], ['hall', t('Hall')],
        ['plate', t('Plate')], ['de-hum', t('De-hum')], ['gate', t('Noise gate')],
      ];
      const opt = (v: string, label: string): void => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        sel.appendChild(o);
      };
      opt('', t('No effect'));
      for (const [key, label] of PRESET_LABELS) opt(key, label);
      const match = PRESET_LABELS.find(([key]) => FX_PRESETS[key] === cur)?.[0] ?? '';
      if (cur && !match) {
        opt('__custom', t('Custom'));
        sel.value = '__custom';
      } else {
        sel.value = match;
      }
      sel.addEventListener('change', () => {
        if (sel.value === '__custom') return;   // reselecting the label is a no-op
        write(patchBox(getBoxes(), id, { [ff]: sel.value ? FX_PRESETS[sel.value] : '' }));
      });
      wrap.append(lab, sel);
      inspector.appendChild(wrap);
    }
    // PITCH (plans/165 WP-7b): transpose in semitones, formants preserved, at any
    // speed. Same one-commit discipline; 0 clears the field.
    if (timed && cfg.pitchField && (mediaKind === 'audio' || mediaKind === 'video')) {
      const ptf = cfg.pitchField;
      const cur = Math.round(clamp(finite(box[ptf], 0), -12, 12));
      const wrap = document.createElement('label');
      wrap.className = 'field-row field-row--inline tl-field tl-pitch-row';
      const lab = document.createElement('span');
      lab.className = 'field-label';
      lab.textContent = t('Pitch');
      const num = document.createElement('input');
      num.className = 'field-input tl-num tl-pitch-num';
      num.type = 'number';
      num.min = '-12';
      num.max = '12';
      num.step = '1';
      num.value = String(cur);
      num.setAttribute('aria-label', t('Pitch'));
      num.title = mediaKind === 'audio'
        ? t('Semitones up or down: 12 is an octave. 0 plays as recorded.')
        : t("Semitones up or down: 12 is an octave. A video clip's sound transposes in the exported file; the preview plays as recorded.");
      num.addEventListener('change', () => {
        const st = Math.round(clamp(finite(num.value, 0), -12, 12));
        num.value = String(st);
        write(patchBox(getBoxes(), id, { [ptf]: st === 0 ? '' : st }));
      });
      wrap.append(lab, num);
      inspector.appendChild(wrap);
    }
    // PRESERVE PITCH (plans/165 WP-7b): only meaningful on a speed-changed clip.
    // Checked - the editor default - keeps the recorded pitch through the stretch;
    // unchecked plays tape-style (pitch follows speed). The default choice clears
    // the field so an untouched box stays byte-identical.
    if (timed && cfg.varispeedField && (mediaKind === 'audio' || mediaKind === 'video')
      && finite(box[cfg.speedField], 1) !== 1) {
      const vf = cfg.varispeedField;
      const vari = box[vf] === true || box[vf] === 'true';
      const wrap = document.createElement('label');
      wrap.className = 'field-row field-row--inline tl-field tl-varispeed-row field-toggle';
      const lab = document.createElement('span');
      lab.className = 'field-label';
      lab.textContent = t('Preserve pitch');
      const check = document.createElement('input');
      check.className = 'field-check';
      check.type = 'checkbox';
      check.checked = !vari;
      check.setAttribute('aria-label', t('Preserve pitch'));
      check.title = t('On keeps the recorded pitch when the clip plays faster or slower. Off plays it tape-style: pitch follows speed.');
      check.addEventListener('change', () => {
        write(patchBox(getBoxes(), id, { [vf]: check.checked ? '' : 'true' }));
      });
      wrap.append(lab, check);
      inspector.appendChild(wrap);
    }
    if (timed) {
      const muted = box[cfg.muteField] === true || box[cfg.muteField] === 'true';
      const muteLabel = muted ? t('Unmute clip') : t('Mute clip');
      const mute = btn('tl-mute', muteLabel, icon(muted ? 'volumeOff' : 'volumeOn'));
      // PRESSED means silent. The glyph flips with it (speaker ⇄ speaker-off) so the
      // state is readable without hovering, and the label names the ACTION the press
      // performs - both existing keys, neither invented for this pass.
      mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
      // `title`, not the `[data-tip]` bubble `btn()` stamps: `.tl-inspector` is an
      // overflow scroller, so a bubble drawn above the control is clipped - the same
      // reason the `.tl-timing` switch at the end of the row carries a title.
      mute.removeAttribute('data-tip');
      mute.title = muteLabel;
      // ONE model write per press, like every other writer in this panel. `muted` is
      // read from the row this build painted, so the toggle can never invert twice off
      // one gesture; the rebuild that follows the commit re-reads it.
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

    // LAST, once every segment exists: an open popover follows the row it belongs to
    // through the rebuild this commit caused, or shuts if that row is gone.
    resyncGroupPopover(id);
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
    /** The bar's resolved foreground colour - canvas 2D silently ignores currentColor. */
    ink: string;
    /** The BOX's own computed background, for the no-media fallback. */
    fill: string;
    /**
     * The live `.lolly-box`, and its model row. Both resolved HERE, in the read pass:
     * `paintThumbs` used to re-scan `getBoxes()` with `indexOfId` per bar, which is
     * O(bars × boxes) and - now that node mode needs the row for its cache key too - 
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
   * One idle pass, and - when it left work behind - the next.
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
      // READ every bar first, THEN paint - one style/layout pass for the whole panel.
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
      //   • a bar already IN FLIGHT joins the running shot (`share()` dedups it) - this
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

    /**
     * The bar's VECTOR TWIN: what this canvas would look like as SVG, for the export
     * walker (lib/vector-paint.ts, bridge/export.ts's `vectorTwinEl`). Presence-keyed
     * and invisible - no element, class, attribute or ThumbMode is added, so the bar's
     * four children and the live paint are byte-for-byte what they always were, and a
     * canvas that never gets a twin serialises exactly as it does today.
     *
     * It is CLEARED first and stamped only where a picture actually landed, because a
     * stale twin is worse than none: it would describe pixels the bar is no longer
     * showing, and the export would disagree with the screen.
     */
    const setTwin = (f: VectorTwin | null): void => {
      const c = cv as VectorTwinCanvas;
      if (f) c.__lollyVectorTwin = f;
      else delete c.__lollyVectorTwin;
    };
    setTwin(null);

    if (!(w > 8) || !(h > 8)) return;
    const mode = thumbMode(media.kind, media.url, job.fill, job.canRaster);
    // Nothing to say about this box: leave the bar's kind tint alone rather than
    // sizing a canvas that would only be cleared.
    if (mode === 'none') return;

    // Sizing a canvas RESETS its bitmap - assigning `cv.width` clears it even when the
    // value is unchanged - so it is deferred behind whoever actually has something to
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
      // Assigning width RESETS the bitmap (see above) - so whatever a twin was
      // describing has just been erased. Cleared here rather than only at entry
      // because `sized()` is deferred: the node branch's underlay can size the canvas
      // passes after the twin that is still hanging off it was stamped.
      setTwin(null);
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

    /**
     * ONE bitmap, once, over the box's own flat fill - the STATIC bar (plans/104 section 8's
     * M2.5 revision, point 4).
     *
     * A filmstrip or a waveform repeats because it is a picture of time passing. A
     * photograph of a text card is not: it is identical in every tile, so a three-second
     * title card read as the same sentence printed twenty times at 6px - noise wearing
     * the costume of information. Drawn once at the leading edge, with the fill carrying
     * the rest of the bar, so the bar reads as one label over one colour.
     *
     * The fill is re-laid here rather than relied on from `paintFill`'s earlier pass:
     * `clearRect` is what makes the upgrade flicker-free (one synchronous overwrite),
     * and it takes the underlay with it.
     */
    const drawSingle = (c: CanvasRenderingContext2D, bm: ImageBitmap): void => {
      c.clearRect(0, 0, w, h);
      if (isPaintedColor(job.fill)) {
        c.fillStyle = job.fill;
        c.fillRect(0, 0, w, h);
      }
      const tile = stillTilePx(bm.height > 0 ? bm.width / bm.height : 0, h);
      // The FULL tile, cut by the canvas edge - never squeezed into `min(tile, w)`.
      // `drawTiled` has always drawn every tile at its own aspect and let the last one
      // overhang, and the vector twin below models exactly that (the walk is sized to
      // `tile` and clipped at `min(tile, w)`). Scaling here instead made a bar narrower
      // than one tile - a short clip, or any clip at low zoom - show a squeezed whole
      // thumbnail on screen against an undistorted left slice in the exported SVG, which
      // is the preview-authenticity rule broken in the one place it is cheapest to keep.
      c.drawImage(bm, 0, 0, tile, h);
      el.classList.add('has-thumbs');
    };

    // The box's own background, flat across the bar. It is honest - it IS the colour
    // that box paints on the frame - and it costs one fillRect, which is why it is
    // also the UNDERLAY a node raster upgrades from (below).
    const paintFill = (): void => {
      const ctx = sized();
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = job.fill;
      ctx.fillRect(0, 0, w, h);
      // One fillRect is one <rect>. The colour is captured by value: `job.fill` is a
      // resolved colour string, and the job object is rebuilt every pass.
      const fill = job.fill;
      setTwin(() => svgDoc(w, h, rectBody(fill, w, h)));
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
    // SYNCHRONOUSLY, before any await, so there is no blank frame and - because the
    // upgrade overwrites the same canvas inside one synchronous `.then` body, and
    // `has-thumbs` is only ever added - no flash either. A declined, deferred, failed,
    // timed-out or aborted raster simply leaves the underlay standing.
    //
    // ONE bitmap, drawn ONCE: a node-mode box cannot animate by construction (any
    // <video>/<img>/Lottie/audio child would have classified it as media instead, and
    // this tool has no box nesting - an animated neighbour is a SIBLING with its own
    // bar), so N rasters would buy N identical pictures and N TILES of one raster buy
    // N identical thumbnails. This branch used to tile it like a still, which is what
    // section 8's M2.5 revision (point 4) calls clip-bar label noise: the picture repeated
    // dozens of times across a wide bar. It is drawn once now, at the leading edge,
    // over the flat fill. The trim window below is skipped for the same reason the
    // repeat is: there is no time axis here.
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
        drawSingle(ctx, bm);
        // ONLY once the raster actually landed. A declined, deferred, failed or aborted
        // shot returns above and keeps `paintFill`'s honest flat-colour twin - an export
        // must not claim a crisp walk of a box the bar never showed.
        //
        // The twin does not reuse the bitmap: it re-walks the LIVE box to real vector.
        // Only numbers survive this callback (the aspect, hence the tile advance) - 
        // the bitmap belongs to the clip-thumbs LRU and is never retained.
        const tile = stillTilePx(bm.height > 0 ? bm.width / bm.height : 0, h);
        const box = job.box;
        // The appearance this bitmap was keyed on. Re-checked at export time because a
        // twin that merely re-walks the LIVE box exports whatever the box says NOW,
        // which is not necessarily what the bar is showing: `scheduleThumbs` is
        // debounced behind `onIdle(…, 400)`, so for at least that long after an edit the
        // canvas still holds the OLD raster. Exporting in that window would emit a
        // picture the user never saw - and, because `tile` is frozen from the old
        // bitmap while the walk is sized live and stretched with
        // preserveAspectRatio="none", a box resized in that window would export
        // distorted. Mismatch ⇒ null ⇒ the PNG on screen, which is always honest.
        const sigAtPaint = job.sig;
        setTwin(async () => {
          // The stage is live and the box may have been removed, re-laid-out or hidden
          // by the clock since the shot; a detached node has no geometry to walk.
          if (!box?.isConnected) return null;
          // Recomputed from the LIVE model/style, exactly as the pass built `job.sig`.
          // Reading the theme here rather than closing over the pass's stamp is
          // deliberate: a theme flip between paint and export changes the picture too.
          const rowNow = getBoxes().find((b) => String(b?.[cfg.idField] ?? '') === job.id);
          const fillNow = getComputedStyle(box).backgroundColor || '';
          const themeNow = document.documentElement?.getAttribute('data-theme') ?? '';
          if (`${appearanceSig(rowNow, cfg)}\u0001${fillNow}\u0001${themeNow}` !== sigAtPaint) return null;
          try {
            const { renderSvgFromHtml } = await import('../bridge/export.ts');
            // LAYOUT size, not the rendered rect - the same reasoning as
            // `defaultNodeRasterer` in clip-thumbs: the stage carries the editor's zoom,
            // and sizing off the rect would walk the box at whatever magnification the
            // user happens to be at.
            const bw = Math.max(1, Number.parseFloat(box.style.width) || box.offsetWidth || 1);
            const bh = Math.max(1, Number.parseFloat(box.style.height) || box.offsetHeight || 1);
            // `.seq-off` (display:none) is on every box outside the playhead window, and
            // a walk of a display:none subtree yields nothing. withBorrowedVisibility is
            // the right lease here precisely because this caller owns the read to
            // completion - unlike captureNode, whose lease must outlive its own race.
            const blob = await withBorrowedVisibility(box, () => renderSvgFromHtml(box, { width: bw, height: bh }));
            const root = parseSvgRoot(await blob.text());
            if (!root) return null;
            // The canvas draws ONE bitmap ONCE at its own aspect over the flat fill,
            // so the vector does exactly that: the walk is sized to the tile box and
            // stretched to it (the tile advance already carries the aspect, so nothing
            // is distorted), placed once, over a rect of the same fill the canvas laid.
            root.setAttribute('width', n3(tile));
            root.setAttribute('height', n3(h));
            root.setAttribute('preserveAspectRatio', 'none');
            const inner = new XMLSerializer().serializeToString(root);
            // `tileBody` over the SINGLE-tile width: one <use>, clipped exactly where
            // the canvas's own edge cuts it. It cannot return null at one tile, but the
            // guard stays - a null twin falls through to the PNG, which is always what
            // the user is actually looking at.
            const under = isPaintedColor(job.fill) ? rectBody(job.fill, w, h) : '';
            const body = tileBody(inner, tile, Math.min(tile, w), h);
            return body === null ? null : svgDoc(w, h, under + body);
          } catch {
            return null; // any failure leaves the walker on its unmodified raster path
          }
        });
      }).catch(() => { /* clip-thumbs never rejects; belt and braces */ });
      return;
    }

    // Every remaining mode has a picture coming, so the canvas is sized now - same
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
    // (no authored dur - which is what the default music bed is, and what any box
    // promoted with only a Start becomes) has a null dur meaning "run to the end of the
    // sequence". Defaulting that to 0 collapses the window to zero width, and
    // windowPeaks correctly answers with silence - so the waveform was still drawn, but
    // flat at the 0.02 floor: a hairline that reads as no waveform at all. span() is the
    // one place that resolves the effective length, and every other geometry read in
    // this panel already goes through it.
    const eff0 = box0 ? span(box0, durationSec()) : null;
    const out0 = clipIn0 + (eff0?.dur ?? 0) * (timing0?.speed ?? 1);

    if (mode === 'waveform') {
      const buckets = Math.max(8, Math.min(600, Math.round(w / 2)));
      peaks(media.url, buckets, signal, { fromSec: clipIn0, toSec: out0 }).then((data) => {
        if (signal.aborted || !data.length) return;
        // Synchronous draw on receipt - the array is cache-owned, never mutated or kept.
        ctx.clearRect(0, 0, w, h);
        // Canvas 2D has no `currentColor` - assigning it is silently IGNORED and the
        // waveform paints default black, invisible on a dark clip. `ink` is that cascade
        // resolved to a real colour (in the read pass), so the bars follow the theme.
        ctx.fillStyle = job.ink;
        const bw = w / data.length;
        for (let i = 0; i < data.length; i++) {
          const amp = Math.max(0.02, Math.min(1, data[i]!));
          const bh = amp * (h - 4);
          ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh);
        }
        // Same bars, as one <path> of subpaths. Built SYNCHRONOUSLY, here, for the same
        // ownership reason the draw is: `data` is cache-owned, so the twin closes over
        // the finished `d` string and never over the Float32Array.
        const d = waveformPathD(data, w, h);
        const ink = job.ink;
        setTwin(() => svgDoc(w, h, `<path fill="${escXml(ink)}" d="${d}"/>`));
        el.classList.add('has-thumbs');
      }).catch(() => { /* clip-thumbs never rejects; belt and braces */ });
      return;
    }
    // One picture, TILED across the bar - an image, a Lottie's live frame, or a tool
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
        // A still is vector-expressible only when its SOURCE is vector. Numbers plus the
        // source string are all that survives the callback; the bitmap is not retained.
        const tile = stillTilePx(bm.height > 0 ? bm.width / bm.height : 0, h);
        const src = media.url;
        setTwin(async () => {
          // data: only. `inlineSvgFromImg` would happily fetch a blob:/http(s) source,
          // but the panel does no network I/O - a photograph stays a photograph, and a
          // remote SVG simply keeps the raster path, which is correct and bounded.
          if (!/^data:/i.test(src)) return null;
          try {
            const { inlineSvgFromImg } = await import('../bridge/export.ts');
            const svg = await inlineSvgFromImg(src);
            // svgMarkup is the same normaliser the live still path uses (root style
            // stripped, viewBox-or-attrs sizing, size ceiling), so screen and export
            // agree on what the source document even is.
            const markup = svg ? svgMarkup(svg) : null;
            const root = markup ? parseSvgRoot(markup) : null;
            if (!root) return null;
            // svgMarkup guarantees positive width/height attributes; a source with no
            // viewBox needs one before width/height can scale rather than crop.
            const nw = Number.parseFloat(root.getAttribute('width') || '');
            const nh = Number.parseFloat(root.getAttribute('height') || '');
            if (!(nw > 0) || !(nh > 0)) return null;
            if (!root.getAttribute('viewBox')) root.setAttribute('viewBox', `0 0 ${n3(nw)} ${n3(nh)}`);
            root.setAttribute('width', n3(tile));
            root.setAttribute('height', n3(h));
            root.setAttribute('preserveAspectRatio', 'none');
            const inner = new XMLSerializer().serializeToString(root);
            // Null when the bar would need more tiles than the vector form emits: the
            // canvas loop is uncapped, so a short run would export a bar the user sees
            // fully tiled with a blank right-hand end. The PNG is the honest answer.
            const body = tileBody(inner, tile, w, h);
            return body === null ? null : svgDoc(w, h, body);
          } catch {
            return null;
          }
        });
      }).catch(() => { /* see above */ });
      return;
    }

    if (mode !== 'filmstrip') {
      // Exhaustiveness guard. Every other mode returns above, so TypeScript narrows
      // `mode` to `never` here - which makes ADDING a ThumbMode without a branch a
      // compile error instead of a bar that silently paints nothing. That is exactly
      // how a new mode would fail: quietly, on one clip kind, in a browser only.
      const unhandled: never = mode;
      void unhandled;
      return;
    }
    filmstrip(media.url, { count: frameCountFor(w), h, clipInSec: clipIn0, clipOutSec: out0 }, signal).then((frames) => {
      if (signal.aborted || !frames.length) return;
      // OWNERSHIP CONTRACT: these ImageBitmaps belong to the clip-thumbs LRU. Draw them
      // into our own canvas right here, synchronously, and drop the references - never
      // hold one across an await or a repaint, and never close() one.
      ctx.clearRect(0, 0, w, h);
      let x = 0;
      for (const bm of frames) {
        const fw = bm.height > 0 ? (bm.width / bm.height) * h : h;
        ctx.drawImage(bm, x, 0, fw, h);
        x += fw;
        if (x >= w) break;
      }
      // No twin, deliberately: decoded video frames are photographs. There is no vector
      // form to recover, so the walker keeps rasterising this bar - which is the right
      // answer, not a gap.
      setTwin(null);
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
    // indefinitely - a thumbnail that actively lies is worse than the flat fill it
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
    // A MODEL change can move the ghosts without moving the clock (a split, a trim, a
    // reorder), and a paused timeline emits no ticks at all. Gated by the same signature
    // as the tick path, so a sync that changed nothing visible still fires nothing.
    emitTime(clock.t());
    // Re-gate the freshly-rebuilt canvas at the current playhead. A commit rebuilds the
    // tool DOM (new nodes → the sequence gate's `.seq-off` is gone), and while playback's
    // rAF loop reapplies every frame, a PAUSED timeline emits no ticks - so without this a
    // scenery→timed edit (promote, or frames-as-scenes "Place in order", whose frame pages
    // get no thumbnail shot to ride the shot-settle reapply) would leave every element on
    // screen until the next scrub. `reapply()` is one class/style pass and is exactly the
    // "canvas was rebuilt" entry point (sequence-clock.ts).
    clock.reapply();
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

  /**
   * Snap a raw time unless Alt is held (the universal bypass).
   *
   * `coarse` is EXPLICIT rather than read off `gesture` at every call site, because the
   * one call that decides what gets written - onPointerUp's - runs AFTER endGesture has
   * already cleared `gesture`. Defaulting it off the live gesture and letting pointerup
   * pass the value it captured is what keeps the committed number identical to the
   * preview the user was looking at; reading it lazily meant a finger's drag previewed
   * at the 12px tolerance and then committed at 8, i.e. snapped on screen and landed off
   * the cut.
   */
  /**
   * The keyframes of the SELECTED boxes, as timeline seconds - the latch's own
   * candidates (plans/104 section 8).
   *
   * Selected only, and that is the whole design: a timeline with six animated clips
   * has dozens of diamonds, and snapping to all of them would make the playhead
   * unplaceable. Selecting a clip is how you say "this is the one I am posing", and
   * the latch follows that declaration rather than guessing from proximity.
   */
  function latchCandidates(boxes: Box[]): number[] {
    if (!cfg.kfField) return [];
    const out: number[] = [];
    for (const id of selection.get()) {
      const i = indexOfId(boxes, cfg, id);
      if (i >= 0) out.push(...kfDiamondTimes(boxes[i]!, cfg));
    }
    return out;
  }

  function maybeSnap(
    raw: number,
    alt: boolean,
    excludeId?: string,
    coarse: boolean = isCoarsePointer(gesture?.pointerType),
    latch = false,
  ): number {
    if (!snapOn || alt) { showSnapline(null); snappedAt = null; return raw; }
    const boxes = getBoxes();
    const cands = snapCandidates(boxes, cfg, clock.t() / 1000, raw, excludeId);
    // The playhead latches onto diamonds; a CLIP being dragged does not. A clip's
    // edges snap to structure (cuts, the ruler's seconds, the playhead) - adding
    // another clip's keyframes to that set would make a move jump to a mark that has
    // nothing to do with where the clip belongs.
    if (latch) cands.push(...latchCandidates(boxes));
    // A finger cannot land on an 8px window. The tolerance follows the pointer that
    // started the gesture (timeline-math's own SNAP_PX default stays 6 for every other
    // caller - this panel is the only one that knows what started the drag).
    const px = coarse ? SNAP_PX_COARSE : SNAP_PX_FINE;
    const r = snapTime(raw, cands, pxPerSec, px);
    showSnapline(r.snapped);
    // Newly engaged, on a pointer with no cursor to watch: an 8ms tick is the only
    // feedback a thumb over the bar can actually receive. Gated on the LIVE gesture, not
    // on `coarse`: the haptic belongs to the drag, and firing it again from pointerup
    // (where endGesture has just reset snappedAt, so every snap reads as new) would tick
    // twice for one snap. Reduced motion turns it off - the pref is about involuntary
    // sensation, not only about pixels moving.
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
   * The three edge states, armed. Every class added here comes off in endGesture - the
   * single teardown - and never at a call site, matching the `is-drop-target` discipline.
   */
  /** A drag has to travel this far vertically before it reads as a lane change. */
  const LANE_DRAG_PX = 14;
  /** Pointer within this of a row boundary reads as the GAP, not the row. */
  const LANE_EDGE_PX = 6;

  function clearLaneDropPaint(): void {
    for (const el of laneWrap.querySelectorAll('.is-drop-target')) el.classList.remove('is-drop-target');
  }

  /**
   * The vertical half of an overlay bar drag (plans/165 Slice C-tracks): resolve
   * which lane row (or gap between rows) the pointer is over, remember it on the
   * gesture for pointerup, and paint the drop row. Rows render top = frontmost, so
   * a gap maps to "directly behind the row above it" and the top gap to "in front
   * of everything" - the LaneDrop vocabulary restackOverlay speaks. Row
   * geometry is cached at the first vertical breach: rows do not move during a
   * drag (the dragged bar previews via transform, which never reflows).
   */
  function resolveLaneDrop(g: Gesture): void {
    const originRow = g.el?.closest<HTMLElement>('.tl-lane');
    if (!originRow || originRow.dataset.lane !== 'overlay') return;   // seq bars have their own reorder
    if (!g.laneRects) {
      if (Math.abs(g.y - g.y0) < LANE_DRAG_PX) return;
      g.laneRects = Array.from(laneWrap.querySelectorAll<HTMLElement>('.tl-lane[data-lane="overlay"]')).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          el,
          anchor: el.dataset.anchor || '',
          members: Array.from(el.querySelectorAll<HTMLElement>('.tl-clip')).map((b) => b.dataset.id || ''),
          top: r.top,
          bottom: r.bottom,
        };
      });
    }
    const rows = g.laneRects;
    let drop: LaneDrop | null = null;
    let hover: HTMLElement | null = null;
    const y = g.y;
    // A gap drop references a ROW - but never the dragged bar itself (leaving a
    // shared row would otherwise resolve to a self-target, which restackOverlay
    // reads as identity and the drag silently does nothing). Substitute the row's
    // next member; a row the drag is the sole member of has no reference to give.
    const refFor = (r: { anchor: string; members: string[] }): string | null =>
      (r.anchor !== g.id ? r.anchor : r.members.find((m) => m && m !== g.id) ?? null);
    const over = rows.find((r) => y >= r.top + LANE_EDGE_PX && y <= r.bottom - LANE_EDGE_PX);
    if (over && over.el !== originRow && over.anchor && over.anchor !== g.id) {
      drop = { onto: over.anchor };
      hover = over.el;
    } else if (!over && rows.length) {
      const belowIdx = rows.findIndex((r) => y < r.top + LANE_EDGE_PX);
      if (belowIdx === 0) drop = { before: null };                       // above the top row
      else if (belowIdx > 0) {
        const ref = refFor(rows[belowIdx - 1]!);                          // between two rows
        drop = ref ? { before: ref } : null;
      } else if (y > rows[rows.length - 1]!.bottom - LANE_EDGE_PX && y < rows[rows.length - 1]!.bottom + 24) {
        const ref = refFor(rows[rows.length - 1]!);                       // just under the bottom row
        drop = ref ? { before: ref } : null;
      }
    }
    g.laneDrop = drop;
    clearLaneDropPaint();
    if (hover) hover.classList.add('is-drop-target');
  }

  function beginTrimChrome(g: Gesture): void {
    if (!g.el) return;
    g.el.classList.add('is-trimming');
    edgeEl(g.el, g.edge)?.classList.add('is-active');
    // The badge's VERTICAL place is fixed for the gesture - a trim never moves a bar
    // between lanes - so it is measured once here rather than per frame. Reading
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
   * Only when the media length is known - a card, a Lottie or a procedural bed has no
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
      const at = maybeSnap(timeAt(e.clientX), e.altKey, undefined, undefined, true);
      seekAuthored(at * 1000, { scrubbing: true });
      beginGesture(e, { kind: 'seek', id: '', el: ruler, x0: e.clientX, y0: e.clientY, start0: 0, dur0: 0, index0: 0, index: 0, h0: panelH });
      return;
    }

    const barEl = target.closest<HTMLElement>('.tl-clip');
    if (!barEl) {
      // Empty lane space inside the tracks scroller → rubber-band select. The ruler,
      // handle and chrome were all handled above, so this is genuinely empty timeline.
      if (target.closest('.tl-tracks')) {
        e.preventDefault();
        const additive = e.shiftKey || e.metaKey || e.ctrlKey;
        if (!additive) selectAndReveal([], { reveal: false });
        marquee.hidden = false;
        drawMarquee(e.clientX, e.clientY, e.clientX, e.clientY);
        beginGesture(e, { kind: 'marquee', id: '', el: tracks, x0: e.clientX, y0: e.clientY, start0: 0, dur0: 0, index0: 0, index: 0, h0: panelH, additive });
      }
      return;
    }
    const id = barEl.dataset.id || '';
    if (!id) return;
    e.preventDefault();

    // Selection follows the press (Shift toggles), so the canvas chrome tracks the bar.
    const cur = selection.get();
    // A plain press on a clip that is ALREADY part of a multi-selection keeps the whole
    // set, so the press can drag the group; a click that never moves collapses to this
    // one clip on release (collapseOnClick), the standard NLE behaviour.
    const inMulti = cur.length > 1 && cur.includes(id);
    // Shift-extend never reveals: with two clips selected there is no single one to
    // put the picture on, and moving it out from under the first is a worse answer.
    if (e.shiftKey) selectAndReveal(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id], { reveal: false });
    else if (inMulti) { /* keep the multi-selection; group-drag or collapse-on-click below */ }
    else {
      // A/V-linked pair: pressing either half selects both, so a move or a delete keeps
      // picture and sound together. Alt selects just the one - the shell's established
      // "solo this box" idiom, and the reason there is no global "linked selection"
      // toggle to find and remember.
      const partner = e.altKey ? '' : partnerOf(id);
      selectAndReveal(partner ? [id, partner] : [id]);
    }
    const groupIds = selection.get();
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

    // A DIAMOND under the pointer - checked after the trim zone and before move, in
    // that order and deliberately. A keyframe at local t = 0 sits exactly on the
    // in-edge, and a clip you cannot trim because its first pose is parked there
    // would be a worse trade than a first pose you retime from the inspector's list
    // (which is where every diamond is reachable anyway, and the same trade the
    // `is-tight` rule already makes for the whole strip).
    const dot = target.closest<HTMLElement>('.tl-kf-dot');
    const dotT = dot ? finite(dot.dataset.t, NaN) : NaN;
    if (dot && cfg.kfField && Number.isFinite(dotT)) {
      beginGesture(e, { ...base, kind: 'kf', index0: 0, index: 0, kfT0: dotT, kfDot: dot });
      return;
    }
    if (lane === 'seq') {
      const order = seqBoxes(boxes, cfg).map((b) => String(b[cfg.idField] ?? ''));
      const idx = order.indexOf(id);
      beginGesture(e, { ...base, kind: 'reorder', index0: idx, index: idx, groupIds, collapseOnClick: inMulti });
      return;
    }
    beginGesture(e, { ...base, kind: 'move', index0: 0, index: 0, groupIds, collapseOnClick: inMulti });
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
   * The panel's non-track chrome - grip + bar + ruler - MEASURED rather than derived
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

  /** Position the rubber band in timeline-content pixels (it lives inside `inner`, so
   *  it scrolls with the bars). Client coords in, content coords out. */
  function drawMarquee(x0: number, y0: number, x1: number, y1: number): void {
    const rect = tracks.getBoundingClientRect();
    marquee.style.left = `${Math.min(x0, x1) - rect.left + tracks.scrollLeft}px`;
    marquee.style.top = `${Math.min(y0, y1) - rect.top + tracks.scrollTop}px`;
    marquee.style.width = `${Math.abs(x1 - x0)}px`;
    marquee.style.height = `${Math.abs(y1 - y0)}px`;
  }

  /** Select every clip bar whose box intersects the marquee (client-rect test - the
   *  same viewport coords the drag captured). Additive drags union with the selection. */
  function commitMarquee(g: Gesture): void {
    const rx0 = Math.min(g.x0, g.x), rx1 = Math.max(g.x0, g.x);
    const ry0 = Math.min(g.y0, g.y), ry1 = Math.max(g.y0, g.y);
    const hits: string[] = [];
    for (const [id, node] of bars) {
      const r = node.getBoundingClientRect();
      if (r.right >= rx0 && r.left <= rx1 && r.bottom >= ry0 && r.top <= ry1) hits.push(id);
    }
    const base = g.additive ? selection.get() : [];
    selectAndReveal(Array.from(new Set([...base, ...hits])), { reveal: false });
    if (hits.length) announce(t('{count} clips selected', { count: hits.length }));
  }

  /** Live preview - PANEL DOM ONLY. The model is untouched until pointerup. */
  function paintGesture(g: Gesture): void {
    if (g.kind === 'marquee') { drawMarquee(g.x0, g.y0, g.x, g.y); return; }
    if (g.kind === 'resize') {
      const stageH = stageEl.getBoundingClientRect().height || 0;
      panelH = clampPanelH(g.h0 + (g.y0 - g.y), stageH, chromeH());
      root.style.height = `${panelH}px`;
      reserve(panelH + RESERVE_PAD);
      return;
    }
    if (g.kind === 'seek') {
      const at = maybeSnap(timeAt(g.x), g.alt, undefined, undefined, true);
      seekAuthored(at * 1000, { scrubbing: true });
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
    // jumping on release) is free here - the throwaway array already holds their new
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
    if (g.kind === 'kf') {
      // PANEL DOM ONLY, like every other preview here: the dot moves, the model does
      // not. Alt is the DUPLICATE modifier on this gesture (it is the drag's own
      // meaning, not a snap bypass - a keyframe snaps to nothing), so the class says
      // so while the pointer is down and the copy is made once, on release.
      const dot = g.kfDot;
      if (!dot) return;
      const to = kfSlideMs(g.kfT0 ?? 0, deltaSec, g.dur0);
      dot.style.left = `${timeToPx(kfLocalSec(to), pxPerSec)}px`;
      dot.classList.toggle('is-duplicating', g.alt);
      return;
    }
    if (g.kind === 'move') {
      if (g.groupIds && g.groupIds.length > 1) { previewRows(moveOverlays(getBoxes(), cfg, g.groupIds, deltaSec)); return; }
      previewRows(moveOverlay(getBoxes(), cfg, g.id, maybeSnap(g.start0 + deltaSec, g.alt, g.id)));
      resolveLaneDrop(g);
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
      // THE LIMIT SIGNAL. Requested vs achieved, using the writer's OWN answer - no
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
        // rather than by the file reports through the same pair - the visual signal is
        // exactly right either way, and these are the nearest true words we have.)
        announce(achievedD > d ? t('Start of the source') : t('End of the source'));
      }
      const at = g.edge === 'in' ? achieved.start : achieved.start + achieved.dur;
      paintTrimBadge(g, at, achieved.dur);
      return;
    }
    if (g.kind === 'reorder') {
      if (g.groupIds && g.groupIds.length > 1) {
        // A group of seq clips: preview the whole block repacking into place (the same
        // "downstream bars move with the drag" style as move/trim), rather than lifting
        // one bar. The index is measured against the row WITHOUT any moving clip.
        g.index = groupDropIndex(getBoxes(), cfg, timeAt(g.x), g.groupIds);
        previewRows(moveSeqClips(getBoxes(), cfg, g.groupIds, g.index, mediaDur));
        return;
      }
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
   * THE one teardown for a gesture, whatever ended it - pointerup, pointercancel, a
   * lost capture, or the panel closing under a drag. Every transient the gesture
   * painted is cleared HERE, so no exit path can leak one:
   *   • `is-drop-target` lives on OTHER bars, and a reorder does not change tracksKey,
   *     so a rebuild will never clean it up - a stale ring would sit on a clip for the
   *     rest of the session;
   *   • the dragged bar's lift transform and dropIndex;
   *   • the three trim states (`is-trimming` on the bar, `is-active`/`is-limit` on the
   *     edge), the readout badge and the ghost extent - added in beginTrimChrome and
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
      // The dragged diamond's alt cue. Cleared HERE with everything else, so an
      // Escape mid-drag cannot strand a dot painted as "about to be copied".
      g.kfDot?.classList.remove('is-duplicating');
    }
    for (const node of bars.values()) node.classList.remove('is-drop-target', 'is-trimming');
    for (const e of Array.from(laneWrap.querySelectorAll<HTMLElement>('.tl-edge'))) {
      e.classList.remove('is-active', 'is-limit');
    }
    trimBadge.hidden = true;
    extent.hidden = true;
    marquee.hidden = true;
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

    // Rubber-band select: hit-test the bars against the final rect. A drag that never
    // moved (a click on empty space) already cleared the selection at pointerdown.
    if (g.kind === 'marquee') { marquee.hidden = true; if (g.moved) commitMarquee(g); sync(); scheduleThumbs(); return; }

    // These two branches write nothing to the model, so they must run the sync a
    // mid-gesture model change (a sidebar edit made while scrubbing) never got.
    if (g.kind === 'resize') { reserve(panelH + RESERVE_PAD); sync(); scheduleThumbs(); return; }
    // `gesture` is already null (endGesture, above), so every maybeSnap below has to be
    // told what kind of pointer this was - see maybeSnap's own note.
    const coarse = isCoarsePointer(g.pointerType);
    if (g.kind === 'seek') { const at = maybeSnap(timeAt(g.x), g.alt, undefined, coarse, true); seekAuthored(at * 1000); sync(); scheduleThumbs(); return; }
    // A diamond PRESSED and released without moving is a click, and a click on a
    // keyframe opens the Keyframes popup ON it (section 8's M2.7 (a): "selection + popup in
    // one gesture"). Before the `!g.moved` return below, because that one is the
    // "nothing happened" path and this is the one gesture where nothing MOVING is
    // itself the intent.
    if (g.kind === 'kf' && !g.moved) { openKeyframeAt(g.id, g.kfT0 ?? 0); sync(); scheduleThumbs(); return; }
    // A plain click (no move) on a clip that was part of a multi-selection collapses to
    // just that clip - the standard "click one of a selection" behaviour.
    if (!g.moved) { if (g.collapseOnClick) selectAndReveal([g.id]); sync(); scheduleThumbs(); return; }

    // ── the ONE model write of the gesture ────────────────────────────────────
    const boxes = getBoxes();
    const deltaSec = pxToTime(g.x - g.x0, pxPerSec);
    const alt = e.altKey || g.alt;
    if (g.kind === 'kf') {
      // ONE commit on release, whichever it was: a retime REPLACES anything already
      // parked at the destination (the wire cannot hold two poses at one instant),
      // an alt-drag leaves the original where it was and copies it.
      const from = g.kfT0 ?? 0;
      const to = kfSlideMs(from, deltaSec, g.dur0);
      if (to !== from) {
        const j = indexOfId(boxes, cfg, g.id);
        const at = j >= 0 ? fmtTime(kfTimelineSec(boxes[j]!, cfg, to)) : '';
        writeTrack(g.id, (track) => (alt ? kfTrackDuplicate(track, from, to) : kfTrackRetime(track, from, to)));
        announce(alt ? t('Keyframe copied to {t}', { t: at }) : t('Keyframe moved to {t}', { t: at }));
      } else {
        // Nothing landed, so nothing was written - but the dot has been dragged and
        // must go back to where the model still says it is.
        scheduleSync();
      }
      scheduleThumbs();
      return;
    }
    if (g.kind === 'move') {
      if (g.groupIds && g.groupIds.length > 1) {
        // Batch overlay move: one write, one undo step. moveOverlays shifts every
        // selected overlay by the same clamped delta and ignores seq/unselected members.
        write(moveOverlays(boxes, cfg, g.groupIds, deltaSec));
        announce(t('{count} clips moved', { count: g.groupIds.length }));
        clearLaneDropPaint();
        showSnapline(null); scheduleThumbs();
        return;
      }
      // moveOverlay owns the clamp AND the ms rounding, so a drag and the inspector's
      // Start field land on exactly the same value for the same time.
      let next = moveOverlay(boxes, cfg, g.id, maybeSnap(g.start0 + deltaSec, alt, g.id, coarse));
      // The drag's vertical half: restack against the row under the drop (or between).
      // ONE write for both halves, so the whole drop is one undo step; identity from
      // restackOverlay means a wobble that went nowhere costs nothing extra.
      if (g.laneDrop) {
        const dropped = restackOverlay(next, cfg, g.id, g.laneDrop);
        if (dropped !== next) {
          next = dropped;
          announce('onto' in g.laneDrop
            ? tRaw('Now sharing a layer with {name}', { name: labelFor(g.laneDrop.onto) })
            : t('Layer order changed'));
        }
      }
      clearLaneDropPaint();
      write(next);
    } else if (g.kind === 'trim') {
      const raw = g.edge === 'in' ? g.start0 + deltaSec : g.start0 + g.dur0 + deltaSec;
      const snapped = maybeSnap(raw, alt, g.id, coarse);
      const d = g.edge === 'in' ? snapped - g.start0 : snapped - (g.start0 + g.dur0);
      const next = trimClip(boxes, cfg, g.id, g.edge ?? 'out', d, mediaOf(g.id).dur, mediaDur);
      write(next);
      // The badge was aria-hidden throughout (sixty updates a second is not speech);
      // this is its ONE spoken form, and it reports what actually landed, not what was
      // asked for - so a drag the media refused says so by simply reading back short.
      const j = indexOfId(next, cfg, g.id);
      if (j >= 0) {
        const now = span(next[j]!, durationSec()).dur;
        announce(tRaw('{name}: {dur}, trimmed {delta}', {
          name: labelFor(g.id), dur: fmtDur(now), delta: fmtDelta(now - g.dur0),
        }));
      }
    } else if (g.kind === 'reorder') {
      // Re-derive from the FINAL pointer position rather than trusting g.index: that one
      // is written by paintGesture, which is rAF-coalesced, so the last pointermove of a
      // fast drag may never have painted. Same discipline as move/trim above - pointerup
      // never depends on whether a frame ran.
      if (g.groupIds && g.groupIds.length > 1) {
        const index = groupDropIndex(boxes, cfg, timeAt(g.x), g.groupIds);
        write(moveSeqClips(boxes, cfg, g.groupIds, index, mediaDur));
        announce(t('{count} clips moved', { count: g.groupIds.length }));
      } else {
        const index = dropIndexAt(boxes, cfg, timeAt(g.x), g.id);
        if (index !== g.index0) write(moveSeqClip(boxes, cfg, g.id, index, mediaDur));
        else sync();
      }
    }
    showSnapline(null);
    scheduleThumbs();
  }

  function onPointerCancel(): void {
    if (!gesture) return;
    const g = gesture;
    clearLaneDropPaint();
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

  /**
   * Is `at` a place this box could actually be CUT? Deliberately the same predicate
   * splitBox uses (timeline-math), not a plain "inside the span" test:
   *
   *   - an open-ended clip resolves its end against the SEQUENCE's (splitBox is handed
   *     `durationSec()` for exactly this) - the same start..total window span() gives it;
   *   - splitBox refuses within MIN_DUR of either edge rather than mint a sliver,
   *     and at any zoom past ~80 px/s the snap tolerance is smaller than MIN_DUR, so the
   *     playhead can rest inside that band without being pulled onto the cut.
   *
   * A mismatch here used to read as "Split clip", enabled - and then announce a refusal
   * on the press. The label cannot promise what the press refuses, so it asks the same
   * question.
   */
  function spanContains(b: Box, at: number, total = durationSec()): boolean {
    if (!b || !isTimed(b, cfg)) return false;
    // An open-ended clip splits against the SEQUENCE's end now (splitBox takes the
    // total for exactly this), so it is in scope whenever its effective span - which
    // span() already resolves to start..total - contains the cut.
    const { start, dur } = span(b, total);
    return at > start + MIN_DUR && at < start + dur - MIN_DUR;
  }

  /**
   * SPLIT - one operation, four doors (the toolbar blade, `s`, the context menu, and
   * the blade's own LABEL, which has to answer the same question a press would) and one
   * scope rule shared by all of them. Resolved here, once, so the label can never
   * promise something the press then refuses.
   *
   * Scope, in the order Premiere and Descript both resolve it:
   *   1. every SELECTED clip the playhead is inside - so a deliberate multi-selection
   *      cuts through all of it in one press, and one undo takes the whole thing back;
   *   2. failing that, the seq clip under the playhead - the "I just want to cut here"
   *      case, which must not require selecting anything first;
   *   3. failing that, say so and write nothing.
   *
   * `everything: true` is the Shift+S variant: every timed clip the playhead is inside,
   * on every lane, IGNORING the selection.
   *
   * The cut is SNAPPED first, so a press within a few pixels of an existing edit lands
   * exactly on it and then fails the "already at a cut" test as an equality rather than
   * a float comparison (Premiere's razor snaps for the same reason).
   */
  function splitScope(everything = false, boxes: Box[] = getBoxes()): { at: number; ids: string[] } {
    const total = durationSec();
    // Snap BEFORE deciding scope: the snapped instant is the one the cut is tested
    // against, so "inside this clip" and "where the cut lands" can never disagree.
    //
    // NOT through maybeSnap - the playhead is one of its own candidates, so snapping
    // the playhead would always find itself at distance 0 and change nothing. Passing a
    // negative playhead drops that candidate (snapCandidates guards on `ph >= 0`) and
    // leaves the clip edges and whole seconds, which is exactly what a razor should
    // land on. It also draws no snapline: there is no drag here to give feedback about.
    const raw = clock.t() / 1000;
    const at = snapOn
      ? snapTime(raw, snapCandidates(boxes, cfg, -1, raw), pxPerSec, SNAP_PX_FINE).t
      : raw;
    let ids: string[];
    if (everything) {
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
    return { at, ids: ids.filter(Boolean) };
  }

  /**
   * The blade says what it would cut BEFORE it is pressed - the researched
   * self-teaching affordance, and the one that makes the scope rule above learnable
   * instead of surprising: "Split clip" when the playhead is inside one, "Split 3
   * clips" when a selection spans it, and disabled (not a refusal announced after the
   * press) when there is nothing under the playhead at all.
   *
   * Disabled is decided by the UNION of both scopes, because Shift-click is the
   * split-everything door: a playhead inside an overlay but no seq clip still has work
   * to do, and a disabled button would swallow that press. The LABEL stays the plain
   * scope's - it describes what an unmodified click does.
   *
   * `aria-disabled`, NOT the `disabled` property. A successful split leaves the playhead
   * exactly on the cut it just made, so both scopes resolve empty on the very next
   * restyle - i.e. the blade goes inert the instant you use it. Per the HTML spec a
   * FOCUSED control that becomes `disabled` is no longer focusable and the browser drops
   * focus to <body>; this panel's keydown listener is bound on `root` and gated by
   * panelKeysActive, so a keyboard user who pressed Enter on the blade would silently
   * lose every panel shortcut. aria-disabled keeps the element focusable and announced
   * as unavailable; the click handler swallows the press, and `.tl-btn[aria-disabled]`
   * carries the same greying as `:disabled`.
   */
  let splitBtnKey = '\u0000';
  function syncSplitBtn(): void {
    const boxes = getBoxes();
    const n = splitScope(false, boxes).ids.length;
    // Disabled is decided by the UNION of both scopes; the label is the plain scope's.
    const off = n === 0 && splitScope(true, boxes).ids.length === 0;
    // The memo is on the ACHIEVED state, not on the playhead: this runs once per tick
    // (see emitTime - the splittable set changes one frame AFTER the active set does,
    // when the playhead steps off a clip's exact start, so it cannot ride tl-time's own
    // gate), and the DOM must not be written sixty times a second for a label that
    // changes twice a sequence.
    const key = `${n}|${off ? 1 : 0}`;
    if (key === splitBtnKey) return;
    splitBtnKey = key;
    const label = n === 0 ? t('Split at playhead')
      : n === 1 ? t('Split clip')
        : t('Split {n} clips', { n: String(n) });
    splitBtn.setAttribute('aria-label', label);
    splitBtn.setAttribute('data-tip', label);
    splitBtn.setAttribute('aria-disabled', off ? 'true' : 'false');
  }

  /**
   * Cut, once, at the resolved instant. `splitAll` returns the input array by IDENTITY
   * when nothing landed, so a no-op costs no commit and no undo entry at all; a
   * multi-clip cut composes on one intermediate array and writes once, so it is one
   * undo step however many clips it touched.
   */
  function splitAtPlayhead(opts?: { everything?: boolean }): void {
    const boxes = getBoxes();
    const { at, ids } = splitScope(!!opts?.everything, boxes);
    if (!ids.length) { announce(t('Move the playhead inside a clip to split it')); return; }
    const { next, split } = splitAll(boxes, cfg, ids, at, mintId, durationSec());
    // Identity, not deep equality: nothing was cut, so nothing is written and the undo
    // stack is untouched. The commonest way here is a second press at the same instant.
    if (next === boxes) { announce(t('The playhead is already at a cut')); return; }
    write(next);
    // Select the right-hand halves - what you carry on editing after a cut is the part
    // ahead of the playhead, and the panel's one selection writer keeps it on screen.
    // Focus moves WITH the selection: trimTargetId prefers focusedId, and leaving it
    // on the left half sent the next keyboard edit (Shift+D, [/]/e) at a clip other
    // than the one painted selected.
    if (split.length) { focusedId = split[0]!; selectAndReveal(split); }
    announce(split.length > 1 ? t('Split {n} clips', { n: String(split.length) }) : t('Clip split'));
  }

  // ── Export frame: a native-resolution PNG of the frame under the playhead ────

  /** May "Export frame" be offered for this box? Video only - a still/audio/lottie
   *  has no per-instant frame to grab. */
  function canExportFrame(id: string): boolean {
    return !!id && mediaOf(id).kind === 'video';
  }

  /**
   * Decode the frame under the playhead from the clip's ORIGINAL asset at the media's
   * own native resolution (never a downscaled preview surface), save it as a new
   * user-catalog asset, and hand the same bytes
   * to the browser's download flow. `mediaOf(id).url` is read straight off the
   * mounted `<video>` element's `currentSrc`/`src`, which - by the same invariant
   * that keeps every OTHER export path honest (see bridge/export.ts and
   * sequence-render.ts's own header) - is never swapped to a proxy: only
   * lib/clip-thumbs.ts's OWN filmstrip/waveform capture ever resolves one, which is
   * exactly why this calls `frameAt` and not `filmstrip`.
   */
  async function exportFrameAt(id: string): Promise<void> {
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0) return;
    const media = mediaOf(id);
    if (media.kind !== 'video' || !media.url) {
      announce(t('This clip has no video frame to export'));
      return;
    }
    const timing = boxTiming(rows[i]!, cfg);
    const start = timing.start ?? 0;
    const speed = timing.speed ?? 1;
    // The bar's own local-time mapping (clipIn plus elapsed playhead time, scaled by
    // speed) - the same arithmetic `out0` uses above to bound a filmstrip's window.
    const localSec = timing.clipIn + Math.max(0, clock.t() / 1000 - start) * speed;
    announce(t('Capturing frame…'));
    const bitmap = await frameAt(media.url, localSec);
    if (!bitmap) { announce(t('Could not capture that frame')); return; }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      try { bitmap.close?.(); } catch { /* already gone */ }
      announce(t('Could not capture that frame'));
      return;
    }
    ctx.drawImage(bitmap, 0, 0);
    try { bitmap.close?.(); } catch { /* already gone */ }
    const rawBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!rawBlob) { announce(t('Could not capture that frame')); return; }

    // Provenance: extracting a frame invents no pixels, so this is a c2pa.edited
    // step - never a generated-content claim - and the clip's own source asset is
    // kept as an ingredient when its bytes carry a credential. This is a plain,
    // editor-initiated derived asset (not a `renders` output), so it is left
    // UNTAGGED. Never blocks the save: both the ingredient read and the stamp are
    // try/catch, exactly like the Matte and Upscale dialogs' own save path.
    let blob = rawBlob;
    try {
      const [{ stampDerivedC2pa }, { extractC2paStore, prepareC2paIngredientFromStore }] = await Promise.all([
        import('../bridge/export.ts'), import('@lolly/engine'),
      ]);
      const ingredient = await (async () => {
        try {
          const srcBytes = new Uint8Array(await (await fetch(media.url)).arrayBuffer());
          const ex = extractC2paStore(srcBytes);
          return ex ? prepareC2paIngredientFromStore(ex.store, ex.format) : null;
        } catch {
          return null; // source bytes unreachable - export continues without an ingredient
        }
      })();
      blob = await stampDerivedC2pa(host as unknown as HostV1, rawBlob, 'png', {
        title: 'Exported frame',
        tool: 'Sequence editor',
        actions: [{ action: 'c2pa.edited', description: 'Frame extracted from a video clip' }],
        ...(ingredient ? { ingredients: [ingredient] } : {}),
        dimensions: `${canvas.width}×${canvas.height}`,
      });
    } catch (e) {
      host.log?.('warn', `Export frame: provenance stamp failed - ${e instanceof Error ? e.message : String(e)}`);
    }

    const now = Date.now();
    const filename = `frame-${now}.png`;
    try {
      await host.assets?._uploadUserAsset?.({
        id: `user/frame/${now}`, type: 'raster', format: 'png', blob, version: '1.0.0',
        width: canvas.width, height: canvas.height,
        meta: { name: filename, bytes: blob.size },
      });
    } catch (e) {
      host.log?.('warn', `Export frame: save failed - ${e instanceof Error ? e.message : String(e)}`);
    }
    await host.export?.download?.(blob, filename);
    announce(t('Frame exported'));
  }

  // ── Remove background: a transparent alternative for a video clip's source ────

  /** May "Remove background…" be offered for this box? A video clip the browser can
   *  decode (WebCodecs) - the same video-matte gate the catalog detail modal (WP-G) uses.
   *  The dialog offers the on-device model (if staged) AND the model-free colour key, so a
   *  staged model is NOT required. Absent (never greyed) otherwise, like Export frame. */
  function canVideoMatte(id: string): boolean {
    return !!id
      && mediaOf(id).kind === 'video'
      && typeof (window as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined';
  }

  /**
   * Open the shared video-job dialog (op 'matte') on this clip's ORIGINAL source video.
   * The source is resolved via refOf(id) - the box's persisted asset ref - and re-fetched
   * by its permanent id (fresh object URL + full meta), NEVER the scrub proxy: the same
   * original-asset rule Export frame follows above, for the same reason (a proxy is a
   * lossy downscaled re-encode). The dialog starts a WP-F background job and closes; the
   * transparent asset lands in the user catalog when it finishes.
   *
   * We CREATE the asset; the follow-on track swap is left to the user. A "replace this
   * clip's source" write is deliberately NOT wired here: the box's asset-field name and
   * shape are the tool's own, and a video→transparent-WebP swap changes the media KIND
   * (a still animated raster, no per-clip timing/audio) - not a safe, general edit for
   * the panel to make blind. Creating the asset (and letting the user swap it in from the
   * asset picker) is the honest, non-destructive half.
   */
  async function videoMatteAt(id: string): Promise<void> {
    if (!canVideoMatte(id)) { announce(t('This clip has no video to process')); return; }
    const ref = refOf(id);
    const refId = typeof ref?.id === 'string' ? ref.id : '';
    // Re-resolve the ORIGINAL asset by its permanent id - the box's stored ref, never a
    // proxy - exactly like the subtitle path (wordsForBox) does.
    let source: AssetRef | null = null;
    if (refId && host.assets?.get) {
      try { source = await host.assets.get(refId); } catch { /* resolve failed → bail below */ }
    }
    if (!source) { announce(t('Couldn’t find this clip’s source video')); return; }
    const sourceName = (source.meta?.name as string | undefined) ?? source.id;
    const ai = source.meta?.aiGenerated;
    try {
      const { openVideoJobDialog } = await import('./video-job-dialog.ts');
      await openVideoJobDialog(host as unknown as VideoJobHost, {
        op: 'matte', source, sourceName,
        ...(ai === 'full' || ai === 'partial' ? { aiGeneratedSource: ai } : {}),
      });
    } catch (err) {
      host.log?.('error', `Remove background: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── A/V link: detach audio, re-attach, and the through-edit join ─────────────
  //
  // Detach is deliberately NOT Final Cut's: theirs is one-way, and "there's no way to
  // resync a clip, except for Undo" is the single most-cited complaint in the survey.
  // This is the Premiere/Resolve model - a persistent link, written on BOTH boxes, so
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
   *   • the TOOL declares a link sub-field (sequence-studio does; design does
   *     not, and gets no affordance at all rather than a broken one);
   *   • the tool has an `audio` add-kind - the vocabulary a detached sound is born into,
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
   * what an asset is. Compared on the ref's ID (its identity), never the whole object - 
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
    // through edits joins forwards - the direction the playhead is travelling.
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

  /**
   * Ids are the tool's contract; mint one that cannot collide with an existing row.
   *
   * `rows` is the array to mint AGAINST - defaulted to the live model, but passed
   * explicitly by any caller composing several writes into one commit (the implicit
   * scene camera), where the live model does not yet contain the boxes already minted
   * into the pending array.
   */
  function mintId(rows: Box[] = getBoxes()): string {
    const used = new Set(rows.map((b) => String(b?.[cfg.idField] ?? '')));
    let n = used.size + 1;
    let id = `b${n}`;
    while (used.has(id)) { n++; id = `b${n}`; }
    return id;
  }

  /**
   * Remove one box, rippling the row behind it. `target` names it (the context menu);
   * with no argument it is the focused/selected bar (the Delete key). Scenery is
   * deletable too - it has a chip rather than a bar, and no reason to be undeletable.
   */
  /**
   * Delete one half of an A/V pair and the other half is left holding a link to an id
   * that no longer exists. `partnerOf` reads a dangling id as '' (so Detach is offered
   * again, and then refuses - `detachAudio` re-reads the raw field and returns null),
   * while the bar paint reads the RAW field and keeps the link chip: the two disagree
   * about whether the clip is linked, and the picture is left silent with nothing in the
   * panel saying why. So the delete sweeps the link off every survivor pointing at the
   * clip that went - and un-mutes it too when it was MUTED, because the only reason it
   * was silent was that its sound lived on the clip just deleted.
   */
  function sweepLinksTo(rows: Box[], goneId: string): Box[] {
    const link = cfg.linkField;
    if (!link || !goneId) return rows;
    let touched = false;
    const out = rows.map((b) => {
      if (!b || String(b[link] ?? '') !== goneId) return b;
      touched = true;
      const muted = b[cfg.muteField] === true || b[cfg.muteField] === 'true';
      return muted ? { ...b, [link]: '', [cfg.muteField]: '' } : { ...b, [link]: '' };
    });
    // Identity when nothing was linked: the commonest delete by far, and it must not
    // look like a change to anything downstream that compares by reference.
    return touched ? out : rows;
  }

  function deleteBox(target?: string): void {
    const id = target || focusedId || selection.get()[0] || '';
    if (!id || !(bars.has(id) || chips.has(id))) return;
    // Hand focus to a neighbour rather than nowhere: `updateRovingTabindex` re-picks
    // when the id is gone, and rebuild() restores focus onto whatever it picked.
    const order = Array.from(bars.keys());
    const at = order.indexOf(id);
    if (at >= 0) focusedId = order[at + 1] || order[at - 1] || '';
    // Say what was actually removed. Scenery has a chip, not a bar, and the panel's own
    // UI never calls it a clip - announcing "Clip removed" for an always-on image is the
    // one place the vocabulary would slip, and it slips only for screen-reader users.
    const wasClip = bars.has(id);
    write(sweepLinksTo(removeAndRipple(getBoxes(), cfg, id, mediaDur), id));
    selectAndReveal(focusedId ? [focusedId] : []);
    announce(wasClip ? t('Clip removed') : t('Removed'));
  }

  // ── keyboard trim (`[` / `]` pick an edge, `,` / `.` nudge it, `e` snaps it) ──
  //
  // The best affordance in the whole survey for an editor that has to be approachable:
  // it needs no pointer precision at all, it works at any zoom (including one where the
  // bar is too narrow to carry a hit zone), and "trim to the playhead" is the operation
  // people actually want most of the time - you are already looking at the frame.
  //
  // Each command is ONE write() = one undo step; holding a key coalesces through
  // tool-history's 500ms window exactly like a held arrow on the canvas.

  /** Which edge the keyboard is aimed at, or null. Cleared by the first Escape. */
  let focusedEdge: 'in' | 'out' | null = null;

  /** Every row's resolved timing, as one string - "did this edit change anything?". */
  function timingSig(rows: Box[]): string {
    return JSON.stringify(rows.map((b) => {
      const tm = boxTiming(b, cfg);
      return [String(b?.[cfg.idField] ?? ''), tm.start, tm.dur, tm.clipIn, tm.speed, tm.lane];
    }));
  }

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
   * `lead` prefixes the spoken readout rather than being announce()d separately - 
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
    // A press that hit a wall must not cost an undo entry - the same rule the split blade
    // already follows ("a split at an existing cut writes NOTHING"). Compared on the
    // resolved TIMING of every row, not on raw field equality: trimClip writes clipIn
    // explicitly, so a refused nudge still returns rows carrying `clipIn: 0` where the
    // field was simply absent before, and a textual comparison would call that a change.
    // Timing is also the whole of what a trim can touch, so nothing else can be missed.
    // The readout below is spoken either way: silence would read as a dropped keypress,
    // and "trimmed 0.0s" is exactly the feedback a wall deserves.
    if (timingSig(next) !== timingSig(boxes)) write(next);
    const j = indexOfId(next, cfg, id);
    const now = j >= 0 ? span(next[j]!, durationSec()).dur : before;
    const said = tRaw('{name}: {dur}, trimmed {delta}', {
      name: labelFor(id), dur: fmtDur(now), delta: fmtDelta(now - before),
    });
    announce(lead ? `${lead} ${said}` : said);
  }

  /** Pull the focused edge to the playhead - the no-dragging trim. */
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
  // time the take started - one commit, one undo step, trimmable immediately.
  //
  // Four things here are essential and each has already cost someone an afternoon:
  //
  //  1. THE LENGTH IS MEASURED, NEVER READ OFF THE BLOB. A fresh MediaRecorder blob
  //     reports duration Infinity or 0 (record-control.ts's `data-clip-ms` note says
  //     the same thing from the video side), so the elapsed wall-clock between "the
  //     recorder said go" and "the user pressed stop" IS the duration - and it is
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
  //     the panel, destroy() - all of them land in the same teardown.
  //  4. THE INSERT IS ONE COMMIT, composed from the SAME writers a drag uses
  //     (moveOverlay + setDuration on the intermediate array). No new clamping
  //     arithmetic lives in this view - see the module header.

  type TakePhase = 'idle' | 'countin' | 'recording' | 'saving';

  let takePhase: TakePhase = 'idle';
  let takeSession: RecordSession | null = null;
  let takeLevelOff: (() => void) | null = null;
  /** Microphone METER references this panel currently holds. A COUNT, not a boolean:
   *  `recorder.meter` is refcounted, so every resolved `start()` owes exactly one
   *  `stop()`. A boolean cannot describe "a start resolved after the take that asked for
   *  it was abandoned, while a newer take holds its own reference" - and an unbalanced
   *  count is unrecoverable: the browser's recording indicator stays lit until reload. */
  let takeMeterRefs = 0;
  /** Identity of the take in flight. Every await in the take driver is resumed by a
   *  continuation that may belong to an ABANDONED take, and the phase string cannot tell
   *  them apart (an abandoned take's continuation sees a NEWER take's 'countin' and
   *  proceeds as if it were live - two sessions, one leaked meter reference). Compare
   *  this instead: it is bumped by every start and every teardown. */
  let takeSeq = 0;
  /** Playhead seconds at the instant the recorder actually started. */
  let takeStartSec = 0;
  /** performance.now() at the same instant - the duration's only honest source. */
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

  /** The manifest's audio add-kind - the seed a recorded take is born from. */
  const audioKind = (): TimelineAddKind | undefined => addKinds.find((k) => k.id === 'audio');

  /**
   * PROGRESSIVE ENHANCEMENT, deliberately not a manifest capability - the same call
   * `host.media`'s live camera makes: the button appears when the running shell can
   * actually record and the tool has somewhere to put a take, and is absent otherwise.
   * Two questions, both answered here:
   *   - `host.recorder` + `isAvailable('audio')`: can THIS SHELL capture audio at all (a
   *     CLI cannot, and neither can a browser outside a secure context);
   *   - the audio add-kind: does the tool have an audio vocabulary - with no audio kind
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

  /** Same two questions for the typed twin: can this shell synthesize speech at all,
   *  and does the tool have an audio vocabulary for the clip to land in. */
  function canScriptVoiceover(): boolean {
    const sp = host.speech;
    if (!sp || typeof sp.isAvailable !== 'function' || !audioKind()) return false;
    try { return sp.isAvailable(); } catch { return false; }
  }

  /**
   * The field on a box that carries an asset ref. See TimelinePanelOpts.assetField.
   * Memoised once found: a tool's field vocabulary cannot change under a mount, and
   * this is reached from `restyle` (every keystroke). The FALLBACK is deliberately not
   * cached - a composition with no assets yet may grow one.
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
  function refOf(id: string): { id?: unknown; source?: unknown; type?: unknown; meta?: unknown } | null {
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0) return null;
    const v = rows[i]![assetFieldName()];
    return v && typeof v === 'object' && !Array.isArray(v) ? v as { id?: unknown } : null;
  }

  /**
   * A box holding a previous VOICEOVER take - the one a re-take is allowed to overwrite.
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
   *  than are held - over-stopping would tear the mic out from under another holder. */
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
    // Only reachable on an abort path - stopTake() has already consumed its session.
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

  /** The elapsed clock, the cap, and the mute re-assertion - one rAF loop. */
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
    // them a few times a second rather than every frame - this walks the canvas.
    if (el - lastMuteAt > 250) { lastMuteAt = el; muteComposition(); }
    takeTimer = requestAnimationFrame(tickTake);
  }

  async function startTake(): Promise<void> {
    if (takePhase !== 'idle' || disposed || !open) return;
    const recorder = host.recorder;
    if (!recorder) return;
    // This take's identity for the rest of the function. `stale()` is the ONLY correct
    // post-await guard: a continuation that fails it belongs to an abandoned take and
    // must clean up only what IT acquired - never call endTake(), which would tear down
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
      if (at != null) seekAuthored(at * 1000);
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
    catch (err) { host.log?.('warn', `timeline voiceover: stop failed - ${String(err)}`); }

    // Picture and sound go back to how we found them BEFORE the storage round-trip, so
    // a slow upload never leaves the composition muted and the playhead running.
    restoreComposition();
    if (!disposed) {
      clock.pause();
      syncPlayBtn();
      seekAuthored(takeStartSec * 1000);   // rewind to the top of the take, ready to hear it
    }

    try { await finishTake(blob, takeMs, seq); }
    catch (err) {
      // Storage-full carries a user-ready message (assets.ts's STORAGE_FULL) and every
      // other upload in the app surfaces it verbatim - swallowing it behind "could not be
      // saved" leaves the user with no reason and no way to make room.
      // A `code` marks the user-ready ones (STORAGE_FULL and the cap errors) - the same
      // test picker.ts's upload handler uses.
      const coded = (err as { code?: unknown; message?: string } | null);
      setNote(coded?.code && coded.message ? coded.message : t('The take could not be saved.'));
      host.log?.('warn', `timeline voiceover: save failed - ${String(err)}`);
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
      // The measured length, not the blob's - see note 1. This is what becomes
      // `data-audio-dur` and therefore what a trim can clamp against.
      { audio: true, durationMs: takeMs },
    );
    // The take was abandoned while the bytes were being stored (the panel closed, the
    // timeline was toggled off, destroy()). Commit nothing - an audio box arriving in a
    // panel the user has left is an undo step for a take they cancelled - and leave the
    // replaced asset alone. The orphan take is harmless; a deleted one is not.
    if (disposed || seq !== takeSeq) return;
    insertTake(ref, takeMs / 1000);
    // Committed. Only now is the superseded recording safe to drop.
    if (replaceId && prevId && prevId !== ref.id && prevId.startsWith('user/recording/')) {
      try { await host.assets?._deleteUserAsset?.(prevId); } catch { /* orphan take is harmless */ }
    }
  }

  /**
   * The take lands on the timeline - ONE commit either way (see note 4).
   *
   * A new take is born from the manifest's audio add-kind seed, placed by `moveOverlay`
   * and sized by `setDuration`, both composed on the intermediate array so the two
   * writers cost one undo step between them. A re-take patches the asset in place and
   * re-fits the length in the same array, and clears `clipIn` - a trim-in measured
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
    insertAudioBoxAt(ref, durSec, takeStartSec);
  }

  /**
   * One audio clip lands at one time - the SINGLE inserter behind both a finished
   * mic take and a saved scripted voiceover, so the two can never drift: born from
   * the manifest's audio seed, placed by `moveOverlay`, sized by `setDuration`,
   * one commit, one undo step.
   */
  function insertAudioBoxAt(ref: AssetRef, durSec: number, atSec: number): string {
    const rows = getBoxes();
    const id = mintId();
    const box: Box = {
      ...(audioKind()?.seed as Box | undefined),
      [cfg.idField]: id,
      [assetFieldName()]: ref as unknown as Box[string],
    };
    const placed = moveOverlay([...rows, box], cfg, id, atSec);
    write(setDuration(placed, cfg, id, durSec, durSec, mediaDur));
    focusedId = id;
    selectAndReveal([id]);
    announce(t('Voiceover added to the timeline'));
    return id;
  }

  // ── scripted voiceover (typed, not performed) ───────────────────────────────
  //
  // The Script-audio dialog owns everything speech: consent + model download,
  // voice/speed, generation progress, preview, save. The panel only remembers
  // WHERE the playhead was when the user pressed the button - the dialog can
  // stay open for minutes, and the clip must land where they were looking, not
  // wherever the clock has since drifted to.

  let scriptBusy = false;

  async function openScriptVoiceover(): Promise<void> {
    if (scriptBusy || !canScriptVoiceover()) return;
    scriptBusy = true;
    scriptBtn.disabled = true;
    const atSec = clock.t() / 1000;
    try {
      // Lazy for the picker's reason: the dialog is its own CSS chunk, and this
      // button is the only thing in the panel that ever needs it.
      const { openScriptAudioDialog } = await import('./script-audio.ts');
      const ref = await openScriptAudioDialog(host as unknown as Parameters<typeof openScriptAudioDialog>[0]);
      if (disposed || !ref) return;
      // The measured clip length rides the record (script-audio's buildTtsRecord
      // stamps `meta.durationMs`) - the same field a mic take stores, and for the
      // same reason: it is what a trim can clamp against.
      const ms = Number((ref.meta as Record<string, unknown> | undefined)?.durationMs);
      const clipId = insertAudioBoxAt(ref, Number.isFinite(ms) && ms > 0 ? ms / 1000 : DEFAULT_CLIP_S, atSec);
      // The scripted clip carries its own exact word timings (meta.tts.words), so
      // the transcript panel opens instantly - "TTS in, text editor out" is the
      // plans/174 entry point, and Esc dismisses it for anyone who just wanted audio.
      if (!transcriptBtn.hidden) void openTranscript(clipId);
    } catch (err) {
      host.log?.('warn', `timeline scripted voiceover failed - ${String(err)}`);
    } finally {
      scriptBusy = false;
      scriptBtn.disabled = false;
    }
  }

  // ── generated subtitles (plans/41-tts-stt-programme.md section 5) ─────────────────────
  //
  // Timing-source ladder, best first: the asset's own `meta.tts.words` (a TTS
  // clip aligns itself - exact by construction, no download, no wait), then a
  // transcript an earlier run already paid for (`meta.transcript` on the clip's
  // own record, or this session's in-memory stash - both lib/stt-job.ts), else
  // on-device Whisper via `host.speech.transcribe` (v1.99, its own one-time
  // model download behind its own consent sheet). No rung reachable → the menu
  // item is simply absent. Words become cues through the ENGINE's grouper and
  // cues become ordinary overlay text boxes - editable, trimmable, deletable
  // like anything else on the timeline, never a burned-in afterthought. The
  // whole set carries `group = captions:<source id>`, which is what lets a
  // re-run REPLACE the previous set (idempotent, never duplicating) and what the
  // panel's lane collapse reads to keep 200 cues off 200 lane rows.
  //
  // The Whisper rung is a BACKGROUND JOB (lib/stt-job.ts, the WP-F pattern): the
  // sheet takes consent and CLOSES, the global toast owns progress and cancel,
  // and the caption boxes land here when it finishes. A transcript that finishes
  // with the panel gone is stashed and written onto the clip's own record rather
  // than thrown away - see openTranscribeSheet and applySubtitles.

  /** The manifest's text add-kind - the seed a caption cue is born from. */
  const textKind = (): TimelineAddKind | undefined => addKinds.find((k) => k.id === 'text');

  /**
   * Boxes with a subtitles run in flight: a consent sheet open, or a
   * transcription job queued/running. A second request for the SAME clip is
   * noise; a DIFFERENT clip may start its own, and lib/jobs.ts's serial heavy
   * queue is what keeps two wasm runs from fighting over the address space.
   */
  const subtitlesPending = new Set<string>();
  const endSubtitles = (id: string): void => { subtitlesPending.delete(id); };

  /**
   * Whether Generate subtitles can be OFFERED for this box: the tool must have a
   * text vocabulary, a group field to own the set with, audio to read - and at
   * least one rung of the timing ladder must be reachable. Sync, because the
   * context menu renders synchronously: the stored ref's meta answers the TTS
   * and transcript rungs without a round-trip, the stash is a map lookup, and
   * the transcription rung is a sync probe.
   */
  function canGenerateSubtitles(id: string): boolean {
    if (!cfg.groupField || !opts.textField || !textKind()) return false;
    // A struck box's window IS the cut media - captioning it would place exactly
    // the words the user removed (plan 174 section 5.5 export-leak guard).
    const rows = getBoxes();
    if (boxIgnored(rows[indexOfId(rows, cfg, id)])) return false;
    const media = mediaOf(id);
    if (media.kind !== 'audio' && media.kind !== 'video') return false;
    const ref = refOf(id);
    if (ttsWordsOf(ref?.meta) || transcriptWordsOf(ref?.meta)) return true;
    if (stashedTranscript(typeof ref?.id === 'string' ? ref.id : '', media.url || '')) return true;
    try { return host.speech?.transcribeAvailable?.() === true; } catch { return false; }
  }

  /**
   * Walk the INSTANT rungs of the ladder for one box - the ones that cost
   * nothing - and, when none of them answers, report the source a transcription
   * would read plus the asset id its result should be filed against.
   */
  async function subtitleSource(
    id: string,
  ): Promise<{ words: SpeechWordTiming[] | null; src: AssetRef | string | null; assetId: string }> {
    const ref = refOf(id);
    const refId = typeof ref?.id === 'string' ? ref.id : '';
    const url = mediaOf(id).url || '';
    const stored = ttsWordsOf(ref?.meta) ?? transcriptWordsOf(ref?.meta);
    if (stored) return { words: stored, src: null, assetId: refId };
    // The model may persist a slim ref; the store still holds the full record.
    let live: AssetRef | null = null;
    if (refId && host.assets?.get) {
      try { live = await host.assets.get(refId); } catch { /* fall through to Whisper */ }
      const fromStore = ttsWordsOf(live?.meta) ?? transcriptWordsOf(live?.meta);
      if (fromStore) return { words: fromStore, src: null, assetId: refId };
    }
    // This session's stash: a run that finished with nobody watching, on a source
    // with no user-asset record of its own to annotate (a catalog clip, a URL).
    const stashed = stashedTranscript(refId, url);
    if (stashed) return { words: stashed, src: null, assetId: refId };
    // Freshest source wins: a live ref (fresh object URL), else the stored ref,
    // else the URL the canvas is already playing. All three are AudioSources.
    const src: AssetRef | string | null = live ?? (ref as AssetRef | null) ?? (url || null);
    return { words: null, src, assetId: refId };
  }

  /**
   * Open the right-docked Transcript panel for a clip (plans/174). Reuses the
   * subtitle timing ladder: stored TTS/Whisper words open the panel directly; a
   * clip with none is offered the same on-device transcription the captions use,
   * after which the user re-opens the panel. The panel edits through THIS module's
   * own `write`/`getBoxes`/`clock`, so its cuts are ordinary undo-aware box writes.
   */
  async function openTranscript(id?: string): Promise<void> {
    const clipId = id || selection.get()[0] || '';
    if (!clipId) return;
    const { words, src, assetId } = await subtitleSource(clipId);
    if (!words) { if (src) openTranscribeSheet(clipId, src, assetId); return; }
    openTranscriptPanel({
      cfg, words, assetId, sourceId: clipId, assetField: assetFieldName(),
      getBoxes, write,
      // The panel's rows are in AUTHORED time (mapped off the box starts), so its seek and
      // its read-along tick go through the same authored<->clock map as the ruler.
      seek: (ms) => seekAuthored(ms),
      subscribeTick: (cb) => clock.onTick((raw) => cb(toAuthoredMs(raw))),
      subscribeModel: (cb) => { const off = runtime.subscribe(cb); return () => { off?.(); }; },
    });
  }

  /**
   * The consent sheet for the transcription rung: what the run does, what it
   * downloads once, and one Go. Go ENQUEUES the background job and closes.
   *
   * Closing this sheet ABORTS NOTHING, and that is the whole point of the
   * conversion. Before Go there is nothing to abort; after Go the run belongs to
   * the job, whose ✕ in the global toast is the one honest cancel. The version
   * this replaced aborted on every exit path, so an Escape - or a stray backdrop
   * click - destroyed a ~77 MB one-time model download and every minute of
   * inference behind it.
   */
  function openTranscribeSheet(id: string, src: AssetRef | string, assetId: string): void {
    const sp = host.speech;
    if (!sp) { endSubtitles(id); return; }
    let enqueued = false;
    let bytes = 0;
    try { bytes = sp.transcribeModelBytes(); } catch { /* consent line just omits the size */ }
    const html = `<form method="dialog" class="tl-junction tl-stt">
      <h2 class="tl-junction-title">${t('Generate subtitles')}</h2>
      <p class="tl-stt-note">${t('Listens to this clip on this device and writes timed captions. Nothing is uploaded.')}</p>
      <p class="tl-stt-note tl-stt-note-dl" data-stt-dl hidden></p>
      <p class="tl-stt-note">${t('It runs in the background, so you can close this and keep working.')}</p>
      <div class="tl-junction-actions">
        <button type="button" class="btn" data-act="cancel">${t('Cancel')}</button>
        <button type="button" class="btn btn--primary" data-act="go">${t('Generate')}</button>
      </div>
    </form>`;
    const modal = mountModal<void>(html, {
      className: 'modal tl-junction-modal',
      ariaLabel: t('Generate subtitles'),
      initialFocus: (el) => el.querySelector<HTMLElement>('[data-act="go"]'),
      // Only the not-yet-enqueued close releases the guard; once the job exists it
      // owns the release, through onSettled.
      onClose: () => { if (!enqueued) endSubtitles(id); },
    });
    const dlNote = modal.el.querySelector<HTMLElement>('[data-stt-dl]');
    const goBtn = modal.el.querySelector<HTMLButtonElement>('[data-act="go"]');
    // The one-time download is the consent-worthy part, so say so up front -
    // but only when it is actually owed (the probe is async, the line arrives).
    void sp.transcribeCached?.().then((cached) => {
      if (!cached && dlNote) {
        dlNote.textContent = bytes > 0
          ? t('The first run downloads the speech model once ({size}). It stays on this device.', { size: fmtBytes(bytes) })
          : t('The first run downloads the speech model once. It stays on this device.');
        dlNote.hidden = false;
      }
    }).catch(() => { /* the probe failing just means no size line */ });
    goBtn?.addEventListener('click', () => {
      if (enqueued) return;
      enqueued = true;
      startTranscribeJob(host, {
        src,
        ...(assetId ? { assetId } : {}),
        title: t('Generating subtitles'),
      }, {
        // The panel places the captions when it is still here; the job announces
        // where the transcript went when it is not (applySubtitles says which).
        onComplete: (words) => applySubtitles(id, words),
        onError: (err) => { host.log?.('warn', `timeline subtitles: transcription failed - ${String(err)}`); },
        onSettled: () => endSubtitles(id),
      });
      modal.close();
      announce(t('Generating subtitles in the background. You can keep working.'));
    });
    modal.el.querySelector<HTMLElement>('[data-act="cancel"]')?.addEventListener('click', () => modal.close());
  }

  /**
   * Place (or REplace) the caption set for one audio/video box from a finished
   * word list. One commit: the previous `captions:<id>` group goes and the new
   * cues land in its place - run it twice and you have one set, not two.
   *
   * Returns whether the words were CONSUMED. False means there was nobody to
   * consume them - the panel has been destroyed, the tool has no text
   * vocabulary, or the source clip is gone - which is how lib/stt-job.ts knows
   * to announce where the transcript is instead of assuming it landed.
   */
  function applySubtitles(id: string, words: readonly SpeechWordTiming[]): boolean {
    const groupField = cfg.groupField;
    const textField = opts.textField;
    const seedKind = textKind();
    if (disposed || !groupField || !textField || !seedKind) return false;
    // The words may have arrived minutes later; re-read the model and make sure
    // the source survived.
    const rows = getBoxes();
    const i = indexOfId(rows, cfg, id);
    if (i < 0) return false;
    // Struck while the transcription ran: not consumed, so the job files the
    // transcript on the record instead of captioning the cut span (plan 174 section 5.5).
    if (boxIgnored(rows[i]!)) return false;
    const timing = boxTiming(rows[i]!, cfg);
    const spans = words.length
      ? cueSpansOnTimeline(groupWordsToCues(words), {
        start: timing.start ?? 0,
        dur: span(rows[i]!, durationSec()).dur,
        clipIn: timing.clipIn,
        speed: timing.speed,
      })
      : [];
    // Nothing to place is still an answer, and telling the user is consuming it.
    if (!spans.length) { announce(t('No speech was found to caption.'), { assertive: true }); return true; }
    const gid = captionGroup(id);
    const kept = rows.filter((b) => !b || String(b[groupField] ?? '') !== gid);
    // Mint against the SURVIVORS plus what this loop has already minted - mintId
    // reads the live model, which does not include either until the commit lands.
    const used = new Set(kept.map((b) => String(b?.[cfg.idField] ?? '')));
    let n = used.size + 1;
    const mint = (): string => {
      let next = `b${n}`;
      while (used.has(next)) { n++; next = `b${n}`; }
      used.add(next);
      return next;
    };
    const made: Box[] = spans.map((c) => ({
      ...(seedKind.seed as Box | undefined),
      [cfg.idField]: mint(),
      [textField]: c.text,
      [cfg.laneField]: '',            // overlay: a caption rides ABOVE the sequence
      [cfg.startField]: c.start,
      [cfg.durField]: Math.round((c.end - c.start) * 1000) / 1000,
      [cfg.enterField]: 'fade',
      [cfg.exitField]: 'fade',
      [groupField]: gid,
    }));
    write([...kept, ...made]);
    selectAndReveal([id]);
    announce(t('{count} caption boxes added. Each one is editable like any clip.', { count: String(made.length) }));
    return true;
  }

  /**
   * Generate (or REgenerate) the caption set for one audio/video box: take the
   * cheapest rung of the timing ladder that answers, and only fall through to the
   * consent sheet (and the background transcription behind it) when none does.
   */
  async function generateSubtitles(id: string): Promise<void> {
    if (!cfg.groupField || !opts.textField || !textKind()) return;
    if (subtitlesPending.has(id)) return;
    subtitlesPending.add(id);
    let handedOver = false;
    try {
      const { words, src, assetId } = await subtitleSource(id);
      if (disposed) return;
      if (words) { applySubtitles(id, words); return; }
      let sttOk = false;
      try { sttOk = host.speech?.transcribeAvailable?.() === true; } catch { /* stays false */ }
      if (!sttOk || !src) return;
      openTranscribeSheet(id, src, assetId);
      handedOver = true;    // the sheet, then the job, owns the guard from here
    } catch (err) {
      host.log?.('warn', `timeline subtitles failed - ${String(err)}`);
    } finally {
      if (!handedOver) endSubtitles(id);
    }
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
   * on `visibilitychange`, so the picture the user was performing against is gone - 
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
    // real - the same predicate that draws the seam's hairline.
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

  // ── the shortcuts sheet ──────────────────────────────────────────────────────
  //
  // Built from PANEL_SHORTCUTS, which is the same list `onKey` is written against, so
  // the sheet cannot drift from the handler (timeline-panel.test.ts drives every row
  // through the handler and checks the reverse direction too).
  //
  // Nodes, not an HTML string: every cell here is a translated string, and building the
  // table with textContent means no locale catalog can ever inject markup into it.

  let keysModal: ModalHandle<void> | null = null;

  function openShortcuts(): void {
    if (keysModal) return;
    // A native <dialog> restores focus on close all by itself (the dialog-closing
    // steps). Captured explicitly anyway so the guarantee belongs to the panel: the
    // sheet opens from the toolbar button AND from `?` over a focused clip bar, and
    // "you end up back where you were" has to hold for both.
    const opener = document.activeElement as HTMLElement | null;

    const sheet = document.createElement('div');
    sheet.className = 'tl-keys-sheet';
    const heading = document.createElement('h2');
    heading.className = 'tl-keys-title';
    heading.textContent = t('Timeline keyboard shortcuts');
    const table = document.createElement('table');
    table.className = 'tl-keys-table';
    const tbody = document.createElement('tbody');
    for (const row of PANEL_SHORTCUTS) {
      const tr = document.createElement('tr');
      const keysCell = document.createElement('td');
      keysCell.className = 'tl-keys-keys';
      const kbd = document.createElement('kbd');
      kbd.textContent = row.keys;
      keysCell.appendChild(kbd);
      const whatCell = document.createElement('td');
      whatCell.className = 'tl-keys-what';
      whatCell.textContent = row.label;
      if (row.hint) {
        const hint = document.createElement('span');
        hint.className = 'tl-keys-hint';
        hint.textContent = row.hint;
        whatCell.appendChild(hint);
      }
      tr.append(keysCell, whatCell);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const actions = document.createElement('div');
    actions.className = 'tl-keys-actions';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn btn--primary';
    done.textContent = t('Done');
    actions.appendChild(done);
    sheet.append(heading, table, actions);

    const modal = mountModal<void>('', {
      className: 'modal tl-keys-modal',
      ariaLabel: t('Timeline keyboard shortcuts'),
      onClose: () => {
        keysModal = null;
        if (opener?.isConnected) opener.focus();
      },
    });
    keysModal = modal;
    modal.el.appendChild(sheet);
    done.addEventListener('click', () => modal.close());
    done.focus();
  }

  // ── keyboard (panel-scoped; NEVER window - free-canvas owns that channel) ────

  let hovered = false;

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (!panelKeysActive(root, document.activeElement, hovered)) return;
    // UNMODIFIED ONLY (Shift excepted - several bindings below read it deliberately).
    // Every binding here is a bare letter or punctuation chosen BECAUSE no browser
    // fights for it; that reasoning only holds if the handler also declines the chord.
    // Without this, Cmd/Ctrl+S split instead of saving the page, Cmd/Ctrl+F fitted the
    // timeline instead of opening Find, Cmd+[ / Cmd+] armed a trim edge instead of
    // going back/forward, and Ctrl+- / Ctrl+= zoomed the timeline instead of the page - 
    // every one of them preventDefault()ed. free-canvas.ts guards its `v`/`p` tool
    // letters the same way.
    // …with ONE documented exception, taken BEFORE the guard because the guard is a
    // bare `return`: Alt+←/→ walks the selected clip's keyframes (plans/104 section 8). Alt
    // is already this panel's "not the ordinary reading" modifier - it bypasses
    // snapping on every drag - and no browser binds Alt+arrow on a focused element,
    // which is the same test every bare letter below had to pass.
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      seekDiamond(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const total = durationSec();
    const stepS = e.shiftKey ? 1 : FRAME_S;
    switch (e.key) {
      case ' ': case 'Spacebar': {
        // A focused <button> activates on Space by itself (click on keyup). Let it - 
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
      case 'End': e.preventDefault(); e.stopPropagation(); seekAuthored(total * 1000); return;
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
      // deliberately - every canonical NLE trim chord collides with a browser binding
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
      // "+Keyframe" from the keyboard - the THIRD door onto `addKeyframeAction`, and
      // literally the same call the transport button and the canvas contextual bar
      // make (section 8's M2.5 revision: two homes, one action). So `K` inherits every rule
      // from it, including the auto-promotion of an untimed selected box: the panel
      // being open with something selected IS the disclosure, and a keyboard user must
      // not be given the smaller half of a feature. Always preventDefault, including
      // on a selection with nothing to key: a shortcut that sometimes falls through to
      // the page is a shortcut nobody can trust.
      case 'k': case 'K': {
        e.preventDefault();
        e.stopPropagation();
        addKeyframeAction({ speak: true });
        return;
      }
      // Onion skin: `o` toggles it, Shift+O opens its options - the same bare-letter /
      // Shift-letter split `s`/`S` and `d`/`D` already use, and the only key space left
      // that no browser binding fights for. Both cases fold into ONE branch and the
      // modifier is read off the EVENT, exactly like `s`/`S`: KeyboardEvent.key reports
      // the produced character, so with Caps Lock on a bare `o` arrives as 'O' and
      // Shift+o as 'o' - branching on the letter's case inverts the pair.
      case 'o': case 'O':
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) onionMenu.open(); else toggleOnion();
        return;
      case '+': case '=': e.preventDefault(); e.stopPropagation(); zoom(ZOOM_STEP); return;
      case '-': case '_': e.preventDefault(); e.stopPropagation(); zoom(1 / ZOOM_STEP); return;
      case 'f': case 'F': e.preventDefault(); e.stopPropagation(); fit(); return;
      case 'Delete': case 'Backspace': e.preventDefault(); e.stopPropagation(); deleteBox(); return;
      // The menu key and Shift+F10 are the platform's context-menu keys. Without them
      // "Send to timeline" / "Make always on" would be pointer-only affordances.
      // `?` is the web's own "what can I press here" key. Every shortcut this panel
      // binds is a bare letter chosen because no browser fights for it, which also
      // means none of them is guessable - so the sheet is not a nicety.
      case '?': e.preventDefault(); e.stopPropagation(); openShortcuts(); return;
      case 'ContextMenu': e.preventDefault(); e.stopPropagation(); openCtxForFocused(); return;
      case 'F10': if (!e.shiftKey) return; e.preventDefault(); e.stopPropagation(); openCtxForFocused(); return;
      // The Escape LADDER, narrowest mode first: (1) a LIVE pointer drag - a trim or a
      // move mid-flight is the narrowest mode of all, and it is a visible one (the bar
      // carries .is-trimming, the badge and the reachable-media ghost are on screen), so
      // Escape must abandon it rather than pull the whole panel out from under the
      // pointer; (2) an armed keyboard trim edge, (3) a live take - mid-recording Escape
      // is the "stop, I fluffed it" key, and closing the panel out from under a live
      // microphone is not what the press meant - (4) the panel itself. Each rung is a
      // mode the user entered deliberately, so each one gets its own press.
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        if (gesture) {
          // endGesture drops the pointer capture and the chrome, so the pointerup that
          // follows finds `gesture === null` and writes nothing - the edit is abandoned,
          // not committed. The re-sync repaints the bars from the model, since a live
          // ripple preview would otherwise sit on screen until the next unrelated sync.
          endGesture(gesture);
          scheduleSync();
          return;
        }
        if (focusedEdge) { focusedEdge = null; paintFocusedEdge(); return; }
        if (takePhase !== 'idle') { cancelTake(); return; }
        // Clear a MULTI-selection before closing, so Escape means "deselect" first after
        // a marquee (matching the canvas). A single selected clip is the normal state and
        // does NOT swallow the close press - the ladder's last rung stays the panel.
        if (selection.get().length > 1) { selectAndReveal([], { reveal: false }); return; }
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
  scriptBtn.addEventListener('click', () => { void openScriptVoiceover(); });
  scriptBtn.hidden = !canScriptVoiceover();
  transcriptBtn.addEventListener('click', () => { void openTranscript(); });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  // Shift-click the blade is the pointer twin of Shift+S: cut everything the playhead
  // is inside. Same one write, same one undo step.
  // aria-disabled is advisory, so the press has to be swallowed here - that is the
  // price of keeping the blade focusable while it is inert (see syncSplitBtn).
  splitBtn.addEventListener('click', (e) => {
    if (splitBtn.getAttribute('aria-disabled') === 'true') return;
    splitAtPlayhead(e.shiftKey ? { everything: true } : undefined);
  });
  snapBtn.addEventListener('click', () => {
    snapOn = !snapOn;
    snapBtn.setAttribute('aria-pressed', snapOn ? 'true' : 'false');
    snapBtn.classList.toggle('is-active', snapOn);
  });
  snapBtn.classList.add('is-active');
  keysBtn.addEventListener('click', openShortcuts);
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
    // The `+` half of the pill promotes straight from the strip - no need to select
    // first and then find a field. One commit, exactly like the inspector route.
    const add = target?.closest<HTMLElement>('.tl-chip-add');
    if (add?.dataset.id) { promote(add.dataset.id); return; }
    const chip = target?.closest<HTMLElement>('.tl-chip');
    if (chip?.dataset.id) selectAndReveal([chip.dataset.id]);
  });
  laneWrap.addEventListener('dblclick', (e) => {
    // On a bar: rename in place. The junction affordance keeps the seams (a
    // double-click BETWEEN clips hits the lane, not a bar, so the two never race).
    const bar = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tl-clip');
    if (bar?.dataset.id && cfg.labelField) { renameClip(bar.dataset.id); return; }
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
  // Only touchmove is non-passive - it is the one that has to preventDefault the pan.
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
   * `tl-time` - the panel→canvas half of the one rule's seam (free-canvas.ts's header).
   * Same CustomEvent-on-the-stage pattern as `tl-add` / `tl-take`, deliberately: the
   * canvas needs to repaint its chrome when the set of ON-SCREEN boxes changes, and it
   * must NOT repaint sixty times a second while a clip merely plays through.
   *
   * So the fire is gated on a string signature of (playing, active ids). A tick inside
   * one clip produces the same string and costs one comparison; a cut, a seek across a
   * boundary, or pressing play produces a new one and fires exactly once.
   *
   * The ONION SKIN rides the same event and the same gate. Its neighbour set changes on
   * exactly the boundaries the active set does, so folding `mode` / `opacity` / the two
   * id lists into the signature keeps the "never once per tick" property intact while
   * making a toggle or an option change fire immediately - `setOnion` simply calls this.
   * With the preference OFF (the default) the whole onion half costs one `!!` per tick:
   * `onionNeighbours` is never called, and `mode` goes out as the empty string, which is
   * what tells free-canvas not to load the module at all.
   */
  let lastTimeKey = '\u0000';       // unmatchable, so the first tick always announces
  function emitTime(tMs: number): void {
    if (disposed) return;
    const playing = clock.playing();
    const boxes = getBoxes();
    const at = tMs / 1000;
    const activeIds = activeIdsAt(boxes, at);
    const pref = onionPref;
    const ghosts = pref
      ? onionNeighbours(boxes, cfg, at, pref.before, pref.after)
      : { past: [] as string[], future: [] as string[] };
    const mode = pref ? pref.mode : '';
    const opacity = pref ? pref.opacity : 1;
    // BEFORE the gate, and deliberately: the splittable set is NOT the active set. A
    // clip becomes active at its exact start, where a cut is impossible, and becomes
    // splittable one frame later - so gating the blade's label on tl-time's signature
    // would leave it disabled for the whole clip. It carries its own memo instead, so
    // the per-tick cost is one scope resolution and no DOM write.
    syncSplitBtn();
    const key = `${playing ? 1 : 0}|${activeIds.join(',')}|${mode}|${opacity}|${ghosts.past.join(',')}|${ghosts.future.join(',')}`;
    if (key === lastTimeKey) return;
    lastTimeKey = key;
    root.dispatchEvent(new CustomEvent('tl-time', {
      bubbles: true,
      detail: { atMs: tMs, activeIds, playing, mode, opacity, past: ghosts.past, future: ghosts.future },
    }));
  }
  const unsubTick = clock.onTick((rawMs) => {
    // The clock runs compressed (ignored spans removed); the ruler, the readout and the
    // read-along rows are all in authored time, so map once here. Identity when nothing
    // is struck. The effect during playback is the playhead SKIPPING a struck clip.
    const tMs = toAuthoredMs(rawMs);
    updatePlayhead(tMs);
    syncPlayBtn();
    emitTime(tMs);
    // The latch is a question about the PLAYHEAD, so it is asked on the same tick the
    // playhead moves on - and answers with no DOM write at all unless the answer
    // changed (see its memo). Outside emitTime's own gate, which is keyed on the
    // ACTIVE set: crossing a diamond changes neither what is on screen nor which
    // clips are playing, so that gate would swallow every latch there is.
    syncKfLatch();
    syncKfCam();
  });

  /**
   * `fc-seek` - the canvas→panel half. The off-playhead banner's "Go to it" asks for a
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
   * and puts `.seq-off` back when it is done. That restore used to be a GUESS taken up
   * to a second and a half earlier, which is exactly how long the artboard could stay
   * black: scrub onto the box being photographed and the applier removed `seq-off` from
   * a box still parked 200vw away, so the LIVE scene was off the viewport until the
   * shot settled and popped it back.
   *
   * The borrow is a LEASE now (`data-tl-borrowed`, sequence-dom.ts): the applier revokes
   * it the instant the playhead moves onto the box, and the shot's restore re-hides only
   * what still carries its own token. So this is no longer the fix - it is the belt to
   * the applier's braces, for the ordinary case where nothing raced. Cheap: `reapply()`
   * is one pass of class/style writes, and this only fires for a box that carried the
   * class at all.
   */
  const unsubShot = onNodeShotSettled(() => {
    if (disposed) return;
    try { clock.reapply(); } catch { /* the clock is gone; the panel is going with it */ }
  });

  /**
   * A thumbnail is a picture of the CLIP, never of the frame the playhead is parked on
   * (plans/104 section 6.5). clip-thumbs cannot reach the authored values itself - importing
   * bridge/sequence-dom.ts would drag sequence-plan → @lolly/engine into the chunk
   * picker.ts loads for `onIdle` alone - so the panel, which already owns both ends,
   * hands it the two readers. Removed with the panel: a seam pointing at a destroyed
   * clock's store would answer authored reads out of nothing.
   */
  const unsubPose = setAuthoredPoseSeam({ read: authoredStyleOf, borrow: borrowAuthoredPose });

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
      // The synchronous reapply above gates the canvas AS IT IS NOW, but `reserve()` at
      // :4839 re-fits (and may re-render) the artboard AFTER this returns - a plain re-fit
      // that does not move the clock fires no further gate, so a template whose clips are
      // already timed on first render (sequence-studio "Video") would keep every clip
      // visible at rest until the user first scrubs/plays. Re-assert the gate one frame
      // later, once the re-fit has settled. Idempotent: on a steady frame reapply() writes
      // zero styles and only re-adds/removes `.seq-off`. Fires only on open, never per tick.
      requestAnimationFrame(() => {
        if (disposed || !open) return;
        clock.reapply();
      });
      root.focus?.();
    } else {
      // A hidden panel has no visible mic button, no meter and no elapsed clock, so a
      // take cannot survive the close: the microphone would stay open with nothing on
      // screen to say so.
      cancelTake();
      // End any gesture FIRST: Escape is reachable mid-drag, and a live resize keeps
      // calling reserve() on every subsequent pointermove - leaving the artboard
      // shrunk behind a hidden panel until the tool is destroyed.
      endGesture(gesture);
      // The menus are body-mounted, so hiding the panel does not hide them.
      addMenu.close();
      ctxMenu.close();
      onionMenu.close();
      easeMenu.close();
      // …and the inspector's group popover most of all: it is positioned ABOVE the
      // panel, so a hidden panel would leave a settings card floating over the canvas
      // with nothing under it to explain what it belongs to.
      closeGroupPopover();
      keysModal?.close();
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
    if (inspectorEnterT) { clearTimeout(inspectorEnterT); inspectorEnterT = null; }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    endGesture(gesture);
    // Body-mounted: these outlive root.remove() unless they are closed explicitly.
    try { addMenu.close(); } catch { /* never opened */ }
    try { ctxMenu.close(); } catch { /* never opened */ }
    try { onionMenu.close(); } catch { /* never opened */ }
    try { easeMenu.close(); } catch { /* never opened */ }
    try { kfCtxMenu.close(); } catch { /* never opened */ }
    // The editor holds a rAF loop and a document-level pointerup; closing the popover
    // only takes its DOM away.
    try { easeEditor?.destroy(); } catch { /* never opened */ }
    easeEditor = null;
    // …and so does the one DOCKED in the Keyframes popup (section 8's M2.7).
    try { kfLatch?.dock?.editor?.destroy(); } catch { /* never mounted */ }
    try { closeGroupPopover(); } catch { /* never opened */ }
    kfLatch = null;
    kfCam = null;
    try { keysModal?.close(); } catch { /* never opened */ }
    if (onionHold) { clearTimeout(onionHold); onionHold = 0; }
    try { clock.pause(); } catch { /* already gone */ }
    abortThumbs();
    cancelIdle?.();
    cancelIdle = null;
    try { unsubShot(); } catch { /* already gone */ }
    try { unsubPose(); } catch { /* already gone */ }
    // The decoded pictures outlive the panel otherwise: nothing else in the web shell
    // consumes this cache (picker.ts imports `onIdle` alone), so up to CACHE_LIMIT
    // ImageBitmaps - filmstrips of dozens each, plus every frame's node raster - would
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

  /**
   * Of `ids`, the ones whose OWN keyframe sits exactly under the playhead right now.
   *
   * Exact equality, because the latch has already put the playhead there (section 8): a
   * tolerance would make a canvas drag key a keyframe the panel's own header says
   * you are not on, which is the one way this model can lie.
   */
  function kfPoseIds(ids: readonly string[]): string[] {
    // A CLOSED panel arms nothing. section 8's model is "the playhead's position IS the arm",
    // and with the panel shut there is no playhead on screen, no diamonds, no latch
    // header and no "+Keyframe" anywhere - so a drag that quietly wrote a keyframe
    // instead of moving the box would be the one thing this model exists to prevent:
    // a keyframe nobody asked for, from a gesture that looked like an ordinary move.
    // `setOpen(false)` keeps the clock's time, so the answer would otherwise survive
    // the close.
    if (!open || !cfg.kfField) return [];
    const rows = getBoxes();
    const at = playheadSec();
    const out: string[] = [];
    for (const id of ids) {
      const i = indexOfId(rows, cfg, id);
      if (i >= 0 && kfDiamondAt(rows[i]!, cfg, at) !== null) out.push(id);
    }
    return out;
  }

  /**
   * The gesture's delta, folded into each box's keyframe at the playhead - a FULL
   * pose over its active channel set, so every diamond stays a complete honest one.
   * Pure: no commit, no announce, no DOM. The caller writes once.
   */
  function kfPoseWrite(
    boxes: Box[], ids: readonly string[], delta: KfPose, mode: 'add' | 'set' = 'add',
  ): Box[] {
    if (!cfg.kfField) return boxes;
    const at = playheadSec();
    let next = boxes;
    for (const id of ids) next = writeKfPose(next, cfg, id, at, delta, mode);
    return next;
  }

  return {
    destroy, setOpen, isOpen: () => open, promote, demote, kfPoseIds, kfPoseWrite,
    cameraModeId, cameraWrite, cameraTiltPreview,
    seek: (sec) => seekAuthored((Number.isFinite(sec) ? Math.max(0, sec) : 0) * 1000),
    selectAndReveal,
    time: () => playheadSec(),
    addKeyframe: () => addKeyframeAction({ speak: true }),
    keyframableIds: (ids) => {
      const rows = getBoxes();
      return ids.filter((id) => isKeyframable(rows[indexOfId(rows, cfg, id)], id));
    },
  };
}

/**
 * Repack the seq row - exposed for free-canvas's create path, which drops a new clip
 * onto the magnetic lane and needs it gapless before the next paint. Thin on purpose:
 * the arithmetic is timeline-math's.
 */
export function packSeqRow(boxes: Box[], cfg: TimeCfg): Box[] {
  return packSeq(boxes, cfg);
}
