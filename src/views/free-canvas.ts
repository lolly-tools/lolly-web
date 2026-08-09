// SPDX-License-Identifier: MPL-2.0
// free-canvas.js — the WYSIWYG direct-manipulation overlay for render.layout:'editor'.
//
// This is the ONLY DOM in the free-canvas feature; all geometry lives in the pure,
// unit-tested free-canvas-math.js. It mounts:
//   • a left toolbar (add / arrange / align / canvas background),
//   • a selection overlay (rotated outlines + 8 resize handles + a rotate handle),
//   • a contextual bar (fill / text controls / duplicate / delete + a transform readout),
// all as SIBLINGS of #tool-canvas inside #tool-stage — so they live OUTSIDE the
// exported node (runtime.export is handed #tool-canvas) and never leak into output.
// They also carry [data-export-hide] as a backstop.
//
// The overlay reads box geometry from the MODEL (runtime.getModel) and maps native
// canvas pixels ↔ screen via the live canvasEl rect (transform-agnostic: composes
// fitCanvas's scale AND stageNav's pan/zoom automatically). Edits mutate the box DOM
// directly for smooth feedback during a gesture and commit ONE runtime.setInput on
// release — which the shell's undo wrapper coalesces into a single history step.
//
// Opt-in and progressive: without this overlay the same flat `boxes` array renders
// identically headless (CLI/URL). The engine and URL never see the editor.
//
// ── THE ONE RULE (sequence editing) ──────────────────────────────────────────
// On a time-capable tool (`timeCfg`) the canvas is a window onto ONE instant, and
// one sentence governs everything the user can touch:
//
//   "The canvas edits exactly what the canvas shows at the playhead. Moving the
//    playhead never changes the selection; selecting in the timeline moves the
//    playhead so the selection stays live; when a selection is nevertheless
//    off-playhead, the canvas says so and offers to reconcile. The timeline
//    inspector and the sidebar are the precision fallbacks and are never gated
//    by time."
//
// It is enforced in three places, deliberately, because one of them alone leaks:
//   1. ACQUISITION — `seqHiddenSkip` makes a click fall THROUGH a hidden box to
//      the visible one beneath (no toast: in a stacked scene composition that
//      would fire on every click).
//   2. RETENTION — `paintChrome` suppresses the outline, all 8 resize handles,
//      the rotate handle and the contextual bar when the selection is not live,
//      so no pointer path can start a gesture on something nobody can see. The
//      chrome is positioned from the MODEL, not the DOM, so without this it
//      would paint full editing furniture over nothing.
//   3. KEYBOARD — `onKey` refuses every mutating key on an off-playhead
//      selection, because a nudge or a Delete needs no chrome at all.
// Plus the reconciliation: an off-playhead selection raises the `.fc-offplayhead`
// banner, whose button dispatches `fc-seek` at the box's own start. The timeline
// panel answers it, and tells us where the playhead is via `tl-time`.
//
// Deliberately NOT built: a "selection follows playhead" preference. Premiere
// ships one and users still lose work to it — time→selection is destructive.

import {
  boxRect, withRect, boxCorners, rectCentre, boxAABB,
  moveBoxes, resizeRect, alignBoxes, distributeBoxes, reorderZ,
  seedBox, normDragRect, snapAngle, normAngle, clampBoxToCanvas, selectionAABB,
  snapMove, snapPoint, scaleGroup, rotateGroup, num,
  edgeWaypoints, edgeNested, roundedEdgePath, smoothEdgePath,
  edgeArrowHead, edgeHeadInset, isEdgePoint, edgeEndRect,
  // plan 96 P3/P5 — a BOUND path is drawn by connector management, through the engine's
  // ONE routed-line renderer and its ONE kind→route mapping, so the live overlay, the
  // committed render and a headless CLI cannot disagree about where the line goes.
  routedLineSvg, pathRouteStyle, formatEdgePoint,
  gradientLine, gradientPosAt, gradientAngleAt, resolveFrame, renumberFrameOrder,
  sequenceFramesInOrder, framesAreSequenced, parseDashArray, formatDashArray,
  pathEndPoints, pathEndTangents,
} from './free-canvas-math.ts';
import type { ZOp, AlignEdge, Axis, AABB as MathAABB, Rect as MathRect, EdgeRect, Box } from './free-canvas-math.ts';
// Phase-A spatial-index pick: grid-accelerated on large docs, identical result to the
// linear hitTest/marqueeHit on small ones (plans/98 §6.1; proven in canvas-scene.test.ts).
import { pickTopmost, pickMarquee } from './canvas-scene.ts';
import {
  toCssPx,
  parseColor, colorToHexString, interpolateColor,
  parseGradientSpec, formatGradientSpec, gradientSpecToCss, MAX_GRADIENT_STOPS,
} from '@lolly/engine';
import type { GradientSpec } from '@lolly/engine';
import type { BooleanOpName, VectorFieldConfig, VectorOpFailure, VectorOpResult } from './vector-ops.ts';
import {
  booleanBoxes, boxOutlineKind, offsetBoxes, pathToBox, replaceBoxes, simplifyBoxes, strokeBoxesToPath,
} from './vector-ops.ts';
import type { AuthoredPath, Continuity, Cubic, HyperbezierSolution, SplineKind, SplineNode } from '@lolly/engine';
import type { PenFrame } from './free-canvas-pen.ts';
import type { OutlineGroup } from './outline-text.ts';
import {
  PEN_DEFAULT_KIND, PEN_KINDS, alignPoints, closesOnClick, convertKind, decodePathContours,
  defaultContinuity, deleteNodes, denormNodes, distributePoints, dragHandle, encodePathField,
  encodePathFields, frameToLocal, handlePoint, insertNodeOnCurve, kindReadsHandles,
  localToFrame, lowerAuthored, type InsertResult, type NodeAlignEdge, type PenPointRef,
  moveNodes, nearestOnPath, nodeAt, normNodes, pathPaintIsVisible, pathPaintSeed,
  penCommitFromNative, penFrame, pickPathPaint, pullHandles,
  refitFrame, resolveDrawnInk, setNodeContinuity,
} from './free-canvas-pen.ts';
import type { PathPaintFields } from './free-canvas-pen.ts';
// Type-only (erased at build): the timeline modules are LAZY — importing their types
// costs no chunk, and timeline-panel.ts pulls in styles/parts/timeline.css.
import type { TimeCfg } from './timeline-math.ts';
import type { TimelinePanel } from './timeline-panel.ts';
// Type-only: the ghost layer is a lazy chunk that only an editor with onion skin turned
// ON ever fetches, so its runtime import lives inside onionFrom's dynamic `import()`.
import type { OnionPaintState, OnionSkinHandle } from './onion-skin.ts';
import type { MatteHost, MatteSource } from './matte-dialog.ts';
import type { HostV1 } from '@lolly-tools/core/host-v1';
import type { InputValue } from '../../../../engine/src/inputs.ts';
import { takePendingDesignImport } from '../lib/drop-router.ts';
// The boot-path slice of user-fonts (NOT ../user-fonts.ts, which would drag the
// whole Google-font fetcher into this view chunk — see user-fonts.ts:73-80).
import { brandFontFamilies } from '../lib/register-user-fonts.ts';
import { LOLLY_ICON } from '../lib/lolly-badge.ts';
import { announce } from '../a11y.ts';
import { prefersReducedMotion } from '../lib/a11y-prefs.ts';
import { escape } from '../utils.ts';
import { isTypingTarget } from '../lib/typing-target.ts';
import { BLEND_STYLES, HUE_ROUTES, isPolarSpace } from '../lib/blend-style.ts';
import { t, tRaw } from '../i18n.ts';
import type { ColorFieldValue } from '../components/color-field.ts';
import { colorFieldHtml, wireColorField } from '../components/color-field.ts';
import {
  charsFromDom, htmlFromChars, markdownFromChars,
  rangeHasFlag, setFlag, setColor, rangeColor, wordRangeAt, allBulleted, toggleBullets,
  setWeight, rangeWeight, allNumbered, toggleNumbers, clearFormatting,
} from './rich-text.ts';

// ── local types ───────────────────────────────────────────────────────────────
// `Box` (a flat per-tool record, field names configured via cfg.*Field) is imported from
// free-canvas-math.ts so the overlay and the pure geometry share one honest type
// (`{ [key: string]: InputValue | undefined }`).
interface Point { x: number; y: number }
interface Rect { x: number; y: number; w: number; h: number; rot?: number }
interface AABB { minX: number; minY: number; maxX: number; maxY: number; w?: number; h?: number }
interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
interface Canvas { w: number; h: number }
interface Metrics { cr: DOMRect; sr: DOMRect; scale: number }
type HandleName = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type Corner = 'nw' | 'ne' | 'se' | 'sw';

/** One entry of a `canvas.addKinds` list — a "kind" the add-box menu can create. */
interface AddKind { id: string; label?: string; seed?: Box }

/** The subset of a blocks-field declaration the editor reads: the font select's
 *  declared options drive the typography menus, so the editor writes exactly the
 *  wire values the tool's hooks.js understands (e.g. 'SUSE'/'SUSE Mono' on the
 *  SUSE profile, 'sans'/'mono' on lolly-start). */
interface BlockFieldDef { id: string; default?: unknown; options?: Array<{ value?: unknown; label?: string }> }
interface FontOption { value: string; label: string }

/** The free-form per-tool `canvas` schema block (from the manifest). */
interface CanvasCfg {
  idField?: string;
  xField?: string; yField?: string; wField?: string; hField?: string;
  rotationField?: string;
  fillField?: string; gradField?: string; opacityField?: string; shapeField?: string;
  radiusField?: string; imageField?: string; fitField?: string; imgPosField?: string;
  blendField?: string; textField?: string; textColorField?: string;
  fontSizeField?: string; alignField?: string; valignField?: string;
  weightField?: string; fontField?: string; lineHeightField?: string;
  trackingField?: string; ligaturesField?: string; alternatesField?: string;
  padField?: string; fitTextField?: string; groupField?: string; clipField?: string;
  shadowField?: string; shadowColorField?: string;
  shadowXField?: string; shadowYField?: string; shadowBlurField?: string;
  /** Vector sub-fields (the `boxes` fields Stage C appends: an authored path plus its
   *  stroke paint and fill rule). `pathField` is the FEATURE FLAG for the whole
   *  vector-operations section of the context menu — a tool that declares no path
   *  sub-field has nowhere to put a boolean result, so it is not offered one. Every
   *  entry degrades to "absent", never to "throws", on a manifest that predates them. */
  pathField?: string; strokeField?: string; strokeWField?: string; fillRuleField?: string;
  /** Stroke DECORATION sub-fields (appended after the timeline block): a dash-style
   *  keyword plus the line cap and join. Keywords, not authored dash arrays — see the
   *  hook's `dashArrayFor` for why the compact URL form cannot carry a comma. */
  strokeDashField?: string; strokeCapField?: string; strokeJoinField?: string;
  /** Power-user dash sub-fields (plan 96 P0). `strokeDashArrayField` holds the AUTHORED
   *  pattern as a SPACE-separated numeric string ("6 4") — a string, not a list, because a
   *  block sub-field is one scalar and space is the one separator the compact blocks URL
   *  survives (see lib/blocks-url.ts; a comma would split the row). It WINS over the
   *  keyword style when set. `dashFitField` is the boolean "fit the pattern to the path's
   *  corners" (Illustrator's corner-aligned dashes), applied by the tool's hook. */
  strokeDashArrayField?: string; dashFitField?: string;
  /** PATH DECORATION sub-fields (plan 96 P0 — the unified path primitive). An arrowhead
   *  shape at each end of an authored path, drawn at its end tangents: none · triangle ·
   *  open · circle · diamond · bar, the same vocabulary the connector heads use, because
   *  a spline, a line and a connector are one primitive that carries one decoration set. */
  headStartField?: string; headEndField?: string;
  /** PATH ENDPOINT BINDING (plan 96 P0). The id of the box each end is attached to, `''`
   *  for a free end. Model only at this stage: nothing reads them yet — P3 adds the bind
   *  gesture and hands a bound path to connector routing. Declared now so the fields ship
   *  in the manifests' wire order before anything depends on them. */
  bindStartField?: string; bindEndField?: string;
  /** PATH ROUTE OVERRIDE (plan 96 P3). A bound path's route is normally read off its own
   *  spline kind; six kinds cannot name the engine's thirteen routes, so this field carries
   *  the explicit one (elbow-src, curved-v, arc-wide …). '' = auto. It is also what makes
   *  the plan-90 edge migration lossless. */
  routeField?: string;
  /** The class the tool's hook puts on its committed BOUND-PATH `<svg>` (plan 96 P5) —
   *  hidden for the duration of a drag so the live overlay does not double up with the
   *  stale committed one. Named here for the same reason `canvas.connect.layerClass` was:
   *  only the manifest knows what its own hook emits. */
  pathLayerClass?: string;
  /** Timeline time-model sub-fields (phase 1: schema/manifest only — inert until a
   *  timeline panel mounts and reads them; see engine 1.65.0 CHANGELOG entry). */
  startField?: string; durField?: string; clipInField?: string; speedField?: string;
  enterField?: string; exitField?: string; enterMsField?: string; exitMsField?: string;
  muteField?: string; laneField?: string;
  /** OPTIONAL time sub-field: the A/V link (detached audio). Absent on a tool that does
   *  not offer detach — the ten-field time check below does NOT include it. */
  linkField?: string;
  /** OPTIONAL time sub-fields: the authored geometry curve for each preset. Absent
   *  leaves every preset on its built-in curve, so they sit outside that same check. */
  enterEaseField?: string; exitEaseField?: string;
  minSize?: number;
  addKinds?: AddKind[];
  import?: unknown;
  /** Opt-in: a SECOND blocks input holding connector edges between boxes, plus a
   *  "Connect" rail mode to author them (click a source card, then targets). The
   *  overlay only reads/writes this array + draws a live preview; the tool's hooks.js
   *  turns {from,to} into the actual routed lines. Absent for Layout Studio / Carousel,
   *  so their toolbars are unchanged. */
  connect?: ConnectCfg;
  /** Opt-in: snap box positions to a fixed grid (with a rail toggle). */
  grid?: { size?: number; default?: boolean };
  /** Opt-in: the canvas is a fixed size (no resize control). Connector tools set this
   *  so the connector <svg>'s viewBox stays 1:1 with box coordinates. */
  fixedCanvas?: boolean;
}

/**
 * The tool the rail says is live. One value, so entering a tool IS leaving every other one.
 *
 * These four are the modes that change what a canvas press MEANS. Point editing is not one
 * of them (it is a sub-state of `'select'`, like a live text edit), and neither is the
 * timeline: the docked panel is a second surface alongside the canvas, not a different
 * reading of a canvas press, so it stays a plain toggle and outlives any tool change.
 */
type EditorMode = 'select' | 'create' | 'pen' | 'line';

/** `canvas.connect` — how the editor authors + stores connector edges. */
interface ConnectCfg {
  input: string;            // input id of the connectors blocks array
  fromField?: string;       // edge field holding the source box id (default 'from')
  toField?: string;         // edge field holding the target box id (default 'to')
  styleField?: string;
  arrowField?: string;
  headField?: string;       // edge field for the arrowhead SHAPE (triangle/open/circle/diamond/bar)
  colorField?: string;
  dashField?: string;
  widthField?: string;
  layerClass?: string;      // class of the tool's rendered connector <svg> (hidden mid-drag)
  defaultStyle?: string;
  defaultArrow?: string;
  defaultHead?: string;
  defaultColor?: string;
  defaultWidth?: number;
}

/** The resolved field-name config this module drives the DOM/model with. Fields the
 *  manifest may omit are typed as string but can be `undefined` at runtime; every
 *  read/write is guarded (setField no-ops on a falsy field), so this stays faithful. */
interface FieldCfg {
  idField: string; xField: string; yField: string; wField: string; hField: string;
  rotationField: string;
  fillField: string; gradField: string; opacityField: string; shapeField: string;
  radiusField: string; imageField: string; fitField: string; imgPosField: string;
  blendField: string; textField: string; textColorField: string;
  fontSizeField: string; alignField: string; valignField: string;
  weightField: string; fontField: string; lineHeightField: string;
  trackingField: string; ligaturesField: string; alternatesField: string;
  padField: string; fitTextField: string; groupField: string; clipField: string;
  shadowField: string; shadowColorField: string;
  shadowXField: string; shadowYField: string; shadowBlurField: string;
  kindField: string;
  pathField: string; strokeField: string; strokeWField: string; fillRuleField: string;
  strokeDashField: string; strokeCapField: string; strokeJoinField: string;
  strokeDashArrayField: string; dashFitField: string;
  headStartField: string; headEndField: string;
  bindStartField: string; bindEndField: string;
  routeField: string;
}

interface ModelItem { id: string; value: any }
interface RuntimeApi {
  getModel(): ModelItem[];
  setInput(id: string, value: any): void;
  subscribe(fn: () => void): (() => void) | void;
}
interface HostApi {
  assets?: { pick(opts: any): Promise<any> };
  /** Feature-detected (plan 96): the engine's dash-fit primitives, once the running
   *  engine carries them. `parse` is the AUTHORITY on what the Dash array field accepts,
   *  so the panel prefers it and falls back to free-canvas-math's own `parseDashArray`
   *  (the same contract) on an engine that predates it. */
  connectors?: { dashFit?: { parse?(text: string): number[] | null } };
}
interface DocInfo {
  getFilename?(): string;
  setFilename?(name: string): void;
  lastEdited?(): string | Promise<string> | null | undefined;
  /** The tool's manifest id. Read by the import panel's templates pass, which
   *  mints saved sessions that must resume into THIS tool. */
  id?: string;
  name?: string;
  version?: string;
  status?: string;
  formats?: string[];
  // Export provenance: a READ-ONLY view of the name/contact that gets baked into an
  // export's file metadata, plus an opt in/out toggle. The fields themselves are
  // edited in the profile (editHref) — never here.
  provenance?: {
    editHref?: string;
    get(): Promise<{ optedIn: boolean; author: string; contact: string }>;
    setOptIn(on: boolean): Promise<void>;
  };
}
interface HistoryApi {
  undo(): void;
  redo(): void;
  register(cb: (canUndo: boolean, canRedo: boolean) => void): void;
}

interface InitFreeCanvasOpts {
  viewEl: HTMLElement;
  stageEl: HTMLElement;
  canvasEl: HTMLElement;
  runtime: RuntimeApi;
  host: HostApi;
  input: { id: string; canvas?: CanvasCfg; fields?: BlockFieldDef[] };
  nativeW: number;
  nativeH: number;
  onDirty?(id: string): void;
  editTool?(url: string, mode?: string): Promise<any>;
  setCanvasSize?(w: number, h: number, unit?: string): void;
  info?: DocInfo;
  history?: HistoryApi;
  actions?: ToolbarActions;
  /** Multi-page ("carousel") mode. When present, the box array spans a horizontal
   *  strip of N same-size page frames (each rendered as a `[data-pdf-page]` by the
   *  tool). Box coords stay GLOBAL across the strip; the overlay only needs to (a)
   *  translate a box's on-screen position by its frame's DOM offset during a live
   *  gesture, (b) un-clip frames mid-drag, and (c) expose a page-count + page-size
   *  control on the rail. Values name the number-input ids the geometry is read
   *  from / written to via runtime. Absent for single-page editors (Layout Studio). */
  pages?: PagesCfg;
  /** Frame-primitive mode (plan 93 F1b). When present, the box array may include
   *  `kind === frameKind` boxes that render as free-placed `[data-pdf-page]` pages
   *  (the tool's hook emits them at authored x/y). The overlay then (a) drives live
   *  gestures in frame-local space via each frame's DOM offset — the same math the
   *  carousel uses, and (b) re-buckets a moved/created/resized box into the frame its
   *  centre lands in, on drop. Absent for tools whose canvas declares no `frameField`,
   *  so every frame-aware path below is dead for them (no-frames byte-identity). */
  frame?: FrameCfg;
}

interface PagesCfg {
  countField: string;   // input id: page count
  widthField: string;   // input id: page width (px)
  heightField: string;  // input id: page height (px)
  min: number;
  max: number;
}

/** `canvas.frameField`/… — the frame-primitive field names (plan 93). `frameKind`
 *  is the `kind` value that marks a box as a page container; `frameField` is where a
 *  member box stores its owning frame id. order/clip are read by the hook, not yet by
 *  the overlay (cascade + clip toggles are later F1b slices). */
interface FrameCfg {
  frameField: string;
  frameKind: string;
  orderField?: string;
  clipChildrenField?: string;
}

/** Primary tool actions surfaced as prominent icons in the editor rail (chromeless
 *  layout has no bottom pill). Callbacks delegate to the tool's existing handlers. */
interface ToolbarActions {
  export(): void;
  save(): void;
  copy(): void;
  share(): void;
  canSave?: boolean;                 // omit the Save icon for tools that don't persist a session
  dirtyRef?: HTMLElement | null;     // element whose `is-unsaved` class the Save icon mirrors
}

interface FreeCanvasHandle { destroy(): void }

interface EditingState {
  id: string;
  el: HTMLElement;
  boxEl: HTMLElement | null;
  prevHtml: string;
  prevStyle: string;
  prevBoxStyle: string;
  pending: Record<string, any>;
  colorRange?: [number, number];
  weightRange?: [number, number];
}

interface FmtRefs {
  align: Record<string, HTMLButtonElement>;
  valign: Record<string, HTMLButtonElement>;
  font?: HTMLSelectElement;
  weight?: HTMLSelectElement;
  clear?: HTMLButtonElement;
  b?: HTMLButtonElement;
  i?: HTMLButtonElement;
  bullet?: HTMLButtonElement;
  numbers?: HTMLButtonElement;
  lig?: HTMLButtonElement;
  alt?: HTMLButtonElement;
  emoji?: HTMLButtonElement;
}
type FmtBar = HTMLDivElement & { _refs?: FmtRefs };

// Popover item shapes (separator / icon-grid / action row).
interface PopGridItem { label: string; icon?: string; run(): void; disabled?: boolean; danger?: boolean; keepOpen?: boolean }
interface PopSep { sep: true; grid?: undefined }
interface PopGrid { sep?: undefined; grid: PopGridItem[]; cols?: number }
// `key` tags the rendered row with `data-pop="<key>"` so a long-lived menu can be
// refreshed in place — the undo/redo pair stays open while you step back, and its
// enabled state has to follow the history stack rather than the moment it opened.
// `on` makes a row a RADIO rather than a command — set it (even to false) and the row
// reports `aria-checked` and paints its current state. Used by the pen's spline-type menu,
// where the point of opening it is to see which type you are already on.
interface PopAction { sep?: undefined; grid?: undefined; label: string; icon?: string; run(): void; disabled?: boolean; danger?: boolean; keepOpen?: boolean; key?: string; on?: boolean }
type PopItem = PopSep | PopGrid | PopAction;

// Gesture state — filled in by beginGesture with pointerId/startClient.
interface GestureBase { pointerId: number; startClient: Point; origin?: Point }
interface TapGesture extends GestureBase { type: 'tap' }
interface MarqueeGesture extends GestureBase { type: 'marquee'; origin: Point; additive: boolean }
interface CreateGesture extends GestureBase { type: 'create'; origin: Point; seed: Box; others: AABB[]; corner?: Point }
// Line tool — one drag draws a TWO-NODE authored path (plan 96 P2; it made a connector
// edge under plan 90). Both ends are plain canvas points: a line is a path box like any
// pen shape, and attaching an end to a box is P3's bind gesture, not a side effect of
// releasing over one.
interface LineGesture extends GestureBase { type: 'line'; origin: Point; to?: Point }
interface MoveGesture extends GestureBase { type: 'move'; start: Map<number, Rect>; sel: number[]; selAABB: AABB | null; others: AABB[]; moveDelta?: { dx: number; dy: number } }
interface ResizeGesture extends GestureBase { type: 'resize'; index: number; handle: HandleName; startRect: Rect; others: AABB[]; liveRect?: Rect }
interface RotateGesture extends GestureBase { type: 'rotate'; index: number; startRect: Rect; centerClient: Point; pointerStartDeg: number; liveRect?: Rect }
interface GScaleGesture extends GestureBase { type: 'gscale'; sel: number[]; startBoxes: Box[]; anchor: Point; origDist: number; liveBoxes?: Box[] }
interface GRotateGesture extends GestureBase { type: 'grotate'; sel: number[]; startBoxes: Box[]; centre: Point; centerClient: Point; pointerStartDeg: number; liveBoxes?: Box[] }
// Pen tool (Stage D). Drawing is `pendraw` — one gesture per NODE, not one per path, since
// the path itself is a draft that outlives any single press (see `penDraft`). The other
// three belong to node-edit mode on an already-committed path box.
interface PenDrawGesture extends GestureBase { type: 'pendraw'; origin: Point; index: number }
interface PenNodeGesture extends GestureBase {
  type: 'pennode'; origin: Point; indices: number[]; start: SplineNode[]; moved?: boolean;
  /** plan 96 P3 — which END of the path is being dragged, when exactly one END node is.
   *  Set at press; drives the bind affordance during the drag and the write on drop. */
  bindEnd?: 'start' | 'end';
}
interface PenHandleGesture extends GestureBase { type: 'penhandle'; origin: Point; index: number; which: 'in' | 'out'; moved?: boolean }
interface PenMarqueeGesture extends GestureBase { type: 'penmarquee'; origin: Point; additive: boolean }
/** One contour's slice of the combined node-edit path: how many nodes it owns, and the
 *  kind + closed flag to restore when the flat run is split back into real contours. */
interface PenPart { count: number; kind: SplineKind; closed: boolean }
type Gesture = TapGesture | MarqueeGesture | CreateGesture | MoveGesture | ResizeGesture | RotateGesture
  | GScaleGesture | GRotateGesture | PenDrawGesture | PenNodeGesture | PenHandleGesture | PenMarqueeGesture | LineGesture;
type FilledBaseFields = 'pointerId' | 'startClient';
type GestureInit =
  | Omit<TapGesture, FilledBaseFields>
  | Omit<MarqueeGesture, FilledBaseFields>
  | Omit<CreateGesture, FilledBaseFields>
  | Omit<MoveGesture, FilledBaseFields>
  | Omit<ResizeGesture, FilledBaseFields>
  | Omit<RotateGesture, FilledBaseFields>
  | Omit<GScaleGesture, FilledBaseFields>
  | Omit<GRotateGesture, FilledBaseFields>
  | Omit<PenDrawGesture, FilledBaseFields>
  | Omit<PenNodeGesture, FilledBaseFields>
  | Omit<PenHandleGesture, FilledBaseFields>
  | Omit<PenMarqueeGesture, FilledBaseFields>
  | Omit<LineGesture, FilledBaseFields>;

const HANDLES: HandleName[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const SNAP_PX = 6;          // snap threshold in SCREEN px
const SVG = {
  add: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  // Undo/redo — same glyphs as the sidebar header's history buttons (tool.js).
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/>',
  // Z-order family — a filled "object" square + a direction arrow; the front/back
  // pair add an edge bar (the top/bottom of the stack) to read as "all the way".
  // Object below the arrow = moving up (forward/front); above it = moving down.
  front: '<rect x="6" y="13" width="12" height="8" rx="2" fill="currentColor" stroke="none"/><path d="M3 3h18"/><path d="M12 10V6"/><path d="m8.5 9.5 3.5-3.5 3.5 3.5"/>',
  align: '<line x1="3" y1="4" x2="3" y2="20"/><rect x="6" y="7" width="12" height="4" rx="1"/><rect x="6" y="14" width="7" height="4" rx="1"/>',
  // Line tool — a diagonal shaft ending in an arrowhead (draw a line or arrow).
  line: '<path d="M5 19 L19 5"/><path d="M12 5h7v7"/>',
  // Snap-to-grid toggle — a magnet in a box (snapping = magnetic pull to the grid).
  grid: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 15.5V11a3 3 0 0 1 6 0v4.5"/><path d="M7.5 15.5h3"/><path d="M13.5 15.5h3"/>',
  // Auto-arrange the connected cards into a tidy hierarchy.
  tidy: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v3"/><path d="M6 16v-2a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v2"/>',
  dup: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  size: '<path d="M9 3H5a2 2 0 0 0-2 2v4"/><path d="M15 3h4a2 2 0 0 1 2 2v4"/><path d="M15 21h4a2 2 0 0 0 2-2v-4"/><path d="M9 21H5a2 2 0 0 1-2-2v-4"/>',
  // Pages/carousel — a centre "page" card flanked by two peeking page edges.
  pages: '<rect x="8" y="4" width="8" height="16" rx="2"/><path d="M4.5 7v10"/><path d="M19.5 7v10"/>',
  // Frame add-kind + the Frames reorder rail button — the Figma artboard "#" (two
  // pairs of ledger lines running past the edges).
  frame: '<path d="M8 3v18M16 3v18M3 8h18M3 16h18"/>',
  // Drag handle in the Frames reorder list — the classic six-dot grip.
  grip: '<circle cx="9" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="17" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="1.2" fill="currentColor" stroke="none"/>',
  chevUp: '<polyline points="6 15 12 9 18 15"/>',
  chevDown: '<polyline points="6 9 12 15 18 9"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  editText: '<path d="M4 7V5h16v2"/><path d="M9 19h6"/><path d="M12 5v14"/>',
  // Pencil — the "edit text" action (replaces the old 'T' glyph on the object bar).
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  // Type glyph — the Text add-kind + the "Aa" text panel.
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  boxKind: '<rect x="3" y="5" width="18" height="14" rx="2.5"/>',
  // Animation (Lottie) add-kind — a play triangle inside a rounded frame, echoing the picker's "▶ LOTTIE" badge.
  anim: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M10 9l5 3-5 3z"/>',
  // Video add-kind — a film clap/frame with a play triangle (a fatter play than `anim`).
  video: '<rect x="2" y="5" width="15" height="14" rx="2.5"/><path d="M17 9l5-3v12l-5-3z"/><path d="M7 9.5l4 2.5-4 2.5z"/>',
  // Timeline rail toggle — three staggered clip bars with the playhead crossing them,
  // i.e. a picture of the panel it opens. The old glyph (one bar over a tick ruler) read
  // as a comb/toaster at rail size: a ruler alone says "measure", not "clips over time",
  // and nothing in it carried the playhead. Staggered bars are the part people recognise.
  timeline: '<rect x="2.5" y="2.5" width="10" height="5" rx="1.8"/><rect x="7" y="9.5" width="14" height="5" rx="1.8"/><rect x="4" y="16.5" width="9" height="5" rx="1.8"/><path d="M9.5 1v22"/>',
  // Sequence add-kinds: a clip (film strip), a sound (level bars), a nested Lolly tool (spark).
  clipKind: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M8 5v14"/><path d="M16 5v14"/>',
  audioKind: '<path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 4v16"/><path d="M16 8v8"/><path d="M20 11v2"/>',
  toolKind: '<path d="M4 20 14 10"/><path d="m16.5 3.5 1.4 3.6 3.6 1.4-3.6 1.4-1.4 3.6-1.4-3.6L11.5 8.5l3.6-1.4z"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="11" y1="11.5" x2="12" y2="11.5"/><line x1="12" y1="11.5" x2="12" y2="16"/><circle cx="12" cy="8" r="0.7" fill="currentColor" stroke="none"/>',
  // Import a design file (Figma SVG / Penpot) — an arrow rising UP out of a tray
  // (upload/import, not download: the arrowhead apexes at the top, not the tray).
  importFile: '<path d="M12 3v10"/><polyline points="8 7 12 3 16 7"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  // Primary editor-rail action glyphs (Export / Save / Share; Copy reuses `dup`).
  exportUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 14 8"/>',
  shareLink: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  // Shape glyphs for the segmented shape control.
  shRect: '<rect x="4" y="6" width="16" height="12"/>',
  shRounded: '<rect x="4" y="6" width="16" height="12" rx="4.5"/>',
  shPill: '<rect x="3" y="7.5" width="18" height="9" rx="4.5"/>',
  shEllipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  shCircle: '<circle cx="12" cy="12" r="8"/>',
  // Image-fit glyphs.
  fitContain: '<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><rect x="8" y="8.5" width="8" height="7" rx="1"/>',
  fitCover: '<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><path d="M3 16l4.5-3.5L11 15l3-2.2L21 18"/><circle cx="8.5" cy="9" r="1.2"/>',
  fitFill: '<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><polyline points="8 9 5.5 12 8 15"/><polyline points="16 9 18.5 12 16 15"/>',
  fitPos: '<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><circle cx="8" cy="8.5" r="1"/><circle cx="12" cy="8.5" r="1"/><circle cx="16" cy="8.5" r="1"/><circle cx="8" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="16" cy="12" r="1"/><circle cx="8" cy="15.5" r="1"/><circle cx="12" cy="15.5" r="1"/><circle cx="16" cy="15.5" r="1"/>',
  radius: '<path d="M5 19V9a4 4 0 0 1 4-4h10"/><line x1="5" y1="19" x2="5" y2="21"/><line x1="3" y1="19" x2="5" y2="19"/>',
  opacity: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M12 3.5v17"/><path d="M12 5.5h6.5M12 8.5h8M12 11.5h8M12 14.5h8M12 17.5h6.5"/>',
  blend: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6" opacity="0.5"/>',
  shadowIc: '<rect x="3.5" y="3.5" width="12" height="12" rx="2.5"/><path d="M8.5 20.5h10a2 2 0 0 0 2-2v-10" opacity="0.45"/>',
  // Position (4-way move) + rotate glyphs for the position & size panel.
  move: '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 8 16 8"/>',
  forward: '<rect x="6" y="13" width="12" height="8" rx="2" fill="currentColor" stroke="none"/><path d="M12 10V4"/><path d="m8.5 7.5 3.5-3.5 3.5 3.5"/>',
  backward: '<rect x="6" y="3" width="12" height="8" rx="2" fill="currentColor" stroke="none"/><path d="M12 14v6"/><path d="m8.5 16.5 3.5 3.5 3.5-3.5"/>',
  back: '<rect x="6" y="3" width="12" height="8" rx="2" fill="currentColor" stroke="none"/><path d="M3 21h18"/><path d="M12 14v4"/><path d="m8.5 14.5 3.5 3.5 3.5-3.5"/>',
  alignL: '<line x1="4" y1="3.5" x2="4" y2="20.5"/><rect x="7" y="5.5" width="13" height="4.5" rx="1"/><rect x="7" y="14" width="8" height="4.5" rx="1"/>',
  alignC: '<line x1="12" y1="3.5" x2="12" y2="20.5"/><rect x="5" y="5.5" width="14" height="4.5" rx="1"/><rect x="8" y="14" width="8" height="4.5" rx="1"/>',
  alignR: '<line x1="20" y1="3.5" x2="20" y2="20.5"/><rect x="4" y="5.5" width="13" height="4.5" rx="1"/><rect x="9" y="14" width="8" height="4.5" rx="1"/>',
  alignT: '<line x1="3.5" y1="4" x2="20.5" y2="4"/><rect x="5.5" y="7" width="4.5" height="13" rx="1"/><rect x="14" y="7" width="4.5" height="8" rx="1"/>',
  alignM: '<line x1="3.5" y1="12" x2="20.5" y2="12"/><rect x="5.5" y="5" width="4.5" height="14" rx="1"/><rect x="14" y="8" width="4.5" height="8" rx="1"/>',
  alignB: '<line x1="3.5" y1="20" x2="20.5" y2="20"/><rect x="5.5" y="4" width="4.5" height="13" rx="1"/><rect x="14" y="9" width="4.5" height="8" rx="1"/>',
  distH: '<line x1="4" y1="3.5" x2="4" y2="20.5"/><line x1="20" y1="3.5" x2="20" y2="20.5"/><rect x="9" y="7" width="6" height="10" rx="1"/>',
  distV: '<line x1="3.5" y1="4" x2="20.5" y2="4"/><line x1="3.5" y1="20" x2="20.5" y2="20"/><rect x="7" y="9" width="10" height="6" rx="1"/>',
  group: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="6.5" y="6.5" width="5" height="5" rx="1"/><rect x="12.5" y="12.5" width="5" height="5" rx="1"/>',
  ungroup: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  clip: '<rect x="3" y="3" width="12" height="12" rx="2"/><circle cx="15.5" cy="15.5" r="5.5"/>',
  unclip: '<rect x="3" y="3" width="9" height="9" rx="2"/><circle cx="16.5" cy="16.5" r="4.5"/>',
  // Boolean family — the Illustrator/Figma pictograms: two overlapping squares, A at
  // (4,4)-(14,14) and B at (10,10)-(20,20), with the SURVIVING region filled and the
  // discarded one left as a faint outline. Same two squares in all four, so the icons
  // read as one set and the difference between them is only ever what's solid.
  boolUnion: '<path d="M4 4h10v6h6v10H10v-6H4z" fill="currentColor" stroke="none"/>',
  boolSubtract: '<path d="M4 4h10v6h-4v4H4z" fill="currentColor" stroke="none"/><rect x="10" y="10" width="10" height="10" opacity="0.4"/>',
  boolIntersect: '<rect x="4" y="4" width="10" height="10" opacity="0.4"/><rect x="10" y="10" width="10" height="10" opacity="0.4"/><rect x="10" y="10" width="4" height="4" fill="currentColor" stroke="none"/>',
  boolExclude: '<path d="M4 4h10v6h6v10H10v-6H4zM10 10h4v4h-4z" fill="currentColor" stroke="none" fill-rule="evenodd"/>',
  // Outline stroke — a band between two concentric outlines (the stroke, now a shape).
  outlineStroke: '<path d="M3 5h18v14H3zM7 9h10v6H7z" fill="currentColor" stroke="none" fill-rule="evenodd"/>',
  // Offset path — the shape, plus a dashed larger copy of it standing off the edge.
  offsetPath: '<rect x="7" y="9" width="10" height="6" rx="1.5"/><rect x="3.5" y="5.5" width="17" height="13" rx="4" stroke-dasharray="3 2.5" opacity="0.75"/>',
  // Simplify — one smooth curve with only its two end nodes left on it.
  simplify: '<path d="M4 17c4-11 12-11 16 0"/><circle cx="4" cy="17" r="1.8" fill="currentColor" stroke="none"/><circle cx="20" cy="17" r="1.8" fill="currentColor" stroke="none"/>',
  outlineText: '<path d="M5 7V4h14v3M12 4v12"/><path d="M9 20h6"/><rect x="10.2" y="14.2" width="3.6" height="3.6" fill="none"/>',
  // Pointer — the arrow cursor itself, outlined to sit with the rest of the line-art rail.
  // The one glyph in here that names a TOOL by drawing the cursor it gives you.
  pointer: '<path d="M5 2.8l10.9 10.9h-4.8l2.8 6-2.5 1.1-2.8-6L5 18.3z"/>',
  // Pen — the vector PEN TOOL: the wedge nib with its slit, the anchor point it drops,
  // and the blade trailing behind. Deliberately NOT the `pencil` glyph, which already
  // means "edit this box's text" on the object bar. The previous glyph was a fountain
  // pen, which reads as "write/draw freehand" — the one thing this mode does not do;
  // the anchor circle is what says "click to place points" at a glance.
  pen: '<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  // Edit nodes — a curve with its knots exposed, which is what the mode shows.
  nodes: '<path d="M4 18C4 9 12 15 12 9s8 0 8-3"/><rect x="2" y="16" width="4" height="4" rx="0.8" fill="currentColor" stroke="none"/><rect x="10" y="7" width="4" height="4" rx="0.8" fill="currentColor" stroke="none"/><rect x="18" y="4" width="4" height="4" rx="0.8" fill="currentColor" stroke="none"/>',
  // Continuity — the same node with the same two arms, changing only how they relate:
  // hinged (corner), collinear (smooth), collinear and equal (symmetric).
  contCorner: '<path d="M5 19 12 12l7 3"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>',
  contSmooth: '<path d="M4 15h8"/><path d="M12 15h8"/><circle cx="12" cy="15" r="2.4" fill="currentColor" stroke="none"/><circle cx="4" cy="15" r="1.4"/><circle cx="20" cy="15" r="1.4"/>',
  contSymmetric: '<path d="M6 15h12"/><circle cx="12" cy="15" r="2.4" fill="currentColor" stroke="none"/><circle cx="6" cy="15" r="1.4"/><circle cx="18" cy="15" r="1.4"/><path d="M6 19v2"/><path d="M18 19v2"/><path d="M6 20h12"/>',
  // Leave node-editing (the mode's explicit exit, mirroring how a text edit is committed).
  penDone: '<polyline points="4 13 9 18 20 6"/>',
  // Closed path — a loop whose ends have met, with the join node called out.
  penClose: '<path d="M12 5c5 0 7 3 7 7s-2 7-7 7-7-3-7-7 2-7 7-7z"/><circle cx="12" cy="5" r="2.2" fill="currentColor" stroke="none"/>',
  // Stroke — two rules of different weight, which is what the panel behind it sets.
  strokeIc: '<path d="M4 8h16" stroke-width="4.5"/><path d="M4 16h16" stroke-width="1.3"/>',
  // Gradient: a square whose fill ramps, plus the two stop dots the canvas handles are.
  // Drawn with a gradient def rather than hatching so the button reads as what it does
  // even at 16px (the `icon()` wrapper only sets stroke, so the fill is declared here).
  gradIc: '<defs><linearGradient id="fcGradIc" x1="0" y1="0" x2="1" y2="0">'
    + '<stop offset="0" stop-color="currentColor" stop-opacity="0.85"/>'
    + '<stop offset="1" stop-color="currentColor" stop-opacity="0.08"/></linearGradient></defs>'
    + '<rect x="3.5" y="6" width="17" height="12" rx="2.5" fill="url(#fcGradIc)" stroke-width="1.4"/>'
    + '<circle cx="7" cy="12" r="1.6" fill="currentColor" stroke="none"/>'
    + '<circle cx="17" cy="12" r="1.6" fill="none" stroke-width="1.4"/>',
  // Stroke style: one rule, drawn in the style it names. The per-path dash/cap overrides
  // the wrapper's round cap, so each glyph IS a sample of the thing it selects.
  dashSolid: '<path d="M3 12h18" stroke-width="2.6"/>',
  dashDashed: '<path d="M3 12h18" stroke-width="2.6" stroke-dasharray="6 4"/>',
  dashDotted: '<path d="M3.5 12h17" stroke-width="3" stroke-dasharray="0 5"/>',
  // Line ends + corners: a fat stub / elbow drawn WITH the cap or join it selects, so
  // the difference between the three is visible rather than described.
  capButt: '<path d="M7 12h10" stroke-width="7" stroke-linecap="butt"/><path d="M7 5.5v13M17 5.5v13" stroke-width="1" opacity="0.5"/>',
  capRound: '<path d="M7 12h10" stroke-width="7" stroke-linecap="round"/><path d="M7 5.5v13M17 5.5v13" stroke-width="1" opacity="0.5"/>',
  capSquare: '<path d="M7 12h10" stroke-width="7" stroke-linecap="square"/><path d="M7 5.5v13M17 5.5v13" stroke-width="1" opacity="0.5"/>',
  joinMiter: '<path d="M6 19V9l7-6" stroke-width="5" stroke-linejoin="miter" stroke-linecap="butt"/>',
  joinRound: '<path d="M6 19V9l7-6" stroke-width="5" stroke-linejoin="round" stroke-linecap="butt"/>',
  joinBevel: '<path d="M6 19V9l7-6" stroke-width="5" stroke-linejoin="bevel" stroke-linecap="butt"/>',
  // Fill rule — the same two-contour shape, filled by each rule: non-zero fills the
  // inner ring too (same winding), even-odd leaves it as a hole.
  ruleNonzero: '<path d="M4 5h16v14H4zM9 9h6v6H9z" fill="currentColor" stroke="none"/>',
  ruleEvenOdd: '<path d="M4 5h16v14H4zM9 9h6v6H9z" fill="currentColor" stroke="none" fill-rule="evenodd"/>',
  // Text alignment (lines of ragged copy) — distinct from the object-align icons.
  textL: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="17" y2="18"/>',
  textC: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5.5" y1="18" x2="18.5" y2="18"/>',
  textR: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="7" y1="18" x2="20" y2="18"/>',
  textT: '<line x1="4" y1="4" x2="20" y2="4"/><line x1="6" y1="9" x2="18" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/>',
  textM: '<line x1="6" y1="8" x2="18" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="6" y1="16" x2="18" y2="16"/>',
  textB: '<line x1="4" y1="20" x2="20" y2="20"/><line x1="6" y1="15" x2="18" y2="15"/><line x1="8" y1="11" x2="16" y2="11"/>',
  // Reset text formatting — a capital T with a diagonal slash through it.
  resetColor: '<line x1="6" y1="6" x2="18" y2="6"/><line x1="12" y1="6" x2="12" y2="18"/><line x1="4.5" y1="20" x2="19.5" y2="4"/>',
  // Bulleted list — three dotted rows (a list, not a lone bullet).
  bulletList: '<circle cx="4.5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.5" fill="currentColor" stroke="none"/><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/>',
  // Scissors — cut the subject out (host.matte "Remove background").
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>',
};

function icon(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// ── the floating rail's position ──────────────────────────────────────────────

/**
 * Where the detached tool rail may sit, in stage-relative px. Pure numbers so the
 * clamp is honestly testable without a browser — the caller does the measuring.
 *
 * `reserveBottom` is the band at the foot of the stage the rail must never cover
 * (the export pill, wherever a host still shows one). It comes off the TRAVEL range,
 * not off the stage, so a rail taller than the room that is left parks at the top
 * edge rather than at a negative offset.
 */
export function clampRailPos(
  want: { left: number; top: number },
  rail: { w: number; h: number },
  stage: { w: number; h: number },
  o: { pad?: number; reserveBottom?: number } = {},
): { left: number; top: number } {
  const pad = o.pad ?? 8;
  // An unmeasurable stage (a not-yet-laid-out ResizeObserver delivery, a stage that has
  // gone display:none on navigation) must not be clamped against: every axis would
  // collapse to `pad` and the remembered position would be silently lost. Hand the
  // wanted position straight back — placePopover guards the same way.
  if (!(stage.w > 0) || !(stage.h > 0)) return { left: Math.round(want.left), top: Math.round(want.top) };
  const maxLeft = Math.max(pad, stage.w - rail.w - pad);
  const maxTop = Math.max(pad, stage.h - rail.h - pad - Math.max(0, o.reserveBottom ?? 0));
  return {
    left: Math.round(Math.min(Math.max(want.left, pad), maxLeft)),
    top: Math.round(Math.min(Math.max(want.top, pad), maxTop)),
  };
}

/**
 * Where a rail/anchor popover goes, in stage-relative px. It prefers the anchor's
 * right (the docked rail's long-standing behaviour, unchanged while the rail sits on
 * the left edge) and FLIPS to its left when that would overflow the stage.
 *
 * The flip only started mattering when the rail became draggable: a rail parked in the
 * right half of a `overflow:hidden` stage (carousel-maker and record are `.is-paged`)
 * used to open its menu straight out through the clipped edge. Vertically the popover
 * is pulled up to keep its foot inside rather than being pinned to the anchor's top.
 *
 * Pure numbers, so the geometry is testable without a browser.
 */
export function placePopover(
  anchor: { left: number; right: number; top: number },
  pop: { w: number; h: number },
  stage: { w: number; h: number },
  gap = 8,
  pad = 6,
): { left: number; top: number } {
  const rightSide = anchor.right + gap;
  const leftSide = anchor.left - gap - pop.w;
  // No measurable stage (detached / display:none / jsdom, which has no layout at all):
  // there is nothing to clamp against, so keep the plain anchored placement rather than
  // inventing a position from zeroes.
  if (!(stage.w > 0) || !(stage.h > 0)) return { left: rightSide, top: Math.max(pad, anchor.top) };
  // Flip only if the left side is genuinely better: on a stage too narrow for either,
  // stay on the preferred side and let the clamp do what it can.
  const left = (rightSide + pop.w > stage.w - pad && leftSide >= pad) ? leftSide : rightSide;
  const maxTop = Math.max(pad, stage.h - pop.h - pad);
  return {
    left: Math.round(Math.max(pad, Math.min(left, Math.max(pad, stage.w - pop.w - pad)))),
    top: Math.round(Math.min(Math.max(anchor.top, pad), maxTop)),
  };
}

// ── the contextual bar's position ─────────────────────────────────────────────

/** A stage-relative box, in stage px. */
interface StageBox { left: number; top: number; right: number; bottom: number }

/** The top-chrome-row band the contextual bar is pinned into, in stage-relative px. */
export interface CtxTopBand { lo: number; hi: number; top: number }

/**
 * The free horizontal band on the top-chrome row where the contextual bar sits.
 *
 * The bar used to float ABOVE (or inside) the selection, which put it right over the very
 * artwork the user was looking at — the thing they were dragging or resizing. So it is
 * pinned to the TOP now, on the same line as the back pill (top-left) and the zoom HUD
 * (top-right): the band runs from the right edge of the left-corner chrome to the left
 * edge of the right-corner chrome, so all three read as one row at every width and none
 * can overlap another — the "layout harmony" the narrow mobile top row needs.
 *
 * `blockers` are that fixed chrome in stage coordinates, measured by the caller (so this
 * stays pure numbers and honestly testable without a browser — the same bargain
 * clampRailPos makes). A blocker whose centre is left of the stage centre bounds the band
 * on the left (the back pill); one to the right bounds it on the right (the zoom HUD). The
 * shared `top` aligns the bar with that chrome so the three sit on one line.
 *
 * The caller caps the bar to `hi - lo` and lets it scroll inside that width (see the
 * `.fc-ctxbar` overflow), so a bar too wide for the band — a phone — becomes a scrolling
 * strip on the row rather than a bar that drops down over the canvas.
 */
export function ctxTopBand(
  stage: { w: number; h: number },
  blockers: StageBox[] = [],
  o: { pad?: number; gap?: number } = {},
): CtxTopBand {
  const pad = o.pad ?? 6;
  const gap = o.gap ?? 8;
  // An unmeasurable stage (display:none, a pre-layout ResizeObserver delivery, jsdom)
  // gives nothing to bound against — hand back a padded strip at the top rather than
  // inventing a band from zeroes, exactly as clampRailPos and placePopover do.
  if (!(stage.w > 0)) return { lo: pad, hi: pad, top: pad };
  const live = blockers.filter((b) => b.right > b.left && b.bottom > b.top);
  let lo = pad;
  let hi = Math.max(pad, stage.w - pad);
  // Align the bar's top with the chrome row (its topmost blocker); with no chrome to
  // align to, the plain pad.
  const top = live.length ? Math.max(pad, Math.min(...live.map((b) => b.top))) : pad;
  const cx = stage.w / 2;
  for (const b of live) {
    if ((b.left + b.right) / 2 <= cx) lo = Math.max(lo, b.right + gap);   // back pill, left
    else hi = Math.min(hi, b.left - gap);                                  // zoom HUD, right
  }
  return { lo, hi: Math.max(lo, hi), top };
}

/**
 * Centre a bar of width `bw` in the band. A bar wider than the band pins to `lo` — its
 * own `overflow-x` scrolls the rest of its controls into reach — so it never pushes past
 * `hi` into the chrome on the right.
 */
export function centreCtxBar(bw: number, band: CtxTopBand): { left: number; top: number } {
  const room = band.hi - band.lo;
  const left = bw >= room ? band.lo : band.lo + (room - bw) / 2;
  return { left: Math.round(left), top: Math.round(band.top) };
}

/**
 * The dragged rail position — CHROME state, exactly like zoom and pan. It lives in
 * the module for the life of the page and deliberately reaches neither the URL, the
 * box model, nor a saved session; a reload puts the rail back on its docked edge.
 * Shared by every free-canvas tool: one editor, one remembered spot for its tools.
 */
let railSession: { left: number; top: number } | null = null;

// Weight menu (shared by the Text panel and the in-edit format bar). Mono cuts
// rarely ship a Black — their variable axes top out at 800 — so the mono menu
// stops at Extrabold (both profiles' hooks.js + the vector exporter cap it the
// same way; mono detection lives in isMonoFont inside initFreeCanvas).
const WEIGHT_CHOICES: Array<[string, string]> = [
  ['100', 'Thin'], ['200', 'Extra light'], ['300', 'Light'], ['400', 'Regular'],
  ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extrabold'], ['900', 'Black'],
];
// Fallback font menu for editor tools whose manifest doesn't declare a font
// select — the historical hard-coded pair, so such tools keep working unchanged.
const FALLBACK_FONT_OPTIONS: FontOption[] = [
  { value: 'SUSE', label: 'SUSE Sans' },
  { value: 'SUSE Mono', label: 'SUSE Mono' },
];
// Live-preview font stacks — kept byte-for-byte in step with the shipped
// layout-studio hooks.js FONTS maps (SUSE profile: 'SUSE'/'SUSE Mono';
// lolly-start: 'sans'/'mono') so the in-edit preview matches the committed
// render and the vector export exactly. Wire values not listed here derive a
// stack from the value itself (fontStackFor inside initFreeCanvas).
const FONT_STACK: Record<string, string> = {
  'SUSE Mono': "'SUSE Mono', ui-monospace, SFMono-Regular, monospace",
  'SUSE': "'SUSE', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  'mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  'sans': "var(--font-brand, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif)",
};
/**
 * The arrowhead vocabulary (plan 96 P1) — EXACTLY the strings `edgeArrowHead` in
 * engine/src/connectors.ts branches on, and in its order, because a spline, a line and a
 * connector are one primitive and must not offer two different sets of heads. Anything
 * outside this list falls through to the engine's triangle, which is why the menu is
 * closed rather than free text.
 */
const HEAD_CHOICES: Array<[string, string]> = [
  ['none', 'None'], ['triangle', 'Arrow'], ['open', 'Open arrow'],
  ['circle', 'Circle'], ['diamond', 'Diamond'], ['bar', 'Bar'],
];
/**
 * The route choices a BOUND path offers (plan 96 P3), in the engine's own order. '' is
 * "auto", i.e. read the route off the spline kind — which is what an unbound path has
 * always done and what a bound one does until someone says otherwise. The other thirteen
 * are `CONNECTOR_ROUTE_STYLES`, spelled with their labels here because six spline kinds
 * cannot name thirteen routes.
 */
const ROUTE_CHOICES: Array<[string, string]> = [
  ['', 'Auto, from the spline type'],
  ['straight', 'Straight'],
  ['elbow', 'Elbow, auto'], ['elbow-v', 'Elbow, vertical'], ['elbow-h', 'Elbow, horizontal'],
  ['elbow-src', 'Elbow, bend at the start'], ['elbow-tgt', 'Elbow, bend at the end'],
  ['curved', 'Curved, auto S'], ['curved-v', 'Curved, vertical S'], ['curved-h', 'Curved, horizontal S'],
  ['arc', 'Arc, bow'], ['arc-wide', 'Arc, wide bow'],
  ['arc-flip', 'Arc, reverse bow'], ['arc-flip-wide', 'Arc, wide reverse bow'],
];

/** Is a dash pattern relevant to this box? A dash keyword is on, OR an array is already
 *  authored — the second half is what stops a stored pattern becoming unreachable the
 *  moment someone flips the keyword back to Solid. */
function dashRowOn(styleVal: string, arrVal: string): boolean {
  return styleVal === 'dashed' || styleVal === 'dotted' || String(arrVal).trim() !== '';
}
// ligatures default ON (off → disable liga/clig); alternates default OFF (on → salt).
function featureSettings(ligOn: boolean, altOn: boolean): string {
  const feat: string[] = [];
  if (!ligOn) feat.push('"liga" 0', '"clig" 0');
  if (altOn) feat.push('"salt" 1');
  return feat.join(', ');   // '' = browser default (ligatures on, no alternates)
}
// A short, unambiguous marker for layout objects copied INSIDE the editor. The
// serialized boxes ride the OS clipboard behind it, so ⌘V pastes (duplicates)
// them — even across a reload — while ordinary copied text still lands as a new
// text box. Kept in-memory too, in case a browser blocks the clipboard read.
const FC_CLIP_PREFIX = 'lolly/layout-boxes:';
// Coerce a manifest/model boolean (real boolean or "true"/"1"/"on" string) — mirrors
// hooks.js boolVal so the editor previews match the render.
function boolOf(v: any, dflt: boolean): boolean {
  if (v === true || v === false) return v;
  if (v == null || v === '') return dflt;
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return dflt;
}
// Flex mappings for the align/valign live preview — must mirror hooks.js boxCss.
const H_JUSTIFY: Record<string, string> = { left: 'flex-start', center: 'center', right: 'flex-end' };
const V_ALIGN: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };

export function initFreeCanvas(opts: InitFreeCanvasOpts): FreeCanvasHandle {
  const { viewEl, stageEl, canvasEl, runtime, host, input, nativeW, nativeH, onDirty, editTool, setCanvasSize, info, history, actions, pages, frame: frameCfg } = opts;
  let dirtyObserver: MutationObserver | null = null;   // mirrors the Save icon's unsaved cue (see buildToolbar/actions)
  // The artboard is resizable, so read its CURRENT declared size (not the mount-time
  // nativeW/H) everywhere geometry depends on the canvas dimensions.
  const canvasWH = (): Canvas => ({
    w: parseInt(canvasEl.style.width, 10) || nativeW,
    h: parseInt(canvasEl.style.height, 10) || nativeH,
  });
  const cv: CanvasCfg = input.canvas || {};
  const blockId = input.id;
  const cfg = ({
    idField: cv.idField || 'id',
    xField: cv.xField || 'x', yField: cv.yField || 'y',
    wField: cv.wField || 'w', hField: cv.hField || 'h',
    rotationField: cv.rotationField || 'rot',
    fillField: cv.fillField, gradField: cv.gradField, opacityField: cv.opacityField, shapeField: cv.shapeField,
    radiusField: cv.radiusField, imageField: cv.imageField, fitField: cv.fitField, imgPosField: cv.imgPosField,
    blendField: cv.blendField, textField: cv.textField, textColorField: cv.textColorField,
    fontSizeField: cv.fontSizeField, alignField: cv.alignField, valignField: cv.valignField,
    weightField: cv.weightField, fontField: cv.fontField, lineHeightField: cv.lineHeightField,
    trackingField: cv.trackingField, ligaturesField: cv.ligaturesField, alternatesField: cv.alternatesField,
    padField: cv.padField, fitTextField: cv.fitTextField, groupField: cv.groupField, clipField: cv.clipField,
    shadowField: cv.shadowField, shadowColorField: cv.shadowColorField,
    shadowXField: cv.shadowXField, shadowYField: cv.shadowYField, shadowBlurField: cv.shadowBlurField,
    kindField: 'kind',
    // `pathField` is left un-defaulted on purpose: it is the feature flag, so a manifest
    // that omits it must resolve to undefined. The other three DO default, to the same
    // names as vector-ops' DEFAULT_VECTOR_FIELDS — the shipped Layout Studio manifests
    // append the `stroke`/`strokeW`/`fillRule` sub-fields but only declare `pathField` on
    // the canvas block, and the overlay has to read the same field the ops write.
    pathField: cv.pathField,
    strokeField: cv.strokeField || 'stroke',
    strokeWField: cv.strokeWField || 'strokeW',
    fillRuleField: cv.fillRuleField || 'fillRule',
    strokeDashField: cv.strokeDashField || 'strokeDash',
    strokeCapField: cv.strokeCapField || 'strokeCap',
    strokeJoinField: cv.strokeJoinField || 'strokeJoin',
    // Plan 96 P0. Same defaulting rule as the three above and for the same reason: the
    // shipped manifests declare these on the canvas block AND as `boxes` sub-fields, and
    // a tool that predates them simply has no box carrying the field, so every read below
    // resolves to '' / false and every write lands on a row nothing reads.
    strokeDashArrayField: cv.strokeDashArrayField || 'strokeDashArray',
    dashFitField: cv.dashFitField || 'dashFit',
    headStartField: cv.headStartField || 'headStart',
    headEndField: cv.headEndField || 'headEnd',
    bindStartField: cv.bindStartField || 'bindStart',
    bindEndField: cv.bindEndField || 'bindEnd',
    routeField: cv.routeField || 'route',
  }) as FieldCfg;
  // The vector operations' own field view. `cfg` is a superset of `VectorFieldConfig`
  // and vector-ops resolves each name defensively (a non-string falls back to the
  // Layout Studio default), so the resolved config is handed over unchanged.
  // Null until the manifest declares `canvas.pathField` — see CanvasCfg.pathField.
  const vectorCfg: VectorFieldConfig | null = cv.pathField ? cfg : null;
  // Plan 96's path decorations are DECLARED, not defaulted-into-existence: the field names
  // above default (so the reads are simple), but a tool that never named them in its canvas
  // block has a hooks.js that cannot draw an arrowhead or an authored dash pattern, and
  // authoring one into its boxes would store a decoration the render silently ignores —
  // worse, one the compact URL drops on the way out because the field is undeclared. Both
  // Layout Studio packs declare the set; Sequence Studio (the other `pathField` tool) does
  // not, so it gets the Line tool and no head controls, which is exactly what it can draw.
  const hasHeadCfg = !!(cv.headStartField || cv.headEndField);
  const hasBindCfg = !!(cv.bindStartField || cv.bindEndField);
  const hasRouteCfg = !!cv.routeField;
  /** The committed bound-path layer's class, hidden while a drag re-routes it live. */
  const boundLayerClass = cv.pathLayerClass || 'lolly-connectors';
  const hasDashArrayCfg = !!cv.strokeDashArrayField;
  const unwrapColor = (v: ColorFieldValue) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
  const minSize = cv.minSize ?? 8;
  // ── Manifest-driven typography ────────────────────────────────────────────────
  // The Text panel + format-bar font menus are built from the tool's OWN declared
  // font select (the blocks field named by canvas.fontField), so the editor writes
  // exactly the wire values the tool's hooks.js understands under any profile
  // (SUSE: 'SUSE'/'SUSE Mono'; lolly-start: 'sans'/'mono'). Tools without a font
  // field declaration fall back to the historical hard-coded pair.
  const fontFieldDef = cfg.fontField ? (input.fields || []).find((f) => f.id === cfg.fontField) : undefined;
  const fontOptions: FontOption[] = (fontFieldDef?.options?.length ? fontFieldDef.options : FALLBACK_FONT_OPTIONS)
    .map((o) => ({ value: String(o.value ?? ''), label: String(o.label || o.value || '') }));
  const defaultFont = String(fontFieldDef?.default || fontOptions[0]!.value);
  // Mono detection mirrors hooks.js weightOf (/mono/i on the wire value; the label
  // covers manifests whose values don't self-describe). Mono cuts rarely ship a
  // Black, so the weight menu and the font-change clamp cap mono at 800.
  const isMonoFont = (font: any): boolean => {
    const v = String(font);
    return /mono/i.test(v) || fontOptions.some((o) => o.value === v && /mono/i.test(o.label));
  };
  const maxWeightFor = (font: any): number => (isMonoFont(font) ? 800 : 900);
  const weightChoicesFor = (font: any): Array<[string, string]> =>
    WEIGHT_CHOICES.filter(([v]) => +v <= maxWeightFor(font));
  // Live-preview stack: exact hooks.js stacks for the known wire values; other
  // declared options derive one from the value (leading family + a generic tail);
  // unknown/empty values preview as the manifest's default font, mirroring
  // hooks.js fontFamily's fallback.
  const stackOf = (s: string): string => FONT_STACK[s] || (isMonoFont(s)
    ? `'${s}', ui-monospace, SFMono-Regular, monospace`
    : `'${s}', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`);
  const fontStackFor = (v: any): string => {
    const s = String(v ?? '');
    // Installed user-font families count too: hooks.js already paints any brand
    // font the kit carries, so the format-bar overlay must preview it rather
    // than coercing the preview to the default face.
    return s && (fontOptions.some((o) => o.value === s) || brandFontFamilies().includes(s))
      ? stackOf(s) : stackOf(defaultFont);
  };
  const fontOptionsHtml = (cur?: any): string => fontOptions.map((o) =>
    `<option value="${escapeHtml(o.value)}"${String(cur) === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  // ── Manifest-driven shape control ─────────────────────────────────────────────
  // The "More" panel's shape segment is built from the tool's OWN declared shape
  // options — NOT a fixed list — so a tool only ever offers shapes its hooks.js can
  // render (e.g. `circle` is Layout Studio only; Carousel/Org-chart/Record don't
  // declare it, so it never shows there and can't produce a broken square). A known
  // value gets its glyph; anything else falls back to its label text.
  const SHAPE_ICON: Record<string, string> = {
    rect: SVG.shRect, rounded: SVG.shRounded, pill: SVG.shPill, ellipse: SVG.shEllipse, circle: SVG.shCircle,
  };
  const shapeFieldDef = cfg.shapeField ? (input.fields || []).find((f) => f.id === cfg.shapeField) : undefined;
  const shapeChoices: Array<[string, string, string?]> = (shapeFieldDef?.options || [])
    .map((o) => [String(o.value ?? ''), t(String(o.label || o.value || '')), SHAPE_ICON[String(o.value ?? '')]]);
  const addKinds: AddKind[] = Array.isArray(cv.addKinds) && cv.addKinds.length
    ? cv.addKinds : [{ id: 'box', label: 'Box', seed: {} }];
  // Opt-in design-file import (Figma SVG / Penpot). Falsy for Layout Studio, whose
  // canvas config has no `import` key — so its toolbar is unchanged.
  const importCfg = cv.import || null;
  // Brand vocabulary for the importer (engine DesignMapOptions): imported text maps
  // onto the tool's OWN font select values (SUSE: 'SUSE'/'SUSE Mono'; lolly-start:
  // 'sans'/'mono'), and box seed colours come from its addKinds seeds — so an import
  // is indistinguishable from natively-authored boxes under any profile. Fields the
  // manifest doesn't declare stay undefined → the engine's neutral defaults apply.
  const importMap = (() => {
    const monoOpt = fontOptions.find((o) => isMonoFont(o.value));
    // '' is a real seed value (transparent fill — e.g. record's image seed), so only
    // a missing/non-string seed defers to the engine default.
    const seedColor = (kindId: string, field: string): string | undefined => {
      const seed = addKinds.find((k) => k.id === kindId)?.seed;
      const v = seed ? seed[field] : undefined;
      return typeof v === 'string' ? v : undefined;
    };
    return {
      fonts: {
        defaultFamily: defaultFont,
        ...(monoOpt ? { monoFamily: monoOpt.value, monoMaxWeight: maxWeightFor(monoOpt.value) } : {}),
        // Every family the shell can actually resolve — the manifest's own wire
        // values plus installed user fonts — passes through mapFontFamily
        // verbatim instead of bucketing to the two-family vocabulary.
        knownFamilies: [...new Set([...fontOptions.map((o) => o.value), ...brandFontFamilies()])],
      },
      seedColors: {
        boxBg: seedColor('box', cfg.fillField || 'bg'),
        textFg: seedColor('text', cfg.textColorField || 'fg') || undefined, // text ink must be a colour
        imageBg: seedColor('image', cfg.fillField || 'bg'),
      },
    };
  })();
  // Opt-in connector authoring (Org Chart). The connect config names a SECOND blocks
  // input that stores {from,to} edges; the overlay authors them and draws a live
  // preview, but the tool's hooks.js owns the actual routed line geometry. Falsy for
  // every other editor tool, so their toolbars/gestures are unchanged.
  const connectCfg: ConnectCfg | null = cv.connect && cv.connect.input ? {
    input: cv.connect.input,
    fromField: cv.connect.fromField || 'from',
    toField: cv.connect.toField || 'to',
    styleField: cv.connect.styleField, arrowField: cv.connect.arrowField, headField: cv.connect.headField,
    colorField: cv.connect.colorField, dashField: cv.connect.dashField, widthField: cv.connect.widthField,
    layerClass: cv.connect.layerClass || 'oc-connectors',
    defaultStyle: cv.connect.defaultStyle || 'elbow',
    defaultArrow: cv.connect.defaultArrow || 'end',
    defaultHead: cv.connect.defaultHead || 'triangle',
    defaultColor: cv.connect.defaultColor || '#94a3b8',
    defaultWidth: cv.connect.defaultWidth ?? 2.5,
  } : null;
  // Opt-in TIME model (phase 1). A tool is "time-capable" only when its canvas config
  // maps ALL TEN time sub-fields — a partial mapping would give the panel somewhere to
  // read from but nowhere to write, so it is treated as absent.
  //
  // Two tools qualify today: Sequence Studio and Layout Studio (both declare the phase-1
  // time model in their canvas block). Carousel Maker, Org Chart, Record and every other
  // editor map none of them, so `timeCfg` is null there and every timeline branch below
  // is dead code for them — no rail button, no lazy chunk, no stage reserve, no listener.
  // On an UNTIMED Layout Studio composition the cost is one extra rail button and nothing
  // else: `anyTimed()` is false, so the panel never auto-opens and its chunk is never
  // fetched until the user asks for it.
  //
  // `idField` comes from the resolved cfg: the panel keys clips by the box id FIELD,
  // exactly as the overlay's selection does.
  const timeCfg: TimeCfg | null = (cv.startField && cv.durField && cv.clipInField && cv.speedField
    && cv.enterField && cv.exitField && cv.enterMsField && cv.exitMsField && cv.muteField && cv.laneField)
    ? {
      startField: cv.startField, durField: cv.durField, clipInField: cv.clipInField,
      speedField: cv.speedField, enterField: cv.enterField, exitField: cv.exitField,
      enterMsField: cv.enterMsField, exitMsField: cv.exitMsField, muteField: cv.muteField,
      laneField: cv.laneField, idField: cfg.idField,
      // OPTIONAL, and deliberately outside the ten-field presence check above: a tool
      // that declares no link sub-field is still fully time-capable, it just never
      // offers "Detach audio" (progressive capability — Layout Studio opts in later).
      linkField: cv.linkField || '',
      // Also optional, for the same reason: the authored easing curves are additive on
      // top of a time model that was complete without them, so a manifest that declares
      // no ease sub-fields keeps every preset on its built-in curve.
      enterEaseField: cv.enterEaseField || '',
      exitEaseField: cv.exitEaseField || '',
      // Same again: a shared group collapses overlays onto one panel lane row
      // (generated captions), and a tool without a group field never groups.
      groupField: cv.groupField || '',
    } : null;
  // Scene-mode import (`canvas.import.mode: 'scenes'`, e.g. Sequence Studio): an
  // imported design's frames land as timed clips appended to the main sequence
  // instead of replacing the canvas. An explicit manifest opt-in — Layout Studio
  // also declares the time model, and its import must keep replacing the board.
  const importScenesMode: boolean = !!(timeCfg && importCfg
    && (importCfg as { mode?: unknown }).mode === 'scenes');

  // Opt-in snap-to-grid. gridOn is toggled from the rail; gridSize is native px.
  const gridSize = Math.max(2, Math.round(cv.grid?.size ?? 20));
  let gridOn = !!(cv.grid && cv.grid.default !== false);

  // ── state ──────────────────────────────────────────────────────────────────
  let selection = new Set<string>();   // box ids
  // Selection change-notifier for the timeline panel. `selection` is assigned from ~20
  // sites, but EVERY one of them reaches paintChrome (directly via renderChrome /
  // renderChromeLive, or via commit → runtime.subscribe → scheduleSync), so the fire
  // lives in exactly one place (top of paintChrome) and is guarded by a signature —
  // a repaint with an unchanged selection is not a change. No write site is touched.
  const selListeners = new Set<() => void>();
  let selNotifyKey: string | null = null;
  function notifySelection(): void {
    if (!selListeners.size) return;
    const k = [...selection].sort().join(',');
    if (k === selNotifyKey) return;
    selNotifyKey = k;
    for (const f of [...selListeners]) { try { f(); } catch (e) { console.error(e); } }
  }
  let multiTapMode = false;            // touch: taps ADD to the selection (Group/Align need ≥2)
  /**
   * THE tool mode — see `setMode`. Every mode used to be its own boolean, which is exactly
   * why they could all be true at once.
   */
  let mode: EditorMode = 'select';
  // The Node tool (Inkscape's `N`): a sub-mode of 'select' where a single click on a path
  // box jumps straight into node editing rather than selecting it. A flag, not a 5th
  // EditorMode, because `setMode` ends any `penEdit` session — the very thing this tool
  // wants to keep — so a real mode would fight that invariant. Mutually exclusive with the
  // other tools: picking pen/create/connect (or the plain pointer) clears it.
  let nodeToolActive = false;
  let armedKind: AddKind | null = null;        // the create gesture's seed; set iff mode === 'create'
  let gesture: Gesture | null = null;          // active pointer gesture
  let editing: EditingState | null = null;     // { id, el, prev } while editing a box's text inline
  let disposed = false;
  let bindHover: string | null = null;          // the box an end node would attach to on drop
  let liveConnectHidden = false;                // the tool's real bound-path layer is hidden mid-drag
  let selectedEdges = new Set<string>();        // connector ids being inspected (click / shift-click / marquee)
  let edgePanel: HTMLElement | null = null;     // the connector-properties popover
  let hoverEdge: string | null = null;          // connector id under the cursor (hover affordance)
  let hoverRaf = 0;
  let lastMenuAt: Point = { x: 0, y: 0 };       // where the context menu was last opened (client px)

  // ── pen tool state (Stage D) ────────────────────────────────────────────────
  // Two things, never both: `mode === 'pen'` DRAWS a new path; `penEdit` edits a committed
  // one. Point editing is NOT a fifth mode — it is a sub-state of the pointer, entered by
  // double-clicking a path exactly as a text edit is (see `setMode`).
  //
  // The draft lives here in NATIVE canvas px and NOT in the model, which is the whole
  // answer to "what happens if the user pans/zooms or the model syncs mid-draw": a pan or
  // zoom only changes the native→screen mapping, so the draft is unaffected and its
  // preview is simply repainted from the same numbers; and a model sync (another actor, an
  // undo) cannot disturb a draft that is not in the model. The single commit reads
  // `getBoxes()` at commit time, so it appends to whatever the array is by then rather
  // than to a stale snapshot.
  let penDraft: AuthoredPath | null = null;      // nodes in NATIVE px; null = not drawing
  let penCursor: Point | null = null;            // live end of the segment under the cursor
  // ALL of a field's contours are edited at once (a boolean with a hole, or outlined text
  // that is one path box of many glyph contours). They share ONE box-local coordinate space
  // (one frame), so `path` is a COMBINED AuthoredPath whose `nodes` are every contour's nodes
  // concatenated in order — every position op (move / drag a handle / align / distribute /
  // continuity / hit-test / marquee) runs on it unchanged, and `penSel` indexes into it flat.
  // `parts` records how to split that flat run back into real per-contour paths (each keeps
  // its own kind + closed): the write re-encodes every contour, the frame fits every contour,
  // and render / insert / delete are the only part-AWARE ops. `path.kind` is the first part's
  // kind (uniform across the contours every producer here makes — all cubic — so it governs
  // handle display + default continuity correctly). A single-contour box has one part and is
  // byte-identical to the old single-`path` model. All DENORMALISED to box-local px.
  let penEdit: { id: string; path: AuthoredPath; parts: PenPart[]; frame: PenFrame } | null = null;
  let penSel = new Set<number>();                // selected node indices while editing
  // Selected CONTROL POINTS (handles) while editing — keys `${nodeIndex}:in` / `:out`.
  // Built by shift-clicking a handle; align/distribute operate on nodes ∪ these. Kept
  // separate from penSel so a handle is a point in its own right, not tied to its node.
  let penHandleSel = new Set<string>();
  // Node-edit selection mode: false = a marquee picks NODES only (default); true = it also
  // picks CONTROL POINTS. A session-scoped preference toggled from the node-edit bar.
  let penSelectHandles = false;
  // The previous frame's hyperbezier solution, reused as the `warm` start. A 40-node solve
  // re-converged from the chord-bend guess costs an O(n) Newton run per pointermove; warm,
  // it costs one or two steps. This is exactly what `toCubics`' `warm` parameter is for.
  let penWarm: HyperbezierSolution | null = null;
  const PEN_HIT_PX = 9;                          // grab radius for a node/handle, SCREEN px
  const PEN_CURVE_PX = 7;                        // "on the curve" band for insert, SCREEN px
  const PEN_PULL_MIN = 3;                        // drag past this and a click became a handle PULL, SCREEN px
  // Alt during a `pendraw` drag BREAKS the handle pair, and latches for the rest of that
  // drag rather than being read fresh each move: a break is a declaration about the node,
  // not a per-frame state, and reading it live makes the corner flicker back to smooth on
  // any move event that happens to arrive without the modifier.
  let penPullBroken = false;
  // The paint the user last put on a path, so the NEXT path they draw matches it — the
  // drawing-app convention, and the reason a session of pen work doesn't mean recolouring
  // every shape. Session-only (never persisted, never in the model): it is a memory of an
  // action, not a property of the document. Set from a paint write to a path selection and
  // from each commit, so consecutive draws agree even before anything is recoloured.
  let penLastPaint: Box | null = null;
  /** The canvas config's paint sub-field names, as the pure pen helpers want them. */
  const penPaintFields: PathPaintFields = {
    fill: cfg.fillField, stroke: cfg.strokeField,
    strokeW: cfg.strokeWField, fillRule: cfg.fillRuleField,
  };

  // ── model access ─────────────────────────────────────────────────────────
  const getBoxes = (): Box[] => {
    const e = runtime.getModel().find((i) => i.id === blockId);
    return Array.isArray(e?.value) ? e!.value : [];
  };
  const bgInputId = 'background';
  const getBg = (): any => runtime.getModel().find((i) => i.id === bgInputId)?.value ?? '#ffffff';

  const idOf = (b: Box | undefined, i: number): string => (b && b[cfg.idField] != null && b[cfg.idField] !== '' ? String(b[cfg.idField]) : String(i));
  const selIndices = (boxes: Box[]): number[] => boxes.reduce<number[]>((a, b, i) => (selection.has(idOf(b, i)) ? (a.push(i), a) : a), []);
  const indexOfId = (boxes: Box[], id: string | undefined): number => boxes.findIndex((b, i) => idOf(b, i) === id);
  const groupOf = (b: Box | undefined): string => (cfg.groupField && b && b[cfg.groupField] ? String(b[cfg.groupField]) : '');
  const groupMemberIds = (boxes: Box[], g: string): string[] => boxes.reduce<string[]>((a, b, i) => (groupOf(b) === g ? (a.push(idOf(b, i)), a) : a), []);
  // The ids selected when box `i` is clicked: its whole group (if any), unless
  // `soloBox` (Alt-click) drills in to just that one box.
  function selectionForHit(boxes: Box[], i: number, soloBox: boolean): string[] {
    const g = groupOf(boxes[i]);
    return (soloBox || !g) ? [idOf(boxes[i], i)] : groupMemberIds(boxes, g);
  }

  /**
   * Frame-aware selection pick (plan 92, ISSUE 2a). Two passes over the SAME hitTest:
   * first the topmost NON-frame box under the point, and only when none is hit does the
   * topmost frame (artboard) take the click. So clicking a child selects the child, and
   * clicking an artboard's own empty area / edge selects the artboard — regardless of
   * array order, which fixes the appended-frame-swallows-its-children bug (an Add-menu
   * frame is pushed last → topmost → a plain hitTest would let it eat every child click).
   * Frame-agnostic docs (no frameCfg) fall straight through to the ordinary hitTest, and
   * the shared hitTest used by connect/line/node modes is deliberately NOT routed here.
   */
  function selectHit(boxes: Box[], px: number, py: number): number {
    const skip = seqHiddenSkip(boxes);
    if (!frameCfg) return pickTopmost(boxes, px, py, cfg, skip);
    const fk = frameCfg.frameKind;
    const isFrame = (i: number): boolean => String(boxes[i]?.[cfg.kindField]) === fk;
    const nonFrame = pickTopmost(boxes, px, py, cfg, (i) => (skip ? skip(i) : false) || isFrame(i));
    if (nonFrame >= 0) return nonFrame;
    return pickTopmost(boxes, px, py, cfg, skip);
  }

  let idSeq = 0;
  function freshId(boxes: Box[]): string {
    // Short, collision-checked id (Math.random is fine in the browser shell).
    const used = new Set(boxes.map((b, i) => idOf(b, i)));
    let id: string;
    do { id = 'b' + (Date.now().toString(36).slice(-4)) + (idSeq++).toString(36) + Math.floor(Math.random() * 46656).toString(36); }
    while (used.has(id));
    return id;
  }

  function commit(nextBoxes: Box[]): void {
    onDirty?.(blockId);
    runtime.setInput(blockId, nextBoxes);
  }

  // ── frame containment-on-drop (plan 93 F1b-1) ────────────────────────────────
  // Re-bucket the boxes TOUCHED by a gesture (by array index) into the frame their
  // centre now falls inside — the drop half of the frame primitive. Pure + gated on
  // `frameCfg`: dead (returns nextBoxes unchanged) for every tool whose canvas
  // declares no frameField, so no-frames documents are untouched. A frame-kind box
  // never gets a `frame` membership here (its own move/cascade is a later slice);
  // resolveFrame is idempotent, so a box that didn't change frames keeps its identity
  // (no spurious new object → no needless re-render churn). `touched` are indices into
  // `nextBoxes`; every gesture that calls this preserves index alignment (append for
  // create, in-place map for move/resize/scale), so indices stay valid.
  function assignFrames(nextBoxes: Box[], touched: Set<number>): Box[] {
    if (!frameCfg) return nextBoxes;
    const ff = frameCfg.frameField;
    const fk = frameCfg.frameKind;
    const frameBoxes = nextBoxes.filter((b) => String(b?.[cfg.kindField]) === fk);
    return nextBoxes.map((b, i) => {
      if (!touched.has(i) || !b) return b;
      if (String(b[cfg.kindField]) === fk) return b;   // a frame keeps frame='' (no self-nesting)
      const fid = resolveFrame(b, frameBoxes);
      return String(b[ff] ?? '') === fid ? b : { ...b, [ff]: fid };
    });
  }

  // F1b-2 frame-move cascade: when a gesture directly moves a frame-kind box, its members
  // must travel with it in the SAME commit (one undo step). `prev` is the pre-gesture
  // model, `next` the post-transform model — both index-aligned with `sel` (no commit
  // happens mid-gesture, so getBoxes()/startBoxes and the transform output share indices).
  // For every frame box whose index is in `sel` we read its OWN top-left delta (next−prev)
  // and shift each member (frame === frame.id) that the gesture did NOT already move
  // directly (index NOT in `sel`). This is why we compose the delta here rather than call
  // cascadeFrameMove(next, id, dx, dy): moveBoxes/scaleGroup/rotateGroup already shifted the
  // frame box AND any selected children, so re-running cascadeFrameMove over the frame id
  // would double-apply to both. A frame box is never cascaded as a member (never
  // self-nests). Deriving the delta from prev/next covers move (exact d.dx/d.dy) and the
  // group transforms (each frame's own top-left translation) with one path. No-op without
  // frameCfg. assignFrames then runs on the touched `sel` only — the cascaded members keep
  // their frame because they moved with it (frame-local position unchanged), so they must
  // NOT be in the touched set, which is what keeps cascade-then-assign consistent.
  function cascadeFrameChildren(prev: Box[], next: Box[], sel: number[]): Box[] {
    if (!frameCfg) return next;
    const ff = frameCfg.frameField;
    const fk = frameCfg.frameKind;
    const selSet = new Set(sel);
    const deltas = new Map<string, { dx: number; dy: number }>();
    for (const i of sel) {
      const nb = next[i];
      const pb = prev[i];
      if (!nb || !pb || String(nb[cfg.kindField]) !== fk) continue;
      const fid = nb[cfg.idField] == null ? '' : String(nb[cfg.idField]);
      if (!fid) continue;
      const dx = num(nb[cfg.xField]) - num(pb[cfg.xField]);
      const dy = num(nb[cfg.yField]) - num(pb[cfg.yField]);
      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) deltas.set(fid, { dx, dy });
    }
    if (deltas.size === 0) return next;
    return next.map((b, i) => {
      if (!b || selSet.has(i) || String(b[cfg.kindField]) === fk) return b;
      const d = deltas.get(String(b[ff] ?? ''));
      return d ? withRect(b, { x: num(b[cfg.xField]) + d.dx, y: num(b[cfg.yField]) + d.dy }, cfg) : b;
    });
  }

  // ── timeline panel (opt-in: canvas time-model fields → `timeCfg`) ─────────────
  // Every branch below is dead on a tool without `timeCfg`: no rail button, no lazy
  // chunk fetch, no stage reserve, no listener.
  let timelinePanel: TimelinePanel | null = null;
  let timelineLoading = false;
  let timelineWantOpen = false;
  let timelineBtn: HTMLButtonElement | null = null;

  // Reserve a bottom band of the stage for the docked panel, then re-fit the canvas.
  // Mirrors deck-editor's syncFreeReserve exactly: a px STRING ('' releases), an
  // equality guard so the stage ResizeObserver cannot loop, and a `canvas-resize`
  // event (never a direct fitCanvas call) to trigger the re-fit.
  function reserveBottom(px: number): void {
    const next = px > 0 ? Math.round(px) + 'px' : '';
    if (stageEl.style.getPropertyValue('--stage-reserve-bottom') === next) return;
    if (next) stageEl.style.setProperty('--stage-reserve-bottom', next);
    else stageEl.style.removeProperty('--stage-reserve-bottom');
    canvasEl.dispatchEvent(new Event('canvas-resize'));
  }

  function syncTimelineBtn(): void {
    if (!timelineBtn) return;
    const on = !!timelinePanel?.isOpen();
    timelineBtn.classList.toggle('is-armed', on);
    timelineBtn.setAttribute('aria-pressed', String(on));
  }

  // The playhead's visibility, as the clock APPLIED it to the live DOM (sequence-dom's
  // OFF_CLASS). A box the sequence currently hides must not swallow a canvas click —
  // the user edits what they can see — so every pointer hit-test skips it and the
  // click falls through to the visible box below. DOM truth, not re-derived timing:
  // selection can never disagree with playback. No timeline mounted (or a box not yet
  // painted) → nothing carries the class → behaviour is unchanged.
  // 'seq-off' is bridge/sequence-dom.ts's OFF_CLASS. A LITERAL, not an import:
  // sequence-dom statically pulls sequence-plan + transitions, and free-canvas keeps
  // the whole sequence graph lazy (see ensureTimeline). free-canvas-seq-hit.test.ts
  // pins this literal against the real export so the two can't drift.
  const SEQ_OFF_CLASS = 'seq-off';
  /**
   * The ONE DOM read behind the whole rule (see the file header): is the sequence
   * currently hiding the box carrying `id`? Everything else — hit-test skipping,
   * chrome suppression, the keyboard gate — is a caller of this, so there is exactly
   * one expression that can ever be wrong.
   */
  function seqHiddenId(id: string): boolean {
    if (!timeCfg) return false;
    const el = canvasEl.querySelector(`.lolly-box[data-box-id="${cssEscape(id)}"]`);
    return el != null && el.classList.contains(SEQ_OFF_CLASS);
  }
  function seqHiddenSkip(boxes: Box[]): ((i: number) => boolean) | undefined {
    if (!timeCfg) return undefined;
    return (i: number) => seqHiddenId(idOf(boxes[i], i));
  }
  /**
   * RETENTION, the half `seqHiddenSkip` cannot cover: a selection acquired while its
   * box was on screen SURVIVES the playhead moving away from it. True means "at least
   * one selected box is on screen at the playhead, so editing it means something".
   * An untimed tool, or an empty selection, is always live.
   */
  function selectionLive(boxes: Box[]): boolean {
    if (!timeCfg || !selection.size) return true;
    for (let i = 0; i < boxes.length; i++) {
      const id = idOf(boxes[i], i);
      if (selection.has(id) && !seqHiddenId(id)) return true;
    }
    return false;
  }

  // True when the block already carries authored timing — the auto-open cue. This is a
  // field-presence check, not editing arithmetic, so it stays here rather than pulling
  // timeline-math in eagerly (that module is part of the lazy chunk).
  function isTimedBox(b: Box): boolean {
    if (!timeCfg) return false;
    if (String(b[timeCfg.laneField] ?? '') === 'seq') return true;
    const s = b[timeCfg.startField];
    return Number.isFinite(typeof s === 'number' ? s : parseFloat(String(s ?? '')));
  }
  function anyTimed(boxes: Box[]): boolean {
    return !!timeCfg && boxes.some(isTimedBox);
  }

  async function ensureTimeline(open: boolean): Promise<void> {
    if (!timeCfg || disposed) return;
    timelineWantOpen = open;
    if (timelinePanel) {
      timelinePanel.setOpen(open); syncTimelineBtn();
      if (open) maybePromptSequenceFrames(); else hideSeqPrompt();
      return;
    }
    if (!open || timelineLoading) return;
    timelineLoading = true;
    try {
      // Lazy for the picker.ts reason: timeline-panel.ts imports its own CSS chunk and
      // the sequence clock, so a static import would ship both to every editor tool.
      const { initTimelinePanel } = await import('./timeline-panel.ts');
      if (disposed) return;   // torn down while the chunk was in flight
      timelinePanel = initTimelinePanel({
        stageEl, canvasEl, runtime,
        host: host as { log?(level: string, msg: string): void },
        blockId, cfg: timeCfg, getBoxes, commit, onDirty,
        // The box sub-field carrying rendered text, so the panel's generated
        // caption boxes write cue text where the tool's template reads it.
        textField: cv.textField,
        // The tool's OWN add-kinds, so the panel's plus offers exactly what the rail's
        // does (audio included) instead of hardcoding a list it cannot know.
        addKinds,
        // The canvas selection, adapted: read/write the same Set the overlay uses, and
        // subscribe to the single notifier fired from paintChrome.
        selection: {
          get: () => [...selection],
          set: (ids: string[]) => { selection = new Set(ids); renderChrome(); },
          onChange: (cb: () => void) => { selListeners.add(cb); return () => { selListeners.delete(cb); }; },
        },
        reserve: reserveBottom,
      });
      timelinePanel.setOpen(timelineWantOpen);   // the intent may have flipped mid-load
      if (timelineWantOpen) maybePromptSequenceFrames(); else hideSeqPrompt();
    } catch (err) {
      console.error('[free-canvas] timeline panel failed to load:', err);
    } finally {
      timelineLoading = false;
      syncTimelineBtn();
    }
  }

  /**
   * The panel asks THIS module for new boxes rather than reaching into it: its plus menu
   * (and its empty-sequence "Add a clip" slot) dispatches `tl-add` with
   * `{ kind, atMs }`, which bubbles from the panel root to the stage. Arming create-mode
   * is exactly what the rail's add menu does, so the next canvas click drops the box —
   * with the one difference the panel depends on: a box added FROM the timeline lands
   * TIMED at the playhead, where the rail's plus leaves it as scenery. `pendingAddAtMs`
   * carries that single bit through to the create commit and is cleared alongside the
   * armed kind, so an abandoned arm can never time the next hand-drawn box.
   *
   * The detail is untrusted — a CustomEvent can be dispatched by anything on the page —
   * so an unknown kind or a non-finite / negative / absurd `atMs` drops the whole event
   * rather than guessing: nothing reaches the model on a bad one.
   */
  const MAX_ADD_AT_MS = 24 * 60 * 60 * 1000;   // a day of sequence; beyond that it is junk
  let pendingAddAtMs: number | null = null;
  function onTlAdd(e: Event): void {
    if (!timeCfg || disposed) return;
    const d = (e as CustomEvent).detail as { kind?: unknown; atMs?: unknown } | null | undefined;
    const kind = addKinds.find((k) => k.id === (typeof d?.kind === 'string' ? d.kind : ''));
    if (!kind) return;
    const atMs = typeof d?.atMs === 'number' ? d.atMs : Number.NaN;
    if (!Number.isFinite(atMs) || atMs < 0 || atMs > MAX_ADD_AT_MS) return;
    // AFTER setMode, never before: enterCreate clears the pending time so that an arm
    // from anywhere else cannot inherit one. This is the single place that sets it.
    setMode('create', { kind });
    pendingAddAtMs = atMs;
  }
  if (timeCfg) stageEl.addEventListener('tl-add', onTlAdd);

  /**
   * The other half of the cross-module seam (same CustomEvent pattern as `tl-add` /
   * `tl-take`, deliberately — not a new coupling): the panel tells the canvas when the
   * ACTIVE SET changed, never once per tick. Two things ride on it:
   *   • the chrome repaint that makes the one rule track the playhead at all, and
   *   • `tlPlaying`, which suppresses the off-playhead banner during playback — scenes
   *     coming and going is the whole point of pressing play, and a chip that blinks on
   *     every cut is noise, not information.
   *   • the ONION SKIN, which is opt-in and OFF by default: the panel puts `mode` /
   *     `past` / `future` / `opacity` on the same detail, and an absent (or unknown)
   *     mode means the lazy chunk is never fetched at all.
   * Untrusted detail (anything on the page can dispatch it): only the `playing` flag is
   * read as a strict boolean, and the onion fields are re-validated in onionFrom.
   */
  let tlPlaying = false;
  function onTlTime(e: Event): void {
    if (!timeCfg || disposed) return;
    const d = (e as CustomEvent).detail as OnionTimeDetail | null | undefined;
    tlPlaying = d?.playing === true;
    onionFrom(d);
    renderChrome();
  }
  if (timeCfg) stageEl.addEventListener('tl-time', onTlTime);

  // ── onion skin: the ghost layer, lazily mounted, never in an export ──────────
  // The whole feature is off unless the panel says otherwise, so the module, its
  // stylesheet and every DOM node it makes cost exactly nothing to an editor that never
  // turns it on. The layer itself lives inside `overlay` — a stage SIBLING of
  // #tool-canvas carrying [data-export-hide] — so no export path can reach it; see
  // onion-skin.ts's module doc for the three independent guarantees.
  interface OnionTimeDetail { playing?: unknown; mode?: unknown; past?: unknown; future?: unknown; opacity?: unknown; activeIds?: unknown }
  let onionSkin: OnionSkinHandle | null = null;
  let onionLoading = false;
  let onionState: OnionPaintState | null = null;

  function onionOff(): void {
    onionState = null;
    if (!onionSkin) return;
    try { onionSkin.destroy(); } catch (e) { console.error(e); }
    onionSkin = null;
  }

  function onionFrom(d: OnionTimeDetail | null | undefined): void {
    const mode = d?.mode === 'filled' ? 'filled' : d?.mode === 'outline' ? 'outline' : '';
    if (!mode) { onionOff(); return; }
    onionState = { mode, past: d?.past, future: d?.future, opacity: d?.opacity, active: d?.activeIds };
    if (onionSkin) { onionSkin.paint(onionState); return; }
    if (onionLoading) return;
    onionLoading = true;
    void (async () => {
      try {
        const mod = await import('./onion-skin.ts');
        // The mode may have been turned off again while the chunk was in flight.
        if (disposed || !onionState) return;
        onionSkin = mod.mountOnionSkin({
          overlayEl: overlay, canvasEl, cfg, getBoxes, metricsOf: metrics,
        });
        onionSkin.paint(onionState);
      } catch (e) { console.error(e); }
      finally { onionLoading = false; }
    })();
  }

  /** Re-place the ghosts after a pan / zoom / resize — they are positioned in stage px
   *  from the model, exactly like the selection outline, so they move with it. */
  function paintOnion(): void {
    if (onionSkin && onionState) onionSkin.paint(onionState);
  }

  /** Open the panel (used by the rail button and after creating a timed box). */
  function openTimeline(): void { void ensureTimeline(true); }
  function toggleTimeline(): void { void ensureTimeline(!timelinePanel?.isOpen()); }

  function destroyTimeline(): void {
    try { stageEl.removeEventListener('tl-add', onTlAdd); } catch { /* stage detached */ }
    try { stageEl.removeEventListener('tl-time', onTlTime); } catch { /* stage detached */ }
    // No panel means no playhead means nothing to be either side OF.
    onionOff();
    try { timelinePanel?.destroy(); } catch (e) { console.error(e); }
    timelinePanel = null;
    // Unconditional, even if destroy() above threw: a leaked reserve permanently shrinks
    // the stage for every other tool mounted in this session.
    stageEl.style.removeProperty('--stage-reserve-bottom');
    try { canvasEl.dispatchEvent(new Event('canvas-resize')); } catch { /* stage detached */ }
  }

  // ── connectors (opt-in via canvas.connect) ───────────────────────────────────
  // The overlay authors edges into a SEPARATE blocks input; the tool's hooks.js reads
  // {from,to} + current box geometry and draws the routed line. Deleting a box leaves
  // its edges in the data but they render to nothing (the hook skips unresolved ids),
  // so undo restores a box AND its lines in one step.
  const getEdges = (): Box[] => {
    if (!connectCfg) return [];
    const e = runtime.getModel().find((i) => i.id === connectCfg.input);
    return Array.isArray(e?.value) ? e!.value : [];
  };
  function commitEdges(next: Box[]): void {
    if (!connectCfg) return;
    onDirty?.(connectCfg.input);
    runtime.setInput(connectCfg.input, next);
  }
  // `freshEdgeId` + `toggleEdge` (plan 90) lived here: Connect mode's write into the
  // connectors input. Plan 96 P4 deleted both with the mode. An edge is not a thing any
  // more — a connector is a path box whose `bindStart`/`bindEnd` name the boxes its ends
  // are attached to, written by the endpoint-bind gesture below, and every tool's hook
  // converts any surviving edge row to one of those on load. `commitEdges` above stays as
  // the DRAIN: nothing calls it today, but a tool that still declares `canvas.connect`
  // keeps its read-only inspector rather than silently losing the ability to delete a row.
  // `createLine` (plan 90) lived here: the Line tool's write into the connectors input.
  // Plan 96 P2 deleted it. A line is a PATH BOX now — `commitPathBox`, the same call the
  // pen commits through — so there is no second place a line can come from, and the edge
  // row it used to mint had no nodes to edit. `toggleEdge` above stays: it is the Connect
  // mode's own write, which P4 migrates.
  const gridRound = (v: number): number => Math.round(v / gridSize) * gridSize;

  // ── coordinate mapping (transform-agnostic via the live canvas rect) ────────
  // The canvas/stage screen rects are INVARIANT for the duration of a box gesture
  // (dragging/resizing/rotating a box never pans or zooms the artboard — pan/zoom is
  // a separate stageNav interaction that fires the transform MutationObserver). So
  // cache them once per gesture instead of forcing a layout flush on every metrics()
  // call (~6 getBoundingClientRect + ~3 forced reflows per drag frame otherwise). The
  // cache is cleared on gesture end and on ANY geometry change (onStageMove clears it),
  // so a pan/zoom/resize/auto-scroll can never leave it stale.
  let gestureMetrics: Metrics | null = null;
  function metrics(): Metrics {
    if (gestureMetrics && gesture) return gestureMetrics;   // trust the cache only while the gesture is live
    const cr = canvasEl.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    const scale = cr.width / canvasWH().w || 1;
    const m = { cr, sr, scale };
    gestureMetrics = gesture ? m : null;   // hold for the rest of the gesture; drop when idle
    return m;
  }
  const clientToNative = (cx: number, cy: number): Point => {
    const { cr, scale } = metrics();
    return { x: (cx - cr.left) / scale, y: (cy - cr.top) / scale };
  };
  const nativeToStage = (nx: number, ny: number, m: Metrics = metrics()): Point => ({
    x: m.cr.left - m.sr.left + nx * m.scale,
    y: m.cr.top - m.sr.top + ny * m.scale,
  });

  // Multi-page mode: box coordinates are GLOBAL across the strip, but each box's DOM
  // element lives INSIDE its page frame ([data-pdf-page]) and is positioned relative
  // to that frame. So converting a global rect to/from the element's own left/top
  // means subtracting/adding the frame's offset within the canvas. Reading offsetLeft/
  // offsetTop off the live frame keeps this immune to the frame-gap constant (the frame
  // sits wherever the template laid it out). Returns {0,0} when the element isn't inside
  // a page frame — so a single-page editor (Layout Studio) is completely unaffected.
  // A [data-pdf-page] frame's offsetLeft/offsetTop does NOT change while a BOX is dragged —
  // only the box moves. But reading them forces a synchronous layout, and applyLiveRect +
  // the live chrome re-sync call this per box PER pointermove, so a drag with frames present
  // thrashed layout (the reported lag, even for an empty-frame drag whose chrome re-syncs).
  // A gesture-scoped cache keyed by the frame element reads each frame's offset at most ONCE
  // per gesture; every later read in the same drag returns the cached value with no reflow.
  // beginGesture arms it, endGesture clears it.
  let frameOffCache: Map<HTMLElement, Point> | null = null;
  const frameOffsetOfEl = (el: Element): Point => {
    // No pages AND no frame primitive ⇒ no [data-pdf-page] frames exist, so skip the
    // ancestor walk entirely (a plain single-page editor hits this every gesture frame).
    // A frame-primitive tool (frameCfg) emits [data-pdf-page] pages at authored x/y even
    // with no `pages` config, so it must walk too — offsetLeft/offsetTop then report the
    // frame's own position and the frame-local drag math below works unchanged.
    if (!pages && !frameCfg) return { x: 0, y: 0 };
    const f = el.closest?.('[data-pdf-page]') as HTMLElement | null;
    if (!f) return { x: 0, y: 0 };
    if (frameOffCache) {
      let c = frameOffCache.get(f);
      if (!c) { c = { x: f.offsetLeft, y: f.offsetTop }; frameOffCache.set(f, c); }
      return c;
    }
    return { x: f.offsetLeft, y: f.offsetTop };
  };

  // ── DOM: overlay + toolbar ──────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'fc-overlay';
  overlay.setAttribute('data-export-hide', '');
  stageEl.appendChild(overlay);

  // Frame dimmer — a hole-punch scrim sized to the export frame (repositioned only
  // when the artboard's screen geometry changes — see scrimDirty). Its big outset
  // box-shadow faintly tints everything OUTSIDE the frame, so boxes dragged off the
  // artboard read as gently faded while staying fully visible + selectable. First
  // overlay child so the selection chrome, guides and ctxbar all paint above it.
  const frameScrim = document.createElement('div');
  frameScrim.className = 'fc-frame-scrim';
  overlay.appendChild(frameScrim);
  // M2 — the scrim only moves on pan/zoom/resize, NEVER on a box drag/hover/selection
  // change. onStageMove (the geometry-change path) sets this; paintChrome repositions
  // the 100vmax soft-shadow region only when it's set, dropping a metrics() + a big
  // shadow repaint from every drag/selection sync. Starts true so mount positions it.
  let scrimDirty = true;

  const rubber = document.createElement('div');
  rubber.className = 'fc-rubber';
  rubber.hidden = true;
  overlay.appendChild(rubber);

  const guidesEl = document.createElement('div'); // snap/alignment guide lines
  guidesEl.className = 'fc-guides';
  overlay.appendChild(guidesEl);

  // First-run invite on an empty canvas — a blank editor is otherwise a mystery. Only
  // shown for tools that can add boxes; clicking it opens the same Add menu as the rail.
  const emptyHint = document.createElement('div');
  emptyHint.className = 'fc-empty';
  emptyHint.hidden = true;
  emptyHint.innerHTML = `<button type="button" class="fc-empty-add">+ ${t('Add your first card')}</button>`;
  emptyHint.querySelector('button')!.addEventListener('click', () => {
    (toolbar.querySelector('.fc-btn-add') as HTMLElement | null)?.click();
  });
  overlay.appendChild(emptyHint);

  // Transient VISIBLE status for an action that refused. The overlay had no such
  // surface — `announce()` is screen-reader-only — and a vector operation that declines
  // must not read as a silent no-op: the kernel throwing `GeomLimitError` means the
  // answer exists and the engine will not guess it, which is a sentence the user needs
  // to see. Pointer-transparent and aria-hidden: the a11y path stays `announce()`, the
  // app's established mechanism, so nothing is announced twice.
  const flashEl = document.createElement('div');
  flashEl.className = 'fc-flash';
  flashEl.setAttribute('aria-hidden', 'true');
  flashEl.hidden = true;
  overlay.appendChild(flashEl);
  let flashTimer: ReturnType<typeof setTimeout> | 0 = 0;
  function flash(message: string): void {
    if (!message) return;
    flashEl.textContent = message;
    flashEl.hidden = false;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashEl.hidden = true; flashEl.textContent = ''; flashTimer = 0; }, 5200);
    announce(message, { assertive: true });
  }

  // The one rule's reconciliation surface. An off-playhead selection is the single
  // STUCK state the rule can produce — the user asked for a box, it is still theirs,
  // and the canvas simply cannot show it — so unlike a click that falls through a
  // hidden scene (silent, by design: it would fire on every click of a stacked
  // composition) this one gets a persistent chip with a way out. It is the only
  // pointer-receiving child of the otherwise pointer-transparent overlay, and it is a
  // stage sibling of #tool-canvas carrying [data-export-hide] on its parent, so no
  // export path can see it.
  // Built node-by-node rather than through innerHTML: two nodes with static text is
  // not worth a raw-HTML sink (primitive-guards R10 ratchets those for a reason), and
  // `btn btn--primary btn--sm` is the shell's ONE primary-fill recipe — restating the
  // fill pair locally is exactly what R2 refuses.
  const offPlayheadEl = document.createElement('div');
  offPlayheadEl.className = 'fc-offplayhead';
  offPlayheadEl.hidden = true;
  const offPlayheadTxt = document.createElement('span');
  offPlayheadTxt.className = 'fc-offplayhead-txt';
  offPlayheadTxt.textContent = t('Not on screen at the playhead');
  const offPlayheadGo = document.createElement('button');
  offPlayheadGo.type = 'button';
  offPlayheadGo.className = 'btn btn--primary btn--sm fc-offplayhead-go';
  offPlayheadGo.textContent = t('Go to it');
  offPlayheadEl.append(offPlayheadTxt, offPlayheadGo);
  overlay.appendChild(offPlayheadEl);
  let offPlayheadAtMs = 0;
  // Guards the announcement so entering the state speaks ONCE, not on every repaint
  // (a pan, a zoom and every tl-time all repaint the chrome).
  let lastOffPlayheadKey = '';
  offPlayheadGo.addEventListener('click', () => {
    stageEl.dispatchEvent(new CustomEvent('fc-seek', { bubbles: true, detail: { atMs: offPlayheadAtMs } }));
  });

  /**
   * Raise the banner over the artboard for an off-playhead selection. Centred with the
   * same maths positionFrameScrim uses, so it tracks pan/zoom for free.
   *
   * Two suppressions, both deliberate: no timeline panel means no clock means nothing is
   * ever `seq-off` (so this can only be a stale class), and during PLAYBACK a scene
   * leaving the screen is expected rather than a problem to report.
   */
  function showOffPlayhead(boxes: Box[], idx: number[]): void {
    if (!timeCfg || !timelinePanel || tlPlaying || !idx.length) { hideOffPlayhead(); return; }
    const b = boxes[idx[0]!];
    // A field read, not arithmetic: the box's own authored start, in ms.
    offPlayheadAtMs = Math.max(0, Number(b?.[timeCfg.startField]) * 1000) || 0;
    const m = metrics();
    const wh = canvasWH();
    const tl = nativeToStage(0, 0, m);
    offPlayheadEl.style.left = `${tl.x + (wh.w * m.scale) / 2}px`;
    offPlayheadEl.style.top = `${tl.y + (wh.h * m.scale) / 2}px`;
    offPlayheadEl.hidden = false;
    const key = idx.map((k) => idOf(boxes[k], k)).sort().join(',');
    if (key !== lastOffPlayheadKey) {
      lastOffPlayheadKey = key;
      announce(t('This card is not on screen at the playhead. Go to it to edit it.'));
    }
  }
  function hideOffPlayhead(): void {
    if (!offPlayheadEl.hidden) offPlayheadEl.hidden = true;
    lastOffPlayheadKey = '';
  }

  // ── frames-as-scenes: the "play in order" invitation (plan 92) ───────────────
  // A one-shot, non-blocking prompt shown when the timeline OPENS on a frame doc whose
  // frames are NOT yet sequenced: "Play your N frames in order?" [Place in order][Not now].
  // Accepting lays the frames end-to-end in time on the scenes lane (one commit, one undo
  // step) so the clock gates the canvas to one frame at a time; declining dismisses for the
  // session. Gated on frameCfg + timeCfg both present — dead on any tool without frames or
  // without a time model. Built node-by-node (static text, `btn` recipes) like the
  // off-playhead chip; a stage sibling of #tool-canvas carrying [data-export-hide], so no
  // export path sees it.
  let seqPromptDismissed = false;
  const seqPromptEl = document.createElement('div');
  seqPromptEl.className = 'fc-frameseq';
  seqPromptEl.hidden = true;
  seqPromptEl.setAttribute('role', 'status');
  const seqPromptTxt = document.createElement('span');
  seqPromptTxt.className = 'fc-frameseq-txt';
  const seqPromptPlace = document.createElement('button');
  seqPromptPlace.type = 'button';
  seqPromptPlace.className = 'btn btn--primary btn--sm fc-frameseq-go';
  seqPromptPlace.textContent = t('Place in order');
  const seqPromptSkip = document.createElement('button');
  seqPromptSkip.type = 'button';
  seqPromptSkip.className = 'btn btn--sm';
  seqPromptSkip.textContent = t('Not now');
  seqPromptEl.append(seqPromptTxt, seqPromptPlace, seqPromptSkip);
  overlay.appendChild(seqPromptEl);

  function hideSeqPrompt(): void {
    if (!seqPromptEl.hidden) seqPromptEl.hidden = true;
  }

  /** The frames-as-scenes field config, or null when this tool has no frames/time model. */
  function frameSeqCfg(): {
    kindField: string; frameKind: string; startField: string; durField: string;
  } | null {
    if (!frameCfg || !timeCfg) return null;
    return {
      kindField: cfg.kindField, frameKind: frameCfg.frameKind,
      startField: timeCfg.startField, durField: timeCfg.durField,
    };
  }

  function frameCount(boxes: Box[]): number {
    if (!frameCfg) return 0;
    let n = 0;
    for (const b of boxes) if (b && String(b[cfg.kindField]) === frameCfg.frameKind) n++;
    return n;
  }

  seqPromptPlace.addEventListener('click', () => {
    if (!frameCfg || !timeCfg) { hideSeqPrompt(); return; }
    commit(sequenceFramesInOrder(getBoxes(), {
      defaultDurMs: 3000,
      lane: 'seq',
      defaultEnter: 'fade',
      defaultExit: 'fade',
      startField: timeCfg.startField, durField: timeCfg.durField, laneField: timeCfg.laneField,
      enterField: timeCfg.enterField, exitField: timeCfg.exitField,
      orderField: frameCfg.orderField || 'order',
      kindField: cfg.kindField, frameKind: frameCfg.frameKind,
    }));
    hideSeqPrompt();
    announce(t('Frames placed in order. Scrub the playhead to preview your slideshow.'));
  });
  seqPromptSkip.addEventListener('click', () => { seqPromptDismissed = true; hideSeqPrompt(); });

  /**
   * Offer to sequence the frames when the timeline is open — but only when frames exist and
   * NONE are timed yet (never nag once sequenced), and only once per session (a decline
   * sticks). Positioned by CSS at the top-centre of the overlay, out of the toolbar's way.
   */
  function maybePromptSequenceFrames(): void {
    if (disposed || seqPromptDismissed) return;
    const sc = frameSeqCfg();
    if (!sc || !timelinePanel?.isOpen()) { hideSeqPrompt(); return; }
    const boxes = getBoxes();
    const n = frameCount(boxes);
    if (n < 1 || framesAreSequenced(boxes, sc)) { hideSeqPrompt(); return; }
    seqPromptTxt.textContent = n === 1
      ? t('Play this frame in the timeline?')
      : tRaw('Play your {n} frames in order?').replace('{n}', String(n));
    seqPromptEl.hidden = false;
  }

  // Connector preview layer (opt-in): the "rubber" line while linking two cards, and a
  // live redraw of every edge while a connected card is being dragged (so the lines
  // follow in real time — the tool's real connector <svg> only re-renders on commit).
  // An <svg> covering the canvas in stage space, drawn in NATIVE coords via its viewBox.
  const connectLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  connectLayer.setAttribute('class', 'fc-connect-layer');
  connectLayer.style.position = 'absolute';
  connectLayer.style.left = '0';
  connectLayer.style.top = '0';
  connectLayer.style.overflow = 'visible';
  connectLayer.style.pointerEvents = 'none';
  connectLayer.style.display = 'none';
  overlay.appendChild(connectLayer);

  // Pen preview layer — the draft path plus the segment under the cursor while drawing,
  // and the edited path's own outline while node-editing. Same trick as the connector
  // layer: an <svg> covering the artboard in stage px, drawn in NATIVE coords via its
  // viewBox, so a pan/zoom only has to move and resize the element.
  const penLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  penLayer.setAttribute('class', 'fc-pen-layer');
  penLayer.style.position = 'absolute';
  penLayer.style.left = '0';
  penLayer.style.top = '0';
  penLayer.style.overflow = 'visible';
  penLayer.style.pointerEvents = 'none';
  penLayer.style.display = 'none';
  overlay.appendChild(penLayer);

  const chrome = document.createElement('div');   // selection outlines + handles
  chrome.className = 'fc-chrome';
  overlay.appendChild(chrome);

  // Node/handle chrome, in its OWN container so it is built and torn down independently of
  // the selection chrome — the two are never on screen together, but they key on different
  // things (a node set vs a selection set) and sharing a container would make one rebuild
  // the other. Same build-once/reposition-many discipline as `chromeNodes`, for the reason
  // documented there: a 40-node path re-created per drag frame is far worse than the ~10
  // selection nodes that motivated the optimisation in the first place.
  const penChrome = document.createElement('div');
  penChrome.className = 'fc-pen-chrome';
  overlay.appendChild(penChrome);
  let penChromeKey: string | null = null;
  let penChromeNodes: { nodes: HTMLElement[]; arms: HTMLElement[]; dots: HTMLElement[] } | null = null;
  function clearPenChrome(): void {
    penChrome.innerHTML = '';
    penChromeKey = null;
    penChromeNodes = null;
  }

  const ctxbar = document.createElement('div');    // contextual controls
  ctxbar.className = 'fc-ctxbar';
  ctxbar.hidden = true;
  ctxbar.addEventListener('pointerdown', (e) => e.stopPropagation());
  overlay.appendChild(ctxbar);
  let ctxSelKey: string | null = null;   // sorted selected-id signature; rebuild ctxbar when it changes

  // ── the bar's ENTRANCE ────────────────────────────────────────────────────────
  // The bar is auto-hidden at rest and revealed by `.tool-stage:hover` (see .fc-ctxbar
  // in editor.css), which means at the moment a card is selected the stage is ALREADY
  // hovered: the opacity transition has nothing to run, and a fully formed bar of a
  // dozen controls materialises between two video frames right where the pointer is.
  // So absent→present gets a real entrance — a short settle after the gesture, then a
  // fade and a small rise — and ONLY that transition: a reposition mid-drag must never
  // re-play it, which is what `ctxShown` tracks.
  //
  // The rise is a transform, and a transform on this bar is the containing block for
  // its colour popover's `position: fixed` (the reason .fc-ctxbar carries neither
  // translateX nor backdrop-filter). Safe here and only here, because the keyframes
  // fill `backwards` and NOT forwards: the computed transform is `none` again the
  // instant the animation ends, and the class comes off on animationend. A popover
  // cannot exist during the run anyway — rebuildCtxBar replaces the bar's innerHTML,
  // which destroys any open one.
  let ctxShown = false;
  const CTX_ENTER = 'fc-ctxbar-enter';
  ctxbar.addEventListener('animationend', () => ctxbar.classList.remove(CTX_ENTER));
  function showCtxBar(): void {
    if (ctxShown && !ctxbar.hidden) return;
    ctxShown = true;
    ctxbar.hidden = false;
    // Reduced motion (OS query OR the app pref): appear instantly. No movement, and no
    // transform written at all, so the popover containing-block trap stays untouched.
    if (prefersReducedMotion()) return;
    ctxbar.classList.remove(CTX_ENTER);
    void ctxbar.offsetWidth;             // restart the animation on a re-selection
    ctxbar.classList.add(CTX_ENTER);
  }
  function hideCtxBar(): void {
    ctxShown = false;
    ctxbar.hidden = true;
    ctxbar.classList.remove(CTX_ENTER);
  }

  // M1 — selection chrome (outline(s) + resize/rotate handles) is built ONCE per
  // selection set (keyed exactly like the ctxbar) and only REPOSITIONED on later
  // syncs. Rebuilding ~10 nodes + re-binding a pointerdown on each, every drag/pan/
  // zoom frame, was the bulk of a sync's DOM cost. chromeNodes holds the live nodes
  // so a reposition is pure style writes; teardown+rebuild happens only when the set
  // changes. handles[] order matches the build order (HANDLES for single; nw,ne,se,sw
  // for group) so positioning can address them positionally.
  let chromeKey: string | null = null;
  let chromeNodes: {
    outlines: HTMLElement[];              // one .fc-outline per selected box, in idx order
    groupOutline: HTMLElement | null;     // multi-select only
    handles: HTMLElement[];               // resize (single) / corner (group) handles
    stem: HTMLElement | null;             // rotate stem
    rot: HTMLElement | null;              // rotate handle
  } | null = null;
  function clearChrome(): void {
    chrome.innerHTML = '';
    chromeKey = null;
    chromeNodes = null;
  }

  // Dock wrapper flex-centres the rail at rest without a transform on the rail
  // itself, and carries the left/top of a DRAGGED rail for the same reason
  // (a transform/backdrop-filter on either would capture the colour popover's
  // fixed positioning — see the .fc-toolbar-dock CSS note).
  const toolbarDock = document.createElement('div');
  toolbarDock.className = 'fc-toolbar-dock';
  toolbarDock.setAttribute('data-export-hide', '');
  const toolbar = document.createElement('div');
  toolbar.className = 'fc-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', t('Editor tools'));
  // Grip at the very top — the rail is a floating palette, so it says so and gives a
  // drag target that is not one of the buttons (every button stops pointerdown, which
  // is what keeps a click on a tool from starting a drag).
  const grip = document.createElement('div');
  grip.className = 'fc-grip';
  grip.title = t('Drag to move the tools');
  grip.setAttribute('aria-hidden', 'true');
  grip.innerHTML = '<span></span><span></span>';
  toolbar.appendChild(grip);
  toolbarDock.appendChild(toolbar);
  stageEl.appendChild(toolbarDock);

  // ── dragging the rail ────────────────────────────────────────────────────────
  // Position is written as plain left/top on the DOCK. NEVER a transform: a
  // transformed ancestor becomes the containing block for every position:fixed
  // descendant, which throws the rail's colour popover off-screen. That bug has
  // already been fixed once here — do not reintroduce it for a drag.
  let railDrag: { pointerId: number; dx: number; dy: number } | null = null;
  let railWant: { left: number; top: number } | null = null;
  let railRaf = 0;
  /**
   * The stage band the rail must never be dragged into. Three things can live in the
   * foot of the stage, and a rail parked under any of them is invisible (the rail is
   * `opacity: 0` at rest) AND unclickable:
   *   - the docked TIMELINE panel — `z-index: 22` and `pointer-events: auto`, well above
   *     the dock's 16, so it both paints over the rail and swallows its pointer;
   *   - the export pill, wherever a host still shows one;
   *   - the recorder tools' "Warm the mic / Record" control at the stage foot.
   * Measured live rather than read off `--stage-reserve-bottom`: that custom property is
   * only an input to fitCanvas and does not shrink the stage box, so the stage rect still
   * spans the panel band.
   */
  function railReserveBottom(sr: DOMRect): number {
    let reserve = 0;
    for (const sel of ['.tl-panel', '.render-pill', '.canvas-record-btn', '.canvas-record-timer']) {
      for (const el of Array.from(viewEl.querySelectorAll<HTMLElement>(sel))) {
        // getClientRects(), not offsetParent: a `position: fixed` element (the mobile
        // export pill is exactly that) reports a null offsetParent while being perfectly
        // visible, so the old guard could never see it.
        if (el.hidden || !el.getClientRects().length) continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > sr.bottom - 4) reserve = Math.max(reserve, sr.bottom - r.top);
      }
    }
    return Math.max(0, Math.round(reserve));
  }
  function placeRail(want: { left: number; top: number }): void {
    const rr = toolbar.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    const pos = clampRailPos(want, { w: rr.width, h: rr.height }, { w: sr.width, h: sr.height },
      { reserveBottom: railReserveBottom(sr) });
    railSession = pos;
    toolbarDock.classList.add('is-detached');
    toolbarDock.style.left = pos.left + 'px';
    toolbarDock.style.top = pos.top + 'px';
  }
  /** Keep a detached rail inside the stage when the stage itself changes size. */
  function reclampRail(): void { if (railSession) placeRail(railSession); }
  const onRailDown = (e: PointerEvent): void => {
    if (e.button !== 0 || railDrag) return;
    // Buttons/fields already stop pointerdown before it reaches here; this is the
    // belt to that pair of braces, and it keeps the colour trigger draggable-proof.
    if ((e.target as HTMLElement).closest?.('button, input, select, .fc-color-btn')) return;
    const rr = toolbar.getBoundingClientRect();
    railDrag = { pointerId: e.pointerId, dx: e.clientX - rr.left, dy: e.clientY - rr.top };
    closePopover();
    closeMorePanel();
    toolbarDock.classList.add('is-dragging');
    try { toolbar.setPointerCapture(e.pointerId); } catch { /* no pointer capture (jsdom) */ }
    e.preventDefault();
    e.stopPropagation();
  };
  const onRailMove = (e: PointerEvent): void => {
    if (!railDrag || e.pointerId !== railDrag.pointerId) return;
    // No button held any more → the pointerup was lost (a capture stolen by the export
    // shutter's `pointer-events: none`, a devtools break). Finish the drag instead of
    // letting a bare hover keep sliding the rail around the stage.
    if (e.type === 'pointermove' && e.buttons === 0) { onRailUp(e); return; }
    const sr = stageEl.getBoundingClientRect();
    railWant = { left: e.clientX - sr.left - railDrag.dx, top: e.clientY - sr.top - railDrag.dy };
    // One style write per frame (the timeline resize grip's shape). Live-mutating
    // only — a rail position is never committed to the model.
    if (railRaf) return;
    railRaf = requestAnimationFrame(() => { railRaf = 0; if (railWant) placeRail(railWant); });
  };
  const onRailUp = (e: PointerEvent): void => {
    if (!railDrag || e.pointerId !== railDrag.pointerId) return;
    if (railRaf) { cancelAnimationFrame(railRaf); railRaf = 0; }
    if (railWant) placeRail(railWant);
    railWant = null;
    try { toolbar.releasePointerCapture(railDrag.pointerId); } catch { /* never captured */ }
    railDrag = null;
    toolbarDock.classList.remove('is-dragging');
  };
  toolbar.addEventListener('pointerdown', onRailDown);
  toolbar.addEventListener('pointermove', onRailMove);
  toolbar.addEventListener('pointerup', onRailUp);
  toolbar.addEventListener('pointercancel', onRailUp);
  // The escape hatch the timeline panel's own grip already has: losing pointer capture
  // fires NEITHER pointerup nor pointercancel (the export shutter sets `pointer-events:
  // none` on the rail mid-drag, which releases capture implicitly). Without this the
  // drag state sticks forever — `.is-dragging` stays on and onRailDown refuses to start
  // a new drag — so the rail could never be released or re-grabbed.
  toolbar.addEventListener('lostpointercapture', onRailUp);

  // ── toolbar ─────────────────────────────────────────────────────────────────
  let popover: HTMLDivElement | null = null;
  let arrangeBtn: HTMLButtonElement | null = null;   // popover anchor (captured, not by index)
  /** The mode buttons, captured by buildToolbar — see syncModeUI. Absent ones stay null:
   *  pen and connect are opt-in, so not every tool has all four. */
  const modeBtns: Record<'select' | 'create' | 'pen' | 'line', HTMLButtonElement | null> =
    { select: null, create: null, pen: null, line: null };
  let nodeToolBtn: HTMLButtonElement | null = null;   // the Node tool (opt-in, cv.pathField)
  function closePopover() { popover?.remove(); popover = null; }
  buildToolbar();   // after arrangeBtn exists (buildToolbar assigns it)
  // Put the rail back where it was dragged to earlier in this page session, re-clamped
  // against THIS stage (a different tool, a resized window).
  if (railSession) placeRail(railSession);

  /** How long a press has to be held before it counts as "open this tool's options"
   *  rather than "use this tool". Long enough not to fire on a slow click, short enough
   *  to feel like a press rather than a hang. */
  const HOLD_MS = 420;
  /** Pointer travel that turns a hold into a drag and cancels the menu, SCREEN px. */
  const HOLD_SLOP = 8;

  /**
   * A rail button, optionally with a press-and-hold menu of its own.
   *
   * `hold` is the touch-reachable half of a right-click: press and keep pressing, or
   * right-click, and the tool offers its options instead of running. The short click is
   * untouched — the tool still does its main job on a tap, which is what makes this safe
   * to add to a button people already use. The two never both fire: a hold that opened a
   * menu swallows the click that the pointerup would otherwise deliver.
   */
  function toolBtn(
    label: string,
    svg: string,
    onClick: (b: HTMLButtonElement, e: MouseEvent) => void,
    extraClass = '',
    hold?: (b: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fc-btn ' + extraClass;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon(svg);
    let holdTimer: ReturnType<typeof setTimeout> | 0 = 0;
    let holdFired = false;
    let holdFrom: { x: number; y: number } | null = null;
    const cancelHold = (): void => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
      holdFrom = null;
    };
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      // The pointerup that ends a hold still delivers a click. Eat exactly that one.
      if (holdFired) { holdFired = false; return; }
      onClick(b, e);
    });
    b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!hold || e.button > 0) return;          // secondary buttons take the contextmenu path
      holdFired = false;
      holdFrom = { x: e.clientX, y: e.clientY };
      // Bare `setTimeout`/`clearTimeout`, matching `flashTimer` above — pairing
      // `window.setTimeout` with a bare `clearTimeout` cancels nothing wherever the two
      // are not the same object, which is every jsdom-hosted test in this file.
      holdTimer = setTimeout(() => { holdTimer = 0; holdFired = true; hold(b); }, HOLD_MS);
    });
    if (hold) {
      // A press that travels is someone scrolling the rail, not someone holding it.
      b.addEventListener('pointermove', (e) => {
        if (holdFrom && Math.hypot(e.clientX - holdFrom.x, e.clientY - holdFrom.y) > HOLD_SLOP) cancelHold();
      });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, cancelHold);
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); cancelHold(); hold(b); });
      b.setAttribute('aria-haspopup', 'true');
    }
    toolbar.appendChild(b);
    return b;
  }

  function buildToolbar(): void {
    // ONE menu at the top of the rail, behind Lolly's own mark: every DOCUMENT-level
    // action — export, save, undo/redo, canvas size, copy, share, document info,
    // import. The rail underneath it is tools only. The trigger is the brand-hued
    // identity mark (--lolly-mark), never the verify verdict green.
    //
    // Export/Save still go through opts.actions (which .click() the hidden
    // #render-fab / #render-save) — no duplicated export or save logic anywhere.
    let histUndo = false, histRedo = false;
    if (history) {
      history.register((canUndo, canRedo) => {
        histUndo = canUndo; histRedo = canRedo;
        // The pair keeps the menu open so you can step back repeatedly, so its
        // enabled state has to follow the stack live rather than freeze at open.
        // (The Cmd/Ctrl-Z shortcuts are the shell's own and never touched the rail.)
        const u = popover?.querySelector<HTMLButtonElement>('[data-pop="undo"]');
        const r = popover?.querySelector<HTMLButtonElement>('[data-pop="redo"]');
        const active = document.activeElement;
        if (active === u && !canUndo && canRedo) r?.focus();
        else if (active === r && !canRedo && canUndo) u?.focus();
        if (u) u.disabled = !canUndo;
        if (r) r.disabled = !canRedo;
      });
    }
    let lollyBtn: HTMLButtonElement | null = null;
    const lollyItems = (): PopItem[] => {
      const items: PopItem[] = [];
      if (actions) {
        items.push({ label: t('Export'), icon: icon(SVG.exportUp), key: 'export', run: () => actions.export() });
        if (actions.canSave !== false) items.push({ label: t('Save to your library'), icon: icon(SVG.save), key: 'save', run: () => actions.save() });
      }
      if (history) {
        if (items.length) items.push({ sep: true });
        items.push({ label: t('Undo — step back'), icon: icon(SVG.undo), key: 'undo', disabled: !histUndo, keepOpen: true, run: () => history.undo() });
        items.push({ label: t('Redo — step forward'), icon: icon(SVG.redo), key: 'redo', disabled: !histRedo, keepOpen: true, run: () => history.redo() });
      }
      if (pages || setCanvasSize) {
        if (items.length) items.push({ sep: true });
        if (pages) items.push({ label: t('Pages & page size'), icon: icon(SVG.pages), key: 'pages', run: () => openPagesMenu(lollyBtn!) });
        else items.push({ label: t('Canvas size'), icon: icon(SVG.size), key: 'size', run: () => openSizeMenu(lollyBtn!) });
      }
      if (actions) {
        items.push({ sep: true });
        items.push({ label: t('Copy image to clipboard'), icon: icon(SVG.dup), key: 'copy', run: () => actions.copy() });
        items.push({ label: t('Copy a shareable link'), icon: icon(SVG.shareLink), key: 'share', run: () => actions.share() });
      }
      if (info || importCfg) {
        if (items.length) items.push({ sep: true });
        if (info) items.push({ label: t('Document info'), icon: icon(SVG.info), key: 'info', run: () => openInfoPanel(lollyBtn!) });
        // keepOpen, because openImportPanel closes this menu and then assigns its own
        // panel to `popover`: without it fillPopover's trailing closePopover() would
        // tear the freshly-mounted import panel down in the same click. (The pages /
        // size / info rows are safe — those assign `morePanel`, a different variable.)
        if (importCfg) items.push({ label: t('Import a design'), icon: icon(SVG.importFile), key: 'import', keepOpen: true, run: () => openImportPanel(lollyBtn!) });
      }
      return items;
    };
    if (actions || history || info || importCfg || pages || setCanvasSize) {
      // `fc-action-primary` is kept on the trigger because it is now the editor's
      // primary action affordance — mountTool focuses it on open (tool.ts) — with
      // .fc-btn-lolly restyling it back to the mark's own colour.
      lollyBtn = toolBtn(t('Menu — export, save, undo, canvas size'), '',
        () => { const items = lollyItems(); if (items.length) spawnPopover(lollyBtn!, items); },
        'fc-action fc-action-primary fc-btn-lolly');
      // The mark is a whole <svg>, not a path set, so it replaces toolBtn's icon().
      lollyBtn.innerHTML = LOLLY_ICON(22);
      lollyBtn.setAttribute('aria-haspopup', 'menu');
      const ref = actions?.dirtyRef;
      if (ref && actions && actions.canSave !== false) {
        // The render pill's amber "unsaved" cue, mirrored onto the trigger — Save
        // lives inside the menu now, so the mark is what has to carry the cue.
        const mark = lollyBtn;
        const mirror = (): void => { mark.classList.toggle('is-unsaved', ref.classList.contains('is-unsaved')); };
        mirror();
        dirtyObserver = new MutationObserver(mirror);
        dirtyObserver.observe(ref, { attributes: true, attributeFilter: ['class'] });
      }
      const asep = document.createElement('div'); asep.className = 'fc-sep'; toolbar.appendChild(asep);
    }
    // Pointer leads the tools, and is the way OUT of every other one. Before it existed the
    // only exit from the pen or from connect mode was clicking that same tool's own button
    // again — discoverable only if you already knew, which is what "trapped in the current
    // tool" meant. Its own click is not a no-op even when it is already lit: it also leaves
    // point editing and finishes a draft.
    modeBtns.select = toolBtn(t('Pointer — select and move (V)'), SVG.pointer, () => pickPointer(), 'fc-btn-pointer');
    const add = toolBtn(t('Add a box'), SVG.add, () => openAddMenu(add), 'fc-btn-add');
    modeBtns.create = add;
    // Pen (opt-in via canvas.pathField — a tool with nowhere to store an authored path has
    // no pen). The tooltip carries the corner modifier, which is otherwise undiscoverable;
    // Alt is free here because a pen click returns long before `selectionForHit`, where Alt
    // means "drill into the group".
    if (cv.pathField) {
      modeBtns.pen = toolBtn(t('Pen - click to place points, drag to curve, Alt for a corner. Hold for the spline type'), SVG.pen,
        () => { mode === 'pen' ? toPointer() : setMode('pen'); }, 'fc-btn-pen',
        (b) => openPenKindMenu(b));
      // Node tool (Inkscape's N): click a shape to edit its points directly.
      nodeToolBtn = toolBtn(t('Edit points (N) - click a shape to edit its nodes directly'), SVG.nodes,
        () => toggleNodeTool(), 'fc-btn-nodes');
      // Line — the pen's other gesture (plan 96 P2). One drag makes a two-node path box,
      // arrowhead on by default; it lives beside the Pen because it is the SAME primitive
      // drawn a different way, and it is opt-in on `pathField` for the same reason the pen
      // is: a tool with nowhere to store an authored path cannot hold a line either.
      modeBtns.line = toolBtn(t('Line — drag to draw a line or arrow'), SVG.line,
        () => { mode === 'line' ? toPointer() : setMode('line'); }, 'fc-btn-line');
    }
    // Timeline (opt-in via the canvas time-model fields — a tool with nowhere to store
    // a start/duration has no timeline). Toggles the docked panel; the panel module
    // itself is only fetched the first time it is opened.
    if (timeCfg) {
      timelineBtn = toolBtn(t('Timeline — arrange clips over time'), SVG.timeline,
        () => toggleTimeline(), 'fc-btn-timeline');
      timelineBtn.setAttribute('data-tip', t('Timeline — arrange clips over time'));
      timelineBtn.setAttribute('aria-pressed', String(!!timelinePanel?.isOpen()));
    }
    // Frames reorder (opt-in via canvas.orderField — the frame primitive's page-order
    // field). A tool with nowhere to store `order` has no frame sequence to sort, so the
    // button is absent for carousel/deck and every non-frame tool. Toggles the panel.
    if (frameCfg?.orderField) {
      const framesBtn = toolBtn(t('Artboards — reorder'), SVG.frame,
        (b) => { if (morePanel?.classList.contains('fc-frames-panel')) closeMorePanel(); else openFramesPanel(b); }, 'fc-btn-frames');
      framesBtn.setAttribute('data-tip', t('Artboards — reorder'));
    }
    // Auto-arrange, for a tool whose boxes can be JOINED (opt-in via canvas.bindStartField).
    // It used to hang off `canvas.connect`, the edge input; the graph it walks is now the
    // bindings on the path boxes themselves, so the button follows the bindings.
    if (hasBindCfg) {
      toolBtn(t('Auto-arrange the connected cards'), SVG.tidy, () => autoLayout());
    }
    // One "Arrange" menu — align + distribute + stacking order + group + clip
    // (previously two separate rail buttons). Every one of those acts ON a selection,
    // so the button only appears once there is one (syncArrangeUI, from the same
    // paint that shows the object bar). The right-click menu and the keyboard keep
    // their own gating — nothing here is the only way to reach an action.
    arrangeBtn = toolBtn(t('Arrange — align, distribute, order, group'), SVG.align, () => openArrangeMenu());
    syncArrangeUI();
    // Snap-to-grid toggle (opt-in).
    if (cv.grid) {
      const gbtn = toolBtn(t('Snap to grid'), SVG.grid, () => {
        gridOn = !gridOn;
        gbtn.classList.toggle('is-armed', gridOn);
        gbtn.setAttribute('aria-pressed', String(gridOn));
      });
      gbtn.setAttribute('aria-pressed', String(gridOn));
      if (gridOn) gbtn.classList.add('is-armed');
    }
    // Pages / canvas size, copy, share, document info and import all live in the
    // Lolly menu at the top of the rail now — see lollyItems() above.
    const sep = document.createElement('div'); sep.className = 'fc-sep'; toolbar.appendChild(sep);
    // Canvas background — the app's shared colour picker (swatches + hex + alpha).
    const bgWrap = document.createElement('div');
    bgWrap.className = 'fc-btn fc-color-btn';
    bgWrap.title = t('Canvas background');
    bgWrap.innerHTML = colorFieldHtml('fc-bg', getBg(), { float: true });
    bgWrap.addEventListener('pointerdown', (e) => e.stopPropagation());
    toolbar.appendChild(bgWrap);
    wireColorField(bgWrap, {
      onChange: (_id, val) => { onDirty?.(bgInputId); runtime.setInput(bgInputId, unwrapColor(val)); },
    });
    syncModeUI();     // Pointer lit on mount; the rail is never rebuilt after this
  }

  function fillPopover(el: HTMLElement, items: PopItem[]): void {
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'fc-pop-sep'; el.appendChild(s); continue; }
      // Icon-only grid row (e.g. align = 3 cols × 2 rows, distribute = 2 cols): each
      // action is a compact square button labelled only by its icon (title/aria carry
      // the text). `cols` drives the column count via a CSS var.
      if (it.grid) {
        const g = document.createElement('div');
        g.className = 'fc-pop-grid';
        g.style.setProperty('--cols', String(it.cols || it.grid.length));
        for (const gi of it.grid) {
          const gb = document.createElement('button');
          gb.type = 'button';
          gb.className = 'fc-pop-gitem' + (gi.danger ? ' fc-pop-danger' : '');
          gb.disabled = gi.disabled === true;
          gb.title = gi.label;
          gb.setAttribute('aria-label', gi.label);
          gb.innerHTML = gi.icon || '';
          gb.addEventListener('click', (e) => { e.stopPropagation(); if (gb.disabled) return; gi.run(); if (!gi.keepOpen) closePopover(); });
          g.appendChild(gb);
        }
        el.appendChild(g);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fc-pop-item' + (it.danger ? ' fc-pop-danger' : '') + (it.on ? ' is-on' : '');
      if (it.on !== undefined) { b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(it.on)); }
      if (it.key) b.dataset.pop = it.key;
      b.disabled = it.disabled === true;
      b.innerHTML = (it.icon ? `<span class="fc-pop-ic">${it.icon}</span>` : '') + `<span>${it.label}</span>`;
      b.addEventListener('click', (e) => { e.stopPropagation(); if (b.disabled) return; it.run(); if (!it.keepOpen) closePopover(); });
      el.appendChild(b);
    }
  }
  function spawnPopover(anchor: HTMLElement, items: PopItem[]): void {
    closePopover();
    popover = document.createElement('div');
    popover.className = 'fc-popover';
    fillPopover(popover, items);
    popover.addEventListener('pointerdown', (e) => e.stopPropagation());
    stageEl.appendChild(popover);
    const ar = anchor.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    const pr = popover.getBoundingClientRect();   // after append: it is laid out
    const pos = placePopover(
      { left: ar.left - sr.left, right: ar.right - sr.left, top: ar.top - sr.top },
      { w: pr.width, h: pr.height },
      { w: sr.width, h: sr.height },
    );
    popover.style.left = pos.left + 'px';
    popover.style.top = pos.top + 'px';
  }
  // Sequence editors (timeCfg) import a design file as SCENES instead: every
  // frame/board/page becomes a stored vector asset placed as one full-canvas clip
  // in the main sequence, appended after the existing timing so nothing the user
  // authored moves. One commit → one undo step; the timeline opens to show the
  // play-through. Returns the number of scenes added.
  async function importAsScenes(f: File | Blob, setStatus: (m: string) => void): Promise<number> {
    const { parseDesignScenes } = await import('./design-import.ts');
    const { DEFAULT_CLIP_S } = await import('./timeline-math.ts');
    const res = await parseDesignScenes(f, { host: host as any, log: setStatus, interactive: true, map: importMap });
    const scenes = res.scenes;
    if (!scenes.length) throw new Error(t('Nothing importable was found in that file.'));
    const tc = timeCfg!;
    const { w: cw, h: ch } = canvasWH();
    const all = [...getBoxes()];
    // Append after the current sequence's end — never disturb existing timing.
    let at = 0;
    for (const b of all) {
      if (String(b[tc.laneField] ?? '') !== 'seq') continue;
      const s = num(b[tc.startField], NaN);
      if (!Number.isFinite(s)) continue;
      const d = num(b[tc.durField], NaN);
      at = Math.max(at, s + (Number.isFinite(d) && d > 0 ? d : DEFAULT_CLIP_S));
    }
    for (const sc of scenes) {
      const id = freshId(all);
      all.push({
        [cfg.idField]: id, [cfg.kindField]: 'image',
        [cfg.xField]: 0, [cfg.yField]: 0, [cfg.wField]: cw, [cfg.hField]: ch,
        ...(cfg.imageField ? { [cfg.imageField]: sc.asset } : {}),
        ...(cfg.fitField ? { [cfg.fitField]: 'contain' } : {}),
        [tc.laneField]: 'seq', [tc.startField]: at, [tc.durField]: DEFAULT_CLIP_S,
        // A Penpot prototype flow carries the authored transition INTO each board;
        // scenes from a file without interactions carry neither key, so the box is
        // written exactly as it always was (enter defaults to 'none' — a cut).
        ...(sc.enter ? { [tc.enterField]: sc.enter } : {}),
        ...(sc.enterMs !== undefined ? { [tc.enterMsField]: sc.enterMs } : {}),
      } as unknown as Box);
      at += DEFAULT_CLIP_S;
    }
    if (disposed) return 0;
    selection = new Set<string>();
    commit(all);
    openTimeline();
    return scenes.length;
  }
  // Import a design file (Figma SVG / Penpot). The heavy DOM parser is lazy-loaded so it
  // only ships to sessions that actually import. On success we REPLACE the whole boxes
  // array (through the normal commit path) and resize the artboard to the file's frame.
  // On a sequence editor the same panel imports frames as scenes (importAsScenes).
  function openImportPanel(anchor: HTMLElement): void {
    closePopover();
    const panel = document.createElement('div');
    panel.className = 'fc-popover fc-import-panel';
    panel.style.width = '264px';
    panel.style.padding = '12px';
    panel.style.whiteSpace = 'normal';
    panel.innerHTML =
      `<div style="font-weight:700;margin-bottom:6px;">${t('Import a design')}</div>` +
      '<p style="margin:0 0 10px;font-size:12px;line-height:1.45;opacity:.82;">' +
      t('Drop a Figma <b>.fig</b> / SVG, a Penpot <b>.penpot</b>, an Illustrator <b>.ai</b> or <b>.pdf</b>, or an InDesign <b>.idml</b> (File → Export → InDesign Markup). (For editable text from a Figma <b>SVG</b>, uncheck “Outline text” on export.)') +
      '</p>' +
      (importScenesMode ? '<p style="margin:0 0 10px;font-size:12px;line-height:1.45;opacity:.82;">' +
        t('Every frame becomes its own scene on the timeline, ready for timing tweaks, music and voiceover.') +
        '</p>' : '') +
      '<button type="button" class="fc-import-choose" style="width:100%;padding:8px 12px;border:0;border-radius:8px;' +
      `background:#30BA78;color:#0c322c;font-weight:700;font-size:13px;cursor:pointer;">${t('Choose file…')}</button>` +
      // Components-as-templates: revealed once the chosen file turns out to
      // define components (countPenpotComponents peeks the zip), so a file
      // without a design system never shows a control that would do nothing.
      '<label class="fc-import-templates" hidden style="display:none;align-items:flex-start;gap:6px;margin-top:8px;font-size:12px;line-height:1.4;">' +
      '<input type="checkbox" checked style="margin-top:2px;"><span></span></label>' +
      '<div class="fc-import-status" role="status" aria-live="polite" style="margin-top:8px;font-size:12px;line-height:1.4;min-height:16px;"></div>';
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    stageEl.appendChild(panel);
    const ar = anchor.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    panel.style.left = Math.min(ar.right - sr.left + 8, sr.width - 272) + 'px';
    panel.style.top = Math.max(6, ar.top - sr.top) + 'px';
    popover = panel;

    const status = panel.querySelector<HTMLElement>('.fc-import-status')!;
    const chooseBtn = panel.querySelector<HTMLButtonElement>('.fc-import-choose')!;
    const tplRow = panel.querySelector<HTMLElement>('.fc-import-templates')!;
    const tplBox = tplRow.querySelector<HTMLInputElement>('input')!;
    const tplLabel = tplRow.querySelector<HTMLElement>('span')!;
    const fileEl = document.createElement('input');
    fileEl.type = 'file';
    fileEl.accept = '.fig,.svg,.penpot,.zip,.ai,.pdf,.idml,.indd,image/svg+xml,application/zip,application/pdf,application/illustrator';
    fileEl.style.display = 'none';
    panel.appendChild(fileEl);
    chooseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileEl.click(); });
    fileEl.addEventListener('change', async () => {
      const f = fileEl.files && fileEl.files[0];
      fileEl.value = '';
      if (!f) return;
      status.style.color = '';
      status.textContent = t('Importing…');
      // Re-hide the components offer for the NEW file. One handler serves every pick and
      // the panel survives a failed import (the auto-close is the last statement of the
      // try), so without this a Penpot file's "Also save 6 components as templates" row
      // stays on screen — checked — while a plain SVG is imported, offering something
      // that can never happen (componentCount is re-derived per file, and is 0).
      tplRow.hidden = true;
      tplRow.style.display = 'none';
      tplLabel.textContent = '';
      tplBox.checked = true;
      chooseBtn.disabled = true;
      try {
        if (importScenesMode) {
          // Sequence editor: frames become timed scenes (importAsScenes above).
          const n = await importAsScenes(f, (m: string) => { status.textContent = m; });
          status.style.color = '#128a5b';
          status.textContent = n === 1 ? t('Added 1 scene.') : t('Added {n} scenes.', { n });
        } else {
          const { parseDesignFile, countPenpotComponents, parseDesignTemplates } = await import('./design-import.ts');
          // A design system's component masters can also be saved as reusable
          // templates. The offer appears as soon as the chosen file turns out to
          // define components (a cheap peek at the zip's component records), and
          // the pass itself runs after the board import so the canvas is never
          // kept waiting on it. Needs the tool's identity to mint sessions with.
          const templateToolId = info?.id || '';
          let componentCount = 0;
          if (templateToolId) {
            componentCount = await countPenpotComponents(f);
            if (componentCount > 0) {
              tplLabel.textContent = componentCount === 1
                ? t('Also save 1 component as a template')
                : t('Also save {n} components as templates', { n: componentCount });
              tplRow.hidden = false;
              tplRow.style.display = 'flex';
            }
          }
          // interactive: a multi-page PDF/.ai asks which page (shared page-picker dialog)
          // instead of silently importing the first. `map` carries this tool's font
          // vocabulary + seed colours (importMap above) into the engine's box mapper.
          const res = await parseDesignFile(f, { host: host as any, log: (m: string) => { status.textContent = m; }, interactive: true, map: importMap });
          const boxes = (Array.isArray(res.boxes) ? res.boxes : []) as Box[];
          if (!boxes.length) throw new Error(t('Nothing importable was found in that file.'));
          selection = new Set<string>();
          commit(boxes);
          if (setCanvasSize && res.width > 0 && res.height > 0) setCanvasSize(res.width, res.height, 'px');
          status.style.color = '#128a5b';
          const imported = boxes.length === 1 ? t('Imported 1 object.') : t('Imported {n} objects.', { n: boxes.length });
          status.textContent = imported;
          if (componentCount > 0 && tplBox.checked) {
            // Never let the extra pass fail an import that already succeeded.
            try {
              status.textContent = `${imported} ${t('Saving templates…')}`;
              const { templates } = await parseDesignTemplates(f, {
                host: host as any,
                log: (m: string) => { status.textContent = `${imported} ${m}`; },
                // res.map carries the deck's own font families, already resolved
                // by the board import, so nothing is fetched or warned twice.
                map: res.map ?? importMap,
              });
              if (templates.length) {
                const { fileTemplatesAsSessions } = await import('../lib/design-templates.ts');
                const filed = await fileTemplatesAsSessions(host as any, templates, {
                  fileName: (f as File).name,
                  toolId: templateToolId,
                  toolVersion: info?.version,
                  boxesField: input.id,
                  format: info?.formats?.[0],
                  warn: (m: string) => { status.textContent = `${imported} ${m}`; },
                });
                status.textContent = `${imported} ${filed.saved === 1
                  ? tRaw('Saved 1 template in “{folder}”.', { folder: filed.folderName })
                  : tRaw('Saved {n} templates in “{folder}”.', { n: filed.saved, folder: filed.folderName })}`;
              } else {
                status.textContent = `${imported} ${t('No components could be saved as templates.')}`;
              }
            } catch (e) {
              status.textContent = `${imported} ${t('The components couldn’t be saved as templates.')}`;
            }
          }
        }
        setTimeout(() => { if (popover === panel) closePopover(); }, 1400);
      } catch (err) {
        status.style.color = '#c0362c';
        status.textContent = ((err as any) && (err as any).message) || t('Import failed.');
      } finally {
        chooseBtn.disabled = false;
      }
    });
  }
  // Right-click context menu at the cursor (desktop): a consolidated list of the
  // arrange / align / group / clip / edit actions.
  function openContextMenu(clientX: number, clientY: number): void {
    closePopover();
    const has = selection.size > 0;
    const multi = selection.size >= 2;
    // Outline text is the primary action on a selected text box, so it sits high in
    // the menu (right under Delete) rather than buried at the end of the vector-ops
    // section — where, for a text selection, every other entry is disabled and the
    // whole menu can run past the bottom of the screen. Shown only when there's an
    // outlinable text box in the selection AND the tool can store the result
    // (vectorCfg = pathField declared) AND host.text is present.
    const canOutlineText = Boolean(vectorCfg && cfg.textField && (host as unknown as HostV1).text);
    const outlinableCount = canOutlineText ? countSelected(isOutlinableTextBox) : 0;
    const items: PopItem[] = [
      { label: t('Duplicate'), icon: icon(SVG.dup), run: () => duplicateSelection(), disabled: !has },
      { label: t('Delete'), icon: icon(SVG.trash), run: () => deleteSelection(), disabled: !has, danger: true },
      { sep: true },
      ...(outlinableCount ? [
        { label: t('Outline text'), icon: icon(SVG.outlineText), run: () => void outlineTextOnSelection() },
        { sep: true } as PopItem,
      ] : []),
      // Stacking order — icons only, 2×2: columns are magnitude (one step │ all the
      // way), rows are direction (up = forward/front, down = backward/back).
      { grid: [
        { label: t('Bring forward'), icon: icon(SVG.forward), run: () => applyZ('forward'), disabled: !has },
        { label: t('Bring to front'), icon: icon(SVG.front), run: () => applyZ('front'), disabled: !has },
        { label: t('Send backward'), icon: icon(SVG.backward), run: () => applyZ('backward'), disabled: !has },
        { label: t('Send to back'), icon: icon(SVG.back), run: () => applyZ('back'), disabled: !has },
      ], cols: 2 },
      { sep: true },
      // Align — icons only, 3 across × 2 rows (L/C/R then T/M/B).
      { grid: [
        { label: t('Align left'), icon: icon(SVG.alignL), run: () => applyAlign('left'), disabled: !has },
        { label: t('Align centre'), icon: icon(SVG.alignC), run: () => applyAlign('hcentre'), disabled: !has },
        { label: t('Align right'), icon: icon(SVG.alignR), run: () => applyAlign('right'), disabled: !has },
        { label: t('Align top'), icon: icon(SVG.alignT), run: () => applyAlign('top'), disabled: !has },
        { label: t('Align middle'), icon: icon(SVG.alignM), run: () => applyAlign('vcentre'), disabled: !has },
        { label: t('Align bottom'), icon: icon(SVG.alignB), run: () => applyAlign('bottom'), disabled: !has },
      ], cols: 3 },
      // Distribute — icons only, one row of 2 (needs 3+ boxes).
      { grid: [
        { label: t('Distribute horizontally'), icon: icon(SVG.distH), run: () => applyDistribute('h'), disabled: selection.size < 3 },
        { label: t('Distribute vertically'), icon: icon(SVG.distV), run: () => applyDistribute('v'), disabled: selection.size < 3 },
      ], cols: 2 },
      { sep: true },
      { label: t('Group'), icon: icon(SVG.group), run: () => groupSelection(), disabled: !multi },
      { label: t('Ungroup'), icon: icon(SVG.ungroup), run: () => ungroupSelection(), disabled: !selHasGroup() },
      { label: t('Clip to bottom shape'), icon: icon(SVG.clip), run: () => clipSelection(), disabled: !multi },
      { label: t('Release clip'), icon: icon(SVG.unclip), run: () => releaseClip(), disabled: !selHasClip() },
    ];
    // ── timeline ───────────────────────────────────────────────────────────────
    // Right-click parity with the panel's own timing toggle. Present for any
    // time-capable tool — `timeCfg` is null on Carousel Maker, Org Chart and Record, so
    // their menu is byte-for-byte what it was. It deliberately does NOT also require a
    // MOUNTED panel: a Layout Studio composition that has never opened its timeline is
    // exactly the user who needs to discover this, and a menu whose height changes
    // between two right-clicks on the same object is the thing the section above avoids.
    // So the panel is loaded on demand and the writer runs once it exists.
    // The two writers live in timeline-panel.ts (promote composes moveOverlay +
    // setDuration in ONE commit; demote clears to '' and repacks a seq row) and are
    // called, never reimplemented. Timing is per-box, so the items act on a single
    // selection and disable rather than hide, like Ungroup above.
    if (timeCfg) {
      const rows = getBoxes();
      const i = selection.size === 1 ? rows.findIndex((b, n) => selection.has(idOf(b, n))) : -1;
      const one = i >= 0 ? rows[i]! : null;
      const oneId = one ? idOf(one, i) : '';
      const timed = !!one && isTimedBox(one);
      // Open (loading the chunk if this is the first time), THEN write — `ensureTimeline`
      // resolves only once `timelinePanel` is assigned, and bails silently if the module
      // failed to load, so a broken chunk means no write rather than a half-written box.
      const withPanel = (fn: (p: NonNullable<typeof timelinePanel>) => void) => () => {
        void ensureTimeline(true).then(() => { if (timelinePanel) fn(timelinePanel); });
      };
      items.push({ sep: true });
      items.push({
        label: t('Add to the timeline'), icon: icon(SVG.timeline),
        run: withPanel((p) => p.promote(oneId)), disabled: !one || timed,
      });
      items.push({
        label: t('Make always on'), icon: icon(SVG.boxKind),
        run: withPanel((p) => p.demote(oneId)), disabled: !timed,
      });
    }
    // ── vector operations ──────────────────────────────────────────────────────
    // Present only for tools whose manifest declares `canvas.pathField` (there is
    // nowhere to store a result otherwise); WITHIN the section every entry disables
    // rather than hides, like Ungroup / Release clip above, so the menu keeps the same
    // height between right-clicks.
    if (vectorCfg) {
      const regions = countSelected((b) => boxOutlineKind(b, vectorCfg) !== 'none');
      const paths = countSelected((b) => boxOutlineKind(b, vectorCfg) === 'path');
      // A boolean needs two operands that actually bound a region — two text boxes are
      // two selected boxes and no shapes at all.
      const boolItem = (op: BooleanOpName, label: string, ic: string): PopGridItem => ({
        label, icon: icon(ic), disabled: regions < 2,
        run: () => runVectorOp((ops, id) => booleanBoxes(ops, op, { cfg: vectorCfg, id }),
          { skipNote: true, empty: boolEmptyMessage(op) }),
      });
      items.push({ sep: true });
      items.push({ cols: 4, grid: [
        boolItem('union', t('Union - merge into one shape'), SVG.boolUnion),
        // Operand order is vector-ops' documented convention and Illustrator's/Figma's:
        // the BOTTOMMOST selected shape is the base and everything above is taken away.
        boolItem('difference', t('Subtract - remove the shapes above from the bottom one'), SVG.boolSubtract),
        boolItem('intersect', t('Intersect - keep only where they overlap'), SVG.boolIntersect),
        boolItem('xor', t('Exclude - keep everything but the overlap'), SVG.boolExclude),
      ] });
      items.push({ label: t('Outline stroke…'), icon: icon(SVG.outlineStroke), disabled: !regions, run: () => askOutlineStroke() });
      items.push({ label: t('Offset path…'), icon: icon(SVG.offsetPath), disabled: !regions, run: () => askOffsetPath() });
      items.push({
        label: t('Simplify'), icon: icon(SVG.simplify), disabled: !paths,
        run: () => runVectorOp((ops, id) => simplifyBoxes(ops, SIMPLIFY_TOL, { cfg: vectorCfg, id }), { each: true }),
      });
      // NOTE: "Outline text" lives near the TOP of this menu (just under Delete), not
      // here — see the canOutlineText block at the head of openContextMenu. It is the
      // gateway INTO vector editing for a text box, so it must not sit below a wall of
      // path-only ops that are all disabled while text is selected.
    }
    // ── remove background ──────────────────────────────────────────────────────
    // Present for any tool with an image field (somewhere to store the cutout)
    // once the on-device matte capability has a STAGED model — otherwise absent,
    // like the timeline/vector sections. Acts on ONE selected image box and, like
    // Ungroup / the vector ops, disables rather than hides so the menu keeps a
    // constant height between right-clicks.
    const matteApi = (host as unknown as HostV1).matte;
    if (cfg.imageField && matteApi?.isAvailable() === true && matteApi.models().length > 0) {
      const rows = getBoxes();
      const idxs = selIndices(rows);
      const one = idxs.length === 1 ? rows[idxs[0]!]! : null;
      const img = one ? (one[cfg.imageField] as { id?: string; url?: string } | undefined) : undefined;
      items.push({ sep: true });
      items.push({
        label: t('Remove background'), icon: icon(SVG.scissors),
        run: () => void removeBackgroundOnSelection(),
        disabled: !(img?.id || img?.url),
      });
    }
    lastMenuAt = { x: clientX, y: clientY };
    popover = document.createElement('div');
    popover.className = 'fc-popover fc-context-menu';
    fillPopover(popover, items);
    popover.addEventListener('pointerdown', (e) => e.stopPropagation());
    stageEl.appendChild(popover);
    const sr = stageEl.getBoundingClientRect();
    const left = Math.max(6, Math.min(clientX - sr.left, sr.width - popover.offsetWidth - 6));
    const top = Math.max(6, Math.min(clientY - sr.top, sr.height - popover.offsetHeight - 6));
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }
  // Open the menu at a point, selecting whatever is under it first (a right-click on an
  // unselected box acts on THAT box, not on the stale selection). Shared by the desktop
  // `contextmenu` event and the touch two-finger tap below, so both behave identically.
  function contextMenuAt(clientX: number, clientY: number, soloBox: boolean): void {
    if (editing) commitTextEdit();
    // While node editing, right-click is a NODE menu (align/distribute/continuity/delete),
    // not the object menu — and it must not re-select boxes underneath.
    if (penEdit) { openPenNodeMenu(clientX, clientY); return; }
    const nat = clientToNative(clientX, clientY);
    const boxes = getBoxes();
    const hit = selectHit(boxes, nat.x, nat.y);   // artboard-aware: child over frame; frame on empty area
    if (hit >= 0 && !selection.has(idOf(boxes[hit], hit))) {
      selection = new Set(selectionForHit(boxes, hit, soloBox));
      renderChrome();
    }
    openContextMenu(clientX, clientY);
  }
  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    contextMenuAt(e.clientX, e.clientY, e.altKey);
  }

  const ADD_KIND_ICON: Record<string, string> = {
    image: SVG.image, text: SVG.type, box: SVG.boxKind, lottie: SVG.anim, video: SVG.video,
    // Sequence Studio's kinds — without these all three fell back to the generic "+".
    clip: SVG.clipKind, card: SVG.boxKind, audio: SVG.audioKind, tool: SVG.toolKind,
    // The frame primitive (plan 93) — the artboard "#" rather than a bare "+".
    frame: SVG.frame,
  };
  function openAddMenu(anchor: HTMLElement): void {
    spawnPopover(anchor, addKinds.map((k) => ({
      label: k.label ? t(k.label) : k.id,
      icon: icon(ADD_KIND_ICON[k.id] || SVG.add),
      run: () => setMode('create', { kind: k }),
    })));
  }
  function openArrangeMenu(): void {
    const has = selection.size > 0;
    const multi = selection.size >= 2;
    const canDist = selection.size >= 3;
    spawnPopover(arrangeBtn!, [
      // Align — a compact 3×2 icon grid (left/centre/right · top/middle/bottom).
      { cols: 3, grid: [
        { label: t('Align left'), icon: icon(SVG.alignL), run: () => applyAlign('left') },
        { label: t('Align centre'), icon: icon(SVG.alignC), run: () => applyAlign('hcentre') },
        { label: t('Align right'), icon: icon(SVG.alignR), run: () => applyAlign('right') },
        { label: t('Align top'), icon: icon(SVG.alignT), run: () => applyAlign('top') },
        { label: t('Align middle'), icon: icon(SVG.alignM), run: () => applyAlign('vcentre') },
        { label: t('Align bottom'), icon: icon(SVG.alignB), run: () => applyAlign('bottom') },
      ] },
      // Distribute — needs 3+ selected, so disabled otherwise.
      { cols: 2, grid: [
        { label: t('Distribute horizontally'), icon: icon(SVG.distH), run: () => applyDistribute('h'), disabled: !canDist },
        { label: t('Distribute vertically'), icon: icon(SVG.distV), run: () => applyDistribute('v'), disabled: !canDist },
      ] },
      { sep: true },
      { label: t('Bring to front'), icon: icon(SVG.front), run: () => has && applyZ('front') },
      { label: t('Bring forward'), icon: icon(SVG.forward), run: () => has && applyZ('forward') },
      { label: t('Send backward'), icon: icon(SVG.backward), run: () => has && applyZ('backward') },
      { label: t('Send to back'), icon: icon(SVG.back), run: () => has && applyZ('back') },
      { sep: true },
      { label: t('Group'), icon: icon(SVG.group), run: () => multi && groupSelection() },
      { label: t('Ungroup'), icon: icon(SVG.ungroup), run: () => ungroupSelection() },
      { sep: true },
      { label: t('Clip to bottom shape'), icon: icon(SVG.clip), run: () => multi && clipSelection() },
      { label: t('Release clip'), icon: icon(SVG.unclip), run: () => releaseClip() },
    ]);
  }

  // ── contextual bar ───────────────────────────────────────────────────────────

  /** Is every selected box a vector path box? Stroke paint only means something there —
   *  every other kind is a styled div, whose "border" is a different mechanism entirely —
   *  so a mixed selection gets no stroke controls rather than controls that write a field
   *  half the selection ignores. */
  function selectionAllPaths(boxes: Box[], idx: number[]): boolean {
    if (!vectorCfg || !idx.length) return false;
    return idx.every((i) => boxOutlineKind(boxes[i], vectorCfg!) === 'path');
  }

  /**
   * The PAINT section of a contextual bar: fill, text colour, and — on a path selection —
   * stroke colour plus the button onto the rest of the stroke (width, style, ends, corners,
   * fill rule).
   *
   * Shared by the object bar and the pen's node-editing bar because the pen bar REPLACES
   * `ctxbar.innerHTML`: without sharing, every paint control vanished at exactly the moment
   * the user was shaping the thing they wanted to paint. Composed rather than appended so
   * each bar keeps deciding its own order.
   */
  function paintCtxHtml(first: Box, allPaths: boolean): string {
    const fillVal = cfg.fillField ? (first[cfg.fillField] || 'transparent') : '';
    const fgVal = cfg.textColorField ? (first[cfg.textColorField] || '#0c322c') : '#0c322c';
    const strokeVal = cfg.strokeField ? (first[cfg.strokeField] || 'transparent') : 'transparent';
    // While a gradient is being edited on the canvas, the SAME field edits the
    // selected stop's colour instead of the flat fill — so the brand swatch palette
    // (the whole reason to reuse this control) is one click from every stop.
    const gradOn = gradEdit != null;
    const fillTitle = gradOn ? t('Gradient stop colour') : t('Fill');
    const fillShown = gradOn ? (gradStopColor(first) ?? fillVal) : fillVal;
    return (cfg.fillField ? `<span class="fc-cfield" title="${escape(fillTitle)}">${colorFieldHtml('fc-fill', fillShown, { float: true })}</span>` : '')
      + (cfg.gradField && !allPaths
        ? `<button type="button" class="fc-cbtn${gradOn ? ' is-on' : ''}" data-cx="grad" aria-pressed="${gradOn}" title="${escape(t('Gradient — drag the stops on the canvas'))}" aria-label="${escape(t('Gradient fill'))}">${icon(SVG.gradIc)}</button>`
        : '')
      + (cfg.textColorField && !allPaths ? `<span class="fc-cfield" title="${escape(t('Text colour'))}">${colorFieldHtml('fc-fg', fgVal, { float: true })}</span>` : '')
      + (allPaths && cfg.strokeField ? `<span class="fc-cfield" title="${escape(t('Stroke colour'))}">${colorFieldHtml('fc-stroke', strokeVal, { float: true })}</span>` : '')
      + (allPaths ? `<button type="button" class="fc-cbtn" data-cx="stroke" title="${escape(t('Stroke — width, style, ends, corners, fill rule'))}" aria-label="${escape(t('Stroke options'))}">${icon(SVG.strokeIc)}</button>` : '');
  }

  /** One `wireColorField` call per bar — it binds delegated listeners on the scope, so a
   *  second call on the same element would fire every change twice. */
  function wirePaintCtx(scope: HTMLElement): void {
    wireColorField(scope, {
      onChange: (id, val) => {
        if (id === 'fc-fill') {
          if (gradEdit != null) setGradStopColor(unwrapColor(val));
          else setField(cfg.fillField, unwrapColor(val));
        }
        else if (id === 'fc-fg') setField(cfg.textColorField, unwrapColor(val));
        else if (id === 'fc-stroke') setField(cfg.strokeField, unwrapColor(val));
      },
    });
  }

  // Every box is ONE unified object (fill + shape + image + text), so the bar
  // always offers every control. Rebuilt only when the selection set changes (so
  // the colour pickers show the selected box); positioned each frame elsewhere.
  function rebuildCtxBar(boxes: Box[], idx: number[]): void {
    // The gradient panel outlives a ctx-bar rebuild. Selecting a stop (and picking a
    // stop colour) deliberately rebuilds the bar so its Fill field shows that stop —
    // and `closeMorePanel()` below would take the panel with it every time, so the
    // panel vanished the moment you touched a handle. Re-request it instead; the sync
    // that follows reopens it against the freshly built button.
    if (gradEdit != null && morePanel?.classList.contains('fc-grad-panel')) gradPanelPending = true;
    closeMorePanel();
    const coarse = matchMedia('(pointer: coarse)').matches;   // touch → offer add-to-selection
    const first: Box = boxes[idx[0]!] || {};
    const allPaths = selectionAllPaths(boxes, idx);
    ctxbar.innerHTML = `
      ${paintCtxHtml(first, allPaths)}
      ${vectorCfg && idx.length === 1 && boxOutlineKind(first, vectorCfg) === 'path'
        ? `<button type="button" class="fc-cbtn" data-cx="nodes" title="${escape(t('Edit points (double-click)'))}" aria-label="${escape(t('Edit points'))}">${icon(SVG.nodes)}</button>`
        : ''}
      <button type="button" class="fc-cbtn" data-cx="edit" title="${escape(t('Edit text (double-click)'))}" aria-label="${escape(t('Edit text'))}">${icon(SVG.pencil)}</button>
      <button type="button" class="fc-cbtn fc-cbtn-text" data-cx="text" title="${escape(t('Text — size, font, weight, line height, kerning, ligatures, alignment'))}" aria-label="${escape(t('Text options'))}">Aa</button>
      <button type="button" class="fc-cbtn" data-cx="setimg" title="${escape(t('Set image'))}" aria-label="${escape(t('Set image'))}">${icon(SVG.image)}</button>
      <button type="button" class="fc-cbtn" data-cx="more" title="${escape(t('More — shape, radius, opacity, fit, blend, shadow'))}" aria-label="${escape(t('More options'))}">${icon(SVG.more)}</button>
      <span class="fc-sep fc-sep-v"></span>
      <button type="button" class="fc-cbtn" data-cx="dup" title="${escape(t('Duplicate'))}" aria-label="${escape(t('Duplicate'))}">${icon(SVG.dup)}</button>
      <button type="button" class="fc-cbtn fc-danger" data-cx="del" title="${escape(t('Delete'))}" aria-label="${escape(t('Delete'))}">${icon(SVG.trash)}</button>
      ${coarse ? `<button type="button" class="fc-cbtn${multiTapMode ? ' is-on' : ''}" data-cx="multi" aria-pressed="${multiTapMode}" title="${escape(t('Select more — tap cards to add'))}" aria-label="${escape(t('Select more cards'))}">${icon(SVG.add)}</button>` : ''}
      <button type="button" class="fc-readout" data-cx="dims" data-cx-readout title="${escape(t('Edit position & size'))}" aria-label="${escape(t('Edit position and size'))}"></button>`;
    wirePaintCtx(ctxbar);
    ctxbar.querySelectorAll<HTMLElement>('[data-cx]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const cx = b.dataset.cx;
      if (cx === 'text') openTextPanel(b);
      else if (cx === 'stroke') openStrokePanel(b);
      else if (cx === 'nodes') { if (selection.size) startPenEdit([...selection][0]!); }
      else if (cx === 'edit') { if (selection.size) startTextEdit([...selection][0]!, { selectAll: true }); }
      else if (cx === 'dup') duplicateSelection();
      else if (cx === 'del') deleteSelection();
      else if (cx === 'setimg') pickImage();
      else if (cx === 'more') openMorePanel(b);
      else if (cx === 'grad') toggleGradEdit(b);
      else if (cx === 'multi') { multiTapMode = !multiTapMode; b.classList.toggle('is-on', multiTapMode); b.setAttribute('aria-pressed', String(multiTapMode)); announce(multiTapMode ? t('Select more — tap cards to add them.') : t('Multi-select off.')); }
      else if (cx === 'dims') openDimsPanel(b);
    }));
  }

  // ── on-canvas gradient editing ────────────────────────────────────────────────
  //
  // A gradient is the one paint property that is genuinely spatial: its stops sit
  // SOMEWHERE on the shape, and picking them off a list of numbers means guessing.
  // So the stops are handles on the artboard, dragged along the gradient's own line,
  // with the direction on a handle of its own.
  //
  // The model is the engine's gradient spec (a string on the box's `grad` field), and
  // the CSS comes from `gradientSpecToCss` — the SAME call the tool's hooks make, so
  // what the handles show and what the export writes cannot drift. The stops are
  // interpolated in OKLab and baked to sRGB by the engine (plans/60-color-spaces.md §10),
  // which is what keeps a two-colour gradient from going muddy through the middle.
  //
  // Colour picking deliberately reuses the ctx bar's Fill field: in gradient mode it
  // edits the SELECTED STOP, so the brand palette is one click from every stop rather
  // than being re-implemented here.
  let gradEdit: string | null = null;   // box id being edited, or null
  let gradStopIdx = 0;                  // which stop the Fill field + Delete act on
  // The panel is opened by the SYNC, not by the click that asks for it. Entering
  // gradient mode resets `ctxSelKey` so the ctx bar rebuilds (its Fill field changes
  // meaning), and `rebuildCtxBar` begins with `closeMorePanel()` — so a panel opened
  // synchronously was destroyed a frame later by the very re-sync that opening it
  // required. Found in a browser, invisible to review: the handles appeared, the panel
  // did not, and any click into it hit a detached node.
  let gradPanelPending = false;
  // The spec mid-drag. `writeGradSpec(…, live)` only touches the box's own
  // backgroundImage (no setInput, so the tool does not re-render per pointermove), so
  // without this the chrome kept repainting from the COMMITTED model: the grabbed
  // handle was destroyed and rebuilt at its pre-drag position on every frame while the
  // paint underneath followed the pointer. Same idea as `liveRects` for box gestures.
  let gradLive: GradientSpec | null = null;

  // The gradient line, as an SVG in STAGE px — redrawn each sync. Stage px rather than
  // native-with-a-viewBox (the pen layer's trick) because the stop handles are DOM
  // divs that must not scale with zoom, and one coordinate system for both is simpler
  // to keep honest than two.
  const gradLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  gradLayer.setAttribute('class', 'fc-grad-layer');
  gradLayer.style.position = 'absolute';
  gradLayer.style.left = '0';
  gradLayer.style.top = '0';
  gradLayer.style.overflow = 'visible';
  gradLayer.style.pointerEvents = 'none';
  gradLayer.style.display = 'none';
  overlay.appendChild(gradLayer);
  const gradChrome = document.createElement('div');
  gradChrome.className = 'fc-grad-chrome';
  overlay.appendChild(gradChrome);

  /** The parsed spec on a box, or null when it has no (readable) gradient. */
  const gradSpecOf = (b: Box | undefined): GradientSpec | null =>
    (b && cfg.gradField ? parseGradientSpec(String(b[cfg.gradField] ?? '')) : null);

  /** Index of the box being gradient-edited, or -1 (it may have been deleted). */
  function gradIndex(boxes: Box[]): number {
    if (gradEdit == null) return -1;
    return boxes.findIndex((b, i) => idOf(b, i) === gradEdit);
  }

  /** Leave gradient mode and drop its chrome. Safe to call when not in it. */
  function exitGradEdit(): void {
    if (gradEdit == null) return;
    gradEdit = null;
    gradStopIdx = 0;
    gradPanelPending = false;
    gradLive = null;
    gradLayer.style.display = 'none';
    gradChrome.innerHTML = '';
    ctxSelKey = '';        // force the ctx bar to rebuild without the stop-colour mode
    scheduleSync();
  }

  /**
   * A fresh gradient for a box that has none: its own fill, ramped toward white.
   *
   * Deliberately not fill→transparent: the point of the first click is to SHOW what a
   * gradient does here, and an OKLab ramp to a light tint does that while staying
   * on-brand (it keeps the fill's hue). A transparent second stop would look like
   * nothing happened on a light artboard.
   */
  function seedGradSpec(b: Box): GradientSpec {
    const fill = cfg.fillField ? String(b[cfg.fillField] ?? '') : '';
    const base = parseColor(fill) ? fill : '#30ba78';
    const light = colorToHexString(interpolateColor(parseColor(base)!, parseColor('#ffffff')!, 0.7));
    return parseGradientSpec(`lin_90_${base.replace('#', '')}-0_${light.replace('#', '')}-100`)!;
  }

  /** Enter/leave gradient mode for the current selection. */
  function toggleGradEdit(anchor: HTMLElement): void {
    if (!cfg.gradField) return;
    if (gradEdit != null) { exitGradEdit(); return; }
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (idx.length !== 1) {
      announce(t('Select one card to edit its gradient.'));
      return;
    }
    const b = boxes[idx[0]!]!;
    gradEdit = idOf(b, idx[0]!);
    gradStopIdx = 0;
    // A box with no gradient yet gets one, in the same step that opens the editor —
    // otherwise the handles would have nothing to sit on.
    if (!gradSpecOf(b)) writeGradSpec(seedGradSpec(b), false);
    ctxSelKey = '';
    gradPanelPending = true;
    void anchor;              // the panel anchors on the rebuilt button, not this one
    scheduleSync();
  }

  /**
   * Write a spec to the box being edited. `live` mutates only that box's DOM (a drag
   * in progress — no setInput, so the tool does not re-render every pointermove, the
   * same discipline every other gesture here follows); otherwise it commits one undo
   * step through the model.
   */
  function writeGradSpec(spec: GradientSpec, live: boolean): void {
    if (!cfg.gradField || gradEdit == null) return;
    const value = formatGradientSpec(spec);
    if (live) {
      gradLive = spec;
      const el = canvasEl.querySelector<HTMLElement>(`.lolly-box[data-box-id="${cssEscape(gradEdit)}"]`);
      if (el) el.style.backgroundImage = gradientSpecToCss(spec) || '';
      return;
    }
    gradLive = null;
    const boxes = getBoxes();
    const i = gradIndex(boxes);
    if (i < 0) return;
    commit(boxes.map((b, j) => (j === i ? { ...b, [cfg.gradField]: value } : b)));
  }

  /** The selected stop's colour, for the ctx bar's Fill field. */
  function gradStopColor(b: Box | undefined): string | null {
    const spec = gradSpecOf(b);
    return spec ? (spec.stops[Math.min(gradStopIdx, spec.stops.length - 1)]?.color ?? null) : null;
  }

  /** Point the ctx bar's Fill field at the selected stop. */
  function setGradStopColor(hex: unknown): void {
    const boxes = getBoxes();
    const i = gradIndex(boxes);
    const spec = i >= 0 ? gradSpecOf(boxes[i]) : null;
    if (!spec) return;
    const at = Math.min(gradStopIdx, spec.stops.length - 1);
    const colour = String(hex ?? '').trim();
    if (!colour || !parseColor(colour)) return;
    spec.stops[at] = { ...spec.stops[at]!, color: colour };
    writeGradSpec(spec, false);
  }

  /** Add a stop at `pos`, coloured as the gradient already is there. */
  function insertGradStop(spec: GradientSpec, pos: number): GradientSpec {
    if (spec.stops.length >= MAX_GRADIENT_STOPS) return spec;
    let at = spec.stops.findIndex((s) => s.pos > pos);
    if (at < 0) at = spec.stops.length;
    const before = spec.stops[Math.max(0, at - 1)]!;
    const after = spec.stops[Math.min(spec.stops.length - 1, at)]!;
    const span = after.pos - before.pos;
    const f = span > 0 ? (pos - before.pos) / span : 0;
    const ca = parseColor(before.color);
    const cb = parseColor(after.color);
    // Sampled through the engine in the spec's OWN space, so the new stop lands on the
    // curve the user can see rather than on the sRGB chord through it.
    const colour = ca && cb
      ? colorToHexString(interpolateColor(ca, cb, f, { space: spec.space, hue: spec.hue }))
      : before.color;
    const stops = [...spec.stops];
    stops.splice(at, 0, { color: colour, pos });
    gradStopIdx = at;
    return { ...spec, stops };
  }

  /** Remove the selected stop (a gradient needs two, so this refuses at two). */
  function deleteGradStop(): boolean {
    const boxes = getBoxes();
    const i = gradIndex(boxes);
    const spec = i >= 0 ? gradSpecOf(boxes[i]) : null;
    if (!spec || spec.stops.length <= 2) return false;
    const stops = spec.stops.filter((_, j) => j !== Math.min(gradStopIdx, spec.stops.length - 1));
    gradStopIdx = Math.max(0, Math.min(gradStopIdx, stops.length - 1));
    writeGradSpec({ ...spec, stops }, false);
    ctxSelKey = '';
    return true;
  }

  /**
   * Draw the gradient line + one handle per stop + the direction handle.
   *
   * Rebuilt (not repositioned) each sync: a gradient has a handful of handles and the
   * set changes whenever a stop is added or removed, so the build-once/reposition-many
   * discipline the selection chrome needs would only buy bookkeeping here.
   */
  function paintGradChrome(boxes: Box[], m: Metrics): void {
    if (gradEdit == null) {
      if (gradLayer.style.display !== 'none') { gradLayer.style.display = 'none'; gradChrome.innerHTML = ''; }
      return;
    }
    const i = gradIndex(boxes);
    // Prefer the in-flight spec so the handles track the pointer, not the last commit.
    const spec = i >= 0 ? (gradLive ?? gradSpecOf(boxes[i])) : null;
    if (!spec) {
      // The box (or its gradient) is gone — leave the mode rather than showing handles
      // for something that no longer exists.
      if (gradEdit != null) exitGradEdit();
      return;
    }
    const r = boxRect(boxes[i]!, cfg);
    const line = gradientLine(r.w, r.h, spec.angle);
    const off = frameOffsetOfEl(canvasEl.querySelector(`.lolly-box[data-box-id="${cssEscape(gradEdit!)}"]`) ?? canvasEl);
    // Through the box's ROTATION, not a plain translation: the same element that paints
    // the gradient carries `transform: rotate()`, so an axis-aligned mapping left the
    // line and swatches ~76px off the visible sweep on a 200×120 box at 45°, and every
    // drag then wrote a position that did not match the point under the cursor.
    const toStage = (p: { x: number; y: number }) => {
      const f = localToFrame(r as PenFrame, p.x, p.y);
      return nativeToStage(f.x + off.x, f.y + off.y, m);
    };
    const a = toStage(line.from);
    const b = toStage(line.to);

    gradLayer.style.display = '';
    gradLayer.setAttribute('width', String(Math.max(1, m.sr.width)));
    gradLayer.setAttribute('height', String(Math.max(1, m.sr.height)));
    // Two strokes: a dark halo under a light rule, so the line stays visible over any
    // artwork (the same reason the guides layer doubles up).
    gradLayer.innerHTML =
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="fc-grad-line-halo"/>`
      + `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="fc-grad-line"/>`;

    gradChrome.innerHTML = '';
    const lerpStage = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    spec.stops.forEach((st, si) => {
      const p = lerpStage(Math.min(100, Math.max(0, st.pos)) / 100);
      const h = document.createElement('div');
      h.className = 'fc-grad-stop' + (si === Math.min(gradStopIdx, spec.stops.length - 1) ? ' is-on' : '');
      h.style.left = `${p.x}px`;
      h.style.top = `${p.y}px`;
      // The handle IS its colour — a swatch you can see against the paint behind it.
      h.style.setProperty('--stop', parseColor(st.color) ? st.color : 'transparent');
      h.title = t('Stop {n} — {pos}%', { n: String(si + 1), pos: String(Math.round(st.pos)) });
      h.setAttribute('aria-label', h.title);
      h.addEventListener('pointerdown', (e) => onGradStopDown(e, si));
      gradChrome.appendChild(h);
    });
    // Direction handle, past the 100% end — far enough that its fat touch target
    // clears the last stop's. Appended FIRST so the stops paint (and hit-test) above
    // it: at 18px the two overlapped, and dragging the 100% stop silently rotated the
    // gradient instead of moving the stop.
    const dirLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dir = document.createElement('div');
    dir.className = 'fc-grad-dir';
    dir.style.left = `${b.x + ((b.x - a.x) / dirLen) * 30}px`;
    dir.style.top = `${b.y + ((b.y - a.y) / dirLen) * 30}px`;
    dir.title = t('Drag to set the gradient direction (hold Shift to snap)');
    dir.setAttribute('aria-label', dir.title);
    dir.addEventListener('pointerdown', onGradDirDown);
    gradChrome.insertBefore(dir, gradChrome.firstChild);
  }

  // Native (box-local) coords for a pointer event, in the edited box's own frame.
  function gradLocal(e: PointerEvent, boxes: Box[], i: number): { x: number; y: number; w: number; h: number } {
    const r = boxRect(boxes[i]!, cfg);
    const el = canvasEl.querySelector(`.lolly-box[data-box-id="${cssEscape(gradEdit!)}"]`);
    const off = frameOffsetOfEl(el ?? canvasEl);
    const n = clientToNative(e.clientX, e.clientY);
    // The exact inverse of paintGradChrome's mapping, rotation included.
    const l = frameToLocal(r as PenFrame, n.x - off.x, n.y - off.y);
    return { x: l.x, y: l.y, w: r.w, h: r.h };
  }

  function onGradStopDown(e: PointerEvent, si: number): void {
    e.stopPropagation();
    e.preventDefault();
    const boxes = getBoxes();
    const i = gradIndex(boxes);
    const spec0 = i >= 0 ? gradSpecOf(boxes[i]) : null;
    if (!spec0) return;
    gradStopIdx = si;
    ctxSelKey = '';                    // the Fill field now shows THIS stop
    let spec = spec0;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const l = gradLocal(ev, boxes, i);
      const pos = Math.round(gradientPosAt(l.w, l.h, spec.angle, l.x, l.y));
      const stops = [...spec.stops];
      stops[si] = { ...stops[si]!, pos };
      spec = { ...spec, stops };
      moved = true;
      writeGradSpec(spec, true);       // live: mutate the box's own background only
      scheduleSync();
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      (ev.target as Element)?.releasePointerCapture?.(ev.pointerId);
      // A tap with no movement just selects the stop; a drag commits one undo step.
      if (moved) writeGradSpec(spec, false);
      else scheduleSync();
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    scheduleSync();
  }

  function onGradDirDown(e: PointerEvent): void {
    e.stopPropagation();
    e.preventDefault();
    const boxes = getBoxes();
    const i = gradIndex(boxes);
    const spec0 = i >= 0 ? gradSpecOf(boxes[i]) : null;
    if (!spec0) return;
    let spec = spec0;
    const move = (ev: PointerEvent) => {
      const l = gradLocal(ev, boxes, i);
      spec = { ...spec, angle: gradientAngleAt(l.w, l.h, l.x, l.y, ev.shiftKey ? 15 : 0) };
      writeGradSpec(spec, true);
      scheduleSync();
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      (ev.target as Element)?.releasePointerCapture?.(ev.pointerId);
      writeGradSpec(spec, false);
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /**
   * Gradient panel: kind, interpolation space, hue route, add/remove a stop, clear.
   *
   * The interpolation control is the reason this panel exists at all. Every other
   * gradient tool bakes sRGB and leaves you to fight the grey middle; here the space
   * is the user's choice, defaulting to OKLab. The options are named for what they
   * give you — Smooth / Vivid — with sRGB named plainly rather than editorialised: it
   * is the classic behaviour, and someone matching an existing asset wants it without
   * being told off for asking.
   *
   * Those names now come from `lib/blend-style.ts`, because Colour Lab's blend ramp
   * offers the same choice and the vocabulary is only worth having if it is the same
   * one in both places.
   */
  function openGradPanel(anchor: HTMLElement): void {
    closeMorePanel();
    const boxes = getBoxes();
    const i = gradIndex(boxes);
    const spec = i >= 0 ? gradSpecOf(boxes[i]) : null;
    if (!spec) return;
    const polar = isPolarSpace(spec.space);
    const segRow = (lbl: string, seg: string): string =>
      `<div class="fc-row"><span class="fc-row-lbl"><span>${escape(lbl)}</span></span>${seg}</div>`;
    const p = document.createElement('div');
    p.className = 'fc-panel fc-grad-panel';
    p.innerHTML =
      segRow(t('Gradient'), segHtml('gradkind', spec.kind, [
        ['linear', t('Linear')], ['radial', t('Radial')], ['conic', t('Conic')]]))
      + segRow(t('Blend'), segHtml('gradspace', spec.space,
        BLEND_STYLES.map(b => [b.space, t(b.label)] as [string, string])))
      + (polar ? segRow(t('Hue route'), segHtml('gradhue', spec.hue || 'shorter',
        HUE_ROUTES.map(r => [r.dir, t(r.label)] as [string, string]))) : '')
      + `<div class="fc-row fc-grad-row-btns">`
      + `<button type="button" class="fc-pop-item" data-gp="add">${t('Add stop')}</button>`
      + `<button type="button" class="fc-pop-item" data-gp="del"${spec.stops.length <= 2 ? ' disabled' : ''}>${t('Remove stop')}</button>`
      + `<button type="button" class="fc-pop-item fc-danger" data-gp="clear">${t('No gradient')}</button>`
      + `</div>`;
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    wireSegs(p, (field, v) => {
      const cur = gradSpecOf(getBoxes()[gradIndex(getBoxes())]);
      if (!cur || !v) return;
      if (field === 'gradkind') writeGradSpec({ ...cur, kind: v as GradientSpec['kind'] }, false);
      else if (field === 'gradspace') writeGradSpec({ ...cur, space: v as GradientSpec['space'] }, false);
      else if (field === 'gradhue') writeGradSpec({ ...cur, hue: v as GradientSpec['hue'] }, false);
      // Reopen so a space change can show/hide the hue row against the new state —
      // through the pending flag, for the same reason the first open goes that way.
      if (field === 'gradspace') { gradPanelPending = true; scheduleSync(); }
    });
    p.querySelectorAll<HTMLElement>('[data-gp]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = gradSpecOf(getBoxes()[gradIndex(getBoxes())]);
      if (!cur) return;
      if (btn.dataset.gp === 'add') {
        // Halfway between the selected stop and the NEXT one. On the last stop there is
        // no next, so go halfway back to the previous instead — the seeded gradient
        // selects a stop at 100%, where "halfway to itself" is 100% and the button did
        // nothing at all.
        const at = Math.min(gradStopIdx, cur.stops.length - 1);
        const here = cur.stops[at]!.pos;
        const neighbour = at + 1 < cur.stops.length ? cur.stops[at + 1]!.pos : cur.stops[Math.max(0, at - 1)]!.pos;
        const mid = (here + neighbour) / 2;
        // Degenerate only if the neighbour sits exactly on top (a hard-edge pair):
        // then nudge into whatever room the gradient has.
        const pos = Math.abs(mid - here) < 0.5 ? (here >= 50 ? Math.max(0, here - 10) : Math.min(100, here + 10)) : mid;
        writeGradSpec(insertGradStop(cur, pos), false);
      } else if (btn.dataset.gp === 'del') {
        deleteGradStop();
      } else {
        setField(cfg.gradField, '');
        exitGradEdit();
        closeMorePanel();
        return;
      }
      ctxSelKey = '';
      gradPanelPending = true;
      scheduleSync();
    }));
    stageEl.appendChild(p);
    morePanel = p;
    const ar = anchor.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    p.style.left = Math.min(ar.left - sr.left, sr.width - p.offsetWidth - 8) + 'px';
    p.style.top = (ar.bottom - sr.top + 8) + 'px';
  }

  // ── "More" panel: shape / radius / opacity / image fit / blend ────────────────
  let morePanel: HTMLElement | null = null;
  function closeMorePanel() { morePanel?.remove(); morePanel = null; }
  /**
   * Close the innermost floating surface, and report whether there WAS one. This is rung 1
   * of the Escape ladder (see `onKey`), and the honesty of the return value is the whole
   * point: returning true when nothing closed is how Escape used to go missing.
   *
   * Three surfaces, innermost first. The colour popover is a child of its own field and
   * closes itself when focus is inside it — but by the time the user reaches for Escape,
   * focus is usually back on the canvas, so it needs a rung here too. Its teardown is not
   * re-implemented: a non-bubbling Escape on the field lets color-field own its internals.
   * It has to be non-bubbling — a bubbling one would arrive straight back here.
   */
  function dismissFloating(): boolean {
    const colour = stageEl.querySelector<HTMLElement>('.color-popover:not([hidden])');
    if (colour) {
      const field = colour.closest<HTMLElement>('[data-color-field]');
      if (field) { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: false })); return true; }
    }
    // A reference to a detached element is not an open panel. Drop it rather than
    // "closing" it, or it eats this press and every one after.
    if (popover && !popover.isConnected) popover = null;
    if (morePanel && !morePanel.isConnected) morePanel = null;
    if (!popover && !morePanel) return false;
    // Both together, as they always have been: closing a panel must NOT also drop the
    // selection it was about to act on (the one-number prompt for Offset / Outline stroke
    // is there to act on that selection), which is why this rung returns before the rest.
    closePopover();
    closeMorePanel();
    return true;
  }

  // ── canvas (document) size ────────────────────────────────────────────────────
  const SIZE_UNITS = ['px', 'mm', 'cm', 'in', 'pt'];
  let sizeUnit = 'px';   // remembered across opens of the size menu
  // px per 1 of a unit (96-DPI CSS convention — matches the artboard mapping).
  const pxPerUnit = (u: string): number => (u === 'px' ? 1 : toCssPx({ value: 1, unit: u as any }));
  const toUnitVal = (n: number, from: string, to: string): number => (n > 0 ? Math.round(n * pxPerUnit(from) / pxPerUnit(to) * 100) / 100 : n);
  function applyDocSize(w: number, h: number, unit = sizeUnit): void {
    if (!setCanvasSize || !(w > 0) || !(h > 0)) return;
    setCanvasSize(w, h, unit);
    scheduleSync();
  }
  const SIZE_PRESETS: Array<[string, number, number]> = [
    ['Square', 1080, 1080], ['Portrait 4:5', 1080, 1350], ['Story 9:16', 1080, 1920],
    ['Landscape 16:9', 1920, 1080], ['Wide 1.91:1', 1200, 630], ['A4 portrait', 2480, 3508],
  ];
  // Page-size presets for multi-page (carousel) mode. Every page shares one size.
  const PAGE_PRESETS: Array<[string, number, number]> = [
    ['Portrait 4:5', 1080, 1350], ['Square', 1080, 1080], ['Story 9:16', 1080, 1920],
    ['Landscape 16:9', 1920, 1080], ['A4 portrait', 1240, 1754], ['Letter', 1275, 1650],
  ];
  const modelVal = (id: string, dflt: number): number => {
    const v = runtime.getModel().find((i) => i.id === id)?.value;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : dflt;
  };
  // Pages panel — a page-count stepper (min..max) + shared page-size presets. Each
  // control writes the tool's page inputs via runtime.setInput; the web shell resizes
  // the editing strip in response (see tool.ts pages mode).
  function openPagesMenu(anchor: HTMLElement): void {
    if (!pages) return;
    closeMorePanel();
    const cur = clampN(modelVal(pages.countField, 3), 3, pages.min, pages.max);
    const pw = Math.round(modelVal(pages.widthField, 1080));
    const ph = Math.round(modelVal(pages.heightField, 1350));
    const p = document.createElement('div');
    p.className = 'fc-panel fc-size-panel fc-pages-panel';
    p.innerHTML =
      `<div class="fc-panel-head">${t('Pages')}</div>` +
      '<div class="fc-row fc-pages-step">' +
        `<button type="button" class="fc-step-btn" data-pg="dec" aria-label="${escape(t('Fewer pages'))}"${cur <= pages.min ? ' disabled' : ''}>${icon(SVG.minus)}</button>` +
        `<b class="fc-pages-count" data-pg-count>${cur}</b>` +
        `<button type="button" class="fc-step-btn" data-pg="inc" aria-label="${escape(t('More pages'))}"${cur >= pages.max ? ' disabled' : ''}>${icon(SVG.add)}</button>` +
      '</div>' +
      `<div class="fc-panel-head">${t('Page size')}</div>` +
      '<div class="fc-size-presets">' +
        PAGE_PRESETS.map(([label, w, h]) => `<button type="button" class="fc-size-preset${w === pw && h === ph ? ' is-current' : ''}" data-w="${w}" data-h="${h}"><b>${escape(t(label))}</b><span>${w}×${h}</span></button>`).join('') +
      '</div>';
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    const setCount = (n: number): void => {
      const clamped = clampN(n, cur, pages.min, pages.max);
      p.querySelector('[data-pg-count]')!.textContent = String(clamped);
      p.querySelector<HTMLButtonElement>('[data-pg="dec"]')!.disabled = clamped <= pages.min;
      p.querySelector<HTMLButtonElement>('[data-pg="inc"]')!.disabled = clamped >= pages.max;
      onDirty?.(pages.countField);
      runtime.setInput(pages.countField, clamped);
    };
    p.querySelector('[data-pg="dec"]')!.addEventListener('click', () => setCount(clampN(modelVal(pages.countField, cur), cur, pages.min, pages.max) - 1));
    p.querySelector('[data-pg="inc"]')!.addEventListener('click', () => setCount(clampN(modelVal(pages.countField, cur), cur, pages.min, pages.max) + 1));
    p.querySelectorAll<HTMLButtonElement>('.fc-size-preset').forEach((b) => b.addEventListener('click', () => {
      p.querySelectorAll('.fc-size-preset').forEach((x) => x.classList.toggle('is-current', x === b));
      onDirty?.(pages.widthField);
      runtime.setInput(pages.widthField, +b.dataset.w!);
      runtime.setInput(pages.heightField, +b.dataset.h!);
    }));
    stageEl.appendChild(p);
    morePanel = p;
    positionPanelBelow(p, anchor);
  }
  function openSizeMenu(anchor: HTMLElement): void {
    closeMorePanel();
    const d = canvasWH();   // always px
    // Show the current px size expressed in the remembered unit.
    const dispW = toUnitVal(d.w, 'px', sizeUnit), dispH = toUnitVal(d.h, 'px', sizeUnit);
    const p = document.createElement('div');
    p.className = 'fc-panel fc-size-panel';
    p.innerHTML =
      `<div class="fc-panel-head">${t('Canvas size')}</div>` +
      '<div class="fc-size-presets">' +
      SIZE_PRESETS.map(([label, w, h]) => `<button type="button" class="fc-size-preset${sizeUnit === 'px' && w === d.w && h === d.h ? ' is-current' : ''}" data-w="${w}" data-h="${h}"><b>${escape(t(label))}</b><span>${w}×${h}</span></button>`).join('') +
      '</div>' +
      `<label class="fc-row"><span>${t('Units')}</span><select class="field-select field-select--sm" data-sz="unit">${SIZE_UNITS.map((u) => `<option value="${u}"${u === sizeUnit ? ' selected' : ''}>${u}</option>`).join('')}</select></label>` +
      `<label class="fc-row"><span>${t('Width')}</span><input type="number" min="1" max="30000" step="any" data-sz="w" value="${dispW}"><b data-sz-unit>${sizeUnit}</b></label>` +
      `<label class="fc-row"><span>${t('Height')}</span><input type="number" min="1" max="30000" step="any" data-sz="h" value="${dispH}"><b data-sz-unit>${sizeUnit}</b></label>`;
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    const wIn = () => p.querySelector<HTMLInputElement>('[data-sz="w"]')!;
    const hIn = () => p.querySelector<HTMLInputElement>('[data-sz="h"]')!;
    p.querySelectorAll<HTMLButtonElement>('.fc-size-preset').forEach((b) => b.addEventListener('click', () => {
      // Presets are px — switch the unit control back to px and fill it in.
      sizeUnit = 'px';
      p.querySelector<HTMLSelectElement>('[data-sz="unit"]')!.value = 'px';
      p.querySelectorAll<HTMLElement>('[data-sz-unit]').forEach((x) => (x.textContent = 'px'));
      wIn().value = b.dataset.w!; hIn().value = b.dataset.h!;
      p.querySelectorAll('.fc-size-preset').forEach((x) => x.classList.toggle('is-current', x === b));
      applyDocSize(+b.dataset.w!, +b.dataset.h!, 'px');
    }));
    const commitCustom = () => {
      const w = parseFloat(wIn().value), h = parseFloat(hIn().value);
      if (w > 0 && h > 0) {
        applyDocSize(w, h, sizeUnit);
        p.querySelectorAll<HTMLButtonElement>('.fc-size-preset').forEach((x) => x.classList.toggle('is-current', sizeUnit === 'px' && +x.dataset.w! === Math.round(w) && +x.dataset.h! === Math.round(h)));
      }
    };
    p.querySelectorAll<HTMLInputElement>('input[data-sz]').forEach((i) => i.addEventListener('change', commitCustom));
    // Unit switch keeps the physical size: convert the shown W/H into the new unit.
    p.querySelector<HTMLSelectElement>('[data-sz="unit"]')!.addEventListener('change', (e) => {
      const to = (e.target as HTMLSelectElement).value;
      wIn().value = String(toUnitVal(parseFloat(wIn().value) || 0, sizeUnit, to));
      hIn().value = String(toUnitVal(parseFloat(hIn().value) || 0, sizeUnit, to));
      sizeUnit = to;
      p.querySelectorAll<HTMLElement>('[data-sz-unit]').forEach((x) => (x.textContent = to));
      p.querySelectorAll('.fc-size-preset').forEach((x) => x.classList.remove('is-current'));
    });
    stageEl.appendChild(p);
    morePanel = p;
    const ar = anchor.getBoundingClientRect(), sr = stageEl.getBoundingClientRect();
    p.style.left = Math.min(ar.right - sr.left + 8, sr.width - p.offsetWidth - 8) + 'px';
    p.style.top = Math.max(6, Math.min(ar.top - sr.top, sr.height - p.offsetHeight - 8)) + 'px';
  }

  function openMorePanel(anchor: HTMLElement): void {
    closeMorePanel();
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (!idx.length) return;
    const b: Box = boxes[idx[0]!] || {};
    const opt = (v: string, label: string, cur: any): string => `<option value="${v}"${String(cur) === v ? ' selected' : ''}>${label}</option>`;
    // Frame-only "Clip children" toggle — shown only when a SINGLE frame-kind box is
    // selected. Dead for non-frame tools (frameCfg is null there) and for a mixed/multi
    // selection, so no-frames documents and ordinary boxes are byte-identical. The hook
    // defaults an unset clipChildren to ON (boolVal(fb.clipChildren, true)), so reflect
    // that here. Writes through setField → one commit → the render honours overflow.
    const isFrame = !!frameCfg && idx.length === 1 && String(b[cfg.kindField]) === frameCfg.frameKind;
    const showClip = isFrame && !!frameCfg!.clipChildrenField;
    const clipCur = showClip ? boolOf(b[frameCfg!.clipChildrenField!], true) : true;
    const shapeCur = b[cfg.shapeField] || 'rect';
    const fitCur = b[cfg.fitField] || 'contain';
    const posCur = String(b[cfg.imgPosField] || 'center');
    const blendCur = b[cfg.blendField] || 'normal';
    const radiusCur = Math.max(0, Math.round(parseFloat(String(b[cfg.radiusField])) || 0));
    const opacityCur = Math.round(clampN(b[cfg.opacityField], 100, 0, 100));
    // Shadow state — target picks the CSS mechanism; colour/x/y/blur are shared.
    const shadowCur = String(b[cfg.shadowField] || 'none');
    const shColor = String(b[cfg.shadowColorField] || '#00000055');
    const shX = Math.round(clampN(parseFloat(String(b[cfg.shadowXField])), 0, -300, 300));
    const shY = Math.round(clampN(parseFloat(String(b[cfg.shadowYField])), 0, -300, 300));
    const shBlur = Math.round(clampN(parseFloat(String(b[cfg.shadowBlurField])), 10, 0, 300));
    // Row with a leading icon label (keeps the "clean up + use icons" intent while
    // staying legible). segRow hosts a segmented control; iconRow a slider/select.
    const iconRow = (ic: string, lbl: string, ctrl: string): string => `<label class="fc-row"><span class="fc-row-lbl" title="${escape(lbl)}">${icon(ic)}<span>${lbl}</span></span>${ctrl}</label>`;
    const segRow = (ic: string, lbl: string, seg: string): string => `<div class="fc-row"><span class="fc-row-lbl" title="${escape(lbl)}">${icon(ic)}<span>${lbl}</span></span>${seg}</div>`;
    const p = document.createElement('div');
    p.className = 'fc-panel fc-more-panel';
    p.innerHTML = `
      ${showClip ? `<label class="fc-row fc-row-toggle field-toggle"><span class="fc-row-lbl" title="${escape(t('Clip children'))}">${icon(SVG.clip)}<span>${t('Clip children')}</span></span><input type="checkbox" class="field-check" data-mp-clip${clipCur ? ' checked' : ''}></label>` : ''}
      ${cfg.shapeField && shapeChoices.length ? segRow(SVG.shRounded, t('Shape'), segHtml(cfg.shapeField, shapeCur, shapeChoices)) : ''}
      ${cfg.radiusField ? iconRow(SVG.radius, t('Corner radius'), `<input type="range" class="field-range" data-mp="radius" min="0" max="200" value="${radiusCur}"><b data-mp-val="radius">${radiusCur}</b>`) : ''}
      ${cfg.opacityField ? iconRow(SVG.opacity, t('Opacity'), `<input type="range" class="field-range" data-mp="opacity" min="0" max="100" value="${Number.isFinite(opacityCur) ? opacityCur : 100}"><b data-mp-val="opacity">${Number.isFinite(opacityCur) ? opacityCur : 100}</b>`) : ''}
      ${cfg.fitField ? segRow(SVG.fitContain, t('Image fit'), segHtml(cfg.fitField, fitCur, [['contain', t('Contain'), SVG.fitContain], ['cover', t('Cover (crop)'), SVG.fitCover], ['fill', t('Stretch'), SVG.fitFill]])) : ''}
      ${cfg.imgPosField ? segRow(SVG.fitPos, t('Image position'), posGridHtml(cfg.imgPosField, posCur)) : ''}
      ${cfg.blendField ? iconRow(SVG.blend, t('Blend mode'), `<select class="field-select field-select--sm" data-mp="blend">
        ${['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'].map((m) => opt(m, t(m[0]!.toUpperCase() + m.slice(1).replace('-', ' ')), blendCur)).join('')}
      </select>`) : ''}
      ${cfg.shadowField ? `<div class="fc-panel-sub">${t('Shadow')}</div>
        ${segRow(SVG.shadowIc, t('Apply to'), segHtml(cfg.shadowField, shadowCur, [['none', t('None')], ['box', t('Box')], ['text', t('Text')], ['content', t('Content')]]))}
        <label class="fc-row"><span class="fc-row-lbl">${t('Colour')}</span><span class="fc-cfield">${colorFieldHtml('fc-shadow', shColor, { float: true })}</span></label>
        <label class="fc-row"><span class="fc-row-lbl">${t('X')}</span><input type="range" class="field-range" data-mp="shx" min="-300" max="300" value="${shX}"><b data-mp-val="shx">${shX}</b></label>
        <label class="fc-row"><span class="fc-row-lbl">${t('Y')}</span><input type="range" class="field-range" data-mp="shy" min="-300" max="300" value="${shY}"><b data-mp-val="shy">${shY}</b></label>
        <label class="fc-row"><span class="fc-row-lbl">${t('Blur')}</span><input type="range" class="field-range" data-mp="shblur" min="0" max="300" value="${shBlur}"><b data-mp-val="shblur">${shBlur}</b></label>` : ''}`;
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    // Shape is special-cased: switching to "circle" also squares the box (w = h),
    // since a circle is only an ellipse the geometry keeps 1:1. Everything else writes
    // its field straight through.
    wireSegs(p, (field, v) => { if (field === cfg.shapeField) setShape(v); else setField(field, v); });
    const MP_FIELD: Record<string, string> = { radius: cfg.radiusField, opacity: cfg.opacityField, shx: cfg.shadowXField, shy: cfg.shadowYField, shblur: cfg.shadowBlurField };
    p.querySelectorAll<HTMLSelectElement>('select[data-mp]').forEach((sel) => sel.addEventListener('change', () => setField(cfg.blendField, sel.value)));
    p.querySelectorAll<HTMLInputElement>('input[data-mp]').forEach((rng) => rng.addEventListener('input', () => {
      const valEl = p.querySelector<HTMLElement>(`[data-mp-val="${rng.dataset.mp}"]`);
      if (valEl) valEl.textContent = rng.value;
      setField(MP_FIELD[rng.dataset.mp!], Number(rng.value));
    }));
    if (cfg.shadowColorField) wireColorField(p, { onChange: (id, val) => { if (id === 'fc-shadow') setField(cfg.shadowColorField, unwrapColor(val)); } });
    if (showClip) p.querySelector<HTMLInputElement>('input[data-mp-clip]')?.addEventListener('change', (e) => setField(frameCfg!.clipChildrenField, (e.currentTarget as HTMLInputElement).checked));
    stageEl.appendChild(p);
    morePanel = p;
    const ar = anchor.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    p.style.left = Math.min(ar.left - sr.left, sr.width - p.offsetWidth - 8) + 'px';
    p.style.top = (ar.bottom - sr.top + 8) + 'px';
  }

  /**
   * ── Frames reorder panel (plan 93 F1b-3) ──────────────────────────────────────
   *
   * A floating list of the document's frame-kind boxes in page order — drag a row (or
   * use its up/down steppers) to change the sequence. A reorder renumbers the `order`
   * field densely 0..n-1 through renumberFrameOrder in ONE commit, and the hook re-sorts
   * pages/export by (order asc, then x asc), so writing `order` is sufficient.
   *
   * Gated entirely on frameCfg?.orderField: the rail button that opens it is only built
   * for a tool whose canvas declares an orderField, so carousel/deck (render.paged, no
   * frameCfg) and every no-frames document never see this surface. It reuses the
   * `morePanel` slot so the shared outside-click / rebuild dismissal takes it down.
   */
  function openFramesPanel(anchor: HTMLElement): void {
    closeMorePanel();
    if (!frameCfg?.orderField) return;
    const of = frameCfg.orderField;
    const fk = frameCfg.frameKind;
    const fkFields = { kindField: cfg.kindField, idField: cfg.idField, orderField: of, frameKind: fk };
    let dragging: HTMLElement | null = null;
    const p = document.createElement('div');
    p.className = 'fc-panel fc-frames-panel';

    // Frames in the SAME page order the hook uses: order asc, x asc tie-break.
    const framesInOrder = (): Box[] => getBoxes()
      .filter((b) => String(b?.[cfg.kindField]) === fk)
      .sort((a, b) => (num(a?.[of]) - num(b?.[of])) || (num(a?.[cfg.xField]) - num(b?.[cfg.xField])));
    const fidOf = (b: Box): string => (b?.[cfg.idField] == null ? '' : String(b[cfg.idField]));
    const seqFromDom = (): string[] => [...p.querySelectorAll<HTMLElement>('.fc-frame-row')].map((r) => r.dataset.fid || '');
    const commitSeq = (seq: string[]): void => { commit(renumberFrameOrder(getBoxes(), seq, fkFields)); };

    function render(): void {
      const frames = framesInOrder();
      if (!frames.length) {
        p.innerHTML = `<div class="fc-panel-head">${escape(t('Artboards'))}</div><div class="fc-frames-empty">${escape(t('No artboards yet — draw one with the Artboard tool.'))}</div>`;
        return;
      }
      p.innerHTML = `<div class="fc-panel-head">${escape(t('Artboards'))}</div>` +
        `<div class="fc-frames-list">` + frames.map((b, i) => {
          const fid = fidOf(b);
          return `<div class="fc-frame-row" draggable="true" data-fid="${escape(fid)}" title="${escape(t('Drag to reorder'))}">
            <span class="fc-frame-grip" aria-hidden="true">${icon(SVG.grip)}</span>
            <span class="fc-frame-name">${escape(t('Artboard'))} ${i + 1}</span>
            <button type="button" class="fc-cbtn fc-frame-mv" data-fmove="up" title="${escape(t('Move up'))}" aria-label="${escape(t('Move up'))}"${i === 0 ? ' disabled' : ''}>${icon(SVG.chevUp)}</button>
            <button type="button" class="fc-cbtn fc-frame-mv" data-fmove="down" title="${escape(t('Move down'))}" aria-label="${escape(t('Move down'))}"${i === frames.length - 1 ? ' disabled' : ''}>${icon(SVG.chevDown)}</button>
          </div>`;
        }).join('') + `</div>`;
      wireRows();
    }

    function wireRows(): void {
      p.querySelectorAll<HTMLElement>('.fc-frame-row').forEach((row) => {
        row.addEventListener('dragstart', (e) => {
          dragging = row;
          row.classList.add('is-dragging');
          if ((e as DragEvent).dataTransfer) { (e as DragEvent).dataTransfer!.effectAllowed = 'move'; (e as DragEvent).dataTransfer!.setData('text/plain', row.dataset.fid || ''); }
        });
        row.addEventListener('dragend', () => { row.classList.remove('is-dragging'); dragging = null; });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          if ((e as DragEvent).dataTransfer) (e as DragEvent).dataTransfer!.dropEffect = 'move';
          if (!dragging || dragging === row) return;
          const list = row.parentElement!;
          const rect = row.getBoundingClientRect();
          const after = (e as DragEvent).clientY > rect.top + rect.height / 2;
          list.insertBefore(dragging, after ? row.nextSibling : row);
        });
        row.addEventListener('drop', (e) => { e.preventDefault(); commitSeq(seqFromDom()); render(); });
      });
      p.querySelectorAll<HTMLButtonElement>('[data-fmove]').forEach((btn) => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest<HTMLElement>('.fc-frame-row');
        if (!row) return;
        const seq = seqFromDom();
        const at = seq.indexOf(row.dataset.fid || '');
        const to = at + (btn.dataset.fmove === 'up' ? -1 : 1);
        if (at < 0 || to < 0 || to >= seq.length) return;
        [seq[at], seq[to]] = [seq[to]!, seq[at]!];
        commitSeq(seq);
        render();
      }));
    }

    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    render();
    stageEl.appendChild(p);
    morePanel = p;
    const ar = anchor.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    p.style.left = Math.min(ar.right - sr.left + 8, sr.width - p.offsetWidth - 8) + 'px';
    p.style.top = Math.max(6, Math.min(ar.top - sr.top, sr.height - p.offsetHeight - 8)) + 'px';
  }

  /**
   * Validate a typed dash pattern. The ENGINE owns this contract (it is the same parse the
   * tool's hook runs on the stored value), so the running engine's primitive wins whenever
   * it is there; `parseDashArray` in free-canvas-math.ts is the identical fallback for a
   * build that predates it, so the field never stops validating. Feature-detected at the
   * call, not cached, because the bridge is assembled asynchronously.
   */
  function parseDashText(text: string): number[] | null {
    // An emptied field is "no authored array", never an error — decided here rather than
    // delegated, so clearing the control cannot depend on how the engine reads a blank.
    if (!text.trim()) return [];
    const viaHost = host?.connectors?.dashFit?.parse;
    if (typeof viaHost === 'function') {
      try { return viaHost(text); } catch { /* a refusing primitive is not a reason to lose the field */ }
    }
    return parseDashArray(text);
  }

  /**
   * ── Stroke panel: width / style / ends / corners / fill rule ───────────────────
   *
   * A path box's stroke had a colour control and nothing else, so the width and the two
   * decorations were unreachable from the canvas — which is the working surface for an
   * `render.layout:"editor"` tool. Everything writes through `setField`, i.e. to EVERY
   * selected box in one `commit()`, the same as the More panel's controls.
   *
   * Fill rule lives here rather than under More because it is a property of the path's
   * paint, and it is what makes a hole a hole the moment anyone uses Subtract.
   *
   * Stroke ALIGNMENT (inside / centre / outside) is deliberately absent: SVG strokes on the
   * centreline only, so inside/outside is not a paint setting but a real outline conversion —
   * which the context menu already offers, exactly, as "Outline stroke".
   *
   * Plan 96 adds three things a keyword-only stroke could not say: the two ARROWHEADS (a
   * spline, a line and a connector are one primitive, so they share one decoration set), the
   * authored DASH ARRAY for anyone who wants the actual numbers, and the corner FIT that
   * makes a dashed rectangle land a dash on each corner instead of a half one.
   */
  function openStrokePanel(anchor: HTMLElement): void {
    closeMorePanel();
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (!idx.length) return;
    const b: Box = boxes[idx[0]!] || {};
    const swCur = Math.max(0, Math.round(clampN(parseFloat(String(b[cfg.strokeWField])), 0, 0, 400)));
    const dashCur = String(b[cfg.strokeDashField] ?? '');
    const capCur = String(b[cfg.strokeCapField] || 'round');
    const joinCur = String(b[cfg.strokeJoinField] || 'round');
    const ruleCur = String(b[cfg.fillRuleField] || 'nonzero');
    const dashArrCur = String(b[cfg.strokeDashArrayField] ?? '');
    const dashFitCur = b[cfg.dashFitField] === true || String(b[cfg.dashFitField]) === 'true';
    const headStartCur = String(b[cfg.headStartField] || 'none');
    const headEndCur = String(b[cfg.headEndField] || 'none');
    // Route is a property of a CONNECTOR, so it is offered only once an end is attached:
    // on a free spline it would be a control with nothing to act on. `pathRouteStyle`
    // supplies the label for what Auto currently resolves to, so "auto" is never a mystery.
    const routeCur = String(b[cfg.routeField] ?? '');
    const routeBound = hasRouteCfg && isBoundPath(b);
    const segRow = (ic: string, lbl: string, seg: string): string => `<div class="fc-row"><span class="fc-row-lbl" title="${escape(lbl)}">${icon(ic)}<span>${lbl}</span></span>${seg}</div>`;
    const headSelect = (field: string, cur: string, lbl: string): string =>
      `<select class="field-select field-select--sm" data-sp-head="${escape(field)}" aria-label="${escape(lbl)}">` +
      HEAD_CHOICES.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${escape(t(l))}</option>`).join('') +
      '</select>';
    const p = document.createElement('div');
    p.className = 'fc-panel fc-more-panel fc-stroke-panel';
    p.innerHTML =
      `<label class="fc-row"><span class="fc-row-lbl" title="${escape(t('Stroke width'))}">${icon(SVG.strokeIc)}<span>${t('Stroke width')}</span></span>` +
        `<input type="range" class="field-range" data-sp="width" min="0" max="120" value="${swCur}"><b data-sp-val="width">${swCur}</b></label>` +
      segRow(SVG.dashDashed, t('Stroke style'), segHtml(cfg.strokeDashField, dashCur, [
        ['', t('Solid'), SVG.dashSolid],
        ['dashed', t('Dashed'), SVG.dashDashed],
        ['dotted', t('Dotted'), SVG.dashDotted],
      ])) +
      // The power-user pair, where the manifest declares them (hasDashArrayCfg). Shown when
      // a dash style is on, or whenever an array is already authored — so a pattern can
      // never become unreachable by switching the keyword back to Solid, and a solid stroke
      // is not asked about dashes it has none of.
      (hasDashArrayCfg
        ? `<label class="fc-row" data-sp-row="dasharray"${dashRowOn(dashCur, dashArrCur) ? '' : ' hidden'}>` +
          `<span class="fc-row-lbl" title="${escape(t('Dash array'))}">${icon(SVG.dashDotted)}<span>${t('Dash array')}</span></span>` +
          `<input type="text" data-sp="dasharray" inputmode="decimal" spellcheck="false" autocomplete="off"` +
          ` value="${escape(dashArrCur)}" placeholder="6 4" aria-label="${escape(t('Dash array'))}"></label>` +
          `<label class="fc-row fc-row-toggle field-toggle" data-sp-row="dashfit"${dashRowOn(dashCur, dashArrCur) ? '' : ' hidden'}>` +
          `<span class="fc-row-lbl" title="${escape(t('Fit dashes to corners'))}">${icon(SVG.joinMiter)}<span>${t('Fit dashes to corners')}</span></span>` +
          `<input type="checkbox" class="field-check" data-sp="dashfit"${dashFitCur ? ' checked' : ''}></label>`
        : '') +
      segRow(SVG.capRound, t('Line ends'), segHtml(cfg.strokeCapField, capCur, [
        ['round', t('Round ends'), SVG.capRound],
        ['butt', t('Flat ends'), SVG.capButt],
        ['square', t('Square ends'), SVG.capSquare],
      ])) +
      // Arrowheads. Two plain menus rather than twelve icon buttons: the six shapes are
      // named things, and the row already carries three other segmented controls. Offered
      // only where the manifest declares them — see hasHeadCfg.
      (hasHeadCfg
        ? segRow(SVG.line, t('Path start'), headSelect(cfg.headStartField, headStartCur, t('Path start'))) +
          segRow(SVG.line, t('Path end'), headSelect(cfg.headEndField, headEndCur, t('Path end')))
        : '') +
      // Route — how a line with an attached end is bent between the two boxes. One plain
      // menu, beside the heads, because the three of them are the connector's whole shape.
      (routeBound
        ? segRow(SVG.tidy, t('Route'),
          `<select class="field-select field-select--sm" data-sp-route aria-label="${escape(t('Route'))}">` +
          ROUTE_CHOICES.map(([v, l]) => `<option value="${v}"${routeCur === v ? ' selected' : ''}>${escape(t(l))}</option>`).join('') +
          '</select>')
        : '') +
      segRow(SVG.joinRound, t('Corners'), segHtml(cfg.strokeJoinField, joinCur, [
        ['round', t('Round corners'), SVG.joinRound],
        ['miter', t('Sharp corners'), SVG.joinMiter],
        ['bevel', t('Bevelled corners'), SVG.joinBevel],
      ])) +
      segRow(SVG.ruleEvenOdd, t('Fill rule'), segHtml(cfg.fillRuleField, ruleCur, [
        ['nonzero', t('Fill overlaps (non-zero)'), SVG.ruleNonzero],
        ['evenodd', t('Punch holes (even-odd)'), SVG.ruleEvenOdd],
      ]));
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    // The dash-style segment also decides whether the two dash rows are on screen, so it
    // needs the write PLUS the reveal — hence a custom onSet rather than wireSegs' default.
    const dashArrEl = p.querySelector<HTMLInputElement>('input[data-sp="dasharray"]');
    const syncDashRows = (styleVal: string): void => {
      const on = dashRowOn(styleVal, dashArrEl?.value ?? dashArrCur);
      p.querySelectorAll<HTMLElement>('[data-sp-row="dasharray"], [data-sp-row="dashfit"]')
        .forEach((row) => { row.hidden = !on; });
    };
    wireSegs(p, (field, v) => {
      setField(field, v);
      if (field === cfg.strokeDashField) syncDashRows(String(v ?? ''));
    });
    p.querySelectorAll<HTMLInputElement>('input[data-sp="width"]').forEach((rng) => rng.addEventListener('input', () => {
      const valEl = p.querySelector<HTMLElement>('[data-sp-val="width"]');
      if (valEl) valEl.textContent = rng.value;
      setField(cfg.strokeWField, Number(rng.value));
    }));
    // Dash array: validated on every keystroke, but a REFUSAL writes nothing at all rather
    // than a repaired guess. That is what keeps the hook's injection stance intact — only
    // numbers ever reach `stroke-dasharray` — and it is also the honest answer to "6 x":
    // there is no pattern there to store, and silently dropping the 'x' would author a
    // pattern the user did not type.
    if (dashArrEl) {
      dashArrEl.addEventListener('input', () => {
        const nums = parseDashText(dashArrEl.value);
        const bad = nums === null;
        dashArrEl.setAttribute('aria-invalid', String(bad));
        if (bad) return;
        setField(cfg.strokeDashArrayField, nums.length ? formatDashArray(nums) : '');
      });
      // Leaving the field with something unparseable puts back what is actually stored,
      // so the control never shows a value the document does not have.
      dashArrEl.addEventListener('blur', () => {
        if (dashArrEl.getAttribute('aria-invalid') !== 'true') return;
        const cur = getBoxes()[selIndices(getBoxes())[0] ?? -1] as Box | undefined;
        dashArrEl.value = String(cur?.[cfg.strokeDashArrayField] ?? '');
        dashArrEl.setAttribute('aria-invalid', 'false');
      });
    }
    p.querySelectorAll<HTMLInputElement>('input[data-sp="dashfit"]').forEach((cb) =>
      cb.addEventListener('change', () => setField(cfg.dashFitField, cb.checked)));
    p.querySelectorAll<HTMLSelectElement>('select[data-sp-head]').forEach((sel) =>
      sel.addEventListener('change', () => setField(sel.dataset.spHead, sel.value)));
    p.querySelectorAll<HTMLSelectElement>('select[data-sp-route]').forEach((sel) =>
      sel.addEventListener('change', () => setField(cfg.routeField, sel.value)));
    stageEl.appendChild(p);
    morePanel = p;
    const ar = anchor.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    p.style.left = Math.min(ar.left - sr.left, Math.max(0, sr.width - p.offsetWidth - 8)) + 'px';
    p.style.top = (ar.bottom - sr.top + 8) + 'px';
  }

  // ── one-number prompt ─────────────────────────────────────────────────────────
  // A couple of menu actions need a number before they can run. There is no prompt() in
  // this app and no dialog light enough for a menu item, so this is the same `fc-panel`
  // recipe the size and dimensions panels already use — a labelled number field
  // committed by Enter or by the button — positioned at the point the menu was opened
  // from. It rides `morePanel`, so an outside click or Escape dismisses it like the rest.
  interface NumberAsk {
    at: Point;
    title: string;
    hint?: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    confirm: string;
    apply(value: number): void;
  }
  function askNumber(ask: NumberAsk): void {
    closePopover();
    closeMorePanel();
    const p = document.createElement('div');
    p.className = 'fc-panel fc-num-panel';
    p.innerHTML =
      `<div class="fc-panel-head">${escape(ask.title)}</div>` +
      (ask.hint ? `<p class="fc-num-hint">${escape(ask.hint)}</p>` : '') +
      '<div class="fc-num-row">' +
        `<input type="number" data-num step="${ask.step ?? 1}"` +
        (ask.min != null ? ` min="${ask.min}"` : '') + (ask.max != null ? ` max="${ask.max}"` : '') +
        ` value="${ask.value}" aria-label="${escape(ask.title)}">` +
        `<i>${escape(ask.unit || 'px')}</i>` +
        `<button type="button" class="btn btn--primary btn--sm fc-num-go" data-num-go>${escape(ask.confirm)}</button>` +
      '</div>';
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    const inp = p.querySelector<HTMLInputElement>('[data-num]')!;
    const go = (): void => {
      const v = parseFloat(inp.value);
      closeMorePanel();
      if (Number.isFinite(v)) ask.apply(v);
    };
    // Enter is the only keyboard commit; Escape falls through to onKey, which closes the
    // panel without applying.
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    p.querySelector<HTMLButtonElement>('[data-num-go]')!.addEventListener('click', (e) => { e.stopPropagation(); go(); });
    stageEl.appendChild(p);
    morePanel = p;
    const sr = stageEl.getBoundingClientRect();
    p.style.left = Math.max(6, Math.min(ask.at.x - sr.left, Math.max(6, sr.width - p.offsetWidth - 6))) + 'px';
    p.style.top = Math.max(6, Math.min(ask.at.y - sr.top, Math.max(6, sr.height - p.offsetHeight - 6))) + 'px';
    inp.focus();
    inp.select();
  }

  // ── are-you-sure ──────────────────────────────────────────────────────────────
  // One action in this overlay destroys authored work rather than moving it: switching a
  // path's spline kind to one that solves its own handles. There is no confirm dialog here
  // and a modal would be far too much furniture for a control on the object bar, so this is
  // the SAME `fc-panel` recipe as askNumber — a titled panel with a sentence and one
  // primary button — riding `morePanel`, so an outside click or Escape dismisses it and
  // that dismissal means "no".
  interface ConfirmAsk {
    at: Point;
    title: string;
    hint: string;
    confirm: string;
    apply(): void;
    cancel?(): void;
  }
  function askConfirm(ask: ConfirmAsk): void {
    closePopover();
    closeMorePanel();
    const p = document.createElement('div');
    p.className = 'fc-panel fc-num-panel fc-confirm-panel';
    p.innerHTML =
      `<div class="fc-panel-head">${escape(ask.title)}</div>` +
      `<p class="fc-num-hint">${escape(ask.hint)}</p>` +
      '<div class="fc-num-row fc-confirm-row">' +
        `<button type="button" class="btn btn--sm" data-confirm-no>${escape(t('Keep them'))}</button>` +
        `<button type="button" class="btn btn--primary btn--sm" data-confirm-yes>${escape(ask.confirm)}</button>` +
      '</div>';
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    // Exactly one of apply/cancel runs, exactly once, whichever way the panel goes away.
    // The two buttons settle it synchronously; the observer only catches the INDIRECT
    // dismissals (Escape, an outside click), which go through the generic closeMorePanel
    // and so cannot call back here themselves. Synchronously matters: the caller usually has
    // UI to put back — a <select> still showing the kind it did not switch to — and leaving
    // that until a microtask would show the wrong value for a frame.
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      if (ok) ask.apply(); else ask.cancel?.();
    };
    const observer = new MutationObserver(() => { if (!p.isConnected) settle(false); });
    p.querySelector<HTMLButtonElement>('[data-confirm-yes]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMorePanel();
      settle(true);
    });
    p.querySelector<HTMLButtonElement>('[data-confirm-no]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMorePanel();
      settle(false);
    });
    stageEl.appendChild(p);
    observer.observe(stageEl, { childList: true });
    morePanel = p;
    const sr = stageEl.getBoundingClientRect();
    p.style.left = Math.max(6, Math.min(ask.at.x - sr.left, Math.max(6, sr.width - p.offsetWidth - 6))) + 'px';
    p.style.top = Math.max(6, Math.min(ask.at.y - sr.top, Math.max(6, sr.height - p.offsetHeight - 6))) + 'px';
    p.querySelector<HTMLButtonElement>('[data-confirm-yes]')!.focus();
  }

  // Clamp a floating panel below-and-left of its anchor, inside the stage.
  function positionPanelBelow(p: HTMLElement, anchor: HTMLElement): void {
    const ar = anchor.getBoundingClientRect(), sr = stageEl.getBoundingClientRect();
    p.style.left = Math.max(6, Math.min(ar.left - sr.left, sr.width - p.offsetWidth - 8)) + 'px';
    p.style.top = Math.max(6, Math.min(ar.bottom - sr.top + 8, sr.height - p.offsetHeight - 8)) + 'px';
  }

  // ── Dimensions panel: manual X / Y / W / H / rotation for ONE box ─────────────
  // Opened from the object bar's transform readout (single selection only — editing
  // X on many boxes would stack them). Writes each field on `change`.
  function openDimsPanel(anchor: HTMLElement): void {
    closeMorePanel();
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (idx.length !== 1) return;
    const b: Box = boxes[idx[0]!] || {};
    const rd = (f: string, d: number): number => Math.round(clampN(b[f], d, -100000, 100000));
    const x = rd(cfg.xField, 0), y = rd(cfg.yField, 0);
    const w = Math.max(1, rd(cfg.wField, 1)), h = Math.max(1, rd(cfg.hField, 1));
    const rot = Math.round(clampN(b[cfg.rotationField], 0, -180, 180));
    // One labelled number cell: leading axis letter · the field · trailing unit.
    const cell = (label: string, field: string, val: number, min1 = false): string =>
      `<label class="fc-dims-f"><span>${label}</span><input type="number"${min1 ? ' min="1"' : ''} data-dm="${field}" value="${val}"><i>px</i></label>`;
    const p = document.createElement('div');
    p.className = 'fc-panel fc-dims-panel';
    p.innerHTML =
      `<div class="fc-panel-head">${t('Position &amp; size')}</div>` +
      '<div class="fc-dims">' +
        `<div class="fc-dims-row"><span class="fc-dims-ic" title="${escape(t('Position'))}">${icon(SVG.move)}</span>${cell(t('X'), cfg.xField, x)}${cell(t('Y'), cfg.yField, y)}</div>` +
        `<div class="fc-dims-row"><span class="fc-dims-ic" title="${escape(t('Size'))}">${icon(SVG.size)}</span>${cell(t('W'), cfg.wField, w, true)}${cell(t('H'), cfg.hField, h, true)}</div>` +
        (cfg.rotationField
          ? `<div class="fc-dims-row fc-dims-rot"><span class="fc-dims-ic" title="${escape(t('Rotation'))}">${icon(SVG.rotate)}</span>` +
            `<label class="fc-dims-f"><input type="number" min="-180" max="180" data-dm="${cfg.rotationField}" value="${rot}"><i>°</i></label>` +
            `<input type="range" class="field-range fc-dims-slider" min="-180" max="180" value="${rot}" aria-label="${escape(t('Rotation'))}" data-dm-slider></div>`
          : '') +
      '</div>';
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    // Number fields commit on `change`; W/H floor at 1 and rotation clamps to ±180.
    p.querySelectorAll<HTMLInputElement>('input[data-dm]').forEach((inp) => inp.addEventListener('change', () => {
      const f = inp.dataset.dm;
      let v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      if (f === cfg.wField || f === cfg.hField) v = Math.max(1, v);
      if (f === cfg.rotationField) { v = clampN(v, 0, -180, 180); inp.value = String(v); }
      setField(f, Math.round(v * 100) / 100);
    }));
    // Rotation slider — drags live-mirror the number readout and commit once on
    // release, so a drag never floods the undo history with intermediate steps.
    if (cfg.rotationField) {
      const rotNum = p.querySelector<HTMLInputElement>(`input[type="number"][data-dm="${cfg.rotationField}"]`);
      const rotRange = p.querySelector<HTMLInputElement>('[data-dm-slider]');
      if (rotNum && rotRange) {
        rotRange.addEventListener('input', () => { rotNum.value = rotRange.value; });
        rotRange.addEventListener('change', () => setField(cfg.rotationField, clampN(parseFloat(rotRange.value), 0, -180, 180)));
        rotNum.addEventListener('input', () => { rotRange.value = rotNum.value; });
      }
    }
    stageEl.appendChild(p);
    morePanel = p;
    positionPanelBelow(p, anchor);
    // Anchor the readout drops BELOW the bar (readout sits at the bar's right end).
    const ar = anchor.getBoundingClientRect(), sr = stageEl.getBoundingClientRect();
    p.style.left = Math.max(6, Math.min(ar.right - sr.left - p.offsetWidth, sr.width - p.offsetWidth - 8)) + 'px';
  }

  // ── Document info panel: rename the session/file + at-a-glance details ─────────
  function openInfoPanel(anchor: HTMLElement): void {
    closeMorePanel();
    const d = canvasWH();
    const fname = info?.getFilename?.() ?? '';
    const p = document.createElement('div');
    p.className = 'fc-panel fc-info-panel';
    p.innerHTML =
      `<div class="fc-panel-head">${t('Document')}</div>` +
      `<label class="fc-row"><span>${t('Name')}</span><input type="text" data-info="filename" value="${escapeHtml(fname)}" placeholder="${escapeHtml(t('Untitled'))}"></label>` +
      '<div class="fc-info-meta">' +
        `<div class="fc-info-line"><span>${t('Last edited')}</span><b data-info-edited>…</b></div>` +
        `<div class="fc-info-line"><span>${t('Canvas')}</span><b>${d.w} × ${d.h} px</b></div>` +
        (info?.name ? `<div class="fc-info-line"><span>${t('Tool')}</span><b>${escapeHtml(info!.name)}${info!.version ? ' · v' + escapeHtml(info!.version) : ''}</b></div>` : '') +
        (info?.status ? `<div class="fc-info-line"><span>${t('Status')}</span><b>${escapeHtml(info!.status)}</b></div>` : '') +
        (info?.formats?.length ? `<div class="fc-info-line"><span>${t('Exports')}</span><b>${info!.formats!.map(escapeHtml).join(', ')}</b></div>` : '') +
      '</div>' +
      // Provenance: what travels in the exported file's metadata. Read-only display +
      // an opt in/out toggle; the name/contact are edited in the profile.
      (info?.provenance ?
        `<div class="fc-panel-head fc-info-sub">${t('Embedded in exports')}</div>` +
        `<label class="fc-row fc-row-toggle field-toggle"><span>${t('Credit me')}</span><input type="checkbox" class="field-check" data-info="optin" disabled></label>` +
        '<div class="fc-info-meta">' +
          `<div class="fc-info-line"><span>${t('Made with')}</span><b>Lolly · lolly.tools</b></div>` +
          `<div class="fc-info-line" data-prov="author" hidden><span>${t('Name')}</span><b></b></div>` +
          `<div class="fc-info-line" data-prov="contact" hidden><span>${t('Contact')}</span><b></b></div>` +
          '<div class="fc-info-note" data-prov="note"></div>' +
        '</div>'
      : '');
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    const fn = p.querySelector<HTMLInputElement>('[data-info="filename"]');
    fn?.addEventListener('input', () => info?.setFilename?.(fn!.value));
    stageEl.appendChild(p);
    morePanel = p;
    positionPanelBelow(p, anchor);
    // Last-edited resolves async (reads the saved session's timestamp).
    Promise.resolve(info?.lastEdited?.()).then((iso) => {
      const el = p.querySelector<HTMLElement>('[data-info-edited]');
      if (el) el.textContent = iso ? fmtDate(iso) : t('Not saved yet');
    }).catch(() => {});
    // Provenance section fills async (reads the profile) then wires the opt-in toggle.
    const prov = info?.provenance;
    if (prov) {
      const optin = p.querySelector<HTMLInputElement>('[data-info="optin"]');
      const authorRow = p.querySelector<HTMLElement>('[data-prov="author"]');
      const contactRow = p.querySelector<HTMLElement>('[data-prov="contact"]');
      const note = p.querySelector<HTMLElement>('[data-prov="note"]');
      // nosemgrep: lolly-href-escape-is-not-scheme-validation — editHref's only caller passes the literal '#/profile?focus=use-details' (views/tool.ts)
    const editLink = prov.editHref ? ` <a href="${escapeHtml(prov.editHref)}">${t('Edit details')}</a>` : '';
      const paint = (optedIn: boolean, author: string, contact: string): void => {
        if (optin) optin.checked = optedIn;
        if (authorRow) { authorRow.hidden = !(optedIn && author); authorRow.querySelector('b')!.textContent = author; }
        if (contactRow) { contactRow.hidden = !(optedIn && contact); contactRow.querySelector('b')!.textContent = contact; }
        if (note) {
          note.innerHTML = optedIn
            ? (author || contact
                ? t('Baked into your PNG, PDF & SVG file metadata.')
                : tRaw('No name on file yet —{action} to be credited.', { action: editLink || ` ${t('add your details in your profile')}` }))
            : tRaw('Your name &amp; contact stay off your files.{link}', { link: editLink });
        }
      };
      prov.get().then(({ optedIn, author, contact }) => {
        if (optin) optin.disabled = false;
        paint(optedIn, author, contact);
        optin?.addEventListener('change', () => {
          const on = optin.checked;
          paint(on, author, contact);        // reflect immediately
          optin.disabled = true;
          Promise.resolve(prov.setOptIn(on))
            .catch(() => { optin.checked = !on; paint(!on, author, contact); }) // revert on failure
            .finally(() => { optin.disabled = false; });
        });
      }).catch(() => {});
    }
  }

  // ── field editing (applies to all selected boxes) ────────────────────────────
  function setField(field: string | undefined, value: any): void {
    if (!field) return;
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    const sel = new Set(idx);
    const next = boxes.map((b, i) => (sel.has(i) ? { ...b, [field]: value } : b));
    // Recolouring a path is what teaches the pen its next paint. Every paint control on
    // both bars (and the whole stroke panel) writes through here, so this is the one place
    // that has to notice — and it is gated on the selection being ALL paths so restyling a
    // text box or an image can't hand the pen a fill that means nothing for a curve.
    if (idx.length > 0 && selectionAllPaths(boxes, idx)) {
      const remembered = pickPathPaint(penPaintFields, next[idx[0]!]);
      if (remembered) penLastPaint = remembered;
    }
    commit(next);
  }
  // Is this box a circle? (An ellipse the geometry keeps square — see setShape.)
  const isCircle = (b: Box | undefined): boolean =>
    !!cfg.shapeField && String(b?.[cfg.shapeField]) === 'circle';
  // Set the shape on the selection. "circle" additionally squares each box to its
  // smaller side about its centre (an inscribed circle), in the SAME commit as the
  // shape change (one undo step) — otherwise a w≠h box would render as an ellipse and
  // the label would lie. Any other shape writes straight through.
  function setShape(v: string | undefined): void {
    if (!cfg.shapeField) return;
    if (v !== 'circle' || !cfg.wField || !cfg.hField) { setField(cfg.shapeField, v); return; }
    const boxes = getBoxes();
    const sel = new Set(selIndices(boxes));
    commit(boxes.map((b, i) => {
      if (!sel.has(i)) return b;
      const w = Math.max(1, num(b[cfg.wField], 1));
      const h = Math.max(1, num(b[cfg.hField], 1));
      const d = Math.round(Math.min(w, h));
      const cx = num(b[cfg.xField], 0) + w / 2;
      const cy = num(b[cfg.yField], 0) + h / 2;
      return {
        ...b, [cfg.shapeField]: 'circle',
        [cfg.wField]: d, [cfg.hField]: d,
        [cfg.xField]: Math.round(cx - d / 2), [cfg.yField]: Math.round(cy - d / 2),
      };
    }));
  }
  function bumpFont(delta: number): void {
    if (!cfg.fontSizeField) return;
    const boxes = getBoxes();
    const sel = new Set(selIndices(boxes));
    commit(boxes.map((b, i) => {
      if (!sel.has(i)) return b;
      const cur = parseFloat(String(b[cfg.fontSizeField]));
      const base = Number.isFinite(cur) ? cur : 48;
      return { ...b, [cfg.fontSizeField]: Math.max(4, base + delta) };
    }));
  }
  // Segmented icon/label control shared by the Text + More panels. `choices` is
  // [value, label, iconSvg?]; data-seg carries the RESOLVED field so wireSegs writes
  // it directly. When an entry has an icon it renders as an icon button (tooltip =
  // label); otherwise the label text.
  function segHtml(field: string, cur: any, choices: Array<[string, string, string?]>): string {
    return `<div class="fc-seg" data-seg="${field}">` +
      choices.map(([v, lbl, ic]) => `<button type="button" class="fc-seg-btn${String(cur) === String(v) ? ' is-on' : ''}${ic ? ' fc-seg-ic' : ''}" data-v="${v}" title="${escape(lbl)}" aria-label="${escape(lbl)}">${ic ? icon(ic) : escape(lbl)}</button>`).join('') +
      '</div>';
  }
  // Image-position anchor picker — a 3×3 grid of the CSS `object-position` anchors,
  // where the button's CELL is its meaning (top-left cell = anchor top-left). It's a
  // `.fc-seg` so wireSegs writes it like any segmented control; the values are literal
  // CSS object-position keywords (the hook whitelists them; the exporter reads the
  // computed value so SVG/PDF honour the anchor too). Default 'center'.
  const POS9: Array<[string, string]> = [
    ['left top', 'Top left'], ['center top', 'Top'], ['right top', 'Top right'],
    ['left center', 'Left'], ['center', 'Centre'], ['right center', 'Right'],
    ['left bottom', 'Bottom left'], ['center bottom', 'Bottom'], ['right bottom', 'Bottom right'],
  ];
  function posGridHtml(field: string, cur: string): string {
    return `<div class="fc-seg fc-posgrid" data-seg="${field}">` +
      POS9.map(([v, lbl]) => `<button type="button" class="fc-seg-btn fc-pos-btn${cur === v ? ' is-on' : ''}" data-v="${v}" title="${escape(t(lbl))}" aria-label="${escape(tRaw('Anchor image {pos}', { pos: t(lbl).toLowerCase() }))}"><i></i></button>`).join('') +
      '</div>';
  }
  function wireSegs(panel: HTMLElement, onSet: (field: string | undefined, v: string | undefined) => void = (field, v) => setField(field, v)): void {
    panel.querySelectorAll<HTMLElement>('.fc-seg').forEach((segEl) => segEl.querySelectorAll<HTMLButtonElement>('.fc-seg-btn').forEach((btn) => btn.addEventListener('click', () => {
      segEl.querySelectorAll('.fc-seg-btn').forEach((x) => x.classList.toggle('is-on', x === btn));
      onSet(segEl.dataset.seg, btn.dataset.v);
    })));
  }
  // ── Text panel: font · size · weight · line height · align · vertical · padding ─
  // In editor layout there is NO sidebar, so this panel is the only place these
  // typographic properties (several of which were previously unreachable) can be
  // set. Every control shows and writes the selected box's current value.
  function openTextPanel(anchor: HTMLElement): void {
    closeMorePanel();
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (!idx.length) return;
    const b: Box = boxes[idx[0]!] || {};
    const opt = (v: string, label: string, cur: any): string => `<option value="${v}"${String(cur) === v ? ' selected' : ''}>${label}</option>`;
    const fontCur = String(b[cfg.fontField] || defaultFont);
    const sizeCur = Math.max(1, Math.round(parseFloat(String(b[cfg.fontSizeField])) || 48));
    const weightCur = String(b[cfg.weightField] || '700');
    const lhRaw = parseFloat(String(b[cfg.lineHeightField]));
    const lhCur = Number.isFinite(lhRaw) ? lhRaw : 1.12;
    // Defaults here MUST match hooks.js textCss so the panel shows the real rendered
    // value for a box that hasn't set the field yet (pad defaults to 8, not 0).
    const padRaw = parseFloat(String(b[cfg.padField]));
    const padCur = Math.max(0, Math.round(Number.isFinite(padRaw) ? padRaw : 8));
    const trRaw = parseFloat(String(b[cfg.trackingField]));
    const trCur = Number.isFinite(trRaw) ? trRaw : 0;
    const ligCur = boolOf(b[cfg.ligaturesField], true);
    const altCur = boolOf(b[cfg.alternatesField], false);
    const fitCur = boolOf(b[cfg.fitTextField], false);
    const alignCur = String(b[cfg.alignField] || 'center');
    const valignCur = String(b[cfg.valignField] || 'middle');
    const p = document.createElement('div');
    p.className = 'fc-panel fc-text-panel';
    p.innerHTML =
      `<div class="fc-panel-head">${t('Text')}</div>` +
      (cfg.fontField ? `<label class="fc-row"><span>${t('Font')}</span><select class="field-select field-select--sm" data-tp="font">${fontOptionsHtml(fontCur)}</select></label>` : '') +
      // Size row now carries the A−/A+ steppers (moved off the object bar) around the number.
      (cfg.fontSizeField ? `<div class="fc-row"><span>${t('Size')}</span><div class="fc-stepper">
        <button type="button" class="fc-cbtn" data-tp="smaller" title="${escape(t('Smaller'))}" aria-label="${escape(t('Smaller text'))}">A−</button>
        <input type="number" min="4" max="2000" data-tp="size" value="${sizeCur}">
        <button type="button" class="fc-cbtn" data-tp="bigger" title="${escape(t('Bigger'))}" aria-label="${escape(t('Bigger text'))}">A+</button>
      </div></div>` : '') +
      (cfg.weightField ? `<label class="fc-row"><span>${t('Weight')}</span><select class="field-select field-select--sm" data-tp="weight">${weightChoicesFor(fontCur).map(([v, l]) => opt(v, t(l), weightCur)).join('')}</select></label>` : '') +
      (cfg.lineHeightField ? `<label class="fc-row"><span>${t('Line height')}</span><input type="range" class="field-range" min="0.7" max="3" step="0.01" data-tp="lh" value="${lhCur}"><b data-tp-val="lh">${lhCur.toFixed(2)}</b></label>` : '') +
      (cfg.trackingField ? `<label class="fc-row"><span>${t('Letter spacing')}</span><input type="range" class="field-range" min="-20" max="100" step="0.5" data-tp="tr" value="${trCur}"><b data-tp-val="tr">${trCur}</b></label>` : '') +
      (cfg.ligaturesField ? `<label class="fc-row fc-row-toggle field-toggle"><span>${t('Ligatures')}</span><input type="checkbox" class="field-check" data-tp="lig"${ligCur ? ' checked' : ''}></label>` : '') +
      (cfg.alternatesField ? `<label class="fc-row fc-row-toggle field-toggle"><span>${t('Alternates')}</span><input type="checkbox" class="field-check" data-tp="alt"${altCur ? ' checked' : ''}></label>` : '') +
      // Shrink-to-fit: on → the text scales down to fit the box (never up); off → the box
      // grows to the text (the default). See the hooks.js fit pass driven by data-fit.
      (cfg.fitTextField ? `<label class="fc-row fc-row-toggle field-toggle"><span>${t('Shrink text to fit')}</span><input type="checkbox" class="field-check" data-tp="fit"${fitCur ? ' checked' : ''}></label>` : '') +
      (cfg.alignField ? `<div class="fc-row"><span>${t('Align')}</span>${segHtml(cfg.alignField, alignCur, [['left', t('Align left'), SVG.textL], ['center', t('Align centre'), SVG.textC], ['right', t('Align right'), SVG.textR]])}</div>` : '') +
      (cfg.valignField ? `<div class="fc-row"><span>${t('Vertical')}</span>${segHtml(cfg.valignField, valignCur, [['top', t('Align top'), SVG.textT], ['middle', t('Centre vertically'), SVG.textM], ['bottom', t('Align bottom'), SVG.textB]])}</div>` : '') +
      (cfg.padField ? `<label class="fc-row"><span>${t('Padding')}</span><input type="range" class="field-range" min="0" max="200" data-tp="pad" value="${padCur}"><b data-tp-val="pad">${padCur}</b></label>` : '');
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    p.querySelector<HTMLButtonElement>('[data-tp="smaller"]')?.addEventListener('click', () => { bumpFont(-6); const s = p.querySelector<HTMLInputElement>('[data-tp="size"]'); if (s) s.value = String(Math.max(4, (parseInt(s.value, 10) || 48) - 6)); });
    p.querySelector<HTMLButtonElement>('[data-tp="bigger"]')?.addEventListener('click', () => { bumpFont(6); const s = p.querySelector<HTMLInputElement>('[data-tp="size"]'); if (s) s.value = String((parseInt(s.value, 10) || 48) + 6); });
    p.querySelectorAll<HTMLSelectElement>('select[data-tp]').forEach((sel) => sel.addEventListener('change', () => {
      if (sel.dataset.tp !== 'font') { setField(cfg.weightField, sel.value); return; }
      // Font change: mono cuts have no 900, so clamp any Black boxes to 800 in
      // the SAME commit (one undo step), then refresh the weight menu to match.
      const font = sel.value;
      const bx = getBoxes();
      const selSet = new Set(selIndices(bx));
      commit(bx.map((row, k) => {
        if (!selSet.has(k)) return row;
        const nb = { ...row, [cfg.fontField]: font };
        if (cfg.weightField && isMonoFont(font) && (parseInt(String(nb[cfg.weightField]), 10) || 700) > 800) nb[cfg.weightField] = '800';
        return nb;
      }));
      const wSel = p.querySelector<HTMLSelectElement>('select[data-tp="weight"]');
      if (wSel) {
        const cur = Math.min(parseInt(wSel.value, 10) || 700, maxWeightFor(font));
        wSel.innerHTML = weightChoicesFor(font).map(([v, l]) => opt(v, t(l), String(cur))).join('');
      }
    }));
    p.querySelectorAll<HTMLInputElement>('input[type="number"][data-tp]').forEach((inp) => inp.addEventListener('change', () => {
      const v = parseInt(inp.value, 10);
      if (Number.isFinite(v) && v >= 4) setField(cfg.fontSizeField, v);
    }));
    p.querySelectorAll<HTMLInputElement>('input[type="range"][data-tp]').forEach((rng) => rng.addEventListener('input', () => {
      const k = rng.dataset.tp;
      const valEl = p.querySelector<HTMLElement>(`[data-tp-val="${k}"]`);
      if (k === 'lh') { if (valEl) valEl.textContent = (+rng.value).toFixed(2); setField(cfg.lineHeightField, +rng.value); }
      else if (k === 'tr') { if (valEl) valEl.textContent = rng.value; setField(cfg.trackingField, +rng.value); }
      else { if (valEl) valEl.textContent = rng.value; setField(cfg.padField, +rng.value); }
    }));
    const cbField: Record<string, string> = { lig: cfg.ligaturesField, alt: cfg.alternatesField, fit: cfg.fitTextField };
    p.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-tp]').forEach((cb) => cb.addEventListener('change', () => {
      setField(cbField[cb.dataset.tp!], cb.checked);
    }));
    wireSegs(p);
    stageEl.appendChild(p);
    morePanel = p;
    const ar = anchor.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    p.style.left = Math.max(6, Math.min(ar.left - sr.left, sr.width - p.offsetWidth - 8)) + 'px';
    p.style.top = Math.max(6, Math.min(ar.bottom - sr.top + 8, sr.height - p.offsetHeight - 8)) + 'px';
  }
  // `initialTab` is the picker pane this add-kind should OPEN on (picker.ts's
  // PickerOpts.initialTab — a default the user can leave immediately, not a lock):
  // 'tools' for the Tool kind, 'library' for the media kinds, whose `pickType` has
  // already narrowed the library to just the assets that fit.
  async function pickImage(
    pickOpts?: { pickType?: 'lottie' | 'video' | 'audio'; initialTab?: 'library' | 'tools' },
  ): Promise<void> {
    if (!cfg.imageField || !host.assets?.pick) return;
    const pickType = pickOpts?.pickType;
    const boxes0 = getBoxes();
    const first: Box = boxes0[selIndices(boxes0)[0]!] || {};
    // The box's current image, viewed as an asset ref (the image field holds one).
    const curImg = first[cfg.imageField] as { id?: string; meta?: { toolUrl?: string; name?: string } } | undefined;
    // A box already filled by a live Lolly render: ask edit-or-replace before
    // opening the picker (same choice-first flow as the sidebar image slots).
    const curToolUrl = curImg?.meta?.toolUrl;
    if (curToolUrl && editTool) {
      // Lazy: picker.ts pulls in the picker's own CSS chunk, and the overlay only needs
      // it on this one branch — a static import would ship (and evaluate) it for every
      // editor mount.
      const { askLollyIntent } = await import('./picker.ts');
      const intent = await askLollyIntent(curImg?.meta?.name);
      if (!intent) return;
      if (intent === 'edit') {
        try {
          const edited = await editTool(curToolUrl, 'edit');
          if (!edited) return;
          const boxes = getBoxes();
          const sel = new Set(selIndices(boxes));
          commit(boxes.map((b, i) => (sel.has(i) ? { ...b, [cfg.imageField]: edited } : b)));
        } catch { /* user cancelled */ }
        return;
      }
    }
    try {
      const ref = await host.assets!.pick({
        title: pickType === 'video' ? t('Choose a video')
          : pickType === 'lottie' ? t('Choose an animation')
          : pickType === 'audio' ? t('Choose a sound')
          : pickOpts?.initialTab === 'tools' ? t('Choose a tool')
          : t('Choose an image'),
        // No type constraint by default: boxes take rasters AND vectors — logos and
        // the themable two-colour icons (with the picker's theme strip) included, plus
        // animated rasters (gif/apng/webp, which are type:'raster'). The "Animation" /
        // "Video" add-kinds constrain the picker to lottie / video respectively; each
        // renders as a live player once placed (mediaHtmlFor dispatches on asset type).
        ...(pickType ? { type: pickType } : {}),
        // Open on the pane that matches what the user asked to add (see the note on
        // this function). Omitted → the picker's own default (Library).
        ...(pickOpts?.initialTab ? { initialTab: pickOpts.initialTab } : {}),
        allowUpload: true,
        current: curImg?.id,
        // A box image that's already a Lolly render surfaces the picker's
        // edit-the-current-tool banner (inputs pre-filled) — the box's only
        // route back into the source tool, since boxes have no Edit badge.
        currentToolUrl: curImg?.meta?.toolUrl,
        currentToolName: curImg?.meta?.name,
        // Choosing a Lolly link or a saved creation opens its inputs first so the
        // user can set values (configure → insert), reusing the sidebar's editor.
        editTool,
      });
      if (!ref) return;
      const boxes = getBoxes();
      const sel = new Set(selIndices(boxes));
      commit(boxes.map((b, i) => (sel.has(i) ? { ...b, [cfg.imageField]: ref } : b)));
    } catch { /* user cancelled */ }
  }

  // Cut the background out of the single selected image box on-device (host.matte)
  // and drop the cutout back over the selection — the exact tail of pickImage, so
  // the result is an ordinary image ref with alpha, its original preserved as a
  // C2PA ingredient. Lazy chunk (matte-dialog.ts) like askLollyIntent above.
  async function removeBackgroundOnSelection(): Promise<void> {
    if (!cfg.imageField) return;
    const boxes0 = getBoxes();
    const idxs = selIndices(boxes0);
    if (idxs.length !== 1) return;
    const box = boxes0[idxs[0]!]!;
    const cur = box[cfg.imageField] as { id?: string; url?: string; meta?: { name?: string } } | undefined;
    if (!cur || (!cur.id && !cur.url)) return; // no image to cut out
    try {
      const { openMatteDialog } = await import('./matte-dialog.ts');
      const cutout = await openMatteDialog(host as unknown as MatteHost, {
        source: cur as unknown as MatteSource,
        sourceName: cur.meta?.name,
      });
      if (!cutout) return;
      const boxes = getBoxes();
      const sel = new Set(selIndices(boxes));
      commit(boxes.map((b, i) => (sel.has(i) ? { ...b, [cfg.imageField]: cutout } : b)));
    } catch { /* cancelled or unavailable */ }
  }

  // ── outline text ─────────────────────────────────────────────────────────────
  // Convert selected text boxes' glyphs into ordinary kind:'path' boxes (plan 88 —
  // the Font Outliner capability, in place). Measurement + shaping live in the lazy
  // outline-text.ts chunk, which reuses the export walk's line machinery; here is
  // only the model surgery: source box → per-fill path boxes at the same z, one
  // commit, refusal-first (a box that can't be outlined faithfully is left alone
  // and said so, never partially converted).

  function isOutlinableTextBox(b: Box): boolean {
    const kind = String(b[cfg.kindField] ?? '');
    if (kind === 'path' || kind === 'audio') return false;
    return Boolean(cfg.textField && String(b[cfg.textField] ?? '').trim());
  }

  /** A box that paints something besides its text (fill, gradient, image, or a
   *  border) keeps its frame; only the text leaves it. A bare text box is replaced
   *  outright. The border matters because a non-path box renders strokeW>0 + a stroke
   *  colour as a CSS border on the frame, and the glyph path boxes deliberately clear
   *  their stroke — so without keeping the frame a bordered label would silently lose
   *  its border on outline. */
  function paintsBesidesText(b: Box): boolean {
    const bg = cfg.fillField ? String(b[cfg.fillField] ?? '').trim() : '';
    const grad = cfg.gradField ? String(b[cfg.gradField] ?? '').trim() : '';
    const img = cfg.imageField ? (b[cfg.imageField] as { id?: string; url?: string } | undefined) : undefined;
    const border = num(b[cfg.strokeWField], 0) > 0 && String(b[cfg.strokeField] ?? '').trim() !== '';
    return Boolean(bg || grad || (img && (img.id || img.url)) || border);
  }

  // Re-entrancy guard: the action reads the live DOM across awaits (fonts, shaping)
  // before its one synchronous commit. Two overlapping runs both measuring the
  // pre-commit DOM could, for a box KEPT because it also paints (paintsBesidesText),
  // splice a second copy of the same glyphs. The menu button self-destructs on click
  // so this isn't reachable through the current dispatch, but the guard is a cheap,
  // future-proof invariant for an async mutator.
  let outliningInFlight = false;
  async function outlineTextOnSelection(): Promise<void> {
    if (outliningInFlight) return;
    outliningInFlight = true;
    try { await runOutlineTextOnSelection(); }
    finally { outliningInFlight = false; }
  }
  async function runOutlineTextOnSelection(): Promise<void> {
    if (!vectorCfg || !cfg.textField) return;
    const textApi = (host as unknown as HostV1).text;
    if (!textApi) return;
    const boxes0 = getBoxes();
    const srcIds = selIndices(boxes0)
      .filter((i) => isOutlinableTextBox(boxes0[i]!))
      .map((i) => idOf(boxes0[i], i));
    if (!srcIds.length) return;

    const { outlineBoxText, rotatedFrameShift } = await import('./outline-text.ts');
    const rectToNative = (r: DOMRect): { x: number; y: number; w: number; h: number } => {
      const { cr, scale } = metrics();
      return { x: (r.left - cr.left) / scale, y: (r.top - cr.top) / scale, w: r.width / scale, h: r.height / scale };
    };

    // Settle fonts AND layout ONCE, up front — before touching any box DOM. A pending
    // webfont load resolves here, and the template's fit pass (which re-runs on
    // document.fonts.ready and rewrites --fit → font-size → line wrapping) gets two
    // paint frames to finish. If we awaited this per box instead, a font-load could
    // move the box between the query and the measurement, so the captured element is
    // stale and the shaped glyphs land at the wrong size/place (or a repaint drops the
    // result). After this, each box is queried fresh and measured with no await between.
    try { await document.fonts?.ready; } catch { /* no Font Loading API */ }
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    const results = new Map<string, OutlineGroup[]>();
    let firstRefusal: string | null = null;
    for (const id of srcIds) {
      const el = canvasEl.querySelector<HTMLElement>(`.lolly-box[data-box-id="${cssEscape(id)}"]`);
      const textEl = el?.querySelector<HTMLElement>('.lolly-box-text');
      if (!el || !textEl) { firstRefusal ??= 'no-text'; continue; }
      try {
        const res = await outlineBoxText(el, textEl, textApi, rectToNative);
        if (res.ok) results.set(id, res.groups);
        else firstRefusal ??= res.reason;
      } catch { firstRefusal ??= 'empty'; }
    }

    // The model may have moved while shaping — re-read and apply by id, one commit.
    const timeCarry = timeCfg ? [
      timeCfg.startField, timeCfg.durField, timeCfg.clipInField, timeCfg.speedField,
      timeCfg.enterField, timeCfg.exitField, timeCfg.enterMsField, timeCfg.exitMsField,
      timeCfg.muteField, timeCfg.laneField, timeCfg.enterEaseField, timeCfg.exitEaseField,
    ].filter((f): f is string => Boolean(f)) : [];
    const shadowCarry = [cfg.shadowColorField, cfg.shadowXField, cfg.shadowYField, cfg.shadowBlurField]
      .filter(Boolean) as string[];
    let next = getBoxes();
    const nextSel = new Set<string>();
    let outlined = 0;
    for (const [srcId, groups] of results) {
      const at = next.findIndex((b, i) => idOf(b, i) === srcId);
      if (at < 0) continue;
      const src = next[at]!;
      // Keep the source frame (only the text leaves it) when it also paints a fill/
      // gradient/image/border; a bare text box is replaced outright. Decided once here
      // because it also governs shadow carry below.
      const keepSource = paintsBesidesText(src);
      const rot = num(src[cfg.rotationField], 0);
      const scx = num(src[cfg.xField], 0) + num(src[cfg.wField], 0) / 2;
      const scy = num(src[cfg.yField], 0) + num(src[cfg.hField], 0) / 2;
      const made: Box[] = [];
      let failed = false;
      // Outlining now yields one box PER GLYPH, so the letters are GROUPED to stay a word:
      // keep the source's own group if it had one (respect existing structure), else mint a
      // fresh shared group when there is more than one box. A lone glyph needs no group.
      const madeGroup = cfg.groupField
        ? (src[cfg.groupField] ? String(src[cfg.groupField]) : (groups.length > 1 ? freshGroupId(next) : ''))
        : '';
      for (const g of groups) {
        const pb = pathToBox(g.path, src, { cfg: vectorCfg, id: freshId(next.concat(made)) });
        // Only the node ceiling gets here (finite, non-empty geometry by construction)
        // — too much text for one encodable shape. Refuse the whole box.
        if (!pb) { failed = true; break; }
        // A path box's fill field paints the GLYPHS; the text box's fill was its
        // background. pathToBox inherited the latter — override with the run colour.
        if (cfg.fillField) pb[cfg.fillField] = g.fill;
        pb[cfg.strokeField] = '';
        pb[cfg.strokeWField] = 0;
        pb[cfg.fillRuleField] = 'nonzero';
        // Shadow: only carry it onto the glyphs when the source is REPLACED. If the
        // frame is kept (keepSource), it still paints the box's own shadow, so copying
        // it onto each glyph too would double it. And any carried shadow becomes
        // 'content' (a drop-shadow following the glyph silhouette): 'text' has nothing
        // to attach to once the text is geometry, and 'box' would otherwise draw a
        // rectangle around each colour group's bounding box — never what was intended.
        // Timing fields always carry (a clip on screen 2s..5s stays 2s..5s) — but never
        // linkOf: duplicating a detach-audio link id would corrupt its link group.
        const shadowField = cfg.shadowField;
        if (!keepSource && shadowField) {
          const sh = src[shadowField];
          if (sh !== undefined && sh !== '' && sh !== 'none') {
            pb[shadowField] = 'content';
            for (const f of shadowCarry) if (src[f] !== undefined) pb[f] = src[f];
          }
        }
        for (const f of timeCarry) if (src[f] !== undefined) pb[f] = src[f];
        // Group membership: every glyph box of one source shares `madeGroup` (its old group
        // if it had one, else a fresh one for the word), so the letters move together and
        // the replace/keep-source branches match replaceBoxes (which only fills group when
        // unset) instead of orphaning glyphs when the group later moves.
        if (cfg.groupField && madeGroup) pb[cfg.groupField] = madeGroup;
        if (rot) {
          const cx = num(pb[cfg.xField], 0) + num(pb[cfg.wField], 0) / 2;
          const cy = num(pb[cfg.yField], 0) + num(pb[cfg.hField], 0) / 2;
          const { dx, dy } = rotatedFrameShift(scx, scy, cx, cy, rot);
          pb[cfg.xField] = num(pb[cfg.xField], 0) + dx;
          pb[cfg.yField] = num(pb[cfg.yField], 0) + dy;
          pb[cfg.rotationField] = rot;
        }
        made.push(pb);
      }
      if (failed || !made.length) { firstRefusal ??= 'too-complex'; continue; }
      if (keepSource) {
        next = next.map((b, i) => (i === at ? { ...b, [cfg.textField as string]: '' } : b));
        next = [...next.slice(0, at + 1), ...made, ...next.slice(at + 1)];
      } else {
        next = replaceBoxes(next, [srcId], -1, made, { cfg: vectorCfg });
      }
      for (const nb of made) nextSel.add(String(nb[cfg.idField]));
      outlined++;
    }

    if (!outlined) {
      flash(firstRefusal === 'not-visible'
        ? t('This clip is not on screen at the current playhead. Move to it, then outline its text.')
        : firstRefusal === 'no-font'
          ? t('No font file could be resolved for this text, so it was left as it is.')
          : firstRefusal === 'notdef'
            ? t('The font cannot draw some of these characters, so the text was left as it is.')
            : firstRefusal === 'too-complex'
              ? t('There is too much text to outline in one shape, so it was left as it is.')
              : t('Nothing in this selection can be outlined.'));
      return;
    }
    selection = nextSel;
    commit(next);
    const skipped = srcIds.length - outlined;
    flash((outlined === 1
      ? t('Text outlined. It is now a shape and can no longer be edited as text.')
      : t('{n} text boxes outlined. They are now shapes and can no longer be edited as text.', { n: outlined }))
      + (skipped ? ' ' + (skipped === 1
        ? t('One selected item could not be outlined and was left as it is.')
        : t('{n} selected items could not be outlined and were left as they are.', { n: skipped })) : ''));
  }

  // ── grouping + clip/mask ──────────────────────────────────────────────────────
  function freshGroupId(boxes: Box[]): string {
    const used = new Set(boxes.map((b) => groupOf(b)).filter(Boolean));
    let g: string;
    do { g = 'g' + Date.now().toString(36).slice(-4) + (idSeq++).toString(36); } while (used.has(g));
    return g;
  }
  function groupSelection(): void {
    if (!cfg.groupField) return;
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (idx.length < 2) return;
    const g = freshGroupId(boxes);
    const set = new Set(idx);
    commit(boxes.map((b, i) => (set.has(i) ? { ...b, [cfg.groupField]: g } : b)));
  }
  function ungroupSelection(): void {
    if (!cfg.groupField) return;
    const boxes = getBoxes();
    const set = new Set(selIndices(boxes));
    if (!boxes.some((b, i) => set.has(i) && groupOf(b))) return;
    commit(boxes.map((b, i) => (set.has(i) && groupOf(b) ? { ...b, [cfg.groupField]: '' } : b)));
  }
  // Clip: the LOWEST selected box (bottom of the stack) is the mask; every higher
  // selected box is clipped to its shape. They're grouped so the mask + content
  // travel together (Figma-style mask group).
  function clipSelection(): void {
    if (!cfg.clipField) return;
    const boxes = getBoxes();
    const idx = selIndices(boxes).slice().sort((a, b) => a - b);
    if (idx.length < 2) return;
    const maskId = idOf(boxes[idx[0]!], idx[0]!);
    const clipSet = new Set(idx.slice(1));
    const allSet = new Set(idx);
    const g = cfg.groupField ? freshGroupId(boxes) : '';
    commit(boxes.map((b, i) => {
      if (!allSet.has(i)) return b;
      const nb = { ...b };
      if (clipSet.has(i)) nb[cfg.clipField] = maskId;
      if (cfg.groupField) nb[cfg.groupField] = g;
      return nb;
    }));
  }
  function releaseClip(): void {
    if (!cfg.clipField) return;
    const boxes = getBoxes();
    const set = new Set(selIndices(boxes));
    if (!boxes.some((b, i) => set.has(i) && b[cfg.clipField])) return;
    commit(boxes.map((b, i) => (set.has(i) && b[cfg.clipField] ? { ...b, [cfg.clipField]: '' } : b)));
  }
  const selHasGroup = () => { const bx = getBoxes(); return selIndices(bx).some((i) => groupOf(bx[i])); };
  const selHasClip = () => { const bx = getBoxes(); return cfg.clipField && selIndices(bx).some((i) => bx[i]![cfg.clipField]); };

  // ── z-order / align / distribute ─────────────────────────────────────────────
  function applyZ(op: string): void {
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (!idx.length) return;
    commit(reorderZ(boxes, idx, op as ZOp));
  }
  function applyAlign(edge: string): void {
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (!idx.length) return;
    commit(alignBoxes(boxes, idx, edge as AlignEdge, cfg, canvasWH()));
  }
  function applyDistribute(axis: string): void {
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (idx.length < 3) return;
    commit(distributeBoxes(boxes, idx, axis as Axis, cfg));
  }

  function duplicateSelection(): void {
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (!idx.length) return;
    const clones: Box[] = [];
    const nextSel = new Set<string>();
    const pool = boxes.slice();
    for (const i of idx) {
      const id = freshId(pool.concat(clones));
      const r = boxRect(boxes[i], cfg);
      const clone = { ...boxes[i], [cfg.idField]: id, [cfg.xField]: Math.round(r.x + 24), [cfg.yField]: Math.round(r.y + 24) };
      clones.push(clone);
      nextSel.add(id);
    }
    selection = nextSel;
    commit([...boxes, ...clones]);
  }
  function deleteSelection(): void {
    const boxes = getBoxes();
    const sel = new Set(selIndices(boxes));
    if (!sel.size) return;
    selection = new Set<string>();
    commit(boxes.filter((_, i) => !sel.has(i)));
  }

  // ── vector operations (opt-in via canvas.pathField) ───────────────────────────
  // The geometry itself lives in vector-ops.ts (pure, DOM-free, engine-backed); this is
  // only the menu wiring: gather the operands, run the op, and commit ONE model write.
  //
  // Failure never half-edits the model — `run` is called first and nothing is committed
  // unless it answered `ok:true`.

  /** Curve-fitting tolerance for Simplify, in native canvas px. Sub-pixel, so the result
   *  is visually the same path with fewer nodes; not exposed as a prompt because the
   *  useful range is narrow and "fewer nodes, same shape" is the whole request. */
  const SIMPLIFY_TOL = 0.6;

  /** How many selected boxes satisfy `pred`, in z-order. */
  function countSelected(pred: (b: Box) => boolean): number {
    const boxes = getBoxes();
    return selIndices(boxes).reduce((n, i) => (pred(boxes[i]!) ? n + 1 : n), 0);
  }

  /** The selection as vector operands: array order is Z-ORDER (bottom first), which is
   *  what every operation in vector-ops.ts documents — Subtract's base is operand 0. */
  function vectorOperands(): { boxes: Box[]; operands: Box[]; ids: string[] } {
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    return { boxes, operands: idx.map((i) => boxes[i]!), ids: idx.map((i) => idOf(boxes[i], i)) };
  }

  /**
   * A refusal the user can read.
   *
   * vector-ops.ts does not import i18n at all — its `message` is diagnostic English
   * for a log — so the translated sentence is owned here and keyed on `reason`.
   *
   * `empty-result` is the interesting one, and it is NOT an error: an intersection of two
   * shapes that do not overlap is legitimately empty, and so is an inward offset deeper
   * than the shape's own inradius. This REFUSES AND SAYS SO rather than deleting the
   * operands. Deleting them is defensible — Illustrator's Intersect does exactly that —
   * but on screen an empty result and a no-op are the same picture, so the destructive
   * reading of an ambiguous gesture would remove the user's artwork and leave nothing
   * behind to explain where it went. Stating the answer in words costs one more tap and
   * never loses work.
   */
  function vectorFailureMessage(res: VectorOpFailure, empty?: string): string {
    switch (res.reason) {
      case 'too-complex':
        // The kernel's GeomLimitError: the answer exists, the engine declines to guess it
        // rather than hand back a plausible-looking wrong shape. That has to be said.
        return t('These shapes are too intricate to combine exactly. Simplify them first, or combine fewer at a time.');
      case 'no-outline':
        return t('Text and image boxes have no outline to work with. Select shapes or pen paths.');
      case 'needs-two':
        return t('Select two or more shapes to combine them.');
      case 'not-applicable':
        return t('Only pen paths can be simplified.');
      case 'empty-result':
        return empty || t('That would leave nothing to draw, so the shapes were left as they are.');
      case 'bad-input':
        return t('One of the selected shapes has a path that cannot be read.');
      default:
        return t('That could not be worked out, so nothing was changed.');
    }
  }

  /** The empty-result sentence for each boolean. Union of non-empty regions cannot be
   *  empty, so it falls through to the generic line. */
  function boolEmptyMessage(op: BooleanOpName): string | undefined {
    if (op === 'intersect') return t('Those shapes do not overlap, so there is nothing to keep. Nothing was changed.');
    if (op === 'difference') return t('The shapes above cover the bottom one completely, so nothing is left. Nothing was changed.');
    if (op === 'xor') return t('Those shapes overlap exactly, so nothing is left. Nothing was changed.');
    return undefined;
  }

  interface RunVectorOpts {
    /** simplifyBoxes returns one box PER OPERAND, each of which keeps its own place in
     *  the stack — so the result is applied operand by operand instead of as one swap. */
    each?: boolean;
    /** Mention boxes the operation left alone (text/image have no outline). */
    skipNote?: boolean;
    /** Override the `empty-result` sentence for this operation. */
    empty?: string;
  }

  function runVectorOp(run: (operands: Box[], id: string) => VectorOpResult, opts: RunVectorOpts = {}): void {
    if (!vectorCfg) return;
    const { boxes, operands, ids } = vectorOperands();
    if (!operands.length) return;
    const res = run(operands, freshId(boxes));
    if (!res.ok) { flash(vectorFailureMessage(res, opts.empty)); return; }

    const nextSel = new Set<string>();
    let next: Box[];
    if (opts.each) {
      // res.boxes lines up 1:1 with the operands NOT in `skipped`, in operand order.
      const skipped = new Set(res.skipped);
      const targets = operands.map((_, k) => k).filter((k) => !skipped.has(k));
      next = boxes;
      for (let k = 0; k < res.boxes.length; k++) {
        const at = targets[k];
        if (at === undefined) break;
        const nb: Box = { ...res.boxes[k]! };
        // Only the first result carries the id we minted; the rest are ours to allocate
        // (checked against the array as it grows, so two results never collide).
        const nid = nb[cfg.idField] != null && nb[cfg.idField] !== '' ? String(nb[cfg.idField]) : freshId(next);
        nb[cfg.idField] = nid;
        next = replaceBoxes(next, [ids[at]!], -1, nb, { cfg: vectorCfg });
        nextSel.add(nid);
      }
    } else {
      next = replaceBoxes(boxes, ids, -1, res.boxes, { cfg: vectorCfg });
      for (const b of res.boxes) {
        const v = b[cfg.idField];
        if (v != null && v !== '') nextSel.add(String(v));
      }
    }
    if (!nextSel.size) { flash(vectorFailureMessage({ ok: false, reason: 'internal', message: 'no result id' })); return; }
    selection = nextSel;
    commit(next);
    if (opts.skipNote && res.skipped.length) {
      flash(res.skipped.length === 1
        ? t('One selected item has no outline, so it was left as it is.')
        : t('{n} selected items have no outline, so they were left as they are.', { n: res.skipped.length }));
    }
  }

  // Outline stroke — the width defaults to the topmost operand's OWN stroke width, which
  // is the stroke the user is looking at.
  function askOutlineStroke(): void {
    if (!vectorCfg) return;
    const { operands } = vectorOperands();
    const seed = Math.max(0.1, num(operands[operands.length - 1]?.[cfg.strokeWField], 1));
    askNumber({
      at: lastMenuAt,
      title: t('Outline stroke'),
      hint: t('Replace the stroke with a filled shape of the same outline.'),
      value: Math.round(seed * 100) / 100,
      min: 0.1, step: 0.5, confirm: t('Outline'),
      apply: (v) => runVectorOp((ops, id) => strokeBoxesToPath(ops, { cfg: vectorCfg, id, width: v }), { skipNote: true }),
    });
  }

  // Offset — no `min` on the field, because a negative distance is an inset and that is
  // half of what this control is for.
  function askOffsetPath(): void {
    if (!vectorCfg) return;
    askNumber({
      at: lastMenuAt,
      title: t('Offset path'),
      hint: t('Grow the shape outwards. A negative distance shrinks it inwards.'),
      value: 8, step: 1, confirm: t('Offset'),
      apply: (v) => runVectorOp((ops, id) => offsetBoxes(ops, v, { cfg: vectorCfg, id }), {
        skipNote: true,
        empty: t('Shrinking by that much removes the shape completely. Nothing was changed.'),
      }),
    });
  }

  // ── the pen tool (opt-in via canvas.pathField) ────────────────────────────────
  // Geometry lives in free-canvas-pen.ts (pure, engine-backed); this is the gestures, the
  // chrome and the one-commit-per-action wiring.
  //
  // Two exclusive modes. DRAWING builds `penDraft` in native px and writes the model
  // exactly once, when the path ends. NODE-EDITING holds the box's path DENORMALISED to
  // box-local px in `penEdit`, which is the space `hooks.js` lowers in, and writes the
  // model once per completed edit (a drag, an insert, a delete, a continuity change).

  /** The kind a NEW path is drawn in. Remembered across draws, seeded from the plan's
   *  default — `hyperbezier`, whose node default is `'smooth'`, so plain click-click-click
   *  draws a curve rather than a polyline. */
  let penDrawKind: SplineKind = PEN_DEFAULT_KIND;

  /** One set of spline-type names for every surface that offers them — the pen bar's
   *  `<select>` and the rail button's hold menu. Built per call rather than frozen at
   *  module load so a language switch renames them. */
  function penKindLabels(): Record<string, string> {
    return {
      hyperbezier: t('Smooth (auto)'), spiro: t('Spiro'), cubic: t('Bezier handles'),
      'catmull-rom': t('Through the points'), bspline: t('B-spline'), line: t('Straight lines'),
    };
  }

  /**
   * The spline type, chosen from the rail BEFORE anything is drawn.
   *
   * Until this existed the switcher only appeared in the pen bar, which only appears once
   * there is a draft — so choosing the type meant drawing a path in the wrong one first
   * and converting, and `hyperbezier → cubic` is the only conversion that is lossless.
   * Picking up the pen already knowing what you want to draw is the normal case for
   * tracing, so it gets a normal path to it.
   */
  function openPenKindMenu(anchor: HTMLElement): void {
    const labels = penKindLabels();
    spawnPopover(anchor, PEN_KINDS.map((k) => ({
      label: labels[k] || k,
      on: k === penDrawKind,
      run: () => setPenDrawKind(k),
    })));
  }

  /** Choose the type and arm the pen, so the menu leaves you ready to draw rather than
   *  back where you started. An in-progress draft follows the choice, exactly as it does
   *  from the pen bar's own switcher. */
  function setPenDrawKind(to: SplineKind): void {
    penDrawKind = to;
    if (penDraft) { penDraft = { ...penDraft, kind: to }; penWarm = null; }
    if (mode !== 'pen') setMode('pen');
    else renderChrome();
    announce(tRaw('Spline type: {name}', { name: penKindLabels()[to] || to }));
  }

  const penScale = (): number => metrics().scale || 1;
  const penTol = (): number => PEN_HIT_PX / penScale();

  // Entering/leaving pen mode. Neither is called directly — `setMode` owns the transition,
  // which is what guarantees the other three modes are down before this one is up.
  function enterPen(): void {
    deselectEdge();
    selection = new Set<string>();
    stageEl.classList.add('fc-penning');
    announce(t('Pen on - click to place points, drag to curve them, click the first point to close. Enter finishes, Esc cancels.'));
    renderChrome();
  }
  function exitPen(): void {
    penDraft = null;
    penCursor = null;
    penWarm = null;
    stageEl.classList.remove('fc-penning');
    clearGuides();
    renderChrome();
  }

  // ── drawing ───────────────────────────────────────────────────────────────────

  /** Place a node at a (already snapped) native point and start the drag that pulls its
   *  handles out. `corner` is the Alt modifier — see the button's tooltip. */
  function penPlaceNode(e: PointerEvent, at: Point, corner: boolean): void {
    const kind = penDraft ? penDraft.kind : penDrawKind;
    const nodes = penDraft ? penDraft.nodes.slice() : [];
    nodes.push({ x: at.x, y: at.y, continuity: corner ? 'corner' : defaultContinuity(kind) });
    penDraft = { kind, nodes, closed: false };
    penCursor = null;
    penPullBroken = corner;   // Alt held at placement arms the break for the drag that follows
    beginGesture(e, { type: 'pendraw', origin: at, index: nodes.length - 1 });
    paintPen();
    syncPenChrome();
  }

  /** Drop the last placed node (Backspace/Delete while drawing). The last one leaving
   *  ends the draw, because an empty draft is not a draft. */
  function penUndoNode(): void {
    if (!penDraft) return;
    const nodes = penDraft.nodes.slice(0, -1);
    if (!nodes.length) { penDraft = null; penCursor = null; penWarm = null; renderChrome(); return; }
    penDraft = { ...penDraft, nodes, closed: false };
    penWarm = null;                             // the node count changed, so the warm start is stale
    renderChrome();
  }

  /**
   * End the draw and commit — ONE `setInput`, so one undo step removes the whole path.
   *
   * A draft with fewer than two nodes commits nothing: a single click with the pen selected
   * is a mis-click, and materialising a one-node box for it would leave the user something
   * invisible to find and delete.
   */
  function penFinishDraw(): void {
    const draft = penDraft;
    penDraft = null;
    penCursor = null;
    penWarm = null;
    clearGuides();
    if (!draft) { renderChrome(); return; }
    if (!commitPathBox(draft)) renderChrome();
  }

  /**
   * A finished authored path → a committed path box. ONE `setInput`, so one undo step
   * removes the whole thing.
   *
   * Extracted from `penFinishDraw` for plan 96 P2: the Line tool draws the same primitive
   * with a different gesture (one drag, two nodes) and must land the same box — same
   * seeding, same paint fallback, same single commit — or a line would be a second-class
   * shape the moment anyone tried to node-edit or restyle it. `extra` is the per-gesture
   * decoration the line adds on top (its default arrowhead and its empty bindings).
   *
   * Returns false when nothing was committed (fewer than two nodes, an unlowerable kind, a
   * tool with no `pathField`) — the caller's cue to repaint its own chrome.
   */
  function commitPathBox(draft: AuthoredPath, extra?: Box): boolean {
    if (!cfg.pathField) return false;
    const made = penCommitFromNative(draft);
    const value = made ? encodePathField(made.path) : '';
    if (!made || !value) return false;
    const boxes = getBoxes();
    const id = freshId(boxes);
    const pathSeed: Box = { ...(addKinds.find((k) => k.id === 'path')?.seed || {}) };
    // Paint: what the user last used on a path, then this tool's own `path` seed — and
    // nothing else. Other add-kinds are deliberately NOT consulted: a `path` seed's empty
    // fill is a statement ("paths in this brand are stroke-only"), so letting a box seed
    // fill it in would overrule the brand, and where there is no `path` seed at all the
    // nearest kind's colour is chosen for a filled rectangle, not for a curve — Sequence
    // Studio's card is #14181d on a #0b1220 artboard, i.e. invisible. The honest fallback
    // for that case is the ink the path was drawn in, below.
    const seed: Box = {
      ...pathSeed,
      ...pathPaintSeed(penPaintFields, [penLastPaint, pathSeed]),
    };
    // Last resort: stroke it in the colour it was DRAWN in. The preview strokes the draft
    // in `currentColor` off .fc-pen-layer (the brand primary), so this is the shape the user
    // was just looking at rather than an invented hue — and it is resolved to a concrete
    // hex here because a box field has to render headlessly, where a CSS variable cannot.
    if (cfg.strokeField && !pathPaintIsVisible(penPaintFields, seed)) {
      seed[cfg.strokeField] = drawnInkHex();
      if (cfg.strokeWField && !(Number(seed[cfg.strokeWField]) > 0)) seed[cfg.strokeWField] = 4;
    }
    let box = seedBox(cfg, {}, seed, { x: made.x, y: made.y, w: made.w, h: made.h } as MathRect, id);
    box[cfg.kindField] = 'path';
    if (cfg.shapeField) box[cfg.shapeField] = 'rect';
    box[cfg.pathField] = value;
    // The gesture's own decoration goes on LAST so it beats the tool's `path` seed: the
    // Line tool's arrowhead is what the user asked for by picking that tool, and a brand
    // seed that says "paths are plain" should not silently take it off.
    if (extra) for (const k of Object.keys(extra)) box[k] = extra[k];
    selection = new Set([id]);
    penLastPaint = pickPathPaint(penPaintFields, box);
    commit([...boxes, box]);
    return true;
  }

  /** The colour the pen preview is drawn in, as a concrete hex — always a usable value, since
   *  a shape in the wrong colour still beats a shape in none. Computed at commit time rather
   *  than cached: the brand, and so this colour, can change mid-session. The resolution is
   *  pure (`resolveDrawnInk`) so it can be tested without a stylesheet, which is also the one
   *  case that reaches its fallback — jsdom applies no CSS, a real browser always resolves. */
  function drawnInkHex(): string {
    try { return resolveDrawnInk(getComputedStyle(penLayer).color); }
    catch { return resolveDrawnInk(null); }
  }

  /** Abandon the draw. Nothing was ever written, so there is nothing to undo. */
  function penCancelDraw(): void {
    penDraft = null;
    penCursor = null;
    penWarm = null;
    clearGuides();
    renderChrome();
  }

  // ── node-edit mode ────────────────────────────────────────────────────────────

  /** Enter node editing on a path box. Entered like `startTextEdit` — a double-click or an
   *  explicit affordance — and left just as explicitly, so ordinary selection behaviour is
   *  never silently different. */
  // ── Multi-contour node editing: combined flat view ↔ per-contour split ─────────
  // Join per-contour paths into ONE combined path (nodes concatenated) + the parts
  // descriptor that splits it back. The combined kind is the first part's — see the
  // penEdit declaration for why that is correct for every producer here.
  function penJoin(paths: AuthoredPath[]): { path: AuthoredPath; parts: PenPart[] } {
    const parts: PenPart[] = paths.map((p) => ({ count: p.nodes.length, kind: p.kind, closed: p.closed }));
    const first = paths[0]!;
    return { path: { kind: first.kind, closed: first.closed, nodes: paths.flatMap((p) => [...p.nodes]) }, parts };
  }
  // Split a flat run of nodes back into per-contour paths by the given parts. Used to turn a
  // position-op result (same node count, same parts) back into real contours for the write.
  function penSplitWith(flat: AuthoredPath, parts: PenPart[]): AuthoredPath[] {
    const out: AuthoredPath[] = [];
    let i = 0;
    for (const part of parts) {
      out.push({ kind: part.kind, closed: part.closed, nodes: flat.nodes.slice(i, i + part.count) });
      i += part.count;
    }
    return out;
  }
  // The current edit's contours as real per-contour paths (render / insert / delete read this).
  function penContours(): AuthoredPath[] {
    return penEdit ? penSplitWith(penEdit.path, penEdit.parts) : [];
  }
  // Cumulative flat start index of each part, and the part a flat node index falls in.
  function penPartStarts(parts: PenPart[]): number[] {
    const starts: number[] = [];
    let acc = 0;
    for (const p of parts) { starts.push(acc); acc += p.count; }
    return starts;
  }

  function startPenEdit(id: string): void {
    if (!cfg.pathField) return;
    if (editing) commitTextEdit();
    if (mode === 'pen') toPointer();
    const boxes = getBoxes();
    const i = indexOfId(boxes, id);
    if (i < 0) return;
    const decoded = decodePathContours(boxes[i]![cfg.pathField]);
    if (!decoded.length) { flash(t('That shape has no editable path.')); return; }
    const frame = penFrame(boxes[i], cfg);
    const local = decoded.map((p) => denormNodes(p, frame.w, frame.h));
    const joined = penJoin(local);
    penEdit = { id, frame, path: joined.path, parts: joined.parts };
    penSel = new Set<number>();
    penHandleSel = new Set<string>();
    penWarm = null;
    selection = new Set([id]);
    stageEl.classList.add('fc-node-editing');
    closeMorePanel(); closePopover();
    announce(t('Editing points - drag a point or its handle, click the curve to add a point, Esc to finish.'));
    renderChrome();
  }

  function endPenEdit(): void {
    if (!penEdit) return;
    setPathSvgHidden(false);
    penEdit = null;
    penSel = new Set<number>();
    penHandleSel = new Set<string>();
    penWarm = null;
    stageEl.classList.remove('fc-node-editing');
    clearPenChrome();
    paintPen();
    ctxSelKey = null;                           // force the ordinary object bar to rebuild
    scheduleSync();
  }

  /** Re-read the edited path from the MODEL, so an undo, a resize or a sibling edit while
   *  node-editing is reflected rather than overwritten by stale local state. Skipped
   *  mid-gesture, where the local path IS the truth until the drop commits. */
  function penSyncFromModel(boxes: Box[]): void {
    if (!penEdit || gesture) return;
    const i = indexOfId(boxes, penEdit.id);
    if (i < 0) { endPenEdit(); return; }
    const decoded = decodePathContours(boxes[i]![cfg.pathField]);
    if (!decoded.length) { endPenEdit(); return; }
    const frame = penFrame(boxes[i], cfg);
    const local = decoded.map((p) => denormNodes(p, frame.w, frame.h));
    const joined = penJoin(local);
    penEdit = { id: penEdit.id, frame, path: joined.path, parts: joined.parts };
    const n = penEdit.path.nodes.length;
    if ([...penSel].some((k) => k >= n)) penSel = new Set([...penSel].filter((k) => k < n));
    // Handle-selection keys reference node indices; a structural change (insert/delete)
    // reshuffles them, so drop any that no longer point at a live node rather than
    // aligning the wrong control point.
    if ([...penHandleSel].some((key) => Number(key.split(':')[0]) >= n)) {
      penHandleSel = new Set([...penHandleSel].filter((key) => Number(key.split(':')[0]) < n));
    }
  }

  /**
   * One completed edit → one model write, frame REFITTED to the curve.
   *
   * The frame is the curve's tight bounding box — that is the invariant every other part of
   * the editor reads (selection chrome, marquee, align/distribute, group bounds, the export
   * bbox) and the one `hooks.js` clips to. So an edit that put a node or a curve outside the
   * old frame grows it and an edit that pulled the shape inward shrinks it, and either way
   * `refitFrame` compensates the frame's own rotation so the RENDERED shape does not move by
   * a pixel. See `refitFrame` for the rotation and rounding arithmetic.
   *
   * This is the commit, not the drag: refitting per pointermove would make the box chase the
   * cursor. The live gesture paints on the native pen layer with the box's own `<svg>`
   * hidden, so nothing clips in between.
   *
   * Every contour is re-encoded, not just the edited one — see `penEdit`.
   *
   * `next` is the COMBINED path (all contours' nodes flat) that a position op returned — same
   * node count and same parts as `penEdit.path`, so it splits cleanly by the current parts.
   * A STRUCTURAL op (insert/delete/close/convert) that changes the parts calls
   * `penEditWritePaths` directly with the new per-contour array instead.
   */
  function penEditWrite(next: AuthoredPath): void {
    if (!penEdit) return;
    penEditWritePaths(penSplitWith(next, penEdit.parts));
  }
  function penEditWritePaths(all: AuthoredPath[]): void {
    if (!penEdit || !cfg.pathField || !all.length) return;
    // No refit when there is no curve to fit (an unlowerable kind): the old frame is then
    // the only frame there is, and it is better than a frame invented from nothing.
    const fit = refitFrame(all, penEdit.frame, penWarm);
    const frame = fit ? fit.frame : penEdit.frame;
    const paths = fit ? fit.paths : all;
    const value = encodePathFields(paths.map((p) => normNodes(p, frame.w, frame.h)));
    if (!value) { flash(t('That edit could not be saved, so nothing was changed.')); return; }
    const joined = penJoin(paths);
    penEdit = { ...penEdit, frame, path: joined.path, parts: joined.parts };
    const boxes = getBoxes();
    const i = indexOfId(boxes, penEdit.id);
    if (i < 0) { endPenEdit(); return; }
    commit(boxes.map((b, k) => (k === i
      ? {
        ...b, [cfg.pathField]: value,
        [cfg.xField]: frame.x, [cfg.yField]: frame.y, [cfg.wField]: frame.w, [cfg.hField]: frame.h,
      }
      : b)));
  }

  /** The handle under a box-local point, or null. Handles are tested BEFORE nodes: they
   *  are smaller and sit outside the curve, so a node would otherwise shadow one that
   *  happens to be short. */
  function penHandleAt(x: number, y: number, tol: number): { index: number; which: 'in' | 'out' } | null {
    if (!penEdit || !kindReadsHandles(penEdit.path.kind)) return null;
    let best: { index: number; which: 'in' | 'out' } | null = null;
    let bestD = tol;
    penEdit.path.nodes.forEach((n, i) => {
      for (const which of ['in', 'out'] as const) {
        const p = handlePoint(n, which);
        if (!p) continue;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= bestD) { bestD = d; best = { index: i, which }; }
      }
    });
    return best;
  }

  /** Insert a node where the pointer met the curve. Exact for `cubic` (a de Casteljau
   *  split), on-curve-but-reshaping for the derived kinds — see `insertNodeOnCurve`.
   *  Part-aware: the click may land on any contour, so each is tried and the nearest wins;
   *  the insert reshapes only THAT contour, and the new node's flat index is offset by the
   *  contour's start so the selection lands on it. */
  function penInsertAt(x: number, y: number): void {
    if (!penEdit) return;
    const contours = penContours();
    const starts = penPartStarts(penEdit.parts);
    let best: InsertResult | null = null;
    let bestPart = -1;
    for (let pi = 0; pi < contours.length; pi++) {
      // The warm hyperbezier start belongs to a single active contour; it is only valid
      // when there IS one contour. Multi-contour boxes are cubic, which needs no warm start.
      const res = insertNodeOnCurve(contours[pi]!, x, y, contours.length === 1 ? penWarm : null);
      if (res && (!best || res.distance < best.distance)) { best = res; bestPart = pi; }
    }
    if (!best || bestPart < 0) return;
    penWarm = null;                             // one more node → the warm start is stale
    penSel = new Set([starts[bestPart]! + best.index]);
    penHandleSel = new Set<string>();           // indices shifted; drop stale handle picks
    penEditWritePaths(contours.map((c, pi) => (pi === bestPart ? best!.path : c)));
  }

  function penDeleteSelected(): void {
    if (!penEdit || !penSel.size) return;
    const contours = penContours();
    const starts = penPartStarts(penEdit.parts);
    // Bucket the flat selection into each contour's own local index set.
    const perPart: Array<Set<number>> = contours.map(() => new Set<number>());
    for (const g of penSel) {
      for (let pi = contours.length - 1; pi >= 0; pi--) {
        if (g >= starts[pi]!) { perPart[pi]!.add(g - starts[pi]!); break; }
      }
    }
    const out: AuthoredPath[] = [];
    let anyDeleted = false;
    for (let pi = 0; pi < contours.length; pi++) {
      const sel = perPart[pi]!;
      const c = contours[pi]!;
      if (!sel.size) { out.push(c); continue; }
      // A wholly-selected contour is dropped outright (an intentional per-glyph erase), as
      // long as another survives (`out.length` guard below). A PARTIAL selection that would
      // orphan a contour under two points keeps it whole instead — the same floor as before.
      if (sel.size >= c.nodes.length) { anyDeleted = true; continue; }
      const nd = deleteNodes(c, sel);
      if (nd) { out.push(nd); anyDeleted = true; } else out.push(c);
    }
    if (!out.length || !anyDeleted) { flash(t('A path needs at least two points, so those were kept.')); return; }
    penWarm = null;
    penSel = new Set<number>();
    penHandleSel = new Set<string>();
    penEditWritePaths(out);
  }

  /**
   * Align / distribute the SELECTED NODES — the same six-plus-two operations the object
   * bar offers, and deliberately the same icons and the same grid shape, because "align
   * left" means the same thing to a user whether the things being aligned are boxes or
   * points. The two never collide: this button only exists while node editing, where
   * `selection` (boxes) is empty by construction.
   *
   * Straightening a traced outline is the reason it is here. A hand-placed run of points
   * along a straight edge is never actually straight, and the alternative is nudging each
   * one with the arrow keys.
   */
  /** The selection as point refs — nodes ∪ selected control points — for align/distribute. */
  function penPointRefs(): PenPointRef[] {
    const refs: PenPointRef[] = [...penSel].map((i) => ({ node: i }));
    for (const key of penHandleSel) {
      const [i, which] = key.split(':');
      refs.push({ node: Number(i), handle: which as 'in' | 'out' });
    }
    return refs;
  }

  /** The align + distribute grids for the current node/control-point selection, shared by
   *  the node-edit bar's Arrange button and the node right-click menu. `disabled` reflects
   *  the combined count (align ≥2, distribute ≥3) so the SAME items read correctly in a
   *  context menu that stays a constant shape. */
  function penArrangeItems(): PopItem[] {
    const n = penPointRefs().length;
    const align = (edge: NodeAlignEdge): void => {
      if (!penEdit) return;
      penWarm = null;               // points moved, so a warm hyperbezier start is stale
      penEditWrite(alignPoints(penEdit.path, penPointRefs(), edge));
    };
    const dist = (axis: 'h' | 'v'): void => {
      if (!penEdit) return;
      penWarm = null;
      penEditWrite(distributePoints(penEdit.path, penPointRefs(), axis));
    };
    return [
      { cols: 3, grid: [
        { label: t('Align left'), icon: icon(SVG.alignL), run: () => align('left'), disabled: n < 2 },
        { label: t('Align centre'), icon: icon(SVG.alignC), run: () => align('hcentre'), disabled: n < 2 },
        { label: t('Align right'), icon: icon(SVG.alignR), run: () => align('right'), disabled: n < 2 },
        { label: t('Align top'), icon: icon(SVG.alignT), run: () => align('top'), disabled: n < 2 },
        { label: t('Align middle'), icon: icon(SVG.alignM), run: () => align('vcentre'), disabled: n < 2 },
        { label: t('Align bottom'), icon: icon(SVG.alignB), run: () => align('bottom'), disabled: n < 2 },
      ] },
      // Evenly spacing three points needs three points.
      { cols: 2, grid: [
        { label: t('Distribute horizontally'), icon: icon(SVG.distH), run: () => dist('h'), disabled: n < 3 },
        { label: t('Distribute vertically'), icon: icon(SVG.distV), run: () => dist('v'), disabled: n < 3 },
      ] },
    ];
  }

  function openPenArrangeMenu(anchor: HTMLElement): void {
    if (!penEdit || penPointRefs().length < 2) return;
    spawnPopover(anchor, penArrangeItems());
  }

  /** Right-click menu WHILE node editing: the same align/distribute grids plus delete and
   *  continuity, at the cursor. Selects the node/handle under the pointer first (like the
   *  object menu selects the box under it) so a right-click acts on what it is over. */
  function openPenNodeMenu(clientX: number, clientY: number): void {
    if (!penEdit) return;
    closePopover();
    const nat = clientToNative(clientX, clientY);
    const loc = frameToLocal(penEdit.frame, nat.x, nat.y);
    const tol = penTol();
    const hh = penHandleAt(loc.x, loc.y, tol);
    if (hh) {
      const key = `${hh.index}:${hh.which}`;
      if (!penHandleSel.has(key)) { penHandleSel = new Set([key]); penSel = new Set<number>(); }
    } else {
      const ni = nodeAt(penEdit.path, loc.x, loc.y, tol);
      if (ni >= 0 && !penSel.has(ni)) { penSel = new Set([ni]); penHandleSel = new Set<string>(); }
    }
    renderChrome();
    const items: PopItem[] = [...penArrangeItems()];
    if (penSel.size && kindReadsHandles(penEdit.path.kind)) {
      items.push({ sep: true });
      items.push({ cols: 3, grid: [
        { label: t('Corner point - handles move independently'), icon: icon(SVG.contCorner), run: () => penSetContinuity('corner') },
        { label: t('Smooth point - handles stay in line'), icon: icon(SVG.contSmooth), run: () => penSetContinuity('smooth') },
        { label: t('Symmetric point - handles stay in line and equal'), icon: icon(SVG.contSymmetric), run: () => penSetContinuity('symmetric') },
      ] });
    }
    items.push({ sep: true });
    items.push({ label: t('Delete the selected points'), icon: icon(SVG.trash), danger: true, disabled: !penSel.size, run: () => penDeleteSelected() });
    popover = document.createElement('div');
    popover.className = 'fc-popover fc-context-menu';
    fillPopover(popover, items);
    popover.addEventListener('pointerdown', (e) => e.stopPropagation());
    stageEl.appendChild(popover);
    const sr = stageEl.getBoundingClientRect();
    popover.style.left = Math.max(6, Math.min(clientX - sr.left, sr.width - popover.offsetWidth - 6)) + 'px';
    popover.style.top = Math.max(6, Math.min(clientY - sr.top, sr.height - popover.offsetHeight - 6)) + 'px';
  }

  function penSetContinuity(c: Continuity): void {
    if (!penEdit || !penSel.size) return;
    penEditWrite(setNodeContinuity(penEdit.path, penSel, c));
  }

  function penToggleClosed(): void {
    if (!penEdit) return;
    penWarm = null;                             // open↔closed changes the segment count
    // Flip every contour to the SAME new state (based on the first), so a multi-contour box
    // toggles deterministically rather than leaving a mix. Single-contour is the old behaviour.
    const contours = penContours();
    const closed = !contours[0]!.closed;
    penEditWritePaths(contours.map((p) => ({ ...p, closed })));
  }

  /**
   * Switch the edited path's spline kind, warning first when that discards authored work.
   *
   * The asymmetry is `convertKind`'s: to `cubic` bakes the current lowering into explicit
   * handles and is lossless; to `hyperbezier` (or another derived kind) DROPS them and
   * cannot get them back. So the lossy direction asks, in the same `fc-panel` recipe the
   * one-number prompts use — the smallest confirmation this overlay has.
   */
  function penSetKind(to: SplineKind): void {
    if (!penEdit) return;
    const apply = (): void => {
      const warm = penWarm;
      penWarm = null;
      // Convert every contour. The warm start belongs to a single active contour, so it is
      // only passed when there is exactly one; multi-contour boxes are cubic and need none.
      const contours = penContours();
      penEditWritePaths(contours.map((p, pi) => convertKind(p, to, (pi === 0 && contours.length === 1) ? warm : null).path));
    };
    if (!penContours().some((p) => convertKind(p, to).lossy)) { apply(); return; }
    askConfirm({
      at: penCtxAnchorPoint(),
      title: t('Discard the handles?'),
      hint: t('This spline works out its own handle lengths, so the ones you set will be dropped. Switching back cannot bring them back.'),
      confirm: t('Discard and switch'),
      apply,
      cancel: () => { ctxSelKey = null; renderChrome(); },   // put the menu back on the old kind
    });
  }

  // ── pen preview + node chrome ─────────────────────────────────────────────────

  /** Hide the box's own rendered `<svg>` while a node drag is live, so the (stale) committed
   *  shape does not double up with the pen layer's live one. Mirrors
   *  `setRealConnectorsHidden`; the commit re-renders it anyway. */
  function setPathSvgHidden(hidden: boolean): void {
    if (!penEdit) return;
    const el = canvasEl.querySelector<HTMLElement>(`.lolly-box[data-box-id="${cssEscape(penEdit.id)}"] .lolly-box-path`);
    if (el) el.style.visibility = hidden ? 'hidden' : '';
  }

  /**
   * Lower a path to SVG path data for the preview, KEEPING the hyperbezier solution as the
   * next frame's warm start.
   *
   * This is why `toCubics(path, warm)` grew that parameter and why the pen path does not use
   * it: `toCubics` throws the solution it computed away, so every frame of a drag would
   * re-converge a 40-node Newton run from the chord-bend guess. Solving here and holding
   * the answer turns each subsequent frame into one or two steps.
   */
  function penPathD(p: AuthoredPath): string {
    const low = lowerAuthored(p, penWarm);
    if (low.solution) penWarm = low.solution;
    return low.cubics.length ? cubicsToD(low.cubics, p.closed) : '';
  }
  /** Cubics → `d`, in native/box-local units. `M` once, then one `C` per curve; the close
   *  is emitted as `Z` only when the contour really is closed, so an open path is not
   *  silently filled. */
  function cubicsToD(cubics: Cubic[], closed: boolean): string {
    const first = cubics[0]!;
    let d = `M${cf2(first[0])} ${cf2(first[1])}`;
    for (const k of cubics) d += `C${cf2(k[2])} ${cf2(k[3])} ${cf2(k[4])} ${cf2(k[5])} ${cf2(k[6])} ${cf2(k[7])}`;
    return closed ? d + 'Z' : d;
  }

  /**
   * The arrowheads of the box being node-edited, as an SVG fragment in BOX-LOCAL px (the
   * caller wraps it in the frame transform, so a rotated box's heads rotate with it).
   *
   * Why it is here at all: a node drag hides the box's own `<svg>` and paints this hairline
   * outline instead, so without it the arrowheads blink out for the whole gesture — exactly
   * while you are moving the point one of them sits on. The geometry is the engine's
   * `edgeArrowHead`, the same call the committed render reaches through the host bridge, so
   * the preview head is the head.
   *
   * Heads go on a SINGLE OPEN contour only, matching pathHtmlFor: "the path's ends" is not
   * a thing a multi-contour boolean result or a closed loop has. The ink is `currentColor`
   * (the guide colour of the outline it decorates), not the box's stroke: this is chrome,
   * and a head painted in a stroke colour that happens to match the artboard would vanish.
   * No shaft pullback either — a 1.6px hairline cannot poke through a filled head visibly,
   * and the inset belongs to the committed render, which is what the export reads.
   */
  function penEditHeadsSvg(contours: AuthoredPath[]): string {
    if (!hasHeadCfg || !penEdit || contours.length !== 1 || contours[0]!.closed) return '';
    const boxes = getBoxes();
    const i = indexOfId(boxes, penEdit.id);
    if (i < 0) return '';
    const b = boxes[i] || {};
    const hs = String(b[cfg.headStartField] || 'none');
    const he = String(b[cfg.headEndField] || 'none');
    if (hs === 'none' && he === 'none') return '';
    const low = lowerAuthored(contours[0]!, penWarm);
    if (!low.cubics.length) return '';
    const tips = pathEndPoints(low.cubics);
    const dir = pathEndTangents(low.cubics);
    if (!tips || !dir) return '';
    // The same clamp `pathHeadSize` applies before the engine sizes a head, so the preview
    // head is the committed head at every stroke width, not just under 20.
    const size = Math.max(9, clampN(b[cfg.strokeWField], 2.5, 0.5, 20) * 4);
    return (hs !== 'none' ? edgeArrowHead(tips.start, dir.start.x, dir.start.y, size, 'currentColor', hs) : '')
      + (he !== 'none' ? edgeArrowHead(tips.end, dir.end.x, dir.end.y, size, 'currentColor', he) : '');
  }

  /** The pen layer: the draft (plus the segment under the cursor) while drawing, and the
   *  edited path's live outline while node-editing. */
  function paintPen(): void {
    if (!penDraft && !penEdit) {
      if (penLayer.style.display !== 'none') { penLayer.style.display = 'none'; penLayer.innerHTML = ''; }
      return;
    }
    const m = metrics();
    placeNativeLayer(penLayer, m);
    const sw = 1.6 / (m.scale || 1);            // constant SCREEN width at any zoom
    let body = '';
    if (penDraft) {
      // The cursor is included as a real node, so the preview is what committing here
      // would actually produce — for a hyperbezier that means the WHOLE run re-solves,
      // which is the honest picture and the reason the warm start matters.
      const preview: AuthoredPath = penCursor
        ? { ...penDraft, nodes: [...penDraft.nodes, { x: penCursor.x, y: penCursor.y, continuity: defaultContinuity(penDraft.kind) }] }
        : penDraft;
      const d = penPathD(preview);
      if (d) body += `<path d="${escape(d)}" fill="none" stroke="currentColor" stroke-width="${cf2(sw)}" stroke-linejoin="round" stroke-linecap="round"/>`;
    } else if (penEdit) {
      // Every contour is lowered and drawn (the box's own `<svg>` is hidden for the gesture,
      // so any contour left out would just vanish). A LONE contour keeps the warm hyperbezier
      // start for a smooth live drag; with several they are cubic and lower cold, and a warm
      // solution belongs to a single run anyway. Each keeps its OWN kind + closed via penPathD/
      // the cold lower, so a curve is never drawn ACROSS a contour boundary.
      const contours = penContours();
      const ds = contours.map((p) => {
        if (contours.length === 1) return penPathD(p);
        const low = lowerAuthored(p);
        return low.cubics.length ? cubicsToD(low.cubics, p.closed) : '';
      }).filter(Boolean);
      const fr = penEdit.frame;
      if (ds.length) {
        const tf = `translate(${cf2(fr.x)} ${cf2(fr.y)})` + (fr.rot ? ` rotate(${cf2(fr.rot)} ${cf2(fr.w / 2)} ${cf2(fr.h / 2)})` : '');
        body += `<g transform="${tf}"><path d="${escape(ds.join(' '))}" fill="none" stroke="currentColor" stroke-width="${cf2(sw)}" stroke-linejoin="round" stroke-linecap="round"/>`
          + penEditHeadsSvg(contours) + '</g>';
      }
    }
    penLayer.innerHTML = body;
    penLayer.style.display = '';
  }

  // ── endpoint binding (plan 96 P3) ─────────────────────────────────────────────
  //
  // Dragging one END of a path onto a box ATTACHES that end to it: the path becomes a
  // connector and the engine routes it from that box's border, re-solving as the box moves.
  // Dragging the same end off every box detaches it and the path is a plain spline again.
  // There is no mode and no separate tool — the gesture is the one the shape suggests, and
  // it is the thing Connect mode used to be (plan 96 P4 deleted that).

  /** Which end of the edited path a node-drag is moving, or undefined when it is not a
   *  single END node (an interior node has nothing to attach; two at once is a reshape).
   *  A CLOSED path has no ends, and a multi-contour path has no single pair of them. */
  function bindEndFor(indices: number[]): 'start' | 'end' | undefined {
    if (!hasBindCfg || !penEdit || indices.length !== 1) return undefined;
    if (penEdit.parts.length !== 1 || penEdit.path.closed) return undefined;
    const i = indices[0]!, n = penEdit.path.nodes.length;
    if (n < 2) return undefined;
    return i === 0 ? 'start' : i === n - 1 ? 'end' : undefined;
  }

  /** The box an end node would attach to at this native point: the topmost hit that is not
   *  the path itself and not a frame (a page is a container, not a thing to point at). */
  function bindableAt(x: number, y: number, selfId: string): string | null {
    const boxes = getBoxes();
    const hit = pickTopmost(boxes, x, y, cfg, seqHiddenSkip(boxes));
    if (hit < 0) return null;
    const b = boxes[hit] || {};
    const id = idOf(b, hit);
    if (id === selfId) return null;
    if (frameCfg && String(b[cfg.kindField]) === (frameCfg.frameKind || 'frame')) return null;
    return id;
  }

  /** The snap ring over the box an end would attach to. Drawn in the connector preview
   *  layer (native coordinates, already placed) so it pans and zooms with everything else.
   *  Same dashed outline Connect mode used to put round its pending source card — the
   *  affordance survived the mode. */
  function setBindHover(id: string | null): void {
    if (id === bindHover) return;
    bindHover = id;
    if (!id) { if (!penEdit) hideConnectLayer(); else { connectLayer.innerHTML = ''; } return; }
    const boxes = getBoxes();
    const i = indexOfId(boxes, id);
    if (i < 0) { bindHover = null; return; }
    const r = boxRect(boxes[i], cfg);
    placeConnectLayer(metrics());
    connectLayer.innerHTML =
      `<rect x="${cf2(r.x - 4)}" y="${cf2(r.y - 4)}" width="${cf2(r.w + 8)}" height="${cf2(r.h + 8)}" rx="10"` +
      ' fill="none" stroke="#30ba78" stroke-width="3" stroke-dasharray="7 5"/>';
    connectLayer.style.display = '';
  }

  /**
   * Write one end's binding — the whole commit, one `setInput`, one undo step.
   *
   * A no-op write is skipped so re-dragging an already-attached end does not mint an undo
   * step that changes nothing. Attaching also seeds a head on the far end when the path has
   * neither: an undecorated connector reads as a divider rather than as a link, and this is
   * the moment the user said "this points at that".
   */
  function applyBinding(id: string, which: 'start' | 'end', to: string): void {
    const field = which === 'start' ? cfg.bindStartField : cfg.bindEndField;
    if (!field) return;
    const boxes = getBoxes();
    const i = indexOfId(boxes, id);
    if (i < 0) return;
    const b = boxes[i] || {};
    if (String(b[field] ?? '') === to) return;
    const next: Box = { ...b, [field]: to };
    if (to && hasHeadCfg
      && String(b[cfg.headStartField] || 'none') === 'none'
      && String(b[cfg.headEndField] || 'none') === 'none') {
      next[which === 'start' ? cfg.headStartField : cfg.headEndField] = 'triangle';
    }
    commit(boxes.map((row, k) => (k === i ? next : row)));
    announce(to
      ? t('Attached to {name}. The line routes to it now, and follows it.', { name: to })
      : t('Detached. The line is a free shape again.'));
  }

  /** Every node's position in NATIVE px, in node order — the one place the two modes'
   *  coordinate spaces are reconciled. */
  function penNodePoints(): Array<{ node: SplineNode; at: Point; hIn: Point | null; hOut: Point | null }> {
    const p = penEdit ? penEdit.path : penDraft;
    if (!p) return [];
    const fr = penEdit ? penEdit.frame : null;
    const toNative = (x: number, y: number): Point => (fr ? localToFrame(fr, x, y) : { x, y });
    return p.nodes.map((node) => {
      const hi = handlePoint(node, 'in'), ho = handlePoint(node, 'out');
      return {
        node,
        at: toNative(node.x, node.y),
        hIn: hi ? toNative(hi.x, hi.y) : null,
        hOut: ho ? toNative(ho.x, ho.y) : null,
      };
    });
  }

  /**
   * Build-once / reposition-many for node chrome, keyed on the node COUNT plus which path
   * is being edited — nothing else. Repositioning is pure style writes, so a drag, a pan
   * and a zoom all cost the same handful of them; only placing or deleting a node (or
   * changing which box is edited) recreates elements and rebinds their pointerdown. This
   * is the discipline `chromeNodes` documents, and it matters more here: a 40-node path
   * rebuilt per frame is 120 elements and 80 listeners per pointermove.
   */
  function syncPenChrome(): void {
    const p = penEdit ? penEdit.path : penDraft;
    if (!p) { if (penChromeKey) clearPenChrome(); return; }
    // Handles are drawn while DRAWING as well as while editing. A pen's click-drag is the
    // one gesture whose whole feedback is the arm you are pulling, and on the very first
    // node of a path there is no segment yet, so without the arm the drag has no visible
    // effect at all — you are aiming a tangent blind. `handlePoint` returns null for a node
    // with no authored handle, so a click-only node still shows a bare dot and only the
    // nodes actually dragged grow arms.
    const withHandles = kindReadsHandles(p.kind);
    const key = `${penEdit ? 'e:' + penEdit.id : 'd'}:${p.nodes.length}:${withHandles ? 'h' : '-'}`;
    if (key !== penChromeKey) {
      penChromeKey = key;
      buildPenChrome(p.nodes.length, withHandles);
    }
    positionPenChrome();
  }

  /**
   * The node chrome carries NO listeners, unlike the selection handles.
   *
   * Every pen hit test already has to happen in box-local coordinates and be
   * rotation-aware — a handle can be anywhere, including under another node — so
   * `onCanvasPointerDown` does it with `penHandleAt`/`nodeAt`/`nearestOnPath` against the
   * real geometry. Binding a second, element-based path on top would give two answers to
   * the same question, and it is precisely the per-node listener rebinding that the
   * build-once discipline exists to avoid. The elements are therefore pointer-transparent
   * (see `.fc-pen-chrome` in editor.css) and this function only ever mints divs.
   */
  function buildPenChrome(count: number, withHandles: boolean): void {
    penChrome.innerHTML = '';
    const arms: HTMLElement[] = [];
    const dots: HTMLElement[] = [];
    const nodes: HTMLElement[] = [];
    // Arms below dots below nodes: paint order is tree order in this container.
    for (let k = 0; withHandles && k < count * 2; k++) {
      const arm = document.createElement('div');
      arm.className = 'fc-pen-arm';
      arm.hidden = true;
      penChrome.appendChild(arm);
      arms.push(arm);
    }
    for (let k = 0; withHandles && k < count * 2; k++) {
      const dot = document.createElement('div');
      dot.className = 'fc-pen-handle';
      dot.hidden = true;
      penChrome.appendChild(dot);
      dots.push(dot);
    }
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'fc-pen-node';
      penChrome.appendChild(el);
      nodes.push(el);
    }
    penChromeNodes = { nodes, arms, dots };
  }

  /** The MODEL row of the box being node-edited (the bindings live there, not on the
   *  denormalised local path `penEdit` holds). null when the edit is over. */
  function penEditBox(): Box | null {
    if (!penEdit) return null;
    const boxes = getBoxes();
    const i = indexOfId(boxes, penEdit.id);
    return i >= 0 ? (boxes[i] || null) : null;
  }

  function positionPenChrome(): void {
    const nodes = penChromeNodes;
    if (!nodes) return;
    const m = metrics();
    const pts = penNodePoints();
    for (let i = 0; i < nodes.nodes.length; i++) {
      const el = nodes.nodes[i]!;
      const pt = pts[i];
      if (!pt) { el.hidden = true; continue; }
      el.hidden = false;
      const s = nativeToStage(pt.at.x, pt.at.y, m);
      el.style.left = s.x + 'px';
      el.style.top = s.y + 'px';
      const cont = pt.node.continuity ?? defaultContinuity(penEdit ? penEdit.path.kind : penDraft!.kind);
      el.classList.toggle('is-corner', cont === 'corner');
      el.classList.toggle('is-symmetric', cont === 'symmetric');
      el.classList.toggle('is-on', penSel.has(i));
      // The first node of an OPEN draft is the one a click closes on, so it reads as a
      // target rather than as another placed point.
      el.classList.toggle('is-close-target', !!penDraft && i === 0 && pts.length >= 3);
      // plan 96 P3 — an ATTACHED end reads as filled, so "this line is pinned to that box"
      // is visible without dragging it to find out. Only the two ends can carry one.
      const end = penEdit ? (i === 0 ? 'start' : i === pts.length - 1 ? 'end' : null) : null;
      el.classList.toggle('is-bound', !!end && !!penEditBox() && bindOf(penEditBox()!, end) !== '');
    }
    for (let k = 0; k < nodes.dots.length; k++) {
      const i = k >> 1;
      const which: 'in' | 'out' = k % 2 === 0 ? 'in' : 'out';
      const dot = nodes.dots[k]!;
      const arm = nodes.arms[k]!;
      const pt = pts[i];
      const h = pt ? (which === 'in' ? pt.hIn : pt.hOut) : null;
      if (!pt || !h) { dot.hidden = true; arm.hidden = true; continue; }
      const a = nativeToStage(pt.at.x, pt.at.y, m);
      const b = nativeToStage(h.x, h.y, m);
      dot.hidden = false;
      dot.classList.toggle('is-on', penHandleSel.has(`${i}:${which}`));
      dot.style.left = b.x + 'px';
      dot.style.top = b.y + 'px';
      arm.hidden = false;
      arm.style.left = a.x + 'px';
      arm.style.top = a.y + 'px';
      arm.style.width = Math.hypot(b.x - a.x, b.y - a.y) + 'px';
      arm.style.transform = `rotate(${Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI}deg)`;
    }
  }

  // ── the pen's contextual bar ───────────────────────────────────────────────────

  /** Where the pen bar's own panels (the lossy-switch confirmation) anchor. */
  function penCtxAnchorPoint(): Point {
    const r = ctxbar.getBoundingClientRect();
    return { x: r.left || lastMenuAt.x, y: r.bottom || lastMenuAt.y };
  }

  /**
   * The paint section + kind switcher + continuity control, in `ctxbar` — which is the
   * contextual control bar that already rebuilds on a selection-signature change, so the
   * pen's signature just joins that scheme rather than inventing a second bar.
   *
   * The paint controls are the SAME `paintCtxHtml` the object bar uses. This bar replaces
   * `ctxbar.innerHTML`, so before that sharing existed fill and stroke disappeared the
   * instant node editing began — which is the thing the bug report was actually about.
   */
  function penCtxBar(): void {
    const p = penEdit ? penEdit.path : penDraft;
    if (!p) return;
    const contSig = [...penSel].sort((a, b) => a - b).map((i) => p.nodes[i]?.continuity ?? '').join(',');
    const handleSig = [...penHandleSel].sort().join(',');
    const key = `pen:${penEdit ? penEdit.id : 'draft'}:${p.kind}:${p.closed ? 'c' : 'o'}:${p.nodes.length}:${contSig}:${handleSig}:${penSelectHandles ? 'h' : '-'}`;
    if (key !== ctxSelKey) {
      ctxSelKey = key;
      buildPenCtxBar(p);
    }
    showCtxBar();
    positionPenCtxBar();
  }

  function buildPenCtxBar(p: AuthoredPath): void {
    closeMorePanel();
    const drawing = !!penDraft;
    const selN = penSel.size;
    // Align/distribute act on nodes ∪ selected control points, so the arrange button
    // enables on the COMBINED count (delete + continuity stay node-only via selN).
    const selPts = penSel.size + penHandleSel.size;
    const cont = selN ? String(p.nodes[[...penSel][0]!]?.continuity ?? defaultContinuity(p.kind)) : '';
    const kindLabel = penKindLabels();
    // Paint belongs to the BOX, so it only appears once there is one: a draft lives in JS
    // state until it commits, and its paint comes from the add-kind's seed.
    const painted = !drawing && !!penEdit;
    let editBox: Box = {};
    if (painted) {
      const rows = getBoxes();
      editBox = rows[indexOfId(rows, penEdit!.id)] || {};
    }
    ctxbar.innerHTML =
      (painted ? paintCtxHtml(editBox, true) + '<span class="fc-sep fc-sep-v"></span>' : '') +
      `<select class="field-select field-select--sm fc-pen-kind" data-pen="kind" title="${escape(t('Spline type'))}" aria-label="${escape(t('Spline type'))}">` +
        PEN_KINDS.map((k) => `<option value="${k}"${k === p.kind ? ' selected' : ''}>${escape(kindLabel[k] || k)}</option>`).join('') +
      '</select>' +
      (drawing ? '' :
        '<span class="fc-sep fc-sep-v"></span>' +
        segHtml('pen-cont', cont, [
          ['corner', t('Corner point - handles move independently'), SVG.contCorner],
          ['smooth', t('Smooth point - handles stay in line'), SVG.contSmooth],
          ['symmetric', t('Symmetric point - handles stay in line and equal'), SVG.contSymmetric],
        ]) +
        `<button type="button" class="fc-cbtn${p.closed ? ' is-on' : ''}" data-pen="closed" aria-pressed="${p.closed}" title="${escape(t('Closed path'))}" aria-label="${escape(t('Closed path'))}">${icon(SVG.penClose)}</button>` +
        // Marquee selection mode: nodes only, or nodes + control points. Only meaningful
        // where control points exist (cubic / hyperbezier).
        (kindReadsHandles(p.kind)
          ? `<button type="button" class="fc-cbtn${penSelectHandles ? ' is-on' : ''}" data-pen="handlesel" aria-pressed="${penSelectHandles}" title="${escape(penSelectHandles ? t('Selecting nodes and control points - click for nodes only') : t('Selecting nodes only - click to include control points'))}" aria-label="${escape(t('Include control points in a marquee selection'))}">${icon(SVG.nodes)}</button>`
          : '') +
        `<button type="button" class="fc-cbtn" data-pen="arrange"${selPts >= 2 ? '' : ' disabled'} title="${escape(t('Align and distribute the selected points'))}" aria-label="${escape(t('Align and distribute the selected points'))}">${icon(SVG.align)}</button>` +
        `<button type="button" class="fc-cbtn fc-danger" data-pen="del"${selN ? '' : ' disabled'} title="${escape(t('Delete the selected points'))}" aria-label="${escape(t('Delete the selected points'))}">${icon(SVG.trash)}</button>`) +
      '<span class="fc-sep fc-sep-v"></span>' +
      `<button type="button" class="fc-cbtn" data-pen="done" title="${escape(drawing ? t('Finish this path (Enter)') : t('Finish editing points (Esc)'))}" aria-label="${escape(drawing ? t('Finish this path') : t('Finish editing points'))}">${icon(SVG.penDone)}</button>` +
      `<span class="fc-readout">${escape(drawing
        ? (p.nodes.length === 1 ? t('1 point - hold Alt for a corner') : t('{n} points - hold Alt for a corner', { n: p.nodes.length }))
        : (selN ? t('{k} of {n} points', { k: selN, n: p.nodes.length }) : t('{n} points', { n: p.nodes.length })))}</span>`;
    const kindSel = ctxbar.querySelector<HTMLSelectElement>('[data-pen="kind"]');
    kindSel?.addEventListener('change', () => {
      const to = kindSel.value as SplineKind;
      if (penDraft) { penDraft = { ...penDraft, kind: to }; penDrawKind = to; penWarm = null; renderChrome(); return; }
      penSetKind(to);
    });
    wireSegs(ctxbar, (field, v) => { if (field === 'pen-cont' && v) penSetContinuity(v as Continuity); });
    if (painted) {
      wirePaintCtx(ctxbar);
      ctxbar.querySelectorAll<HTMLElement>('[data-cx="stroke"]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        openStrokePanel(b);
      }));
    }
    ctxbar.querySelectorAll<HTMLElement>('[data-pen]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const which = b.dataset.pen;
      if (which === 'closed') penToggleClosed();
      else if (which === 'handlesel') { penSelectHandles = !penSelectHandles; ctxSelKey = null; renderChrome(); }
      else if (which === 'arrange') openPenArrangeMenu(b);
      else if (which === 'del') penDeleteSelected();
      else if (which === 'done') { if (penDraft) penFinishDraw(); else endPenEdit(); }
    }));
  }

  /** Pinned to the top chrome row, centred between the back pill and zoom HUD — the same
   *  perch the object bar takes, so the bar does not jump when a draw becomes a selection
   *  and never sits over the path the user is shaping. */
  function positionPenCtxBar(): void {
    const m = metrics();
    const band = ctxTopBand({ w: m.sr.width, h: m.sr.height }, ctxBarBlockers(m.sr));
    ctxbar.style.maxWidth = Math.max(0, band.hi - band.lo) + 'px';
    const bw = ctxbar.offsetWidth || 0;
    if (bw <= 0) return;   // not laid out yet — next frame, rather than a half-width-off jump
    const pos = centreCtxBar(bw, band);
    ctxbar.style.left = pos.left + 'px';
    ctxbar.style.top = pos.top + 'px';
  }

  // ── the tool mode ─────────────────────────────────────────────────────────────
  /**
   * THE mode switch. Every enter/exit below is private to it, because the bug it fixes was
   * not a missing button: the modes were four independent booleans, so each `armX` had to
   * remember to disarm each of the others by hand — and `armConnect` never disarmed the pen,
   * so Connect-over-Pen left two live tools, two lit rail buttons, and an Escape that took
   * two presses to dismantle what looked like one state. Here "enter next" IS "leave
   * everything else", once, in one place.
   *
   * `draft` decides an in-progress pen path's fate, and the two answers are deliberately
   * opposite: a TOOL SWITCH finishes it ('commit', the default — the user asked for a
   * different tool, not to throw the path away, which is what every mainstream design tool
   * does), while Escape means cancel and passes 'discard'. Getting these the same way round
   * either loses drawn work or resurrects work the user just abandoned. `penFinishDraw`
   * still commits nothing for a draft under two nodes, so a stray single click on the way
   * out leaves no invisible one-node box behind.
   *
   * Point editing is not a mode, but it IS something the user is inside, so any tool change
   * leaves it — the same way switching tools leaves a text edit.
   */
  function setMode(next: EditorMode, o: { kind?: AddKind; draft?: 'commit' | 'discard' } = {}): void {
    // The line tool writes a PATH BOX now (plan 96 P2), so it is gated on the same config
    // the pen is — `pathField` — and no longer on the connectors input it used to write to.
    if (next === 'line' && !cfg.pathField) return;
    if (next === 'pen' && !cfg.pathField) return;
    if (next === 'create' && !o.kind && !armedKind) return;
    if (next !== 'select') nodeToolActive = false;   // any other tool exits the Node tool
    const from = mode;
    if (penEdit) endPenEdit();
    if (from === 'pen' && penDraft) { if (o.draft === 'discard') penCancelDraw(); else penFinishDraw(); }
    mode = next;
    if (from !== next) {
      // A mode switch while a create/line DRAG is still in flight (Escape's discard rung, or
      // a V/P/N tool shortcut pressed mid-draw) ABORTS that gesture, so its eventual
      // pointerup can't commit a box/line against the discard — both tools committed on
      // release and neither ended the gesture here (plan 90 verify LENS 3). endGesture()
      // nulls `gesture`, so onGestureEnd early-returns on release; the browser auto-releases
      // the pointer capture. Scoped to these two so select-mode move/resize/rotate is
      // untouched (those never coexist with a tool switch), as is pen's own draft handling.
      if (gesture && (gesture.type === 'create' || gesture.type === 'line')) endGesture();
      if (from === 'create') exitCreate();
      else if (from === 'pen') exitPen();
      else if (from === 'line') exitLine();
      if (next === 'pen') enterPen();
      else if (next === 'line') enterLine();
    }
    if (next === 'create') enterCreate(o.kind);
    syncModeUI();
  }
  /** Back to the pointer, from anywhere — Escape's mode rung, and every internal "this
   *  gesture consumed the tool" exit. */
  const toPointer = (draft: 'commit' | 'discard' = 'commit'): void => { setMode('select', { draft }); };
  /** The pointer as an EXPLICIT user choice (the rail button, `V`). Announced, because the
   *  other two tools announce themselves and a mode change no screen reader hears is not a
   *  mode change; the internal exits above stay quiet, or every edge click would speak. */
  const pickPointer = (): void => {
    nodeToolActive = false;                     // the plain pointer is NOT the Node tool
    toPointer();
    announce(t('Pointer on - click to select, drag to move.'));
  };

  /** Toggle the Node tool. Turning it on drops any other tool (it is a select sub-mode)
   *  and, if exactly one path box is selected, jumps straight into editing it — the
   *  "jump straight into node editing an object" ask. */
  function toggleNodeTool(): void {
    if (nodeToolActive) { nodeToolActive = false; if (penEdit) endPenEdit(); syncModeUI(); announce(t('Pointer on - click to select, drag to move.')); return; }
    if (mode !== 'select') setMode('select');   // exit pen/create/connect
    nodeToolActive = true;
    const boxes = getBoxes();
    if (selection.size === 1) {
      const id = [...selection][0]!;
      const i = boxes.findIndex((b, k) => idOf(b, k) === id);
      if (i >= 0 && boxOutlineKind(boxes[i], vectorCfg ?? undefined) === 'path') startPenEdit(id);
    }
    syncModeUI();
    announce(t('Node tool on - click a shape to edit its points.'));
  }

  function enterCreate(kind?: AddKind): void {
    if (kind) armedKind = kind;
    // Every arm starts UNTIMED, and the timeline path re-stamps its time right after
    // calling setMode. Clearing here rather than only in exitCreate is what makes a
    // create→create switch safe: setMode skips exitCreate when the mode does not
    // change, so arming from the timeline `+` and then from the rail's add menu used
    // to carry the stale playhead time into the box drawn by the SECOND arm.
    pendingAddAtMs = null;
    deselectEdge();
    stageEl.classList.add('fc-arming');
  }
  function exitCreate(): void {
    armedKind = null;
    pendingAddAtMs = null;   // an abandoned arm must not time the NEXT box drawn by hand
    stageEl.classList.remove('fc-arming');
  }
  // `enterConnect` / `exitConnect` (plan 90) lived here. Plan 96 P4 deleted Connect mode
  // outright: clicking a card and then another card was a third way to make the one
  // primitive the Pen and the Line tool already make, and P3 replaced it with the gesture
  // the shape itself suggests — drag a line's endpoint onto a box and it attaches. There is
  // no mode to enter, so there is no mode to be trapped in and none to leave.
  // The Line tool (plan 96 P2) — the pen's other gesture. One drag draws a straight
  // two-node authored path, committed as an ordinary path box: selectable, node-editable,
  // and carrying the same stroke + arrowhead decorations any spline does.
  function enterLine(): void {
    deselectEdge();
    hideConnectLayer();
    selection = new Set<string>();
    stageEl.classList.add('fc-lining');
    setHoverEdge(null);
    announce(t('Line tool — drag on the canvas to draw a line or arrow. Esc to finish.'));
    renderChrome();
  }
  function exitLine(): void {
    stageEl.classList.remove('fc-lining');
    hideConnectLayer();
    clearGuides();
  }
  /**
   * What the Line tool adds to a path box beyond the pen's own seeding.
   *
   * An arrowhead at the END and nothing at the start: someone reaching for a line tool on a
   * layout canvas is nearly always pointing at something, and an undecorated straight
   * segment is what the pen already gives. The head is a normal field, so the stroke panel
   * takes it straight back off.
   *
   * Both bindings are written EMPTY rather than left absent, so a line drawn today carries
   * the same shape of row as one bound in P3 — the field exists, it just names no box.
   */
  const lineBoxSeed = (): Box => ({
    ...(hasHeadCfg ? { [cfg.headStartField]: 'none', [cfg.headEndField]: 'triangle' } : {}),
    ...(hasBindCfg ? { [cfg.bindStartField]: '', [cfg.bindEndField]: '' } : {}),
  });

  /**
   * The rail's one job: say which tool is live. Attributes only, on buttons captured at
   * build time — this runs on every chrome sync (so, every frame of a drag), and the rail
   * follows the same build-once/touch-many discipline as the selection chrome.
   */
  function syncModeUI(): void {
    const flag = (b: HTMLElement | null, on: boolean): void => {
      if (!b) return;
      b.classList.toggle('is-armed', on);
      b.setAttribute('aria-pressed', String(on));
    };
    flag(modeBtns.select, mode === 'select' && !nodeToolActive);
    flag(modeBtns.create, mode === 'create');
    flag(modeBtns.pen, mode === 'pen');
    flag(modeBtns.line, mode === 'line');
    flag(nodeToolBtn, nodeToolActive);
  }

  // Auto-arrange the connected cards into a tidy top-down hierarchy. Roots (cards with
  // nothing pointing AT them) are laid out left-to-right; each child sits under its parent,
  // and a parent is centred over the span of its children. Unconnected cards are left where
  // they are. One commit → one undo step.
  //
  // The graph is read off the path boxes' BINDINGS (plan 96 P4). It used to be read off the
  // `connectors` edge input; a connector is a path box now, and `bindStart` → `bindEnd` is
  // the same directed pair `from` → `to` was, so the walk below is unchanged.
  function autoLayout(): void {
    if (!hasBindCfg) return;
    const boxes = getBoxes();
    if (!boxes.length) return;
    const idAt = new Map<string, number>();
    boxes.forEach((b, i) => idAt.set(idOf(b, i), i));
    const children = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const b of boxes) {
      if (!b) continue;
      const from = String(b[cfg.bindStartField] ?? ''), to = String(b[cfg.bindEndField] ?? '');
      if (!from || !to || !idAt.has(from) || !idAt.has(to) || from === to) continue;
      if (!children.has(from)) children.set(from, []);
      if (!children.get(from)!.includes(to)) children.get(from)!.push(to);
      hasParent.add(to);
    }
    const roots = boxes.map((b, i) => idOf(b, i)).filter((id) => children.has(id) && !hasParent.has(id));
    if (!roots.length) { announce(t('Connect some cards first, then Auto-arrange lays them out.')); return; }   // nothing connected → leave the canvas alone
    const HGAP = 40, VGAP = 90;
    const cw = canvasWH();
    const placed = new Map<string, { x: number; y: number }>();
    const seen = new Set<string>();
    let cursorX = 0;
    // First pass: assign x by in-order leaf slots, y by depth; parents centre over kids.
    function widthOf(id: string): number {
      const b = boxes[idAt.get(id)!]!;
      return Math.max(1, num(b[cfg.wField], 200));
    }
    function heightAtDepth(d: number): number {
      // Uniform row height = the tallest card overall (keeps rows aligned).
      let mh = 0;
      for (const b of boxes) mh = Math.max(mh, num(b[cfg.hField], 100));
      return d * (mh + VGAP);
    }
    function layout(id: string, depth: number): { cx: number } {
      seen.add(id);
      const kids = (children.get(id) || []).filter((k) => !seen.has(k));
      const y = heightAtDepth(depth);
      if (!kids.length) {
        const x = cursorX;
        cursorX += widthOf(id) + HGAP;
        placed.set(id, { x, y });
        return { cx: x + widthOf(id) / 2 };
      }
      const cxs: number[] = [];
      for (const k of kids) cxs.push(layout(k, depth + 1).cx);
      const cx = (cxs[0]! + cxs[cxs.length - 1]!) / 2;
      placed.set(id, { x: cx - widthOf(id) / 2, y });
      return { cx };
    }
    for (const r of roots) { layout(r, 0); cursorX += HGAP * 2; }
    // Centre the whole tree horizontally on the artboard, then snap onto the grid.
    let minX = Infinity, maxX = -Infinity, minY = Infinity;
    for (const [id, p] of placed) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x + widthOf(id)); minY = Math.min(minY, p.y); }
    const offX = (cw.w - (maxX - minX)) / 2 - minX;
    const offY = Math.max(40, (cw.h * 0.12)) - minY;
    const g = gridOn ? gridSize : 1;
    const next = boxes.map((b, i) => {
      const id = idOf(b, i);
      const p = placed.get(id);
      if (!p) return b;
      return { ...b, [cfg.xField]: Math.round((p.x + offX) / g) * g, [cfg.yField]: Math.round((p.y + offY) / g) * g };
    });
    commit(next);
  }

  // ── object copy / paste ───────────────────────────────────────────────────────
  // ⌘/Ctrl+C on a selection copies the box(es) — both to an in-memory clip and,
  // behind FC_CLIP_PREFIX, onto the OS clipboard — so the next ⌘V duplicates them
  // (see onGlobalPaste). While editing text the browser's native text copy wins;
  // this only fires on the bare canvas with a selection.
  let objectClipboard: Box[] | null = null;   // Array<box> — the in-memory fallback
  let lastPointer: { x: number; y: number } | null = null;       // last client {x,y} over the stage — paste placement
  function pasteAimedHere(): boolean {
    const ae = document.activeElement;
    return !(ae && ae !== document.body && !stageEl.contains(ae));
  }
  function onCopy(e: ClipboardEvent): void {
    if (disposed || editing) return;               // editing → native text copy
    if (typingTarget() || !pasteAimedHere()) return;
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (!idx.length) return;                        // nothing selected → native copy
    const picked = idx.map((i) => ({ ...boxes[i] }));
    objectClipboard = picked;
    try {
      e.clipboardData!.setData('text/plain', FC_CLIP_PREFIX + JSON.stringify(picked));
      e.preventDefault();
    } catch { /* clipboard write blocked — the in-memory copy still serves ⌘V */ }
  }
  // Duplicate a set of copied boxes at a +24,+24 offset (cascades on repeat paste),
  // clamped into the canvas, and select the fresh copies. Mirrors duplicateSelection.
  function pasteObjects(picked: any): void {
    if (!Array.isArray(picked) || !picked.length) return;
    const boxes = getBoxes();
    const cw = canvasWH();
    const clones: Box[] = [];
    const nextSel = new Set<string>();
    for (const src of picked) {
      if (!src || typeof src !== 'object') continue;
      const id = freshId(boxes.concat(clones));
      const r = boxRect(src, cfg);
      let clone = { ...src, [cfg.idField]: id, [cfg.xField]: Math.round(r.x + 24), [cfg.yField]: Math.round(r.y + 24) };
      clone = clampBoxToCanvas(clone, cfg, cw);
      clones.push(clone);
      nextSel.add(id);
    }
    if (!clones.length) return;
    selection = nextSel;
    commit([...boxes, ...clones]);
    renderChrome();
  }

  // ── paste-to-create ──────────────────────────────────────────────────────────
  // Pasting (⌘/Ctrl+V, or a mobile long-press paste) while nothing is being edited
  // drops the clipboard text into a NEW text box. Rich clipboard HTML (bold/italic/
  // colour/weight/lists) is converted to the tool's markdown-subset source by
  // round-tripping through the same rich-text model the editor uses; plain text is
  // used verbatim. The in-edit editable has its OWN paste handler (onEditPaste) and
  // stops propagation, so this only fires on the bare canvas.
  const textAddKind = (): AddKind | undefined => addKinds.find((k) => k.id === 'text' || (k.seed && k.seed[cfg.kindField] === 'text'));
  function sourceFromPastedHtml(html: string): string {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return markdownFromChars(charsFromDom(doc.body)).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    } catch { return ''; }
  }
  function createTextBoxFromSource(source: string): void {
    if (!cfg.textField) return;
    const kind = textAddKind();
    const seed: Box = { ...(kind && kind.seed) };
    seed[cfg.textField] = source;
    const boxes = getBoxes();
    const cw = canvasWH();
    // Place the new box where the cursor last was over the stage (a text paste is
    // usually aimed there); fall back to the visible-canvas centre when the pointer
    // is stale / off-stage (e.g. a keyboard ⌘V after scrolling).
    const m = metrics();
    const onStage = lastPointer &&
      lastPointer.x >= m.sr.left && lastPointer.x <= m.sr.left + m.sr.width &&
      lastPointer.y >= m.sr.top && lastPointer.y <= m.sr.top + m.sr.height;
    const c = onStage
      ? clientToNative(lastPointer!.x, lastPointer!.y)
      : clientToNative(m.sr.left + m.sr.width / 2, m.sr.top + m.sr.height / 2);
    const fontSize = parseFloat(String(seed[cfg.fontSizeField])) || 64;
    const lhRaw = parseFloat(String(seed[cfg.lineHeightField]));
    const lh = Number.isFinite(lhRaw) ? lhRaw : 1.12;
    const padRaw = parseFloat(String(seed[cfg.padField]));
    const pad = Number.isFinite(padRaw) ? padRaw : 8;
    const lines = source.split('\n').length;
    const w = Math.round(Math.min(cw.w * 0.72, 760));
    // Over-estimate height (the box clips overflow in the render) — the user can drag
    // to resize, and a subsequent text edit grows-to-fit exactly.
    const h = Math.round(Math.max(120, lines * fontSize * lh + pad * 2 + fontSize * 0.5));
    const id = freshId(boxes);
    let box = seedBox(cfg, {}, seed, { x: c.x - w / 2, y: c.y - h / 2, w, h } as MathRect, id);
    box = clampBoxToCanvas(box, cfg, cw);
    selection = new Set([id]);
    commit([...boxes, box]);
    renderChrome();
  }
  function onGlobalPaste(e: ClipboardEvent): void {
    if (disposed || editing) return;
    if (typingTarget()) return;                    // a real input owns the paste
    if (!canvasEl.isConnected) return;
    if (!pasteAimedHere()) return;                 // aimed at a modal/picker elsewhere
    const dt = e.clipboardData || (window as any).clipboardData;
    if (!dt) return;
    const plain = String((dt.getData && dt.getData('text/plain')) || '');
    // Objects copied inside the editor → paste = duplicate them (⌘C/⌘V an object).
    // Prefer the clipboard payload (survives reloads); fall back to the in-memory
    // copy when the clipboard held only our marker or the read was blocked.
    if (plain.startsWith(FC_CLIP_PREFIX) || (objectClipboard && !plain.trim())) {
      let picked = objectClipboard;
      if (plain.startsWith(FC_CLIP_PREFIX)) {
        try { picked = JSON.parse(plain.slice(FC_CLIP_PREFIX.length)); } catch { /* keep in-memory */ }
      }
      if (Array.isArray(picked) && picked.length) {
        e.preventDefault(); e.stopPropagation();
        pasteObjects(picked);
        return;
      }
    }
    // Otherwise clipboard TEXT (rich or plain) → a new text box at the canvas centre.
    if (!cfg.textField) return;
    const html = dt.getData && dt.getData('text/html');
    let source = html && html.trim() ? sourceFromPastedHtml(html) : '';
    if (!source) source = plain.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (!source.trim()) return;                    // nothing useful → let the default happen
    e.preventDefault();
    e.stopPropagation();
    createTextBoxFromSource(source);
  }

  // Multi-page mode: page frames clip their content (overflow:hidden) so a box that
  // bleeds off a page is cut at the page edge in the render. While a box is being
  // dragged, lift that clip so a box crossing between pages (or into the gap) stays
  // fully visible under the cursor; the next paint re-buckets it and restores the clip.
  // No-op for single-page editors (no [data-pdf-page] frames).
  function setFramesClipped(clipped: boolean): void {
    if (!pages && !frameCfg) return;
    canvasEl.querySelectorAll<HTMLElement>('[data-pdf-page]').forEach((f) => {
      if (!clipped) {
        // Stash the inline overflow before lifting the clip so we can restore it
        // EXACTLY. Carousel `.cm-page` clips from the stylesheet (inline ''), but the
        // frames path bakes `overflow:hidden` INLINE on clipChildren frames — blanket
        // resetting to '' there would delete the only clip source, so restore verbatim.
        f.dataset.fcOverflow = f.style.overflow;
        f.style.overflow = 'visible';
      } else {
        f.style.overflow = f.dataset.fcOverflow ?? '';
        delete f.dataset.fcOverflow;
      }
    });
    // When restoring the clip at gesture end, also drop the drag-time z-index hoist
    // (applyLiveRect set it) so box paint order returns to array order. A committed edit
    // repaints the elements clean anyway; this covers a gesture that ends without a commit.
    if (clipped) canvasEl.querySelectorAll<HTMLElement>('.lolly-box').forEach((el) => { el.style.zIndex = ''; });
  }

  // ── pointer gestures on the canvas ───────────────────────────────────────────
  function beginGesture(e: PointerEvent, g: GestureInit): void {
    try { canvasEl.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
    gesture = { ...g, pointerId: e.pointerId, startClient: { x: e.clientX, y: e.clientY } } as Gesture;
    setHoverEdge(null);   // drop any hover highlight/cursor when a drag begins
    document.body.classList.add('fc-manipulating');
    setFramesClipped(false);
    frameOffCache = new Map();   // frame offsets are stable during a drag — cache to avoid per-move reflow
  }
  function endGesture(): void {
    document.body.classList.remove('fc-manipulating');
    gesture = null;
    rubber.hidden = true;
    clearGuides();
    setFramesClipped(true);
    frameOffCache = null;   // release the gesture-scoped frame-offset cache
    // The ctx bar's live state dies WITH the gesture: the frozen placement, the cached
    // chrome rects, and — the visible one — the drag readout. Its values come from
    // `liveRects`, so without a repaint of its own the bar keeps showing the coordinates
    // the pointer left behind until the tool's own re-render lands, which is a second or
    // more away and outlives things as unrelated as a playhead scrub. `commit()` writes
    // the model synchronously, so the frame after this one reads the settled numbers.
    ctxFrozen = null;
    ctxBlockers = null;
    if (!disposed) requestAnimationFrame(() => { if (!disposed && !gesture) renderChrome(); });
  }

  // ── inline text editing (double-click a box) ─────────────────────────────────
  // WYSIWYG rich text: the box's rendered markup is edited in place, and a
  // floating format bar offers bold/italic/bullets (selection-level, via the
  // rich-text.js char model) plus alignment/weight/size (box-level, staged in
  // editing.pending and committed with the text as one undo step).
  let fmtbar: FmtBar | null = null;

  function onDblClick(e: MouseEvent): void {
    // A double-click ends an open pen path — the polyline-ending gesture every tool with a
    // multi-click primitive uses — and it never falls through to a text edit, because there
    // is no box under the cursor yet to edit.
    if (penDraft) { e.preventDefault(); penFinishDraw(); return; }
    // On a committed path box it ENTERS node editing, the same way a double-click enters a
    // text edit on a text box (see startTextEdit); one mode per kind of content.
    if (vectorCfg && !penEdit) {
      const pnat = clientToNative(e.clientX, e.clientY);
      const pboxes = getBoxes();
      const phit = pickTopmost(pboxes, pnat.x, pnat.y, cfg, seqHiddenSkip(pboxes));
      if (phit >= 0 && boxOutlineKind(pboxes[phit], vectorCfg) === 'path') {
        e.preventDefault();
        startPenEdit(idOf(pboxes[phit], phit));
        return;
      }
    }
    if (penEdit) return;                        // node-edit mode owns its own double-clicks
    if (!cfg.textField) return;
    // Already editing this box's text → let the browser's native double-click
    // word-selection stand. This listener is on the canvas, so a dblclick inside
    // the editable bubbles up to here; re-entering startTextEdit would commit +
    // restart the edit and collapse the caret to the end — the reported "word
    // flashes selected then vanishes" bug. (Triple-click escaped it only because
    // its third click fires no second dblclick event.) Just refresh the bar.
    if (editing && editing.el.contains(e.target as Node)) { refreshFmtStates(); return; }
    const nat = clientToNative(e.clientX, e.clientY);
    const boxes = getBoxes();
    const hit = selectHit(boxes, nat.x, nat.y);   // artboard-aware (a frame has no editable text → startTextEdit no-ops)
    if (hit < 0) return;
    e.preventDefault();
    selection = new Set([idOf(boxes[hit], hit)]);
    renderChrome();
    startTextEdit(idOf(boxes[hit], hit));
  }
  // A box element only exists after a foreground paint (rAF-gated), so a freshly
  // created box needs us to wait a few frames before we can focus its text.
  function editAfterPaint(id: string, opts: { selectAll?: boolean }, tries = 8): void {
    if (disposed) return;
    const el = canvasEl.querySelector<HTMLElement>(`.lolly-box[data-box-id="${cssEscape(id)}"] .lolly-box-text`);
    if (el) { startTextEdit(id, opts); return; }
    if (tries > 0) requestAnimationFrame(() => editAfterPaint(id, opts, tries - 1));
  }
  function startTextEdit(id: string, opts: { selectAll?: boolean } = {}): void {
    if (editing) commitTextEdit();
    const el = canvasEl.querySelector<HTMLElement>(`.lolly-box[data-box-id="${cssEscape(id)}"] .lolly-box-text`);
    if (!el) return;
    const boxEl = el.closest<HTMLElement>('.lolly-box');
    // WYSIWYG: edit the RENDERED rich text in place (the element already holds
    // hooks.js richText output — <strong>/<em> runs, \n line breaks, "•  "
    // bullets). Formatting ops round-trip through the rich-text.js char model,
    // and commit serialises back to the stored markdown-subset source.
    // `pending` collects box-field changes (align/weight/size/…) made from the
    // format bar mid-edit; they preview as inline styles and land in the SAME
    // commit as the text, so the whole edit stays one undo step.
    editing = {
      id, el, boxEl,
      prevHtml: el.innerHTML,
      prevStyle: el.style.cssText,
      prevBoxStyle: boxEl ? boxEl.style.cssText : '',
      pending: {},
    };
    clearChrome();               // hide handles while typing (resets chrome node cache)
    hideCtxBar();
    closeMorePanel(); closePopover();
    boxEl?.classList.add('fc-box-editing');   // reveal overflow so typing stays visible
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-label', t('Edit text'));
    el.classList.add('fc-editing');
    el.focus();
    // Select-all when replacing a create-seed ("Text") so the first keystroke wins;
    // otherwise drop the caret at the end for a natural continue-typing feel.
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!opts.selectAll) range.collapse(false);
    const sel = window.getSelection();
    sel!.removeAllRanges(); sel!.addRange(range);
    el.addEventListener('keydown', onEditKey);
    el.addEventListener('blur', onEditBlur);
    el.addEventListener('paste', onEditPaste);
    document.addEventListener('selectionchange', onEditSelChange);
    showFmtBar();
    positionFmtBar();
    refreshFmtStates();
  }
  function onEditKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); cancelTextEdit(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitTextEdit(); }
    // Plain Enter inserts a literal \n (the render model is pre-wrap text) —
    // never the browser's <div> soup, which would desync the char model.
    else if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
    else if ((e.key === 'b' || e.key === 'B') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleInline('b'); }
    else if ((e.key === 'i' || e.key === 'I') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleInline('i'); }
    e.stopPropagation();          // keep global Delete/nudge/undo off while typing
  }
  // Paste as plain text: rich clipboard HTML would smuggle arbitrary markup into
  // the editable; \n survives fine under pre-wrap.
  function onEditPaste(e: ClipboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const text = (e.clipboardData || (window as any).clipboardData)?.getData('text/plain') ?? '';
    if (text) document.execCommand('insertText', false, text);
  }
  function onEditSelChange(): void {
    if (editing) refreshFmtStates();
  }
  function onEditBlur(e: FocusEvent): void {
    // Clicking our own format bar preventDefaults focus, so blur shouldn't fire from
    // it — but guard anyway so a stray blur toward the bar never drops the edit.
    if (e && e.relatedTarget && fmtbar && fmtbar.contains(e.relatedTarget as Node)) return;
    commitTextEdit();
  }
  function finishEdit(): EditingState | null {
    if (!editing) return null;
    const done = editing; editing = null;
    hideFmtBar();
    done.el.removeEventListener('keydown', onEditKey);
    done.el.removeEventListener('blur', onEditBlur);
    done.el.removeEventListener('paste', onEditPaste);
    document.removeEventListener('selectionchange', onEditSelChange);
    done.el.removeAttribute('contenteditable');
    done.el.removeAttribute('role');
    done.el.removeAttribute('aria-label');
    done.el.classList.remove('fc-editing');
    done.boxEl?.classList.remove('fc-box-editing');
    return done;
  }
  // Restore the pre-edit rendered view + inline styles (drops any pending-field
  // live previews the format bar applied during the edit).
  function restoreEditView(done: EditingState): void {
    done.el.innerHTML = done.prevHtml;
    done.el.style.cssText = done.prevStyle;
    if (done.boxEl) done.boxEl.style.cssText = done.prevBoxStyle;
  }
  function commitTextEdit(): void {
    const done = editing;
    if (!done) return;
    const text = markdownFromChars(charsFromDom(done.el));
    const pending = done.pending || {};
    const boxes = getBoxes();
    const i = indexOfId(boxes, done.id);
    const changedText = i >= 0 && String(boxes[i]![cfg.textField] ?? '') !== text;
    const changed = changedText || Object.keys(pending).length > 0;
    // Grow-to-fit — ONLY when the edit actually changed something (so merely
    // opening a box to read it never mutates its height). The box clips overflow
    // in the final render, so if the copy is taller than the box, grow it (only
    // ever grow) to keep it whole. The editable IS the rendered rich text (with
    // any pending size/weight previews already applied), so measure it directly.
    // A box that opted into shrink-to-fit handles overflow by scaling the text DOWN, so
    // it must NOT also grow — the two are opposite responses to the same overflow.
    const fitOn = i >= 0 && !!cfg.fitTextField && boolOf(boxes[i]![cfg.fitTextField], false);
    let grownH: number | null = null;
    if (changed && !fitOn && cfg.hField && done.boxEl) {
      const needed = Math.ceil(done.el.scrollHeight);
      const boxNativeH = parseFloat(done.boxEl.style.height) || 0;
      if (boxNativeH && needed > boxNativeH + 1) grownH = needed;
    }
    finishEdit();
    if (i < 0) { renderChrome(); return; }
    if (changed) {
      commit(boxes.map((b, k) => {
        if (k !== i) return b;
        const nb = { ...b, ...pending, [cfg.textField]: text };
        if (grownH != null) nb[cfg.hField] = grownH;
        return nb;
      }));
    } else {
      restoreEditView(done);   // nothing changed → restore rendered view
      renderChrome();
    }
  }
  function cancelTextEdit(): void {
    const done = editing;
    if (!done) return;
    finishEdit();
    restoreEditView(done);     // discard edits, restore rendered view
    renderChrome();
  }

  // ── in-edit formatting: true rich text over the char model ────────────────────
  // The editable's DOM ↔ a flat char array (rich-text.js); the selection maps to
  // [start, end) character offsets. Toggle = parse → flip flags → re-render →
  // restore the selection at the same offsets. BRs count as one \n character.
  function selectionOffsets(el: HTMLElement): [number, number] | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
    const offsetOf = (container: Node, offset: number): number => {
      let n = 0;
      let found = false;
      const walk = (node: Node): void => {
        if (found) return;
        if (node.nodeType === 3) {
          if (node === container) { n += Math.min(offset, node.nodeValue!.length); found = true; }
          else n += node.nodeValue!.length;
          return;
        }
        if (node.nodeName === 'BR') {
          if (node === container) found = true;
          else n += 1;
          return;
        }
        const kids = node.childNodes;
        for (let k = 0; k < kids.length; k++) {
          if (node === container && k === offset) { found = true; return; }
          walk(kids[k]!);
          if (found) return;
        }
        if (node === container) found = true;
      };
      walk(el);
      return n;
    };
    const a = offsetOf(range.startContainer, range.startOffset);
    const b = offsetOf(range.endContainer, range.endOffset);
    return a <= b ? [a, b] : [b, a];
  }
  function selectOffsets(el: HTMLElement, a: number, b: number): void {
    const idxIn = (node: Node): number => Array.prototype.indexOf.call(node.parentNode!.childNodes, node);
    const posOf = (target: number): { node: Node; offset: number } => {
      let n = 0;
      let out: { node: Node; offset: number } | null = null;
      const walk = (node: Node): void => {
        if (out) return;
        if (node.nodeType === 3) {
          const len = node.nodeValue!.length;
          if (n + len >= target) { out = { node, offset: target - n }; return; }
          n += len;
          return;
        }
        if (node.nodeName === 'BR') {
          if (n + 1 > target) out = { node: node.parentNode!, offset: idxIn(node) };
          else n += 1;
          return;
        }
        for (const kid of node.childNodes) { walk(kid); if (out) return; }
      };
      walk(el);
      return out || { node: el, offset: el.childNodes.length };
    };
    const start = posOf(a);
    const end = b === a ? start : posOf(b);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const sel = window.getSelection();
    sel!.removeAllRanges(); sel!.addRange(range);
  }
  function toggleInline(flag: string): void {
    if (!editing) return;
    const el = editing.el;
    el.focus();
    const off = selectionOffsets(el);
    if (!off) return;
    let [a, b] = off;
    const chars = charsFromDom(el);
    if (a === b) [a, b] = wordRangeAt(chars, a);   // caret → the word under it
    if (a === b) return;
    const next = setFlag(chars, a, b, flag as 'b' | 'i', !rangeHasFlag(chars, a, b, flag as 'b' | 'i'));
    el.innerHTML = htmlFromChars(next);
    selectOffsets(el, a, b);
    refreshFmtStates();
  }
  // Text colour on the selection (mid-edit). The colour picker steals focus/selection, so
  // STASH the range the moment the swatch is engaged (while the editable still owns the
  // selection) and colour that range on each pick. `color` falsy → clear to the box fg.
  function stashRunColorRange(): void {
    if (!editing) return;
    const off = selectionOffsets(editing.el);
    if (!off) return;                        // focus already left → keep the earlier stash
    const chars = charsFromDom(editing.el);
    let [a, b] = off;
    if (a === b) [a, b] = wordRangeAt(chars, a);
    if (a < b) editing.colorRange = [a, b];
  }
  function applyRunColor(color: any): void {
    if (!editing || !editing.colorRange) return;
    const [a, b] = editing.colorRange;
    const el = editing.el;
    el.innerHTML = htmlFromChars(setColor(charsFromDom(el), a, b, color || null));
    try { selectOffsets(el, a, b); } catch { /* focus may be in the colour picker */ }
    refreshFmtStates();
  }
  // Per-selection font weight (mid-edit). Like the colour picker, the <select> steals
  // focus/selection when it opens, so STASH the range on engage and re-weight it on
  // change. A null weight clears the run back to the box weight. Weight and bold are
  // the same axis, so setWeight drops any bold on the run (rich-text.js invariant).
  function stashRunWeightRange(): void {
    if (!editing) return;
    const off = selectionOffsets(editing.el);
    if (!off) return;
    const chars = charsFromDom(editing.el);
    let [a, b] = off;
    if (a === b) [a, b] = wordRangeAt(chars, a);
    if (a < b) editing.weightRange = [a, b];
  }
  function applyRunWeight(weight: any): void {
    if (!editing || !editing.weightRange) return;
    const [a, b] = editing.weightRange;
    const el = editing.el;
    el.innerHTML = htmlFromChars(setWeight(charsFromDom(el), a, b, weight));
    try { selectOffsets(el, a, b); } catch { /* focus may be in the select */ }
    refreshFmtStates();
  }
  // Toggle "•  " bullets / "1.  " numbers on every non-blank line (a text box is one
  // logical list — bullets and numbers are mutually exclusive, handled in rich-text.js).
  function toggleBullet(): void { toggleList(toggleBullets); }
  function toggleNumber(): void { toggleList(toggleNumbers); }
  function toggleList(fn: (chars: any) => any): void {
    if (!editing) return;
    const el = editing.el;
    el.focus();
    const next = fn(charsFromDom(el));
    el.innerHTML = htmlFromChars(next);
    selectOffsets(el, next.length, next.length);   // caret to the end
    refreshFmtStates();
  }
  // A field tweak from the format bar mid-edit: preview it as an inline style on
  // the live box (repainting now would destroy the contenteditable) and stash it
  // in `pending` for commitTextEdit to fold into the box row.
  function applyPending(field: string | undefined, value: any): void {
    if (!editing || !field) return;
    editing.pending[field] = value;
    const el = editing.el;
    const boxEl = editing.boxEl;
    if (field === cfg.alignField) {
      el.style.textAlign = value;
      if (boxEl) boxEl.style.justifyContent = H_JUSTIFY[value] || 'center';
    } else if (field === cfg.valignField) {
      if (boxEl) boxEl.style.alignItems = V_ALIGN[value] || 'center';
    } else if (field === cfg.weightField) {
      el.style.fontWeight = String(value);
    } else if (field === cfg.fontSizeField) {
      el.style.fontSize = value + 'px';
    } else if (field === cfg.fontField) {
      el.style.fontFamily = fontStackFor(value);
    } else if (field === cfg.ligaturesField || field === cfg.alternatesField) {
      applyFeaturePreview();
    }
    positionFmtBar();
    refreshFmtStates();
  }
  // Preview the box-level OpenType features on the live editable (ligatures /
  // stylistic alternates). 'normal' explicitly re-enables defaults, overriding
  // any stale value baked into the box's rendered style.
  function applyFeaturePreview(): void {
    if (!editing) return;
    const boxes = getBoxes();
    const box: Box = boxes[indexOfId(boxes, editing.id)] || {};
    const ligOn = boolOf(pendingOr(cfg.ligaturesField, box[cfg.ligaturesField]), true);
    const altOn = boolOf(pendingOr(cfg.alternatesField, box[cfg.alternatesField]), false);
    editing.el.style.fontFeatureSettings = featureSettings(ligOn, altOn) || 'normal';
  }
  // Toggle a box-level boolean (ligatures/alternates) from the format bar, staged
  // like the other box fields and committed with the text as one undo step.
  function toggleBoxBool(field: string | undefined, dflt: boolean): void {
    if (!editing || !field) return;
    const boxes = getBoxes();
    const box: Box = boxes[indexOfId(boxes, editing.id)] || {};
    applyPending(field, !boolOf(pendingOr(field, box[field]), dflt));
  }
  // Drop the brand emoji trio (🦎💚🐧 / 🐧💚🦎) at the caret and force the box's
  // ligatures ON, so the font can shape the three adjacent glyphs as one ligature.
  // The insert keeps them adjacent; forcing ligatures on means a box that had the
  // feature switched off still shapes them. Staged like the other box fields, so the
  // insert + the ligature toggle land in the SAME commit (one undo step).
  function insertBrandLigature(seq: string): void {
    if (!editing) return;
    editing.el.focus();
    if (cfg.ligaturesField) {
      const box: Box = getBoxes()[indexOfId(getBoxes(), editing.id)] || {};
      if (!boolOf(pendingOr(cfg.ligaturesField, box[cfg.ligaturesField]), true)) applyPending(cfg.ligaturesField, true);
    }
    // execCommand keeps the contenteditable's own selection model in sync (same path
    // as Enter/paste); the inserted glyphs serialise straight through on commit.
    document.execCommand('insertText', false, seq);
    refreshFmtStates();
  }
  // Strip inline character formatting (bold/italic/weight/colour) from the
  // selection (or the word under the caret). Lists are paragraph-level and kept.
  function clearFormattingSelection(): void {
    if (!editing) return;
    const el = editing.el;
    el.focus();
    const off = selectionOffsets(el);
    if (!off) return;
    let [a, b] = off;
    const chars = charsFromDom(el);
    if (a === b) [a, b] = wordRangeAt(chars, a);
    if (a === b) return;
    el.innerHTML = htmlFromChars(clearFormatting(chars, a, b));
    selectOffsets(el, a, b);
    refreshFmtStates();
  }
  const pendingOr = (field: string | undefined, fallback: any): any =>
    (editing && field && field in editing.pending ? editing.pending[field] : fallback);
  function showFmtBar(): void {
    if (fmtbar) return;
    fmtbar = document.createElement('div') as FmtBar;
    fmtbar.className = 'fc-fmtbar';
    fmtbar.setAttribute('data-export-hide', '');
    const refs: FmtRefs = { align: {}, valign: {} };
    // The bar is built as a row of logical GROUPS (type · styles · align · valign ·
    // size · OpenType). Each group is one flex item that never splits internally, so
    // when the bar wraps to a second row it breaks cleanly between groups and the
    // clusters stay legible. `curGroup` is the section buttons land in; section()
    // starts a new one.
    let curGroup: HTMLElement = fmtbar;
    const section = (): HTMLElement => {
      const g = document.createElement('span');
      g.className = 'fc-fmt-group';
      fmtbar!.appendChild(g);
      curGroup = g;
      return g;
    };
    const mk = (label: string, html: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'fc-cbtn'; b.title = label; b.setAttribute('aria-label', label);
      b.innerHTML = html;
      // preventDefault on pointerdown keeps the caret/selection in the editable
      // (focus never leaves → the toggle hits the live selection, no blur/commit).
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
      curGroup.appendChild(b);
      return b;
    };
    const boxes = getBoxes();
    const box: Box = boxes[indexOfId(boxes, editing?.id)] || {};
    // Type pill — font, weight and text colour joined into ONE connected control
    // (a single left→right run: font → weight → colour). These are the type
    // settings reached for most while typing; the weight menu is seeded from the
    // font so it sits between them. CSS collapses the inner borders so the three
    // read as one pill — only the pill's outer corners round.
    const typeGroup = document.createElement('span');
    typeGroup.className = 'fc-fmt-typegroup';
    if (cfg.fontField) {
      const fsel = document.createElement('select');
      fsel.className = 'field-select field-select--sm field-select--auto fc-fmt-font';
      fsel.title = t('Font');
      fsel.setAttribute('aria-label', t('Font'));
      fsel.innerHTML = fontOptionsHtml();
      fsel.addEventListener('pointerdown', (e) => e.stopPropagation());
      fsel.addEventListener('change', () => {
        const font = fsel.value;
        applyPending(cfg.fontField, font);
        if (cfg.weightField && isMonoFont(font)) {
          const bx: Box = getBoxes()[indexOfId(getBoxes(), editing!.id)] || {};
          if ((parseInt(pendingOr(cfg.weightField, bx[cfg.weightField]), 10) || 700) > 800) applyPending(cfg.weightField, '800');
        }
        if (refs.weight) {   // the run-weight menu's choices depend on the font
          const cur = refs.weight.value;
          refs.weight.innerHTML = `<option value="">${t('Auto')}</option>` +
            weightChoicesFor(font).map(([v, l]) => `<option value="${v}">${escape(t(l))}</option>`).join('');
          refs.weight.value = weightChoicesFor(font).some(([v]) => v === cur) ? cur : '';
        }
      });
      typeGroup.appendChild(fsel);
      refs.font = fsel;
    }
    // Weight (per-selection) sits right after the font — its menu depends on the
    // font — and before the colour. "Auto" = no explicit run weight (the run
    // inherits the box weight); refreshFmtStates fills it from the selected run.
    if (cfg.weightField) {
      const sel = document.createElement('select');
      sel.className = 'field-select field-select--sm field-select--auto fc-fmt-weight';
      sel.title = t('Weight of the selected text');
      sel.setAttribute('aria-label', t('Weight of the selected text'));
      const font = String((cfg.fontField && box[cfg.fontField]) || defaultFont);
      sel.innerHTML = `<option value="">${t('Auto')}</option>` + weightChoicesFor(font).map(([v, l]) => `<option value="${v}">${escape(t(l))}</option>`).join('');
      sel.value = '';
      // Stash the selection on engage (the select steals focus/selection when it
      // opens); no preventDefault — the select needs focus, and the onEditBlur guard
      // recognises the bar so the edit survives the round trip.
      sel.addEventListener('pointerdown', (e) => { e.stopPropagation(); stashRunWeightRange(); });
      sel.addEventListener('change', () => applyRunWeight(sel.value === '' ? null : parseInt(sel.value, 10)));
      typeGroup.appendChild(sel);
      refs.weight = sel;
    }
    // Per-selection text colour (distinct from the whole-box fg on the object bar)
    // — closes the pill.
    if (cfg.textColorField) {
      const cw = document.createElement('span');
      cw.className = 'fc-cfield fc-fmt-color';
      cw.innerHTML = colorFieldHtml('fc-runcolor', box[cfg.textColorField] || '#0c322c', { float: true });
      // Capture the selection before the picker takes focus (capture phase catches the
      // trigger's pointerdown; later swatch clicks find no selection and keep the stash).
      cw.addEventListener('pointerdown', () => stashRunColorRange(), true);
      typeGroup.appendChild(cw);
      wireColorField(cw, { onChange: (_id, val) => applyRunColor(unwrapColor(val)) });
    }
    // Type section — the connected font·weight·colour pill plus the "reset
    // formatting" button (T-with-a-slash: strips bold/italic/weight/colour from the
    // selection, keeping paragraph structure). Grouped so the pill and its reset
    // never split across a wrapped row.
    if (typeGroup.childElementCount || cfg.textColorField) {
      const g = section();
      if (typeGroup.childElementCount) g.appendChild(typeGroup);
      if (cfg.textColorField) refs.clear = mk(t('Reset text formatting'), icon(SVG.resetColor), () => clearFormattingSelection());
    }
    // Character styles — bold / italic / bulleted + numbered lists.
    section();
    refs.b = mk(t('Bold (⌘B)'), '<b>B</b>', () => toggleInline('b'));
    refs.i = mk(t('Italic (⌘I)'), '<i style="font-family:serif">I</i>', () => toggleInline('i'));
    refs.bullet = mk(t('Bulleted list'), icon(SVG.bulletList), () => toggleBullet());
    refs.numbers = mk(t('Numbered list'), '<b style="font-size:11px">1.</b>', () => toggleNumber());
    // How the copy sits in its box: horizontal alignment, then vertical — each its
    // own group so the two icon-runs read apart.
    if (cfg.alignField) {
      section();
      for (const [v, label, ic] of [['left', 'Align left', SVG.textL], ['center', 'Align centre', SVG.textC], ['right', 'Align right', SVG.textR]] as Array<[string, string, string]>) {
        refs.align[v] = mk(t(label), icon(ic), () => applyPending(cfg.alignField, v));
      }
    }
    if (cfg.valignField) {
      section();
      for (const [v, label, ic] of [['top', 'Align to top', SVG.textT], ['middle', 'Centre vertically', SVG.textM], ['bottom', 'Align to bottom', SVG.textB]] as Array<[string, string, string]>) {
        refs.valign[v] = mk(t(label), icon(ic), () => applyPending(cfg.valignField, v));
      }
    }
    // Size steppers — the weight menu moved into the type pill, so this trailing
    // group is just the A− / A+ font-size nudges.
    if (cfg.fontSizeField) {
      section();
      mk(t('Smaller text'), 'A−', () => bumpPendingFont(-6));
      mk(t('Bigger text'), 'A+', () => bumpPendingFont(6));
    }
    // OpenType features (whole-box, staged): ligatures + stylistic alternates, plus
    // the brand-ligature inserter.
    if (cfg.ligaturesField || cfg.alternatesField) {
      section();
      if (cfg.ligaturesField) refs.lig = mk(t('Ligatures'), '<span style="font-size:13px">fi</span>', () => toggleBoxBool(cfg.ligaturesField, true));
      if (cfg.alternatesField) refs.alt = mk(t('Stylistic alternates'), '<span style="font-size:13px">a͎</span>', () => toggleBoxBool(cfg.alternatesField, false));
      // Geeko 💚 Tux — drops the brand emoji trio at the caret and forces ligatures
      // on so the font can shape the three adjacent glyphs as one ligature. Plain
      // click inserts 🦎💚🐧; ⌥/Alt-click flips to penguin-first (🐧💚🦎). Gated on
      // the ligatures field since it turns that feature on.
      if (cfg.ligaturesField) {
        const emo = document.createElement('button');
        emo.type = 'button';
        emo.className = 'fc-cbtn fc-fmt-emoji';
        emo.title = t('Insert 🦎💚🐧 — turns ligatures on (⌥-click for 🐧💚🦎)');
        emo.setAttribute('aria-label', t('Insert Geeko loves Tux'));
        emo.textContent = '🦎💚🐧';
        emo.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
        emo.addEventListener('click', (e) => { e.stopPropagation(); insertBrandLigature(e.altKey ? '🐧💚🦎' : '🦎💚🐧'); });
        curGroup.appendChild(emo);
        refs.emoji = emo;
      }
    }
    fmtbar._refs = refs;
    overlay.appendChild(fmtbar);
  }
  function bumpPendingFont(delta: number): void {
    if (!editing || !cfg.fontSizeField) return;
    const boxes = getBoxes();
    const box: Box = boxes[indexOfId(boxes, editing.id)] || {};
    const cur = parseFloat(pendingOr(cfg.fontSizeField, box[cfg.fontSizeField]));
    const base = Number.isFinite(cur) ? cur : 48;
    applyPending(cfg.fontSizeField, Math.max(4, base + delta));
  }
  // Reflect the live state on the bar: B/I from the selection (or the word under
  // the caret), bullets/alignment/weight from the box row + pending overrides.
  function refreshFmtStates(): void {
    if (!fmtbar || !editing) return;
    const r = (fmtbar._refs || {}) as FmtRefs;
    const chars = charsFromDom(editing.el);
    let [a, b] = selectionOffsets(editing.el) || [chars.length, chars.length];
    if (a === b) [a, b] = wordRangeAt(chars, a);
    r.b?.classList.toggle('is-on', rangeHasFlag(chars, a, b, 'b'));
    r.i?.classList.toggle('is-on', rangeHasFlag(chars, a, b, 'i'));
    r.bullet?.classList.toggle('is-on', allBulleted(chars));
    r.numbers?.classList.toggle('is-on', allNumbered(chars));
    const boxes = getBoxes();
    const box: Box = boxes[indexOfId(boxes, editing.id)] || {};
    const alignCur = String(pendingOr(cfg.alignField, box[cfg.alignField] || 'center'));
    const valignCur = String(pendingOr(cfg.valignField, box[cfg.valignField] || 'middle'));
    for (const [v, btn] of Object.entries(r.align)) btn.classList.toggle('is-on', v === alignCur);
    for (const [v, btn] of Object.entries(r.valign)) btn.classList.toggle('is-on', v === valignCur);
    if (r.weight && document.activeElement !== r.weight) {
      // The weight picker reflects the SELECTED RUN's explicit weight (or Auto).
      const rw = rangeWeight(chars, a, b);
      r.weight.value = rw != null ? String(rw) : '';
    }
    // Whole-box font + OpenType feature toggles (staged in pending).
    if (r.font && document.activeElement !== r.font) {
      r.font.value = String(pendingOr(cfg.fontField, box[cfg.fontField]) || defaultFont);
    }
    r.lig?.classList.toggle('is-on', boolOf(pendingOr(cfg.ligaturesField, box[cfg.ligaturesField]), true));
    r.alt?.classList.toggle('is-on', boolOf(pendingOr(cfg.alternatesField, box[cfg.alternatesField]), false));
  }
  function hideFmtBar(): void { fmtbar?.remove(); fmtbar = null; }
  function positionFmtBar(): void {
    if (!fmtbar || !editing) return;
    const boxes = getBoxes();
    const i = indexOfId(boxes, editing.id);
    if (i < 0) return;
    const m = metrics();
    const aabb = selectionAABB(boxes, [i], cfg);
    if (!aabb) return;
    const tl = nativeToStage(aabb.minX, aabb.minY, m);
    const br = nativeToStage(aabb.maxX, aabb.minY, m);
    const bottomY = nativeToStage(aabb.minX, aabb.maxY, m).y;
    const bw = fmtbar.offsetWidth || 0;
    const bh = fmtbar.offsetHeight || 44;
    const GAP = 8;
    fmtbar.style.left = Math.max(6, Math.min((tl.x + br.x) / 2 - bw / 2, m.sr.width - bw - 6)) + 'px';
    // Seat the WHOLE bar above the box using its real height (the two-row
    // colour version is ~90px — a fixed offset let it dip onto the first line).
    // If there's no room above, flip below the box; clamp to the stage so a
    // tall/off-screen box pins the bar to a visible edge, never over the text.
    const above = tl.y - bh - GAP;
    const top = above >= 6 ? above : Math.min(bottomY + GAP, m.sr.height - bh - 6);
    fmtbar.style.top = Math.max(6, top) + 'px';
  }

  // ── two-finger tap → context menu (touch) ─────────────────────────────────────
  // A touchscreen has no right-click, and `contextmenu` is not reliably synthesised for
  // one: Android Chrome fires it on a long-press, iOS Safari does not fire it at all over
  // ordinary elements, and NO mobile browser fires it for a two-finger tap. So the
  // gesture is recognised here rather than waited for.
  //
  // It must not steal two-finger PAN or PINCH, which tool-stage-nav.ts owns on this same
  // element through these same pointer events. That is what the two thresholds are for: a
  // tap is two fingers down together, neither travelling more than TWO_TAP_SLOP, released
  // inside TWO_TAP_MS. A pan travels, a pinch travels, and a two-finger hold outstays the
  // window — each of those clears the candidate and stageNav keeps the gesture untouched.
  // Nothing is taken away from it in the tap case either: stageNav's pinch dead-zone
  // swallows a sub-pixel finger spread and a zero-delta two-finger pan is a no-op.
  const TWO_TAP_MS = 500;
  const TWO_TAP_SLOP = 14;                    // SCREEN px, per finger
  interface TouchPt { x: number; y: number; moved: number }
  const touchPts = new Map<number, TouchPt>();
  let twoTapStart = 0;                        // when the second finger landed (0 = not a candidate)
  let twoTapDone = false;                     // menu already opened for this touch sequence

  // Capture phase on the STAGE, so this runs before onCanvasPointerDown (bound to the
  // canvas, a descendant) and that handler can see the second finger has arrived.
  function onStageTouchDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return;
    touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: 0 });
    if (touchPts.size === 2) { twoTapStart = e.timeStamp || Date.now(); twoTapDone = false; }
    else if (touchPts.size > 2) twoTapStart = 0;   // three fingers is not a tap
  }
  function onStageTouchMove(e: PointerEvent): void {
    const p = touchPts.get(e.pointerId);
    if (!p) return;
    p.moved = Math.max(p.moved, Math.hypot(e.clientX - p.x, e.clientY - p.y));
    if (p.moved > TWO_TAP_SLOP) twoTapStart = 0;   // a pan or a pinch, not a tap
  }
  function onStageTouchUp(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return;
    const pts = [...touchPts.values()];
    const when = e.timeStamp || Date.now();
    if (twoTapStart && !twoTapDone && pts.length === 2
      && when - twoTapStart <= TWO_TAP_MS
      && pts.every((p) => p.moved <= TWO_TAP_SLOP)) {
      twoTapDone = true;                      // the OTHER finger's up must not re-open it
      twoTapStart = 0;
      if (gesture) endGesture();              // neither finger commits a (zero-delta) drag
      contextMenuAt((pts[0]!.x + pts[1]!.x) / 2, (pts[0]!.y + pts[1]!.y) / 2, false);
    }
    touchPts.delete(e.pointerId);
    if (!touchPts.size) { twoTapStart = 0; twoTapDone = false; }
  }

  // Pen-DRAW placement and armed-CREATE, factored out so BOTH the in-frame handler
  // (onCanvasPointerDown, bound to canvasEl) and the off-frame handler
  // (onBackdropPointerDown, bound to the stage) share one implementation. The frame is
  // canvasEl's own hit box, so without this a click on the empty stage OUTSIDE the frame
  // never reaches the pen/create logic — you couldn't start a node or add an object off
  // the artboard even though clientToNative maps such points fine and the gesture, once
  // begun, already captures the pointer anywhere. Each returns true when it handled the
  // event (the caller then stops propagation).
  function tryPenDrawAt(e: PointerEvent, nat: Point): boolean {
    if (mode !== 'pen') return false;
    const tol = penTol();
    if (penDraft && closesOnClick(penDraft.nodes, nat.x, nat.y, tol)) {
      penDraft = { ...penDraft, closed: true };
      penFinishDraw();
      return true;
    }
    let px = nat.x, py = nat.y;
    if (gridOn && !e.altKey) { px = gridRound(px); py = gridRound(py); }
    const snap = snapPoint(px, py, otherAABBs(getBoxes(), new Set<number>()) as MathAABB[], canvasWH(), snapThreshNative());
    drawGuides(snap.guides);
    penPlaceNode(e, { x: snap.x, y: snap.y }, e.altKey);
    return true;
  }
  function tryArmedCreateAt(e: PointerEvent, nat: Point): boolean {
    if (!armedKind) return false;
    beginGesture(e, { type: 'create', origin: nat, seed: armedKind.seed || {}, others: otherAABBs(getBoxes(), new Set<number>()) });
    rubber.hidden = false;
    return true;
  }
  // Line tool press: start a line at the pressed point. The drag previews the rubber;
  // release commits a two-node path box (see onGestureEnd). Snapped and grid-rounded the
  // same way a pen node and a created box are, so a line lands on the guides the rest of
  // the editor draws. Alt opts out of both, exactly as it does for the pen.
  function tryLineDrawAt(e: PointerEvent, nat: Point): boolean {
    if (mode !== 'line' || !cfg.pathField) return false;
    const at = lineSnap(nat, e.altKey);
    beginGesture(e, { type: 'line', origin: at });
    drawLineRubber(at, at);
    return true;
  }
  /** A line endpoint's landing spot: grid first (when the grid is on), then the smart
   *  guides, whose guide lines are drawn as a side effect — the same order tryPenDrawAt
   *  uses, so the two gestures agree about where "here" is. */
  function lineSnap(nat: Point, alt: boolean): Point {
    let px = nat.x, py = nat.y;
    if (gridOn && !alt) { px = gridRound(px); py = gridRound(py); }
    if (alt) { clearGuides(); return { x: px, y: py }; }
    const snap = snapPoint(px, py, otherAABBs(getBoxes(), new Set<number>()) as MathAABB[], canvasWH(), snapThreshNative());
    drawGuides(snap.guides);
    return { x: snap.x, y: snap.y };
  }

  function onCanvasPointerDown(e: PointerEvent): void {
    if (e.button > 0) return;                 // primary button / touch only
    // A second finger belongs to a stage gesture (pan / pinch / two-finger tap), never to
    // a box drag — and the first finger's gesture is abandoned so no drag commits.
    if (e.pointerType !== 'mouse' && touchPts.size > 1) {
      // A node the FIRST finger placed is retracted, not just abandoned: the create gesture
      // above commits nothing until release, but a pen node is already in the draft, and a
      // two-finger pan must not litter the shape being drawn with the point it started on.
      if (gesture?.type === 'pendraw') { endGesture(); penUndoNode(); return; }
      if (gesture) endGesture();
      return;
    }
    if (editing) {
      if (editing.el.contains(e.target as Node)) return;   // let the caret move within the text
      commitTextEdit();                            // clicked elsewhere → commit, then select
    }
    closePopover();
    const nat = clientToNative(e.clientX, e.clientY);
    const boxes = getBoxes();

    // Line tool: press starts a line (drag → release attaches to a card or floats free).
    if (tryLineDrawAt(e, nat)) { e.stopPropagation(); e.preventDefault(); return; }

    // Pen — DRAWING. Click places a node; the drag that follows pulls its handles out
    // symmetrically; a click on the first node closes the path. Nothing about the box
    // selection model runs here, which is why Alt is free to mean "corner". Shared with
    // the off-frame handler so a path can be started/extended outside the artboard.
    if (tryPenDrawAt(e, nat)) { e.stopPropagation(); e.preventDefault(); return; }

    // Pen — NODE EDITING. Handles first (smaller, and outside the curve), then nodes, then
    // the curve itself (a click on it inserts), and only then a marquee over the nodes.
    if (penEdit) {
      const fr = penEdit.frame;
      const loc = frameToLocal(fr, nat.x, nat.y);
      const tol = penTol();
      const hh = penHandleAt(loc.x, loc.y, tol);
      if (hh) {
        const key = `${hh.index}:${hh.which}`;
        // Shift/⌘-click a control point TOGGLES it into the point selection (for align /
        // distribute) rather than dragging it — the handle equivalent of shift-clicking a
        // node. A plain click drags it (a direct edit), and clears any point selection.
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          penHandleSel.has(key) ? penHandleSel.delete(key) : penHandleSel.add(key);
          ctxSelKey = null;
          renderChrome();
          e.stopPropagation(); e.preventDefault();
          return;
        }
        penHandleSel = new Set<string>();
        setPathSvgHidden(true);
        beginGesture(e, { type: 'penhandle', origin: nat, index: hh.index, which: hh.which });
        e.stopPropagation(); e.preventDefault();
        return;
      }
      const ni = nodeAt(penEdit.path, loc.x, loc.y, tol);
      if (ni >= 0) {
        if (e.shiftKey || e.metaKey || e.ctrlKey) { penSel.has(ni) ? penSel.delete(ni) : penSel.add(ni); }
        else if (!penSel.has(ni)) { penSel = new Set([ni]); penHandleSel = new Set<string>(); }
        setPathSvgHidden(true);
        const indices = penSel.size ? [...penSel] : [ni];
        beginGesture(e, {
          type: 'pennode', origin: nat,
          indices,
          start: penEdit.path.nodes.map((n) => ({ ...n })),
          // plan 96 P3: dragging exactly ONE of the path's two ends is the bind gesture.
          // Two nodes at once is a reshape, and an interior node has no end to attach.
          bindEnd: bindEndFor(indices),
        });
        ctxSelKey = null;                        // the continuity control reflects the new pick
        renderChrome();
        e.stopPropagation(); e.preventDefault();
        return;
      }
      // Is the click on ANY contour's curve? Lower each on its own (lowering the combined run
      // as one path would draw — and hit — a phantom segment joining one glyph to the next),
      // and take the nearest across all. penInsertAt then reshapes whichever contour that was.
      const contours = penContours();
      let hitD = Infinity;
      for (const p of contours) {
        const low = lowerAuthored(p, contours.length === 1 ? penWarm : null);
        const h = low.cubics.length ? nearestOnPath(low.cubics, loc.x, loc.y) : null;
        if (h && h.distance < hitD) hitD = h.distance;
      }
      if (hitD <= PEN_CURVE_PX / penScale()) {
        penInsertAt(loc.x, loc.y);
        e.stopPropagation(); e.preventDefault();
        return;
      }
      beginGesture(e, { type: 'penmarquee', origin: nat, additive: e.shiftKey || e.metaKey });
      rubber.hidden = false;
      e.stopPropagation(); e.preventDefault();
      return;
    }

    if (tryArmedCreateAt(e, nat)) { e.stopPropagation(); e.preventDefault(); return; }

    // Node tool: a click on a PATH box jumps straight into editing its nodes (the click
    // that would otherwise just select it). Non-path boxes fall through to normal select,
    // so the tool doesn't trap you on a shape it can't edit. Runs only when no node-edit
    // session is live (that case is handled by the penEdit block above).
    if (nodeToolActive && vectorCfg && !penEdit) {
      const nh = pickTopmost(boxes, nat.x, nat.y, cfg, seqHiddenSkip(boxes));
      if (nh >= 0 && boxOutlineKind(boxes[nh], vectorCfg) === 'path') {
        startPenEdit(idOf(boxes[nh], nh));
        e.stopPropagation(); e.preventDefault();
        return;
      }
    }

    const hit = selectHit(boxes, nat.x, nat.y);    // artboard-aware: a child over a frame wins; the frame takes an empty-area/edge click
    if (hit >= 0) {
      deselectEdge();                              // picking a card drops any connector selection
      const id = idOf(boxes[hit], hit);
      const additive = e.shiftKey || e.metaKey || e.ctrlKey || multiTapMode;
      const hitSel = selectionForHit(boxes, hit, e.altKey);   // whole group, or Alt = just this box
      if (additive) {
        const anyIn = hitSel.some((x) => selection.has(x));
        for (const x of hitSel) anyIn ? selection.delete(x) : selection.add(x);
      } else if (!selection.has(id)) {
        selection = new Set(hitSel);
      }
      renderChrome();
      // Start a move for the whole current selection.
      const start = new Map<number, Rect>();
      const sel = selIndices(boxes);
      for (const i of sel) start.set(i, boxRect(boxes[i], cfg));
      beginGesture(e, {
        type: 'move', start, sel,
        selAABB: selectionAABB(boxes, sel, cfg),
        others: otherAABBs(boxes, new Set(sel)),
      });
      e.stopPropagation();
      return;
    }

    // No card under the pointer — try a connector line (they render behind the cards).
    if (connectCfg) {
      const eid = edgeAt(nat.x, nat.y);
      if (eid) { selectEdge(eid, e.shiftKey || e.metaKey || e.ctrlKey); e.stopPropagation(); return; }
    }
    deselectEdge();   // clicked empty → drop any connector selection

    // Empty canvas.
    if (e.pointerType === 'mouse') {
      beginGesture(e, { type: 'marquee', origin: nat, additive: e.shiftKey || e.metaKey });
      rubber.hidden = false;
      e.stopPropagation();
    } else {
      // Let stageNav own touch pan/pinch on empty canvas; arm a tap-to-deselect.
      gesture = { type: 'tap', pointerId: e.pointerId, startClient: { x: e.clientX, y: e.clientY } };
    }
  }

  // Clicking the stage/view backdrop OUTSIDE the artboard deselects, just like clicking the
  // empty canvas inside it (onCanvasPointerDown is bound to canvasEl, so those clicks never
  // reached it). Guarded to a DIRECT hit on the backdrop element (target === currentTarget)
  // so a bubbled event from a box, toolbar, popover or the canvas never triggers it. Doesn't
  // stopPropagation, so stageNav's pan on a backdrop drag is unaffected.
  function onBackdropPointerDown(e: PointerEvent): void {
    if (e.button > 0 || e.target !== e.currentTarget) return;
    if (editing) commitTextEdit();
    // Off-frame click while DRAWING places/extends a node (not "finish"), and off-frame
    // click while an Add is armed starts the create — the same as inside the artboard, so
    // the whole stage is usable, not just the export frame. These come FIRST, before the
    // "clicking off the artboard means I'm done" fallbacks below.
    const natBd = clientToNative(e.clientX, e.clientY);
    if (tryPenDrawAt(e, natBd)) { e.stopPropagation(); e.preventDefault(); return; }
    if (tryArmedCreateAt(e, natBd)) { e.stopPropagation(); e.preventDefault(); return; }
    if (tryLineDrawAt(e, natBd)) { e.stopPropagation(); e.preventDefault(); return; }
    // Clicking right off the artboard is the natural "I'm done" for a node-edit session,
    // and it matches what the same click already does to a selection. (A pen DRAFT is no
    // longer finished here — an off-frame click extends it, handled above.)
    if (penEdit) { endPenEdit(); return; }
    closePopover();
    deselectEdge();
    // A SHIFT/⌘ drag is additive, so it must not wipe what is already selected — same
    // rule the in-artboard marquee follows.
    const additive = e.shiftKey || e.metaKey;
    if (selection.size && !additive) selection = new Set<string>();
    renderChrome();
    // …and a plain left-drag out here MARQUEES, exactly as it does over the artboard.
    // Nothing claimed that gesture before: stageNav pans on middle-drag or Space+drag
    // and lets plain left-clicks through, while the marquee lived on canvasEl — so a
    // left-drag on the backdrop fell between the two and did nothing at all, which is
    // what made the whole area outside the artboard feel inert.
    // Touch is left alone: stageNav owns one-finger pan there, as it does inside.
    if (e.pointerType !== 'mouse' || spacePan) return;
    beginGesture(e, { type: 'marquee', origin: clientToNative(e.clientX, e.clientY), additive });
    rubber.hidden = false;
    // The gesture captures the pointer on canvasEl, so the move/up handlers bound there
    // keep receiving it even though the drag started outside.
  }

  /** Right-click on the backdrop opens the SAME menu as right-click on empty artboard —
   *  guarded to a direct hit so a bubbled event from a box or the toolbar can't reach it. */
  function onBackdropContextMenu(e: MouseEvent): void {
    if (e.target !== e.currentTarget) return;
    onContextMenu(e);
  }

  /** Space is stageNav's pan modifier (Space+left-drag). Tracked here only so the
   *  backdrop marquee yields to it — stageNav owns the pan and exposes no state. */
  let spacePan = false;
  function onSpaceKey(e: KeyboardEvent): void {
    if (e.code === 'Space' && !isTypingTarget()) spacePan = e.type === 'keydown';
  }

  // pointermove fires far faster than paint (60–120 Hz); coalesce to one rAF per frame so
  // the heavy path (snap + live rects + connector redraw) runs at most once per paint.
  let pendingMove: PointerEvent | null = null;
  let moveRaf = 0;
  function onGestureMove(e: PointerEvent): void {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    if (gesture.type === 'tap') return;       // stageNav owns it; only checked on up
    e.preventDefault();                        // must be synchronous to suppress scroll/text-select
    pendingMove = e;
    if (!moveRaf) moveRaf = requestAnimationFrame(flushGestureMove);
  }
  function flushGestureMove(): void {
    moveRaf = 0;
    const e = pendingMove; pendingMove = null;
    if (e) applyGestureMove(e);
  }
  function applyGestureMove(e: PointerEvent): void {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const nat = clientToNative(e.clientX, e.clientY);
    const dxN = nat.x - (gesture.origin?.x ?? clientToNative(gesture.startClient.x, gesture.startClient.y).x);
    const dyN = nat.y - (gesture.origin?.y ?? clientToNative(gesture.startClient.x, gesture.startClient.y).y);

    if (gesture.type === 'marquee' || gesture.type === 'penmarquee') {
      drawRubber(gesture.origin, nat);
      return;
    }
    // Pen: pull the just-placed node's handles out, the universal click-and-drag idiom.
    // Symmetrically by default; Alt BREAKS the pair and steers only the outgoing arm, which
    // is the gesture tracing lives on — it is how a curve turns a corner into a new curve
    // without giving up the one already drawn. Alt with no drag still places a hard corner,
    // because the break only takes effect past `PEN_PULL_MIN`.
    if (gesture.type === 'pendraw') {
      if (!penDraft) return;
      const i = gesture.index;
      const n = penDraft.nodes[i];
      if (!n) return;
      const pulled = Math.hypot(nat.x - gesture.origin.x, nat.y - gesture.origin.y) > PEN_PULL_MIN / penScale();
      // A click-DRAG is the Bézier idiom: it names a direction AND a length. `hyperbezier`
      // can only honour the direction, and only within a right angle of its chord — past
      // that `hbArm`'s signed shape function puts the control arm on the far side of the
      // node, so the curve leaves in the OPPOSITE direction to the drag, and approaching
      // 90° the arm collapses to zero so the drag stops mattering at all. That is
      // deliberate in the solver (see `hbArm`'s comment: clamping costs convergence), so
      // the fix belongs here: the first real pull promotes the draft to `cubic`, whose
      // lowering honours the handle exactly. The bake is lossless (see `convertKind`), so
      // the shape drawn so far does not move, and the kind pill flips to say what happened.
      if (penDraft.kind === 'hyperbezier' && pulled) {
        penDraft = convertKind(penDraft, 'cubic', penWarm).path;
        penWarm = null;
        announce(t('Switched to Bezier handles - this curve kind honours the handle you drag.'));
        renderChrome();
      }
      const nodes = penDraft.nodes.slice();
      const cur = nodes[i] ?? n;   // re-read: the promotion above rebuilds the node array
      const dx = nat.x - gesture.origin.x, dy = nat.y - gesture.origin.y;
      const at = { ...cur, x: gesture.origin.x, y: gesture.origin.y };
      // Whichever branch runs owns the node's continuity outright: `pullHandles` refuses a
      // `corner` node, and `defaultContinuity` is `'corner'` for every kind except
      // `hyperbezier` — so without this a click-drag in a `cubic` draft silently did nothing.
      // Breaking keeps `hIn` exactly where it is: on the first broken frame that is the arm
      // the bake left holding the segment already drawn, so "keep what is behind me, aim what
      // is ahead" needs no recomputation.
      if (e.altKey) penPullBroken = true;
      nodes[i] = !pulled ? at
        : penPullBroken ? { ...at, continuity: 'corner', hOutX: dx, hOutY: dy }
        : pullHandles({ ...at, continuity: 'smooth' }, dx, dy);
      penDraft = { ...penDraft, nodes };
      paintPen();
      positionPenChrome();
      return;
    }
    if (gesture.type === 'pennode') {
      if (!penEdit) return;
      // The pointer snaps against sibling boxes and the artboard exactly as a create/resize
      // drag does — same helper, same `.fc-guides` layer, Alt suppresses it — so a node can
      // be landed on a neighbour's edge without a second snapping system existing.
      let sx = nat.x, sy = nat.y;
      if (!e.altKey) {
        if (gridOn) { sx = gridRound(sx); sy = gridRound(sy); }
        const snap = snapPoint(sx, sy, otherAABBs(getBoxes(), new Set([indexOfId(getBoxes(), penEdit.id)])) as MathAABB[], canvasWH(), snapThreshNative());
        sx = snap.x; sy = snap.y;
        drawGuides(snap.guides);
      } else clearGuides();
      const fr = penEdit.frame;
      const a = frameToLocal(fr, gesture.origin.x, gesture.origin.y);
      const b = frameToLocal(fr, sx, sy);
      gesture.moved = Math.hypot(sx - gesture.origin.x, sy - gesture.origin.y) > 0.01;
      penEdit = { ...penEdit, path: moveNodes(penEdit.path, gesture.indices, b.x - a.x, b.y - a.y, gesture.start) };
      // plan 96 P3 — the bind affordance. The ring follows the pointer, not the node: the
      // node is under the finger and the box is what the drop acts on.
      if (gesture.bindEnd) setBindHover(bindableAt(sx, sy, penEdit.id));
      paintPen();
      positionPenChrome();
      return;
    }
    if (gesture.type === 'penhandle') {
      if (!penEdit) return;
      // No snapping: a handle is not an object edge, so an alignment guide would be a lie.
      // `dragHandle` re-applies the node's continuity on EVERY move, which is what
      // `enforceContinuity` exists for.
      const loc = frameToLocal(penEdit.frame, nat.x, nat.y);
      gesture.moved = true;
      penEdit = { ...penEdit, path: dragHandle(penEdit.path, gesture.index, gesture.which, loc.x, loc.y) };
      paintPen();
      positionPenChrome();
      return;
    }
    if (gesture.type === 'create') {
      let px = nat.x, py = nat.y;
      if (gridOn && !e.altKey) { px = gridRound(px); py = gridRound(py); }   // land on grid
      const snap = snapPoint(px, py, gesture.others as MathAABB[], canvasWH(), snapThreshNative());
      const corner = { x: snap.x, y: snap.y };
      drawGuides(snap.guides);
      gesture.corner = corner;
      drawRubber(gesture.origin, corner);
      return;
    }
    if (gesture.type === 'line') {
      const to = lineSnap(nat, e.altKey);
      gesture.to = to;
      drawLineRubber(gesture.origin, to);
      return;
    }
    if (gesture.type === 'move') {
      let mdx = dxN, mdy = dyN;
      if (gesture.selAABB && !e.altKey) {
        // Smart guides win: snap the RAW drag to any sibling/artboard edge or centre
        // first, so dragging a card onto another's vertical/horizontal line locks it
        // into alignment (even off-grid). The grid then only rounds whichever axis
        // did NOT catch a guide, so cards stay tidy without fighting alignment.
        const cand = {
          minX: gesture.selAABB.minX + dxN, minY: gesture.selAABB.minY + dyN,
          maxX: gesture.selAABB.maxX + dxN, maxY: gesture.selAABB.maxY + dyN,
        };
        const snap = snapMove(cand as MathAABB, gesture.others as MathAABB[], canvasWH(), snapThreshNative());
        mdx = dxN + snap.dx; mdy = dyN + snap.dy;
        if (gridOn) {
          const xAligned = snap.guides.some((g) => g.x1 === g.x2);   // a vertical guide → x is aligned
          const yAligned = snap.guides.some((g) => g.y1 === g.y2);   // a horizontal guide → y is aligned
          if (!xAligned) mdx = gridRound(gesture.selAABB.minX + dxN) - gesture.selAABB.minX;
          if (!yAligned) mdy = gridRound(gesture.selAABB.minY + dyN) - gesture.selAABB.minY;
        }
        drawGuides(snap.guides);
      } else clearGuides();
      gesture.moveDelta = { dx: mdx, dy: mdy };
      for (const [i, r] of gesture.start) applyLiveRect(i, { ...r, x: r.x + mdx, y: r.y + mdy });
      renderChromeLive();
      liveConnUpdate();
      return;
    }
    if (gesture.type === 'resize') {
      let sdx = dxN, sdy = dyN;
      if ((gesture.startRect.rot || 0) === 0 && !e.altKey) {
        let px = nat.x, py = nat.y;
        if (gridOn) { px = gridRound(px); py = gridRound(py); }
        const snap = snapPoint(px, py, gesture.others as MathAABB[], canvasWH(), snapThreshNative());
        sdx += snap.x - nat.x; sdy += snap.y - nat.y;
        drawGuides(snap.guides);
      } else clearGuides();
      // A circle stays a circle: lock its aspect (1:1) through the resize, as if Shift
      // were held. Its startRect is already square, so any handle keeps w === h.
      const nr = resizeRect(gesture.startRect, gesture.handle, sdx, sdy, {
        minSize, keepAspect: e.shiftKey || isCircle(getBoxes()[gesture.index]), fromCentre: e.altKey,
      });
      applyLiveRect(gesture.index, { ...nr, rot: gesture.startRect.rot });
      gesture.liveRect = { ...nr, rot: gesture.startRect.rot };
      renderChromeLive();
      liveConnUpdate();
      return;
    }
    if (gesture.type === 'rotate') {
      const c = gesture.centerClient;
      let deg = Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180 / Math.PI - gesture.pointerStartDeg + gesture.startRect.rot!;
      deg = normAngle(deg);                       // keep stored rotation in [-180, 180)
      if (!e.altKey) deg = snapAngle(deg, 15, 4);
      const live = { ...gesture.startRect, rot: deg };
      applyLiveRect(gesture.index, live);
      gesture.liveRect = live;
      renderChromeLive();
      return;
    }
    if (gesture.type === 'gscale') {
      const k = Math.hypot(nat.x - gesture.anchor.x, nat.y - gesture.anchor.y) / gesture.origDist;
      const next = scaleGroup(gesture.startBoxes, gesture.sel, gesture.anchor, k, cfg, { minSize });
      for (const i of gesture.sel) applyLiveRect(i, boxRect(next[i], cfg));
      gesture.liveBoxes = next;
      renderChromeLive();
      liveConnUpdate();
      return;
    }
    if (gesture.type === 'grotate') {
      const c = gesture.centerClient;
      let deg = Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180 / Math.PI - gesture.pointerStartDeg;
      if (!e.altKey) deg = snapAngle(deg, 15, 4);
      const next = rotateGroup(gesture.startBoxes, gesture.sel, gesture.centre, deg, cfg);
      for (const i of gesture.sel) applyLiveRect(i, boxRect(next[i], cfg));
      gesture.liveBoxes = next;
      renderChromeLive();
      liveConnUpdate();
      return;
    }
  }

  function onGestureEnd(e: PointerEvent): void {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const g = gesture;
    // Apply any pending (coalesced) move first so the drop commits the final pointer
    // position, then drop the scheduled frame.
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
    if (pendingMove) { const pe = pendingMove; pendingMove = null; applyGestureMove(pe); }
    try { canvasEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    endLiveConnectors();   // restore the tool's committed connector layer after a drag

    if (g.type === 'tap') {
      const moved = Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y);
      if (moved < 6) { selection = new Set<string>(); toPointer(); renderChrome(); }
      gesture = null;
      return;
    }

    const nat = clientToNative(e.clientX, e.clientY);
    if (g.type === 'line') {
      const moved = Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y);
      const to = g.to ?? lineSnap(nat, e.altKey);
      endGesture();
      hideConnectLayer();
      clearGuides();
      // A tap is a mis-click, and a zero-length line is not a shape: neither commits — the
      // same floor `penFinishDraw` puts under a one-node draft.
      if (moved < 6 || (Math.abs(to.x - g.origin.x) < 0.5 && Math.abs(to.y - g.origin.y) < 0.5)) { toPointer(); return; }
      commitPathBox({
        kind: 'line', closed: false,
        nodes: [{ x: g.origin.x, y: g.origin.y, continuity: 'corner' }, { x: to.x, y: to.y, continuity: 'corner' }],
      }, lineBoxSeed());
      toPointer();
      return;
    }
    const boxes = getBoxes();

    // Pen: placing a node commits NOTHING — the draft is a draft until the path ends, which
    // is what makes the whole drawing one undo step (see `penFinishDraw`).
    if (g.type === 'pendraw') {
      endGesture();
      penCursor = nat;
      paintPen();
      syncPenChrome();
      penCtxBar();
      return;
    }
    if (g.type === 'pennode' || g.type === 'penhandle') {
      const moved = g.moved === true;
      const next = penEdit ? penEdit.path : null;
      // plan 96 P3 — landing an end node ON a box attaches it; landing it anywhere else
      // detaches it. Read BEFORE endGesture(), which clears the hover.
      const bindTo = g.type === 'pennode' && g.bindEnd && moved
        ? { which: g.bindEnd, id: bindHover ?? '' } : null;
      const editId = penEdit?.id ?? '';
      setPathSvgHidden(false);
      setBindHover(null);
      endGesture();
      if (moved && next) penEditWrite(next);
      else renderChrome();
      if (bindTo && editId) applyBinding(editId, bindTo.which, bindTo.id);
      return;
    }
    if (g.type === 'penmarquee') {
      const moved = Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y);
      if (penEdit) {
        if (moved < 6) {
          if (!g.additive) { penSel = new Set<number>(); penHandleSel = new Set<string>(); }
        } else {
          const r = normDragRect(g.origin.x, g.origin.y, nat.x, nat.y, 0);
          const inR = (p: Point): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
          const pts = penNodePoints();
          const nodeHits = pts.reduce<number[]>((acc, pt, i) => (inR(pt.at) ? (acc.push(i), acc) : acc), []);
          // In "nodes + control points" mode, a marquee also grabs any handle whose point
          // falls in the box — the direct-selection behaviour Illustrator/Inkscape users
          // expect. Nodes-only mode (the default) leaves handles alone.
          const handleHits: string[] = [];
          if (penSelectHandles && penEdit && kindReadsHandles(penEdit.path.kind)) {
            pts.forEach((pt, i) => {
              if (pt.hIn && inR(pt.hIn)) handleHits.push(`${i}:in`);
              if (pt.hOut && inR(pt.hOut)) handleHits.push(`${i}:out`);
            });
          }
          if (g.additive) { for (const i of nodeHits) penSel.add(i); for (const k of handleHits) penHandleSel.add(k); }
          else { penSel = new Set(nodeHits); penHandleSel = new Set(handleHits); }
        }
      }
      endGesture();
      ctxSelKey = null;
      renderChrome();
      return;
    }

    if (g.type === 'create') {
      const moved = Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y);
      // A circle seed must be born square (seedBox takes its geometry from the drawn
      // rect, not the seed's w/h), so a tap uses one default diameter and a drag squares
      // to its smaller side (anchored at the drag's top-left).
      const circleSeed = cfg.shapeField && String(g.seed?.[cfg.shapeField]) === 'circle';
      let rect: Rect;
      if (moved < 6) {
        // A tap (no drag) drops a default-sized box centred on the point.
        const w = circleSeed ? 400 : 320, h = circleSeed ? 400 : 200;
        rect = { x: g.origin.x - w / 2, y: g.origin.y - h / 2, w, h };
      } else {
        const c = g.corner || nat;
        rect = normDragRect(g.origin.x, g.origin.y, c.x, c.y, minSize);
        if (circleSeed) { const s = Math.max(minSize, Math.min(rect.w, rect.h)); rect = { x: rect.x, y: rect.y, w: s, h: s }; }
      }
      const id = freshId(boxes);
      let box = seedBox(cfg, {}, g.seed, rect as MathRect, id);
      box = clampBoxToCanvas(box, cfg, canvasWH());
      if (gridOn && !e.altKey) box = { ...box, [cfg.xField]: gridRound(num(box[cfg.xField], 0)), [cfg.yField]: gridRound(num(box[cfg.yField], 0)) };
      selection = new Set([id]);
      // The Animation and Video add-kinds both seed kind:'image' (they render through
      // the image field), so they also match wasImage — check them FIRST and open the
      // type-constrained picker instead of the general image one.
      const wasLottie = armedKind?.id === 'lottie';
      const wasVideo = armedKind?.id === 'video';
      // Sequence Studio's kinds. `clip` seeds kind:'image' too, so — like Animation and
      // Video — it must be recognised BEFORE wasImage or it would open the general image
      // picker. `tool` also seeds kind:'image', and it still opens the UNTYPED picker —
      // that is where the Lolly-link / saved-session path lives, and the picker is
      // already handed `editTool` so a chosen tool opens its inputs first — but it asks
      // for the Tools pane, so the tool grid is what the user lands on. Same idea as the
      // typed kinds above: the pane matches the kind that was added.
      // `card` seeds kind:'box' and takes no asset at all — it is authored like text.
      // An add-kind id this switch doesn't know keeps its seed-derived behaviour.
      const wasClip = armedKind?.id === 'clip';
      const wasAudio = armedKind?.id === 'audio' || g.seed?.[cfg.kindField] === 'audio';
      const wasCard = armedKind?.id === 'card';
      const wasTool = armedKind?.id === 'tool';
      const wasImage = !wasLottie && !wasVideo && !wasClip && !wasAudio && !wasTool
        && ((g.seed?.[cfg.kindField] === 'image') || armedKind?.id === 'image');
      const wasText = (g.seed?.[cfg.kindField] === 'text') || armedKind?.id === 'text' || wasCard;
      // Read BEFORE toPointer(): exitCreate clears the pending time with the armed kind.
      const addAtMs = pendingAddAtMs;
      toPointer();                  // the gesture consumed the armed kind — back to the pointer
      endGesture();
      // Containment-on-create: the new box lands in whatever frame its centre falls in
      // (dead unless frameCfg). It is the last element of the array, so index boxes.length.
      commit(assignFrames([...boxes, box], new Set([boxes.length])));
      // Added from the timeline, so it lands TIMED at the playhead instead of as scenery
      // (the rail's plus keeps that default). The panel's promote() owns the write — one
      // commit through moveOverlay + setDuration — so no timing arithmetic lives here.
      // `dur: null` is deliberate and load-shifting: this box was created a moment ago
      // and its asset picker has not even opened, so nothing on the canvas knows how long
      // its media is. Authoring a length HERE would pin a 45s audio track to 3s and would
      // overwrite the `card` kind's own seeded 2.5s. Unauthored, the seq pack derives it
      // from the media and an overlay runs to the sequence end — same as a canvas add.
      if (addAtMs != null) timelinePanel?.promote(id, { start: addAtMs / 1000, dur: null });
      // A new timed box is only useful next to a timeline, so creating one opens it.
      if (timeCfg && (wasClip || wasCard || wasAudio)) openTimeline();
      if (wasLottie) setTimeout(() => pickImage({ pickType: 'lottie', initialTab: 'library' }), 0);
      else if (wasVideo || wasClip) setTimeout(() => pickImage({ pickType: 'video', initialTab: 'library' }), 0);
      else if (wasAudio) setTimeout(() => pickImage({ pickType: 'audio', initialTab: 'library' }), 0);
      else if (wasTool) setTimeout(() => pickImage({ initialTab: 'tools' }), 0);
      else if (wasImage) setTimeout(() => pickImage({ initialTab: 'library' }), 0);
      else if (wasText && cfg.textField) editAfterPaint(id, { selectAll: true });
      return;
    }
    if (g.type === 'marquee') {
      const moved = Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y);
      if (moved < 6) { selection = new Set<string>(); deselectEdge(); }
      else {
        // A marquee grabs cards AND any connector lines it crosses — a mixed selection
        // (card handles + the connector panel editing every selected line at once).
        const rect = normDragRect(g.origin.x, g.origin.y, nat.x, nat.y, 0);
        const hits = pickMarquee(boxes, rect, cfg, seqHiddenSkip(boxes)).map((i: number) => idOf(boxes[i], i));
        const edgeHits = edgesInRect(rect);
        if (g.additive) {
          for (const id of hits) selection.add(id);
          for (const id of edgeHits) selectedEdges.add(id);
        } else {
          selection = new Set(hits);
          selectedEdges = new Set(edgeHits);
        }
        if (selectedEdges.size) setHoverEdge(null);
      }
      endGesture();
      renderChrome();                                  // card chrome + edge highlights (via renderChrome)
      if (selectedEdges.size) openEdgePanel(); else closeEdgePanel();
      return;
    }
    if (g.type === 'move') {
      const d = g.moveDelta || { dx: 0, dy: 0 };
      const sel = g.sel;
      endGesture();
      // Containment-on-drop: the moved boxes re-bucket into the frame their centre now
      // lands in. moveBoxes preserves index order, so g.sel indices stay valid.
      if (Math.abs(d.dx) > 0.5 || Math.abs(d.dy) > 0.5) commit(assignFrames(cascadeFrameChildren(boxes, moveBoxes(boxes, [...sel], d.dx, d.dy, cfg), sel), new Set(sel)));
      else renderChrome();
      return;
    }
    if (g.type === 'resize' || g.type === 'rotate') {
      const live = g.liveRect || g.startRect;
      const idx = g.index;
      endGesture();
      // Containment-on-resize: a resize/rotate can move the box's centre across a frame
      // edge, so re-bucket the single edited box.
      commit(assignFrames(boxes.map((b, i) => (i === idx ? withRect(b, live, cfg) : b)), new Set([idx])));
      return;
    }
    if (g.type === 'gscale' || g.type === 'grotate') {
      const next = g.liveBoxes;
      const sel = g.sel;
      endGesture();
      // Containment-on-group-transform: every scaled/rotated box re-buckets. g.liveBoxes
      // is a full index-aligned array, so g.sel indices stay valid.
      if (next) commit(assignFrames(cascadeFrameChildren(boxes, next, sel), new Set(sel))); else renderChrome();
      return;
    }
    endGesture();
  }

  // Apply a rect to a live box DOM element during a gesture (no model write).
  function applyLiveRect(index: number, r: Rect): void {
    const boxes = getBoxes();
    const id = idOf(boxes[index], index);
    const el = canvasEl.querySelector<HTMLElement>(`.lolly-box[data-box-id="${cssEscape(id)}"]`);
    if (!el) return;
    // r is in GLOBAL native coords; the element positions relative to its page frame.
    const fo = frameOffsetOfEl(el);
    el.style.left = Math.round(r.x - fo.x) + 'px';
    el.style.top = Math.round(r.y - fo.y) + 'px';
    el.style.width = Math.max(1, Math.round(r.w)) + 'px';
    el.style.height = Math.max(1, Math.round(r.h)) + 'px';
    el.style.transform = r.rot ? `rotate(${(Math.round(r.rot * 10) / 10)}deg)` : '';
    // Multi-page: a box dragged toward a higher-index page spills (unclipped) into that
    // page's rectangle, but the later frame's opaque background paints OVER it (same
    // stacking context, tree order). A positive z-index hoists the live box above every
    // later frame for the duration of the drag; endGesture clears it (and the next paint
    // rebuilds the element clean). No-op for single-page editors (Layout Studio).
    if (pages || frameCfg) el.style.zIndex = '9999';
  }

  function drawRubber(origin: Point, nat: Point): void {
    const a = nativeToStage(Math.min(origin.x, nat.x), Math.min(origin.y, nat.y));
    const { scale } = metrics();
    rubber.style.left = a.x + 'px';
    rubber.style.top = a.y + 'px';
    rubber.style.width = Math.abs(nat.x - origin.x) * scale + 'px';
    rubber.style.height = Math.abs(nat.y - origin.y) * scale + 'px';
  }

  // ── handle interactions ──────────────────────────────────────────────────────
  function onHandlePointerDown(e: PointerEvent, handle: HandleName | 'rotate'): void {
    e.stopPropagation();
    if (e.button > 0) return;
    const boxes = getBoxes();
    const idx = selIndices(boxes);
    if (idx.length !== 1) return;
    const index = idx[0]!;
    const startRect = boxRect(boxes[index], cfg);
    if (handle === 'rotate') {
      const m = metrics();
      const c = rectCentre(startRect);
      const cs = nativeToStage(c.x, c.y, m);
      const centerClient = { x: cs.x + m.sr.left, y: cs.y + m.sr.top };
      const pointerStartDeg = Math.atan2(e.clientY - centerClient.y, e.clientX - centerClient.x) * 180 / Math.PI;
      beginGesture(e, { type: 'rotate', index, startRect, centerClient, pointerStartDeg });
    } else {
      beginGesture(e, { type: 'resize', index, handle, startRect, others: otherAABBs(boxes, new Set([index])) });
    }
  }

  // AABBs of every box NOT in `exclude` (snap targets), + the snap threshold in
  // native px (a fixed SCREEN distance regardless of zoom).
  function otherAABBs(boxes: Box[], exclude: Set<number>): AABB[] {
    const out: AABB[] = [];
    for (let i = 0; i < boxes.length; i++) if (!exclude.has(i)) out.push(boxAABB(boxes[i], cfg));
    return out;
  }
  const snapThreshNative = (): number => SNAP_PX / (metrics().scale || 1);

  function drawGuides(list: any[] | null | undefined): void {
    guidesEl.innerHTML = '';
    if (!list || !list.length) return;
    const m = metrics();
    for (const g of list) {
      const a = nativeToStage(g.x1, g.y1, m), b = nativeToStage(g.x2, g.y2, m);
      const el = document.createElement('div');
      el.className = 'fc-guide';
      el.style.left = a.x + 'px';
      el.style.top = a.y + 'px';
      el.style.width = Math.hypot(b.x - a.x, b.y - a.y) + 'px';
      el.style.transform = `rotate(${Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI}deg)`;
      guidesEl.appendChild(el);
    }
  }
  const clearGuides = (): void => { guidesEl.innerHTML = ''; };

  // ── bound paths (plan 96 P3) ──────────────────────────────────────────────────
  //
  // A path box with an end attached to another box is a CONNECTOR: connector management
  // draws it, routed from the bound box's border toward the other end. The editor's live
  // overlay reads the SAME model the tool's hook reads (bindStart/bindEnd + the decoration
  // fields) and draws it with the SAME engine call (`routedLineSvg`), so what tracks the
  // cursor during a drag is what lands in the committed render on drop.

  /** One end's binding: the id of the box it is attached to, '' for a free end. */
  const bindOf = (b: Box, which: 'start' | 'end'): string =>
    String(b[which === 'start' ? cfg.bindStartField : cfg.bindEndField] ?? '').trim();
  /** Is this box a connector? ONE binding is enough — a path pinned at one end and loose at
   *  the other still routes, from the border toward the loose point. */
  const isBoundPath = (b: Box): boolean =>
    hasBindCfg && String(b[cfg.kindField]) === 'path' && (bindOf(b, 'start') !== '' || bindOf(b, 'end') !== '');

  /**
   * A bound path as the engine's endpoint pair + decoration record, or null when it is not
   * a connector (or when a HALF-bound path's free end cannot be read — half a connector is
   * worse than none). `rectFor` resolves a box id to the rect to route from, which is the
   * LIVE DOM rect mid-drag and the model rect otherwise.
   *
   * This mirrors `boundPathRow` in the tool hooks field-for-field, deliberately: the hook
   * cannot import from the shell and the shell cannot call the hook, so the ONE thing that
   * has to be shared is the geometry, and that is `routedLineSvg`.
   */
  function boundPathParts(b: Box): { from: string; to: string; decor: Parameters<typeof routedLineSvg>[2] } | null {
    if (!isBoundPath(b)) return null;
    const bs = bindOf(b, 'start'), be = bindOf(b, 'end');
    const ends = (!bs || !be) ? pathEndsNative(b) : null;
    if ((!bs || !be) && !ends) return null;
    const contours = decodePathContours(b[cfg.pathField]);
    const sole = contours[0];
    const route = pathRouteStyle(sole ? sole.kind : '', b[cfg.routeField], sole ? sole.nodes.length : 2);
    const sw = clampN(b[cfg.strokeWField], 0, 0, 400);
    const dashKw = String(b[cfg.strokeDashField] ?? '');
    return {
      from: bs || formatEdgePoint(ends!.start.x, ends!.start.y),
      to: be || formatEdgePoint(ends!.end.x, ends!.end.y),
      decor: {
        style: route,
        headStart: String(b[cfg.headStartField] || 'none'),
        headEnd: String(b[cfg.headEndField] || 'none'),
        dash: dashKw === 'dashed' || dashKw === 'dotted' ? dashKw : 'solid',
        dashArray: parseDashText(String(b[cfg.strokeDashArrayField] ?? '')) || null,
        dashFit: boolOf(b[cfg.dashFitField], false),
        color: cAttr(String(b[cfg.strokeField] || '#64748b')),
        width: sw > 0 ? Math.min(20, Math.max(0.5, sw)) : 3,
      },
    };
  }

  /** A path box's first and last node in NATIVE canvas px. Nodes are stored normalised to
   *  the frame; rotation is ignored for the same reason the hook ignores it — a bound path
   *  is drawn between two rects and the router re-solves both ends anyway. */
  function pathEndsNative(b: Box): { start: Point; end: Point } | null {
    const contours = decodePathContours(b[cfg.pathField]);
    const ns = contours[0]?.nodes;
    if (!ns || ns.length < 2) return null;
    const r = boxRect(b, cfg);
    const w = Math.max(1, r.w), h = Math.max(1, r.h);
    const a = ns[0]!, z = ns[ns.length - 1]!;
    return {
      start: { x: r.x + a.x * w, y: r.y + a.y * h },
      end: { x: r.x + z.x * w, y: r.y + z.y * h },
    };
  }

  // ── connector preview layer ───────────────────────────────────────────────────
  // The routing math (edgeWaypoints / roundedEdgePath / smoothEdgePath / edgeBorderPt /
  // edgeNested) lives in free-canvas-math.ts so it is unit-tested (tests/connector-
  // geometry.test.ts) and stays in sync with tools/org-chart/hooks.js. Arrowheads render
  // live too (edgeArrowHead, plan 90 thread B) with the same gap + inset pullback as the
  // committed render, so nothing jumps on commit; dashes stay preview-only (throwaway
  // stroke-dasharray) since the committed layer draws real <line> segments.
  const cf2 = (v: number): number => Math.round(v * 100) / 100;
  const cAttr = (s: string): string => String(s == null ? '' : s).replace(/[<>"]/g, '');
  // Size + place a preview <svg> to cover the artboard in stage px (native viewBox), so
  // its contents can be written in native coordinates and a pan/zoom is one element move.
  function placeNativeLayer(el: SVGSVGElement, m: Metrics): void {
    const cw = canvasWH();
    const o = nativeToStage(0, 0, m);
    el.style.left = o.x + 'px';
    el.style.top = o.y + 'px';
    el.style.width = (cw.w * m.scale) + 'px';
    el.style.height = (cw.h * m.scale) + 'px';
    el.setAttribute('viewBox', `0 0 ${cw.w} ${cw.h}`);
    el.setAttribute('preserveAspectRatio', 'none');
  }
  const placeConnectLayer = (m: Metrics): void => placeNativeLayer(connectLayer, m);
  // Hide/show the tool's committed bound-path <svg> (so it doesn't double up with the
  // live preview mid-drag). Re-shown on gesture end; the commit re-renders it anyway.
  // The class is the manifest's (`canvas.pathLayerClass`) for the same reason it used to be
  // `canvas.connect.layerClass`: only a tool knows what its own hook emits.
  function setRealConnectorsHidden(hidden: boolean): void {
    const cls = connectCfg?.layerClass || boundLayerClass;
    const el = canvasEl.querySelector<HTMLElement>('.' + cls);
    if (el) el.style.visibility = hidden ? 'hidden' : '';
    liveConnectHidden = hidden;
  }
  // The rect used to anchor an edge to a box: the LIVE DOM rect when present (mid-drag),
  // else the model rect. Rotation is ignored (org cards are axis-aligned).
  function boxRectById(boxes: Box[], id: string): EdgeRect | null {
    const i = indexOfId(boxes, id);
    if (i < 0) return null;
    const el = canvasEl.querySelector<HTMLElement>(`.lolly-box[data-box-id="${cssEscape(id)}"]`);
    if (el && el.style.left) {
      const fo = frameOffsetOfEl(el);
      return { x: (parseFloat(el.style.left) || 0) + fo.x, y: (parseFloat(el.style.top) || 0) + fo.y, w: parseFloat(el.style.width) || 1, h: parseFloat(el.style.height) || 1 };
    }
    const r = boxRect(boxes[i], cfg);
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  // Pull the shaft back off an arrow end and build the head fragment(s) for the preview —
  // mirrors the gap + headInset logic in drawConnector() (org-chart/hooks.js) so the live
  // line matches the committed render and nothing jumps on release. Returns the (copied)
  // shaft points to draw through, plus the heads SVG to append. End direction is the last
  // shaft segment (exact for straight/elbow, a close sample for arc/curved).
  function previewHeads(src: Point[], arrow: string, head: string, headSize: number, col: string): { pts: Point[]; heads: string } {
    const pts = src.map((p) => ({ x: p.x, y: p.y }));
    const n = pts.length;
    if (n < 2 || arrow === 'none' || head === 'none') return { pts, heads: '' };
    const d2 = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
    const along = (from: Point, toward: Point, d: number): Point => {
      const L = d2(from, toward); if (L < 1e-4) return { x: from.x, y: from.y };
      const t = Math.min(d, L) / L; return { x: from.x + (toward.x - from.x) * t, y: from.y + (toward.y - from.y) * t };
    };
    const gap = Math.max(8, headSize * 0.8);
    const inset = edgeHeadInset(head, headSize);
    const last = { x: pts[n - 1]!.x, y: pts[n - 1]!.y }, first = { x: pts[0]!.x, y: pts[0]!.y };
    const lastNbr = pts[n - 2]!, firstNbr = pts[1]!;
    let heads = '';
    if (arrow === 'end' || arrow === 'both') {
      const ge = Math.min(gap, d2(last, lastNbr) * 0.55);
      const endTip = along(last, lastNbr, ge);
      pts[n - 1] = along(last, lastNbr, Math.min(ge + inset, d2(last, lastNbr) * 0.9));
      const L = d2(last, lastNbr) || 1;
      heads += edgeArrowHead(endTip, (last.x - lastNbr.x) / L, (last.y - lastNbr.y) / L, headSize, col, head);
    }
    if (arrow === 'both') {
      const gs = Math.min(gap, d2(first, firstNbr) * 0.55);
      const startTip = along(first, firstNbr, gs);
      pts[0] = along(first, firstNbr, Math.min(gs + inset, d2(first, firstNbr) * 0.9));
      const seg = pts[1]!;   // reversed first drawn segment = direction OUT of the source
      const L = d2(startTip, seg) || 1;
      heads += edgeArrowHead(startTip, (startTip.x - seg.x) / L, (startTip.y - seg.y) / L, headSize, col, head);
    }
    return { pts, heads };
  }
  /** Every box's rect for routing: the LIVE DOM rect when there is one (mid-drag), else
   *  the model rect. Resolved in ONE querySelectorAll + one pass, so a connected drag
   *  redraws in O(boxes + lines) rather than two DOM queries per line. */
  function liveRectById(boxes: Box[]): Map<string, EdgeRect> {
    const liveEls = new Map<string, HTMLElement>();
    canvasEl.querySelectorAll<HTMLElement>('.lolly-box[data-box-id]').forEach((el) => {
      const id = el.getAttribute('data-box-id');
      if (id != null) liveEls.set(id, el);
    });
    const rectById = new Map<string, EdgeRect>();
    for (let i = 0; i < boxes.length; i++) {
      const id = idOf(boxes[i], i);
      const el = liveEls.get(id);
      if (el && el.style.left) {
        const fo = frameOffsetOfEl(el);
        rectById.set(id, { x: (parseFloat(el.style.left) || 0) + fo.x, y: (parseFloat(el.style.top) || 0) + fo.y, w: parseFloat(el.style.width) || 1, h: parseFloat(el.style.height) || 1 });
      } else {
        const r = boxRect(boxes[i], cfg);
        rectById.set(id, { x: r.x, y: r.y, w: r.w, h: r.h });
      }
    }
    return rectById;
  }

  /**
   * Redraw every BOUND PATH from the current (possibly live) box rects — the plan 96 P3
   * live re-route. Called each frame of a drag that moves a box a line is attached to, so
   * the line follows in real time while the tool's committed layer is hidden.
   *
   * The geometry is `routedLineSvg`, the engine's committed renderer, called with the same
   * decoration record the hook builds — not a preview approximation of it. So nothing jumps
   * on release: what the drag showed IS what the commit re-renders.
   *
   * Returns the number of lines drawn, so the caller knows whether the layer is worth
   * showing at all.
   */
  function drawLiveBoundPaths(boxes: Box[], rectById: Map<string, EdgeRect>): string {
    if (!hasBindCfg) return '';
    let body = '';
    for (const b of boxes) {
      const parts = b && boundPathParts(b);
      if (!parts) continue;
      const a = edgeEndRect(parts.from, rectById);
      const z = edgeEndRect(parts.to, rectById);
      if (!a || !z) continue;                       // a dangling id draws nothing
      if (!isEdgePoint(parts.from) && !isEdgePoint(parts.to) && edgeNested(a, z)) continue;
      body += routedLineSvg(a, z, parts.decor);
    }
    return body;
  }

  // Redraw every edge from the current (possibly live) box rects. Called each frame of a
  // drag involving connected cards, so the lines track the boxes in real time.
  function drawLiveConnectors(): void {
    const boxes = getBoxes();
    if (hasBindCfg && !connectCfg) {
      // The plan-96 path: every connector is a bound path box, and there is no edge input.
      placeConnectLayer(metrics());
      connectLayer.innerHTML = drawLiveBoundPaths(boxes, liveRectById(boxes));
      connectLayer.style.display = '';
      return;
    }
    if (!connectCfg) return;
    const edges = getEdges();
    placeConnectLayer(metrics());
    const rectById = liveRectById(boxes);
    // A tool that still declares BOTH (an un-migrated pack on a new shell) draws each from
    // its own model, once — the bound paths first so they sit under the legacy edges.
    let body = drawLiveBoundPaths(boxes, rectById);
    for (const e of edges) {
      if (!e) continue;
      // An endpoint is a box id OR a free point (`@x,y`); edgeEndRect resolves either (a
      // point → a 0×0 rect the routing already handles). A dangling id → null → no line.
      const fromV = String(e[connectCfg.fromField!]);
      const toV = String(e[connectCfg.toField!]);
      const a = edgeEndRect(fromV, rectById);
      const b = edgeEndRect(toV, rectById);
      if (!a || !b) continue;
      // Nested pair draws no line (mirrors hooks.js) — but ONLY when both ends are nodes;
      // a free point inside a box is a deliberate endpoint, not an overlap to suppress.
      if (!isEdgePoint(fromV) && !isEdgePoint(toV) && edgeNested(a, b)) continue;
      const style = String((connectCfg.styleField && e[connectCfg.styleField]) || connectCfg.defaultStyle);
      const col = cAttr(String((connectCfg.colorField && e[connectCfg.colorField]) || connectCfg.defaultColor));
      const w = Math.min(20, Math.max(0.5, Number((connectCfg.widthField && e[connectCfg.widthField]) ?? connectCfg.defaultWidth) || 2.5));
      const arrow = String((connectCfg.arrowField && e[connectCfg.arrowField]) || connectCfg.defaultArrow || 'none');
      const head = String((connectCfg.headField && e[connectCfg.headField]) || connectCfg.defaultHead || 'triangle');
      const raw = edgeWaypoints(a, b, style);
      if (raw.length < 2) continue;
      const { pts, heads } = previewHeads(raw, arrow, head, Math.max(9, w * 4), col);
      const d = style === 'curved' ? smoothEdgePath(pts) : roundedEdgePath(pts, Math.min(16, w * 4 + 6));
      body += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${cf2(w)}" stroke-linejoin="round" stroke-linecap="round"/>` + heads;
    }
    connectLayer.innerHTML = body;
    connectLayer.style.display = '';
  }
  // `drawConnectRubber` (plan 90) lived here — the dashed rubber from a pending source
  // card to the cursor. It went with Connect mode (plan 96 P4); `drawBindRing` below is
  // its replacement, and it hangs off the endpoint being dragged rather than off a mode.
  /**
   * The Line tool's rubber (plan 96 P2): a dashed shaft between the two canvas points of
   * the drag, with the head the committed box will carry previewed at the far end.
   *
   * Both ends are plain points now. Under plan 90 the start resolved through `edgeEndRect`
   * (a card border or an `@x,y`) and the far end outlined whatever card a release would
   * attach to — honest then, misleading now: releasing over a box binds nothing until P3,
   * and an outline promising an attachment that does not happen is worse than no outline.
   *
   * Drawn in the SAME ink and at the same head size as `commitPathBox` will use, so the
   * preview is the shape you get rather than a stand-in for it.
   */
  function drawLineRubber(from: Point, to: Point): void {
    const col = cAttr(drawnInkHex());
    const w = lineDraftWidth();
    const head = 'triangle';                      // lineBoxSeed's default headEnd
    const headSize = Math.max(9, w * 4);
    const dirL = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const ux = (to.x - from.x) / dirL, uy = (to.y - from.y) / dirL;
    // Below the head's own length there is no room for both, so the dot stands in — the
    // same "there is an endpoint here" mark the connect rubber uses.
    const showHead = dirL > headSize;
    const inset = showHead ? edgeHeadInset(head, headSize) : 0;
    const tip = showHead
      ? edgeArrowHead(to, ux, uy, headSize, col, head)
      : `<circle cx="${cf2(to.x)}" cy="${cf2(to.y)}" r="5" fill="${col}"/>`;
    placeConnectLayer(metrics());
    connectLayer.innerHTML =
      `<path d="M${cf2(from.x)} ${cf2(from.y)}L${cf2(to.x - ux * inset)} ${cf2(to.y - uy * inset)}" fill="none" stroke="${col}" stroke-width="${cf2(w)}" stroke-dasharray="8 6" stroke-linecap="round"/>` +
      tip;
    connectLayer.style.display = '';
  }
  /** The stroke width a line draft previews at: whatever the committed box will take —
   *  the last path paint, else the tool's own `path` seed, else `penFinishDraw`'s own 4px
   *  last resort — so the rubber is not a different weight from the shape it becomes. */
  function lineDraftWidth(): number {
    const seed = { ...(addKinds.find((k) => k.id === 'path')?.seed || {}) } as Box;
    const w = Number(penLastPaint?.[cfg.strokeWField] ?? seed[cfg.strokeWField] ?? 0);
    return Math.min(20, Math.max(0.5, w > 0 ? w : 4));
  }
  function hideConnectLayer(): void {
    connectLayer.style.display = 'none';
    connectLayer.innerHTML = '';
  }
  // Called each frame of a drag that moves connected cards: hide the tool's committed
  // connector layer once, then redraw every edge live so the lines follow the boxes.
  function liveConnUpdate(): void {
    if (!connectCfg && !hasBindCfg) return;
    if (!liveConnectHidden) setRealConnectorsHidden(true);
    drawLiveConnectors();
  }
  // On drop, keep the preview one extra paint so the committed connectors re-render
  // underneath before we drop it (avoids a flash), then restore + clear.
  function endLiveConnectors(): void {
    if (!liveConnectHidden) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (disposed) return;
      setRealConnectorsHidden(false);
      if (!selectedEdges.size) hideConnectLayer();
    }));
  }

  // ── connector inspector (click a line → edit its bend / thickness / colour) ────
  // Connectors render in the tool's #tool-canvas svg (pointer-events:none) BEHIND the
  // cards, so the overlay hit-tests them itself: on a click that misses every box, the
  // nearest connector polyline within a small screen-px band is selected.
  const edgeById = (eid: string): Box | null => getEdges().find((e) => e && String(e[cfg.idField]) === eid) || null;
  function distToSeg(px: number, py: number, a: Point, b: Point): number {
    const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / L2)) : 0;
    return Math.hypot(px - (a.x + vx * t), py - (a.y + vy * t));
  }
  function polylineDist(px: number, py: number, pts: Point[]): number {
    let d = Infinity;
    for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, distToSeg(px, py, pts[i]!, pts[i + 1]!));
    return d;
  }
  function polylineMid(pts: Point[]): Point {
    if (pts.length < 2) return pts[0] || { x: 0, y: 0 };
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const seg = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
      if (acc + seg >= total / 2) { const t = seg ? (total / 2 - acc) / seg : 0; return { x: pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * t, y: pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * t }; }
      acc += seg;
    }
    return pts[pts.length - 1]!;
  }
  const edgeStyleOf = (e: Box): string => String((connectCfg?.styleField && e[connectCfg.styleField]) || connectCfg?.defaultStyle || 'elbow');
  const edgeWidthOf = (e: Box): number => clampN(connectCfg?.widthField ? e[connectCfg.widthField] : undefined, connectCfg?.defaultWidth ?? 2.5, 0.5, 20);
  function edgePts(e: Box): Point[] | null {
    if (!connectCfg) return null;
    const boxes = getBoxes();
    const a = boxRectById(boxes, String(e[connectCfg.fromField!])), b = boxRectById(boxes, String(e[connectCfg.toField!]));
    return a && b ? edgeWaypoints(a, b, edgeStyleOf(e)) : null;
  }
  // The connector id nearest to a native point, within ~9 screen px. null if none.
  function edgeAt(x: number, y: number): string | null {
    if (!connectCfg) return null;
    const thresh = 9 / (metrics().scale || 1);
    let best: { id: string; d: number } | null = null;
    for (const e of getEdges()) {
      if (!e) continue;
      const id = String(e[cfg.idField] ?? '');
      if (!id) continue;
      const pts = edgePts(e);
      if (!pts) continue;
      const d = polylineDist(x, y, pts);
      if (d <= thresh && (!best || d < best.d)) best = { id, d };
    }
    return best ? best.id : null;
  }
  // Hover affordance: a pointer cursor + a faint highlight when the cursor is over a
  // connector line, so the (pointer-events:none) lines read as selectable. rAF-throttled
  // so the edgeAt hit-test never runs more than once per frame.
  function updateHover(): void {
    hoverRaf = 0;
    if (!connectCfg || selectedEdges.size || gesture || !lastPointer) { setHoverEdge(null); return; }
    const nat = clientToNative(lastPointer.x, lastPointer.y);
    setHoverEdge(edgeAt(nat.x, nat.y));
  }
  function setHoverEdge(id: string | null): void {
    if (id === hoverEdge) return;
    hoverEdge = id;
    stageEl.style.cursor = id ? 'pointer' : '';
    if (id) {
      const e = edgeById(id);
      const pts = e && edgePts(e);
      if (e && pts) {
        const w = edgeWidthOf(e);
        const d = edgeStyleOf(e) === 'curved' ? smoothEdgePath(pts) : roundedEdgePath(pts, Math.min(16, w * 4 + 6));
        placeConnectLayer(metrics());
        connectLayer.innerHTML = `<path d="${d}" fill="none" stroke="#30ba78" stroke-width="${cf2(w + 6)}" stroke-linejoin="round" stroke-linecap="round" opacity="0.18"/>`;
        connectLayer.style.display = '';
      }
    } else if (!selectedEdges.size) {
      hideConnectLayer();
    }
  }
  // The "primary" selected edge — drives the panel's displayed values + placement.
  function primaryEdgeId(): string | null { for (const id of selectedEdges) return id; return null; }
  // Geometry for marquee edge-hit: does a connector's polyline overlap the drag rect?
  function pointInRect(x: number, y: number, r: Rect): boolean { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
  function segsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
    const d = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }
  function polylineInRect(pts: Point[], r: Rect): boolean {
    for (const p of pts) if (pointInRect(p.x, p.y, r)) return true;   // an endpoint inside
    const c = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
    for (let i = 0; i < pts.length - 1; i++)
      for (let j = 0; j < 4; j++)
        if (segsCross(pts[i]!, pts[i + 1]!, c[j]!, c[(j + 1) % 4]!)) return true;   // a segment crossing a side
    return false;
  }
  function edgesInRect(r: Rect): string[] {
    if (!connectCfg) return [];
    const ids: string[] = [];
    for (const e of getEdges()) {
      if (!e) continue;
      const id = String(e[cfg.idField] ?? '');
      const pts = id && edgePts(e);
      if (pts && polylineInRect(pts, r)) ids.push(id);
    }
    return ids;
  }
  // Select a connector. `additive` (shift/⌘-click) toggles it in the current set;
  // otherwise it becomes the sole selection. Either way it clears the card selection —
  // a marquee is what mixes cards + connectors (see the marquee gesture end).
  function selectEdge(eid: string, additive?: boolean): void {
    setHoverEdge(null);
    if (additive && selectedEdges.size) {
      if (selectedEdges.has(eid)) selectedEdges.delete(eid); else selectedEdges.add(eid);
      if (!selectedEdges.size) { deselectEdge(); return; }
    } else {
      selectedEdges = new Set([eid]);
    }
    selection = new Set<string>();     // a connector and a card can't be selected by a plain click
    renderChrome();                    // clear any card chrome + draw the highlight(s)
    openEdgePanel();                   // rebuild (count / values may have changed)
  }
  function deselectEdge(): void {
    if (!selectedEdges.size && !edgePanel) return;
    selectedEdges = new Set<string>();
    closeEdgePanel();
    hideConnectLayer();
  }
  function closeEdgePanel(): void { edgePanel?.remove(); edgePanel = null; }
  // Redraw EVERY selected edge's highlight (native coords in the connect layer) + keep
  // the panel over the primary edge. Prunes any edge whose line/box vanished.
  function refreshEdgeChrome(): void {
    if (!connectCfg || !selectedEdges.size) return;
    let html = '';
    const alive = new Set<string>();
    for (const eid of selectedEdges) {
      const e = edgeById(eid);
      const pts = e && edgePts(e);
      if (!e || !pts) continue;
      alive.add(eid);
      const w = edgeWidthOf(e);
      // Match the tool hook's path choice: a dashed/dotted line is drawn as sharp
      // segments (no smooth curve), so the highlight follows suit; solid honours curved.
      const dashV = String((connectCfg.dashField && e[connectCfg.dashField]) || 'solid');
      const d = dashV !== 'solid' ? roundedEdgePath(pts, 0)
        : edgeStyleOf(e) === 'curved' ? smoothEdgePath(pts)
          : roundedEdgePath(pts, Math.min(16, w * 4 + 6));
      html += `<path d="${d}" fill="none" stroke="#30ba78" stroke-width="${cf2(w + 8)}" stroke-linejoin="round" stroke-linecap="round" opacity="0.35"/>`;
    }
    if (alive.size !== selectedEdges.size) selectedEdges = alive;   // drop the vanished
    if (!selectedEdges.size) { deselectEdge(); return; }
    placeConnectLayer(metrics());
    connectLayer.innerHTML = html;
    connectLayer.style.display = '';
    positionEdgePanel();
  }
  // Set a field on ALL selected connectors at once (the multi-edit core).
  function setEdgeField(field: string | undefined, value: unknown): void {
    if (!connectCfg || !selectedEdges.size || !field) return;
    const edges = getEdges();
    commitEdges(edges.map((e) => (e && selectedEdges.has(String(e[cfg.idField])) ? { ...e, [field]: value as InputValue } : e)));
    refreshEdgeChrome();               // bend/thickness change → re-highlight + reposition
  }
  function deleteSelectedEdge(): void {
    if (!connectCfg || !selectedEdges.size) return;
    commitEdges(getEdges().filter((e) => !(e && selectedEdges.has(String(e[cfg.idField])))));
    deselectEdge();
  }
  function positionEdgePanel(): void {
    const pid = primaryEdgeId();
    if (!edgePanel || !connectCfg || !pid) return;
    const e = edgeById(pid);
    const pts = e && edgePts(e);
    if (!pts) return;
    const s = nativeToStage(polylineMid(pts).x, polylineMid(pts).y, metrics());
    const sr = stageEl.getBoundingClientRect();
    edgePanel.style.left = Math.max(6, Math.min(s.x + 14, sr.width - edgePanel.offsetWidth - 8)) + 'px';
    edgePanel.style.top = Math.max(6, Math.min(s.y + 12, sr.height - edgePanel.offsetHeight - 8)) + 'px';
  }
  function openEdgePanel(): void {
    closeEdgePanel();
    const pid = primaryEdgeId();
    if (!connectCfg || !pid) return;
    const e = edgeById(pid);
    if (!e) return;
    const nSel = selectedEdges.size;   // >1 → the panel edits them ALL; values shown are the primary's
    const styleF = connectCfg.styleField, arrowF = connectCfg.arrowField, dashF = connectCfg.dashField;
    const widthF = connectCfg.widthField, colorF = connectCfg.colorField, headF = connectCfg.headField;
    const styleCur = edgeStyleOf(e);
    const arrowCur = String((arrowF && e[arrowF]) || connectCfg.defaultArrow || 'end');
    const headCur = String((headF && e[headF]) || connectCfg.defaultHead || 'triangle');
    const dashCur = String((dashF && e[dashF]) || 'solid');
    const widthCur = edgeWidthOf(e);
    const colorCur = String((colorF && e[colorF]) || connectCfg.defaultColor || '#94a3b8');
    // Arrowhead-shape glyphs for the segmented picker (a shaft + the head, pointing right).
    const HEAD_CHOICES: Array<[string, string, string]> = [
      ['triangle', t('Triangle'), '<line x1="3" y1="12" x2="13" y2="12"/><path d="M12 8l7 4-7 4Z" fill="currentColor" stroke="none"/>'],
      ['open', t('Open'), '<line x1="3" y1="12" x2="19" y2="12"/><path d="M14 7l6 5-6 5" fill="none"/>'],
      ['circle', t('Circle'), '<line x1="3" y1="12" x2="13" y2="12"/><path d="M20 12a3.3 3.3 0 1 1-6.6 0 3.3 3.3 0 0 1 6.6 0Z" fill="currentColor" stroke="none"/>'],
      ['diamond', t('Diamond'), '<line x1="3" y1="12" x2="11" y2="12"/><path d="M11 12l4.5-4 4.5 4-4.5 4Z" fill="currentColor" stroke="none"/>'],
      ['bar', t('Bar'), '<line x1="3" y1="12" x2="18" y2="12"/><line x1="18" y1="6" x2="18" y2="18"/>'],
    ];
    // Bend has many orthogonal flavours → a dropdown (kept in sync with tool.json's
    // `style` options + hooks.js waypoints()).
    const STYLE_OPTS: Array<[string, string]> = [
      ['straight', 'Straight'], ['elbow', 'Elbow — auto'], ['elbow-v', 'Elbow — vertical'],
      ['elbow-h', 'Elbow — horizontal'], ['elbow-src', 'Bend at start'], ['elbow-tgt', 'Bend at end'],
      ['curved', 'Curved — auto'], ['curved-v', 'Curved — vertical'], ['curved-h', 'Curved — horizontal'],
      ['arc', 'Arc — bow'], ['arc-wide', 'Arc — wide bow'], ['arc-flip', 'Arc — reverse bow'], ['arc-flip-wide', 'Arc — wide reverse'],
    ];
    // `row()` below wraps controls in a <div>, not a <label>, so this select gets no
    // implicit name from its row text — it names itself.
    const styleSelect = `<select class="field-select field-select--sm" data-ep="style" aria-label="${escape(t('Connector bend'))}">${STYLE_OPTS.map(([v, l]) => `<option value="${v}"${styleCur === v ? ' selected' : ''}>${escape(t(l))}</option>`).join('')}</select>`;
    const row = (lbl: string, ctrl: string): string => `<div class="fc-row"><span class="fc-row-lbl"><span>${lbl}</span></span>${ctrl}</div>`;
    const p = document.createElement('div');
    p.className = 'fc-panel fc-edge-panel';
    p.innerHTML =
      (nSel > 1 ? `<div class="fc-edge-count">${t('{n} connectors — editing all', { n: nSel })}</div>` : '') +
      (styleF ? row(t('Bend'), styleSelect) : '') +
      (arrowF ? row(t('Arrow'), segHtml(arrowF, arrowCur, [['none', t('None')], ['end', t('End')], ['both', t('Both')]])) : '') +
      (headF ? row(t('Head'), segHtml(headF, headCur, HEAD_CHOICES)) : '') +
      (dashF ? row(t('Line'), segHtml(dashF, dashCur, [['solid', t('Solid')], ['dashed', t('Dashed')], ['dotted', t('Dotted')]])) : '') +
      (widthF ? `<label class="fc-row"><span class="fc-row-lbl"><span>${t('Thickness')}</span></span><input type="range" class="field-range" data-ep="width" min="0.5" max="12" step="0.5" value="${widthCur}"><b data-ep-val="width">${widthCur}</b></label>` : '') +
      (colorF ? `<label class="fc-row"><span class="fc-row-lbl"><span>${t('Colour')}</span></span><span class="fc-cfield">${colorFieldHtml('fc-edge-color', colorCur, { float: true })}</span></label>` : '') +
      `<div class="fc-row fc-edge-actions"><button type="button" class="fc-cbtn fc-danger" data-ep="del">${icon(SVG.trash)}<span>${nSel > 1 ? t('Delete {n} lines', { n: nSel }) : t('Delete line')}</span></button></div>`;
    p.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    wireSegs(p, (field, v) => setEdgeField(field, v));
    if (styleF) {
      const sel = p.querySelector<HTMLSelectElement>('select[data-ep="style"]');
      sel?.addEventListener('change', () => setEdgeField(styleF, sel.value));
    }
    if (widthF) {
      const rng = p.querySelector<HTMLInputElement>('input[data-ep="width"]');
      rng?.addEventListener('input', () => {
        const vb = p.querySelector<HTMLElement>('[data-ep-val="width"]');
        if (vb) vb.textContent = rng.value;
        setEdgeField(widthF, Number(rng.value));
      });
    }
    if (colorF) wireColorField(p, { onChange: (id, val) => { if (id === 'fc-edge-color') setEdgeField(colorF, unwrapColor(val)); } });
    p.querySelector<HTMLButtonElement>('[data-ep="del"]')?.addEventListener('click', (ev) => { ev.stopPropagation(); deleteSelectedEdge(); });
    stageEl.appendChild(p);
    edgePanel = p;
    positionEdgePanel();
  }

  // ── overlay rendering ─────────────────────────────────────────────────────────
  let syncScheduled = false;
  function scheduleSync(): void {
    if (syncScheduled || disposed) return;
    syncScheduled = true;
    requestAnimationFrame(() => { syncScheduled = false; if (!gesture || gesture.type === 'tap') renderChrome(); });
  }

  // During a gesture, reposition chrome from the live DOM (which we just mutated).
  function renderChromeLive(): void {
    const boxes = getBoxes();
    const rects = new Map<number, Rect>();
    for (const i of selIndices(boxes)) {
      const id = idOf(boxes[i], i);
      const el = canvasEl.querySelector<HTMLElement>(`.lolly-box[data-box-id="${cssEscape(id)}"]`);
      // el.style.left/top are FRAME-LOCAL in multi-page mode; add the frame offset back
      // so the selection chrome (which paints in global native → stage coords) lines up.
      if (el) { const fo = frameOffsetOfEl(el); rects.set(i, {
        x: (parseFloat(el.style.left) || 0) + fo.x, y: (parseFloat(el.style.top) || 0) + fo.y,
        w: parseFloat(el.style.width) || 1, h: parseFloat(el.style.height) || 1,
        rot: rotOf(el),
      }); }
    }
    paintChrome(boxes, rects);
  }

  function renderChrome(): void {
    const boxes = getBoxes();
    paintChrome(boxes, null);
    // Keep the selected connector's highlight + inspector tracking any box move,
    // pan/zoom, or edit (drops the selection if its edge/box has gone).
    if (selectedEdges.size) refreshEdgeChrome();
  }

  // Align the frame dimmer to the export frame. Runs on every sync (pan / zoom /
  // resize) regardless of selection or text-edit state, so the "faded outside the
  // frame" cue tracks the artboard wherever it moves.
  function positionFrameScrim(): void {
    const m = metrics();
    const wh = canvasWH();
    const tl = nativeToStage(0, 0, m);
    frameScrim.style.left = tl.x + 'px';
    frameScrim.style.top = tl.y + 'px';
    frameScrim.style.width = wh.w * m.scale + 'px';
    frameScrim.style.height = wh.h * m.scale + 'px';
  }

  function paintChrome(boxes: Box[], liveRects: Map<number, Rect> | null): void {
    // The one place a selection change is announced (see selListeners) — BEFORE the
    // text-edit / pen early returns, so a listener never misses a change made in
    // those modes. Inert (returns immediately) when nothing is listening.
    notifySelection();
    // M2 — reposition the frame scrim only when the artboard geometry changed (pan/
    // zoom/resize set scrimDirty); a box drag/hover/selection change never moves it.
    const movedStage = scrimDirty;
    if (scrimDirty) { positionFrameScrim(); scrimDirty = false; }
    // Ghosts are positioned in stage px from the MODEL, exactly like the selection
    // outline, so they have to be re-placed whenever the artboard's geometry or the
    // model moves. Skipped on the LIVE path (`liveRects` non-null = a box drag is in
    // flight) unless the stage itself moved: a ghosted box is off-playhead by
    // definition and therefore never the one being dragged, so rebuilding its ghost
    // sixty times a second buys nothing.
    if (!liveRects || movedStage) paintOnion();
    // ── THE ONE RULE, enforcement point 2 of 3: RETENTION (see the file header) ──
    // The chrome below is positioned from the MODEL, not from the DOM: a selected box
    // the sequence is hiding would otherwise get a full outline, 8 resize handles, a
    // rotate handle and a contextual bar painted over empty canvas — the "edit a layer
    // you cannot see" failure, and the ONLY drag entry point that never goes through
    // the hit-test (a handle is its own pointerdown target). So the whole apparatus
    // comes down and the reconciliation banner goes up instead.
    if (timeCfg && selection.size && !selectionLive(boxes)) {
      const offIdx = selIndices(boxes);
      if (offIdx.length) {
        clearChrome();
        hideCtxBar();
        closeMorePanel();
        chromeKey = '';
        ctxSelKey = '';
        showOffPlayhead(boxes, offIdx);
        updateToolbarState(0);
        return;
      }
    }
    hideOffPlayhead();
    // While editing text, suppress selection chrome + ctxbar; just keep the floating
    // format bar tracking the box as the stage pans/zooms.
    if (editing) { clearChrome(); hideCtxBar(); positionFmtBar(); return; }
    // Pen mode owns the chrome outright — no selection outline, no resize handles, and the
    // object bar replaced by the pen's own. Same suppression a text edit does, for the same
    // reason: the box's frame is not what is being manipulated.
    if (penDraft || penEdit) {
      clearChrome();
      penSyncFromModel(boxes);
      if (penDraft || penEdit) {
        paintPen();
        syncPenChrome();
        penCtxBar();
        updateToolbarState(0);
        syncBoxA11y();
        emptyHint.hidden = true;
        return;
      }
    }
    if (penChromeKey) clearPenChrome();
    paintPen();
    const idx = selIndices(boxes);
    const m = metrics();
    // Gradient handles sit UNDER the selection chrome in z-order but are painted here
    // so they track the same pan/zoom sync (and self-exit if their box went away).
    // Gradient mode belongs to ONE box. If the selection moved on, leave the mode —
    // otherwise the ctx bar rebuilds for the new box while the Fill field and Delete
    // still write to the old one, which is silent, wrong, and very hard to spot.
    if (gradEdit != null && !(idx.length === 1 && idOf(boxes[idx[0]!], idx[0]!) === gradEdit)) {
      exitGradEdit();
      ctxSelKey = '';
    }
    paintGradChrome(boxes, m);
    // M1 — build the outline(s) + handles ONCE per selection set, then only reposition.
    const key = idx.length ? idx.map((i) => idOf(boxes[i], i)).sort().join(',') : '';
    if (key !== chromeKey) {
      chromeKey = key;
      buildChrome(idx.length);            // (re)create nodes for the new set
    }
    positionChrome(boxes, idx, liveRects, m);
    // Contextual bar — rebuild its controls only when the SELECTION set changes
    // (so the colour pickers reflect the box); otherwise just reposition it.
    if (key !== ctxSelKey) {
      ctxSelKey = key;
      if (idx.length) rebuildCtxBar(boxes, idx);
      else { hideCtxBar(); closeMorePanel(); multiTapMode = false; }
    }
    // Now that the ctx bar exists (and cannot close the panel again this frame), honour
    // a pending request to open the gradient panel, anchored on the live button.
    if (gradPanelPending && gradEdit != null) {
      gradPanelPending = false;
      const btn = ctxbar.querySelector<HTMLElement>('[data-cx="grad"]');
      if (btn) openGradPanel(btn);
    }
    if (idx.length) positionCtxBar(boxes, idx, liveRects, m);
    updateToolbarState(idx.length);
    syncBoxA11y();
    emptyHint.hidden = boxes.length > 0 || !toolbar.querySelector('.fc-btn-add');
  }
  // Make each rendered card keyboard-focusable + labelled, and reflect selection state, so
  // keyboard users can Tab to a card (which selects it → every onKey action applies) and
  // screen readers announce it. The tool template owns the .lolly-box elements; we annotate
  // them here after each sync (fresh elements after a re-render arrive without the attrs).
  function syncBoxA11y(): void {
    canvasEl.querySelectorAll<HTMLElement>('.lolly-box[data-box-id]').forEach((el) => {
      const id = el.getAttribute('data-box-id') || '';
      if (!el.hasAttribute('tabindex')) {
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        el.setAttribute('aria-label', txt ? tRaw('Card: {text}', { text: txt }) : t('Card'));
      }
      const on = selection.has(id);
      if ((el.getAttribute('aria-pressed') === 'true') !== on) el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // Create the chrome node set for a selection of `count` boxes (0 = none, 1 = single
  // with 8 resize handles + rotate, 2+ = group AABB with 4 corners + rotate). Nodes
  // are stored in chromeNodes so subsequent syncs reposition them without recreating
  // (or re-binding pointerdown). positionChrome fills in geometry.
  function buildChrome(count: number): void {
    chrome.innerHTML = '';
    const outlines: HTMLElement[] = [];
    const handles: HTMLElement[] = [];
    let groupOutline: HTMLElement | null = null;
    let stem: HTMLElement | null = null;
    let rot: HTMLElement | null = null;
    if (count === 1) {
      const o = document.createElement('div');
      o.className = 'fc-outline';
      outlines.push(o); chrome.appendChild(o);
      for (const h of HANDLES) {
        const el = document.createElement('div');
        el.className = 'fc-handle fc-h-' + h;
        el.addEventListener('pointerdown', (e) => onHandlePointerDown(e, h));
        handles.push(el); chrome.appendChild(el);
      }
      stem = document.createElement('div');
      stem.className = 'fc-rot-stem';
      chrome.appendChild(stem);
      rot = document.createElement('div');
      rot.className = 'fc-handle fc-h-rotate';
      rot.title = t('Rotate');
      rot.addEventListener('pointerdown', (e) => onHandlePointerDown(e, 'rotate'));
      chrome.appendChild(rot);
    } else if (count > 1) {
      for (let k = 0; k < count; k++) {
        const o = document.createElement('div');
        o.className = 'fc-outline';
        outlines.push(o); chrome.appendChild(o);
      }
      groupOutline = document.createElement('div');
      groupOutline.className = 'fc-outline fc-group-outline';
      chrome.appendChild(groupOutline);
      for (const name of ['nw', 'ne', 'se', 'sw'] as Corner[]) {
        const el = document.createElement('div');
        el.className = 'fc-handle fc-h-' + name;
        el.addEventListener('pointerdown', (e) => onGroupHandleDown(e, name));
        handles.push(el); chrome.appendChild(el);
      }
      stem = document.createElement('div');
      stem.className = 'fc-rot-stem';
      chrome.appendChild(stem);
      rot = document.createElement('div');
      rot.className = 'fc-handle fc-h-rotate';
      rot.title = t('Rotate group');
      rot.addEventListener('pointerdown', (e) => onGroupHandleDown(e, 'rotate'));
      chrome.appendChild(rot);
    }
    chromeNodes = { outlines, groupOutline, handles, stem, rot };
  }

  // Reposition the (already-built) chrome nodes for the current selection. Pure style
  // writes — pixel-identical to the old build path, just no node churn.
  function positionChrome(boxes: Box[], idx: number[], liveRects: Map<number, Rect> | null, m: Metrics): void {
    const nodes = chromeNodes;
    if (!nodes) return;
    for (let k = 0; k < idx.length; k++) {
      const r = (liveRects && liveRects.get(idx[k]!)) || boxRect(boxes[idx[k]!], cfg);
      const tl = nativeToStage(r.x, r.y, m);
      const o = nodes.outlines[k]!;
      o.style.left = tl.x + 'px';
      o.style.top = tl.y + 'px';
      o.style.width = r.w * m.scale + 'px';
      o.style.height = r.h * m.scale + 'px';
      o.style.transform = r.rot ? `rotate(${r.rot}deg)` : '';
    }
    if (idx.length === 1) {
      positionHandles((liveRects && liveRects.get(idx[0]!)) || boxRect(boxes[idx[0]!], cfg), m);
    } else if (idx.length > 1) {
      positionGroupHandles(groupAABBNative(idx, boxes, liveRects), m);
    }
  }

  function positionHandles(r: Rect, m: Metrics): void {
    const nodes = chromeNodes;
    if (!nodes) return;
    const box = { [cfg.xField]: r.x, [cfg.yField]: r.y, [cfg.wField]: r.w, [cfg.hField]: r.h, [cfg.rotationField]: r.rot };
    const corners = boxCorners(box, cfg).map((p: Point) => nativeToStage(p.x, p.y, m)); // TL,TR,BR,BL
    const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const pos: Record<HandleName, Point> = {
      nw: corners[0]!, ne: corners[1]!, se: corners[2]!, sw: corners[3]!,
      n: mid(corners[0]!, corners[1]!), e: mid(corners[1]!, corners[2]!),
      s: mid(corners[2]!, corners[3]!), w: mid(corners[3]!, corners[0]!),
    };
    HANDLES.forEach((h, k) => {
      const el = nodes.handles[k]!;
      el.style.left = pos[h].x + 'px';
      el.style.top = pos[h].y + 'px';
    });
    // rotate handle: outward from the BOTTOM-edge midpoint along the box "down"
    // normal — kept clear of the contextual bar (which floats above the selection)
    // and the 'n' resize handle, so the two never fight for a grab (Canva-style).
    const ROT_OFFSET = 30;
    const c = nativeToStage(r.x + r.w / 2, r.y + r.h / 2, m);
    const bottom = pos.s;
    const len = Math.hypot(bottom.x - c.x, bottom.y - c.y) || 1;
    const ux = (bottom.x - c.x) / len, uy = (bottom.y - c.y) / len;
    const rp = { x: bottom.x + ux * ROT_OFFSET, y: bottom.y + uy * ROT_OFFSET };
    if (nodes.stem) {
      nodes.stem.style.left = bottom.x + 'px'; nodes.stem.style.top = bottom.y + 'px';
      nodes.stem.style.width = ROT_OFFSET + 'px';
      nodes.stem.style.transform = `rotate(${Math.atan2(uy, ux) * 180 / Math.PI}deg)`;
    }
    if (nodes.rot) { nodes.rot.style.left = rp.x + 'px'; nodes.rot.style.top = rp.y + 'px'; }
  }

  // Axis-aligned native AABB of a multi-selection (rotation-aware), from live DOM
  // rects during a gesture else from the model.
  function groupAABBNative(idx: number[], boxes: Box[], liveRects: Map<number, Rect> | null): Bounds {
    let a: Bounds | null = null;
    for (const i of idx) {
      const r = (liveRects && liveRects.get(i)) || boxRect(boxes[i], cfg);
      for (const p of boxCorners(rectAsBox(r), cfg)) {
        a = a
          ? { minX: Math.min(a.minX, p.x), minY: Math.min(a.minY, p.y), maxX: Math.max(a.maxX, p.x), maxY: Math.max(a.maxY, p.y) }
          : { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
      }
    }
    return a || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  // Group/multi-selection chrome: an axis-aligned box with 4 corner handles
  // (uniform scale) + a rotate handle. Nodes are built by buildChrome; this only
  // repositions the group outline, the 4 corner handles (nw,ne,se,sw order) and the
  // rotate stem/handle.
  function positionGroupHandles(a: Bounds, m: Metrics): void {
    const nodes = chromeNodes;
    if (!nodes) return;
    const corners: Record<Corner, Point> = {
      nw: nativeToStage(a.minX, a.minY, m), ne: nativeToStage(a.maxX, a.minY, m),
      se: nativeToStage(a.maxX, a.maxY, m), sw: nativeToStage(a.minX, a.maxY, m),
    };
    if (nodes.groupOutline) {
      nodes.groupOutline.style.left = corners.nw.x + 'px';
      nodes.groupOutline.style.top = corners.nw.y + 'px';
      nodes.groupOutline.style.width = (corners.ne.x - corners.nw.x) + 'px';
      nodes.groupOutline.style.height = (corners.sw.y - corners.nw.y) + 'px';
    }
    (['nw', 'ne', 'se', 'sw'] as Corner[]).forEach((name, k) => {
      const el = nodes.handles[k]!;
      el.style.left = corners[name].x + 'px';
      el.style.top = corners[name].y + 'px';
    });
    const bc = { x: (corners.sw.x + corners.se.x) / 2, y: (corners.sw.y + corners.se.y) / 2 };
    if (nodes.stem) {
      nodes.stem.style.left = bc.x + 'px'; nodes.stem.style.top = bc.y + 'px';
      nodes.stem.style.width = '30px'; nodes.stem.style.transform = 'rotate(90deg)';
    }
    if (nodes.rot) { nodes.rot.style.left = bc.x + 'px'; nodes.rot.style.top = (bc.y + 30) + 'px'; }
  }

  const CORNER_PT = (a: Bounds, name: Corner): Point => ({
    nw: { x: a.minX, y: a.minY }, ne: { x: a.maxX, y: a.minY },
    se: { x: a.maxX, y: a.maxY }, sw: { x: a.minX, y: a.maxY },
  } as Record<Corner, Point>)[name];
  const OPPOSITE: Record<Corner, Corner> = { nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' };

  function onGroupHandleDown(e: PointerEvent, name: Corner | 'rotate'): void {
    e.stopPropagation();
    if (e.button > 0) return;
    const boxes = getBoxes();
    const sel = selIndices(boxes);
    if (sel.length < 2) return;
    const a = groupAABBNative(sel, boxes, null);
    const centre = { x: (a.minX + a.maxX) / 2, y: (a.minY + a.maxY) / 2 };
    if (name === 'rotate') {
      const m = metrics();
      const cs = nativeToStage(centre.x, centre.y, m);
      const centerClient = { x: cs.x + m.sr.left, y: cs.y + m.sr.top };
      const pointerStartDeg = Math.atan2(e.clientY - centerClient.y, e.clientX - centerClient.x) * 180 / Math.PI;
      beginGesture(e, { type: 'grotate', sel, startBoxes: boxes, centre, centerClient, pointerStartDeg });
    } else {
      const anchor = CORNER_PT(a, OPPOSITE[name]);
      const origDist = Math.hypot(CORNER_PT(a, name).x - anchor.x, CORNER_PT(a, name).y - anchor.y) || 1;
      beginGesture(e, { type: 'gscale', sel, startBoxes: boxes, anchor, origDist });
    }
  }

  /**
   * The fixed stage chrome the contextual bar has to keep off, in STAGE coordinates:
   * the zoom HUD top-right (`.stage-nav`) and the back pill top-left
   * (`.tools-home`, which is `position: fixed` and therefore lives outside the stage
   * in the DOM but squarely on top of it on screen). Measured, never assumed — a
   * hard-coded HUD width goes stale the first time the theme/sound toggles or the
   * type multiplier change it, and the back pill's label is the view's own name.
   *
   * Cached for the life of a gesture beside `gestureMetrics`, for the same reason: two
   * more forced layouts per drag frame buy nothing, and this chrome cannot move while a
   * box is being dragged.
   */
  let ctxBlockers: StageBox[] | null = null;
  /** The placement held for the life of a box gesture (see positionCtxBar). */
  let ctxFrozen: { left: number; top: number } | null = null;
  function ctxBarBlockers(sr: DOMRect): StageBox[] {
    if (ctxBlockers && gesture) return ctxBlockers;
    const out: StageBox[] = [];
    for (const el of [stageEl.querySelector<HTMLElement>('.stage-nav'),
                      ...Array.from(document.querySelectorAll<HTMLElement>('.tools-home'))]) {
      if (!el || el.hidden || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ left: r.left - sr.left, top: r.top - sr.top, right: r.right - sr.left, bottom: r.bottom - sr.top });
    }
    ctxBlockers = gesture ? out : null;
    return out;
  }

  function positionCtxBar(boxes: Box[], idx: number[], liveRects: Map<number, Rect> | null, m: Metrics): void {
    if (editing) { hideCtxBar(); return; }   // hidden while typing in a box
    showCtxBar();
    // Pinned to the top chrome row (never over the selection, whose artwork the user is
    // looking at), centred in the band between the back pill and the zoom HUD and capped
    // to it — a bar too wide for a narrow phone row scrolls inside that width (see the
    // `.fc-ctxbar` overflow) instead of dropping down over the canvas.
    const band = ctxTopBand({ w: m.sr.width, h: m.sr.height }, ctxBarBlockers(m.sr));
    ctxbar.style.maxWidth = Math.max(0, band.hi - band.lo) + 'px';
    // Measured AFTER the bar is shown and its max-width is set, so `offsetWidth` reflects
    // a laid-out, capped bar rather than the zero a `hidden` element reports. A zero here
    // would paint the first frame off-centre and then snap; leave the last position alone
    // and come back next frame instead.
    const bw = ctxbar.offsetWidth || 0;
    if (bw > 0) {
      // Frozen for the life of a box gesture: the transform readout grows mid-drag
      // ("241, -235" → "113, -92 · 1920×1080"), which would re-centre the bar and walk
      // its controls sideways. It re-places on release; the readout itself keeps updating.
      const pos = liveRects && ctxFrozen ? ctxFrozen : centreCtxBar(bw, band);
      ctxFrozen = liveRects ? pos : null;
      ctxbar.style.left = pos.left + 'px';
      ctxbar.style.top = pos.top + 'px';
    }
    // Transform readout.
    const first = boxes[idx[0]!];
    const r = liveRects?.get(idx[0]!) || boxRect(first, cfg);
    const read = ctxbar.querySelector('[data-cx-readout]');
    if (read) read.textContent = idx.length > 1
      ? t('{n} selected', { n: idx.length })
      : `${Math.round(r.x)}, ${Math.round(r.y)}  ·  ${Math.round(r.w)}×${Math.round(r.h)}${r.rot ? '  ·  ' + Math.round(r.rot) + '°' : ''}`;
  }

  function updateToolbarState(count: number): void {
    // Nothing hard-disabled — align-to-canvas works on a single box; arrange/delete
    // no-op when empty. Just reflect which tool is live, and whether the layout
    // options have anything to act on.
    syncModeUI();
    syncArrangeUI();
  }
  /** The Arrange button is layout options for a SELECTION — no selection, no button.
   *  Hidden rather than disabled: an always-there control whose whole menu no-ops is
   *  what made "arrange" read as broken. Nothing else reaches these actions through
   *  it (right-click and the keyboard are unchanged), so hiding it removes no path. */
  function syncArrangeUI(): void {
    if (arrangeBtn) arrangeBtn.hidden = selection.size === 0;
  }

  // ── helpers ───────────────────────────────────────────────────────────────────
  const rectAsBox = (r: Rect): Box => ({ [cfg.xField]: r.x, [cfg.yField]: r.y, [cfg.wField]: r.w, [cfg.hField]: r.h, [cfg.rotationField]: r.rot });
  function rotOf(el: HTMLElement): number {
    const t = el.style.transform || '';
    const mm = t.match(/rotate\(([-0-9.]+)deg\)/);
    return mm ? parseFloat(mm[1]!) : 0;
  }
  function normHex(v: any, fallback = '#ffffff'): string {
    const s = String(v == null ? '' : v).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    return fallback;
  }
  function cssEscape(s: any): string {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  }
  // Finite number clamped to [lo,hi], or the default when not a number.
  function clampN(v: any, dflt: number, lo: number, hi: number): number {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n)) return dflt;
    return n < lo ? lo : (n > hi ? hi : n);
  }
  // Delegates to the canonical 5-char escape (utils.ts) — this used to hand-roll a 4-char
  // (no `'`) escape, safe only by accident of every call site using double-quoted attrs.
  function escapeHtml(s: any): string { return escape(s); }
  function fmtDate(iso: any): string {
    try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
    catch { return String(iso); }
  }

  // ── keyboard ─────────────────────────────────────────────────────────────────
  // Shadow-aware: jelly text fields keep their real <input> in a shadow root, so a
  // host-only tagName test reads as "not typing" and shortcuts eat the keystroke.
  function typingTarget(): boolean {
    return isTypingTarget();
  }
  // Keyboard focus on a card selects it, so Tab / Shift-Tab cycle the cards and the onKey
  // actions (Delete, arrows, duplicate, group…) apply. Pointer focus is ignored here —
  // pointerdown already owns pointer selection (and would clobber shift-click multi-select).
  function onBoxFocus(e: FocusEvent): void {
    if (gesture || editing) return;
    const el = (e.target as HTMLElement | null)?.closest?.('.lolly-box[data-box-id]') as HTMLElement | null;
    if (!el || !el.matches(':focus-visible')) return;
    const id = el.getAttribute('data-box-id');
    if (!id || (selection.size === 1 && selection.has(id))) return;
    selection = new Set([id]);
    renderChrome();
  }
  /**
   * Does this press CHANGE the selected boxes? The keyboard half of the one rule gates
   * on exactly this set and nothing else, so navigation (Tab, ⌘A, the tool letters) and
   * every escape route stay live on an off-playhead selection.
   *
   * The list mirrors onKey's own mutating branches below: arrow nudge, delete, the
   * text-edit entry (Enter/F2 — starting a text edit on a box nobody can see is the
   * same mistake in slow motion), duplicate, group/ungroup, and z-order.
   */
  function isMutatingKey(e: KeyboardEvent): boolean {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') return true;
    if (k === 'Delete' || k === 'Backspace') return true;
    if (k === 'Enter' || k === 'F2') return true;
    if (!(e.metaKey || e.ctrlKey)) return false;
    return k === 'd' || k === 'D' || k === 'g' || k === 'G' || k === ']' || k === '[';
  }
  function onKey(e: KeyboardEvent): void {
    if (disposed) return;
    // The timeline panel binds its keys on its OWN root and owns them while focus is
    // inside it (deck-editor's `.deck-strip, .deck-bar…` bail). Without this, Delete /
    // arrows / ⌘A / Enter typed at a clip would also hit the canvas selection.
    if (timelinePanel && (document.activeElement as HTMLElement | null)?.closest?.('.tl-panel')) return;
    // ── Escape: ONE ladder, innermost rung first, one rung per press ───────────
    // Escape is exempt from the typing bail below on purpose: it is how you get out of a
    // text edit too (onEditKey owns that and stops here).
    //
    // The rule that matters is that a rung only swallows the key if it actually DID
    // something. The old first rung returned on a merely non-null `popover` / `morePanel`
    // reference, so a reference left pointing at a detached element silently ate the next
    // Escape — the reported "Esc does not leave point editing". A floating surface that is
    // no longer in the document is not a rung.
    if (e.key === 'Escape') {
      // Rung 1 stays the colour popover — it is the innermost surface, and it can be
      // open over the gradient panel while picking a stop's brand swatch.
      if (stageEl.querySelector('.color-popover:not([hidden])') && dismissFloating()) { e.preventDefault(); return; }
      // Gradient editing is a MODE like point editing, and its panel is part of it:
      // closing just the panel left the handles up with no way back to it (the toolbar
      // button now reads as "leave"), so Escape takes the whole mode.
      if (gradEdit != null) { e.preventDefault(); closeMorePanel(); exitGradEdit(); return; }
      if (dismissFloating()) { e.preventDefault(); return; }
      // Cancel, not commit: a draft dies here and Enter (or a tool switch) is what keeps it.
      if (penDraft) { e.preventDefault(); penCancelDraw(); return; }
      // Point editing ends and the rail is already the pointer, since it never left it.
      if (penEdit) { e.preventDefault(); endPenEdit(); return; }
      if (mode !== 'select') { e.preventDefault(); toPointer('discard'); return; }
      if (selectedEdges.size) { e.preventDefault(); deselectEdge(); return; }
      if (selection.size) { e.preventDefault(); selection = new Set<string>(); renderChrome(); return; }
      return;                       // nothing left to back out of — leave the key alone
    }
    // ── the pen's other keys ───────────────────────────────────────────────────
    // Each already means something on a box, so the pen takes them only while it is
    // actually on, and hands them straight back when it is not. The split follows the
    // meanings already in this handler rather than redefining them:
    //   Enter   — "commit the thing you are in the middle of", as it commits a text edit;
    //             it finishes the drawn path and leaves point editing.
    //   Delete/Backspace — "remove what is selected", so it drops the last placed node
    //             while drawing and the selected nodes while editing, never the box.
    if ((penDraft || penEdit) && !typingTarget()) {
      if (penDraft) {
        if (e.key === 'Enter') { e.preventDefault(); penFinishDraw(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); penUndoNode(); return; }
      } else if (penEdit) {
        if (e.key === 'Enter') { e.preventDefault(); endPenEdit(); return; }
        if ((e.key === 'Delete' || e.key === 'Backspace') && penSel.size) { e.preventDefault(); penDeleteSelected(); return; }
        if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          penSel = new Set(penEdit.path.nodes.map((_, i) => i));
          ctxSelKey = null;
          renderChrome();
          return;
        }
      }
    }
    if (typingTarget()) return;
    // ── THE ONE RULE, enforcement point 3 of 3: KEYBOARD ────────────────────────
    // Chrome suppression closes every POINTER path onto an off-playhead box; a nudge,
    // a Delete or a duplicate needs no chrome at all. Navigation stays live on purpose
    // — Tab still moves, Escape (handled above, before this gate) still deselects, and
    // ⌘A still selects all — because the way out of this state must never be blocked.
    if (timeCfg && selection.size && isMutatingKey(e) && !selectionLive(getBoxes())) {
      e.preventDefault();
      announce(t('This card is not on screen at the playhead. Go to it to edit it.'));
      return;
    }
    // Tool shortcuts, the Illustrator/Figma letters: V pointer, P pen. Unmodified only —
    // ⌘V is paste and ⌘P is print — and after `typingTarget()`, so a live text edit or any
    // focused field gets the letter typed into it instead. Neither letter meant anything
    // here before (the only unmodified keys taken are Escape/Enter/F2/Delete/arrows, and
    // tool-stage-nav's 0/1/+/-).
    if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      pickPointer();
      return;
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'p' || e.key === 'P') && cfg.pathField) {
      e.preventDefault();
      if (mode !== 'pen') setMode('pen');
      return;
    }
    // N — the Node tool (Inkscape's key). Toggles direct node editing on the selection.
    if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'n' || e.key === 'N') && cfg.pathField) {
      e.preventDefault();
      toggleNodeTool();
      return;
    }
    // Enter / F2 on a selected box → edit its text (select-all so typing replaces it).
    if ((e.key === 'Enter' || e.key === 'F2') && !editing && selection.size && cfg.textField) {
      e.preventDefault();
      startTextEdit([...selection][0]!, { selectAll: e.key === 'Enter' });
      return;
    }
    // In gradient mode the selected thing is a STOP, so Delete removes that — deleting
    // the whole card here would be a nasty surprise mid-gradient. Falls through when the
    // gradient is down to its last two stops (deleteGradStop refuses and says so).
    if ((e.key === 'Delete' || e.key === 'Backspace') && gradEdit != null) {
      e.preventDefault();
      if (!deleteGradStop()) announce(t('A gradient needs at least two stops.'));
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEdges.size) { e.preventDefault(); deleteSelectedEdge(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) { e.preventDefault(); deleteSelection(); return; }
    if ((e.key === 'd' || e.key === 'D') && (e.metaKey || e.ctrlKey) && selection.size) { e.preventDefault(); duplicateSelection(); return; }
    if ((e.key === 'g' || e.key === 'G') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.shiftKey ? ungroupSelection() : groupSelection(); return; }
    // Stacking order (Illustrator/Figma convention): Cmd/Ctrl + ] forward, + [ back;
    // add Shift to jump all the way to front / back. (Undo/redo is handled globally
    // by tool.js's onHistoryKey — Cmd+Z / Cmd+Shift+Z / Cmd+Y — and reaches the editor
    // because every edit commits through runtime.setInput, which the undo wrapper
    // records; nothing extra is needed here.)
    if ((e.key === ']' || e.key === '[') && (e.metaKey || e.ctrlKey) && selection.size) {
      e.preventDefault();
      if (e.key === ']') applyZ(e.shiftKey ? 'front' : 'forward');
      else applyZ(e.shiftKey ? 'back' : 'backward');
      return;
    }
    if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const boxes = getBoxes();
      selection = new Set(boxes.map((b, i) => idOf(b, i)));
      renderChrome();
      return;
    }
    // Arrow-nudge (Shift = 10px).
    const nudges: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (nudges[e.key] && selection.size) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1);
      const [ux, uy] = nudges[e.key]!;
      const boxes = getBoxes();
      // Same containment+cascade path as the pointer-drag move (see g.type === 'move'):
      // nudging a frame-kind box must carry its members in the SAME commit, and any box
      // whose centre crosses a frame edge must re-bucket. cascadeFrameChildren + assignFrames
      // over the selected indices only — no-op on frameless tools (Layout Studio), so a
      // no-frame nudge stays byte-identical to the old moveBoxes-only path.
      const idx = selIndices(boxes);
      commit(assignFrames(cascadeFrameChildren(boxes, moveBoxes(boxes, idx, ux * step, uy * step, cfg), idx), new Set(idx)));
    }
  }

  // ── wiring ────────────────────────────────────────────────────────────────────
  // Two-finger-tap recognition — capture phase, so a second finger is already recorded by
  // the time the canvas's own pointerdown handler runs (see onCanvasPointerDown).
  stageEl.addEventListener('pointerdown', onStageTouchDown, true);
  stageEl.addEventListener('pointermove', onStageTouchMove, true);
  stageEl.addEventListener('pointerup', onStageTouchUp, true);
  stageEl.addEventListener('pointercancel', onStageTouchUp, true);
  canvasEl.addEventListener('pointerdown', onCanvasPointerDown);
  stageEl.addEventListener('pointerdown', onBackdropPointerDown);   // deselect/marquee on backdrop
  viewEl.addEventListener('pointerdown', onBackdropPointerDown);
  stageEl.addEventListener('contextmenu', onBackdropContextMenu);
  viewEl.addEventListener('contextmenu', onBackdropContextMenu);
  window.addEventListener('keydown', onSpaceKey);
  window.addEventListener('keyup', onSpaceKey);
  canvasEl.addEventListener('pointermove', onGestureMove);
  canvasEl.addEventListener('pointerup', onGestureEnd);
  canvasEl.addEventListener('pointercancel', onGestureEnd);
  canvasEl.addEventListener('dblclick', onDblClick);
  canvasEl.addEventListener('contextmenu', onContextMenu);
  canvasEl.addEventListener('focusin', onBoxFocus);
  // While the editor is mounted, un-clip the canvas (and the tool's own clipping
  // root inside it) so boxes dragged off the artboard stay visible + selectable —
  // their DOM still lives inside canvasEl, so clicks bubble to the handlers above.
  // Export semantics are unchanged: the raster capture is bounded by the canvas
  // rect, and the vector walkers' out-of-viewBox geometry never paints.
  canvasEl.classList.add('fc-open-canvas');
  window.addEventListener('keydown', onKey);
  document.addEventListener('paste', onGlobalPaste);
  document.addEventListener('copy', onCopy);
  // Reposition chrome when the stage pans/zooms/resizes.
  // Geometry changed (pan/zoom/resize) — invalidate the metrics cache and mark the
  // frame scrim for repositioning (M2: paintChrome only moves the scrim when this is
  // set, so drag/hover/selection syncs skip the 100vmax shadow repaint).
  const onStageMove = (e: any): void => { gestureMetrics = null; ctxBlockers = null; scrimDirty = true; if (e && typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY }; scheduleSync(); reclampRail(); if (connectLayer.style.display !== 'none') placeConnectLayer(metrics()); };
  // pointermove fires continuously while the cursor merely HOVERS the canvas. The old
  // handler rebuilt the whole selection chrome (2 getBoundingClientRect + innerHTML swap
  // + 10 handle nodes re-bound) every frame for zero visual change. Here we only track
  // the paste-at-cursor position; a real pan (buttons held) still re-syncs, and pan/zoom
  // via the transform is already caught by the MutationObserver below — so an idle hover
  // costs nothing.
  const onStagePointerMove = (e: any): void => {
    if (e && typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY };
    // Pen: the segment from the last placed node to the cursor, previewed live. Only while
    // no gesture is running — mid-drag the pointer is pulling a handle, not proposing a
    // node. Works for `pointerType: 'touch'` too: a touch drag reports `buttons` while
    // down, so this only fires between taps and never fights stageNav's pan/pinch.
    if (mode === 'pen' && penDraft && !gesture && e && typeof e.clientX === 'number' && !e.buttons) {
      penCursor = clientToNative(e.clientX, e.clientY);
      paintPen();
      return;
    }
    // Hover affordance over connector lines (idle hover only, throttled to one rAF/frame).
    if (connectCfg && !selectedEdges.size && !gesture && e && !e.buttons && typeof e.clientX === 'number') {
      if (!hoverRaf) hoverRaf = requestAnimationFrame(updateHover);
    }
    if (e && e.buttons) scheduleSync();
  };
  stageEl.addEventListener('pointermove', onStagePointerMove, { passive: true });
  stageEl.addEventListener('wheel', onStageMove, { passive: true });
  window.addEventListener('resize', onStageMove);
  const ro = new ResizeObserver(onStageMove);
  ro.observe(stageEl);
  // Keyboard/HUD zoom (setupStageNav's − / + / 0 / 1 / Fit) changes the canvas
  // wrapper's transform with NO pointer or wheel event — watch the wrapper's
  // style attribute so the selection chrome follows those zooms too.
  const mo = new MutationObserver(onStageMove);
  if (canvasEl.parentElement) mo.observe(canvasEl.parentElement, { attributes: true, attributeFilter: ['style'] });
  // Re-sync after every model change (paint()).
  const unsub = runtime.subscribe(() => scheduleSync());
  // Dismiss popover / more-panel on outside click.
  const onDocDown = (e: PointerEvent): void => {
    if (popover && !popover.contains(e.target as Node)) closePopover();
    // The colour popover is a companion of the panel, not an outside click: the whole
    // point of the gradient panel is to pick stop colours from the brand palette, and
    // closing the panel the moment you reached for a swatch made that a two-click
    // dance. `[data-cx="grad"]` is exempt for the same reason as `more`/`text` — the
    // button that opens a panel must not immediately close it.
    const t = e.target as HTMLElement;
    // Everything that IS the gradient-editing surface: the button that opens the panel,
    // the on-canvas handles, and the colour popover the panel sends you to for a brand
    // swatch. None of those are an "outside click" — treating the handles as one closed
    // the panel the instant you selected a stop.
    const companion = t.closest?.(
      '[data-cx="more"],[data-cx="text"],[data-cx="grad"],.color-popover,[data-color-field],.fc-grad-stop,.fc-grad-dir');
    if (morePanel && !morePanel.contains(e.target as Node) && !companion) closeMorePanel();
  };
  document.addEventListener('pointerdown', onDocDown, true);

  renderChrome();

  // A composition that already has timing opens with its timeline showing; an empty
  // (or untimed) one leaves the stage whole until the user asks for it from the rail.
  if (timeCfg && anyTimed(getBoxes())) openTimeline();

  // Universal drop front door (lib/drop-router.ts): a design file dropped on the
  // gallery/dashboard was stashed one-shot and is consumed here on mount, through
  // the exact same lazy parseDesignFile → commit path as the Import panel above.
  const pendingImport = importCfg ? takePendingDesignImport() : null;
  if (pendingImport) {
    void (async () => {
      announce(t('Importing…'));
      try {
        if (importScenesMode) {
          // Sequence editor: the dropped design's frames become timed scenes.
          const n = await importAsScenes(pendingImport, (m: string) => announce(m));
          if (disposed) return;
          announce(n === 1 ? t('Added 1 scene.') : t('Added {n} scenes.', { n }));
          return;
        }
        const { parseDesignFile } = await import('./design-import.ts');
        const res = await parseDesignFile(pendingImport, {
          host: host as any, log: (m: string) => announce(m), interactive: true, map: importMap,
        });
        if (disposed) return;
        const boxes = (Array.isArray(res.boxes) ? res.boxes : []) as Box[];
        if (!boxes.length) throw new Error(t('Nothing importable was found in that file.'));
        selection = new Set<string>();
        commit(boxes);
        if (setCanvasSize && res.width > 0 && res.height > 0) setCanvasSize(res.width, res.height, 'px');
        announce(boxes.length === 1 ? t('Imported 1 object.') : t('Imported {n} objects.', { n: boxes.length }));
      } catch (err) {
        if (!disposed) announce(((err as Error)?.message) || t('Import failed.'), { assertive: true });
      }
    })();
  }

  return {
    destroy() {
      disposed = true;
      // FIRST, so nothing that throws later in this teardown can leave the stage's
      // bottom band reserved for a panel that no longer exists.
      destroyTimeline();
      finishEdit();
      if (flashTimer) clearTimeout(flashTimer);
      stageEl.removeEventListener('pointerdown', onStageTouchDown, true);
      stageEl.removeEventListener('pointermove', onStageTouchMove, true);
      stageEl.removeEventListener('pointerup', onStageTouchUp, true);
      stageEl.removeEventListener('pointercancel', onStageTouchUp, true);
      canvasEl.removeEventListener('pointerdown', onCanvasPointerDown);
      stageEl.removeEventListener('pointerdown', onBackdropPointerDown);
      viewEl.removeEventListener('pointerdown', onBackdropPointerDown);
      stageEl.removeEventListener('contextmenu', onBackdropContextMenu);
      viewEl.removeEventListener('contextmenu', onBackdropContextMenu);
      window.removeEventListener('keydown', onSpaceKey);
      window.removeEventListener('keyup', onSpaceKey);
      canvasEl.removeEventListener('pointermove', onGestureMove);
      canvasEl.removeEventListener('pointerup', onGestureEnd);
      canvasEl.removeEventListener('pointercancel', onGestureEnd);
      canvasEl.removeEventListener('dblclick', onDblClick);
      canvasEl.removeEventListener('contextmenu', onContextMenu);
      canvasEl.removeEventListener('focusin', onBoxFocus);
      window.removeEventListener('keydown', onKey);
      toolbar.removeEventListener('pointerdown', onRailDown);
      toolbar.removeEventListener('pointermove', onRailMove);
      toolbar.removeEventListener('pointerup', onRailUp);
      toolbar.removeEventListener('pointercancel', onRailUp);
      toolbar.removeEventListener('lostpointercapture', onRailUp);
      if (railRaf) { cancelAnimationFrame(railRaf); railRaf = 0; }
      document.removeEventListener('paste', onGlobalPaste);
      document.removeEventListener('copy', onCopy);
      stageEl.removeEventListener('pointermove', onStagePointerMove);
      stageEl.removeEventListener('wheel', onStageMove);
      window.removeEventListener('resize', onStageMove);
      document.removeEventListener('pointerdown', onDocDown, true);
      ro.disconnect();
      mo.disconnect();
      dirtyObserver?.disconnect();
      unsub?.();
      canvasEl.classList.remove('fc-open-canvas');
      stageEl.classList.remove('fc-penning', 'fc-node-editing');
      overlay.remove(); toolbarDock.remove(); closePopover(); closeMorePanel(); closeEdgePanel();
      document.body.classList.remove('fc-manipulating');
    },
  };
}
