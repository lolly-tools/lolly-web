// SPDX-License-Identifier: MPL-2.0
/**
 * OKLCH gamut charts — a 2D plane through colour space, painted as real pixels,
 * with the sRGB / Display-P3 / Rec.2020 boundaries visible on it.
 *
 * This is the companion to palette-wheel.ts, not a replacement. The wheel is an
 * instrument dial: it shows a palette's spread of hue and chroma at a glance.
 * What it structurally cannot show is where the gamut ends, because the sRGB
 * boundary is a curve in lightness×chroma that moves with hue, and the wheel has
 * no lightness axis. That curve is the thing a brand decision turns on — it is
 * why a yellow can be twice as chromatic as a blue, why an evenly-stepped ramp
 * goes lopsided across hues, and why a colour "changes" when exported.
 *
 * ## How it's drawn: one fill, contour lines on top
 *
 * A single pass of the engine primitive (`host.color.slice` / `oklchSlice`) at
 * the widest gamut being charted, painted at FULL strength, with each narrower
 * gamut's boundary stroked over it as a thin contour — the way oklch.com reads,
 * and the way a topographic map reads.
 *
 * An earlier version drained chroma from the wide-gamut bands to mark them as
 * unshowable. It was defensible but wrong in practice: going outward past a line
 * made the colour look DULLER, which is backwards from what the axis says, and it
 * cost three slice passes instead of one — the bulk of the lag while dragging.
 * The contour carries the same information without editing the colour.
 *
 * Honesty note, and it matters: the canvas is 8-bit sRGB, so every pixel outside
 * sRGB is painted GAMUT-MAPPED — the nearest sRGB colour, not the real one. What
 * the chart shows past the sRGB contour is therefore approximate by construction;
 * the contour is the fact.
 */

// No `import './oklch-slice.css'` here, deliberately: the node test runner has
// no CSS loader, so a module that imports a stylesheet cannot be exercised under
// `node --test` at all (which is why palette-wheel had to split its geometry
// into a second file to get any coverage). Mounting surfaces import
// `lib/oklch-slice.css` themselves — brand-editor.ts does, alongside the rest of
// the studio's sheet — and this module stays testable as a whole.
import { hexToOklch, oklchSlice, sliceGamutRegion } from '@lolly/engine';
import type { SlicePlane, GamutName } from '@lolly/engine';
import { escapeHtml } from './html.ts';
import {
  SLICE_C_MAX, SLICE_AXES, oklchSliceXY, sliceXYToOklch, sliceOffPlane, sliceTicks,
} from './oklch-slice-geom.ts';

export { SLICE_C_MAX, SLICE_AXES, sliceFixedOf } from './oklch-slice-geom.ts';

/** One palette swatch plotted on a chart. `idx` indexes the editor's swatch list. */
export interface SliceDot { idx: number; hex: string; label: string }

export interface SliceChartState {
  plane: SlicePlane;
  /** The channel the plane holds constant: hue° for 'lc', lightness for 'ch', chroma for 'lh'. */
  fixed: number;
  cMax?: number;
  /** The widest gamut to chart. Default 'rec2020' — everything we can classify.
   *  Narrowing it stops the fill (and the legend, and the P3 edge) at that
   *  gamut, for a caller that wants the chart to answer one display's question. */
  limit?: Exclude<GamutName, 'none'>;
}

/** Human names for the axes, used in labels and the hint line. */
const CHANNEL_NAME: Record<'l' | 'c' | 'h', string> = {
  l: 'Lightness', c: 'Chroma', h: 'Hue',
};

const PLANE_LABEL: Record<SlicePlane, string> = {
  lc: 'Lightness × Chroma',
  ch: 'Chroma × Hue',
  lh: 'Lightness × Hue',
};

/** The fixed channel's value, formatted the way that channel is normally read. */
export function formatFixed(plane: SlicePlane, fixed: number): string {
  const ch = SLICE_AXES[plane].fixed;
  if (ch === 'h') return `${Math.round(fixed)}°`;
  if (ch === 'l') return `${Math.round(fixed * 100)}%`;
  return fixed.toFixed(3);
}

// ── Markup ────────────────────────────────────────────────────────────────────

