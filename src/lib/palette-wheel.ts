// SPDX-License-Identifier: MPL-2.0
/**
 * Palette colour wheel — every brand colour plotted on an OKLCH hue/chroma disc:
 * angle = hue (0° at top, clockwise), distance from the centre = chroma (greys
 * sit at the middle, vivid colours reach the rim), dot fill = the colour itself.
 * Lightness is the third axis — it rides in the dot's own colour, and is edited
 * in the swatch popover (color-formats.ts OKLCH), not by position.
 *
 * Two modes off one geometry (oklchWheelXY / wheelXYToChromaHue, both pure +
 * unit-tested):
 *  - renderPaletteWheel / wirePaletteWheel — the Dashboard's read-only instrument
 *    dial (hover a dot to read it).
 *  - renderBrandWheel / wireBrandWheel — the brand editor's LIVE wheel: drag a dot
 *    to recolour it (hue+chroma from where you drop it, lightness kept), click a
 *    dot to edit/delete it, click empty space to drop a new one there.
 */

import './palette-wheel.css';
import { hexToOklch, oklchToHex, formatOklch } from '@lolly/engine';
import { escapeHtml } from './html.ts';
import { WHEEL_R, WHEEL_R_IN, oklchWheelXY, wheelXYToChromaHue } from './palette-wheel-geom.ts';

export interface WheelColor { hex: string; label: string }

// Re-export the pure geometry so palette-wheel remains the one import site.
export { WHEEL_R, WHEEL_R_IN, WHEEL_CMAX, oklchWheelXY, wheelXYToChromaHue } from './palette-wheel-geom.ts';

/** #rrggbb → its wheel position, or null when it isn't a resolvable colour. */
function hexWheelXY(hex: string): { x: number; y: number; light: boolean } | null {
  const o = hexToOklch(hex);
  if (!o) return null;
  const { x, y } = oklchWheelXY(o);
  return { x, y, light: o.l > 0.82 };
}

// ── Read-only instrument dial (Dashboard bento) ──────────────────────────────

export function renderPaletteWheel(colors: readonly WheelColor[]): string {
  const dots = colors.map((c) => {
    const p = hexWheelXY(c.hex);
    if (!p) return '';
    return `<button type="button" class="dash-wheel-dot${p.light ? ' is-light' : ''}" role="listitem"
      style="left:${p.x.toFixed(2)}%;top:${p.y.toFixed(2)}%;--dot:${escapeHtml(c.hex)}"
      data-label="${escapeHtml(c.label)}" data-hex="${escapeHtml(c.hex.toUpperCase())}"
      aria-label="${escapeHtml(c.label)} ${escapeHtml(c.hex)}"></button>`;
  }).join('');
  return `
    <div class="dash-wheel-wrap">
      <div class="dash-wheel" role="list" aria-label="Palette colours plotted by hue and chroma">
        <div class="dash-wheel-ring" aria-hidden="true"></div>
        <div class="dash-wheel-grid" aria-hidden="true"></div>
        ${dots}
      </div>
      <div class="dash-wheel-preview" data-wheel-preview aria-hidden="true">
        <span class="dash-wheel-pv-swatch" data-wheel-pv-swatch aria-hidden="true"></span>
        <span class="dash-wheel-pv-text">
          <span class="dash-wheel-pv-name" data-wheel-pv-name>Hover a colour to read it</span>
          <code class="dash-wheel-pv-hex" data-wheel-pv-hex></code>
        </span>
      </div>
    </div>`;
}

/** Wire the readout beneath the read-only wheel: hover/focus a dot → name + hex. */
export function wirePaletteWheel(root: HTMLElement): void {
  const wheel = root.querySelector<HTMLElement>('.dash-wheel');
  if (!wheel) return;
  const pv = root.querySelector<HTMLElement>('[data-wheel-preview]');
  const pvSw = pv?.querySelector<HTMLElement>('[data-wheel-pv-swatch]') ?? null;
  const pvNm = pv?.querySelector<HTMLElement>('[data-wheel-pv-name]') ?? null;
  const pvHx = pv?.querySelector<HTMLElement>('[data-wheel-pv-hex]') ?? null;
  const clear = (): void => {
    pv?.classList.remove('is-active');
    if (pvSw) pvSw.style.background = 'transparent';
    if (pvNm) pvNm.textContent = 'Hover a colour to read it';
    if (pvHx) pvHx.textContent = '';
  };
  const show = (dot: HTMLElement): void => {
    pv?.classList.add('is-active');
    if (pvSw) pvSw.style.background = dot.dataset.hex || '';
    if (pvNm) pvNm.textContent = dot.dataset.label || '';
    if (pvHx) pvHx.textContent = dot.dataset.hex || '';
  };
  wheel.querySelectorAll<HTMLElement>('.dash-wheel-dot').forEach((dot) => {
    dot.addEventListener('pointerenter', () => show(dot));
    dot.addEventListener('focus', () => show(dot));
    dot.addEventListener('pointerleave', clear);
    dot.addEventListener('blur', clear);
  });
}

// ── Editable wheel (brand editor) ─────────────────────────────────────────────

export interface WheelDot { idx: number; hex: string; label: string }

