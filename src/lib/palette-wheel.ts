// SPDX-License-Identifier: MPL-2.0
/**
 * Palette color wheel — plots each brand colour where it actually sits on the hue
 * circle: angle = hue, distance from centre = saturation, dot fill = the colour itself.
 * Neutrals (no chroma) settle onto a short vertical axis by lightness. It is built
 * straight from the passed palette, so adding a colour re-plots it with no other change.
 *
 * A signature piece for the Dashboard's brand-system panel: the palette as an instrument
 * dial rather than a grid of chips. Hover/focus a dot to read its name + hex in the hub.
 */

import './palette-wheel.css';
import { escapeHtml } from './html.ts';

export interface WheelColor { hex: string; label: string }

/** #rgb / #rrggbb → { h (0-360), s (0-100), l (0-100) }, or null for non-hex. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h6 = m[1]!;
  if (h6.length === 3) h6 = h6.split('').map((c) => c + c).join('');
  const r = parseInt(h6.slice(0, 2), 16) / 255;
  const g = parseInt(h6.slice(2, 4), 16) / 255;
  const b = parseInt(h6.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

/**
 * Build the wheel HTML for a set of colours. Angle is the hue; distance from the centre is
 * the LIGHTNESS — dark shades sit near the middle, bright tints reach the rim. So a family's
 * tint ramp (persimmon-1…8) fans out along one hue spoke, dark in → bright out, instead of
 * the shades piling on top of each other. Non-hex ('transparent') entries are dropped.
 */
export function renderPaletteWheel(colors: readonly WheelColor[]): string {
  const R = 41;      // rim radius (% of box) — the lightest tints land here
  const R_IN = 7;    // inner floor so the very darkest shades still clear the exact centre
  const dots = colors.map((c) => {
    const hsl = hexToHsl(c.hex);
    if (!hsl) return '';
    const neutral = hsl.s < 12;
    // Chromatic: polar plot, radius = lightness (bright → outer). Neutrals have no hue, so
    // they ride a central value strip instead — light up top, dark at the bottom.
    const rad = R_IN + (hsl.l / 100) * (R - R_IN);
    const x = neutral ? 50 : 50 + rad * Math.sin((hsl.h * Math.PI) / 180);
    const y = neutral ? 50 - ((hsl.l - 50) / 50) * (R * 0.62) : 50 - rad * Math.cos((hsl.h * Math.PI) / 180);
    // A ring around light dots so #fff-ish colours don't vanish on the card.
    const ringed = hsl.l > 82;
    return `<button type="button" class="dash-wheel-dot${ringed ? ' is-light' : ''}" role="listitem"
      style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;--dot:${escapeHtml(c.hex)}"
      data-label="${escapeHtml(c.label)}" data-hex="${escapeHtml(c.hex.toUpperCase())}"
      aria-label="${escapeHtml(c.label)} ${escapeHtml(c.hex)}"></button>`;
  }).join('');
  return `
    <div class="dash-wheel-wrap">
      <div class="dash-wheel" role="list" aria-label="Palette colours plotted by hue and lightness">
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

/** Wire the readout beneath the wheel: hovering/focusing a dot shows its name + hex. */
export function wirePaletteWheel(root: HTMLElement): void {
  const wheel = root.querySelector<HTMLElement>('.dash-wheel');
  if (!wheel) return;
  // The big readout beneath the wheel — the readable copy of the hovered colour.
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
    const hex = dot.dataset.hex || '';
    const label = dot.dataset.label || '';
    pv?.classList.add('is-active');
    if (pvSw) pvSw.style.background = hex;
    if (pvNm) pvNm.textContent = label;
    if (pvHx) pvHx.textContent = hex;
  };
  wheel.querySelectorAll<HTMLElement>('.dash-wheel-dot').forEach((dot) => {
    dot.addEventListener('pointerenter', () => show(dot));
    dot.addEventListener('focus', () => show(dot));
    dot.addEventListener('pointerleave', clear);
    dot.addEventListener('blur', clear);
  });
}