function ticksHtml(ch: 'l' | 'c' | 'h', axis: 'x' | 'y', cMax: number): string {
  return sliceTicks(ch, cMax).map((t) => {
    // The y axis runs bottom-up (its maximum is at the top), so a tick at
    // fraction `at` sits at 1 - at from the top.
    const pos = axis === 'x' ? t.at : 1 - t.at;
    const side = axis === 'x' ? 'left' : 'top';
    return `<span class="okls-tick" style="${side}:${(pos * 100).toFixed(3)}%">${escapeHtml(t.label)}</span>`;
  }).join('');
}

function dotHtml(d: SliceDot, plane: SlicePlane, fixed: number, cMax: number): string {
  const o = hexToOklch(d.hex);
  if (!o) return '';
  const p = oklchSliceXY(plane, o, cMax);
  const off = sliceOffPlane(plane, o, fixed, cMax);
  const fixedCh = CHANNEL_NAME[SLICE_AXES[plane].fixed].toLowerCase();
  const aria = off > 0.02
    ? `${d.label} ${d.hex} — off this slice (different ${fixedCh}); drag to recolour, click to bring the slice to it`
    : `${d.label} ${d.hex} — drag to recolour, click to edit`;
  return `<button type="button" class="okls-dot${o.l > 0.82 ? ' is-light' : ''}"
    style="left:${(p.x * 100).toFixed(3)}%;top:${(p.y * 100).toFixed(3)}%;--dot:${escapeHtml(d.hex)};--off:${off.toFixed(3)}"
    data-okls-idx="${d.idx}" data-hex="${escapeHtml(d.hex.toUpperCase())}"
    aria-label="${escapeHtml(aria)}"></button>`;
}

/**
 * The chart's markup — canvas fill, boundary overlay, axis ticks and the palette
 * dots. Call {@link paintSliceChart} after it is in the document (the canvas
 * needs a measured box) and {@link wireSliceChart} to make it interactive.
 */
export function renderSliceChart(
  state: SliceChartState,
  dots: readonly SliceDot[] = [],
  opts: { editable?: boolean } = {},
): string {
  const cMax = state.cMax ?? SLICE_C_MAX;
  const axes = SLICE_AXES[state.plane];
  const edit = opts.editable ? ' is-editable' : '';
  const label = `${PLANE_LABEL[state.plane]} at ${CHANNEL_NAME[axes.fixed].toLowerCase()} ${formatFixed(state.plane, state.fixed)}`;
  return `
    <div class="okls" data-okls data-plane="${state.plane}">
      <div class="okls-frame">
        <div class="okls-axis okls-axis--y" aria-hidden="true">
          <span class="okls-axis-name">${escapeHtml(CHANNEL_NAME[axes.y])}</span>
          ${ticksHtml(axes.y, 'y', cMax)}
        </div>
        <div class="okls-plot${edit}" data-okls-plot role="group" aria-label="${escapeHtml(label)}">
          <canvas class="okls-canvas" data-okls-canvas aria-hidden="true"></canvas>
          <svg class="okls-edges" data-okls-edges viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
            <path class="okls-edge okls-edge--p3" data-okls-edge="p3" fill="none" vector-effect="non-scaling-stroke"></path>
            <path class="okls-edge okls-edge--srgb" data-okls-edge="srgb" fill="none" vector-effect="non-scaling-stroke"></path>
          </svg>
          ${dots.map(d => dotHtml(d, state.plane, state.fixed, cMax)).join('')}
        </div>
      </div>
      <div class="okls-axis okls-axis--x" aria-hidden="true">
        ${ticksHtml(axes.x, 'x', cMax)}
        <span class="okls-axis-name">${escapeHtml(CHANNEL_NAME[axes.x])}</span>
      </div>
      <p class="okls-legend">${legendHtml(state.limit ?? 'rec2020')}</p>
    </div>`;
}

/**
 * A key per CONTOUR actually drawn, plus one for the empty area.
 *
 * The keys are LINE WEIGHTS, not colour chips, because that is what distinguishes
 * the boundaries on the chart: every contour is the same white line and they are
 * told apart by thickness. A coloured dot would be describing a rendering the
 * chart no longer uses. The widest gamut gets no line key either — its boundary
 * is where the colour stops, so the checkerboard key is the one that names it.
 */
function legendHtml(limit: Exclude<GamutName, 'none'>): string {
  const keys: string[] = [];
  for (const g of ['srgb', 'p3', 'rec2020'] as const) {
    if (g === limit) break; // no contour is drawn for the limit itself
    keys.push(`<span class="okls-key okls-key--line okls-key--${g}">${GAMUT_KEY_LABEL[g]}</span>`);
  }
  keys.push(`<span class="okls-key okls-key--none">past ${GAMUT_KEY_LABEL[limit]} — no display</span>`);
  return keys.join('');
}

