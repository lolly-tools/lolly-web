// SPDX-License-Identifier: MPL-2.0
// free-canvas-math.js — DOM-free geometry for the WYSIWYG "editor" layout.
//
// The web shell's free-canvas overlay (free-canvas.js) is the only DOM here; ALL
// coordinate math lives in this module so it can be unit-tested at the repo root,
// exactly like block-tree.js is for nested blocks. Everything operates on a FLAT
// array of "box" objects (one row of a `blocks` input) plus a `cfg` describing
// which sub-fields carry geometry (from the input's `canvas` flag). Functions are
// pure: they read boxes, return NEW boxes / arrays, and never touch the DOM.
//
// Coordinate space: box x/y/w/h are in CANVAS (native render) pixels; the box is
// the axis-aligned rectangle [x, x+w] × [y, y+h] BEFORE rotation, and `rot`
// degrees is applied clockwise about the box centre (matching CSS
// `transform: rotate()` with the default centre transform-origin). Screen↔native
// mapping is the shell's job (it reads live getBoundingClientRect); this module is
// purely in native pixels.

import type { InputValue } from '../../../../engine/src/inputs.ts';

/** A flat row of a `blocks` input, keyed by field id — the shape of one "box". */
export type Box = { [key: string]: InputValue | undefined };

/** Which sub-fields of a box carry its geometry (from the input's `canvas` flag). */
export interface BoxFieldConfig {
  idField: string;
  xField: string;
  yField: string;
  wField: string;
  hField: string;
  rotationField: string;
  fontSizeField?: string;
  radiusField?: string;
}

/** A box's geometry, resolved to finite numbers. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

/** Partial geometry to write back via {@link withRect} — only present fields change. */
export type PartialRect = { x?: number; y?: number; w?: number; h?: number; rot?: number };

/** A world-space (native px) point. */
export interface Point {
  x: number;
  y: number;
}

/** An axis-aligned bounding box (world px), plus its size for convenience. */
export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
}

/** A native-px rectangle in x/y/w/h form (e.g. a marquee-select drag). */
export interface MarqueeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The artboard's native-px size. */
export interface Canvas {
  w: number;
  h: number;
}

/** A guide line segment to draw (native px), reported by the snap helpers. */
export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Result of {@link snapMove}: the extra translation, plus guides to draw. */
export interface SnapMoveResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

/** Result of {@link snapPoint}: the snapped point, plus guides to draw. */
export interface SnapPointResult {
  x: number;
  y: number;
  guides: Guide[];
}

/** A resize-handle name — the 8 compass points around a box. */
export type HandleName = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Options for {@link resizeRect}. */
export interface ResizeOpts {
  minSize?: number;
  keepAspect?: boolean;
  fromCentre?: boolean;
}

/** Options for {@link scaleGroup}. */
export interface ScaleOpts {
  minSize?: number;
}

/** The rect a resize gesture started from — `rot` may be absent (treated as 0). */
export interface StartRect {
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
}

/** Which artboard/selection edge to align to. */
export type AlignEdge = 'left' | 'hcentre' | 'right' | 'top' | 'vcentre' | 'bottom';

/** Which axis to distribute boxes along. */
export type Axis = 'h' | 'v';

/** A re-stacking (z-order) operation. */
export type ZOp = 'front' | 'back' | 'forward' | 'backward';

/** Coerce a possibly-stringy field (URL round-trips numbers as strings) to a finite number. */
export function num(v: InputValue | undefined, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(v as string);
  return Number.isFinite(n) ? n : fallback;
}

/** Read a box's geometry as finite numbers, tolerant of string fields. */
export function boxRect(box: Box | undefined, cfg: BoxFieldConfig): Rect {
  return {
    x: num(box?.[cfg.xField], 0),
    y: num(box?.[cfg.yField], 0),
    w: Math.max(0, num(box?.[cfg.wField], 0)),
    h: Math.max(0, num(box?.[cfg.hField], 0)),
    rot: num(box?.[cfg.rotationField], 0),
  };
}

