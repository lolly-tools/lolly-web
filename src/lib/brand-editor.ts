// SPDX-License-Identifier: MPL-2.0
/**
 * Brand studio — the ONE place brand primitives are created, edited, saved,
 * imported and exported. Mounted exclusively by #/start (the Dashboard's
 * Design-system tab is a read-only rendering of the result; user preferences
 * like the app theme live on #/profile — that separation is the whole point).
 *
 * The studio renders five tab panels, each wrapped in `[data-be-tab-panel]`;
 * the host view (start.ts) drives visibility by setting `data-active-tab` on
 * the editor root — every panel stays mounted (and wired) whichever tab shows:
 *
 *  1. logos     — the mark manager (brand-logos.ts): the canonical orientation
 *                 × treatment matrix, user-named custom marks ("icon", "crest"),
 *                 and additional logo identities. An SVG upload feeds the Colour
 *                 tab's "found in your logo" primary suggestion.
 *  2. color     — the derive controls (primary + scheme / surface / contrast)
 *                 with live preview (DRAFT-until-saved: only "Save colour"
 *                 persists), the harmony generator, the palette (every swatch an
 *                 editable tile + the OKLCH wheel) and optional gradient tokens.
 *  3. type      — the Google-Fonts manager (user-fonts.ts) plus the two type
 *                 roles the chrome reads (font.brand / font.mono) and a live
 *                 specimen, so type is chosen without colour noise.
 *  4. tokens    — the corner radius plus every other non-colour primitive
 *                 (spacing, sizing, stroke, opacity, rotation, numbers, shadows
 *                 — lib/token-studio.ts).
 *  5. catalogue — brand asset uploads, sorted the same way the Catalogue view
 *                 sorts them (vector / image / audio / motion).
 *
 * Everything persists to the one `user/tokens/brand` install via the bridge's
 * single write chokepoint (installUserTokens → bust → the next get()/colors()/
 * resolve() re-reads) — except the Colour panel's derive, which is draft-until-
 * saved. Palette/font/logo/token edits persist immediately, same as ever.
 * Import/export of the whole brand pack is exposed on the handle
 * (exportPack/importPack) so the host view owns those buttons' placement.
 *
 * A LOCKED build (host.tokens.isLocked()) exposes none of this — the caller
 * renders a read-only note instead. Everything is best-effort and DOM-guarded:
 * a detached editor (route changed mid-op) never writes to a dead node.
 */

import '../styles/parts/brand-studio.css'; // every .be-* rule — rides this module's lazy chunk
import { deriveBrandTokens, createTokenSet, colorToHex, contrastRatio, extractSvgColors, RAMP_STEPS_MIN, RAMP_STEPS_MAX, SCHEME_KINDS, generateSchemeAccents } from '@lolly/engine';
import type { BrandDeriveOptions, SchemeKind } from '@lolly/engine';
import { nameColor } from './color-namer.ts';
import { palettePreviewSvgs } from './palette-preview.ts';
import type { HostV1, TokenSet } from '../../../../engine/src/bridge/host-v1.ts';
import type { WebTokensAPI } from '../bridge/tokens.ts';
import { installUserTokens, USER_TOKENS_ID } from '../bridge/tokens.ts';
import {
  isRec, prettify, walkSwatches, setSwatchValue, setSwatchName, deleteSwatch, addSwatch, setSemanticRampAlias,
  setSwatchCmykLock, setSwatchSpotLock, getSwatchPrintOverride, primaryAnchorPath,
} from './brand-doc.ts';
import type { BrandSwatch, PrintLock } from './brand-doc.ts';
import { exportSwatches, type SwatchExportFormat } from './swatch-export.ts';
import type { SpotColor } from '../../../../engine/src/bridge/host-v1.ts';
import { applyChromeBrandVars, applyChromeAccent, tokenValueToHex, brandRadiusValue } from '../brand-vars.ts';
import { colorFieldHtml, wireColorField, setSwatches, refreshSwatches } from '../components/color-field.ts';
import { COLOR_FORMATS, STORAGE_FORMATS, formatColor, parseColor, serializeColor, storageFormatOf } from './color-formats.ts';
import type { ColorFormat, StorageFormat } from './color-formats.ts';
import {
  renderBrandWheel, wireBrandWheel, updateWheelDot, oklchToStored, oklchHex,
} from './palette-wheel.ts';
import type { WheelDot } from './palette-wheel.ts';
import type { PaletteEntry } from '../palette.ts';
import {
  listUserFonts, installGoogleFont, setPrimaryFont, setMonoFont, removeUserFont,
  primaryFontFamily, monoFontFamily, setBrandRadius,
} from '../user-fonts.ts';
import type { UserFontsHost, UserFontFamily } from '../user-fonts.ts';
import {
  LOGO_ORIENTATIONS, LOGO_TREATMENTS, ORIENTATION_META, TREATMENT_META, LOGO_SLUG_RE,
  splitVariant, variantLabel, listLogos, installLogo, removeLogo,
} from './brand-logos.ts';
import type { LogoVariant, LogoSlot } from './brand-logos.ts';
import { mountTokensPanel, mountGradientsPanel, mountCataloguePanel } from './brand-studio-tabs.ts';
import { STUDIO_GROUPS } from './token-studio.ts';
import { POPULAR_FAMILIES } from './google-fonts.ts';
import { exportBrandPack, importBrandPack } from '../brand-transfer.ts';
import type { BrandTransferHost } from '../brand-transfer.ts';
import { saveBlob } from '../pro/zip.ts';
import { confirmDialog } from '../components/confirm-dialog.ts';
import { fmtBytes } from './device-info.ts';
import { escape } from '../utils.ts';
import { announce } from '../a11y.ts';
import { playSfx } from './sfx.ts';

/**
 * Fired on `document` whenever the Colour panel's live draft changes (primary
 * drag, a neutral/secondary ramp pick, or "Use this colour") — `detail.palette`
 * is the draft's ramp + spectrum swatches (see draftPalette). Best-effort
 * listeners (the Dashboard's "Colour palette" ink bar) should treat this as
 * optional decoration, never a dependency.
 */
export const BRAND_DRAFT_EVENT = 'lolly:brand-draft';
export interface BrandDraftEventDetail { palette: PaletteEntry[]; }

// ── Host shape ──────────────────────────────────────────────────────────────
// The editor reads/writes tokens, fonts and brand packs. Every real web host
// (createBridge) satisfies all three; the caller passes its HostV1 and the
// sub-APIs are reached through the same narrow casts the wizard/profile use.
type EditorHost = HostV1;
type Scheme = NonNullable<BrandDeriveOptions['scheme']>;
type Surface = NonNullable<BrandDeriveOptions['surface']>;
type Contrast = NonNullable<BrandDeriveOptions['contrast']>;
type Fg = NonNullable<BrandDeriveOptions['foreground']>;

const SCHEMES: ReadonlyArray<{ id: Scheme; label: string }> = [
  { id: 'mono', label: 'Mono' }, { id: 'complement', label: 'Complement' },
  { id: 'analogous', label: 'Analogous' }, { id: 'triad', label: 'Triad' },
];
// UI intensity — the surface look baked into the brand, collapsed from the old
// Light / Dark / Deep-primary trio to a single Muted ↔ Deep toggle. Light vs dark
// is the app THEME's job (the Theme picker), so this axis only carries how RICH the
// surface reads: `muted` = a neutral surface (light default); `deep` = the
// chroma-rich primary surface. The ids stay the engine's `surface` values so
// deriveBrandTokens is unchanged (see engine/src/brand-derive.ts).
const INTENSITIES: ReadonlyArray<{ id: Surface; label: string }> = [
  { id: 'light', label: 'Muted' }, { id: 'primary', label: 'Deep' },
];
const CONTRASTS: ReadonlyArray<{ id: Contrast; label: string }> = [
  { id: 'comfort', label: 'Comfort' }, { id: 'high', label: 'High' },
];
// What sits on top of the brand primary. Auto picks white/black by contrast;
// Light/Dark force it — the fix for a mid-tone brand colour that "should" wear
// white text but auto-flips to black for the higher ratio (see deriveBrandTokens).
const FOREGROUNDS: ReadonlyArray<{ id: Fg; label: string }> = [
  { id: 'auto', label: 'Auto' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' },
];
const DEFAULT_PRIMARY = '#4f83cc';
// The engine's own default for `secondary` (deriveBrandTokens hardcodes ramp
// step 5); `neutral` has no engine default to match since it's not a slot the
// engine emits at all — step 5 (the ramp's contrast-anchor step) is this
// editor's own sensible starting point for it.
const DEFAULT_RAMP_STEP = 5;

// ── Live derive preview (ramps + specimen), same recipe as the wizard ─────────

const slot = (set: TokenSet, name: string): string => {
  const v = set.resolve(`color.semantic.${name}`); return typeof v === 'string' ? v : '';
};
const ratioOf = (fg: string, bg: string): string => {
  try { const f = colorToHex(fg), b = colorToHex(bg); return f && b ? contrastRatio(f, b).toFixed(1) : ''; }
  catch { return ''; }
};
/**
 * One ramp's 9 steps. When `selected` is given the cells become buttons the
 * user can pick a step from (data-be-ramp/data-be-step carry which); the
 * chosen one gets `.is-selected` — the same ring treatment `.be-swatch` uses
 * in the Palette panel below. Omitted (the Primary ramp — it's already driven
 * by the colour field above) they stay plain, non-interactive swatches.
 */
function rampRow(set: TokenSet, ramp: string, label: string, steps: number, selected?: number): string {
  let cells = '';
  for (let i = 1; i <= steps; i++) {
    const v = set.resolve(`color.ramp.${ramp}.${i}`);
    const css = typeof v === 'string' ? v : 'transparent';
    const title = `${label} ${i} · ${css}`;
    cells += selected === undefined
      ? `<span class="be-ramp-cell" style="background:${escape(css)}" title="${escape(title)}"></span>`
      : `<button type="button" class="be-ramp-cell${i === selected ? ' is-selected' : ''}" style="background:${escape(css)}"
           title="${escape(title)}" data-be-ramp="${escape(ramp)}" data-be-step="${i}"
           aria-pressed="${i === selected}" aria-label="${escape(title)}"></button>`;
  }
  return `<div class="be-ramp-row"><span class="be-ramp-label">${escape(label)}</span><div class="be-ramp" role="${selected === undefined ? 'img' : 'group'}" aria-label="${escape(label)} ramp">${cells}</div></div>`;
}
function specCard(name: 'Light' | 'Dark', set: TokenSet): string {
  const s = slot(set, 'surface'), text = slot(set, 'text'), muted = slot(set, 'muted');
  const edge = slot(set, 'edge'), prim = slot(set, 'primary'), on = slot(set, 'on-primary');
  const ratio = ratioOf(text, s);
  return `
    <article class="be-spec" style="background:${escape(s)};border-color:${escape(edge)}">
      <span class="be-spec-name" style="color:${escape(muted)}">${name}</span>
      <h4 class="be-spec-h" style="color:${escape(text)}">The quick brown fox</h4>
      <p class="be-spec-b" style="color:${escape(muted)}">Body copy sits one step back — calm and unmistakably yours.</p>
      <div class="be-spec-row">
        <span class="be-spec-btn" style="background:${escape(prim)};color:${escape(on)}">Primary</span>
        ${ratio ? `<span class="be-spec-ratio" style="color:${escape(muted)}">${escape(ratio)}:1</span>` : ''}
      </div>
    </article>`;
}
/** `deriveBrandTokens`, swallowing an unparseable primary (mid-edit hex). */
function deriveSafe(opts: BrandDeriveOptions): Record<string, unknown> | null {
  try { return deriveBrandTokens(opts) as Record<string, unknown>; } catch { return null; }
}
function previewHtml(doc: Record<string, unknown>, sel: { neutral: number; secondary: number; steps: number }): string {
  const light = createTokenSet(doc, { theme: 'light' });
  const dark = createTokenSet(doc, { theme: 'dark' });
  return `
    <div class="be-ramps">${rampRow(light, 'primary', 'Primary', sel.steps)}${rampRow(light, 'neutral', 'Neutral', sel.steps, sel.neutral)}${rampRow(light, 'secondary', 'Secondary', sel.steps, sel.secondary)}</div>
    <div class="be-specs">${specCard('Light', light)}${specCard('Dark', dark)}</div>`;
}

/**
 * The derived doc's ramp + spectrum swatches as PaletteEntry[] — the shape the
 * Dashboard's "Colour palette" ink-bar section (views/dashboard.ts) renders.
 * Semantic roles are left out (that section never shows them); cmyk is always
 * null (a draft has no measured ink). Broadcast on every draft change so that
 * section can track the picker live — see mount()'s draft-changed dispatch.
 */
function draftPalette(doc: Record<string, unknown>): PaletteEntry[] {
  return walkSwatches(doc, 'light')
    .filter(s => s.kind === 'ramp' || s.kind === 'spectrum')
    .map(s => ({
      hex: s.hex,
      label: s.kind === 'ramp' ? `${s.group} ${s.name}` : s.name,
      cmyk: null,
      group: s.kind === 'spectrum' ? 'spectrum' : s.group,
    }));
}

/**
 * Live-apply a derived (not necessarily installed) doc's chrome accent —
 * resolved locally via createTokenSet, never through host.tokens, so this
 * works from an in-memory draft the same way applyChromeBrandVars works from
 * the real install. Generalises brand-vars.ts's CSS-generation (applyChromeAccent)
 * rather than duplicating it.
 */
function applyDraftChrome(doc: Record<string, unknown>): void {
  const hex = (theme: 'light' | 'dark', role: string): string | null => {
    try { return tokenValueToHex(createTokenSet(doc, { theme }).resolve(`color.semantic.${role}`)); }
    catch { return null; }
  };
  applyChromeAccent(
    { primary: hex('light', 'primary'), onPrimary: hex('light', 'on-primary') },
    { primary: hex('dark', 'primary'), onPrimary: hex('dark', 'on-primary') },
  );
}

/** Tell any listener (the Dashboard's ink-bar section) the draft just changed. */
function broadcastDraft(doc: Record<string, unknown>): void {
  document.dispatchEvent(new CustomEvent<BrandDraftEventDetail>(BRAND_DRAFT_EVENT, { detail: { palette: draftPalette(doc) } }));
}

const segHtml = (name: string, opts: ReadonlyArray<{ id: string; label: string }>, active: string, label: string): string => `
  <div class="view-seg be-seg" role="group" aria-label="${escape(label)}" data-be-seg="${escape(name)}">
    ${opts.map(o => `<button type="button" class="view-seg-btn" data-val="${escape(o.id)}" aria-pressed="${o.id === active}">${escape(o.label)}</button>`).join('')}
  </div>`;

// ── Shared print-lock control (independent CMYK lock + Spot-colour lock) ─────
// One control, two mounts: the Colour panel's primary field and the Palette
// panel's swatch popover (see mountPrintLock's two call sites below). CMYK and
// spot are independent (see brand-doc.ts's PrintLock doc comment) — a swatch
// may carry either, both, or neither: CMYK is the process-colour fallback used
// for preview / non-PDF export / the PDF Separation tint-transform's alternate
// space whether or not a spot is also set, so locking a named ink never
// discards a separately-tuned CMYK build.

/** The auto sRGB→CMYK conversion of a hex (C,M,Y,K 0–100) — the value the CMYK
 *  block seeds from when first locked, and what it shows while auto. */
const autoCmykOf = (hex: string): [number, number, number, number] => {
  const p = formatColor('cmyk', hex).split(',').map(n => Math.round(parseFloat(n)) || 0);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0];
};

