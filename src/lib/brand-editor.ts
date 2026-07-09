// SPDX-License-Identifier: MPL-2.0
/**
 * Brand editor — the interactive brand-configuration surface embedded in the
 * Dashboard's "Your brand" section (mountBrandEditor). It is the "adjust"
 * counterpart to the first-run #/start wizard: colour, palette AND fonts are set
 * here, in place, instead of bouncing to the wizard (colours) or Profile (fonts).
 *
 * Four panels, all persisting to the one `user/tokens/brand` install via the
 * bridge's single write chokepoint (installUserTokens → bust → the next
 * get()/colors()/resolve() re-reads) — except Colour, which is DRAFT-until-saved
 * (see below):
 *
 *  1. Fonts — the Google-Fonts manager (user-fonts.ts), the same primitives
 *     Profile uses, so a font added here is a font added everywhere.
 *  2. Colour — the derive controls (primary + scheme / surface / contrast) with a
 *     live ramp + specimen preview (the engine's deriveBrandTokens, same as the
 *     wizard), plus a selectable step in the neutral/secondary ramps. Every change
 *     here — the primary picker, a ramp-step pick — live-applies the chrome accent
 *     (--primary/--primary-foreground/--ring, brand-vars.ts) app-wide WITHOUT
 *     installing anything. "Use this colour" re-derives the palette into the
 *     in-memory doc (still just a draft); a separate "Save colour" action is the
 *     only thing in this panel that actually persists.
 *  3. Palette — every colour the brand carries as an editable tile: recolour any
 *     swatch, rename it, delete the ones you added, and add your own. Edits are
 *     overrides written straight onto the doc (installed, or the Colour panel's
 *     unsaved draft), so they survive until you re-derive. Ramp + role swatches
 *     are structural (recolour/rename only); spectrum + custom swatches are
 *     add/delete too. These edits persist immediately, same as ever.
 *  4. Share — export/import a brand pack.
 *
 * A LOCKED build (host.tokens.isLocked()) exposes none of this — the caller
 * renders a read-only note instead. Everything is best-effort and DOM-guarded:
 * a detached editor (route changed mid-op) never writes to a dead node.
 */

import { deriveBrandTokens, createTokenSet, colorToHex, contrastRatio } from '@lolly/engine';
import type { BrandDeriveOptions } from '@lolly/engine';
import type { HostV1, TokenSet } from '../../../../engine/src/bridge/host-v1.ts';
import type { WebTokensAPI } from '../bridge/tokens.ts';
import { installUserTokens } from '../bridge/tokens.ts';
import {
  isRec, walkSwatches, setSwatchValue, setSwatchName, deleteSwatch, addSwatch, setSemanticRampAlias,
} from './brand-doc.ts';
import type { BrandSwatch } from './brand-doc.ts';
import { applyChromeBrandVars, applyChromeAccent, tokenValueToHex } from '../brand-vars.ts';
import { colorFieldHtml, wireColorField, setSwatches } from '../components/color-field.ts';
import { COLOR_FORMATS, formatColor, parseColor } from './color-formats.ts';
import type { ColorFormat } from './color-formats.ts';
import {
  renderBrandWheel, wireBrandWheel, updateWheelDot, oklchToStored, oklchHex,
} from './palette-wheel.ts';
import type { WheelDot } from './palette-wheel.ts';
import type { PaletteEntry } from '../palette.ts';
import {
  listUserFonts, installGoogleFont, setPrimaryFont, removeUserFont, primaryFontFamily,
} from '../user-fonts.ts';
import type { UserFontsHost, UserFontFamily } from '../user-fonts.ts';
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