/** Return a NEW box with the given rect (+optional rot) written back, rounded to whole px. */
export function withRect(box: Box, rect: PartialRect, cfg: BoxFieldConfig): Box {
  const next: Box = { ...box };
  if (rect.x != null) next[cfg.xField] = Math.round(rect.x);
  if (rect.y != null) next[cfg.yField] = Math.round(rect.y);
  if (rect.w != null) next[cfg.wField] = Math.round(rect.w);
  if (rect.h != null) next[cfg.hField] = Math.round(rect.h);
  if (rect.rot != null && cfg.rotationField) next[cfg.rotationField] = Math.round(rect.rot * 10) / 10;
  return next;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Local→world rotation of a vector by `deg` (clockwise, screen y-down). */
export function rotateVec(vx: number, vy: number, deg: number): Point {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  return { x: vx * c - vy * s, y: vx * s + vy * c };
}

/** Centre of a box's rect. */
export function rectCentre(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** The four rotated corners of a box, in world (native) pixels, TL,TR,BR,BL order. */
export function boxCorners(box: Box | undefined, cfg: BoxFieldConfig): Point[] {
  const r = boxRect(box, cfg);
  const c = rectCentre(r);
  const hw = r.w / 2, hh = r.h / 2;
  const corners: [number, number][] = [
    [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh],
  ];
  return corners.map(([lx, ly]) => {
    const w = rotateVec(lx, ly, r.rot);
    return { x: c.x + w.x, y: c.y + w.y };
  });
}

/** Axis-aligned bounding box (world px) of a possibly-rotated box. */
export function boxAABB(box: Box | undefined, cfg: BoxFieldConfig): AABB {
  const pts = boxCorners(box, cfg);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Union AABB of a set of boxes (by index list). null if empty. */
export function selectionAABB(boxes: Box[], indices: number[], cfg: BoxFieldConfig): AABB | null {
  let acc: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const i of indices) {
    const b = boxes[i];
    if (!b) continue;
    const a = boxAABB(b, cfg);
    acc = acc
      ? {
          minX: Math.min(acc.minX, a.minX), minY: Math.min(acc.minY, a.minY),
          maxX: Math.max(acc.maxX, a.maxX), maxY: Math.max(acc.maxY, a.maxY),
        }
      : { minX: a.minX, minY: a.minY, maxX: a.maxX, maxY: a.maxY };
  }
  if (!acc) return null;
  return { ...acc, w: acc.maxX - acc.minX, h: acc.maxY - acc.minY };
}

/**
 * Topmost box index under a native point, honouring rotation. -1 if none.
 * `skip` excludes a box from hit-testing entirely (the click falls through to
 * whatever is below) — the sequence editor passes "hidden at the playhead", so
 * a user can only ever select what they can currently see.
 */
export function hitTest(boxes: Box[], px: number, py: number, cfg: BoxFieldConfig, skip?: (i: number) => boolean): number {
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (skip && skip(i)) continue;
    const r = boxRect(boxes[i], cfg);
    const c = rectCentre(r);
    // Rotate the point into the box's local (unrotated) frame.
    const l = rotateVec(px - c.x, py - c.y, -r.rot);
    if (Math.abs(l.x) <= r.w / 2 && Math.abs(l.y) <= r.h / 2) return i;
  }
  return -1;
}

/** Indices whose AABB intersects a native marquee rect {x,y,w,h}. `skip` as in hitTest. */
export function marqueeHit(boxes: Box[], rect: MarqueeRect, cfg: BoxFieldConfig, skip?: (i: number) => boolean): number[] {
  const mx1 = Math.min(rect.x, rect.x + rect.w), mx2 = Math.max(rect.x, rect.x + rect.w);
  const my1 = Math.min(rect.y, rect.y + rect.h), my2 = Math.max(rect.y, rect.y + rect.h);
  const out: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    if (skip && skip(i)) continue;
    const a = boxAABB(boxes[i], cfg);
    if (a.maxX >= mx1 && a.minX <= mx2 && a.maxY >= my1 && a.minY <= my2) out.push(i);
  }
  return out;
}

/** Move a set of boxes by (dx,dy) native px. Returns a NEW boxes array. */
export function moveBoxes(boxes: Box[], indices: number[], dx: number, dy: number, cfg: BoxFieldConfig): Box[] {
  const set = new Set(indices);
  return boxes.map((b, i) => {
    if (!set.has(i)) return b;
    const r = boxRect(b, cfg);
    return withRect(b, { x: r.x + dx, y: r.y + dy }, cfg);
  });
}

// Handle → local sign of the corner/edge being dragged. 0 = free on that axis.
const HANDLE_SIGN: Record<HandleName, [number, number]> = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0],
  ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1],
};

/**
 * Resize one box by dragging `handle`, given the TOTAL pointer delta (native px)
 * since the gesture began and the box's rect AT gesture start (`startRect`).
 * Rotation-aware: the opposite anchor stays fixed in world space.
 * opts: { minSize, keepAspect, fromCentre }.
 */