/** Same JSON key path — used to tell whether the Palette panel's currently-edited
 *  swatch IS the primary ramp's anchor step, so the two print-lock controls that
 *  can both touch it stay reconciled (see primaryPrintLock's doc comment). */
const samePath = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((seg, i) => seg === b[i]);

function printLockHtml(): string {
  return `
    <div class="be-lock" data-be-lock>
      <div class="be-lock-block" data-be-lock-block="cmyk">
        <div class="be-subst-line">
          <span class="be-subst-key">CMYK</span>
          <code class="be-subst-val" data-be-lock-readout="cmyk"></code>
        </div>
        ${segHtml('lock-cmyk', [{ id: 'auto', label: 'Auto' }, { id: 'locked', label: 'Locked' }], 'auto', 'CMYK print colour')}
        <div class="be-lock-body" data-be-lock-cmyk-body hidden>
          <div class="be-cmyk-inputs">
            ${['C', 'M', 'Y', 'K'].map((l, i) => `<label class="be-cmyk-in"><span>${l}</span><input type="number" min="0" max="100" step="1" inputmode="numeric" data-be-lock-c="${i}" aria-label="${l === 'K' ? 'Black' : l === 'C' ? 'Cyan' : l === 'M' ? 'Magenta' : 'Yellow'} %"></label>`).join('')}
          </div>
        </div>
      </div>
      <div class="be-lock-block" data-be-lock-block="spot">
        <div class="be-subst-line">
          <span class="be-subst-key">Spot colour</span>
          <code class="be-subst-val" data-be-lock-readout="spot"></code>
        </div>
        ${segHtml('lock-spot', [{ id: 'none', label: 'None' }, { id: 'set', label: 'Set' }], 'none', 'Spot colour lock')}
        <div class="be-lock-spot" data-be-lock-spot-body hidden>
          <label class="be-lock-field"><span>Name</span><input type="text" data-be-lock-name placeholder="PANTONE 186 C" autocomplete="off" spellcheck="false"></label>
          <label class="be-lock-field"><span>Book <em>(optional)</em></span><input type="text" data-be-lock-book placeholder="PANTONE+ Solid Coated" autocomplete="off" spellcheck="false"></label>
        </div>
      </div>
    </div>`;
}

interface PrintLockCtx {
  /** The subject's current screen colour — feeds the Auto CMYK conversion. */
  hex: () => string;
  getCmyk: () => [number, number, number, number] | null;
  setCmyk: (cmyk: [number, number, number, number] | null) => void;
  getSpot: () => SpotColor | null;
  setSpot: (spot: SpotColor | null) => void;
}

/**
 * Render the print-lock markup into `mount` and wire it against `ctx`. Returns
 * a handle whose `render()` the caller calls whenever the subject changes
 * underneath it (a newly selected swatch, an edited primary hex) so the
 * readouts/fields resync without re-mounting the control.
 *
 * Call this AFTER any generic `[data-be-seg]` delegate (see the Scheme/Surface/
 * Contrast wiring below) has already run its one-time `querySelectorAll` — the
 * control's own Auto/Locked and None/Set toggles are built on that same
 * `segHtml` markup, so mounting later keeps them out of that older NodeList.
 */
function mountPrintLock(mount: HTMLElement, ctx: PrintLockCtx): { render: () => void } {
  mount.innerHTML = printLockHtml();
  const cmykReadout = mount.querySelector<HTMLElement>('[data-be-lock-readout="cmyk"]');
  const cmykSeg = mount.querySelector<HTMLElement>('[data-be-seg="lock-cmyk"]');
  const cmykBlock = mount.querySelector<HTMLElement>('[data-be-lock-block="cmyk"]');
  const cmykBody = mount.querySelector<HTMLElement>('[data-be-lock-cmyk-body]');
  const cInputs = Array.from(mount.querySelectorAll<HTMLInputElement>('[data-be-lock-c]'));

  const spotReadout = mount.querySelector<HTMLElement>('[data-be-lock-readout="spot"]');
  const spotSeg = mount.querySelector<HTMLElement>('[data-be-seg="lock-spot"]');
  const spotBlock = mount.querySelector<HTMLElement>('[data-be-lock-block="spot"]');
  const spotBody = mount.querySelector<HTMLElement>('[data-be-lock-spot-body]');
  const nameInput = mount.querySelector<HTMLInputElement>('[data-be-lock-name]');
  const bookInput = mount.querySelector<HTMLInputElement>('[data-be-lock-book]');

  const setPressed = (seg: HTMLElement | null, val: string): void =>
    seg?.querySelectorAll<HTMLElement>('[data-val]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.val === val)));
  const cmykFromInputs = (): [number, number, number, number] =>
    cInputs.map(i => Math.min(100, Math.max(0, Math.round(parseFloat(i.value) || 0)))) as [number, number, number, number];

  const commitCmyk = (): void => { ctx.setCmyk(cmykFromInputs()); renderCmyk(); };
  const commitSpot = (): void => {
    const name = nameInput?.value.trim();
    if (!name) return; // a spot lock needs a name — nothing to commit yet
    const book = bookInput?.value.trim();
    ctx.setSpot({ name, ...(book ? { book } : {}) });
    renderSpot();
  };

  cmykSeg?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-val]'); if (!btn) return;
    if (btn.dataset.val === 'auto') { ctx.setCmyk(null); renderCmyk(); return; }
    // Locking always leaves something pinned, never a limbo state — seed from
    // the auto conversion.
    ctx.setCmyk(autoCmykOf(ctx.hex()));
    renderCmyk();
  });
  cInputs.forEach(inp => inp.addEventListener('input', commitCmyk));

  spotSeg?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-val]'); if (!btn) return;
    if (btn.dataset.val === 'none') { ctx.setSpot(null); renderSpot(); return; }
    // "Set" opens the name field but doesn't commit anything yet — a spot lock
    // needs a name (commitSpot no-ops until one's typed).
    setPressed(spotSeg, 'set');
    if (spotBody) spotBody.hidden = false;
    nameInput?.focus();
  });
  nameInput?.addEventListener('input', commitSpot);
  bookInput?.addEventListener('input', () => { if (nameInput?.value.trim()) commitSpot(); });

  function renderCmyk(): void {
    const cmyk = ctx.getCmyk();
    const eff = cmyk ?? autoCmykOf(ctx.hex());
    if (cmykReadout) cmykReadout.textContent = `C${eff[0]} M${eff[1]} Y${eff[2]} K${eff[3]}`;
    cmykBlock?.classList.toggle('is-pinned', !!cmyk);
    setPressed(cmykSeg, cmyk ? 'locked' : 'auto');
    if (cmykBody) cmykBody.hidden = !cmyk;
    cInputs.forEach((inp, i) => { if (document.activeElement !== inp) inp.value = String(eff[i]); });
  }
  function renderSpot(): void {
    const spot = ctx.getSpot();
    if (spotReadout) spotReadout.textContent = spot ? spot.name : 'Not set';
    spotBlock?.classList.toggle('is-pinned', !!spot);
    setPressed(spotSeg, spot ? 'set' : 'none');
    if (spotBody) spotBody.hidden = !spot;
    if (nameInput && document.activeElement !== nameInput) nameInput.value = spot?.name ?? '';
    if (bookInput && document.activeElement !== bookInput) bookInput.value = spot?.book ?? '';
  }
  function render(): void { renderCmyk(); renderSpot(); }
  render();
  return { render };
}

// ── Print substitutes, compact (the swatch popover's folded variant) ──────────
// Same PrintLockCtx contract as mountPrintLock, different clothes: two checkbox
// rows ("check on" a CMYK build / a named spot ink) sized for the popover, where
// the primary panel's fuller segmented control would crowd the card. Checking
// CMYK seeds from the auto conversion so a lock never sits in a limbo state;
// checking Spot opens the name field and commits once a name is typed.

function printSubstHtml(): string {
  return `
    <div class="be-ps" data-be-ps>
      <label class="be-ps-row">
        <input type="checkbox" data-be-ps-on="cmyk">
        <span class="be-ps-key">CMYK</span>
        <code class="be-ps-val" data-be-ps-val="cmyk"></code>
      </label>
      <div class="be-ps-body be-cmyk-inputs" data-be-ps-body="cmyk" hidden>
        ${['C', 'M', 'Y', 'K'].map((l, i) => `<label class="be-cmyk-in"><span>${l}</span><input type="number" min="0" max="100" step="1" inputmode="numeric" data-be-ps-c="${i}" aria-label="${l === 'K' ? 'Black' : l === 'C' ? 'Cyan' : l === 'M' ? 'Magenta' : 'Yellow'} %"></label>`).join('')}
      </div>
      <label class="be-ps-row">
        <input type="checkbox" data-be-ps-on="spot">
        <span class="be-ps-key">Spot</span>
        <code class="be-ps-val" data-be-ps-val="spot"></code>
      </label>
      <div class="be-ps-body be-ps-spot" data-be-ps-body="spot" hidden>
        <label class="be-lock-field"><span>Name</span><input type="text" data-be-ps-name placeholder="PANTONE 186 C" autocomplete="off" spellcheck="false"></label>
        <label class="be-lock-field"><span>Book <em>(optional)</em></span><input type="text" data-be-ps-book placeholder="PANTONE+ Solid Coated" autocomplete="off" spellcheck="false"></label>
      </div>
    </div>`;
}

function mountPrintSubst(mount: HTMLElement, ctx: PrintLockCtx): { render: () => void } {
  mount.innerHTML = printSubstHtml();
  const on = (k: string): HTMLInputElement | null => mount.querySelector<HTMLInputElement>(`[data-be-ps-on="${k}"]`);
  const val = (k: string): HTMLElement | null => mount.querySelector<HTMLElement>(`[data-be-ps-val="${k}"]`);
  const body = (k: string): HTMLElement | null => mount.querySelector<HTMLElement>(`[data-be-ps-body="${k}"]`);
  const cInputs = Array.from(mount.querySelectorAll<HTMLInputElement>('[data-be-ps-c]'));
  const nameInput = mount.querySelector<HTMLInputElement>('[data-be-ps-name]');
  const bookInput = mount.querySelector<HTMLInputElement>('[data-be-ps-book]');

  const cmykFromInputs = (): [number, number, number, number] =>
    cInputs.map(i => Math.min(100, Math.max(0, Math.round(parseFloat(i.value) || 0)))) as [number, number, number, number];

  on('cmyk')?.addEventListener('change', () => {
    ctx.setCmyk(on('cmyk')!.checked ? autoCmykOf(ctx.hex()) : null);
    render();
  });
  cInputs.forEach(inp => inp.addEventListener('input', () => { ctx.setCmyk(cmykFromInputs()); renderCmyk(); }));

  on('spot')?.addEventListener('change', () => {
    if (!on('spot')!.checked) { ctx.setSpot(null); render(); return; }
    // Opening only — a spot lock needs a name before anything commits.
    if (body('spot')) body('spot')!.hidden = false;
    nameInput?.focus();
  });
  const commitSpot = (): void => {
    const name = nameInput?.value.trim();
    if (!name) return;
    const book = bookInput?.value.trim();
    ctx.setSpot({ name, ...(book ? { book } : {}) });
    renderSpot();
  };
  nameInput?.addEventListener('input', commitSpot);
  bookInput?.addEventListener('input', () => { if (nameInput?.value.trim()) commitSpot(); });

  function renderCmyk(): void {
    const cmyk = ctx.getCmyk();
    const eff = cmyk ?? autoCmykOf(ctx.hex());
    if (val('cmyk')) val('cmyk')!.textContent = cmyk ? `C${eff[0]} M${eff[1]} Y${eff[2]} K${eff[3]}` : 'auto';
    if (on('cmyk')) on('cmyk')!.checked = !!cmyk;
    if (body('cmyk')) body('cmyk')!.hidden = !cmyk;
    cInputs.forEach((inp, i) => { if (document.activeElement !== inp) inp.value = String(eff[i]); });
  }
  function renderSpot(): void {
    const spot = ctx.getSpot();
    if (val('spot')) val('spot')!.textContent = spot ? spot.name : 'none';
    if (on('spot')) on('spot')!.checked = !!spot;
    if (body('spot')) body('spot')!.hidden = !spot && document.activeElement !== nameInput && document.activeElement !== bookInput;
    if (nameInput && document.activeElement !== nameInput) nameInput.value = spot?.name ?? '';
    if (bookInput && document.activeElement !== bookInput) bookInput.value = spot?.book ?? '';
  }
  function render(): void { renderCmyk(); renderSpot(); }
  render();
  return { render };
}

