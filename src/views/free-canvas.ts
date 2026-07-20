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

import {
  boxRect, withRect, boxCorners, rectCentre, hitTest, marqueeHit, boxAABB,
  moveBoxes, resizeRect, alignBoxes, distributeBoxes, reorderZ,
  seedBox, normDragRect, snapAngle, normAngle, clampBoxToCanvas, selectionAABB,
  snapMove, snapPoint, scaleGroup, rotateGroup, num,
  edgeBorderPt, edgeWaypoints, edgeNested, roundedEdgePath, smoothEdgePath,
} from './free-canvas-math.ts';
import type { ZOp, AlignEdge, Axis, AABB as MathAABB, Rect as MathRect, EdgeRect, Box } from './free-canvas-math.ts';
import { toCssPx } from '@lolly/engine';
import type { InputValue } from '../../../../engine/src/inputs.ts';
import { askLollyIntent } from './picker.ts';
import { takePendingDesignImport } from '../lib/drop-router.ts';
import { announce } from '../a11y.ts';
import { escape } from '../utils.ts';
import { t } from '../i18n.ts';
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
  fillField?: string; opacityField?: string; shapeField?: string;
  radiusField?: string; imageField?: string; fitField?: string; imgPosField?: string;
  blendField?: string; textField?: string; textColorField?: string;
  fontSizeField?: string; alignField?: string; valignField?: string;
  weightField?: string; fontField?: string; lineHeightField?: string;
  trackingField?: string; ligaturesField?: string; alternatesField?: string;
  padField?: string; groupField?: string; clipField?: string;
  shadowField?: string; shadowColorField?: string;
  shadowXField?: string; shadowYField?: string; shadowBlurField?: string;
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
  fillField: string; opacityField: string; shapeField: string;
  radiusField: string; imageField: string; fitField: string; imgPosField: string;
  blendField: string; textField: string; textColorField: string;
  fontSizeField: string; alignField: string; valignField: string;
  weightField: string; fontField: string; lineHeightField: string;
  trackingField: string; ligaturesField: string; alternatesField: string;
  padField: string; groupField: string; clipField: string;
  shadowField: string; shadowColorField: string;
  shadowXField: string; shadowYField: string; shadowBlurField: string;
  kindField: string;
}

interface ModelItem { id: string; value: any }
interface RuntimeApi {
  getModel(): ModelItem[];
  setInput(id: string, value: any): void;
  subscribe(fn: () => void): (() => void) | void;
}
interface HostApi { assets?: { pick(opts: any): Promise<any> } }
interface DocInfo {
  getFilename?(): string;
  setFilename?(name: string): void;
  lastEdited?(): string | Promise<string> | null | undefined;
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
}

interface PagesCfg {
  countField: string;   // input id: page count
  widthField: string;   // input id: page width (px)
  heightField: string;  // input id: page height (px)
  min: number;
  max: number;
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
interface PopAction { sep?: undefined; grid?: undefined; label: string; icon?: string; run(): void; disabled?: boolean; danger?: boolean; keepOpen?: boolean }
type PopItem = PopSep | PopGrid | PopAction;

// Gesture state — filled in by beginGesture with pointerId/startClient.
interface GestureBase { pointerId: number; startClient: Point; origin?: Point }
interface TapGesture extends GestureBase { type: 'tap' }
interface MarqueeGesture extends GestureBase { type: 'marquee'; origin: Point; additive: boolean }
interface CreateGesture extends GestureBase { type: 'create'; origin: Point; seed: Box; others: AABB[]; corner?: Point }
interface MoveGesture extends GestureBase { type: 'move'; start: Map<number, Rect>; sel: number[]; selAABB: AABB | null; others: AABB[]; moveDelta?: { dx: number; dy: number } }
interface ResizeGesture extends GestureBase { type: 'resize'; index: number; handle: HandleName; startRect: Rect; others: AABB[]; liveRect?: Rect }
interface RotateGesture extends GestureBase { type: 'rotate'; index: number; startRect: Rect; centerClient: Point; pointerStartDeg: number; liveRect?: Rect }
interface GScaleGesture extends GestureBase { type: 'gscale'; sel: number[]; startBoxes: Box[]; anchor: Point; origDist: number; liveBoxes?: Box[] }
interface GRotateGesture extends GestureBase { type: 'grotate'; sel: number[]; startBoxes: Box[]; centre: Point; centerClient: Point; pointerStartDeg: number; liveBoxes?: Box[] }
type Gesture = TapGesture | MarqueeGesture | CreateGesture | MoveGesture | ResizeGesture | RotateGesture | GScaleGesture | GRotateGesture;
type FilledBaseFields = 'pointerId' | 'startClient';
type GestureInit =
  | Omit<TapGesture, FilledBaseFields>
  | Omit<MarqueeGesture, FilledBaseFields>
  | Omit<CreateGesture, FilledBaseFields>
  | Omit<MoveGesture, FilledBaseFields>
  | Omit<ResizeGesture, FilledBaseFields>
  | Omit<RotateGesture, FilledBaseFields>
  | Omit<GScaleGesture, FilledBaseFields>
  | Omit<GRotateGesture, FilledBaseFields>;

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
  // Connect mode — two nodes joined by a link (start linking cards).
  connect: '<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="M8 8l8 8"/>',
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
};