export function resizeRect(startRect: StartRect, handle: HandleName, dxTotal: number, dyTotal: number, opts: ResizeOpts = {}): Rect {
  const minSize = opts.minSize ?? 8;
  const [hx, hy] = HANDLE_SIGN[handle] || [0, 0];
  const rot = startRect.rot || 0;
  // World unit vectors of the box's local axes.
  const ax = rotateVec(1, 0, rot); // local +x in world
  const ay = rotateVec(0, 1, rot); // local +y in world
  // Pointer delta projected onto the local axes.
  const dLocalX = dxTotal * ax.x + dyTotal * ax.y;
  const dLocalY = dxTotal * ay.x + dyTotal * ay.y;
  let newW = startRect.w + (hx === 0 ? 0 : hx * dLocalX);
  let newH = startRect.h + (hy === 0 ? 0 : hy * dLocalY);
  newW = Math.max(minSize, newW);
  newH = Math.max(minSize, newH);

  if (opts.keepAspect && startRect.w > 0 && startRect.h > 0) {
    const aspect = startRect.w / startRect.h;
    if (hx !== 0 && hy !== 0) {
      // Corner drag: drive height from width along the aspect.
      newH = Math.max(minSize, newW / aspect);
      newW = newH * aspect;
    } else if (hx !== 0) {
      newH = newW / aspect;
    } else if (hy !== 0) {
      newW = newH * aspect;
    }
  }

  const c0 = { x: startRect.x + startRect.w / 2, y: startRect.y + startRect.h / 2 };
  if (opts.fromCentre) {
    return { x: c0.x - newW / 2, y: c0.y - newH / 2, w: newW, h: newH, rot };
  }
  // Fixed anchor = the corner OPPOSITE the dragged handle (local sign -hx,-hy),
  // kept put in world space.
  const fx = -hx, fy = -hy;
  const anchorLocal0 = { x: (fx * startRect.w) / 2, y: (fy * startRect.h) / 2 };
  const aw = rotateVec(anchorLocal0.x, anchorLocal0.y, rot);
  const anchorWorld = { x: c0.x + aw.x, y: c0.y + aw.y };
  const anchorLocal1 = { x: (fx * newW) / 2, y: (fy * newH) / 2 };
  const aw1 = rotateVec(anchorLocal1.x, anchorLocal1.y, rot);
  const c1 = { x: anchorWorld.x - aw1.x, y: anchorWorld.y - aw1.y };
  return { x: c1.x - newW / 2, y: c1.y - newH / 2, w: newW, h: newH, rot };
}

/** Snap an angle (deg) to the nearest `step` when within `tol` degrees. */
export function snapAngle(deg: number, step = 15, tol = 4): number {
  const nearest = Math.round(deg / step) * step;
  return Math.abs(deg - nearest) <= tol ? nearest : deg;
}