export interface BrandWheelHandlers {
  /** Live during a drag: the dot moved to this hue/chroma (lightness + alpha kept). */
  onRecolor(idx: number, oklch: { l: number; c: number; h: number; alpha?: number }): void;
  /** The drag ended — a good moment to persist. */
  onCommit(idx: number): void;
  /** A dot was clicked (not dragged) — open its editor. */
  onPick(idx: number): void;
  /** Empty space was clicked — drop a new swatch seeded at this hue/chroma. */
  onAdd(seed: { l: number; c: number; h: number }): void;
  /** Current hex of a dot (drags keep its lightness). */
  hexOf(idx: number): string;
}

function dotHtml(d: WheelDot): string {
  const p = hexWheelXY(d.hex);
  const pos = p ?? { x: 50, y: 50, light: false };
  return `<button type="button" class="dash-wheel-dot dash-wheel-dot--edit${pos.light ? ' is-light' : ''}"
    style="left:${pos.x.toFixed(2)}%;top:${pos.y.toFixed(2)}%;--dot:${escapeHtml(d.hex || 'transparent')}"
    data-be-widx="${d.idx}" data-hex="${escapeHtml((d.hex || '').toUpperCase())}"
    aria-label="${escapeHtml(d.label)} ${escapeHtml(d.hex)} — drag to recolour, click to edit"></button>`;
}

/** The editable wheel's markup. Dots carry `data-be-widx` (their swatch index). */
export function renderBrandWheel(dots: readonly WheelDot[]): string {
  return `
    <div class="dash-wheel dash-wheel--edit" data-be-wheel role="group"
      aria-label="Palette wheel — drag a dot to recolour, click to edit, click empty space to add">
      <div class="dash-wheel-ring" aria-hidden="true"></div>
      <div class="dash-wheel-grid" aria-hidden="true"></div>
      ${dots.map(dotHtml).join('')}
    </div>
    <p class="be-wheel-hint">Angle = hue · distance out = chroma. Drag to recolour · click to edit · click empty space to add.</p>`;
}

/**
 * Wire the editable wheel. Returns a teardown. Pointer capture on the wheel makes
 * a drag continue even when the pointer leaves the disc; a press that doesn't move
 * past a small threshold is treated as a click (edit a dot / add on empty space).
 */
export function wireBrandWheel(root: HTMLElement, h: BrandWheelHandlers): () => void {
  const wheel = root.querySelector<HTMLElement>('[data-be-wheel]');
  if (!wheel) return () => {};
  let dragIdx = -1;         // the dot being pressed (-1 = pressing empty space)
  let moved = false;        // has the pointer travelled past the click threshold
  let startX = 0, startY = 0;
  let pointerId = -1;

  const posPct = (e: PointerEvent): { x: number; y: number } => {
    const r = wheel.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  };

  const onDown = (e: PointerEvent): void => {
    const dot = (e.target as HTMLElement).closest<HTMLElement>('[data-be-widx]');
    dragIdx = dot ? Number(dot.dataset.beWidx) : -1;
    moved = false; startX = e.clientX; startY = e.clientY; pointerId = e.pointerId;
    wheel.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
    moved = true;
    if (dragIdx < 0) return; // dragging on empty space isn't a recolour
    const { x, y } = posPct(e);
    const { c, h: hue } = wheelXYToChromaHue(x, y);
    const cur = hexToOklch(h.hexOf(dragIdx)) ?? { l: 0.62, c, h: hue };
    // Keep the swatch's lightness AND its opacity — dragging only moves hue+chroma.
    h.onRecolor(dragIdx, { l: cur.l, c, h: hue, alpha: cur.alpha });
  };
  const onUp = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    if (wheel.hasPointerCapture(e.pointerId)) wheel.releasePointerCapture(e.pointerId);
    pointerId = -1;
    if (moved) { if (dragIdx >= 0) h.onCommit(dragIdx); }
    else if (dragIdx >= 0) h.onPick(dragIdx);
    else {
      const { x, y } = posPct(e);
      const { c, h: hue } = wheelXYToChromaHue(x, y);
      h.onAdd({ l: 0.62, c: Math.max(c, 0.02), h: hue });
    }
    dragIdx = -1;
  };
  wheel.addEventListener('pointerdown', onDown);
  wheel.addEventListener('pointermove', onMove);
  wheel.addEventListener('pointerup', onUp);
  wheel.addEventListener('pointercancel', onUp);
  return () => {
    wheel.removeEventListener('pointerdown', onDown);
    wheel.removeEventListener('pointermove', onMove);
    wheel.removeEventListener('pointerup', onUp);
    wheel.removeEventListener('pointercancel', onUp);
  };
}

/** Move + recolour a single live dot in place (during a drag) without a re-render. */
export function updateWheelDot(root: HTMLElement, idx: number, hex: string): void {
  const dot = root.querySelector<HTMLElement>(`[data-be-widx="${idx}"]`);
  if (!dot) return;
  const p = hexWheelXY(hex);
  if (p) { dot.style.left = `${p.x.toFixed(2)}%`; dot.style.top = `${p.y.toFixed(2)}%`; dot.classList.toggle('is-light', p.light); }
  dot.style.setProperty('--dot', hex || 'transparent');
  dot.dataset.hex = (hex || '').toUpperCase();
}

/** Format an OKLCH value as the `oklch()` string the DTCG doc stores (alpha kept
 *  as `/ a` when < 1, via formatOklch). */
export function oklchToStored(o: { l: number; c: number; h: number; alpha?: number }): string {
  return formatOklch(o);
}
/** OKLCH → hex (hex8 when alpha < 1), for live tile/preview repaint alongside a drag. */
export function oklchHex(o: { l: number; c: number; h: number; alpha?: number }): string {
  return oklchToHex(o);
}