const SCHEMES: ReadonlyArray<{ id: Scheme; label: string }> = [
  { id: 'mono', label: 'Mono' }, { id: 'complement', label: 'Complement' },
  { id: 'analogous', label: 'Analogous' }, { id: 'triad', label: 'Triad' },
];
const SURFACES: ReadonlyArray<{ id: Surface; label: string }> = [
  { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'primary', label: 'Deep primary' },
];
const CONTRASTS: ReadonlyArray<{ id: Contrast; label: string }> = [
  { id: 'comfort', label: 'Comfort' }, { id: 'high', label: 'High' },
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
function rampRow(set: TokenSet, ramp: string, label: string, selected?: number): string {
  let cells = '';
  for (let i = 1; i <= 9; i++) {
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
function previewHtml(doc: Record<string, unknown>, sel: { neutral: number; secondary: number }): string {
  const light = createTokenSet(doc, { theme: 'light' });
  const dark = createTokenSet(doc, { theme: 'dark' });
  return `
    <div class="be-ramps">${rampRow(light, 'primary', 'Primary')}${rampRow(light, 'neutral', 'Neutral', sel.neutral)}${rampRow(light, 'secondary', 'Secondary', sel.secondary)}</div>
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

// ── Swatch tile + palette grid ────────────────────────────────────────────────

function tileHtml(s: BrandSwatch, idx: number): string {
  const trans = !s.hex;
  return `
    <button type="button" class="be-swatch${trans ? ' is-empty' : ''}" data-be-tile="${idx}"
      style="--sw:${escape(s.hex || 'transparent')}"
      aria-label="${escape(`${s.name} — ${s.hex || 'unset'}`)}">
      <span class="be-swatch-chip" aria-hidden="true"></span>
      <span class="be-swatch-meta">
        <span class="be-swatch-name">${escape(s.name)}</span>
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
 * Render the brand editor into `root` and wire it. Returns a teardown that stops
 * the (font/preview) listeners. Locked builds render a read-only note and no-op.
 */
export async function mountBrandEditor(root: HTMLElement, host: EditorHost): Promise<() => void> {
  const tokens = host.tokens as unknown as WebTokensAPI | undefined;
  const fontsHost = host as unknown as UserFontsHost;
  const transferHost = { host: host as unknown as BrandTransferHost, storage: localStorage };

  let locked = false;
  try { locked = !!(await tokens?.isLocked?.()); } catch { /* treat as unlocked */ }
  if (locked) {
    root.innerHTML = `<p class="be-locked">This build ships with a fixed brand — its colours, fonts and tokens are what the whole app, your tools and every export wear. Brand editing is turned off here.</p>`;
    return () => {};
  }

  // The document we edit: the installed brand if any, else a fresh derive from
  // the default primary so the palette is never empty on an unbranded install.
  let doc = (await tokens?.raw().catch(() => null)) as Record<string, unknown> | null;
  const installedDoc = isRec(doc) ? doc : null; // stable snapshot for seeding, below — never reassigned
  if (!isRec(doc)) doc = deriveBrandTokens({ primary: DEFAULT_PRIMARY, name: 'My brand' }) as Record<string, unknown>;

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
  // The neutral/secondary ramp-step picks in the Colour preview below — both
  // default to the engine's own anchor step (5) so behaviour is unchanged
  // until the user actively picks a different one (see setSemanticRampAlias).
  let neutralStep = DEFAULT_RAMP_STEP, secondaryStep = DEFAULT_RAMP_STEP;
  const currentTheme = document.documentElement.dataset.theme || 'light';

  const initialDraft = deriveSafe({ primary, scheme, surface, contrast });

  root.innerHTML = `
    <div class="be" data-brand-editor>
      <div class="be-panel be-fonts">
        <div class="be-panel-head"><h3 class="be-panel-title">Fonts</h3>
          <p class="be-panel-sub">Add any <strong>Google Font</strong> — it downloads to this device and renders in the app, your tools and every export. One is always the <strong>primary</strong>.</p></div>
        <ul class="be-font-list" data-be-fonts role="list"></ul>
        <form class="be-font-add" data-be-font-add>
          <input type="text" data-be-font-input list="be-google-fonts" placeholder="Search Google Fonts — Inter, Fraunces, Space Grotesk…" autocomplete="off" autocapitalize="words" spellcheck="false" aria-label="Google Fonts family">
          <datalist id="be-google-fonts">${POPULAR_FAMILIES.map(f => `<option value="${escape(f)}"></option>`).join('')}</datalist>
          <button type="submit" class="be-btn" data-be-font-btn>Add font</button>
        </form>
        <p class="be-err" data-be-font-err hidden></p>
      </div>

      <div class="be-panel be-colour">
        <div class="be-panel-head"><h3 class="be-panel-title">Colour</h3>
          <p class="be-panel-sub">Pick one colour — Lolly derives the ramps, both themes and every role; click a step in the Neutral or Secondary ramp to choose that shade instead of the default. Changes here preview live across the whole app. "Use this colour" re-derives the palette below — <strong>Save colour</strong> is what actually keeps it.</p></div>
        <div class="be-derive">
          <div class="be-colorpick">
            <span class="be-field-label">Primary colour</span>
            ${colorFieldHtml('be-primary', primary, { inline: true })}
          </div>
          <div class="be-derive-controls">
            <label class="be-field"><span class="be-field-label">Scheme</span>${segHtml('scheme', SCHEMES, scheme, 'Colour scheme')}</label>
            <label class="be-field"><span class="be-field-label">Surface</span>${segHtml('surface', SURFACES, surface, 'Default surface')}</label>
            <label class="be-field"><span class="be-field-label">Contrast</span>${segHtml('contrast', CONTRASTS, contrast, 'Contrast target')}</label>
            <button type="button" class="be-cta" data-be-derive>Use this colour</button>
            <button type="button" class="be-cta" data-be-save hidden>Save colour</button>
          </div>
          <div class="be-preview" data-be-preview>${initialDraft ? previewHtml(initialDraft, { neutral: neutralStep, secondary: secondaryStep }) : ''}</div>
        </div>
      </div>

      <div class="be-panel be-palette">
        <div class="be-panel-head"><h3 class="be-panel-title">Palette</h3>
          <p class="be-panel-sub">Every colour your brand carries — as a list, or on the wheel (angle = hue, distance out = chroma). Click a swatch to recolour or rename it, drag a dot to recolour it, click empty space on the wheel to add one. Changes flow to every picker, tool and export.</p></div>
        <div class="be-pal-split">
          <div class="be-pal-wheel" data-be-wheel-mount></div>
          <div class="be-pal" data-be-pal></div>
        </div>
      </div>

      <div class="be-panel be-share">
        <div class="be-panel-head"><h3 class="be-panel-title">Share</h3>
          <p class="be-panel-sub">One file with your tokens, fonts and theme — send it to anyone and their Lolly wears your brand.</p></div>
        <div class="be-share-row">
          <button type="button" class="be-btn" data-be-export data-sfx="whoosh">Export brand file</button>
          <button type="button" class="be-btn" data-be-import>Load a brand file…</button>
          <input type="file" data-be-import-file accept=".zip,application/zip" hidden>
        </div>
        <p class="be-err" data-be-share-err hidden></p>
      </div>

      <!-- Swatch editor popover (shared; positioned under the clicked tile) -->
      <div class="be-editor" data-be-editor hidden>
        <div class="be-editor-card" role="dialog" aria-label="Edit swatch">
          <div class="be-editor-field"><span class="be-field-label">Colour</span><div data-be-editor-color></div></div>
          <div class="be-editor-field be-fmt">
            <span class="be-field-label">Set by value</span>
            <div class="be-fmt-row">
              <select class="be-fmt-sel" data-be-fmt-sel aria-label="Colour space">
                ${COLOR_FORMATS.map(f => `<option value="${f.id}">${escape(f.label)}</option>`).join('')}
              </select>
              <input type="text" class="be-fmt-input" data-be-fmt-input autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Colour value">
            </div>
            <code class="be-fmt-out" data-be-fmt-out aria-live="polite"></code>
          </div>
          <label class="be-editor-field"><span class="be-field-label">Name</span>
            <input type="text" class="be-editor-name" data-be-editor-name autocomplete="off"></label>
          <div class="be-editor-actions">
            <button type="button" class="be-editor-del" data-be-editor-del hidden>Delete</button>
            <button type="button" class="be-btn be-editor-done" data-be-editor-done>Done</button>
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
  };

  // The Save-colour dirty flag — declared ahead of persist() below, which
  // clears it: Palette edits and the Colour draft share the one `doc`, so a
  // persist() triggered from the Palette panel writes a pending Colour draft
  // too, and the button must stop claiming it's unsaved once that happens.
  const saveBtn = $('[data-be-save]') as HTMLButtonElement | null;
  const setDirty = (v: boolean): void => { if (saveBtn) saveBtn.hidden = !v; };

  /**
   * Push the edited doc to the install (debounced) + refresh chrome & pickers.
   * Also clears the Save-colour dirty flag — see setDirty above.
   */
  const persist = (immediate = false): void => {
    clearTimeout(saveTimer);
    setDirty(false);
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
    const next = deriveSafe({ primary, scheme, surface, contrast });
    if (!next) return; // a half-typed hex mid-edit — keep the last good preview
    if (preview) preview.innerHTML = previewHtml(next, { neutral: neutralStep, secondary: secondaryStep });
    applyDraftChrome(next);
    broadcastDraft(next);
  };
  wireColorField(root, {
    onChange: (id, value) => {
      if (id !== 'be-primary') return;
      const raw = typeof value === 'string' ? value : value.value;
      if (!raw || raw === 'transparent') return;
      primary = /^#[0-9a-fA-F]{8}$/.test(raw) ? raw.slice(0, 7) : raw;
      renderPreview();
    },
  });
  root.querySelectorAll<HTMLElement>('[data-be-seg]').forEach(seg => {
    const on = (e: Event): void => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-val]'); if (!btn) return;
      const name = seg.dataset.beSeg;
      if (name === 'scheme') scheme = btn.dataset.val as Scheme;
      else if (name === 'surface') surface = btn.dataset.val as Surface;
      else if (name === 'contrast') contrast = btn.dataset.val as Contrast;
      seg.querySelectorAll<HTMLElement>('[data-val]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      renderPreview();
    };
    seg.addEventListener('click', on);
  });
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
    try { next = deriveBrandTokens({ primary, scheme, surface, contrast, name: 'My brand' }) as Record<string, unknown>; }
    catch (err) { announce(`Couldn't derive from ${primary}: ${String((err as { message?: unknown })?.message ?? err)}`, { assertive: true }); return; }
    setSemanticRampAlias(next, 'secondary', secondaryStep);
    setSemanticRampAlias(next, 'neutral', neutralStep);
    const ok = swatches.some(s => s.kind === 'custom')
      ? await confirmDialog({ title: 'Re-derive the palette?', message: 'This rebuilds every swatch from your colour and drops the custom swatches you added.', confirmLabel: 'Re-derive' })
      : true;
    if (!ok || !root.isConnected) return;
    // Commits into the in-memory draft only — no persist() here; Save colour
    // (below) is the only thing in this panel that writes to storage.
    doc = next; repaintPalette(); applyDraftChrome(doc); broadcastDraft(doc); setDirty(true);
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
  // space and extrapolates the rest. Both funnel through applyEditedHex.
  const fmtSel = editorEl?.querySelector<HTMLSelectElement>('[data-be-fmt-sel]') ?? null;
  const fmtInput = editorEl?.querySelector<HTMLInputElement>('[data-be-fmt-input]') ?? null;
  const fmtOut = editorEl?.querySelector<HTMLElement>('[data-be-fmt-out]') ?? null;
  let editFmt: ColorFormat = 'hex'; // sticky across swatch selections

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
    mountEl.innerHTML = colorFieldHtml('be-edit-color', hex || '#888888', { block: true });
    wireColorField(mountEl, {
      onChange: (id, value) => {
        if (id !== 'be-edit-color') return;
        const raw = typeof value === 'string' ? value : value.value;
        applyEditedHex(raw); // field-driven → don't re-render the field under the user
      },
    });
  };
  /**
   * Apply a colour to the selected swatch from EITHER surface: normalise to a
   * solid hex (brand swatches are opaque — the same hex8→hex6 drop the field
   * already did), write it to the doc, repaint the tile + value row, and persist.
   * `rerenderField` re-seeds the visual field (used when the value row drove the
   * change, so the sliders catch up; NOT when the field itself did, mid-drag).
   */
  function applyEditedHex(rawHex: string, opts: { rerenderField?: boolean } = {}): void {
    const cur = selected >= 0 ? swatches[selected] : null; if (!cur) return;
    const hex = /^#[0-9a-fA-F]{8}$/.test(rawHex) ? rawHex.slice(0, 7) : rawHex;
    if (!hex || hex === 'transparent') return;
    setSwatchValue(doc, cur.path, hex);
    cur.hex = colorToHex(hex) ?? hex; cur.raw = hex;
    const tile = palMount?.querySelector<HTMLElement>(`[data-be-tile="${selected}"]`);
    if (tile) {
      tile.style.setProperty('--sw', cur.hex);
      tile.classList.remove('is-empty');
      const hx = tile.querySelector('.be-swatch-hex'); if (hx) hx.textContent = cur.hex;
    }
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
    if (fmtInput) fmtInput.value = formatColor(editFmt, s.hex);
    if (fmtOut) fmtOut.textContent = extrapolation(s.hex);
    nameInput.value = s.name;
    delBtn.hidden = !s.deletable;
    // Position the popover under the tile, clamped to the editor box.
    const r = tile.getBoundingClientRect(), pr = root.getBoundingClientRect();
    editorEl.style.left = `${Math.min(Math.max(8, r.left - pr.left), pr.width - 280)}px`;
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
    if (hex) applyEditedHex(hex, { rerenderField: true });
    else if (fmtOut) fmtOut.textContent = 'unrecognised value';
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
      // A neutral new swatch the user immediately recolours.
      const path = addSwatch(doc, group, group === 'spectrum' ? 'New hue' : 'New swatch', '#888888');
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
  editorEl?.querySelector('[data-be-editor-done]')?.addEventListener('click', closeEditor);
  // Esc / outside-click closes the swatch editor (the colour popover stops its own Esc).
  const onDocPointer = (e: PointerEvent): void => {
    if (editorEl && !editorEl.hidden && !editorEl.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-be-tile]')) closeEditor();
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && editorEl && !editorEl.hidden) { e.stopPropagation(); closeEditor(); } };
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
        const stored = oklchToStored(o), hex = oklchHex(o);
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

  // ── Fonts ───────────────────────────────────────────────────────────────────
  const fontErr = $('[data-be-font-err]') as HTMLElement | null;
  const showFontErr = (m: string): void => { if (fontErr) { fontErr.textContent = m; fontErr.hidden = !m; } if (m) announce(m, { assertive: true }); };
  let fontFamilies: UserFontFamily[] = [];
  const fontRow = (f: UserFontFamily): string => `
    <li class="be-font-row${f.primary ? ' is-primary' : ''}" data-font-family="${escape(f.family)}">
      <span class="be-font-aa" style="font-family:'${escape(f.family)}'" aria-hidden="true">Aa</span>
      <span class="be-font-meta"><span class="be-font-name" style="font-family:'${escape(f.family)}'">${escape(f.family)}</span>
        <span class="be-font-sub">${escape(f.weights)} · ${fmtBytes(f.bytes)}</span></span>
      ${f.primary ? '<span class="be-font-badge">Primary</span>'
        : `<button type="button" class="be-btn be-font-mp" data-mp="${escape(f.family)}">Make primary</button>`}
      <button type="button" class="be-font-del" data-del="${escape(f.family)}" aria-label="Remove ${escape(f.family)}">&#x2715;</button>
    </li>`;
  const paintFonts = async (): Promise<void> => {
    const list = $('[data-be-fonts]') as HTMLElement | null; if (!list) return;
    fontFamilies = await listUserFonts(fontsHost).catch(() => []);
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
  };
  void paintFonts();
  $('[data-be-font-add]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('[data-be-font-input]') as HTMLInputElement | null;
    const btn = $('[data-be-font-btn]') as HTMLButtonElement | null;
    const family = input?.value.trim(); if (!family || !btn || !input) return;
    showFontErr(''); const prev = btn.textContent;
    btn.disabled = input.disabled = true; btn.textContent = 'Downloading…';
    try { const fam = await installGoogleFont(fontsHost, family); input.value = ''; playSfx('saveProfile'); await paintFonts(); announce(`Added ${fam.family}${fam.primary ? ' as your primary font' : ''}`); }
    // Clear on failure too — otherwise the failed attempt's text blocks searching
    // for a different font until manually cleared (matches the success path above).
    catch (err) { showFontErr(String((err as { message?: unknown })?.message ?? err)); input.value = ''; }
    btn.textContent = prev; btn.disabled = input.disabled = false; input.focus();
  });
  $('[data-be-fonts]')?.addEventListener('click', async (e) => {
    const mp = (e.target as Element).closest<HTMLButtonElement>('[data-mp]');
    if (mp) { mp.disabled = true; try { await setPrimaryFont(fontsHost, mp.dataset.mp!); await paintFonts(); announce(`${mp.dataset.mp} is now your primary font`); } catch (err) { mp.disabled = false; showFontErr(String((err as { message?: unknown })?.message ?? err)); } return; }
    const del = (e.target as Element).closest<HTMLButtonElement>('[data-del]'); if (!del) return;
    const fam = fontFamilies.find(f => f.family === del.dataset.del); if (!fam) return;
    const ok = await confirmDialog({ title: `Remove ${fam.family}?`, message: `Its font files (${fmtBytes(fam.bytes)}) are deleted from this device${fam.primary ? ' and the next font becomes primary' : ''}.`, confirmLabel: 'Remove' });
    if (!ok) return; del.disabled = true;
    try { await removeUserFont(fontsHost, fam); await paintFonts(); } catch (err) { del.disabled = false; showFontErr(String((err as { message?: unknown })?.message ?? err)); }
  });

  // ── Share ─────────────────────────────────────────────────────────────────
  const shareErr = $('[data-be-share-err]') as HTMLElement | null;
  $('[data-be-export]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement; const prev = btn.textContent;
    btn.disabled = true; btn.textContent = 'Exporting…';
    try { const { blob, filename, summary } = await exportBrandPack(transferHost); saveBlob(blob, filename); btn.textContent = 'Exported'; announce(`Brand exported — ${summary.fontFamilies} font ${summary.fontFamilies === 1 ? 'family' : 'families'}`); }
    catch (err) { btn.textContent = 'Export failed'; if (shareErr) { shareErr.textContent = String((err as { message?: unknown })?.message ?? err); shareErr.hidden = false; } }
    setTimeout(() => { if (root.isConnected) { btn.textContent = prev; btn.disabled = false; } }, 1800);
  });
  const importFile = $('[data-be-import-file]') as HTMLInputElement | null;
  $('[data-be-import]')?.addEventListener('click', () => importFile?.click());
  importFile?.addEventListener('change', async () => {
    const file = importFile.files?.[0]; importFile.value = ''; if (!file) return;
    if (shareErr) shareErr.hidden = true;
    try {
      await importBrandPack(transferHost, await file.arrayBuffer());
      // The pack replaced tokens+fonts — reload the doc and repaint everything.
      tokens?.bust?.();
      doc = ((await tokens?.raw().catch(() => null)) as Record<string, unknown> | null) ?? doc;
      repaintPalette(); await paintFonts(); void applyChromeBrandVars(host); setDirty(false);
      announce('Brand loaded');
    } catch (err) { if (shareErr) { shareErr.textContent = String((err as { message?: unknown })?.message ?? err); shareErr.hidden = false; } }
  });

  return () => {
    clearTimeout(saveTimer); cleanups.forEach(fn => fn());
    // A live-previewed but unsaved colour draft must not outlive the editor —
    // restore the chrome accent from whatever's actually installed.
    void applyChromeBrandVars(host);
  };
}