/** Normalise a degrees value into [-180, 180). */
export function normAngle(deg: number): number {
  let d = deg % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Align boxes to an edge. If `indices` has ≤1 box the reference is the artboard
 * (0..canvasW/H); otherwise it is the selection's union AABB. Edges:
 * 'left'|'hcentre'|'right'|'top'|'vcentre'|'bottom'. Returns a NEW boxes array.
 */
export function alignBoxes(boxes: Box[], indices: number[], edge: AlignEdge, cfg: BoxFieldConfig, canvas: Canvas): Box[] {
  if (!indices.length) return boxes;
  const single = indices.length <= 1;
  const ref = single
    ? { minX: 0, minY: 0, maxX: canvas.w, maxY: canvas.h }
    : selectionAABB(boxes, indices, cfg);
  if (!ref) return boxes;
  const set = new Set(indices);
  return boxes.map((b, i) => {
    if (!set.has(i)) return b;
    const a = boxAABB(b, cfg);
    let dx = 0, dy = 0;
    switch (edge) {
      case 'left': dx = ref.minX - a.minX; break;
      case 'right': dx = ref.maxX - a.maxX; break;
      case 'hcentre': dx = (ref.minX + ref.maxX) / 2 - (a.minX + a.maxX) / 2; break;
      case 'top': dy = ref.minY - a.minY; break;
      case 'bottom': dy = ref.maxY - a.maxY; break;
      case 'vcentre': dy = (ref.minY + ref.maxY) / 2 - (a.minY + a.maxY) / 2; break;
      default: return b;
    }
    const r = boxRect(b, cfg);
    return withRect(b, { x: r.x + dx, y: r.y + dy }, cfg);
  });
}

/**
 * Distribute boxes evenly along an axis ('h' or 'v') by equalising the GAPS
 * between adjacent AABBs, keeping the two extreme boxes fixed. Needs ≥3.
 * Returns a NEW boxes array.
 */
export function distributeBoxes(boxes: Box[], indices: number[], axis: Axis, cfg: BoxFieldConfig): Box[] {
  if (indices.length < 3) return boxes;
  const horiz = axis === 'h';
  const items = indices.map((i) => ({ i, a: boxAABB(boxes[i], cfg) }));
  items.sort((p, q) => (horiz ? p.a.minX - q.a.minX : p.a.minY - q.a.minY));
  const first = items[0]!.a, last = items[items.length - 1]!.a;
  const span = horiz ? last.maxX - first.minX : last.maxY - first.minY;
  let sizes = 0;
  for (const it of items) sizes += horiz ? it.a.w : it.a.h;
  const gap = (span - sizes) / (items.length - 1);
  const moves = new Map<number, number>();
  let cursor = horiz ? first.minX : first.minY;
  for (let k = 0; k < items.length; k++) {
    const it = items[k]!;
    const curMin = horiz ? it.a.minX : it.a.minY;
    if (k > 0 && k < items.length - 1) {
      moves.set(it.i, cursor - curMin);
    }
    cursor += (horiz ? it.a.w : it.a.h) + gap;
  }
  return boxes.map((b, i) => {
    if (!moves.has(i)) return b;
    const r = boxRect(b, cfg);
    const d = moves.get(i)!;
    return withRect(b, horiz ? { x: r.x + d } : { y: r.y + d }, cfg);
  });
}

/**
 * Re-stack boxes (z-order == array order; later = on top).
 * op: 'front'|'back'|'forward'|'backward'. Returns a NEW boxes array.
 */
export function reorderZ(boxes: Box[], indices: number[], op: ZOp): Box[] {
  const set = new Set(indices);
  if (!set.size) return boxes;
  if (op === 'front') {
    const keep = boxes.filter((_, i) => !set.has(i));
    const sel = boxes.filter((_, i) => set.has(i));
    return [...keep, ...sel];
  }
  if (op === 'back') {
    const keep = boxes.filter((_, i) => !set.has(i));
    const sel = boxes.filter((_, i) => set.has(i));
    return [...sel, ...keep];
  }
  const arr = boxes.slice();
  if (op === 'forward') {
    // Walk from top down so a moving box doesn't leapfrog another selected one.
    for (let i = arr.length - 2; i >= 0; i--) {
      if (set.has(i) && !set.has(i + 1)) {
        [arr[i], arr[i + 1]] = [arr[i + 1]!, arr[i]!];
        set.delete(i); set.add(i + 1);
      }
    }
    return arr;
  }
  if (op === 'backward') {
    for (let i = 1; i < arr.length; i++) {
      if (set.has(i) && !set.has(i - 1)) {
        [arr[i], arr[i - 1]] = [arr[i - 1]!, arr[i]!];
        set.delete(i); set.add(i - 1);
      }
    }
    return arr;
  }
  return boxes;
}

/**
 * Build a new box object from block-field defaults + a kind's seed + a rect + id.
 * Pure: the shell supplies `defaults` (declared field defaults) and `id`.
 */
export function seedBox(cfg: BoxFieldConfig, defaults: Box | null | undefined, kindSeed: Box | null | undefined, rect: Rect, id: string | number | null | undefined): Box {
  const box: Box = { ...(defaults || {}), ...(kindSeed || {}) };
  if (cfg.idField && id != null) box[cfg.idField] = id;
  box[cfg.xField] = Math.round(rect.x);
  box[cfg.yField] = Math.round(rect.y);
  box[cfg.wField] = Math.round(rect.w);
  box[cfg.hField] = Math.round(rect.h);
  if (cfg.rotationField && box[cfg.rotationField] == null) box[cfg.rotationField] = 0;
  return box;
}

/** Normalise a drag rect (can be dragged up/left) into positive w/h with a floor. */
export function normDragRect(x0: number, y0: number, x1: number, y1: number, minSize = 8): MarqueeRect {
  const x = Math.min(x0, x1), y = Math.min(y0, y1);
  let w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  if (w < minSize) w = minSize;
  if (h < minSize) h = minSize;
  return { x, y, w, h };
}

// ── Group transforms (multi-selection: scale + rotate about a pivot) ──────────
// A group / multi-selection scales UNIFORMLY (shear-free — a rotated box can't
// represent a non-uniform scale) about a fixed `anchor`, and rotates rigidly about
// a fixed `centre`. Text size + corner radius scale with the group so it reads as
// real scaling. Both return NEW boxes arrays.

export function scaleGroup(boxes: Box[], indices: number[], anchor: Point, k: number, cfg: BoxFieldConfig, opts: ScaleOpts = {}): Box[] {
  const set = new Set(indices);
  const minSize = opts.minSize ?? 1;
  const kk = k > 0 ? k : 0.01;
  return boxes.map((b, i) => {
    if (!set.has(i)) return b;
    const r = boxRect(b, cfg);
    const c = rectCentre(r);
    const nc = { x: anchor.x + (c.x - anchor.x) * kk, y: anchor.y + (c.y - anchor.y) * kk };
    const nw = Math.max(minSize, r.w * kk);
    const nh = Math.max(minSize, r.h * kk);
    const nb = withRect(b, { x: nc.x - nw / 2, y: nc.y - nh / 2, w: nw, h: nh }, cfg);
    if (cfg.fontSizeField && b[cfg.fontSizeField] != null && b[cfg.fontSizeField] !== '')
      nb[cfg.fontSizeField] = Math.max(1, Math.round(num(b[cfg.fontSizeField]) * kk));
    if (cfg.radiusField && b[cfg.radiusField] != null && b[cfg.radiusField] !== '')
      nb[cfg.radiusField] = Math.max(0, Math.round(num(b[cfg.radiusField]) * kk));
    return nb;
  });
}

export function rotateGroup(boxes: Box[], indices: number[], centre: Point, deltaDeg: number, cfg: BoxFieldConfig): Box[] {
  const set = new Set(indices);
  return boxes.map((b, i) => {
    if (!set.has(i)) return b;
    const r = boxRect(b, cfg);
    const c = rectCentre(r);
    const v = rotateVec(c.x - centre.x, c.y - centre.y, deltaDeg);
    const nc = { x: centre.x + v.x, y: centre.y + v.y };
    return withRect(b, { x: nc.x - r.w / 2, y: nc.y - r.h / 2, rot: normAngle(r.rot + deltaDeg) }, cfg);
  });
}

// ── Snapping ──────────────────────────────────────────────────────────────────
// Design-tool "smart guides": while moving/resizing/creating, snap the active
// box's edges + centres to the artboard (edges + centre) and to every OTHER box's
// edges + centres, and report guide line segments to draw. All native px.

interface SnapTarget {
  v: number;
  span?: [number, number];
}

interface SnapPick {
  d: number;
  line: number;
  span?: [number, number];
}

function pickSnap(edges: number[], targets: SnapTarget[], threshold: number): SnapPick | null {
  let best: SnapPick | null = null;
  for (const e of edges) {
    for (const t of targets) {
      const d = t.v - e;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: t.v, span: t.span };
    }
  }
  return best;
}