// ── Swatch tile + palette grid ────────────────────────────────────────────────

function tileHtml(s: BrandSwatch, idx: number): string {
  const trans = !s.hex;
  const lockTitle = s.lock?.spot
    ? `Print colour locked to ${s.lock.spot.name}${s.lock.cmyk ? ' (with a CMYK fallback)' : ''}`
    : s.lock?.cmyk ? 'Print colour locked (CMYK)' : '';
  return `
    <button type="button" class="be-swatch${trans ? ' is-empty' : ''}${s.lock ? ' is-pinned' : ''}" data-be-tile="${idx}"
      style="--sw:${escape(s.hex || 'transparent')}"
      aria-label="${escape(`${s.name} — ${s.hex || 'unset'}${s.lock ? ' (print colour locked)' : ''}`)}">
      <span class="be-swatch-chip" aria-hidden="true"></span>
      <span class="be-swatch-meta">
        <span class="be-swatch-name">${escape(s.name)}${s.lock ? `<span class="be-swatch-lock" title="${escape(lockTitle)}">LOCK</span>` : ''}</span>
        <code class="be-swatch-hex">${escape(s.hex || '—')}</code>
      </span>
    </button>`;
}

function paletteHtml(swatches: BrandSwatch[]): string {
  // Group in a stable, meaningful order: ramps first (Primary, Neutral, then the
  // rest alphabetically), Spectrum, Custom, then the theme roles.
  const groups = new Map<string, BrandSwatch[]>();
  swatches.forEach(s => { (groups.get(s.group) ?? groups.set(s.group, []).get(s.group)!).push(s); });
  const rank = (g: string): number =>
    /^primary$/i.test(g) ? 0 : /^neutral$/i.test(g) ? 1 : /^secondary$/i.test(g) ? 2 :
    /spectrum/i.test(g) ? 6 : /custom/i.test(g) ? 7 : /roles/i.test(g) ? 9 : 4;
  const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const idxOf = new Map(swatches.map((s, i) => [s, i]));
  // A palette-level Add always shows — a brand with no `custom` group yet has no
  // Custom section to hang a per-group Add off, so the first swatch needs this.
  const top = `
    <div class="be-pal-top">
      <span class="be-pal-count">${swatches.length} colour${swatches.length === 1 ? '' : 's'}</span>
      <button type="button" class="be-add" data-be-add="custom">+ Add swatch</button>
    </div>`;
  const body = order.map(g => {
    const items = groups.get(g)!;
    // Spectrum is an open-ended set of illustration hues, so it grows in place.
    const addable = /spectrum/i.test(g);
    return `
      <div class="be-pal-group">
        <div class="be-pal-group-head">
          <span class="be-pal-group-label">${escape(g)}<span class="be-pal-group-n">${items.length}</span></span>
          ${addable ? '<button type="button" class="be-add be-add--sm" data-be-add="spectrum">+ Add</button>' : ''}
        </div>
        <div class="be-pal-grid">${items.map(s => tileHtml(s, idxOf.get(s)!)).join('')}</div>
      </div>`;
  }).join('');
  return top + body;
}

// ── Mount ─────────────────────────────────────────────────────────────────────

/**
 * Render the brand studio into `root` and wire it. Returns a teardown that stops
 * the (font/preview) listeners. Locked builds render a read-only note and no-op.
 */
/** The five step tabs the studio renders — the host view's tab bar drives which
 *  one shows by setting `data-active-tab` on the editor root. */
export type BrandTabKey = 'logos' | 'color' | 'type' | 'tokens' | 'catalogue';
export const BRAND_TABS: ReadonlyArray<{ id: BrandTabKey; label: string }> = [
  { id: 'logos', label: 'Logos' },
  { id: 'color', label: 'Colours' },
  { id: 'type', label: 'Type' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'catalogue', label: 'Catalogue' },
];

export interface BrandEditorOptions {
  /** Fired after any brand edit lands (persisted or drafted), with the tab it
   *  came from — the host's "Save & continue" appearance + next-tab nudge. */
  onChange?: (tab: BrandTabKey) => void;
}

/** teardown: unmount. saveDraft: commit the Colour panel's pending, unsaved
 *  derive (a no-op when there's nothing dirty). isDirty: whether such a draft
 *  is pending. exportPack/importPack: the brand-file share pair, exposed here
 *  so the host view owns the buttons' placement (errors propagate — the caller
 *  shows them). */
export interface BrandEditorHandle {
  teardown: () => void;
  saveDraft: () => void;
  isDirty: () => boolean;
  exportPack: () => Promise<{ filename: string }>;
  importPack: (file: File) => Promise<void>;
  /** Re-read the installed doc and repaint every panel — for a host that
   *  installed tokens through its own path (JSON/SVG import) underneath us. */
  reload: () => Promise<void>;
  /** Close any floating editor UI (the swatch popover) — the host calls this
   *  on tab switches, where an open popover would otherwise outlive the tile
   *  it was anchored to (the popover sits outside the tab panels). */
  closeOverlays: () => void;
}