function icon(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

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
  const { viewEl, stageEl, canvasEl, runtime, host, input, nativeW, nativeH, onDirty, editTool, setCanvasSize, info, history, actions, pages } = opts;
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
    fillField: cv.fillField, opacityField: cv.opacityField, shapeField: cv.shapeField,
    radiusField: cv.radiusField, imageField: cv.imageField, fitField: cv.fitField, imgPosField: cv.imgPosField,
    blendField: cv.blendField, textField: cv.textField, textColorField: cv.textColorField,
    fontSizeField: cv.fontSizeField, alignField: cv.alignField, valignField: cv.valignField,
    weightField: cv.weightField, fontField: cv.fontField, lineHeightField: cv.lineHeightField,
    trackingField: cv.trackingField, ligaturesField: cv.ligaturesField, alternatesField: cv.alternatesField,
    padField: cv.padField, groupField: cv.groupField, clipField: cv.clipField,
    shadowField: cv.shadowField, shadowColorField: cv.shadowColorField,
    shadowXField: cv.shadowXField, shadowYField: cv.shadowYField, shadowBlurField: cv.shadowBlurField,
    kindField: 'kind',
  }) as FieldCfg;
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
    return s && fontOptions.some((o) => o.value === s) ? stackOf(s) : stackOf(defaultFont);
  };
  const fontOptionsHtml = (cur?: any): string => fontOptions.map((o) =>
    `<option value="${escapeHtml(o.value)}"${String(cur) === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
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
  // Opt-in snap-to-grid. gridOn is toggled from the rail; gridSize is native px.
  const gridSize = Math.max(2, Math.round(cv.grid?.size ?? 20));
  let gridOn = !!(cv.grid && cv.grid.default !== false);

  // ── state ──────────────────────────────────────────────────────────────────
  let selection = new Set<string>();   // box ids
  let multiTapMode = false;            // touch: taps ADD to the selection (Group/Align need ≥2)
  let armedKind: AddKind | null = null;        // seed for the add-box create gesture
  let gesture: Gesture | null = null;          // active pointer gesture
  let editing: EditingState | null = null;     // { id, el, prev } while editing a box's text inline
  let disposed = false;
  let armedConnect = false;                    // Connect mode is on (click cards to link)
  let connectSource: string | null = null;     // the pending source box id while linking
  let liveConnectHidden = false;                // the tool's real connector layer is hidden mid-drag
  let selectedEdges = new Set<string>();        // connector ids being inspected (click / shift-click / marquee)
  let edgePanel: HTMLElement | null = null;     // the connector-properties popover
  let hoverEdge: string | null = null;          // connector id under the cursor (hover affordance)
  let hoverRaf = 0;

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
  function freshEdgeId(edges: Box[]): string {
    const used = new Set(edges.map((e, i) => (e && e.id != null && e.id !== '' ? String(e.id) : String(i))));
    let id: string;
    do { id = 'e' + (Date.now().toString(36).slice(-4)) + (idSeq++).toString(36) + Math.floor(Math.random() * 46656).toString(36); }
    while (used.has(id));
    return id;
  }
  // Add an edge from→to, or remove it if one already joins the two boxes (either way).
  function toggleEdge(from: string, to: string): void {
    if (!connectCfg || from === to) return;
    const edges = getEdges();
    const ff = connectCfg.fromField!, tf = connectCfg.toField!;
    const at = edges.findIndex((e) => {
      const a = String(e?.[ff]), b = String(e?.[tf]);
      return (a === from && b === to) || (a === to && b === from);
    });
    if (at >= 0) { commitEdges(edges.filter((_, i) => i !== at)); return; }
    const ne: Box = { id: freshEdgeId(edges), [ff]: from, [tf]: to };
    if (connectCfg.styleField) ne[connectCfg.styleField] = connectCfg.defaultStyle;
    if (connectCfg.arrowField) ne[connectCfg.arrowField] = connectCfg.defaultArrow;
    if (connectCfg.dashField) ne[connectCfg.dashField] = 'solid';
    if (connectCfg.colorField) ne[connectCfg.colorField] = connectCfg.defaultColor;
    if (connectCfg.headField) ne[connectCfg.headField] = connectCfg.defaultHead;
    if (connectCfg.widthField && connectCfg.defaultWidth != null) ne[connectCfg.widthField] = connectCfg.defaultWidth;
    commitEdges([...edges, ne]);
  }
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
  const frameOffsetOfEl = (el: Element): Point => {
    // No pages config ⇒ no [data-pdf-page] frames exist, so skip the ancestor walk
    // entirely (single-page editors like Layout Studio hit this every gesture frame).
    if (!pages) return { x: 0, y: 0 };
    const f = el.closest?.('[data-pdf-page]') as HTMLElement | null;
    return f ? { x: f.offsetLeft, y: f.offsetTop } : { x: 0, y: 0 };
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

  const chrome = document.createElement('div');   // selection outlines + handles
  chrome.className = 'fc-chrome';
  overlay.appendChild(chrome);

  const ctxbar = document.createElement('div');    // contextual controls
  ctxbar.className = 'fc-ctxbar';
  ctxbar.hidden = true;
  ctxbar.addEventListener('pointerdown', (e) => e.stopPropagation());
  overlay.appendChild(ctxbar);
  let ctxSelKey: string | null = null;   // sorted selected-id signature; rebuild ctxbar when it changes

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

  // Dock wrapper flex-centres the rail without a transform on the rail itself
  // (a transform/backdrop-filter there would capture its colour popover's fixed
  // positioning — see the .fc-toolbar-dock CSS note).
  const toolbarDock = document.createElement('div');
  toolbarDock.className = 'fc-toolbar-dock';
  toolbarDock.setAttribute('data-export-hide', '');
  const toolbar = document.createElement('div');
  toolbar.className = 'fc-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', t('Editor tools'));
  toolbarDock.appendChild(toolbar);
  stageEl.appendChild(toolbarDock);

  // ── toolbar ─────────────────────────────────────────────────────────────────
  let popover: HTMLDivElement | null = null;
  let arrangeBtn: HTMLButtonElement | null = null;   // popover anchor (captured, not by index)
  function closePopover() { popover?.remove(); popover = null; }
  buildToolbar();   // after arrangeBtn exists (buildToolbar assigns it)

  function toolBtn(label: string, svg: string, onClick: (b: HTMLButtonElement, e: MouseEvent) => void, extraClass = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fc-btn ' + extraClass;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon(svg);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b, e); });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    toolbar.appendChild(b);
    return b;
  }

  function buildToolbar(): void {
    // Primary actions lead the rail — Export / Save / Copy / Share as prominent
    // icons (Export filled in the brand accent). This is the chromeless editor's
    // only surface for them; the floating bottom Export|Save pill is removed
    // (see .tool-layout.is-editor .render-pill). Callbacks delegate to the tool's
    // existing handlers (opts.actions) so there's no duplicated export/save logic.
    if (actions) {
      toolBtn(t('Export'), SVG.exportUp, () => actions.export(), 'fc-action fc-action-primary');
      if (actions.canSave !== false) {
        const saveBtn = toolBtn(t('Save to your library'), SVG.save, () => actions.save(), 'fc-action fc-action-save');
        const ref = actions.dirtyRef;
        if (ref) {
          // Mirror the render pill's amber "unsaved" cue onto the rail Save icon.
          const mirror = (): void => { saveBtn.classList.toggle('is-unsaved', ref.classList.contains('is-unsaved')); };
          mirror();
          dirtyObserver = new MutationObserver(mirror);
          dirtyObserver.observe(ref, { attributes: true, attributeFilter: ['class'] });
        }
      }
      // Copy / Copy-link fold into the "More" menu below (they're also in the export
      // popup), so the rail leads with just the two primary actions.
      const asep = document.createElement('div'); asep.className = 'fc-sep'; toolbar.appendChild(asep);
    }
    // Undo / redo — the chromeless editor has no sidebar header, so the rail is
    // where the history control lives (the only touch trigger here: no keyboard on
    // mobile). Combined into ONE indicator: two stacked halves of a single capsule
    // (undo above, redo below) so it reads as one back/forward control rather than
    // two separate icons. Wired to mountTool's shared history via opts.history, so
    // each half shows the same toast and disables at its end of the stack.
    if (history) {
      const hist = document.createElement('div');
      hist.className = 'fc-history';
      hist.setAttribute('role', 'group');
      hist.setAttribute('aria-label', t('History — go back or forward'));
      hist.addEventListener('pointerdown', (e) => e.stopPropagation());
      const histBtn = (label: string, svg: string, run: () => void): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fc-btn fc-hist-btn';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.innerHTML = icon(svg);
        b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
        hist.appendChild(b);
        return b;
      };
      const undoBtn = histBtn(t('Undo — step back'), SVG.undo, () => history.undo());
      const redoBtn = histBtn(t('Redo — step forward'), SVG.redo, () => history.redo());
      history.register((canUndo, canRedo) => {
        // Same focus handoff as the header buttons: a half that disables itself
        // under focus hands off to its enabled sibling instead of dropping focus
        // to <body>.
        const active = document.activeElement;
        if (active === undoBtn && !canUndo && canRedo) redoBtn.focus();
        else if (active === redoBtn && !canRedo && canUndo) undoBtn.focus();
        undoBtn.disabled = !canUndo;
        redoBtn.disabled = !canRedo;
      });
      toolbar.appendChild(hist);
      const hsep = document.createElement('div'); hsep.className = 'fc-sep'; toolbar.appendChild(hsep);
    }
    const add = toolBtn(t('Add a box'), SVG.add, () => openAddMenu(add), 'fc-btn-add');
    if (armedKind) add.classList.add('is-armed');
    // Connect mode (opt-in): link cards with routed connector lines. Click a source
    // card, then each target; click a card twice or hit Esc to stop.
    if (connectCfg) {
      const cbtn = toolBtn(t('Connect cards — click a card, then the ones it links to'), SVG.connect,
        () => { armedConnect ? disarmConnect() : armConnect(); }, 'fc-btn-connect');
      if (armedConnect) cbtn.classList.add('is-armed');
      toolBtn(t('Auto-arrange the connected cards'), SVG.tidy, () => autoLayout());
    }
    // One "Arrange" menu — align + distribute + stacking order + group + clip
    // (previously two separate rail buttons).
    arrangeBtn = toolBtn(t('Arrange — align, distribute, order, group'), SVG.align, () => openArrangeMenu());
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
    if (pages) toolBtn(t('Pages & page size'), SVG.pages, (b) => openPagesMenu(b));
    else if (setCanvasSize) toolBtn(t('Canvas size'), SVG.size, (b) => openSizeMenu(b));
    // Overflow "More" — the occasional items (copy, copy-link, document info, import)
    // collapse into one menu instead of a standalone icon each.
    let moreBtn: HTMLButtonElement | null = null;
    const openMore = (): void => {
      const items: PopItem[] = [];
      if (actions) {
        items.push({ label: t('Copy image to clipboard'), icon: icon(SVG.dup), run: () => actions.copy() });
        items.push({ label: t('Copy a shareable link'), icon: icon(SVG.shareLink), run: () => actions.share() });
      }
      if ((info || importCfg) && items.length) items.push({ sep: true });
      if (info) items.push({ label: t('Document info'), icon: icon(SVG.info), run: () => openInfoPanel(moreBtn!) });
      if (importCfg) items.push({ label: t('Import a design'), icon: icon(SVG.importFile), run: () => openImportPanel(moreBtn!) });
      if (items.length) spawnPopover(moreBtn!, items);
    };
    if (actions || info || importCfg) moreBtn = toolBtn(t('More'), SVG.more, () => openMore());
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
      b.className = 'fc-pop-item' + (it.danger ? ' fc-pop-danger' : '');
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
    popover.style.left = (ar.right - sr.left + 8) + 'px';
    popover.style.top = Math.max(6, ar.top - sr.top) + 'px';
  }
  // Import a design file (Figma SVG / Penpot). The heavy DOM parser is lazy-loaded so it
  // only ships to sessions that actually import. On success we REPLACE the whole boxes
  // array (through the normal commit path) and resize the artboard to the file's frame.
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
      '<button type="button" class="fc-import-choose" style="width:100%;padding:8px 12px;border:0;border-radius:8px;' +
      `background:#30BA78;color:#0c322c;font-weight:700;font-size:13px;cursor:pointer;">${t('Choose file…')}</button>` +
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
      chooseBtn.disabled = true;
      try {
        const { parseDesignFile } = await import('./design-import.ts');
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
        status.textContent = boxes.length === 1 ? t('Imported 1 object.') : t('Imported {n} objects.', { n: boxes.length });
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
    const items: PopItem[] = [
      { label: t('Duplicate'), icon: icon(SVG.dup), run: () => duplicateSelection(), disabled: !has },
      { label: t('Delete'), icon: icon(SVG.trash), run: () => deleteSelection(), disabled: !has, danger: true },
      { sep: true },
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
  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (editing) commitTextEdit();
    const nat = clientToNative(e.clientX, e.clientY);
    const boxes = getBoxes();
    const hit = hitTest(boxes, nat.x, nat.y, cfg);
    if (hit >= 0 && !selection.has(idOf(boxes[hit], hit))) {
      selection = new Set(selectionForHit(boxes, hit, e.altKey));
      renderChrome();
    }
    openContextMenu(e.clientX, e.clientY);
  }

  const ADD_KIND_ICON: Record<string, string> = { image: SVG.image, text: SVG.type, box: SVG.boxKind, lottie: SVG.anim, video: SVG.video };
  function openAddMenu(anchor: HTMLElement): void {
    spawnPopover(anchor, addKinds.map((k) => ({
      label: k.label ? t(k.label) : k.id,
      icon: icon(ADD_KIND_ICON[k.id] || SVG.add),
      run: () => armCreate(k),
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
  // Every box is ONE unified object (fill + shape + image + text), so the bar
  // always offers every control. Rebuilt only when the selection set changes (so
  // the colour pickers show the selected box); positioned each frame elsewhere.
  function rebuildCtxBar(boxes: Box[], idx: number[]): void {
    closeMorePanel();
    const coarse = matchMedia('(pointer: coarse)').matches;   // touch → offer add-to-selection
    const first: Box = boxes[idx[0]!] || {};
    const fillVal = cfg.fillField ? (first[cfg.fillField] || 'transparent') : '';
    const fgVal = cfg.textColorField ? (first[cfg.textColorField] || '#0c322c') : '#0c322c';
    ctxbar.innerHTML = `
      ${cfg.fillField ? `<span class="fc-cfield" title="${escape(t('Fill'))}">${colorFieldHtml('fc-fill', fillVal, { float: true })}</span>` : ''}
      ${cfg.textColorField ? `<span class="fc-cfield" title="${escape(t('Text colour'))}">${colorFieldHtml('fc-fg', fgVal, { float: true })}</span>` : ''}
      <button type="button" class="fc-cbtn" data-cx="edit" title="${escape(t('Edit text (double-click)'))}" aria-label="${escape(t('Edit text'))}">${icon(SVG.pencil)}</button>
      <button type="button" class="fc-cbtn fc-cbtn-text" data-cx="text" title="${escape(t('Text — size, font, weight, line height, kerning, ligatures, alignment'))}" aria-label="${escape(t('Text options'))}">Aa</button>
      <button type="button" class="fc-cbtn" data-cx="setimg" title="${escape(t('Set image'))}" aria-label="${escape(t('Set image'))}">${icon(SVG.image)}</button>
      <button type="button" class="fc-cbtn" data-cx="more" title="${escape(t('More — shape, radius, opacity, fit, blend, shadow'))}" aria-label="${escape(t('More options'))}">${icon(SVG.more)}</button>
      <span class="fc-sep fc-sep-v"></span>
      <button type="button" class="fc-cbtn" data-cx="dup" title="${escape(t('Duplicate'))}" aria-label="${escape(t('Duplicate'))}">${icon(SVG.dup)}</button>
      <button type="button" class="fc-cbtn fc-danger" data-cx="del" title="${escape(t('Delete'))}" aria-label="${escape(t('Delete'))}">${icon(SVG.trash)}</button>
      ${coarse ? `<button type="button" class="fc-cbtn${multiTapMode ? ' is-on' : ''}" data-cx="multi" aria-pressed="${multiTapMode}" title="${escape(t('Select more — tap cards to add'))}" aria-label="${escape(t('Select more cards'))}">${icon(SVG.add)}</button>` : ''}
      <button type="button" class="fc-readout" data-cx="dims" data-cx-readout title="${escape(t('Edit position & size'))}" aria-label="${escape(t('Edit position and size'))}"></button>`;
    wireColorField(ctxbar, {
      onChange: (id, val) => {
        if (id === 'fc-fill') setField(cfg.fillField, unwrapColor(val));
        else if (id === 'fc-fg') setField(cfg.textColorField, unwrapColor(val));
      },
    });
    ctxbar.querySelectorAll<HTMLElement>('[data-cx]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const cx = b.dataset.cx;
      if (cx === 'text') openTextPanel(b);
      else if (cx === 'edit') { if (selection.size) startTextEdit([...selection][0]!, { selectAll: true }); }
      else if (cx === 'dup') duplicateSelection();
      else if (cx === 'del') deleteSelection();
      else if (cx === 'setimg') pickImage();
      else if (cx === 'more') openMorePanel(b);
      else if (cx === 'multi') { multiTapMode = !multiTapMode; b.classList.toggle('is-on', multiTapMode); b.setAttribute('aria-pressed', String(multiTapMode)); announce(multiTapMode ? t('Select more — tap cards to add them.') : t('Multi-select off.')); }
      else if (cx === 'dims') openDimsPanel(b);
    }));
  }

  // ── "More" panel: shape / radius / opacity / image fit / blend ────────────────
  let morePanel: HTMLElement | null = null;
  function closeMorePanel() { morePanel?.remove(); morePanel = null; }

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
      `<label class="fc-row"><span>${t('Units')}</span><select data-sz="unit">${SIZE_UNITS.map((u) => `<option value="${u}"${u === sizeUnit ? ' selected' : ''}>${u}</option>`).join('')}</select></label>` +
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
      ${cfg.shapeField ? segRow(SVG.shRounded, t('Shape'), segHtml(cfg.shapeField, shapeCur, [['rect', t('Rectangle'), SVG.shRect], ['rounded', t('Rounded'), SVG.shRounded], ['pill', t('Pill'), SVG.shPill], ['ellipse', t('Ellipse'), SVG.shEllipse]])) : ''}
      ${cfg.radiusField ? iconRow(SVG.radius, t('Corner radius'), `<input type="range" data-mp="radius" min="0" max="200" value="${radiusCur}"><b data-mp-val="radius">${radiusCur}</b>`) : ''}
      ${cfg.opacityField ? iconRow(SVG.opacity, t('Opacity'), `<input type="range" data-mp="opacity" min="0" max="100" value="${Number.isFinite(opacityCur) ? opacityCur : 100}"><b data-mp-val="opacity">${Number.isFinite(opacityCur) ? opacityCur : 100}</b>`) : ''}
      ${cfg.fitField ? segRow(SVG.fitContain, t('Image fit'), segHtml(cfg.fitField, fitCur, [['contain', t('Contain'), SVG.fitContain], ['cover', t('Cover (crop)'), SVG.fitCover], ['fill', t('Stretch'), SVG.fitFill]])) : ''}
      ${cfg.imgPosField ? segRow(SVG.fitPos, t('Image position'), posGridHtml(cfg.imgPosField, posCur)) : ''}
      ${cfg.blendField ? iconRow(SVG.blend, t('Blend mode'), `<select data-mp="blend">
        ${['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'].map((m) => opt(m, t(m[0]!.toUpperCase() + m.slice(1).replace('-', ' ')), blendCur)).join('')}
      </select>`) : ''}
      ${cfg.shadowField ? `<div class="fc-panel-sub">${t('Shadow')}</div>
        ${segRow(SVG.shadowIc, t('Apply to'), segHtml(cfg.shadowField, shadowCur, [['none', t('None')], ['box', t('Box')], ['text', t('Text')], ['content', t('Content')]]))}
        <label class="fc-row"><span class="fc-row-lbl">${t('Colour')}</span><span class="fc-cfield">${colorFieldHtml('fc-shadow', shColor, { float: true })}</span></label>
        <label class="fc-row"><span class="fc-row-lbl">${t('X')}</span><input type="range" data-mp="shx" min="-300" max="300" value="${shX}"><b data-mp-val="shx">${shX}</b></label>
        <label class="fc-row"><span class="fc-row-lbl">${t('Y')}</span><input type="range" data-mp="shy" min="-300" max="300" value="${shY}"><b data-mp-val="shy">${shY}</b></label>
        <label class="fc-row"><span class="fc-row-lbl">${t('Blur')}</span><input type="range" data-mp="shblur" min="0" max="300" value="${shBlur}"><b data-mp-val="shblur">${shBlur}</b></label>` : ''}`;
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    wireSegs(p);
    const MP_FIELD: Record<string, string> = { radius: cfg.radiusField, opacity: cfg.opacityField, shx: cfg.shadowXField, shy: cfg.shadowYField, shblur: cfg.shadowBlurField };
    p.querySelectorAll<HTMLSelectElement>('select[data-mp]').forEach((sel) => sel.addEventListener('change', () => setField(cfg.blendField, sel.value)));
    p.querySelectorAll<HTMLInputElement>('input[data-mp]').forEach((rng) => rng.addEventListener('input', () => {
      const valEl = p.querySelector<HTMLElement>(`[data-mp-val="${rng.dataset.mp}"]`);
      if (valEl) valEl.textContent = rng.value;
      setField(MP_FIELD[rng.dataset.mp!], Number(rng.value));
    }));
    if (cfg.shadowColorField) wireColorField(p, { onChange: (id, val) => { if (id === 'fc-shadow') setField(cfg.shadowColorField, unwrapColor(val)); } });
    stageEl.appendChild(p);
    morePanel = p;
    const ar = anchor.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    p.style.left = Math.min(ar.left - sr.left, sr.width - p.offsetWidth - 8) + 'px';
    p.style.top = (ar.bottom - sr.top + 8) + 'px';
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
            `<input type="range" class="fc-dims-slider" min="-180" max="180" value="${rot}" aria-label="${escape(t('Rotation'))}" data-dm-slider></div>`
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
        `<label class="fc-row fc-row-toggle"><span>${t('Credit me')}</span><input type="checkbox" data-info="optin" disabled></label>` +
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
      const editLink = prov.editHref ? ` <a href="${escapeHtml(prov.editHref)}">${t('Edit details')}</a>` : '';
      const paint = (optedIn: boolean, author: string, contact: string): void => {
        if (optin) optin.checked = optedIn;
        if (authorRow) { authorRow.hidden = !(optedIn && author); authorRow.querySelector('b')!.textContent = author; }
        if (contactRow) { contactRow.hidden = !(optedIn && contact); contactRow.querySelector('b')!.textContent = contact; }
        if (note) {
          note.innerHTML = optedIn
            ? (author || contact
                ? t('Baked into your PNG, PDF & SVG file metadata.')
                : t('No name on file yet —{action} to be credited.', { action: editLink || ` ${t('add your details in your profile')}` }))
            : t('Your name &amp; contact stay off your files.{link}', { link: editLink });
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
    const sel = new Set(selIndices(boxes));
    commit(boxes.map((b, i) => (sel.has(i) ? { ...b, [field]: value } : b)));
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
      POS9.map(([v, lbl]) => `<button type="button" class="fc-seg-btn fc-pos-btn${cur === v ? ' is-on' : ''}" data-v="${v}" title="${escape(t(lbl))}" aria-label="${escape(t('Anchor image {pos}', { pos: t(lbl).toLowerCase() }))}"><i></i></button>`).join('') +
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
    const alignCur = String(b[cfg.alignField] || 'center');
    const valignCur = String(b[cfg.valignField] || 'middle');
    const p = document.createElement('div');
    p.className = 'fc-panel fc-text-panel';
    p.innerHTML =
      `<div class="fc-panel-head">${t('Text')}</div>` +
      (cfg.fontField ? `<label class="fc-row"><span>${t('Font')}</span><select data-tp="font">${fontOptionsHtml(fontCur)}</select></label>` : '') +
      // Size row now carries the A−/A+ steppers (moved off the object bar) around the number.
      (cfg.fontSizeField ? `<div class="fc-row"><span>${t('Size')}</span><div class="fc-stepper">
        <button type="button" class="fc-cbtn" data-tp="smaller" title="${escape(t('Smaller'))}" aria-label="${escape(t('Smaller text'))}">A−</button>
        <input type="number" min="4" max="2000" data-tp="size" value="${sizeCur}">
        <button type="button" class="fc-cbtn" data-tp="bigger" title="${escape(t('Bigger'))}" aria-label="${escape(t('Bigger text'))}">A+</button>
      </div></div>` : '') +
      (cfg.weightField ? `<label class="fc-row"><span>${t('Weight')}</span><select data-tp="weight">${weightChoicesFor(fontCur).map(([v, l]) => opt(v, t(l), weightCur)).join('')}</select></label>` : '') +
      (cfg.lineHeightField ? `<label class="fc-row"><span>${t('Line height')}</span><input type="range" min="0.7" max="3" step="0.01" data-tp="lh" value="${lhCur}"><b data-tp-val="lh">${lhCur.toFixed(2)}</b></label>` : '') +
      (cfg.trackingField ? `<label class="fc-row"><span>${t('Letter spacing')}</span><input type="range" min="-20" max="100" step="0.5" data-tp="tr" value="${trCur}"><b data-tp-val="tr">${trCur}</b></label>` : '') +
      (cfg.ligaturesField ? `<label class="fc-row fc-row-toggle"><span>${t('Ligatures')}</span><input type="checkbox" data-tp="lig"${ligCur ? ' checked' : ''}></label>` : '') +
      (cfg.alternatesField ? `<label class="fc-row fc-row-toggle"><span>${t('Alternates')}</span><input type="checkbox" data-tp="alt"${altCur ? ' checked' : ''}></label>` : '') +
      (cfg.alignField ? `<div class="fc-row"><span>${t('Align')}</span>${segHtml(cfg.alignField, alignCur, [['left', t('Align left'), SVG.textL], ['center', t('Align centre'), SVG.textC], ['right', t('Align right'), SVG.textR]])}</div>` : '') +
      (cfg.valignField ? `<div class="fc-row"><span>${t('Vertical')}</span>${segHtml(cfg.valignField, valignCur, [['top', t('Align top'), SVG.textT], ['middle', t('Centre vertically'), SVG.textM], ['bottom', t('Align bottom'), SVG.textB]])}</div>` : '') +
      (cfg.padField ? `<label class="fc-row"><span>${t('Padding')}</span><input type="range" min="0" max="200" data-tp="pad" value="${padCur}"><b data-tp-val="pad">${padCur}</b></label>` : '');
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
    p.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-tp]').forEach((cb) => cb.addEventListener('change', () => {
      setField(cb.dataset.tp === 'lig' ? cfg.ligaturesField : cfg.alternatesField, cb.checked);
    }));
    wireSegs(p);
    stageEl.appendChild(p);
    morePanel = p;
    const ar = anchor.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    p.style.left = Math.max(6, Math.min(ar.left - sr.left, sr.width - p.offsetWidth - 8)) + 'px';
    p.style.top = Math.max(6, Math.min(ar.bottom - sr.top + 8, sr.height - p.offsetHeight - 8)) + 'px';
  }
  async function pickImage(pickOpts?: { pickType?: 'lottie' | 'video' }): Promise<void> {
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
        title: pickType === 'video' ? t('Choose a video') : pickType === 'lottie' ? t('Choose an animation') : t('Choose an image'),
        // No type constraint by default: boxes take rasters AND vectors — logos and
        // the themable two-colour icons (with the picker's theme strip) included, plus
        // animated rasters (gif/apng/webp, which are type:'raster'). The "Animation" /
        // "Video" add-kinds constrain the picker to lottie / video respectively; each
        // renders as a live player once placed (mediaHtmlFor dispatches on asset type).
        ...(pickType ? { type: pickType } : {}),
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

  // ── create-mode arming ───────────────────────────────────────────────────────
  function armCreate(kind: AddKind): void {
    if (armedConnect) disarmConnect();         // add-mode and connect-mode are exclusive
    deselectEdge();
    armedKind = kind;
    stageEl.classList.add('fc-arming');
    toolbar.querySelector('.fc-btn-add')?.classList.add('is-armed');
  }
  function disarm(): void {
    armedKind = null;
    stageEl.classList.remove('fc-arming');
    toolbar.querySelector('.fc-btn-add')?.classList.remove('is-armed');
  }

  // ── connect-mode arming (opt-in) ──────────────────────────────────────────────
  function armConnect(): void {
    if (!connectCfg) return;
    disarm();                                  // add-mode and connect-mode are exclusive
    deselectEdge();                            // and drop any connector selection
    armedConnect = true;
    connectSource = null;
    selection = new Set<string>();
    stageEl.classList.add('fc-connecting');
    toolbar.querySelector('.fc-btn-connect')?.classList.add('is-armed');
    setHoverEdge(null);
    announce(t('Connect mode on — click a card, then the card to link it to. Esc to finish.'));
    renderChrome();
  }
  function disarmConnect(): void {
    armedConnect = false;
    connectSource = null;
    stageEl.classList.remove('fc-connecting');
    toolbar.querySelector('.fc-btn-connect')?.classList.remove('is-armed');
    hideConnectLayer();
  }

  // Auto-arrange the connected cards into a tidy top-down hierarchy. Roots (cards with
  // no incoming edge) are laid out left-to-right; each child sits under its parent, and
  // a parent is centred over the span of its children. Unconnected cards are left where
  // they are. One commit → one undo step.
  function autoLayout(): void {
    if (!connectCfg) return;
    const boxes = getBoxes();
    if (!boxes.length) return;
    const edges = getEdges();
    const ff = connectCfg.fromField!, tf = connectCfg.toField!;
    const idAt = new Map<string, number>();
    boxes.forEach((b, i) => idAt.set(idOf(b, i), i));
    const children = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const e of edges) {
      if (!e) continue;
      const from = String(e[ff]), to = String(e[tf]);
      if (!idAt.has(from) || !idAt.has(to) || from === to) continue;
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
    if (!pages) return;
    canvasEl.querySelectorAll<HTMLElement>('[data-pdf-page]').forEach((f) => {
      f.style.overflow = clipped ? '' : 'visible';
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
  }
  function endGesture(): void {
    document.body.classList.remove('fc-manipulating');
    gesture = null;
    rubber.hidden = true;
    clearGuides();
    setFramesClipped(true);
  }

  // ── inline text editing (double-click a box) ─────────────────────────────────
  // WYSIWYG rich text: the box's rendered markup is edited in place, and a
  // floating format bar offers bold/italic/bullets (selection-level, via the
  // rich-text.js char model) plus alignment/weight/size (box-level, staged in
  // editing.pending and committed with the text as one undo step).
  let fmtbar: FmtBar | null = null;

  function onDblClick(e: MouseEvent): void {
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
    const hit = hitTest(boxes, nat.x, nat.y, cfg);
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
    ctxbar.hidden = true;
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
    let grownH: number | null = null;
    if (changed && cfg.hField && done.boxEl) {
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
      fsel.className = 'fc-fmt-font';
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
      sel.className = 'fc-fmt-weight';
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

  function onCanvasPointerDown(e: PointerEvent): void {
    if (e.button > 0) return;                 // primary button / touch only
    if (editing) {
      if (editing.el.contains(e.target as Node)) return;   // let the caret move within the text
      commitTextEdit();                            // clicked elsewhere → commit, then select
    }
    closePopover();
    const nat = clientToNative(e.clientX, e.clientY);
    const boxes = getBoxes();

    // Connect mode: click a source card, then each target it links to. Clicking the
    // same card again (or empty canvas) drops the pending source; Esc / the rail button
    // exits the mode. Never starts a drag gesture.
    if (armedConnect) {
      const chit = hitTest(boxes, nat.x, nat.y, cfg);
      if (chit < 0) { connectSource = null; hideConnectLayer(); e.stopPropagation(); e.preventDefault(); return; }
      const cid = idOf(boxes[chit], chit);
      if (!connectSource) connectSource = cid;
      else if (connectSource === cid) { connectSource = null; hideConnectLayer(); e.stopPropagation(); e.preventDefault(); return; }
      else { toggleEdge(connectSource, cid); connectSource = cid; }   // chain from the same source
      drawConnectRubber(nat);
      e.stopPropagation(); e.preventDefault();
      return;
    }

    if (armedKind) {
      beginGesture(e, { type: 'create', origin: nat, seed: armedKind.seed || {}, others: otherAABBs(boxes, new Set<number>()) });
      rubber.hidden = false;
      e.stopPropagation(); e.preventDefault();
      return;
    }

    const hit = hitTest(boxes, nat.x, nat.y, cfg);
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
    closePopover();
    deselectEdge();
    if (selection.size) selection = new Set<string>();
    renderChrome();
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

    if (gesture.type === 'marquee') {
      drawRubber(gesture.origin, nat);
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
      const nr = resizeRect(gesture.startRect, gesture.handle, sdx, sdy, {
        minSize, keepAspect: e.shiftKey, fromCentre: e.altKey,
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
      if (moved < 6) { selection = new Set<string>(); disarm(); renderChrome(); }
      gesture = null;
      return;
    }

    const nat = clientToNative(e.clientX, e.clientY);
    const boxes = getBoxes();

    if (g.type === 'create') {
      const moved = Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y);
      let rect: Rect;
      if (moved < 6) {
        // A tap (no drag) drops a default-sized box centred on the point.
        const w = 320, h = 200;
        rect = { x: g.origin.x - w / 2, y: g.origin.y - h / 2, w, h };
      } else {
        const c = g.corner || nat;
        rect = normDragRect(g.origin.x, g.origin.y, c.x, c.y, minSize);
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
      const wasImage = !wasLottie && !wasVideo && ((g.seed?.[cfg.kindField] === 'image') || armedKind?.id === 'image');
      const wasText = (g.seed?.[cfg.kindField] === 'text') || armedKind?.id === 'text';
      disarm();
      endGesture();
      commit([...boxes, box]);
      if (wasLottie) setTimeout(() => pickImage({ pickType: 'lottie' }), 0);
      else if (wasVideo) setTimeout(() => pickImage({ pickType: 'video' }), 0);
      else if (wasImage) setTimeout(() => pickImage(), 0);
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
        const hits = marqueeHit(boxes, rect, cfg).map((i: number) => idOf(boxes[i], i));
        const edgeHits = edgesInRect(rect);
        if (g.additive) {
          for (const id of hits) selection.add(id);
          for (const id of edgeHits) selectedEdges.add(id);
        } else {
          selection = new Set(hits);
          selectedEdges = new Set(edgeHits);
        }
        if (selectedEdges.size) { if (armedConnect) disarmConnect(); setHoverEdge(null); }
      }
      endGesture();
      renderChrome();                                  // card chrome + edge highlights (via renderChrome)
      if (selectedEdges.size) openEdgePanel(); else closeEdgePanel();
      return;
    }
    if (g.type === 'move') {
      const d = g.moveDelta || { dx: 0, dy: 0 };
      endGesture();
      if (Math.abs(d.dx) > 0.5 || Math.abs(d.dy) > 0.5) commit(moveBoxes(boxes, [...g.sel], d.dx, d.dy, cfg));
      else renderChrome();
      return;
    }
    if (g.type === 'resize' || g.type === 'rotate') {
      const live = g.liveRect || g.startRect;
      endGesture();
      commit(boxes.map((b, i) => (i === g.index ? withRect(b, live, cfg) : b)));
      return;
    }
    if (g.type === 'gscale' || g.type === 'grotate') {
      const next = g.liveBoxes;
      endGesture();
      if (next) commit(next); else renderChrome();
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
    if (pages) el.style.zIndex = '9999';
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

  // ── connector preview layer ───────────────────────────────────────────────────
  // The routing math (edgeWaypoints / roundedEdgePath / smoothEdgePath / edgeBorderPt /
  // edgeNested) lives in free-canvas-math.ts so it is unit-tested (tests/connector-
  // geometry.test.ts) and stays in sync with tools/org-chart/hooks.js. Preview lines
  // omit the arrowheads/dashes (the real hook adds those on commit).
  const cf2 = (v: number): number => Math.round(v * 100) / 100;
  const cAttr = (s: string): string => String(s == null ? '' : s).replace(/[<>"]/g, '');
  // Size + place the preview <svg> to cover the artboard in stage px (native viewBox).
  function placeConnectLayer(m: Metrics): void {
    const cw = canvasWH();
    const o = nativeToStage(0, 0, m);
    connectLayer.style.left = o.x + 'px';
    connectLayer.style.top = o.y + 'px';
    connectLayer.style.width = (cw.w * m.scale) + 'px';
    connectLayer.style.height = (cw.h * m.scale) + 'px';
    connectLayer.setAttribute('viewBox', `0 0 ${cw.w} ${cw.h}`);
    connectLayer.setAttribute('preserveAspectRatio', 'none');
  }
  // Hide/show the tool's committed connector <svg> (so it doesn't double up with the
  // live preview mid-drag). Re-shown on gesture end; the commit re-renders it anyway.
  function setRealConnectorsHidden(hidden: boolean): void {
    if (!connectCfg?.layerClass) return;
    const el = canvasEl.querySelector<HTMLElement>('.' + connectCfg.layerClass);
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
  // Redraw every edge from the current (possibly live) box rects. Called each frame of a
  // drag involving connected cards, so the lines track the boxes in real time.
  function drawLiveConnectors(): void {
    if (!connectCfg) return;
    const boxes = getBoxes();
    const edges = getEdges();
    placeConnectLayer(metrics());
    // Resolve every box's (possibly live) rect ONCE — a single querySelectorAll + one pass
    // over boxes — so a connected drag redraws in O(boxes + edges), not O(edges × boxes)
    // with two DOM queries per edge. Mirrors boxRectById's live-DOM-else-model logic.
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
    let body = '';
    for (const e of edges) {
      if (!e) continue;
      const a = rectById.get(String(e[connectCfg.fromField!]));
      const b = rectById.get(String(e[connectCfg.toField!]));
      if (!a || !b || edgeNested(a, b)) continue;   // nested pair draws no line (mirrors hooks.js)
      const style = String((connectCfg.styleField && e[connectCfg.styleField]) || connectCfg.defaultStyle);
      const col = cAttr(String((connectCfg.colorField && e[connectCfg.colorField]) || connectCfg.defaultColor));
      const w = Math.min(20, Math.max(0.5, Number((connectCfg.widthField && e[connectCfg.widthField]) ?? connectCfg.defaultWidth) || 2.5));
      const pts = edgeWaypoints(a, b, style);
      if (pts.length < 2) continue;
      const d = style === 'curved' ? smoothEdgePath(pts) : roundedEdgePath(pts, Math.min(16, w * 4 + 6));
      body += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${cf2(w)}" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    connectLayer.innerHTML = body;
    connectLayer.style.display = '';
  }
  // The dashed "rubber" from the pending source card toward the cursor while linking.
  function drawConnectRubber(cursorNative: Point): void {
    if (!connectCfg || !connectSource) return;
    const boxes = getBoxes();
    const i = indexOfId(boxes, connectSource);
    if (i < 0) { connectSource = null; hideConnectLayer(); return; }
    const r = boxRect(boxes[i], cfg);
    const a = { cx: r.x + r.w / 2, cy: r.y + r.h / 2, hw: r.w / 2, hh: r.h / 2 };
    const p = edgeBorderPt(a, cursorNative.x, cursorNative.y);
    const col = cAttr(connectCfg.defaultColor || '#94a3b8');
    placeConnectLayer(metrics());
    connectLayer.innerHTML =
      `<rect x="${cf2(r.x - 3)}" y="${cf2(r.y - 3)}" width="${cf2(r.w + 6)}" height="${cf2(r.h + 6)}" rx="10" fill="none" stroke="${col}" stroke-width="2.5" stroke-dasharray="6 5"/>` +
      `<path d="M${cf2(p.x)} ${cf2(p.y)}L${cf2(cursorNative.x)} ${cf2(cursorNative.y)}" fill="none" stroke="${col}" stroke-width="2.5" stroke-dasharray="8 6" stroke-linecap="round"/>` +
      `<circle cx="${cf2(cursorNative.x)}" cy="${cf2(cursorNative.y)}" r="5" fill="${col}"/>`;
    connectLayer.style.display = '';
  }
  function hideConnectLayer(): void {
    connectLayer.style.display = 'none';
    connectLayer.innerHTML = '';
  }
  // Called each frame of a drag that moves connected cards: hide the tool's committed
  // connector layer once, then redraw every edge live so the lines follow the boxes.
  function liveConnUpdate(): void {
    if (!connectCfg) return;
    if (!liveConnectHidden) setRealConnectorsHidden(true);
    drawLiveConnectors();
  }
  // On drop, keep the preview one extra paint so the committed connectors re-render
  // underneath before we drop it (avoids a flash), then restore + clear.
  function endLiveConnectors(): void {
    if (!connectCfg || !liveConnectHidden) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (disposed) return;
      setRealConnectorsHidden(false);
      if (!armedConnect && !selectedEdges.size) hideConnectLayer();
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
    if (!connectCfg || armedConnect || selectedEdges.size || gesture || !lastPointer) { setHoverEdge(null); return; }
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
    } else if (!selectedEdges.size && !armedConnect) {
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
    if (armedConnect) disarmConnect();
    setHoverEdge(null);
    if (additive && selectedEdges.size) {
      if (selectedEdges.has(eid)) selectedEdges.delete(eid); else selectedEdges.add(eid);
      if (!selectedEdges.size) { deselectEdge(); return; }
    } else {
      selectedEdges = new Set([eid]);
    }
    selection = new Set<string>();     // a connector and a card can't be selected by a plain click
    connectSource = null;
    renderChrome();                    // clear any card chrome + draw the highlight(s)
    openEdgePanel();                   // rebuild (count / values may have changed)
  }
  function deselectEdge(): void {
    if (!selectedEdges.size && !edgePanel) return;
    selectedEdges = new Set<string>();
    closeEdgePanel();
    if (!armedConnect) hideConnectLayer();
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
    const styleSelect = `<select data-ep="style">${STYLE_OPTS.map(([v, l]) => `<option value="${v}"${styleCur === v ? ' selected' : ''}>${escape(t(l))}</option>`).join('')}</select>`;
    const row = (lbl: string, ctrl: string): string => `<div class="fc-row"><span class="fc-row-lbl"><span>${lbl}</span></span>${ctrl}</div>`;
    const p = document.createElement('div');
    p.className = 'fc-panel fc-edge-panel';
    p.innerHTML =
      (nSel > 1 ? `<div class="fc-edge-count">${t('{n} connectors — editing all', { n: nSel })}</div>` : '') +
      (styleF ? row(t('Bend'), styleSelect) : '') +
      (arrowF ? row(t('Arrow'), segHtml(arrowF, arrowCur, [['none', t('None')], ['end', t('End')], ['both', t('Both')]])) : '') +
      (headF ? row(t('Head'), segHtml(headF, headCur, HEAD_CHOICES)) : '') +
      (dashF ? row(t('Line'), segHtml(dashF, dashCur, [['solid', t('Solid')], ['dashed', t('Dashed')], ['dotted', t('Dotted')]])) : '') +
      (widthF ? `<label class="fc-row"><span class="fc-row-lbl"><span>${t('Thickness')}</span></span><input type="range" data-ep="width" min="0.5" max="12" step="0.5" value="${widthCur}"><b data-ep-val="width">${widthCur}</b></label>` : '') +
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
    // M2 — reposition the frame scrim only when the artboard geometry changed (pan/
    // zoom/resize set scrimDirty); a box drag/hover/selection change never moves it.
    if (scrimDirty) { positionFrameScrim(); scrimDirty = false; }
    // While editing text, suppress selection chrome + ctxbar; just keep the floating
    // format bar tracking the box as the stage pans/zooms.
    if (editing) { clearChrome(); ctxbar.hidden = true; positionFmtBar(); return; }
    const idx = selIndices(boxes);
    const m = metrics();
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
      else { ctxbar.hidden = true; closeMorePanel(); multiTapMode = false; }
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
        el.setAttribute('aria-label', txt ? t('Card: {text}', { text: txt }) : t('Card'));
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

  function positionCtxBar(boxes: Box[], idx: number[], liveRects: Map<number, Rect> | null, m: Metrics): void {
    if (editing) { ctxbar.hidden = true; return; }   // hidden while typing in a box
    ctxbar.hidden = false;
    // Position above the selection's union AABB. groupAABBNative computes the same
    // rotation-aware corner union over `idx` (preferring liveRects) WITHOUT the
    // per-frame whole-canvas `boxes.map(...)` allocation — and reuses the exact math
    // used for the group handles above, so the two can't drift.
    const aabb = groupAABBNative(idx, boxes, liveRects);
    const tl = nativeToStage(aabb.minX, aabb.minY, m);
    const br = nativeToStage(aabb.maxX, aabb.maxY, m);
    // Centre by computed `left` (NOT translateX) so the colour popover — which is
    // position:fixed — isn't captured by a transformed ancestor. Clamp on-stage.
    const bw = ctxbar.offsetWidth || 0;
    const stageW = m.sr.width;
    const left = Math.max(6, Math.min((tl.x + br.x) / 2 - bw / 2, stageW - bw - 6));
    ctxbar.style.left = left + 'px';
    ctxbar.style.top = Math.max(6, tl.y - 48) + 'px';
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
    // no-op when empty. Just reflect the armed state.
    toolbar.querySelector('.fc-btn-add')?.classList.toggle('is-armed', !!armedKind);
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
  function typingTarget(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
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
  function onKey(e: KeyboardEvent): void {
    if (disposed) return;
    if (e.key === 'Escape') { if (armedConnect) { disarmConnect(); } else if (selectedEdges.size) { deselectEdge(); } else if (armedKind) { disarm(); } else if (selection.size) { selection = new Set<string>(); renderChrome(); } closePopover(); return; }
    if (typingTarget()) return;
    // Enter / F2 on a selected box → edit its text (select-all so typing replaces it).
    if ((e.key === 'Enter' || e.key === 'F2') && !editing && selection.size && cfg.textField) {
      e.preventDefault();
      startTextEdit([...selection][0]!, { selectAll: e.key === 'Enter' });
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
      commit(moveBoxes(boxes, selIndices(boxes), ux * step, uy * step, cfg));
    }
  }

  // ── wiring ────────────────────────────────────────────────────────────────────
  canvasEl.addEventListener('pointerdown', onCanvasPointerDown);
  stageEl.addEventListener('pointerdown', onBackdropPointerDown);   // deselect on backdrop click
  viewEl.addEventListener('pointerdown', onBackdropPointerDown);
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
  const onStageMove = (e: any): void => { gestureMetrics = null; scrimDirty = true; if (e && typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY }; scheduleSync(); if (connectLayer.style.display !== 'none') placeConnectLayer(metrics()); };
  // pointermove fires continuously while the cursor merely HOVERS the canvas. The old
  // handler rebuilt the whole selection chrome (2 getBoundingClientRect + innerHTML swap
  // + 10 handle nodes re-bound) every frame for zero visual change. Here we only track
  // the paste-at-cursor position; a real pan (buttons held) still re-syncs, and pan/zoom
  // via the transform is already caught by the MutationObserver below — so an idle hover
  // costs nothing.
  const onStagePointerMove = (e: any): void => {
    if (e && typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY };
    // Connect mode: while a source card is pending, the "rubber" tracks the cursor.
    if (armedConnect && connectSource && e && typeof e.clientX === 'number' && !e.buttons) {
      drawConnectRubber(clientToNative(e.clientX, e.clientY));
    }
    // Hover affordance over connector lines (idle hover only, throttled to one rAF/frame).
    if (connectCfg && !armedConnect && !selectedEdges.size && !gesture && e && !e.buttons && typeof e.clientX === 'number') {
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
    if (morePanel && !morePanel.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-cx="more"],[data-cx="text"]')) closeMorePanel();
  };
  document.addEventListener('pointerdown', onDocDown, true);

  renderChrome();

  // Universal drop front door (lib/drop-router.ts): a design file dropped on the
  // gallery/dashboard was stashed one-shot and is consumed here on mount, through
  // the exact same lazy parseDesignFile → commit path as the Import panel above.
  const pendingImport = importCfg ? takePendingDesignImport() : null;
  if (pendingImport) {
    void (async () => {
      announce(t('Importing…'));
      try {
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
      finishEdit();
      canvasEl.removeEventListener('pointerdown', onCanvasPointerDown);
      stageEl.removeEventListener('pointerdown', onBackdropPointerDown);
      viewEl.removeEventListener('pointerdown', onBackdropPointerDown);
      canvasEl.removeEventListener('pointermove', onGestureMove);
      canvasEl.removeEventListener('pointerup', onGestureEnd);
      canvasEl.removeEventListener('pointercancel', onGestureEnd);
      canvasEl.removeEventListener('dblclick', onDblClick);
      canvasEl.removeEventListener('contextmenu', onContextMenu);
      canvasEl.removeEventListener('focusin', onBoxFocus);
      window.removeEventListener('keydown', onKey);
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
      overlay.remove(); toolbarDock.remove(); closePopover(); closeMorePanel(); closeEdgePanel();
      document.body.classList.remove('fc-manipulating');
    },
  };
}