/**
 * Snap a rigidly-translating selection: `active` and `others` are AABBs
 * {minX,minY,maxX,maxY}. Returns { dx, dy, guides:[{x1,y1,x2,y2}] } — the extra
 * translation that lands an edge/centre on a target, plus guide segments.
 */
export function snapMove(active: AABB, others: AABB[], canvas: Canvas, threshold: number): SnapMoveResult {
  const acx = (active.minX + active.maxX) / 2, acy = (active.minY + active.maxY) / 2;
  const xTargets: SnapTarget[] = [
    { v: 0, span: [0, canvas.h] }, { v: canvas.w / 2, span: [0, canvas.h] }, { v: canvas.w, span: [0, canvas.h] },
  ];
  const yTargets: SnapTarget[] = [
    { v: 0, span: [0, canvas.w] }, { v: canvas.h / 2, span: [0, canvas.w] }, { v: canvas.h, span: [0, canvas.w] },
  ];
  for (const o of others) {
    const ocx = (o.minX + o.maxX) / 2, ocy = (o.minY + o.maxY) / 2;
    const yspan: [number, number] = [Math.min(active.minY, o.minY), Math.max(active.maxY, o.maxY)];
    const xspan: [number, number] = [Math.min(active.minX, o.minX), Math.max(active.maxX, o.maxX)];
    xTargets.push({ v: o.minX, span: yspan }, { v: ocx, span: yspan }, { v: o.maxX, span: yspan });
    yTargets.push({ v: o.minY, span: xspan }, { v: ocy, span: xspan }, { v: o.maxY, span: xspan });
  }
  const bx = pickSnap([active.minX, acx, active.maxX], xTargets, threshold);
  const by = pickSnap([active.minY, acy, active.maxY], yTargets, threshold);
  const guides: Guide[] = [];
  if (bx) guides.push({ x1: bx.line, y1: bx.span![0], x2: bx.line, y2: bx.span![1] });
  if (by) guides.push({ x1: by.span![0], y1: by.line, x2: by.span![1], y2: by.line });
  return { dx: bx ? bx.d : 0, dy: by ? by.d : 0, guides };
}

/**
 * Snap a single pointer/corner point (native px) to the artboard + sibling
 * edge/centre lines. Used for create-drag and unrotated resize (the handle
 * follows the pointer, so snapping the pointer aligns the moving edge).
 * Returns { x, y, guides }.
 */
export function snapPoint(px: number, py: number, others: AABB[], canvas: Canvas, threshold: number): SnapPointResult {
  const xTargets: SnapTarget[] = [{ v: 0 }, { v: canvas.w / 2 }, { v: canvas.w }];
  const yTargets: SnapTarget[] = [{ v: 0 }, { v: canvas.h / 2 }, { v: canvas.h }];
  for (const o of others) {
    xTargets.push({ v: o.minX }, { v: (o.minX + o.maxX) / 2 }, { v: o.maxX });
    yTargets.push({ v: o.minY }, { v: (o.minY + o.maxY) / 2 }, { v: o.maxY });
  }
  const bx = pickSnap([px], xTargets, threshold);
  const by = pickSnap([py], yTargets, threshold);
  const guides: Guide[] = [];
  if (bx) guides.push({ x1: bx.line, y1: 0, x2: bx.line, y2: canvas.h });
  if (by) guides.push({ x1: 0, y1: by.line, x2: canvas.w, y2: by.line });
  return { x: bx ? px + bx.d : px, y: by ? py + by.d : py, guides };
}

/** Clamp a box's rect so its centre stays within the artboard (never fully lost). */
export function clampBoxToCanvas(box: Box, cfg: BoxFieldConfig, canvas: Canvas): Box {
  const r = boxRect(box, cfg);
  const c = rectCentre(r);
  const cx = Math.max(0, Math.min(canvas.w, c.x));
  const cy = Math.max(0, Math.min(canvas.h, c.y));
  if (cx === c.x && cy === c.y) return box;
  return withRect(box, { x: r.x + (cx - c.x), y: r.y + (cy - c.y) }, cfg);
}