export async function mountBrandEditor(root: HTMLElement, host: EditorHost, opts: BrandEditorOptions = {}): Promise<BrandEditorHandle> {
  const tokens = host.tokens as unknown as WebTokensAPI | undefined;
  const fontsHost = host as unknown as UserFontsHost;
  const transferHost = { host: host as unknown as BrandTransferHost, storage: localStorage };

  let locked = false;
  try { locked = !!(await tokens?.isLocked?.()); } catch { /* treat as unlocked */ }
  if (locked) {
    root.innerHTML = `<p class="be-locked">This build ships with a fixed brand — its colours, fonts and tokens are what the whole app, your tools and every export wear. Brand editing is turned off here.</p>`;
    return {
      teardown: () => {}, saveDraft: () => {}, isDirty: () => false,
      exportPack: () => Promise.reject(new Error('This brand is fixed — there is nothing of yours to export.')),
      importPack: () => Promise.reject(new Error('This brand is fixed — imports are turned off.')),
      reload: () => Promise.resolve(),
      closeOverlays: () => {},
    };
  }

  // The document we edit: the installed brand if any, else a fresh derive from
  // the default primary so the palette is never empty on an unbranded install.
  let doc = (await tokens?.raw().catch(() => null)) as Record<string, unknown> | null;
  const installedDoc = isRec(doc) ? doc : null; // stable snapshot for seeding, below — never reassigned
  if (!isRec(doc)) doc = deriveBrandTokens({ primary: DEFAULT_PRIMARY, name: 'My brand' }) as Record<string, unknown>;

  // Whether installedDoc is something the USER actually saved here, vs just the
  // catalog's own shipped/placeholder brand — distinct from "is there any doc at
  // all", since a fresh install still resolves ITS tokens as installedDoc. Only a
  // real user save should seed a control (like Shades below) away from its
  // considered default; the catalog's incidental step count isn't a user choice.
  let isUserBrand = false;
  try {
    isUserBrand = (await (host.assets as unknown as {
      _findMetaByType?(t: string): Promise<{ id: string } | null>;
    })._findMetaByType?.('tokens'))?.id === USER_TOKENS_ID;
  } catch { /* discovery unavailable — treat as not user-owned */ }

  // Derive-control state (separate from the edited doc — it RE-SEEDS on install).
  // Primary is seeded from the REAL installed brand's current colour, so the
  // picker opens on what's actually running, not a hardcoded default — only a
  // genuinely unbranded install (no real doc yet) falls back to DEFAULT_PRIMARY.
  // Scheme/surface/contrast aren't recoverable (deriveBrandTokens doesn't persist
  // its own input options into the doc), so those stay at their usual defaults.
  let primary = DEFAULT_PRIMARY;
  if (installedDoc) {
    try {
      primary = tokenValueToHex(createTokenSet(installedDoc, { theme: 'light' }).resolve('color.semantic.primary')) ?? DEFAULT_PRIMARY;
    } catch { /* malformed/tokenless doc — keep the default seed */ }
  }
  let scheme: Scheme = 'mono', surface: Surface = 'light', contrast: Contrast = 'comfort';
  // Foreground preference (text on the brand colour). Defaults to 'auto' — the
  // engine's contrast pick — until the user forces Light or Dark.
  let foreground: Fg = 'auto';
  // How many shades each ramp carries. New brands start at 5 (a tight, decisive
  // palette); a brand the USER saved here keeps whatever it shipped (seeded from
  // its primary ramp's step count) so re-opening the editor never silently
  // reshapes it — but the catalog's own placeholder brand doesn't count as a user
  // choice, so it doesn't override the 5-step default either.
  const DEFAULT_STEPS = 5;
  const anchorStep = (n: number): number => Math.round((n - 1) / 2) + 1; // mid step = engine at(0.5)
  let steps = DEFAULT_STEPS;
  if (installedDoc && isUserBrand) {
    try {
      const g = createTokenSet(installedDoc).query({ type: 'color' }).filter(t => /^color\.ramp\.primary\.\d+$/.test(t.path));
      if (g.length >= RAMP_STEPS_MIN) steps = Math.min(RAMP_STEPS_MAX, g.length);
    } catch { /* keep the default */ }
  }
  // Neutral/secondary ramp-step picks — default to the anchor (mid) step for the
  // current division count, so they track the shade count until the user picks.
  let neutralStep = anchorStep(steps), secondaryStep = anchorStep(steps);
  // The primary's pinned print lock (null = auto-convert at export) — read LIVE
  // off `doc` rather than cached, since the very same swatch (the primary ramp's
  // anchor step) is also reachable — and lockable — through the Palette panel's
  // swatch popover (see mountPrintLock's two call sites below). A cached copy
  // would drift the moment the OTHER surface writes the lock straight to `doc`.
  const primaryPrintLock = (): PrintLock | null => {
    const p = primaryAnchorPath(doc);
    return p ? getSwatchPrintOverride(doc, p) : null;
  };
  // The colour-harmony the "Build your palette" generator suggests accents from.
  let schemeKind: SchemeKind = 'adjacent-3';
  const currentTheme = document.documentElement.dataset.theme || 'light';

  const initialDraft = deriveSafe({ primary, scheme, surface, contrast, steps, foreground });

  root.innerHTML = `
    <div class="be" data-brand-editor>
      <div class="be-tab" data-be-tab-panel="logos">
        <div class="be-panel be-logos">
          <div class="be-panel-head"><h3 class="be-panel-title">Logos</h3>
            <p class="be-panel-sub">Add whichever marks you have — each <strong>orientation</strong> (horizontal, vertical) in each <strong>treatment</strong> (primary and mono, each with a reverse form for dark backgrounds), plus any marks your brand names its own way — an <strong>icon</strong>, a <strong>crest</strong>. A brand with more than one logo can carry each as its own set. Every slot is optional. PNG, SVG, JPEG or WebP; they stay on this device and travel in your brand file.</p></div>
          <div class="be-logo-grid" data-be-logos></div>
          <p class="be-err" data-be-logo-err hidden></p>
        </div>
      </div>

      <div class="be-tab" data-be-tab-panel="color">
      <div class="be-panel be-colour">
        <div class="be-panel-head"><h3 class="be-panel-title">Colour</h3>
          <p class="be-panel-sub">Pick one colour — Lolly derives the ramps, both themes and every role; click a step in the Neutral or Secondary ramp to choose that shade instead of the default. Changes here preview live across the whole app. "Use this colour" re-derives the palette below — <strong>Save colour</strong> is what actually keeps it.</p></div>
        <div class="be-suggest" data-be-suggest hidden></div>
        <div class="be-derive">
          <div class="be-colorpick">
            <span class="be-field-label">Primary colour</span>
            <div data-be-primary-field>${colorFieldHtml('be-primary', primary, { inline: true, modes: true })}</div>
            <!-- Screen / print: the primary is one colour; Lolly shows its on-screen
                 (sRGB) form and auto-converts it for print — UNLESS the shared print
                 lock below pins an exact CMYK anchor or a named spot colour instead. -->
            <div class="be-subst" data-be-subst>
              <div class="be-subst-line">
                <span class="be-subst-key">Screen</span>
                <code class="be-subst-val" data-be-screen></code>
                <span class="be-subst-tag">auto</span>
              </div>
              <div data-be-lock-mount="primary"></div>
            </div>
          </div>
          <div class="be-derive-controls">
            <label class="be-field"><span class="be-field-label">Scheme</span>${segHtml('scheme', SCHEMES, scheme, 'Colour scheme')}</label>
            <label class="be-field"><span class="be-field-label">UI intensity</span>${segHtml('surface', INTENSITIES, surface, 'UI intensity')}</label>
            <label class="be-field"><span class="be-field-label">Contrast</span>${segHtml('contrast', CONTRASTS, contrast, 'Contrast target')}</label>
            <label class="be-field"><span class="be-field-label">Text on brand</span>${segHtml('foreground', FOREGROUNDS, foreground, 'Text colour on the brand colour')}</label>
            <div class="be-field be-steps-field">
              <span class="be-field-label">Shades <span class="be-steps-val" data-be-steps-val>${steps}</span></span>
              <input type="range" class="be-steps-slider" data-be-steps min="${RAMP_STEPS_MIN}" max="${RAMP_STEPS_MAX}" step="1" value="${steps}" aria-label="Shades per ramp">
            </div>
            <button type="button" class="be-cta" data-be-derive>Use this colour</button>
            <button type="button" class="be-cta" data-be-save hidden>Save colour</button>
          </div>
          <div class="be-preview" data-be-preview>${initialDraft ? previewHtml(initialDraft, { neutral: neutralStep, secondary: secondaryStep, steps }) : ''}</div>
        </div>
      </div>

      <div class="be-panel be-generate">
        <div class="be-panel-head"><h3 class="be-panel-title">Build your palette</h3>
          <p class="be-panel-sub">Generate matching colours from your primary — pick a harmony, then <strong>+ Add</strong> the ones you want to your brand. Each comes pre-named; rename any of them later. See the whole palette on real graphics below.</p></div>
        <div class="be-field">
          <span class="be-field-label">Harmony</span>
          <div class="view-seg be-seg be-schemekinds" role="group" aria-label="Colour harmony" data-be-schemekind>
            ${SCHEME_KINDS.map(k => `<button type="button" class="view-seg-btn" data-kind="${escape(k.id)}" aria-pressed="${k.id === schemeKind}">${escape(k.label)}</button>`).join('')}
          </div>
        </div>
        <div class="be-candidates" data-be-candidates aria-live="polite"></div>
        <div class="be-previews-wrap">
          <span class="be-field-label">Your palette, applied</span>
          <div class="be-previews" data-be-previews></div>
        </div>
      </div>

      <div class="be-panel be-palette">
        <div class="be-panel-head"><h3 class="be-panel-title">Palette</h3>
          <p class="be-panel-sub">Every colour your brand carries — as a list, or on the wheel (angle = hue, distance out = chroma). Click a swatch to recolour or rename it, drag a dot to recolour it, click empty space on the wheel to add one. Changes flow to every picker, tool and export.</p></div>
        <div class="be-pal-actions">
          <label class="be-field be-pal-fmt-field">
            <span class="be-field-label">Download all as</span>
            <select class="be-pal-fmt-sel" data-be-pal-fmt aria-label="Download format">
              <option value="tokens-json">Design tokens (JSON)</option>
              <option value="css-vars">CSS variables</option>
              <option value="css-classes">CSS classes</option>
              <option value="gpl">GIMP palette (.gpl)</option>
              <option value="ase">Adobe Swatch Exchange (.ase)</option>
            </select>
          </label>
          <button type="button" class="be-btn" data-be-pal-download data-sfx="whoosh">Download</button>
        </div>
        <p class="be-err" data-be-pal-err hidden></p>
        <div class="be-pal-split">
          <div class="be-pal-wheel" data-be-wheel-mount></div>
          <div class="be-pal" data-be-pal></div>
        </div>
      </div>

      <div class="be-panel be-gradients" data-be-grads-mount></div>
      </div>

      <div class="be-tab" data-be-tab-panel="type">
      <div class="be-panel be-fonts">
        <div class="be-panel-head"><h3 class="be-panel-title">Fonts</h3>
          <p class="be-panel-sub">Add any <strong>Google Font</strong> — it downloads to this device and renders in the app, your tools and every export. One is always the <strong>primary</strong>; another can serve as your <strong>code</strong> face.</p></div>
        <ul class="be-font-list" data-be-fonts role="list"></ul>
        <form class="be-font-add" data-be-font-add>
          <input type="text" data-be-font-input list="be-google-fonts" placeholder="Search Google Fonts — Inter, Fraunces, Space Grotesk…" autocomplete="off" autocapitalize="words" spellcheck="false" aria-label="Google Fonts family">
          <datalist id="be-google-fonts">${POPULAR_FAMILIES.map(f => `<option value="${escape(f)}"></option>`).join('')}</datalist>
          <button type="submit" class="be-btn" data-be-font-btn>Add font</button>
        </form>
        <p class="be-err" data-be-font-err hidden></p>
      </div>

      <div class="be-panel be-typeroles">
        <div class="be-panel-head"><h3 class="be-panel-title">Type roles</h3>
          <p class="be-panel-sub">What each face is <em>for</em> — the roles tools and the app read. Headings, body and UI wear the primary; code and data wear the mono face.</p></div>
        <div class="be-specimen" data-be-specimen aria-live="off"></div>
      </div>
      </div>

      <div class="be-tab" data-be-tab-panel="tokens">
      <div class="be-panel be-radius-panel">
        <div class="be-panel-head"><h3 class="be-panel-title">Rounded corners</h3>
          <p class="be-panel-sub">One radius token — cards, buttons and panels across the app (and the tools that opt in) follow it.</p></div>
        <div class="brand-radius-row">
          <span class="brand-radius-preview" data-be-radius-preview aria-hidden="true"></span>
          <input type="range" class="brand-radius-slider" data-be-radius-slider min="0" max="1.5" step="0.05" aria-label="Corner radius">
          <span class="brand-radius-value" data-be-radius-value></span>
        </div>
        <p class="be-err" data-be-radius-err role="alert" hidden></p>
      </div>
      <div class="be-panel be-tokens" data-be-tokens-mount></div>
      </div>

      <div class="be-tab" data-be-tab-panel="catalogue">
      <div class="be-panel be-cat" data-be-cat-mount></div>
      </div>

      <!-- Swatch editor popover (shared; positioned under the clicked tile).
           Compact by design: identity row up top, the picker + value entry in a
           scrolling middle, print substitutes folded, Delete/Save pinned to a
           sticky footer — the two actions never scroll away. -->
      <div class="be-editor" data-be-editor hidden>
        <div class="be-editor-card" role="dialog" aria-label="Edit swatch">
          <div class="be-editor-scroll">
            <div class="be-editor-id">
              <span class="be-editor-chip" data-be-editor-chip aria-hidden="true"></span>
              <input type="text" class="be-editor-name" data-be-editor-name autocomplete="off" aria-label="Swatch name">
              <span class="be-swatch-lock be-editor-lockbadge" data-be-editor-lockbadge hidden>LOCK</span>
            </div>
            <div class="be-editor-field"><div data-be-editor-color></div></div>
            <div class="be-editor-field be-fmt">
              <div class="be-fmt-row">
                <select class="be-fmt-sel" data-be-fmt-sel aria-label="Colour space">
                  ${COLOR_FORMATS.map(f => `<option value="${f.id}">${escape(f.label)}</option>`).join('')}
                </select>
                <input type="text" class="be-fmt-input" data-be-fmt-input autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Colour value">
              </div>
              <code class="be-fmt-out" data-be-fmt-out aria-live="polite"></code>
            </div>
            <div class="be-editor-field be-stored" data-be-stored-row>
              <span class="be-stored-label" id="be-stored-label">Stored as</span>
              <div class="be-stored-seg" role="group" aria-labelledby="be-stored-label" data-be-stored>
                ${STORAGE_FORMATS.map(f => `<button type="button" data-store-fmt="${f.id}" aria-pressed="false">${escape(f.label)}</button>`).join('')}
              </div>
            </div>
            <details class="be-subst-details" data-be-subst-details>
              <summary><span class="be-subst-details-label">Print substitutes</span><span class="be-subst-chips" data-be-subst-chips></span></summary>
              <div data-be-subst-mount></div>
            </details>
          </div>
          <div class="be-editor-actions">
            <button type="button" class="be-editor-del" data-be-editor-del hidden>Delete</button>
            <button type="button" class="be-cta be-editor-done" data-be-editor-done>Save</button>
          </div>
        </div>
      </div>
    </div>`;

  const $ = <T extends Element>(sel: string): T | null => root.querySelector<T>(sel);
  const preview = $('[data-be-preview]') as HTMLElement | null;
  const palMount = $('[data-be-pal]') as HTMLElement | null;
  const editorEl = $('[data-be-editor]') as HTMLElement | null;
  const cleanups: Array<() => void> = [];

  // ── Palette state + persistence ─────────────────────────────────────────────
  let swatches: BrandSwatch[] = [];
  let selected = -1;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  // The wheel is a second view of the SAME swatches — assigned once the handlers
  // it needs (openEditor/applyEditedHex/addSwatch) exist, and called by every
  // repaintPalette so grid + wheel never drift.
  const wheelMount = $('[data-be-wheel-mount]') as HTMLElement | null;
  let wheelTeardown: (() => void) | undefined;
  let paintWheel: () => void = () => {};

  // Hooks run at the end of every repaintPalette (the generator's candidate
  // "added" states + applied-previews subscribe here, so any palette change —
  // add / delete / re-derive — keeps them in sync). Declared as a mutable list
  // to sidestep the TDZ: the generator functions are defined further below.
  const paletteHooks: Array<() => void> = [];
  const repaintPalette = (): void => {
    // Roles store `{alias}` refs, so hand the walker a resolver built from the
    // SAME doc + theme the tiles are describing — otherwise every role renders
    // as a blank chip.
    let resolve: ((key: string) => unknown) | undefined;
    try {
      const set = createTokenSet(doc, { theme: currentTheme === 'dark' ? 'dark' : 'light' });
      resolve = (key: string) => set.resolve(key);
    } catch { /* a malformed doc still lists its literal swatches */ }
    swatches = walkSwatches(doc, currentTheme, resolve);
    if (palMount) palMount.innerHTML = paletteHtml(swatches);
    paintWheel();
    syncPickerSwatches();
    for (const fn of paletteHooks) fn();
  };

  // Feed the colour PICKER's swatch grid from the live (draft) brand palette, so
  // the inline primary picker's swatches reflect exactly the colours this brand
  // carries — and grow/shrink as the user adds or deletes them. Roles (aliases)
  // are skipped (they duplicate the ramp step they point at); transparent leads.
  // refreshSwatches repopulates the already-open inline grid in place.
  const syncPickerSwatches = (): void => {
    const opts = swatches
      .filter(s => s.hex && s.kind !== 'semantic')
      .map(s => ({ value: s.hex, label: s.name, group: s.group, ref: s.isAlias ? null : `{${s.key}}` }));
    setSwatches([{ value: 'transparent', label: 'Transparent', group: null, ref: null }, ...opts]);
    refreshSwatches(root);
  };

  // The Save-colour dirty flag — declared ahead of persist() below, which
  // clears it: Palette edits and the Colour draft share the one `doc`, so a
  // persist() triggered from the Palette panel writes a pending Colour draft
  // too, and the button must stop claiming it's unsaved once that happens.
  const saveBtn = $('[data-be-save]') as HTMLButtonElement | null;
  const setDirty = (v: boolean): void => { if (saveBtn) saveBtn.hidden = !v; };

  // "Use this colour" lights up bright green (see .be-cta.is-active) the moment any
  // derive input changes — colour, scheme, surface, contrast, shades, a ramp step —
  // signalling there's a fresh palette to apply. Cleared once it's applied (or the
  // draft is saved), so a resting button never nags. Every live change funnels
  // through renderPreview(), so that's the one place we flag it.
  const deriveBtn = $('[data-be-derive]') as HTMLButtonElement | null;
  const setDeriveActive = (v: boolean): void => { deriveBtn?.classList.toggle('is-active', v); };

  /** Tell the host view a brand edit just landed on `tab` (Save-&-continue
   *  appearance + next-tab nudge). Best-effort — a throwing listener must never
   *  break an edit. */
  const notify = (tab: BrandTabKey): void => { try { opts.onChange?.(tab); } catch { /* host's problem */ } };

  /**
   * Push the edited doc to the install (debounced) + refresh chrome & pickers.
   * Also clears the Save-colour dirty flag — see setDirty above. Every caller
   * is a Colour-tab surface (palette tiles, wheel, locks, generator), so this
   * is also the one place that flags colour-tab activity to the host.
   */
  const persist = (immediate = false): void => {
    clearTimeout(saveTimer);
    setDirty(false);
    notify('color');
    setDeriveActive(false); // saved — nothing pending to apply
    const run = async (): Promise<void> => {
      try {
        await installUserTokens(host as unknown as Parameters<typeof installUserTokens>[0], doc, { label: 'My brand' });
        void applyChromeBrandVars(host);
        // Reflect the new palette in every picker without a tool remount.
        try {
          const cols = (await tokens?.colors?.()) ?? [];
          setSwatches(cols.map(c => ({ value: c.value, label: c.name, group: c.group, ref: c.ref })));
        } catch { /* pickers refresh on next tool mount regardless */ }
      } catch (err) {
        if (root.isConnected) announce(`Couldn't save the brand: ${String((err as { message?: unknown })?.message ?? err)}`, { assertive: true });
      }
    };
    if (immediate) void run(); else saveTimer = setTimeout(run, 300);
  };

  // ── Derive controls ─────────────────────────────────────────────────────────
  // Colour is DRAFT-until-saved: every change below live-applies the chrome
  // accent + the Dashboard ink-bar app-wide (applyDraftChrome/broadcastDraft),
  // but nothing here calls persist() directly — only the Save colour button
  // does (a Palette-panel persist() can also clear this draft — see persist()).
  const renderPreview = (): void => {
    const next = deriveSafe({ primary, scheme, surface, contrast, steps, foreground });
    if (!next) return; // a half-typed hex mid-edit — keep the last good preview
    if (preview) preview.innerHTML = previewHtml(next, { neutral: neutralStep, secondary: secondaryStep, steps });
    applyDraftChrome(next);
    broadcastDraft(next);
    setDeriveActive(true); // a derive input changed → invite the user to apply it
    // Deliberately NO notify() here: a preview-only change isn't saveable yet
    // (saveDraft() would no-op), so surfacing the host's "Save & continue" now
    // would be a lie — the glowing "Use this colour" CTA is the honest next step.
  };
  // Shades slider — how many divisions each ramp carries. Re-derives live; the
  // neutral/secondary step picks re-centre on the new anchor (and clamp in range).
  const stepsSlider = $('[data-be-steps]') as HTMLInputElement | null;
  const stepsVal = $('[data-be-steps-val]') as HTMLElement | null;
  stepsSlider?.addEventListener('input', () => {
    steps = Math.round(Number(stepsSlider.value)) || DEFAULT_STEPS;
    if (stepsVal) stepsVal.textContent = String(steps);
    neutralStep = Math.min(neutralStep, steps);
    secondaryStep = Math.min(secondaryStep, steps);
    renderPreview();
  });
  const onPrimaryFieldChange = (id: string, value: string | { value: string }): void => {
    if (id !== 'be-primary') return;
    const raw = typeof value === 'string' ? value : value.value;
    if (!raw || raw === 'transparent') return;
    primary = /^#[0-9a-fA-F]{8}$/.test(raw) ? raw.slice(0, 7) : raw;
    renderPreview();
    renderScreen();
    primaryLock?.render();
    renderGenerator();
  };
  wireColorField(root, { onChange: onPrimaryFieldChange });
  /** Programmatically move the primary (the logo-colour pathway): re-seed the
   *  visual field (fresh render + wire — no setter exists on the component) and
   *  run the same fan-out a manual pick runs. */
  const setPrimaryTo = (hex: string): void => {
    primary = hex;
    const wrap = $('[data-be-primary-field]') as HTMLElement | null;
    if (wrap) {
      wrap.innerHTML = colorFieldHtml('be-primary', hex, { inline: true, modes: true });
      wireColorField(wrap, { onChange: onPrimaryFieldChange });
      refreshSwatches(wrap);
    }
    renderPreview();
    renderScreen();
    primaryLock?.render();
    renderGenerator();
  };

  /** The current primary as a `#`-prefixed hex (shared by the generator + the
   *  screen/print readout below). */
  const primaryHex = (): string => (/^#/.test(primary) ? primary : `#${primary}`);

  // ── Build your palette: generate harmony accents (named) + live "applied" previews ──
  // Each accent is a candidate the user must explicitly + Add to officiate it
  // into the brand (addSwatch → repaintPalette → persist), matching the Palette
  // panel's add semantics. The previews render the CURRENT brand palette on
  // illustrative graphics so the effect of adding/removing colours is felt.
  const candidatesEl = $('[data-be-candidates]') as HTMLElement | null;
  const previewsEl = $('[data-be-previews]') as HTMLElement | null;
  /** The brand's live palette as hexes (primary first), deduped — feeds the previews. */
  const paletteHexes = (): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (h: string | undefined): void => { const k = (h || '').toLowerCase(); if (h && /^#[0-9a-fA-F]{6}/.test(h) && !seen.has(k)) { seen.add(k); out.push(h.slice(0, 7)); } };
    add(primaryHex());
    for (const s of swatches) if (s.hex && s.kind !== 'semantic') add(s.hex);
    return out;
  };
  const isInPalette = (hex: string): boolean => {
    const k = hex.toLowerCase().slice(0, 7);
    return swatches.some(s => (s.hex || '').toLowerCase().slice(0, 7) === k);
  };
  const renderCandidates = (): void => {
    if (!candidatesEl) return;
    let accents: ReturnType<typeof generateSchemeAccents> = [];
    try { accents = generateSchemeAccents(primaryHex(), schemeKind); } catch { accents = []; }
    candidatesEl.innerHTML = accents.map(a => {
      const name = nameColor(a.hex);
      const added = isInPalette(a.hex);
      return `<div class="be-cand${added ? ' is-added' : ''}">
          <span class="be-cand-sw" style="background:${escape(a.hex)}" aria-hidden="true"></span>
          <span class="be-cand-meta"><span class="be-cand-name">${escape(name)}</span><span class="be-cand-hex">${escape(a.hex)}</span></span>
          <button type="button" class="be-cand-add" data-add-hex="${escape(a.hex)}" data-add-name="${escape(name)}"${added ? ' disabled aria-disabled="true"' : ''}>${added ? '✓ Added' : '+ Add'}</button>
        </div>`;
    }).join('');
  };
  const renderPreviews = (): void => {
    if (!previewsEl) return;
    const scenes = palettePreviewSvgs(paletteHexes(), { steps });
    previewsEl.innerHTML = scenes.map(s => `<figure class="be-pv"><div class="be-pv-art">${s.svg}</div><figcaption class="be-pv-cap">${escape(s.label)}</figcaption></figure>`).join('');
  };
  const renderGenerator = (): void => { renderCandidates(); renderPreviews(); };
  $('[data-be-schemekind]')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]'); if (!btn) return;
    schemeKind = btn.dataset.kind as SchemeKind;
    root.querySelectorAll<HTMLElement>('[data-be-schemekind] [data-kind]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    renderCandidates();
  });
  candidatesEl?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-add-hex]'); if (!btn || btn.disabled) return;
    const hex = btn.dataset.addHex!, name = btn.dataset.addName || nameColor(hex);
    if (isInPalette(hex)) return;
    addSwatch(doc, 'spectrum', name, serializeColor(hex, 'lch')); // LCH — the storage default
    repaintPalette();       // refreshes swatches + picker + wheel + (via hook) the generator
    persist(true);          // officiate: the accent is now part of the brand
    playSfx('click');
    announce(`${name} added to your palette`);
  });
  paletteHooks.push(renderGenerator); // keep candidates + previews in sync with the palette
  renderGenerator();                  // initial paint

  // ── Screen readout — the primary's on-screen (sRGB) form. ───────────────────
  const screenEl = $('[data-be-screen]') as HTMLElement | null;
  const renderScreen = (): void => {
    const hex = primaryHex();
    if (screenEl) screenEl.textContent = `${hex.toUpperCase()} · rgb(${formatColor('rgb', hex)})`;
  };
  renderScreen();
  root.querySelectorAll<HTMLElement>('[data-be-seg]').forEach(seg => {
    const on = (e: Event): void => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-val]'); if (!btn) return;
      const name = seg.dataset.beSeg;
      if (name === 'scheme') scheme = btn.dataset.val as Scheme;
      else if (name === 'surface') surface = btn.dataset.val as Surface;
      else if (name === 'contrast') contrast = btn.dataset.val as Contrast;
      else if (name === 'foreground') foreground = btn.dataset.val as Fg;
      seg.querySelectorAll<HTMLElement>('[data-val]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      renderPreview();
    };
    seg.addEventListener('click', on);
  });
  // The primary's print lock — mounted only now, AFTER the generic [data-be-seg]
  // delegate above has taken its one-time querySelectorAll snapshot, so this
  // control's own Auto/Locked + Process/Spot segments (built on the same
  // segHtml markup) don't get swept into that older Scheme/Surface/Contrast
  // listener (see mountPrintLock's doc comment).
  const primaryLockMount = $('[data-be-lock-mount="primary"]') as HTMLElement | null;
  const primaryLock = primaryLockMount ? mountPrintLock(primaryLockMount, {
    hex: () => primaryHex(),
    getCmyk: () => primaryPrintLock()?.cmyk ?? null,
    setCmyk: (cmyk) => {
      const path = primaryAnchorPath(doc);
      if (path) setSwatchCmykLock(doc, path, cmyk); // rides on the current draft; Save persists it
      setDirty(true);
      notify('color');
      repaintPalette(); // same swatch is a tile in the Palette panel — keep its lock badge in sync
    },
    getSpot: () => primaryPrintLock()?.spot ?? null,
    setSpot: (spot) => {
      const path = primaryAnchorPath(doc);
      if (path) setSwatchSpotLock(doc, path, spot);
      setDirty(true);
      notify('color');
      repaintPalette();
    },
  }) : null;
  // Neutral/secondary ramp-step picks — the Primary ramp stays non-interactive
  // (it's already driven by the colour field above, not a step choice).
  preview?.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-be-ramp]');
    if (!cell) return;
    const step = Number(cell.dataset.beStep);
    if (cell.dataset.beRamp === 'neutral') neutralStep = step;
    else if (cell.dataset.beRamp === 'secondary') secondaryStep = step;
    else return;
    renderPreview();
  });
  $('[data-be-derive]')?.addEventListener('click', async () => {
    let next: Record<string, unknown>;
    try { next = deriveBrandTokens({ primary, scheme, surface, contrast, steps, foreground, name: 'My brand' }) as Record<string, unknown>; }
    catch (err) { announce(`Couldn't derive from ${primary}: ${String((err as { message?: unknown })?.message ?? err)}`, { assertive: true }); return; }
    setSemanticRampAlias(next, 'secondary', secondaryStep);
    setSemanticRampAlias(next, 'neutral', neutralStep);
    // Read the lock LIVE off the pre-derive `doc` — whichever surface (Colour
    // panel or the Palette panel's swatch popover) set it last, since both write
    // straight to `doc` — so re-deriving never silently drops a lock the other
    // surface just set (see primaryPrintLock's doc comment above). cmyk and spot
    // are independent, so both are re-pinned onto the freshly derived doc.
    const priorLock = primaryPrintLock();
    const p = priorLock ? primaryAnchorPath(next) : null;
    if (p && priorLock?.cmyk) setSwatchCmykLock(next, p, priorLock.cmyk); // ramp rebuilt → re-pin the print lock
    if (p && priorLock?.spot) setSwatchSpotLock(next, p, priorLock.spot);
    // Deriving only rebuilds COLOUR — everything else the doc carries (the
    // studio's spacing/shadows/gradients, the font roles, the logos' asset
    // tokens, shape.radius) survives it, same precedent as the print lock.
    // deriveBrandTokens never emits these groups, so a straight carry is safe.
    {
      const cur = isRec(doc) ? doc : {};
      const srcBase = (isRec(cur.base) ? cur.base : cur) as Record<string, unknown>;
      const dstBase = (isRec(next.base) ? next.base : next) as Record<string, unknown>;
      for (const g of [...STUDIO_GROUPS, 'font', 'asset', 'shape']) {
        if (dstBase[g] === undefined && isRec(srcBase[g])) dstBase[g] = structuredClone(srcBase[g]);
      }
    }
    const ok = swatches.some(s => s.kind === 'custom')
      ? await confirmDialog({ title: 'Re-derive the palette?', message: 'This rebuilds every swatch from your colour and drops the custom swatches you added.', confirmLabel: 'Re-derive' })
      : true;
    if (!ok || !root.isConnected) return;
    // Commits into the in-memory draft only — no persist() here; Save colour
    // (below) is the only thing in this panel that writes to storage.
    doc = next; repaintPalette(); applyDraftChrome(doc); broadcastDraft(doc); setDirty(true); notify('color');
    setDeriveActive(false); // applied — the button rests until the next change
    playSfx('click');
    announce('Palette re-derived from your colour — click Save colour to keep it');
  });
  saveBtn?.addEventListener('click', () => {
    persist(true); playSfx('saveProfile');
    announce('Brand colour saved');
  });

  // ── Palette: click a tile → open the shared swatch editor ───────────────────
  // The popover carries TWO ways to set a colour that stay in lock-step: the
  // visual colour field, and a "Set by value" row (Hex / RGB / RGBA / OKLCH /
  // CMYK — see color-formats.ts) that lets a user type an exact value in any
  // space and extrapolates the rest. Both funnel through applyEditedHex, which
  // WRITES the doc in the swatch's storage format (the "Stored as" toggle —
  // LCH by default, the notation already in the doc for older edits).
  const fmtSel = editorEl?.querySelector<HTMLSelectElement>('[data-be-fmt-sel]') ?? null;
  const fmtInput = editorEl?.querySelector<HTMLInputElement>('[data-be-fmt-input]') ?? null;
  const fmtOut = editorEl?.querySelector<HTMLElement>('[data-be-fmt-out]') ?? null;
  const editorLockBadge = editorEl?.querySelector<HTMLElement>('[data-be-editor-lockbadge]') ?? null;
  const editorChip = editorEl?.querySelector<HTMLElement>('[data-be-editor-chip]') ?? null;
  const storedSeg = editorEl?.querySelector<HTMLElement>('[data-be-stored]') ?? null;
  const storedRow = editorEl?.querySelector<HTMLElement>('[data-be-stored-row]') ?? null;
  const substDetails = editorEl?.querySelector<HTMLDetailsElement>('[data-be-subst-details]') ?? null;
  const substChips = editorEl?.querySelector<HTMLElement>('[data-be-subst-chips]') ?? null;
  let editFmt: ColorFormat = 'hex'; // sticky across swatch selections
  // The open swatch's $value notation. Entering via the CMYK row keeps this and
  // additionally pins the typed inks as the print CMYK (see commitFmt) — the
  // "primary value was a CMYK one" case keeps its anchor rather than storing lch.
  let storedFmt: StorageFormat = 'lch';

  const renderStoredSeg = (): void => {
    storedSeg?.querySelectorAll<HTMLElement>('[data-store-fmt]').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.storeFmt === storedFmt)));
  };
  /** The print-substitute state, summarised on the folded row so a lock is
   *  visible without opening it. */
  const renderSubstChips = (): void => {
    const cur = selected >= 0 ? swatches[selected] : null;
    if (!substChips) return;
    const bits: string[] = [];
    if (cur?.lock?.cmyk) bits.push(`<span class="be-ps-chip">C${cur.lock.cmyk[0]} M${cur.lock.cmyk[1]} Y${cur.lock.cmyk[2]} K${cur.lock.cmyk[3]}</span>`);
    if (cur?.lock?.spot) bits.push(`<span class="be-ps-chip">${escape(cur.lock.spot.name)}</span>`);
    substChips.innerHTML = bits.length ? bits.join('') : '<span class="be-ps-chip be-ps-chip--auto">auto</span>';
  };

  /** Refresh a swatch's tile in place (lock badge + colour), without a full repaint —
   *  preserves `.is-selected` (tileHtml doesn't know selection state) so an open
   *  popover's tile doesn't lose its ring the moment its lock changes. */
  const refreshTile = (idx: number): void => {
    const s = swatches[idx]; const tile = palMount?.querySelector<HTMLElement>(`[data-be-tile="${idx}"]`);
    if (!s || !tile) return;
    const wasSelected = tile.classList.contains('is-selected');
    tile.outerHTML = tileHtml(s, idx);
    if (wasSelected) palMount?.querySelector<HTMLElement>(`[data-be-tile="${idx}"]`)?.classList.add('is-selected');
  };
  // The swatch popover's print substitutes — always read/write whichever swatch
  // is CURRENTLY open (`selected`), so the control is built once and driven
  // dynamically rather than re-mounted per swatch (openEditor calls render()).
  const substMount = editorEl?.querySelector<HTMLElement>('[data-be-subst-mount]') ?? null;
  // Re-syncs the popover's lock badge + folded-row chips + tile + the
  // primary-panel control (when the edited swatch IS the primary anchor — see
  // primaryPrintLock's doc comment) after either half of the swatch lock changes.
  const afterSwatchLockChange = (): void => {
    if (selected < 0) return;
    const cur = swatches[selected]!;
    cur.lock = getSwatchPrintOverride(doc, cur.path);
    refreshTile(selected);
    if (editorLockBadge) editorLockBadge.hidden = !cur.lock;
    renderSubstChips();
    persist();
    const anchorPath = primaryAnchorPath(doc);
    if (anchorPath && samePath(anchorPath, cur.path)) primaryLock?.render();
  };
  const swatchSubst = substMount ? mountPrintSubst(substMount, {
    hex: () => (selected >= 0 ? swatches[selected]!.hex : ''),
    getCmyk: () => (selected >= 0 ? getSwatchPrintOverride(doc, swatches[selected]!.path)?.cmyk ?? null : null),
    setCmyk: (cmyk) => { if (selected >= 0) { setSwatchCmykLock(doc, swatches[selected]!.path, cmyk); afterSwatchLockChange(); } },
    getSpot: () => (selected >= 0 ? getSwatchPrintOverride(doc, swatches[selected]!.path)?.spot ?? null : null),
    setSpot: (spot) => { if (selected >= 0) { setSwatchSpotLock(doc, swatches[selected]!.path, spot); afterSwatchLockChange(); } },
  }) : null;

  // "Stored as" — re-serialise the open swatch's $value in the picked notation.
  // An alias role has no literal of its own to re-write, so the row hides for
  // those (recolouring detaches the alias first, which re-shows it).
  storedSeg?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-store-fmt]'); if (!btn) return;
    const next = btn.dataset.storeFmt as StorageFormat;
    if (next === storedFmt) return;
    storedFmt = next;
    renderStoredSeg();
    const cur = selected >= 0 ? swatches[selected] : null;
    if (!cur || cur.isAlias || !cur.hex) return;
    const stored = serializeColor(colorToHex(cur.raw) ?? cur.hex, storedFmt);
    setSwatchValue(doc, cur.path, stored);
    cur.raw = stored;
    persist();
  });

  const extrapolation = (hex: string): string =>
    hex ? `${hex.toUpperCase()} · rgb(${formatColor('rgb', hex)})` : '';
  /** Sync the value row to a hex — but never clobber the field the user is typing in. */
  const syncFmtRow = (hex: string): void => {
    if (fmtInput && document.activeElement !== fmtInput) fmtInput.value = formatColor(editFmt, hex);
    if (fmtOut) fmtOut.textContent = extrapolation(hex);
  };
  /** (Re)build the visual colour field on a hex, wiring its live onChange. */
  const renderEditField = (hex: string): void => {
    const mountEl = editorEl?.querySelector<HTMLElement>('[data-be-editor-color]'); if (!mountEl) return;
    // Inline (not block): the sliders + swatches sit in the editor card's flow
    // instead of a floating popover that overlapped the value/name rows below.
    mountEl.innerHTML = colorFieldHtml('be-edit-color', hex || '#888888', { inline: true });
    wireColorField(mountEl, {
      onChange: (id, value) => {
        if (id !== 'be-edit-color') return;
        const raw = typeof value === 'string' ? value : value.value;
        applyEditedHex(raw); // field-driven → don't re-render the field under the user
      },
    });
  };
  /**
   * Apply a colour to the selected swatch from EITHER surface: write it to the
   * doc, repaint the tile + value row, and persist. Alpha is kept — an `#rrggbbaa`
   * from the field's opacity slider (or an rgba()/oklch(… / a) value) flows
   * through verbatim, so brand swatches can be translucent. `rerenderField`
   * re-seeds the visual field (used when the value row drove the change, so the
   * sliders catch up; NOT when the field itself did, mid-drag).
   */
  function applyEditedHex(rawHex: string, opts: { rerenderField?: boolean } = {}): void {
    const cur = selected >= 0 ? swatches[selected] : null; if (!cur) return;
    if (!rawHex || rawHex === 'transparent') return;
    const hex = rawHex; // keep #rrggbbaa alpha — brand swatches may be translucent
    // The doc stores the swatch's chosen notation ("Stored as" — LCH default);
    // the tile/UI keep working in resolved hex. Recolouring an alias role
    // detaches it to a literal, which is when the storage toggle starts to bite.
    const stored = serializeColor(colorToHex(hex) ?? hex, storedFmt);
    setSwatchValue(doc, cur.path, stored);
    cur.hex = colorToHex(hex) ?? hex; cur.raw = stored;
    if (cur.isAlias) { cur.isAlias = false; if (storedRow) storedRow.hidden = false; }
    const tile = palMount?.querySelector<HTMLElement>(`[data-be-tile="${selected}"]`);
    if (tile) {
      tile.style.setProperty('--sw', cur.hex);
      tile.classList.remove('is-empty');
      const hx = tile.querySelector('.be-swatch-hex'); if (hx) hx.textContent = cur.hex;
    }
    if (editorChip) editorChip.style.setProperty('--sw', cur.hex);
    syncFmtRow(cur.hex);
    if (opts.rerenderField) renderEditField(cur.hex);
    persist();
  }

  const closeEditor = (): void => { if (editorEl) { editorEl.hidden = true; } selected = -1; root.querySelectorAll('.be-swatch.is-selected').forEach(t => t.classList.remove('is-selected')); };
  const openEditor = (idx: number, tile: HTMLElement): void => {
    const s = swatches[idx]; if (!s || !editorEl) return;
    selected = idx;
    root.querySelectorAll('.be-swatch.is-selected').forEach(t => t.classList.remove('is-selected'));
    tile.classList.add('is-selected');
    const nameInput = editorEl.querySelector<HTMLInputElement>('[data-be-editor-name]')!;
    const delBtn = editorEl.querySelector<HTMLButtonElement>('[data-be-editor-del]')!;
    renderEditField(s.hex);
    if (editorChip) editorChip.style.setProperty('--sw', s.hex || 'transparent');
    if (fmtInput) fmtInput.value = formatColor(editFmt, s.hex);
    if (fmtOut) fmtOut.textContent = extrapolation(s.hex);
    nameInput.value = s.name;
    delBtn.hidden = !s.deletable;
    if (editorLockBadge) editorLockBadge.hidden = !s.lock;
    // Storage notation: respect what the doc already holds (an older hex edit
    // stays hex); the app default for everything else — aliases included, which
    // start storing the moment a recolour detaches them — is LCH. The row hides
    // while there's no literal to re-write.
    storedFmt = s.isAlias ? 'lch' : storageFormatOf(s.raw);
    renderStoredSeg();
    if (storedRow) storedRow.hidden = s.isAlias;
    renderSubstChips();
    if (substDetails) substDetails.open = false; // folded until asked — the lock chips say enough
    swatchSubst?.render();
    // Position the popover under the tile, clamped to the editor box — the
    // left floor (8) must win over the right clamp so a viewport narrower
    // than the card never pushes it off the left edge.
    const r = tile.getBoundingClientRect(), pr = root.getBoundingClientRect();
    editorEl.style.left = `${Math.max(8, Math.min(r.left - pr.left, pr.width - 308))}px`;
    editorEl.style.top = `${r.bottom - pr.top + 8}px`;
    editorEl.hidden = false;
    nameInput.focus();
  };

  // "Set by value" row — bound ONCE (the select/input are static in the popover);
  // both read the currently-`selected` swatch.
  fmtSel?.addEventListener('change', () => {
    editFmt = fmtSel.value as ColorFormat;
    const cur = selected >= 0 ? swatches[selected] : null;
    if (cur && fmtInput) fmtInput.value = formatColor(editFmt, cur.hex);
    if (cur) syncFmtRow(cur.hex);
  });
  const commitFmt = (): void => {
    if (!fmtInput) return;
    const hex = parseColor(editFmt, fmtInput.value);
    if (!hex) { if (fmtOut) fmtOut.textContent = 'unrecognised value'; return; }
    applyEditedHex(hex, { rerenderField: true });
    // A value ENTERED as CMYK is a print value: pin the typed inks as the
    // swatch's CMYK substitute (the $value keeps only the sRGB approximation,
    // so without the lock the exact build would be lost on export).
    if (editFmt === 'cmyk' && selected >= 0) {
      const nums = (fmtInput.value.match(/-?\d*\.?\d+/g) ?? []).map(Number);
      if (nums.length >= 4) {
        const cmyk = nums.slice(0, 4).map(n => Math.min(100, Math.max(0, Math.round(n)))) as [number, number, number, number];
        setSwatchCmykLock(doc, swatches[selected]!.path, cmyk);
        afterSwatchLockChange();
        swatchSubst?.render();
      }
    }
  };
  // Live extrapolation as they type; commit (apply) on blur / Enter.
  fmtInput?.addEventListener('input', () => {
    if (!fmtInput || !fmtOut) return;
    const hex = parseColor(editFmt, fmtInput.value);
    fmtOut.textContent = hex ? extrapolation(hex) : 'unrecognised value';
  });
  fmtInput?.addEventListener('change', commitFmt);
  fmtInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitFmt(); } });
  palMount?.addEventListener('click', (e) => {
    const add = (e.target as HTMLElement).closest<HTMLElement>('[data-be-add]');
    if (add) {
      const group = add.dataset.beAdd === 'spectrum' ? 'spectrum' : 'custom';
      // A neutral new swatch the user immediately recolours — stored LCH, the default.
      const path = addSwatch(doc, group, group === 'spectrum' ? 'New hue' : 'New swatch', serializeColor('#888888', 'lch'));
      repaintPalette(); persist(true);
      // Select the leaf we just wrote (by JSON path — never "the last one", which
      // depends on key order after a repaint).
      const newIdx = path ? swatches.findIndex(s => s.path.length === path.length && s.path.every((seg, i) => seg === path[i])) : -1;
      const tile = newIdx >= 0 ? palMount!.querySelector<HTMLElement>(`[data-be-tile="${newIdx}"]`) : null;
      if (newIdx >= 0 && tile) openEditor(newIdx, tile);
      return;
    }
    const tileEl = (e.target as HTMLElement).closest<HTMLElement>('[data-be-tile]');
    if (tileEl) openEditor(Number(tileEl.dataset.beTile), tileEl);
  });
  editorEl?.querySelector('[data-be-editor-name]')?.addEventListener('input', (e) => {
    if (selected < 0) return;
    const cur = swatches[selected]; if (!cur) return;
    const val = (e.target as HTMLInputElement).value;
    setSwatchName(doc, cur.path, val); cur.name = val || cur.name;
    const tile = palMount?.querySelector<HTMLElement>(`[data-be-tile="${selected}"] .be-swatch-name`);
    if (tile) tile.textContent = val;
    persist();
  });
  editorEl?.querySelector('[data-be-editor-del]')?.addEventListener('click', () => {
    if (selected < 0) return;
    const cur = swatches[selected]; if (!cur || !cur.deletable) return;
    deleteSwatch(doc, cur.path); closeEditor(); repaintPalette(); persist(true);
  });
  // Save = the affirmative close: edits already landed live (same contract as
  // the wheel/tiles), so this flushes the debounce, confirms audibly, and closes.
  editorEl?.querySelector('[data-be-editor-done]')?.addEventListener('click', () => {
    persist(true); playSfx('saveProfile'); closeEditor();
  });
  // Esc / outside-click closes the swatch editor (the colour popover stops its own Esc).
  const onDocPointer = (e: PointerEvent): void => {
    if (editorEl && !editorEl.hidden && !editorEl.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-be-tile]')) closeEditor();
  };
  // stopImmediatePropagation, not stopPropagation: the host view's own
  // Esc-to-leave handler listens on the SAME document target, and plain
  // stopPropagation can't stop a sibling listener — Esc on an open popover
  // would close it AND kick the user out of the studio. The editor mounts
  // before the host wires its handler, so this one runs first.
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && editorEl && !editorEl.hidden) { e.stopImmediatePropagation(); closeEditor(); } };
  document.addEventListener('pointerdown', onDocPointer, true);
  document.addEventListener('keydown', onKey);
  cleanups.push(() => { document.removeEventListener('pointerdown', onDocPointer, true); document.removeEventListener('keydown', onKey); });

  // ── The wheel: a live OKLCH hue/chroma view of the SAME swatches ────────────
  // Drag a dot to recolour it (hue+chroma from where it lands, lightness kept),
  // click a dot to open its editor, click empty space to drop a new custom
  // swatch there. Re-rendered (and re-wired) on every repaint so it never drifts
  // from the grid; recolours update the one dot + its grid tile in place.
  const liveTile = (idx: number, hex: string): void => {
    const tile = palMount?.querySelector<HTMLElement>(`[data-be-tile="${idx}"]`);
    if (!tile) return;
    tile.style.setProperty('--sw', hex);
    tile.classList.remove('is-empty');
    const hx = tile.querySelector('.be-swatch-hex'); if (hx) hx.textContent = hex;
  };
  paintWheel = (): void => {
    if (!wheelMount) return;
    const dots: WheelDot[] = swatches.map((s, idx) => ({ idx, hex: s.hex, label: s.name }));
    wheelMount.innerHTML = renderBrandWheel(dots);
    wheelTeardown?.();
    wheelTeardown = wireBrandWheel(wheelMount, {
      hexOf: (idx) => swatches[idx]?.hex ?? '#888888',
      onRecolor: (idx, o) => {
        const cur = swatches[idx]; if (!cur) return;
        // Respect the swatch's stored notation: LCH swatches (the default) get
        // the exact oklch() string; a swatch the user stores as hex/rgb/hsl
        // keeps its notation through a wheel drag too.
        const fmt = storageFormatOf(cur.raw);
        const hex = oklchHex(o);
        const stored = fmt === 'lch' ? oklchToStored(o) : serializeColor(hex, fmt);
        setSwatchValue(doc, cur.path, stored);
        cur.raw = stored; cur.hex = hex;
        updateWheelDot(wheelMount, idx, hex);
        liveTile(idx, hex);
        if (selected === idx) syncFmtRow(hex); // keep an open editor's value row in step
      },
      onCommit: () => persist(),
      onPick: (idx) => {
        const anchor = palMount?.querySelector<HTMLElement>(`[data-be-tile="${idx}"]`)
          ?? wheelMount.querySelector<HTMLElement>(`[data-be-widx="${idx}"]`);
        if (anchor) openEditor(idx, anchor);
      },
      onAdd: (seed) => {
        const path = addSwatch(doc, 'custom', 'New swatch', oklchHex(seed));
        if (path) setSwatchValue(doc, path, oklchToStored(seed)); // sit exactly where dropped
        repaintPalette(); persist(true);
        const newIdx = path ? swatches.findIndex(s => s.path.length === path.length && s.path.every((seg, i) => seg === path[i])) : -1;
        const anchor = newIdx >= 0
          ? (palMount?.querySelector<HTMLElement>(`[data-be-tile="${newIdx}"]`) ?? wheelMount.querySelector<HTMLElement>(`[data-be-widx="${newIdx}"]`))
          : null;
        if (newIdx >= 0 && anchor) openEditor(newIdx, anchor);
      },
    });
  };
  cleanups.push(() => wheelTeardown?.());

  repaintPalette();

  // ── Fonts (the Type tab) ─────────────────────────────────────────────────────
  const fontErr = $('[data-be-font-err]') as HTMLElement | null;
  const showFontErr = (m: string): void => { if (fontErr) { fontErr.textContent = m; fontErr.hidden = !m; } if (m) announce(m, { assertive: true }); };
  let fontFamilies: UserFontFamily[] = [];
  let monoFamily = ''; // the font.mono role's family, '' when the platform default serves
  const fontRow = (f: UserFontFamily): string => {
    const isMono = f.family === monoFamily;
    return `
    <li class="be-font-row${f.primary ? ' is-primary' : ''}" data-font-family="${escape(f.family)}">
      <span class="be-font-aa" style="font-family:'${escape(f.family)}'" aria-hidden="true">Aa</span>
      <span class="be-font-meta"><span class="be-font-name" style="font-family:'${escape(f.family)}'">${escape(f.family)}</span>
        <span class="be-font-sub">${escape(f.weights)} · ${fmtBytes(f.bytes)}</span></span>
      ${f.primary ? '<span class="be-font-badge">Primary</span>'
        : `<button type="button" class="be-btn be-font-mp" data-mp="${escape(f.family)}">Make primary</button>`}
      ${isMono ? '<span class="be-font-badge be-font-badge--mono">Code</span>'
        : `<button type="button" class="be-btn be-font-mono" data-mono="${escape(f.family)}" title="Use ${escape(f.family)} for code & data">Use for code</button>`}
      <button type="button" class="be-font-del" data-del="${escape(f.family)}" aria-label="Remove ${escape(f.family)}">&#x2715;</button>
    </li>`;
  };
  // The live specimen (Type roles panel): each role rendered in the face that
  // actually serves it — --font-brand / --font-mono, whatever set them.
  const paintSpecimen = async (): Promise<void> => {
    const mount = $('[data-be-specimen]') as HTMLElement | null; if (!mount) return;
    const brandFace = await primaryFontFamily(fontsHost).catch(() => '') || 'Platform default';
    const monoFace = monoFamily || 'Platform default';
    if (!root.isConnected) return;
    mount.innerHTML = `
      <div class="be-typerole">
        <span class="be-typerole-role">Heading</span>
        <span class="be-typerole-sample be-typerole-sample--h" style="font-family:var(--font-brand)">Pack my box with five dozen liqueur jugs</span>
        <span class="be-typerole-face">${escape(brandFace)}</span>
      </div>
      <div class="be-typerole">
        <span class="be-typerole-role">Body</span>
        <span class="be-typerole-sample" style="font-family:var(--font-brand)">Every tool, page and export follows the primary face — headings, body copy and UI alike. Sub-heading, call-to-action and italic roles arrive here as tokens tools can read.</span>
        <span class="be-typerole-face">${escape(brandFace)}</span>
      </div>
      <div class="be-typerole">
        <span class="be-typerole-role">Code &amp; data</span>
        <span class="be-typerole-sample be-typerole-sample--mono" style="font-family:var(--font-mono)">lolly qr-code --url=https://example.com --export=svg</span>
        <span class="be-typerole-face">${escape(monoFace)}</span>
      </div>`;
  };
  const paintFonts = async (): Promise<void> => {
    const list = $('[data-be-fonts]') as HTMLElement | null; if (!list) return;
    fontFamilies = await listUserFonts(fontsHost).catch(() => []);
    monoFamily = await monoFontFamily(fontsHost).catch(() => '');
    const rows: string[] = [];
    if (!fontFamilies.some(f => f.primary)) {
      const builtin = await primaryFontFamily(fontsHost).catch(() => '');
      rows.push(`<li class="be-font-row is-primary is-builtin"><span class="be-font-aa" style="font-family:'${escape(builtin || 'Outfit')}'" aria-hidden="true">Aa</span>
        <span class="be-font-meta"><span class="be-font-name">${escape(builtin || 'Outfit')}</span><span class="be-font-sub">${builtin ? 'built-in brand font' : 'platform default'}</span></span>
        <span class="be-font-badge">Primary</span></li>`);
    }
    rows.push(...fontFamilies.map(fontRow));
    if (!fontFamilies.length) rows.push('<li class="be-font-empty">No fonts added yet — pick any Google Font below.</li>');
    if (root.isConnected) list.innerHTML = rows.join('');
    void paintSpecimen();
  };
  void paintFonts();
  $('[data-be-font-add]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('[data-be-font-input]') as HTMLInputElement | null;
    const btn = $('[data-be-font-btn]') as HTMLButtonElement | null;
    const family = input?.value.trim(); if (!family || !btn || !input) return;
    showFontErr(''); const prev = btn.textContent;
    btn.disabled = input.disabled = true; btn.textContent = 'Downloading…';
    try { const fam = await installGoogleFont(fontsHost, family); input.value = ''; playSfx('saveProfile'); await paintFonts(); notify('type'); announce(`Added ${fam.family}${fam.primary ? ' as your primary font' : ''}`); }
    // Clear on failure too — otherwise the failed attempt's text blocks searching
    // for a different font until manually cleared (matches the success path above).
    catch (err) { showFontErr(String((err as { message?: unknown })?.message ?? err)); input.value = ''; }
    btn.textContent = prev; btn.disabled = input.disabled = false; input.focus();
  });
  $('[data-be-fonts]')?.addEventListener('click', async (e) => {
    const mp = (e.target as Element).closest<HTMLButtonElement>('[data-mp]');
    if (mp) { mp.disabled = true; try { await setPrimaryFont(fontsHost, mp.dataset.mp!); await paintFonts(); notify('type'); announce(`${mp.dataset.mp} is now your primary font`); } catch (err) { mp.disabled = false; showFontErr(String((err as { message?: unknown })?.message ?? err)); } return; }
    const mono = (e.target as Element).closest<HTMLButtonElement>('[data-mono]');
    if (mono) { mono.disabled = true; try { await setMonoFont(fontsHost, mono.dataset.mono!); await paintFonts(); notify('type'); announce(`${mono.dataset.mono} now serves code & data`); } catch (err) { mono.disabled = false; showFontErr(String((err as { message?: unknown })?.message ?? err)); } return; }
    const del = (e.target as Element).closest<HTMLButtonElement>('[data-del]'); if (!del) return;
    const fam = fontFamilies.find(f => f.family === del.dataset.del); if (!fam) return;
    const ok = await confirmDialog({ title: `Remove ${fam.family}?`, message: `Its font files (${fmtBytes(fam.bytes)}) are deleted from this device${fam.primary ? ' and the next font becomes primary' : ''}.`, confirmLabel: 'Remove' });
    if (!ok) return; del.disabled = true;
    try {
      await removeUserFont(fontsHost, fam);
      if (fam.family === monoFamily) await setMonoFont(fontsHost, null).catch(() => {}); // a removed face can't keep a role
      await paintFonts(); notify('type');
    } catch (err) { del.disabled = false; showFontErr(String((err as { message?: unknown })?.message ?? err)); }
  });

  // ── Logos (the Logos tab) ────────────────────────────────────────────────────
  // Identity sections (a brand can carry several distinct logos), each holding
  // the canonical orientation × treatment matrix plus user-named custom marks
  // ("icon", "crest", …). Each slot is a drop/upload tile: empty → "Add",
  // filled → the mark on a chip themed to its treatment (reverse on dark, mono
  // on neutral) with a Replace/Remove pair. Stored as user assets via
  // brand-logos.ts; every slot optional.
  const logoErr = $('[data-be-logo-err]') as HTMLElement | null;
  const showLogoErr = (m: string): void => { if (logoErr) { logoErr.textContent = m; logoErr.hidden = !m; } if (m) announce(m, { assertive: true }); };
  let logoUrls: string[] = []; // object URLs to revoke on repaint/teardown
  // Identities the user added this session that hold no assets yet — an identity
  // only truly exists through its assets, so empty sections live here until the
  // first mark lands (and vanish on reload if none ever does; that's honest).
  const pendingIdentities: string[] = [];
  const identityLabel = (id: string): string => (id === 'default' ? 'Your logo' : prettify(id));
  const logoTile = (v: string, identity: string, slot: LogoSlot | undefined, label?: string): string => {
    const { treatment } = splitVariant(v);
    const tm = treatment ? TREATMENT_META[treatment] : null;
    const name = label ?? slot?.label ?? (tm ? tm.label : prettify(v));
    const hint = slot ? 'Click to replace' : (tm ? tm.hint : 'Your own named mark.');
    const body = slot
      ? `<span class="be-logo-art"><img src="${escape(slot.url)}" alt="${escape(name)} logo" loading="lazy"></span>`
      : `<span class="be-logo-empty" aria-hidden="true">+</span>`;
    return `<div class="be-logo-slot${slot ? ' is-filled' : ''}" data-be-logo="${escape(v)}" data-treatment="${treatment ?? 'custom'}">
        <div class="be-logo-slot-head"><span class="be-logo-slot-name">${escape(name)}</span>
          ${slot ? `<button type="button" class="be-logo-del" data-logo-del="${escape(v)}" data-identity="${escape(identity)}" aria-label="Remove the ${escape(name)} mark">&#x2715;</button>` : ''}</div>
        <label class="be-logo-drop">
          ${body}
          <input type="file" class="be-logo-file" data-logo-file="${escape(v)}" data-identity="${escape(identity)}" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden>
        </label>
        <p class="be-logo-hint">${escape(hint)}</p>
      </div>`;
  };
  const paintLogos = async (): Promise<void> => {
    const mount = $('[data-be-logos]') as HTMLElement | null; if (!mount) return;
    logoUrls.forEach(u => URL.revokeObjectURL(u)); logoUrls = [];
    const slots = await listLogos(fontsHost).catch(() => [] as LogoSlot[]);
    logoUrls = slots.map(s => s.url);
    // default leads, then stored identities in first-seen order, then this
    // session's still-empty additions.
    const identities: string[] = ['default'];
    for (const s of slots) if (!identities.includes(s.identity)) identities.push(s.identity);
    for (const p of pendingIdentities) if (!identities.includes(p)) identities.push(p);
    const sections = identities.map(identity => {
      const mine = slots.filter(s => s.identity === identity);
      const byVariant = new Map(mine.map(s => [s.variant, s]));
      const groups = LOGO_ORIENTATIONS.map(o => {
        const om = ORIENTATION_META[o];
        const tiles = LOGO_TREATMENTS.map(t => {
          const v = `${o}-${t}` as LogoVariant;
          return logoTile(v, identity, byVariant.get(v));
        }).join('');
        return `<div class="be-logo-group">
            <div class="be-logo-group-head"><span class="be-logo-group-name">${escape(om.label)}</span>
              <span class="be-logo-group-hint">${escape(om.hint)}</span></div>
            <div class="be-logo-row">${tiles}</div>
          </div>`;
      }).join('');
      const customs = mine.filter(s => s.custom);
      const customTiles = customs.map(s => logoTile(s.variant, identity, s)).join('');
      const customGroup = `<div class="be-logo-group be-logo-group--custom">
          <div class="be-logo-group-head"><span class="be-logo-group-name">Custom marks</span>
            <span class="be-logo-group-hint">Marks your brand names its own way — an icon, a crest, a favicon.</span></div>
          <div class="be-logo-row">${customTiles}
            <form class="be-logo-addmark" data-logo-addmark data-identity="${escape(identity)}">
              <input type="text" class="be-logo-addmark-name" data-addmark-name placeholder="Name it — Icon, Crest…" autocomplete="off" spellcheck="false" aria-label="Custom mark name">
              <label class="be-btn be-logo-addmark-pick">Choose file…
                <input type="file" data-addmark-file accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden></label>
            </form>
          </div>
        </div>`;
      return `<section class="be-logo-identity" data-identity="${escape(identity)}">
          ${identities.length > 1 || identity !== 'default' ? `<div class="be-logo-identity-head"><h4 class="be-logo-identity-name">${escape(identityLabel(identity))}</h4></div>` : ''}
          ${groups}${customGroup}
        </section>`;
    }).join('');
    const addIdentity = `<form class="be-logo-addidentity" data-logo-addidentity>
        <input type="text" data-addidentity-name placeholder="Another logo? Name it — Product, Event…" autocomplete="off" spellcheck="false" aria-label="New logo name">
        <button type="submit" class="be-btn">+ Add another logo</button>
      </form>`;
    if (root.isConnected) mount.innerHTML = sections + addIdentity;
  };
  void paintLogos();
  cleanups.push(() => logoUrls.forEach(u => URL.revokeObjectURL(u)));

  /** A slug brand-logos accepts, from whatever the user typed. */
  const slugify = (name: string): string =>
    name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  // The logo-colour pathway: an SVG mark carries the brand's real colours, so
  // offer (or on a still-unbranded install, simply apply) its first colour as
  // the primary — the Colour tab picks it up from here.
  const suggestEl = $('[data-be-suggest]') as HTMLElement | null;
  const suggestFromLogo = async (file: File): Promise<void> => {
    if (!/svg/i.test(file.type) || file.size > 10 * 1024 * 1024) return;
    let colors: string[] = [];
    try { colors = extractSvgColors(await file.text()).map(c => colorToHex(c) ?? '').filter(c => /^#/.test(c)); } catch { return; }
    const first = colors[0];
    if (!first || !suggestEl) return;
    if (!isUserBrand) {
      // Nothing of the user's to clobber yet — set it, say so, let Save keep it.
      setPrimaryTo(first);
      suggestEl.innerHTML = `<span class="be-suggest-note"><span class="be-suggest-sw" style="--sw:${escape(first)}" aria-hidden="true"></span>Primary set from your logo — <strong>Save colour</strong> keeps it.</span>`;
      suggestEl.hidden = false;
      announce('Primary colour set from your logo');
      return;
    }
    suggestEl.innerHTML = `
      <span class="be-suggest-note"><span class="be-suggest-sw" style="--sw:${escape(first)}" aria-hidden="true"></span>Found in your logo: <code>${escape(first)}</code></span>
      <button type="button" class="be-btn be-btn--sm" data-be-suggest-use="${escape(first)}">Use as primary</button>
      <button type="button" class="be-suggest-dismiss" data-be-suggest-dismiss aria-label="Dismiss suggestion">&#x2715;</button>`;
    suggestEl.hidden = false;
  };
  suggestEl?.addEventListener('click', (e) => {
    const use = (e.target as HTMLElement).closest<HTMLElement>('[data-be-suggest-use]');
    if (use) { setPrimaryTo(use.dataset.beSuggestUse!); suggestEl.hidden = true; playSfx('click'); return; }
    if ((e.target as HTMLElement).closest('[data-be-suggest-dismiss]')) suggestEl.hidden = true;
  });

  $('[data-be-logos]')?.addEventListener('change', async (e) => {
    const target = e.target as HTMLElement;
    // A custom-mark file pick: needs the name typed beside it.
    const addFile = target.closest<HTMLInputElement>('[data-addmark-file]');
    if (addFile) {
      const form = addFile.closest<HTMLElement>('[data-logo-addmark]');
      const nameInput = form?.querySelector<HTMLInputElement>('[data-addmark-name]');
      const identity = form?.dataset.identity || 'default';
      const label = nameInput?.value.trim() ?? '';
      const slug = slugify(label);
      const file = addFile.files?.[0]; addFile.value = '';
      if (!file) return;
      showLogoErr('');
      if (!slug || !LOGO_SLUG_RE.test(slug)) { showLogoErr('Name the mark first — letters and numbers, e.g. "Icon".'); nameInput?.focus(); return; }
      try {
        await installLogo(fontsHost, slug, file, { identity, label });
        playSfx('saveProfile'); await paintLogos(); notify('logos');
        void suggestFromLogo(file);
        announce(`${label} mark added`);
      } catch (err) { showLogoErr(String((err as { message?: unknown })?.message ?? err)); }
      return;
    }
    const input = target.closest<HTMLInputElement>('[data-logo-file]'); if (!input) return;
    const variant = input.dataset.logoFile!;
    const identity = input.dataset.identity || 'default';
    const file = input.files?.[0]; input.value = ''; if (!file) return;
    showLogoErr('');
    try {
      await installLogo(fontsHost, variant, file, identity === 'default' ? undefined : { identity });
      playSfx('saveProfile'); await paintLogos(); notify('logos');
      void suggestFromLogo(file);
      announce(`${variantLabel(variant)} logo added`);
    } catch (err) { showLogoErr(String((err as { message?: unknown })?.message ?? err)); }
  });
  $('[data-be-logos]')?.addEventListener('submit', (e) => {
    // The custom-mark form has no submit button (its "action" is the file
    // picker), but Enter in its name field still implicitly submits — swallow
    // that and forward the intent to the picker instead of reloading the page.
    const addmark = (e.target as HTMLElement).closest<HTMLElement>('[data-logo-addmark]');
    if (addmark) {
      e.preventDefault();
      addmark.querySelector<HTMLInputElement>('[data-addmark-file]')?.click();
      return;
    }
    const form = (e.target as HTMLElement).closest<HTMLElement>('[data-logo-addidentity]');
    if (!form) return;
    e.preventDefault();
    const nameInput = form.querySelector<HTMLInputElement>('[data-addidentity-name]');
    const slug = slugify(nameInput?.value ?? '');
    showLogoErr('');
    if (!slug || !LOGO_SLUG_RE.test(slug)) { showLogoErr('Name the logo first — letters and numbers, e.g. "Product".'); nameInput?.focus(); return; }
    if (slug === 'default') { showLogoErr('“Default” is the unnamed logo above — pick a different name.'); nameInput?.focus(); return; }
    if (!pendingIdentities.includes(slug)) pendingIdentities.push(slug);
    void paintLogos().then(() => {
      // Land the user in the fresh section rather than leaving them at the form.
      root.querySelector(`[data-be-logos] .be-logo-identity[data-identity="${slug}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });
  $('[data-be-logos]')?.addEventListener('click', async (e) => {
    const del = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-logo-del]'); if (!del) return;
    e.preventDefault();
    const variant = del.dataset.logoDel!;
    const identity = del.dataset.identity || 'default';
    const ok = await confirmDialog({ title: `Remove the ${variantLabel(variant).toLowerCase()} mark?`, message: 'It’s deleted from this device.', confirmLabel: 'Remove' });
    if (!ok) return; del.disabled = true;
    try {
      await removeLogo(fontsHost, variant, identity === 'default' ? undefined : identity);
      await paintLogos(); notify('logos');
    } catch (err) { del.disabled = false; showLogoErr(String((err as { message?: unknown })?.message ?? err)); }
  });

  // ── Palette download ─────────────────────────────────────────────────────
  const palErr = $('[data-be-pal-err]') as HTMLElement | null;
  const palFmtSel = $('[data-be-pal-fmt]') as HTMLSelectElement | null;
  $('[data-be-pal-download]')?.addEventListener('click', () => {
    if (palErr) palErr.hidden = true;
    try {
      const format = (palFmtSel?.value ?? 'tokens-json') as SwatchExportFormat;
      const { blob, filename } = exportSwatches(swatches, format);
      saveBlob(blob, filename);
      announce(`Palette downloaded as ${filename}`);
    } catch (err) {
      if (palErr) { palErr.textContent = String((err as { message?: unknown })?.message ?? err); palErr.hidden = false; }
    }
  });

  // ── Corner radius (the Tokens tab) ───────────────────────────────────────
  // Live app-wide preview on every drag tick (set --radius directly — instant,
  // no round trip), persisted debounced so a drag doesn't spam writes.
  const radiusSlider = $('[data-be-radius-slider]') as HTMLInputElement | null;
  const radiusPreview = $('[data-be-radius-preview]') as HTMLElement | null;
  const radiusValueEl = $('[data-be-radius-value]') as HTMLElement | null;
  const radiusErr = $('[data-be-radius-err]') as HTMLElement | null;
  void (async () => {
    // Seed from the installed brand's --radius, else the shell default (1rem).
    // parseFloat tolerates a stored px/em value from a hand-authored import;
    // the slider always writes back in rem.
    const current = await (tokens as { resolve?(ref: string): Promise<unknown> } | undefined)
      ?.resolve?.('{shape.radius}').then(v => brandRadiusValue(v)).catch(() => null) ?? null;
    const rem = current ? parseFloat(current) : 1;
    if (radiusSlider) radiusSlider.value = String(rem);
    if (radiusPreview) radiusPreview.style.borderRadius = `${rem}rem`;
    if (radiusValueEl) radiusValueEl.textContent = `${rem}rem`;
  })();
  let radiusDebounce: ReturnType<typeof setTimeout> | undefined;
  let radiusPending: string | null = null; // flushed on teardown — a drag right before leaving must still land
  radiusSlider?.addEventListener('input', () => {
    const css = `${radiusSlider.value}rem`;
    if (radiusPreview) radiusPreview.style.borderRadius = css;
    if (radiusValueEl) radiusValueEl.textContent = css;
    document.documentElement.style.setProperty('--radius', css);
    notify('tokens');
    radiusPending = css;
    clearTimeout(radiusDebounce);
    radiusDebounce = setTimeout(() => {
      radiusPending = null;
      setBrandRadius(fontsHost, css).catch(err => {
        if (radiusErr) { radiusErr.textContent = String((err as { message?: unknown })?.message ?? err); radiusErr.hidden = false; }
      });
    }, 400);
  });
  cleanups.push(() => {
    clearTimeout(radiusDebounce);
    if (radiusPending) void setBrandRadius(fontsHost, radiusPending).catch(() => {});
  });

  // ── The three studio panels that live outside this file ──────────────────
  // Token editors, gradients and catalogue uploads (brand-studio-tabs.ts) —
  // each gets the same narrow context: the live doc (getter — the Colour tab
  // reassigns it on re-derive/import), the persist funnel, and its tab's notify.
  const studioCtx = {
    host,
    doc: () => doc as Record<string, unknown>,
    persist: (immediate?: boolean) => persist(immediate),
  };
  const tokensMount = $('[data-be-tokens-mount]') as HTMLElement | null;
  const tokensPanel = tokensMount ? mountTokensPanel(tokensMount, { ...studioCtx, notify: () => notify('tokens') }) : null;
  const gradsMount = $('[data-be-grads-mount]') as HTMLElement | null;
  const gradsPanel = gradsMount ? mountGradientsPanel(gradsMount, { ...studioCtx, notify: () => notify('color'), primaryHex, paletteHexes }) : null;
  const catMount = $('[data-be-cat-mount]') as HTMLElement | null;
  const catPanel = catMount ? mountCataloguePanel(catMount, { host, notify: () => notify('catalogue') }) : null;
  cleanups.push(() => { tokensPanel?.teardown(); gradsPanel?.teardown(); catPanel?.teardown(); });
  // Token/gradient groups ride the same doc the palette walks, so a re-derive
  // or pack import must repaint them too.
  paletteHooks.push(() => { tokensPanel?.render(); gradsPanel?.render(); });

  // ── Share (brand pack in/out) — exposed on the handle; the host view owns
  //    the buttons' placement (its persistent Import/Export action row).
  const exportPack = async (): Promise<{ filename: string }> => {
    const { blob, filename, summary } = await exportBrandPack(transferHost);
    saveBlob(blob, filename);
    announce(`Brand exported — ${summary.fontFamilies} font ${summary.fontFamilies === 1 ? 'family' : 'families'}`);
    return { filename };
  };
  // Something replaced the installed tokens underneath us (a pack import, the
  // host view's own JSON/SVG install path) — reload the doc and repaint every
  // panel so the studio shows what's actually installed. The Colour panel's
  // derive CONTROLS re-seed too (primary, shade count, ramp anchors, the
  // preview): they were captured from the pre-import doc at mount, and leaving
  // them stale would make "Use this colour" silently derive from the old brand.
  const reload = async (): Promise<void> => {
    tokens?.bust?.();
    doc = ((await tokens?.raw().catch(() => null)) as Record<string, unknown> | null) ?? doc;
    isUserBrand = true; // every reload() caller just installed on the user's behalf
    try {
      const set = createTokenSet(doc, { theme: 'light' });
      primary = tokenValueToHex(set.resolve('color.semantic.primary')) ?? primary;
      const g = set.query({ type: 'color' }).filter(t => /^color\.ramp\.primary\.\d+$/.test(t.path));
      if (g.length >= RAMP_STEPS_MIN) steps = Math.min(RAMP_STEPS_MAX, g.length);
      neutralStep = anchorStep(steps); secondaryStep = anchorStep(steps);
    } catch { /* tokenless/malformed doc — keep the previous seeds */ }
    if (stepsSlider) stepsSlider.value = String(steps);
    if (stepsVal) stepsVal.textContent = String(steps);
    const wrap = $('[data-be-primary-field]') as HTMLElement | null;
    if (wrap) {
      wrap.innerHTML = colorFieldHtml('be-primary', primary, { inline: true, modes: true });
      wireColorField(wrap, { onChange: onPrimaryFieldChange });
    }
    // Refresh the decorative ramp preview WITHOUT applyDraftChrome/broadcast —
    // the imported doc's real accents just landed via applyChromeBrandVars, and
    // a derive draft would immediately paint over them.
    const fresh = deriveSafe({ primary, scheme, surface, contrast, steps, foreground });
    if (preview && fresh) preview.innerHTML = previewHtml(fresh, { neutral: neutralStep, secondary: secondaryStep, steps });
    renderScreen();
    primaryLock?.render();
    renderGenerator();
    setDeriveActive(false);
    repaintPalette(); await paintFonts(); await paintLogos(); void applyChromeBrandVars(host); setDirty(false);
  };
  const importPack = async (file: File): Promise<void> => {
    await importBrandPack(transferHost, await file.arrayBuffer());
    await reload();
    announce('Brand loaded');
  };

  return {
    teardown: () => {
      clearTimeout(saveTimer); cleanups.forEach(fn => fn());
      // A live-previewed but unsaved colour draft must not outlive the editor —
      // restore the chrome accent from whatever's actually installed (unless
      // the caller already committed it via saveDraft() first).
      void applyChromeBrandVars(host);
    },
    saveDraft: () => { if (saveBtn && !saveBtn.hidden) persist(true); },
    isDirty: () => !!saveBtn && !saveBtn.hidden,
    exportPack,
    importPack,
    reload,
    closeOverlays: closeEditor,
  };
}
