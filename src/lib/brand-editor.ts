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

import { deriveBrandTokens, createTokenSet, colorToHex, contrastRatio, RAMP_STEPS_MIN, RAMP_STEPS_MAX, SCHEME_KINDS, generateSchemeAccents } from '@lolly/engine';
import type { BrandDeriveOptions, SchemeKind } from '@lolly/engine';
import { nameColor } from './color-namer.ts';
import { palettePreviewSvgs } from './palette-preview.ts';
import type { HostV1, TokenSet } from '../../../../engine/src/bridge/host-v1.ts';
import type { WebTokensAPI } from '../bridge/tokens.ts';
import { installUserTokens, USER_TOKENS_ID } from '../bridge/tokens.ts';
import {
  isRec, walkSwatches, setSwatchValue, setSwatchName, deleteSwatch, addSwatch, setSemanticRampAlias,
  setSwatchPrintOverride, getSwatchPrintOverride, primaryAnchorPath,
} from './brand-doc.ts';
import type { BrandSwatch, PrintLock } from './brand-doc.ts';
import { applyChromeBrandVars, applyChromeAccent, tokenValueToHex } from '../brand-vars.ts';
import { colorFieldHtml, wireColorField, setSwatches, refreshSwatches } from '../components/color-field.ts';
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
import {
  LOGO_ORIENTATIONS, LOGO_TREATMENTS, ORIENTATION_META, TREATMENT_META,
  splitVariant, variantLabel, listLogos, installLogo, removeLogo,
} from './brand-logos.ts';
import type { LogoVariant, LogoSlot } from './brand-logos.ts';
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

// ── Shared print-lock control (Auto ↔ Locked·Process/Spot) ───────────────────
// One control, two mounts: the Colour panel's primary field and the Palette
// panel's swatch popover (see mountPrintLock's two call sites below). Auto
// converts the subject's screen colour to CMYK at export time; Locked pins
// either a plain process-CMYK anchor or a named spot colour (whose own CMYK
// equivalent reuses the same four inputs) — the two are mutually exclusive,
// enforced by brand-doc.ts's setSwatchPrintOverride.