// ── Connector / edge geometry — re-exported from the engine (plan 90 R1) ──────────
// The routing, arrowheads, endpoint model, and the committed-SVG builder now live in
// engine/src/connectors.ts as the ONE source, so the editor preview here, the committed
// export, and the CLI all emit identical geometry. Re-exported so every existing
// `from './free-canvas-math.ts'` import keeps working unchanged.
export {
  edgeAnchor, edgeBorderPt, edgeWaypoints, edgeNested, connectorRoute,
  roundedEdgePath, smoothEdgePath, edgeArrowHead, edgeHeadInset,
  isEdgePoint, parseEdgePoint, formatEdgePoint, edgeEndRect, buildConnectorSvg,
} from '@lolly/engine';
export type { EdgeRect, EdgeAnchor, ConnectorRoute, ConnectorRenderOpts } from '@lolly/engine';

// ── on-canvas gradient editing ───────────────────────────────────────────────
//
// The geometry behind dragging a gradient's stops and direction directly on the
// artboard. DOM-free and unit-tested for the usual reason: a gesture that lands a
// stop 3% off is invisible in review and obvious to the person using it.

/** The two ends of a gradient's line: where 0% and 100% sit, in box-local px. */
export interface GradientLine {
  from: Point;
  to: Point;
}

/**
 * The gradient line for a `w`×`h` box at `angleDeg`, in CSS `linear-gradient`
 * terms: 0° points UP (the gradient runs bottom→top), 90° points right, and the
 * line is centred on the box and long enough that its ends sit exactly where the
 * first and last stop colours become solid.
 *
 * That length is not the box diagonal — CSS defines it as the projection of the
 * box onto the gradient direction, |w·sin θ| + |h·cos θ|, which is what makes a
 * 45° gradient reach the corners of a rectangle rather than stopping short. Using
 * the diagonal instead is the classic off-by-a-bit that makes on-canvas handles
 * disagree with the paint underneath them.
 */
export function gradientLine(w: number, h: number, angleDeg: number): GradientLine {
  const rad = (((angleDeg % 360) + 360) % 360) * Math.PI / 180;
  // CSS angle → direction vector. 0deg = up = (0,-1) in screen coords.
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = w / 2;
  const cy = h / 2;
  return {
    from: { x: cx - (dx * len) / 2, y: cy - (dy * len) / 2 },
    to: { x: cx + (dx * len) / 2, y: cy + (dy * len) / 2 },
  };
}

/**
 * Where a point falls along a gradient line, as a stop position 0–100 (clamped).
 * The point is projected ONTO the line, so a drag that wanders off the line still
 * moves the stop by the component that matters instead of stalling.
 */
export function gradientPosAt(w: number, h: number, angleDeg: number, px: number, py: number): number {
  const { from, to } = gradientLine(w, h, angleDeg);
  const vx = to.x - from.x;
  const vy = to.y - from.y;
  const len2 = vx * vx + vy * vy;
  if (!(len2 > 0)) return 0;
  const t = ((px - from.x) * vx + (py - from.y) * vy) / len2;
  return Math.min(100, Math.max(0, t * 100));
}

/**
 * The CSS gradient angle that points from the box centre toward (px, py) — what a
 * drag on the direction handle means. Snaps to the nearest `snap` degrees when
 * given one (the Shift-key affordance), so 0/45/90 are reachable exactly.
 */
export function gradientAngleAt(w: number, h: number, px: number, py: number, snap = 0): number {
  const dx = px - w / 2;
  const dy = py - h / 2;
  if (!dx && !dy) return 0;
  // Inverse of gradientLine's mapping: atan2(dx, -dy) puts 0° at "up".
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (snap > 0) deg = Math.round(deg / snap) * snap;
  return ((deg % 360) + 360) % 360;
}

// ── Frame primitive — membership + cascade geometry (plan 93 §5/§10) ──────────
//
// A "frame" is an ordinary box (kind === 'frame') that OWNS the boxes whose centre
// falls inside it. Membership is derived here, DOM-free, so the carousel strip is
// reproducible as N side-by-side frames: a frame at global x is the reference
// origin for its members' local coordinates. Pure — geometry read via `num`, no
// mutation of inputs, no assumption beyond flat x/y/w/h + kind/id/frame fields.

/** id of the LAST (topmost, z = array order) frame whose rect contains `box`'s centre; '' if none. A frame box never nests, so it resolves to ''. */
export function resolveFrame(box: Box | undefined, frameBoxes: Box[]): string {
  if (!box || box.kind === 'frame') return '';
  const cx = num(box.x) + num(box.w) / 2;
  const cy = num(box.y) + num(box.h) / 2;
  let hit = '';
  for (const f of frameBoxes) {
    const fx = num(f?.x), fy = num(f?.y);
    if (cx >= fx && cx <= fx + num(f?.w) && cy >= fy && cy <= fy + num(f?.h)) {
      hit = f?.id == null ? '' : String(f.id);
    }
  }
  return hit;
}