const GAMUT_KEY_LABEL: Record<Exclude<GamutName, 'none'>, string> = {
  srgb: 'sRGB', p3: 'Display-P3', rec2020: 'Rec.2020',
};

// ── Painting ──────────────────────────────────────────────────────────────────

/** What a canvas was last painted with, so an identical repaint is skipped. */
const PAINTED = new WeakMap<HTMLCanvasElement, string>();

/**
 * Paint (or repaint) a chart's fill and boundary lines. Safe to call on every
 * frame of a drag: it no-ops when nothing that affects the pixels has changed,
 * and `quality: 'draft'` halves the resolution for the duration of a scrub.
 *
 * Cost at full quality is three engine slices — about 17ms for a 320×200 plot on
 * a laptop, so this belongs inside a rAF, not in a pointermove handler.
 */
export function paintSliceChart(
  root: HTMLElement,
  state: SliceChartState,
  opts: { quality?: 'full' | 'draft' } = {},
): void {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-okls-canvas]');
  const plot = root.querySelector<HTMLElement>('[data-okls-plot]');
  if (!canvas || !plot) return;
  const box = plot.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return; // not laid out yet (a folded card)

  const cMax = state.cMax ?? SLICE_C_MAX;
  const draft = opts.quality === 'draft';
  // Cap the backing store: past ~2 device pixels per CSS pixel the extra detail
  // is invisible on a gradient field but the paint cost is real.
  const scale = draft ? 0.5 : Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(box.width * scale));
  const h = Math.max(1, Math.round(box.height * scale));

  const limit = state.limit ?? 'rec2020';
  const key = `${state.plane}|${state.fixed.toFixed(4)}|${cMax}|${limit}|${w}x${h}`;
  if (PAINTED.get(canvas) === key) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);

  // One pass, at the widest gamut being charted, at full strength. Anything past
  // it comes back transparent and the plot's checkerboard shows through, so "no
  // display can do this" reads as absence rather than as a colour choice.
  const img = oklchSlice({ plane: state.plane, fixed: state.fixed, width: w, height: h, cMax, limit });
  const out = ctx.createImageData(w, h);
  out.data.set(img.data);
  ctx.putImageData(out, 0, 0);
  PAINTED.set(canvas, key);

  paintEdges(root, state, cMax, limit);
}

/** Trace the sRGB and P3 boundaries as polylines, where the plane has one. */
/**
 * Stroke each narrower gamut's boundary as a contour over the fill.
 *
 * Built from `sliceGamutRegion` (closed rings) rather than the open-curve
 * `sliceGamutEdge`, because rings exist for ALL THREE planes — 'lh' has no
 * single-valued boundary curve, and it used to be left with no contour at all.
 * The ring also runs along the achromatic edge, which lands on the plot border
 * where it reads as part of the frame.
 */