/** The auto sRGB→CMYK conversion of a hex (C,M,Y,K 0–100) — the value Locked
 *  seeds from, and what Auto shows as the print readout. */
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
      <div class="be-subst-line">
        <span class="be-subst-key">Print</span>
        <code class="be-subst-val" data-be-lock-readout></code>
      </div>
      ${segHtml('lock-mode', [{ id: 'auto', label: 'Auto' }, { id: 'locked', label: 'Locked' }], 'auto', 'Print colour')}
      <div class="be-lock-body" data-be-lock-body hidden>
        ${segHtml('lock-kind', [{ id: 'cmyk', label: 'Process (CMYK)' }, { id: 'spot', label: 'Spot colour' }], 'cmyk', 'Lock type')}
        <div class="be-lock-spot" data-be-lock-spot hidden>
          <label class="be-lock-field"><span>Name</span><input type="text" data-be-lock-name placeholder="PANTONE 186 C" autocomplete="off" spellcheck="false"></label>
          <label class="be-lock-field"><span>Book <em>(optional)</em></span><input type="text" data-be-lock-book placeholder="PANTONE+ Solid Coated" autocomplete="off" spellcheck="false"></label>
        </div>
        <div class="be-cmyk-inputs">
          ${['C', 'M', 'Y', 'K'].map((l, i) => `<label class="be-cmyk-in"><span>${l}</span><input type="number" min="0" max="100" step="1" inputmode="numeric" data-be-lock-c="${i}" aria-label="${l === 'K' ? 'Black' : l === 'C' ? 'Cyan' : l === 'M' ? 'Magenta' : 'Yellow'} %"></label>`).join('')}
        </div>
      </div>
    </div>`;
}

interface PrintLockCtx {
  /** The subject's current screen colour — feeds the Auto conversion. */
  hex: () => string;
  get: () => PrintLock | null;
  /** Apply the change; the caller owns persistence/dirty-flag semantics. */
  set: (lock: PrintLock | null) => void;
}

/**
 * Render the print-lock markup into `mount` and wire it against `ctx`. Returns
 * a handle whose `render()` the caller calls whenever the subject changes
 * underneath it (a newly selected swatch, an edited primary hex) so the
 * readout/fields resync without re-mounting the control.
 *
 * Call this AFTER any generic `[data-be-seg]` delegate (see the Scheme/Surface/
 * Contrast wiring below) has already run its one-time `querySelectorAll` — the
 * control's own Auto/Locked and Process/Spot toggles are built on that same
 * `segHtml` markup, so mounting later keeps them out of that older NodeList.
 */
function mountPrintLock(mount: HTMLElement, ctx: PrintLockCtx): { render: () => void } {
  mount.innerHTML = printLockHtml();
  const box = mount.querySelector<HTMLElement>('[data-be-lock]');
  const readout = mount.querySelector<HTMLElement>('[data-be-lock-readout]');
  const modeSeg = mount.querySelector<HTMLElement>('[data-be-seg="lock-mode"]');
  const kindSeg = mount.querySelector<HTMLElement>('[data-be-seg="lock-kind"]');
  const body = mount.querySelector<HTMLElement>('[data-be-lock-body]');
  const spotFields = mount.querySelector<HTMLElement>('[data-be-lock-spot]');
  const nameInput = mount.querySelector<HTMLInputElement>('[data-be-lock-name]');
  const bookInput = mount.querySelector<HTMLInputElement>('[data-be-lock-book]');
  const cInputs = Array.from(mount.querySelectorAll<HTMLInputElement>('[data-be-lock-c]'));
  let kind: 'cmyk' | 'spot' = 'cmyk'; // which sub-mode shows while the box is open

  const setPressed = (seg: HTMLElement | null, val: string): void =>
    seg?.querySelectorAll<HTMLElement>('[data-val]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.val === val)));
  const cmykFromInputs = (): [number, number, number, number] =>
    cInputs.map(i => Math.min(100, Math.max(0, Math.round(parseFloat(i.value) || 0)))) as [number, number, number, number];

  const commit = (): void => {
    if (kind === 'spot') {
      const name = nameInput?.value.trim();
      if (!name) return; // a spot lock needs a name — nothing to commit yet
      const book = bookInput?.value.trim();
      ctx.set({ spot: { name, ...(book ? { book } : {}), cmyk: cmykFromInputs() } });
    } else {
      ctx.set({ cmyk: cmykFromInputs() });
    }
    render();
  };

  modeSeg?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-val]'); if (!btn) return;
    if (btn.dataset.val === 'auto') { ctx.set(null); render(); return; }
    // Locking with nothing pinned yet seeds from the auto conversion (Process by
    // default) — "Locked" always leaves something pinned, never a limbo state.
    if (!ctx.get()) ctx.set({ cmyk: autoCmykOf(ctx.hex()) });
    render();
  });
  kindSeg?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-val]'); if (!btn) return;
    kind = btn.dataset.val === 'spot' ? 'spot' : 'cmyk';
    setPressed(kindSeg, kind);
    if (spotFields) spotFields.hidden = kind !== 'spot';
    if (kind === 'cmyk') commit(); // Process has no name field to wait on — commit straight away
  });
  cInputs.forEach(inp => inp.addEventListener('input', commit));
  nameInput?.addEventListener('input', commit);
  bookInput?.addEventListener('input', () => { if (kind === 'spot' && nameInput?.value.trim()) commit(); });

  function render(): void {
    const lock = ctx.get();
    const eff = lock ? ('spot' in lock ? lock.spot.cmyk : lock.cmyk) : autoCmykOf(ctx.hex());
    if (readout) {
      readout.textContent = lock && 'spot' in lock
        ? `${lock.spot.name} · C${eff[0]} M${eff[1]} Y${eff[2]} K${eff[3]}`
        : `C${eff[0]} M${eff[1]} Y${eff[2]} K${eff[3]}`;
    }
    box?.classList.toggle('is-pinned', !!lock);
    setPressed(modeSeg, lock ? 'locked' : 'auto');
    if (body) body.hidden = !lock;
    kind = lock && 'spot' in lock ? 'spot' : 'cmyk';
    setPressed(kindSeg, kind);
    if (spotFields) spotFields.hidden = kind !== 'spot';
    if (nameInput && document.activeElement !== nameInput) nameInput.value = lock && 'spot' in lock ? lock.spot.name : '';
    if (bookInput && document.activeElement !== bookInput) bookInput.value = lock && 'spot' in lock ? (lock.spot.book ?? '') : '';
    cInputs.forEach((inp, i) => { if (document.activeElement !== inp) inp.value = String(eff[i]); });
  }
  render();
  return { render };
}

// ── Swatch tile + palette grid ────────────────────────────────────────────────

function tileHtml(s: BrandSwatch, idx: number): string {
  const trans = !s.hex;
  const lockTitle = s.lock && 'spot' in s.lock ? `Print colour locked to ${s.lock.spot.name}` : 'Print colour locked';
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
 * Render the brand editor into `root` and wire it. Returns a teardown that stops
 * the (font/preview) listeners. Locked builds render a read-only note and no-op.
 */
/** teardown: unmount. saveDraft: commit the Colour panel's pending, unsaved
 *  derive (a no-op when there's nothing dirty) — for a host that wants an
 *  explicit "finish up" action instead of leaving an unsaved draft to be
 *  silently discarded on teardown (see the bottom of this function). */
export interface BrandEditorHandle { teardown: () => void; saveDraft: () => void }

export async function mountBrandEditor(root: HTMLElement, host: EditorHost): Promise<BrandEditorHandle> {
  const tokens = host.tokens as unknown as WebTokensAPI | undefined;
  const fontsHost = host as unknown as UserFontsHost;
  const transferHost = { host: host as unknown as BrandTransferHost, storage: localStorage };

  let locked = false;
  try { locked = !!(await tokens?.isLocked?.()); } catch { /* treat as unlocked */ }
  if (locked) {
    root.innerHTML = `<p class="be-locked">This build ships with a fixed brand — its colours, fonts and tokens are what the whole app, your tools and every export wear. Brand editing is turned off here.</p>`;
    return { teardown: () => {}, saveDraft: () => {} };
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

  const initialDraft = deriveSafe({ primary, scheme, surface, contrast, steps });

  root.innerHTML = `
    <div class="be" data-brand-editor>
      <div class="be-panel be-colour">
        <div class="be-panel-head"><h3 class="be-panel-title">Colour</h3>
          <p class="be-panel-sub">Pick one colour — Lolly derives the ramps, both themes and every role; click a step in the Neutral or Secondary ramp to choose that shade instead of the default. Changes here preview live across the whole app. "Use this colour" re-derives the palette below — <strong>Save colour</strong> is what actually keeps it.</p></div>
        <div class="be-derive">
          <div class="be-colorpick">
            <span class="be-field-label">Primary colour</span>
            ${colorFieldHtml('be-primary', primary, { inline: true, modes: true })}
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

      <div class="be-panel be-logos">
        <div class="be-panel-head"><h3 class="be-panel-title">Logo</h3>
          <p class="be-panel-sub">Add whichever marks you have — each <strong>orientation</strong> (horizontal, vertical) in each <strong>treatment</strong> (primary and mono, each with a reverse form for dark backgrounds). Every slot is optional and independent. PNG, SVG, JPEG or WebP; they stay on this device and travel in your brand file.</p></div>
        <div class="be-logo-grid" data-be-logos></div>
        <p class="be-err" data-be-logo-err hidden></p>
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
          <p class="be-panel-sub">One file with your tokens, fonts, logos and theme — send it to anyone and their Lolly wears your brand.</p></div>
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
          <div class="be-editor-head">
            <span class="be-editor-headlabel">Edit swatch</span>
            <span class="be-swatch-lock be-editor-lockbadge" data-be-editor-lockbadge hidden>LOCK</span>
          </div>
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
          <div class="be-editor-field" data-be-lock-mount="swatch"></div>
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

  /**
   * Push the edited doc to the install (debounced) + refresh chrome & pickers.
   * Also clears the Save-colour dirty flag — see setDirty above.
   */
  const persist = (immediate = false): void => {
    clearTimeout(saveTimer);
    setDirty(false);
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
    const next = deriveSafe({ primary, scheme, surface, contrast, steps });
    if (!next) return; // a half-typed hex mid-edit — keep the last good preview
    if (preview) preview.innerHTML = previewHtml(next, { neutral: neutralStep, secondary: secondaryStep, steps });
    applyDraftChrome(next);
    broadcastDraft(next);
    setDeriveActive(true); // a derive input changed → invite the user to apply it
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
  wireColorField(root, {
    onChange: (id, value) => {
      if (id !== 'be-primary') return;
      const raw = typeof value === 'string' ? value : value.value;
      if (!raw || raw === 'transparent') return;
      primary = /^#[0-9a-fA-F]{8}$/.test(raw) ? raw.slice(0, 7) : raw;
      renderPreview();
      renderScreen();
      primaryLock?.render();
      renderGenerator();
    },
  });

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
    addSwatch(doc, 'spectrum', name, hex);
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
    get: () => primaryPrintLock(),
    set: (lock) => {
      const path = primaryAnchorPath(doc);
      if (path) setSwatchPrintOverride(doc, path, lock); // rides on the current draft; Save persists it
      setDirty(true);
      repaintPalette(); // same swatch is a tile in the Palette panel — keep its lock badge in sync
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
    try { next = deriveBrandTokens({ primary, scheme, surface, contrast, steps, name: 'My brand' }) as Record<string, unknown>; }
    catch (err) { announce(`Couldn't derive from ${primary}: ${String((err as { message?: unknown })?.message ?? err)}`, { assertive: true }); return; }
    setSemanticRampAlias(next, 'secondary', secondaryStep);
    setSemanticRampAlias(next, 'neutral', neutralStep);
    // Read the lock LIVE off the pre-derive `doc` — whichever surface (Colour
    // panel or the Palette panel's swatch popover) set it last, since both write
    // straight to `doc` — so re-deriving never silently drops a lock the other
    // surface just set (see primaryPrintLock's doc comment above).
    const priorLock = primaryPrintLock();
    if (priorLock) { const p = primaryAnchorPath(next); if (p) setSwatchPrintOverride(next, p, priorLock); } // ramp rebuilt → re-pin the print lock
    const ok = swatches.some(s => s.kind === 'custom')
      ? await confirmDialog({ title: 'Re-derive the palette?', message: 'This rebuilds every swatch from your colour and drops the custom swatches you added.', confirmLabel: 'Re-derive' })
      : true;
    if (!ok || !root.isConnected) return;
    // Commits into the in-memory draft only — no persist() here; Save colour
    // (below) is the only thing in this panel that writes to storage.
    doc = next; repaintPalette(); applyDraftChrome(doc); broadcastDraft(doc); setDirty(true);
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
  // space and extrapolates the rest. Both funnel through applyEditedHex.
  const fmtSel = editorEl?.querySelector<HTMLSelectElement>('[data-be-fmt-sel]') ?? null;
  const fmtInput = editorEl?.querySelector<HTMLInputElement>('[data-be-fmt-input]') ?? null;
  const fmtOut = editorEl?.querySelector<HTMLElement>('[data-be-fmt-out]') ?? null;
  const editorLockBadge = editorEl?.querySelector<HTMLElement>('[data-be-editor-lockbadge]') ?? null;
  let editFmt: ColorFormat = 'hex'; // sticky across swatch selections

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
  // The swatch popover's print lock — always reads/writes whichever swatch is
  // CURRENTLY open (`selected`), so it's built once and driven dynamically
  // rather than re-mounted per swatch (openEditor calls its render() instead).
  const swatchLockMount = editorEl?.querySelector<HTMLElement>('[data-be-lock-mount="swatch"]') ?? null;
  const swatchLock = swatchLockMount ? mountPrintLock(swatchLockMount, {
    hex: () => (selected >= 0 ? swatches[selected]!.hex : ''),
    get: () => (selected >= 0 ? getSwatchPrintOverride(doc, swatches[selected]!.path) : null),
    set: (lock) => {
      if (selected < 0) return;
      const cur = swatches[selected]!;
      setSwatchPrintOverride(doc, cur.path, lock);
      cur.lock = lock;
      refreshTile(selected);
      if (editorLockBadge) editorLockBadge.hidden = !lock;
      persist();
      // This swatch may BE the primary ramp's anchor step — the same swatch the
      // Colour panel's own print lock reads/writes (see primaryPrintLock's doc
      // comment). Keep that control's readout in sync too.
      const anchorPath = primaryAnchorPath(doc);
      if (anchorPath && samePath(anchorPath, cur.path)) primaryLock?.render();
    },
  }) : null;

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
    if (editorLockBadge) editorLockBadge.hidden = !s.lock;
    swatchLock?.render();
    // Position the popover under the tile, clamped to the editor box.
    const r = tile.getBoundingClientRect(), pr = root.getBoundingClientRect();
    editorEl.style.left = `${Math.min(Math.max(8, r.left - pr.left), pr.width - 308)}px`;
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

  // ── Logo variants (horizontal · vertical · mono · reverse) ──────────────────
  // Each slot is a drop/upload tile: empty → "Add", filled → the mark on a chip
  // sized to its variant (reverse on dark, mono on neutral) with a Replace/Remove
  // pair. Stored as user assets via brand-logos.ts; all four optional.
  const logoErr = $('[data-be-logo-err]') as HTMLElement | null;
  const showLogoErr = (m: string): void => { if (logoErr) { logoErr.textContent = m; logoErr.hidden = !m; } if (m) announce(m, { assertive: true }); };
  let logoUrls: string[] = []; // object URLs to revoke on repaint/teardown
  // One tile per (orientation × treatment) cell — labelled by its treatment; the
  // chip behind an uploaded mark is themed per treatment (reverse on dark, mono
  // on neutral) so a light-on-transparent PNG still reads.
  const logoTile = (v: LogoVariant, slot: LogoSlot | undefined): string => {
    const { treatment } = splitVariant(v);
    const tm = TREATMENT_META[treatment];
    const body = slot
      ? `<span class="be-logo-art"><img src="${escape(slot.url)}" alt="${escape(variantLabel(v))} logo" loading="lazy"></span>`
      : `<span class="be-logo-empty" aria-hidden="true">+</span>`;
    return `<div class="be-logo-slot${slot ? ' is-filled' : ''}" data-be-logo="${v}" data-treatment="${treatment}">
        <div class="be-logo-slot-head"><span class="be-logo-slot-name">${escape(tm.label)}</span>
          ${slot ? `<button type="button" class="be-logo-del" data-logo-del="${v}" aria-label="Remove ${escape(variantLabel(v))} logo">&#x2715;</button>` : ''}</div>
        <label class="be-logo-drop">
          ${body}
          <input type="file" class="be-logo-file" data-logo-file="${v}" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden>
        </label>
        <p class="be-logo-hint">${escape(slot ? 'Click to replace' : tm.hint)}</p>
      </div>`;
  };
  const paintLogos = async (): Promise<void> => {
    const mount = $('[data-be-logos]') as HTMLElement | null; if (!mount) return;
    logoUrls.forEach(u => URL.revokeObjectURL(u)); logoUrls = [];
    const slots = await listLogos(fontsHost).catch(() => [] as LogoSlot[]);
    logoUrls = slots.map(s => s.url);
    const byVariant = new Map(slots.map(s => [s.variant, s]));
    // Group by orientation: each is a labelled row of its three treatment tiles.
    const groups = LOGO_ORIENTATIONS.map(o => {
      const om = ORIENTATION_META[o];
      const tiles = LOGO_TREATMENTS.map(t => {
        const v = `${o}-${t}` as LogoVariant;
        return logoTile(v, byVariant.get(v));
      }).join('');
      return `<div class="be-logo-group">
          <div class="be-logo-group-head"><span class="be-logo-group-name">${escape(om.label)}</span>
            <span class="be-logo-group-hint">${escape(om.hint)}</span></div>
          <div class="be-logo-row">${tiles}</div>
        </div>`;
    }).join('');
    if (root.isConnected) mount.innerHTML = groups;
  };
  void paintLogos();
  cleanups.push(() => logoUrls.forEach(u => URL.revokeObjectURL(u)));
  $('[data-be-logos]')?.addEventListener('change', async (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('[data-logo-file]'); if (!input) return;
    const variant = input.dataset.logoFile as LogoVariant;
    const file = input.files?.[0]; input.value = ''; if (!file) return;
    showLogoErr('');
    try { await installLogo(fontsHost, variant, file); playSfx('saveProfile'); await paintLogos(); announce(`${variantLabel(variant)} logo added`); }
    catch (err) { showLogoErr(String((err as { message?: unknown })?.message ?? err)); }
  });
  $('[data-be-logos]')?.addEventListener('click', async (e) => {
    const del = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-logo-del]'); if (!del) return;
    e.preventDefault();
    const variant = del.dataset.logoDel as LogoVariant;
    const ok = await confirmDialog({ title: `Remove the ${variantLabel(variant).toLowerCase()} logo?`, message: 'It’s deleted from this device.', confirmLabel: 'Remove' });
    if (!ok) return; del.disabled = true;
    try { await removeLogo(fontsHost, variant); await paintLogos(); } catch (err) { del.disabled = false; showLogoErr(String((err as { message?: unknown })?.message ?? err)); }
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

  return {
    teardown: () => {
      clearTimeout(saveTimer); cleanups.forEach(fn => fn());
      // A live-previewed but unsaved colour draft must not outlive the editor —
      // restore the chrome accent from whatever's actually installed (unless
      // the caller already committed it via saveDraft() first).
      void applyChromeBrandVars(host);
    },
    saveDraft: () => { if (saveBtn && !saveBtn.hidden) persist(true); },
  };
}