/** A box's position expressed relative to its frame's origin (the frame-local coordinate). */
export function frameLocalXY(box: Box | undefined, frame: Box | undefined): Point {
  return { x: num(box?.x) - num(frame?.x), y: num(box?.y) - num(frame?.y) };
}

/** New boxes array with the frame (id === frameId) AND every member (frame === frameId) shifted by (dx,dy); others untouched, input not mutated. */
export function cascadeFrameMove(boxes: Box[], frameId: string, dx: number, dy: number): Box[] {
  const fid = String(frameId);
  return boxes.map((b) => {
    const moves = (b?.id != null && String(b.id) === fid) || (b?.frame != null && String(b.frame) === fid);
    return moves ? { ...b, x: num(b.x) + dx, y: num(b.y) + dy } : b;
  });
}

/** New frame copies with `order` (0-based) assigned left→right by ascending x, stable for ties; input not mutated. */
export function seedFrameOrder(frameBoxes: Box[]): Box[] {
  const ranked = frameBoxes.map((b, i) => ({ i, x: num(b?.x) }));
  ranked.sort((a, b) => a.x - b.x || a.i - b.i);
  const order: number[] = new Array(frameBoxes.length);
  ranked.forEach((r, rank) => { order[r.i] = rank; });
  return frameBoxes.map((b, i) => ({ ...b, order: order[i] }));
}

/**
 * Renumber the `order` field of frame-kind boxes densely 0..n-1 to match `seq` — an
 * ordered list of frame ids (the new page sequence). Non-frame boxes, and frame boxes
 * whose id is absent from `seq`, are returned unchanged; a frame already carrying its
 * target rank keeps its identity (no needless re-render churn). Field names are injected
 * so the shell's configurable canvas fields drive it. Input is never mutated.
 *
 * Renumbering densely (not sparsely) is deliberate: the hook sorts pages by
 * (order asc, then x asc), so a gap-free 0..n-1 sequence means the x tie-break can never
 * fight the explicit order the user just chose.
 */
export function renumberFrameOrder(
  boxes: Box[],
  seq: string[],
  fields: { kindField: string; idField: string; orderField: string; frameKind: string },
): Box[] {
  const { kindField, idField, orderField, frameKind } = fields;
  const rank = new Map<string, number>();
  seq.forEach((id, i) => rank.set(String(id), i));
  return boxes.map((b) => {
    if (!b || String(b[kindField]) !== frameKind) return b;
    const id = b[idField] == null ? '' : String(b[idField]);
    const r = rank.get(id);
    if (r == null) return b;
    const cur = b[orderField];
    // Write when unset (so 0..n-1 is dense) or when the stored rank differs; otherwise
    // keep the existing object so an unchanged frame doesn't force a re-render.
    if (cur != null && cur !== '' && Number(cur) === r) return b;
    return { ...b, [orderField]: r };
  });
}

// ── Frames AS scenes — turn frame order into a timeline sequence (plan 92 §Frames) ─
//
// "Frames are scenes": the frame ORDER is a slideshow. Sequencing a frame doc lays every
// frame end-to-end in TIME on a scenes lane, so the sequence clock can gate the canvas to
// ONE frame at the playhead (a slide at a time) while spatial view still shows them side
// by side. Pure — reads the frame boxes, returns a NEW boxes array, never mutates. Writes
// ONLY the timeline fields (start/dur/lane/enter/exit); the committed geometry
// (x/y/w/h/order) is untouched, so a sequenced deck still exports as the same pages.
//
// UNITS: the timeline fields store SECONDS — the same contract timeline-math.ts and the
// tool hook's startSeconds/seqDurationMs read (a frame's start*1000 becomes its
// data-t-start ms). `defaultDurMs` is expressed in MILLISECONDS for the caller's
// convenience and converted to seconds here, so a 3000 ms default is 3 s in the field and
// 3000 in the emitted data-t-dur. Storing ms straight into the field would read back as
// 3000 s and clamp to the hour ceiling — the conversion is load-bearing, not cosmetic.

/** Ceiling for an authored time value, seconds. Mirrors timeline-math.ts MAX_TIME_S. */
const FRAME_MAX_TIME_S = 3600;
/** Floor for a scene's length, seconds. Mirrors timeline-math.ts MIN_DUR. */
const FRAME_MIN_DUR_S = 0.1;
/** ms grid for accumulated starts — mirrors timeline-math.ts r3 / packOrder. */
const r3s = (v: number): number => Math.round(v * 1000) / 1000;

/** Field names + defaults for {@link sequenceFramesInOrder}. */
export interface FrameSeqOpts {
  /** Default scene length, MILLISECONDS, for a frame with no authored dur (e.g. 3000). */
  defaultDurMs?: number;
  /** The scenes lane value written to every frame's lane field (e.g. 'seq'). */
  lane: string;
  /** Default enter transition when a frame has none authored (e.g. 'fade'). Omit to leave enter alone. */
  defaultEnter?: string;
  /** Default exit transition when a frame has none authored (e.g. 'fade'). Omit to leave exit alone. */
  defaultExit?: string;
  startField: string;
  durField: string;
  laneField: string;
  enterField: string;
  exitField: string;
  orderField: string;
  kindField: string;
  frameKind: string;
}

