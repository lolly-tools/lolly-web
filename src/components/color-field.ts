// SPDX-License-Identifier: MPL-2.0
/**
 * Shared SUSE colour picker — the ONE colour field used across the app.
 *
 * Renders the palette swatches + hex entry + alpha + native picker + current
 * swatch, and wires their behaviour. Both the single-tool sidebar (views/tool.js)
 * and the /pro batch grid use this, so there is a single implementation to
 * maintain (no per-view variations).
 *
 * Markup styling lives in styles/app.css (`.color-picker-field`, `.color-popover`,
 * `.color-swatch`, `.color-trigger`, …) — global, so it applies wherever this
 * markup is mounted.
 *
 *   colorFieldHtml(id, value, { float })   → HTML string for one field
 *   wireColorField(scopeEl, { onChange, onInteractStart, onInteractEnd })
 *
 * `float` makes the popover position itself (fixed) anchored to the trigger and
 * close on outside-click — for hosts where the field sits inside a clipping /
 * scrolling container (the /pro grid). Regular sidebar fields use plain CSS
 * positioning; block-colour fields keep their sidebar-spanning behaviour.
 */
import { hexToOklch, oklchToHex } from '@lolly/engine';
import type { Oklch } from '@lolly/engine';
import { PALETTE } from '../palette.ts';
import { escape } from '../utils.ts';

/** One swatch as the picker renders it (see SWATCHES below). */
export interface ColorSwatchOption {
  value: string;
  label?: string | null;
  group?: string | null;
  /** canonical token reference ('{color.brand.jungle}') — null for plain colours */
  ref?: string | null;
}

/** What onChange receives: a plain colour string, or a token-linked value. */
export type ColorFieldValue = string | { ref: string; value: string };

export interface WireColorFieldOpts {
  onChange?(id: string, value: ColorFieldValue): void;
  onInteractStart?(): void;
  onInteractEnd?(): void;
}

// The swatch source the picker renders. Defaults to the built-in brand palette
// (so the picker works before — and without — tokens), and is replaced at runtime
// by setSwatches() with swatches resolved from design tokens. Shape per swatch:
//   { value: '#rrggbb' | 'transparent', label, group, ref|null }
// `ref` is the canonical token reference ('{color.brand.jungle}'); choosing such a
// swatch stores a token value so the colour stays linked to the token.
let SWATCHES: ColorSwatchOption[] = PALETTE.map(s => ({ value: s.hex, label: s.label, group: s.group ?? null, ref: null }));

/** Replace the picker's swatches (e.g. with tokens). Ignored if empty/invalid. */
export function setSwatches(list: ColorSwatchOption[]): void {
  if (Array.isArray(list) && list.length) SWATCHES = list;
}

// A colour value may be a token value object ({ ref, value }); the field UI works
// in plain colour strings, so coerce to the (cached) hex for display.
function toHex(value: unknown): string {
  const o = value as { ref?: unknown; value?: unknown };
  return ((value && typeof value === 'object' && typeof o.ref === 'string') ? (o.value ?? '') : value) as string;
}

/**
 * The palette name for a colour value ("Persimmon 3"), or '' when it isn't a named
 * swatch (a custom colour). Matches on the RGB channels — alpha is ignored — against
 * the active swatch list (the brand palette, or tokens once setSwatches() has run).
 * The FIRST matching swatch wins, so a hex shared by several ramps takes its primary
 * name (e.g. #0c322c → "Pine", not "Jungle 1").
 */