function paintEdges(
  root: HTMLElement, state: SliceChartState, cMax: number,
  limit: Exclude<GamutName, 'none'>,
): void {
  const svg = root.querySelector<SVGSVGElement>('[data-okls-edges]');
  if (!svg) return;
  for (const edge of ['srgb', 'p3'] as const) {
    const path = svg.querySelector<SVGPathElement>(`[data-okls-edge="${edge}"]`);
    if (!path) continue;
    // Don't trace a boundary the fill stops short of: on an sRGB-only chart a P3
    // contour would float in empty space. And the widest gamut needs no contour —
    // the edge of the fill IS its boundary.
    const skip = edge === limit || (edge === 'p3' && limit === 'srgb');
    const rings = skip ? [] : sliceGamutRegion(state.plane, state.fixed, edge, 128, cMax);
    path.setAttribute('d', rings.map(ring =>
      `${ring.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(5)} ${p.y.toFixed(5)}`).join(' ')} Z`,
    ).join(' '));
  }
  svg.classList.remove('is-empty');
}

/** Reposition + recolour one dot in place during a drag, without re-rendering. */
export function updateSliceDot(
  root: HTMLElement, idx: number, hex: string, state: SliceChartState,
): void {
  const dot = root.querySelector<HTMLElement>(`[data-okls-idx="${idx}"]`);
  if (!dot) return;
  const cMax = state.cMax ?? SLICE_C_MAX;
  const o = hexToOklch(hex);
  if (o) {
    const p = oklchSliceXY(state.plane, o, cMax);
    dot.style.left = `${(p.x * 100).toFixed(3)}%`;
    dot.style.top = `${(p.y * 100).toFixed(3)}%`;
    dot.style.setProperty('--off', sliceOffPlane(state.plane, o, state.fixed, cMax).toFixed(3));
    dot.classList.toggle('is-light', o.l > 0.82);
  }
  dot.style.setProperty('--dot', hex || 'transparent');
  dot.dataset.hex = (hex || '').toUpperCase();
}

// ── Interaction ───────────────────────────────────────────────────────────────

export interface SliceChartHandlers {
  /** Live during a drag: the dot moved to this position on the plane. */
  onRecolor(idx: number, oklch: { l: number; c: number; h: number; alpha?: number }): void;
  /** The drag ended — a good moment to persist. */
  onCommit(idx: number): void;
  /** A dot was clicked, not dragged — open its editor. */
  onPick(idx: number): void;
  /** Empty space was clicked — drop a new swatch at this colour. */
  onAdd(seed: { l: number; c: number; h: number }): void;
  /** Current hex of a dot, so a drag can keep the channels the plane doesn't move. */
  hexOf(idx: number): string;
  /** The chart's current state, read fresh on each event (plane/fixed can change under it). */
  stateOf(): SliceChartState;
}

/**
 * Make a chart interactive: drag a dot to recolour it, click one to edit, click
 * empty space to add. Returns a teardown.
 *
 * A drag moves ONLY the two channels the plane has axes for. The swatch keeps
 * its own value on the fixed channel — dragging a dot on the L×C plane at hue
 * 145 does not rotate a blue swatch to green. That is why an off-plane dot stays
 * off-plane (and stays faded) while you drag it: the projection is telling the
 * truth about where the colour is, and quietly snapping its hue to the plane's
 * would be the chart editing something the user did not point at.
 */
export function wireSliceChart(root: HTMLElement, h: SliceChartHandlers): () => void {
  const plot = root.querySelector<HTMLElement>('[data-okls-plot]');
  if (!plot) return () => {};

  let dragIdx = -1;
  let moved = false;
  let startX = 0, startY = 0;
  let pointerId = -1;

  /** Pointer → position on the plane, as 0–1 fractions of the plot box. */
  const posOf = (e: PointerEvent): { x: number; y: number } => {
    const r = plot.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  /** The colour at a position, keeping `keep`'s value on the fixed channel. */
  const colorAt = (e: PointerEvent, keep?: string): { l: number; c: number; h: number; alpha?: number } => {
    const st = h.stateOf();
    const { x, y } = posOf(e);
    const cur = keep ? hexToOklch(keep) : null;
    const fixedCh = SLICE_AXES[st.plane].fixed;
    const fixed = cur ? (fixedCh === 'h' ? cur.h : fixedCh === 'l' ? cur.l : cur.c) : st.fixed;
    const o = sliceXYToOklch(st.plane, x, y, fixed, st.cMax ?? SLICE_C_MAX);
    return cur?.alpha != null ? { ...o, alpha: cur.alpha } : o;
  };

  const onDown = (e: PointerEvent): void => {
    const dot = (e.target as HTMLElement).closest<HTMLElement>('[data-okls-idx]');
    dragIdx = dot ? Number(dot.dataset.oklsIdx) : -1;
    moved = false; startX = e.clientX; startY = e.clientY; pointerId = e.pointerId;
    plot.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
    moved = true;
    if (dragIdx < 0) return; // a drag across empty space isn't a recolour
    h.onRecolor(dragIdx, colorAt(e, h.hexOf(dragIdx)));
  };
  const onUp = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    if (plot.hasPointerCapture(e.pointerId)) plot.releasePointerCapture(e.pointerId);
    pointerId = -1;
    if (moved) { if (dragIdx >= 0) h.onCommit(dragIdx); }
    else if (dragIdx >= 0) h.onPick(dragIdx);
    else h.onAdd(colorAt(e));
    dragIdx = -1;
  };

  plot.addEventListener('pointerdown', onDown);
  plot.addEventListener('pointermove', onMove);
  plot.addEventListener('pointerup', onUp);
  plot.addEventListener('pointercancel', onUp);
  return () => {
    plot.removeEventListener('pointerdown', onDown);
    plot.removeEventListener('pointermove', onMove);
    plot.removeEventListener('pointerup', onUp);
    plot.removeEventListener('pointercancel', onUp);
  };
}