/** The subset of {@link FrameSeqOpts} that {@link framesAreSequenced} reads. */
export interface FramesSequencedCfg {
  kindField: string;
  frameKind: string;
  startField: string;
  durField: string;
}

/** Absent / empty / 'none' — the three spellings of "no transition authored". */
function noTransition(v: InputValue | undefined): boolean {
  return v == null || v === '' || v === 'none';
}

/** Does `v` parse to a finite number at all (an authored start, vs an empty field)? */
function finiteField(v: InputValue | undefined): boolean {
  if (v == null || v === '') return false;
  const x = typeof v === 'number' ? v : parseFloat(v as string);
  return Number.isFinite(x);
}

/**
 * Are the doc's frames already SEQUENCED — i.e. has any frame been given timing? A frame
 * counts as sequenced once it carries a scene length (dur>0) OR an authored start. Used to
 * decide whether to OFFER "play in order": offer only when frames exist and none are timed
 * yet, so the prompt never nags once the user has sequenced (or declined) them.
 */
export function framesAreSequenced(boxes: Box[], cfg: FramesSequencedCfg): boolean {
  const rows = Array.isArray(boxes) ? boxes : [];
  for (const b of rows) {
    if (!b || String(b[cfg.kindField]) !== cfg.frameKind) continue;
    if (num(b[cfg.durField], 0) > 0) return true;
    if (finiteField(b[cfg.startField])) return true;
  }
  return false;
}

/**
 * Sequence every FRAME box end-to-end in time, in play order (order asc, then x asc — the
 * exact key frameGroupsFor / seedFrameOrder use, so the timeline order matches the editor's
 * frame numbering). Each frame gets:
 *   • start = cumulative sum of the prior frames' durations (gapless from 0),
 *   • dur   = its existing dur when >0, else the default scene length,
 *   • lane  = the scenes lane,
 *   • enter/exit = its existing transition, else the default (only when a default is given).
 * Non-frame boxes are returned untouched (same reference). The input is never mutated, and a
 * frame already at its target timing keeps object identity (no re-render churn), so the
 * operation is idempotent in value.
 */
export function sequenceFramesInOrder(boxes: Box[], opts: FrameSeqOpts): Box[] {
  const rows = Array.isArray(boxes) ? boxes : [];
  const { startField, durField, laneField, enterField, exitField, orderField, kindField, frameKind, lane } = opts;
  const clampDur = (s: number): number => (s < FRAME_MIN_DUR_S ? FRAME_MIN_DUR_S : s > FRAME_MAX_TIME_S ? FRAME_MAX_TIME_S : s);
  const clampTime = (s: number): number => (s < 0 ? 0 : s > FRAME_MAX_TIME_S ? FRAME_MAX_TIME_S : s);
  const defaultDurS = clampDur(r3s(num(opts.defaultDurMs, 3000) / 1000));
  const defEnter = opts.defaultEnter;
  const defExit = opts.defaultExit;

  // Frame indices in play order: order asc, ties broken by x asc, then array index.
  const frames: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && String(rows[i]![kindField]) === frameKind) frames.push(i);
  }
  frames.sort((a, b) => {
    const oa = num(rows[a]![orderField], 0), ob = num(rows[b]![orderField], 0);
    if (oa !== ob) return oa - ob;
    const xa = num(rows[a]!.x, 0), xb = num(rows[b]!.x, 0);
    return xa !== xb ? xa - xb : a - b;
  });

  const starts = new Map<number, number>();
  const durs = new Map<number, number>();
  let cursor = 0;
  for (const i of frames) {
    const existing = num(rows[i]![durField], 0);
    const d = existing > 0 ? clampDur(existing) : defaultDurS;
    const room = FRAME_MAX_TIME_S - cursor;
    // ONE rounding grid (packOrder's discipline): advance the cursor by the STORED dur so
    // start[i] === start[i-1] + dur[i-1] exactly, else a gapless row grows sub-ms seams.
    const dr = clampDur(r3s(Math.min(d, room)));
    starts.set(i, cursor);
    durs.set(i, dr);
    cursor = clampTime(r3s(cursor + dr));
  }

  return rows.map((b, i) => {
    if (!b || !starts.has(i)) return b;
    const patch: Record<string, InputValue> = {
      [startField]: starts.get(i)!,
      [durField]: durs.get(i)!,
      [laneField]: lane,
    };
    if (defEnter != null && noTransition(b[enterField])) patch[enterField] = defEnter;
    if (defExit != null && noTransition(b[exitField])) patch[exitField] = defExit;
    let changed = false;
    for (const k of Object.keys(patch)) { if (b[k] !== patch[k]) { changed = true; break; } }
    return changed ? { ...b, ...patch } : b;
  });
}