export function swatchName(value: unknown): string {
  const raw = toHex(value);
  if (typeof raw !== 'string' || !raw) return '';
  let v = raw.toLowerCase();
  if (v !== 'transparent' && /^#[0-9a-f]{8}$/.test(v)) v = v.slice(0, 7); // ignore alpha when naming
  for (const s of SWATCHES) {
    const sv = typeof s.value === 'string' ? s.value.toLowerCase() : '';
    if (sv && sv === v) return s.label || '';
  }
  return '';
}

// A colour value is only interpolated into an inline `style="…"` attribute after
// passing this shape test: a bare hex, a colour function (rgb()/hsl()/oklch()/…)
// whose arguments contain no nested parens/quotes/semicolons/braces, or a plain
// ident ('rebeccapurple', 'transparent'). Swatch values can come from a
// user-IMPORTED tokens document (setSwatches ← host.tokens.colors(), fed by the
// #/start wizard), and escape() doesn't neutralise CSS metacharacters — so a
// malicious $value like `#000; background-image:url(https://evil.example/x)`
// would otherwise smuggle a live declaration into the attribute and fire an
// external request. The engine's colorToHex is the primary gate upstream; this
// is the defense-in-depth at the sink.
const SAFE_CSS_COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^();"'{}<>\\]*\)|[a-z][a-z0-9-]*)$/i;

/** `v` when it's a safely inlinable CSS colour, else '' (paints nothing). */
function safeCssColor(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return SAFE_CSS_COLOR.test(s) ? s : '';
}

// ── OKLCH sliders (the LCH-first custom-colour surface) ─────────────────────
// The picker's custom-colour controls are OKLCH sliders — perceptual axes
// (lightness / chroma / hue) instead of the RGB cube, matching the OKLCH-native
// brand token system. The engine's brand-derive module is the conversion
// authority: hexToOklch to seed the sliders, gamut-mapped oklchToHex (chroma
// reduced until sRGB-representable) on the way out — so any slider position
// yields a real, in-gamut hex.

/** Slider ranges. C's ceiling is CSS Color 4's practical sRGB chroma maximum. */
export const LCH_MAX = { l: 100, c: 0.4, h: 360 } as const;

/** Sliders' fallback when the current value has no colour to seed from
 * ('transparent', or an unparsable string): a pleasant mid-blue, not black —
 * black sits at C=0 where the H slider does nothing, a dead-feeling start. */
const LCH_SEED: Oklch = { l: 0.62, c: 0.11, h: 250 };

/**
 * The three slider-track gradients for the current colour, as CSS backgrounds.
 * Each axis sweeps its own range while holding the other two at the current
 * value, so the track previews exactly what dragging that thumb will do.
 * Stops are raw `oklch()` strings — the browser renders and gamut-maps them;
 * no per-stop JS conversion. Exported for tests.
 */
export function lchTrackGradients(l: number, c: number, h: number): { l: string; c: string; h: string } {
  const stops = (n: number, at: (t: number) => string) =>
    `linear-gradient(to right, ${Array.from({ length: n }, (_, i) => at(i / (n - 1))).join(', ')})`;
  const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
  return {
    l: stops(9, t => `oklch(${pct(t)} ${c} ${h})`),
    c: stops(9, t => `oklch(${pct(l)} ${t * LCH_MAX.c} ${h})`),
    h: stops(13, t => `oklch(${pct(l)} ${Math.max(c, 0.08)} ${t * 360})`), // floor C so the hue sweep stays visible near grey
  };
}

/** Black or white — whichever reads on `hex`. Perceptual luminance threshold. */
export function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return '#000000';
  const r = parseInt(m[1]!, 16), g = parseInt(m[2]!, 16), b = parseInt(m[3]!, 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#000000' : '#ffffff';
}

export function colorFieldHtml(id: string, value: unknown, { float = false, swatchesOnly = false, block = false, inline = false }: { float?: boolean; swatchesOnly?: boolean; block?: boolean; inline?: boolean } = {}): string {
  const rawVal = toHex(value) ?? '';
  const isTransparent = rawVal === 'transparent';
  const isHex8 = /^#[0-9a-fA-F]{8}$/.test(rawVal);
  const isHex6 = /^#[0-9a-fA-F]{6}$/.test(rawVal);
  const rgbHex = isHex8 ? rawVal.slice(0, 7) : (isHex6 ? rawVal : '#000000');
  const alphaInt = isHex8 ? parseInt(rawVal.slice(7, 9), 16) : (isTransparent ? 0 : 255);
  const alphaPct = Math.round(alphaInt / 255 * 100);
  const hexDisplay = isHex8 ? rawVal.toLowerCase() : (isHex6 ? rawVal.toLowerCase() : '');
  const previewBg = isTransparent ? '' : `style="background:${escape(safeCssColor(rawVal) || '#000000')}"`;
  const previewClass = `color-trigger-preview${isTransparent ? ' color-swatch--transparent' : ''}`;
  const eid = escape(id);
  const hexText = hexDisplay || rawVal || '#000000';
  const name = swatchName(value);

  // Swatches are NOT rendered here — they're the heaviest part (the whole
  // palette per field) and are built lazily on first popover open (see
  // buildSwatches in wireColorField). Keeps the initial grid DOM light.
  //
  // The trigger shows the swatch circle + the colour NAME (small, muted SUSE Mono) —
  // NOT the hex; the hex value lives only inside the popover picker. A CSS container
  // query on the button collapses the name away, leaving just the circle, when the
  // field is squeezed in next to other controls (see .color-trigger in components.css).
  // The name span is always present (:empty hides it) so live edits can fill/clear it
  // without a rebuild. The hex still rides in the aria-label for screen readers.
  // `block` marks a field living inside a block-editor row: positionPopover's
  // block-color-field branch spans the popover across the sidebar, and the block
  // host routes its onChange by the composite id ("blockId:idx:fieldId").
  // `inline` drops the trigger entirely and keeps the popover always-open, laid
  // out in flow (no floating/positioning) — for hosts with room to spare that
  // want the picker as a spacious inline panel, not a click-to-open popover (the
  // dashboard brand editor's Primary colour). CSS (.color-field--inline) turns
  // the popover static + horizontal; wireColorField builds its swatches up front
  // since the lazy-on-open path never fires without a trigger.
  const cls = `color-picker-field${float ? ' color-field--float' : ''}${block ? ' block-color-field' : ''}${inline ? ' color-field--inline' : ''}`;
  return `<div class="${cls}" data-color-field="${eid}">
    ${inline ? '' : `<button type="button" class="color-trigger" data-color-trigger="${eid}" aria-haspopup="true" aria-expanded="false" aria-label="Colour: ${escape(name ? name + ' ' : '')}${escape(hexText)}">
      <span class="${previewClass}" ${previewBg} aria-hidden="true"></span>
      <span class="color-trigger-name">${escape(name)}</span>
    </button>`}
    <div class="color-popover" role="group" aria-label="Colour options"${inline ? '' : ' hidden'}>
      ${swatchesOnly ? '' : `${lchSlidersHtml(eid, isHex6 || isHex8 ? rgbHex : null)}
      <input type="text" class="color-hex-input" data-color-hex="${eid}"
             value="${escape(hexDisplay || rawVal || '#000000')}" placeholder="#rrggbbaa"
             maxlength="9" spellcheck="false" autocomplete="off" aria-label="Hex colour value">
      <div class="color-alpha-row">
        <span class="color-alpha-label" aria-hidden="true">A</span>
        <input type="range" class="color-alpha-slider" data-color-alpha="${eid}"
               min="0" max="255" value="${alphaInt}" aria-label="Opacity">
        <span class="color-alpha-pct" data-alpha-pct="${eid}">${alphaPct}%</span>
      </div>
      <input type="color" class="color-popover-native" data-input-id="${eid}" value="${escape(rgbHex)}" aria-label="Pick a custom colour">`}
      <div class="color-swatches"></div>
    </div>
  </div>`;
}

/** Slider readout formatting per axis — L in %, C to 3 places, H in degrees. */
function lchValText(axis: 'l' | 'c' | 'h', v: number): string {
  return axis === 'l' ? `${Math.round(v)}%` : axis === 'c' ? v.toFixed(3) : `${Math.round(v)}°`;
}

/**
 * The OKLCH slider stack for one field, seeded from `rgbHex` (or the neutral
 * seed when the value has no colour, e.g. 'transparent'). The current OKLCH
 * state rides on data-l/c/h of the wrapper — the sliders are its projection,
 * and slider drags mutate the state directly (never a hex round-trip, which
 * would drift hue at low chroma).
 */
function lchSlidersHtml(eid: string, rgbHex: string | null): string {
  const o = (rgbHex ? hexToOklch(rgbHex) : null) ?? LCH_SEED;
  const tracks = lchTrackGradients(o.l, o.c, o.h);
  const row = (axis: 'l' | 'c' | 'h', label: string, aria: string, max: number, step: number, value: number) => `
      <div class="color-lch-row">
        <span class="color-lch-label" aria-hidden="true">${label}</span>
        <input type="range" class="color-lch-slider" data-lch-axis="${axis}"
               min="0" max="${max}" step="${step}" value="${value}"
               style="background:${tracks[axis]}" aria-label="${aria}">
        <span class="color-lch-val" data-lch-val="${axis}">${lchValText(axis, value)}</span>
      </div>`;
  return `<div class="color-lch" data-color-lch="${eid}" data-l="${o.l}" data-c="${o.c}" data-h="${o.h}">
      ${row('l', 'L', 'Lightness', LCH_MAX.l, 0.5, Math.round(o.l * 1000) / 10)}
      ${row('c', 'C', 'Chroma', LCH_MAX.c, 0.004, Math.round(o.c * 1000) / 1000)}
      ${row('h', 'H', 'Hue', LCH_MAX.h, 1, Math.round(o.h))}
    </div>`;
}

/** The palette swatch buttons for a field — built lazily on first popover open. */
function swatchButtonsHtml(id: string): string {
  const eid = escape(id);
  return SWATCHES.map(s => {
    const isTrans = s.value === 'transparent';
    const refAttr = s.ref ? ` data-swatch-ref="${escape(s.ref)}"` : '';
    const name = s.label || s.value;
    const aria = s.group && s.label ? `${s.group} · ${s.label}` : name;
    // Each swatch carries its own colour (--sw-c) + a black/white contrast colour
    // (--sw-fg) as inline custom props; the floating hover tooltip paints itself in
    // those (see showSwatchTip). Transparent has no colour of its own, so give the
    // tooltip a neutral chip. No native `title` — the graphical tip replaces it.
    // safeCssColor: this is a CSS context, so attribute-escaping alone isn't
    // enough — an unvalidated token value could smuggle extra declarations.
    const val = safeCssColor(s.value);
    const tip = isTrans ? '--sw-c:#c9ccd1;--sw-fg:#1d1d1d' : `--sw-c:${escape(val || '#c9ccd1')};--sw-fg:${contrastText(val)};background:${escape(val)}`;
    return `<button type="button"
      class="color-swatch${isTrans ? ' color-swatch--transparent' : ''}"
      data-swatch-for="${eid}" data-swatch-value="${escape(s.value)}"${refAttr}
      data-name="${escape(name)}" style="${tip}"
      aria-label="${escape(aria)}"></button>`;
  }).join('');
}

// ── Swatch name tooltip (a single shared, floating chip) ─────────────────────────
// A graphical hover label for the palette swatches: a little chip painted in the
// swatch's OWN colour with a contrasting black/white name. It lives on document.body
// as position:fixed, so the swatch grid's own scroll/overflow never clips it (a CSS
// ::after would be), pops in after a tiny delay, and is pointer-events:none — hovering
// it never steals a click, so you can slide straight onto the next swatch. One shared
// element + delegated listeners cover every field's (lazily built) swatches.
let swatchTip: HTMLElement | null = null;
let swatchTipTimer: ReturnType<typeof setTimeout> | undefined;
let swatchTipArmed = false;

function showSwatchTip(swatch: HTMLElement): void {
  const name = swatch.dataset.name;
  if (!name) return;
  if (!swatchTip) {
    swatchTip = document.createElement('div');
    swatchTip.className = 'swatch-name-tip';
    swatchTip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(swatchTip);
  }
  const tip = swatchTip;
  tip.textContent = name;
  tip.style.background = swatch.style.getPropertyValue('--sw-c').trim() || '#333';
  tip.style.color = swatch.style.getPropertyValue('--sw-fg').trim() || '#fff';
  const r = swatch.getBoundingClientRect();
  tip.style.left = `${Math.round(r.left + r.width / 2)}px`;
  tip.style.top = `${Math.round(r.top - 6)}px`;
  clearTimeout(swatchTipTimer);
  swatchTipTimer = setTimeout(() => tip.classList.add('is-shown'), 240); // the tiny delay
}

function hideSwatchTip(): void {
  clearTimeout(swatchTipTimer);
  swatchTip?.classList.remove('is-shown');
}

/** Arm the delegated swatch-tooltip listeners once (idempotent across every wireColorField). */
function armSwatchTip(): void {
  if (swatchTipArmed) return;
  swatchTipArmed = true;
  document.addEventListener('mouseover', (e) => {
    const sw = (e.target as Element | null)?.closest<HTMLElement>('.color-swatch');
    if (sw) showSwatchTip(sw);
  });
  document.addEventListener('mouseout', (e) => {
    if ((e.target as Element | null)?.closest('.color-swatch')) hideSwatchTip();
  });
  // A fixed chip doesn't follow a scrolling swatch grid — drop it rather than strand it.
  window.addEventListener('scroll', hideSwatchTip, true);
}

/**
 * The viewport origin of the box a `position:fixed` descendant of `el` is laid out
 * against. `fixed` is viewport-relative ONLY when no ancestor establishes a containing
 * block — a `transform`, the individual `translate`/`scale`/`rotate` properties,
 * `perspective`, `filter`, `backdrop-filter`, `will-change`, or `contain` on an ancestor
 * all make `fixed` resolve against THAT box's padding edge instead. Two traps bite here:
 * the sidebar carries `backdrop-filter: blur()`, and every `.input-row` keeps a computed
 * `translate: 0px` from the `card-in` enter animation's `both` fill-mode — and a non-`none`
 * `translate` establishes a containing block even at zero (a computed value other than
 * `none`, not a visible offset, is the trigger). Either way a popover portalled to `fixed`
 * lands on the controls below its trigger. Callers subtract this origin so their
 * viewport-space coords stay correct; returns {0,0} (a no-op) when nothing traps `fixed`.
 */
export function fixedContainingBlockOrigin(el: HTMLElement): { x: number; y: number } {
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const s = getComputedStyle(a);
    const backdrop = s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter');
    // container-type: size/inline-size applies layout containment — a fixed containing
    // block — but computed `contain` does NOT reflect it, so it needs its own check
    // (e.g. the record tool's `.tool-stage.has-record { container-type: inline-size }`).
    const ctype = s.getPropertyValue('container-type');
    if (s.transform !== 'none' || s.translate !== 'none' || s.scale !== 'none' || s.rotate !== 'none' ||
        s.perspective !== 'none' || s.filter !== 'none' ||
        (backdrop && backdrop !== 'none') ||
        (ctype && ctype !== 'normal') ||
        /\b(transform|perspective|filter|translate|scale|rotate)\b/.test(s.willChange) ||
        /\b(strict|content|layout|paint)\b/.test(s.contain)) {
      const r = a.getBoundingClientRect();
      // Containing block is the ancestor's padding box, not its border box.
      return { x: r.left + (parseFloat(s.borderLeftWidth) || 0), y: r.top + (parseFloat(s.borderTopWidth) || 0) };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * Wire every colour field within `scope`. Calls onChange(id, value) with the
 * canonical value string (#rrggbb, #rrggbbaa, or 'transparent'). The trigger
 * preview + sibling controls are kept in sync so the field reflects changes
 * without the host needing to re-render.
 */
export function wireColorField(scope: HTMLElement, { onChange = () => {}, onInteractStart, onInteractEnd }: WireColorFieldOpts = {}): void {
  const interact = (on: boolean) => { (on ? onInteractStart : onInteractEnd)?.(); };
  const q = <T extends Element = Element>(sel: string) => scope.querySelector<T>(sel);
  armSwatchTip();

  function updateTrigger(field: HTMLElement | null, value: string): void {
    const preview = field?.querySelector<HTMLElement>('.color-trigger-preview');
    const nameText = field?.querySelector<HTMLElement>('.color-trigger-name');
    const isTrans = value === 'transparent';
    if (preview) {
      preview.classList.toggle('color-swatch--transparent', isTrans);
      preview.style.background = isTrans ? '' : (value || '#000000');
    }
    const name = swatchName(value);
    if (nameText) nameText.textContent = name;             // :empty CSS hides it for custom colours
    const trigger = field?.querySelector('.color-trigger');
    if (trigger) trigger.setAttribute('aria-label', `Colour: ${name ? name + ' ' : ''}${value || '#000000'}`);
  }

  // ── OKLCH sliders ────────────────────────────────────────────────────────────
  // The wrapper's data-l/c/h is the single OKLCH state; sliders read AND write
  // it. Drags convert state → hex (gamut-mapped) for the output; hex/swatch/
  // native edits convert hex → state to re-seat the sliders. State only ever
  // crosses through hex in that one direction, so low-chroma hue never drifts.

  /** Repaint the three tracks + readouts from the wrapper's current state. */
  function paintLch(box: HTMLElement): void {
    const l = parseFloat(box.dataset.l!), c = parseFloat(box.dataset.c!), h = parseFloat(box.dataset.h!);
    const tracks = lchTrackGradients(l, c, h);
    for (const [axis, value] of [['l', l * 100], ['c', c], ['h', h]] as const) {
      const slider = box.querySelector<HTMLInputElement>(`[data-lch-axis="${axis}"]`);
      const val = box.querySelector<HTMLElement>(`[data-lch-val="${axis}"]`);
      if (slider) { slider.value = String(value); slider.style.background = tracks[axis]; }
      if (val) val.textContent = axis === 'l' ? `${Math.round(value)}%` : axis === 'c' ? value.toFixed(3) : `${Math.round(value)}°`;
    }
  }

  /** Re-seed the sliders from a hex chosen elsewhere (swatch / hex box / native). */
  function seedLch(field: HTMLElement, hex: string): void {
    const box = field.querySelector<HTMLElement>('.color-lch');
    if (!box) return;
    const o = hexToOklch(hex.startsWith('#') ? hex.slice(0, 7) : hex);
    if (!o) return; // 'transparent' / invalid — leave the sliders where they were
    box.dataset.l = String(o.l); box.dataset.c = String(o.c); box.dataset.h = String(o.h);
    paintLch(box);
  }

  // ── Palette swatches (lazy) ──────────────────────────────────────────────────
  // Apply a swatch's colour to the field, syncing the popover controls + trigger.
  // A swatch carrying a token `ref` emits a token value ({ ref, value }) so the
  // colour stays linked to the token; a plain swatch emits the hex string. Editing
  // the hex/native/alpha afterwards emits a plain string, de-linking from the token.
  function applySwatch(field: HTMLElement, hex: string, ref: string | null = null): void {
    const id = field.dataset.colorField;
    const native = field.querySelector<HTMLInputElement>('input.color-popover-native');
    const hexInput = field.querySelector<HTMLInputElement>('.color-hex-input');
    const alphaSlider = field.querySelector<HTMLInputElement>('.color-alpha-slider');
    const alphaPctEl = field.querySelector<HTMLElement>('.color-alpha-pct');
    if (native && hex.startsWith('#')) native.value = hex.slice(0, 7);
    if (hexInput) hexInput.value = hex;
    if (alphaSlider) alphaSlider.value = hex === 'transparent' ? '0' : '255';
    if (alphaPctEl) alphaPctEl.textContent = (hex === 'transparent' ? 0 : 100) + '%';
    seedLch(field, hex);
    updateTrigger(field, hex);
    onChange(id!, ref ? { ref, value: hex } : hex);
  }

  // Build the swatch grid the first time a field's popover opens — deferring the
  // whole palette (the heaviest part of each colour cell) until it's needed.
  function buildSwatches(field: HTMLElement): void {
    const box = field.querySelector('.color-swatches');
    if (!box || box.childElementCount) return; // already built
    box.innerHTML = swatchButtonsHtml(field.dataset.colorField!);
    box.querySelectorAll<HTMLElement>('[data-swatch-value]').forEach(btn =>
      btn.addEventListener('click', () => applySwatch(field, btn.dataset.swatchValue!, btn.dataset.swatchRef || null)));
  }

  // Inline fields have no trigger and their popover is always open, so the
  // lazy-on-open build above never fires — build their swatch grid up front.
  scope.querySelectorAll<HTMLElement>('.color-field--inline[data-color-field]').forEach(buildSwatches);

  // ── Trigger: open/close the popover ──────────────────────────────────────────
  scope.querySelectorAll<HTMLElement>('[data-color-trigger]').forEach(trigger => {
    const field = trigger.closest<HTMLElement>('[data-color-field]');
    trigger.addEventListener('click', () => {
      const popover = field?.querySelector<HTMLElement>('.color-popover');
      if (!popover) return;
      scope.querySelectorAll<HTMLElement>('.color-popover:not([hidden])').forEach(p => {
        if (p !== popover) {
          p.hidden = true; p.style.cssText = '';
          p.closest('[data-color-field]')?.querySelector('.color-trigger')?.setAttribute('aria-expanded', 'false');
        }
      });
      popover.hidden = !popover.hidden;
      trigger.setAttribute('aria-expanded', String(!popover.hidden));
      if (popover.hidden) { popover.style.cssText = ''; disarmOutside(); }
      else { buildSwatches(field!); positionPopover(field!, trigger, popover); }
    });

    // Escape closes this field's open popover and returns focus to the trigger.
    // Bound to the field (re-created on each render) — not the persistent scope —
    // so re-wiring on re-render doesn't accumulate listeners.
    field?.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const popover = field.querySelector<HTMLElement>('.color-popover:not([hidden])');
      if (!popover) return;
      popover.hidden = true; popover.style.cssText = ''; disarmOutside();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
      e.stopPropagation();
    });
  });

  function positionPopover(field: HTMLElement, trigger: HTMLElement, popover: HTMLElement): void {
    // Force-settle any in-flight entrance cascade on the field's ancestors first: while
    // `card-in` is running, the animated `translate` makes that ancestor the popover's
    // containing block — mispositioned AND clipped by the section — and the trap would
    // flip anyway (a visible jump) the moment the animation ends. Stripping .reveal-item
    // cancels the animation and snaps the item straight to its natural (settled) state.
    for (let a = field.closest<HTMLElement>('.reveal-item'); a;
         a = a.parentElement ? a.parentElement.closest<HTMLElement>('.reveal-item') : null) {
      a.classList.remove('reveal-item');
      a.style.removeProperty('--reveal-delay');
    }
    // We compute viewport-space coords below, then translate into the box `fixed`
    // is actually laid out against (the sidebar's backdrop-filter traps it — see
    // fixedContainingBlockOrigin). `cb` is {0,0} when `fixed` is truly viewport-relative.
    const cb = fixedContainingBlockOrigin(popover);
    if (field.classList.contains('block-color-field')) {
      // Block colour fields span the sidebar (escape its overflow clipping).
      const sidebar = scope.closest('.sidebar-body') || scope.closest('.sidebar');
      if (sidebar) {
        const sb = sidebar.getBoundingClientRect();
        const t = trigger.getBoundingClientRect();
        popover.style.cssText = `position:fixed;top:${t.bottom + 4 - cb.y}px;left:${sb.left + 14 - cb.x}px;width:${sb.width - 28}px;right:auto;z-index:10001;`;
      }
      // Same close-on-outside/scroll as the other fixed branches — without it the
      // popover survives a click on another block's field and strands on scroll.
      armOutside(field, popover);
    } else if (field.classList.contains('color-field--float')) {
      // Float: dock to the CELL frame's top-left (not the trigger's — the field's
      // padding would otherwise leave the popover a few px low), escaping any
      // scroll container; close on outside. Match the cell width when it's wider
      // than the minimum (the field is fluid at 100%), squaring the docked corner.
      const t = (trigger.closest('td') || trigger).getBoundingClientRect();
      const W = Math.max(224, Math.round(t.width));
      const left = Math.max(8, Math.min(t.left, window.innerWidth - W - 8));
      popover.style.cssText = `position:fixed;top:${Math.round(t.top - cb.y)}px;left:${Math.round(left - cb.x)}px;width:${W}px;right:auto;z-index:10001;border-top-left-radius:0;`;
      armOutside(field, popover);
    } else {
      // Regular sidebar field: portal to position:fixed anchored to the field (like the
      // block/float branches). An absolute popover was trapped whenever an ancestor
      // formed a stacking context — the focus-spotlight dim on non-focused
      // sections, or the section's own clip — and a later section painted over it (the
      // "picker renders below" bug). Fixed escapes every ancestor stacking context and
      // overflow clip, so it's always on top. Flip above when it would overflow the
      // sidebar's bottom; close on any outside interaction.
      const sb = scope.closest('.sidebar-body') || scope.closest('.sidebar');
      const f = field.getBoundingClientRect();
      const prev = popover.style.cssText;
      popover.style.cssText = `position:fixed;visibility:hidden;left:-9999px;top:0;width:${Math.round(f.width)}px;`;
      const ph = popover.offsetHeight;
      const bottomLimit = sb ? sb.getBoundingClientRect().bottom : window.innerHeight;
      const openUp = (bottomLimit - f.bottom) < ph + 10;
      const top = openUp ? Math.max(8, Math.round(f.top - 4 - ph)) : Math.round(f.bottom + 4);
      popover.style.cssText = prev;
      popover.style.cssText = `position:fixed;top:${top - cb.y}px;left:${Math.round(f.left) - cb.x}px;width:${Math.round(f.width)}px;right:auto;z-index:10001;`;
      armOutside(field, popover);
    }
  }

  // Outside-click / scroll close (float + regular sidebar fields, both position:fixed).
  let outside: ((e: PointerEvent) => void) | null = null;
  let onScroll: (() => void) | null = null;
  function armOutside(field: HTMLElement, popover: HTMLElement): void {
    disarmOutside();
    const close = () => { popover.hidden = true; popover.style.cssText = ''; field.querySelector('.color-trigger')?.setAttribute('aria-expanded', 'false'); disarmOutside(); };
    outside = (e) => { if (!field.contains(e.target as Node | null)) close(); };
    // A fixed popover doesn't follow the field — close it on scroll rather than leave
    // it stranded over unrelated controls (capture catches the sidebar's own scroll).
    onScroll = () => close();
    setTimeout(() => {
      document.addEventListener('pointerdown', outside!);
      window.addEventListener('scroll', onScroll!, true);
    }, 0);
  }
  function disarmOutside(): void {
    if (outside) { document.removeEventListener('pointerdown', outside); outside = null; }
    if (onScroll) { window.removeEventListener('scroll', onScroll, true); onScroll = null; }
  }

  // ── OKLCH sliders (the primary custom-colour control) ───────────────────────
  scope.querySelectorAll<HTMLElement>('.color-lch[data-color-lch]').forEach(box => {
    const id = box.dataset.colorLch!;
    const field = box.closest<HTMLElement>('[data-color-field]');
    box.querySelectorAll<HTMLInputElement>('.color-lch-slider').forEach(slider => {
      slider.addEventListener('pointerdown', () => interact(true));
      slider.addEventListener('pointerup', () => interact(false));
      slider.addEventListener('input', () => {
        const axis = slider.dataset.lchAxis as 'l' | 'c' | 'h';
        const raw = parseFloat(slider.value);
        box.dataset[axis] = String(axis === 'l' ? raw / 100 : raw);
        const state = { l: parseFloat(box.dataset.l!), c: parseFloat(box.dataset.c!), h: parseFloat(box.dataset.h!) };
        paintLch(box); // repaint the OTHER two tracks around the new position
        const rgbHex = oklchToHex(state); // gamut-mapped — always a real sRGB hex
        const alphaSlider = q<HTMLInputElement>(`[data-color-alpha="${CSS.escape(id)}"]`);
        const alphaInt = alphaSlider ? parseInt(alphaSlider.value, 10) : 255;
        const fullHex = alphaInt < 255 ? rgbHex + alphaInt.toString(16).padStart(2, '0') : rgbHex;
        const hexInput = q<HTMLInputElement>(`[data-color-hex="${CSS.escape(id)}"]`);
        if (hexInput) hexInput.value = fullHex;
        const native = q<HTMLInputElement>(`input.color-popover-native[data-input-id="${CSS.escape(id)}"]`);
        if (native) native.value = rgbHex;
        updateTrigger(field, fullHex);
        onChange(id, fullHex);
      });
    });
  });

  // ── Native colour input (RGB) ────────────────────────────────────────────────
  scope.querySelectorAll<HTMLInputElement>('input.color-popover-native[data-input-id]').forEach(native => {
    const id = native.dataset.inputId!;
    const field = native.closest<HTMLElement>('[data-color-field]');
    native.addEventListener('pointerdown', () => interact(true));
    native.addEventListener('pointerup', () => interact(false));
    native.addEventListener('input', () => {
      const alphaSlider = q<HTMLInputElement>(`[data-color-alpha="${CSS.escape(id)}"]`);
      const alphaInt = alphaSlider ? parseInt(alphaSlider.value, 10) : 255;
      const fullHex = (alphaInt < 255 ? native.value + alphaInt.toString(16).padStart(2, '0') : native.value).toLowerCase();
      const hexInput = q<HTMLInputElement>(`[data-color-hex="${CSS.escape(id)}"]`);
      if (hexInput) hexInput.value = fullHex;
      if (field) seedLch(field, native.value);
      updateTrigger(field, fullHex);
      onChange(id, fullHex);
    });
  });

  // ── Hex text entry ───────────────────────────────────────────────────────────
  scope.querySelectorAll<HTMLInputElement>('.color-hex-input[data-color-hex]').forEach(hexInput => {
    const id = hexInput.dataset.colorHex!;
    const field = hexInput.closest<HTMLElement>('[data-color-field]');
    hexInput.addEventListener('focus', () => interact(true));
    hexInput.addEventListener('blur', () => interact(false));
    hexInput.addEventListener('input', () => {
      const raw = hexInput.value.trim();
      if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(raw)) return;
      const native = q<HTMLInputElement>(`input.color-popover-native[data-input-id="${CSS.escape(id)}"]`);
      if (native) native.value = raw.slice(0, 7);
      const alphaSlider = q<HTMLInputElement>(`[data-color-alpha="${CSS.escape(id)}"]`);
      const alphaPctEl = q<HTMLElement>(`[data-alpha-pct="${CSS.escape(id)}"]`);
      const alphaInt = raw.length === 9 ? parseInt(raw.slice(7, 9), 16) : 255;
      if (alphaSlider) alphaSlider.value = String(alphaInt);
      if (alphaPctEl) alphaPctEl.textContent = Math.round(alphaInt / 255 * 100) + '%';
      const finalVal = (alphaInt < 255 ? raw.slice(0, 9) : raw.slice(0, 7)).toLowerCase();
      if (field) seedLch(field, finalVal);
      updateTrigger(field, finalVal);
      onChange(id, finalVal);
    });
  });

  // ── Alpha slider ─────────────────────────────────────────────────────────────
  scope.querySelectorAll<HTMLInputElement>('.color-alpha-slider[data-color-alpha]').forEach(alphaSlider => {
    const id = alphaSlider.dataset.colorAlpha!;
    const field = alphaSlider.closest<HTMLElement>('[data-color-field]');
    alphaSlider.addEventListener('pointerdown', () => interact(true));
    alphaSlider.addEventListener('pointerup', () => interact(false));
    alphaSlider.addEventListener('input', () => {
      const alphaInt = parseInt(alphaSlider.value, 10);
      const alphaPctEl = q<HTMLElement>(`[data-alpha-pct="${CSS.escape(id)}"]`);
      if (alphaPctEl) alphaPctEl.textContent = Math.round(alphaInt / 255 * 100) + '%';
      const native = q<HTMLInputElement>(`input.color-popover-native[data-input-id="${CSS.escape(id)}"]`);
      const rgbHex = native?.value || '#000000';
      const fullHex = (alphaInt < 255 ? rgbHex + alphaInt.toString(16).padStart(2, '0') : rgbHex).toLowerCase();
      const hexInput = q<HTMLInputElement>(`[data-color-hex="${CSS.escape(id)}"]`);
      if (hexInput) hexInput.value = fullHex;
      updateTrigger(field, fullHex);
      onChange(id, fullHex);
    });
  });
}
