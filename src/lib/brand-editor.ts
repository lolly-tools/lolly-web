// SPDX-License-Identifier: MPL-2.0
/**
 * Brand editor — the interactive brand-configuration surface embedded in the
 * Dashboard's "Your brand" section (mountBrandEditor). It is the "adjust"
 * counterpart to the first-run #/start wizard: colour, palette AND fonts are set
 * here, in place, instead of bouncing to the wizard (colours) or Profile (fonts).
 *
 * Three panels, all persisting to the one `user/tokens/brand` install via the
 * bridge's single write chokepoint (installUserTokens → bust → the next
 * get()/colors()/resolve() re-reads):
 *
 *  1. Colour — the derive controls (primary + scheme / surface / contrast) with a
 *     live ramp + specimen preview (the engine's deriveBrandTokens, same as the
 *     wizard). "Use this colour" RE-SEEDS the whole palette from scratch.
 *  2. Palette — every colour the brand carries as an editable tile: recolour any
 *     swatch, rename it, delete the ones you added, and add your own. Edits are
 *     overrides written straight onto the installed DTCG doc (host.tokens.raw()),
 *     so they survive until you re-derive. Ramp + role swatches are structural
 *     (recolour/rename only); spectrum + custom swatches are add/delete too.
 *  3. Fonts — the Google-Fonts manager (user-fonts.ts), the same primitives
 *     Profile uses, so a font added here is a font added everywhere.
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
  isRec, walkSwatches, setSwatchValue, setSwatchName, deleteSwatch, addSwatch,
} from './brand-doc.ts';
import type { BrandSwatch } from './brand-doc.ts';
import { applyChromeBrandVars } from '../brand-vars.ts';
import { colorFieldHtml, wireColorField, setSwatches } from '../components/color-field.ts';
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

// ── Live derive preview (ramps + specimen), same recipe as the wizard ─────────

const slot = (set: TokenSet, name: string): string => {
  const v = set.resolve(`color.semantic.${name}`); return typeof v === 'string' ? v : '';
};
const ratioOf = (fg: string, bg: string): string => {
  try { const f = colorToHex(fg), b = colorToHex(bg); return f && b ? contrastRatio(f, b).toFixed(1) : ''; }
  catch { return ''; }
};
function rampRow(set: TokenSet, ramp: string, label: string): string {
  let cells = '';
  for (let i = 1; i <= 9; i++) {
    const v = set.resolve(`color.ramp.${ramp}.${i}`);
    const css = typeof v === 'string' ? v : 'transparent';
    cells += `<span class="be-ramp-cell" style="background:${escape(css)}" title="${escape(`${label} ${i} · ${css}`)}"></span>`;
  }
  return `<div class="be-ramp-row"><span class="be-ramp-label">${escape(label)}</span><div class="be-ramp" role="img" aria-label="${escape(label)} ramp">${cells}</div></div>`;
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
function previewHtml(opts: BrandDeriveOptions): string {
  let doc: Record<string, unknown>;
  try { doc = deriveBrandTokens(opts) as Record<string, unknown>; } catch { return ''; }
  const light = createTokenSet(doc, { theme: 'light' });
  const dark = createTokenSet(doc, { theme: 'dark' });
  return `
    <div class="be-ramps">${rampRow(light, 'primary', 'Primary')}${rampRow(light, 'neutral', 'Neutral')}</div>
    <div class="be-specs">${specCard('Light', light)}${specCard('Dark', dark)}</div>`;
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
  if (!isRec(doc)) doc = deriveBrandTokens({ primary: DEFAULT_PRIMARY, name: 'My brand' }) as Record<string, unknown>;

  // Derive-control state (separate from the edited doc — it RE-SEEDS on install).
  let primary = DEFAULT_PRIMARY, scheme: Scheme = 'mono', surface: Surface = 'light', contrast: Contrast = 'comfort';
  const currentTheme = document.documentElement.dataset.theme || 'light';

  root.innerHTML = `
    <div class="be" data-brand-editor>
      <div class="be-panel be-colour">
        <div class="be-panel-head"><h3 class="be-panel-title">Colour</h3>
          <p class="be-panel-sub">Pick one colour — Lolly derives the ramps, both themes and every role. Re-deriving replaces the palette below.</p></div>
        <div class="be-derive">
          <div class="be-derive-controls">
            <label class="be-field"><span class="be-field-label">Primary</span>${colorFieldHtml('be-primary', primary, { block: true })}</label>
            <label class="be-field"><span class="be-field-label">Scheme</span>${segHtml('scheme', SCHEMES, scheme, 'Colour scheme')}</label>
            <label class="be-field"><span class="be-field-label">Surface</span>${segHtml('surface', SURFACES, surface, 'Default surface')}</label>
            <label class="be-field"><span class="be-field-label">Contrast</span>${segHtml('contrast', CONTRASTS, contrast, 'Contrast target')}</label>
            <button type="button" class="be-cta" data-be-derive>Use this colour</button>
          </div>
          <div class="be-preview" data-be-preview>${previewHtml({ primary, scheme, surface, contrast })}</div>
        </div>
      </div>

      <div class="be-panel be-palette">
        <div class="be-panel-head"><h3 class="be-panel-title">Palette</h3>
          <p class="be-panel-sub">Every colour your brand carries. Click a swatch to recolour or rename it; add your own under Spectrum or Custom. Changes flow to every picker, tool and export.</p></div>
        <div class="be-pal" data-be-pal></div>
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
  };

  /** Push the edited doc to the install (debounced) + refresh chrome & pickers. */
  const persist = (immediate = false): void => {
    clearTimeout(saveTimer);
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
  const renderPreview = (): void => { if (preview) preview.innerHTML = previewHtml({ primary, scheme, surface, contrast }); };
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
  $('[data-be-derive]')?.addEventListener('click', async () => {
    let next: Record<string, unknown>;
    try { next = deriveBrandTokens({ primary, scheme, surface, contrast, name: 'My brand' }) as Record<string, unknown>; }
    catch (err) { announce(`Couldn't derive from ${primary}: ${String((err as { message?: unknown })?.message ?? err)}`, { assertive: true }); return; }
    const ok = swatches.some(s => s.kind === 'custom')
      ? await confirmDialog({ title: 'Re-derive the palette?', message: 'This rebuilds every swatch from your colour and drops the custom swatches you added.', confirmLabel: 'Re-derive' })
      : true;
    if (!ok || !root.isConnected) return;
    doc = next; repaintPalette(); persist(true); playSfx('saveProfile');
    announce('Palette re-derived from your colour');
  });

  // ── Palette: click a tile → open the shared swatch editor ───────────────────
  const closeEditor = (): void => { if (editorEl) { editorEl.hidden = true; } selected = -1; root.querySelectorAll('.be-swatch.is-selected').forEach(t => t.classList.remove('is-selected')); };
  const openEditor = (idx: number, tile: HTMLElement): void => {
    const s = swatches[idx]; if (!s || !editorEl) return;
    selected = idx;
    root.querySelectorAll('.be-swatch.is-selected').forEach(t => t.classList.remove('is-selected'));
    tile.classList.add('is-selected');
    const colorMount = editorEl.querySelector<HTMLElement>('[data-be-editor-color]')!;
    const nameInput = editorEl.querySelector<HTMLInputElement>('[data-be-editor-name]')!;
    const delBtn = editorEl.querySelector<HTMLButtonElement>('[data-be-editor-del]')!;
    colorMount.innerHTML = colorFieldHtml('be-edit-color', s.hex || '#888888', { block: true });
    nameInput.value = s.name;
    delBtn.hidden = !s.deletable;
    // Rewire the field just built (idempotent per node).
    wireColorField(editorEl, {
      onChange: (id, value) => {
        if (id !== 'be-edit-color' || selected < 0) return;
        const raw = typeof value === 'string' ? value : value.value;
        const hex = /^#[0-9a-fA-F]{8}$/.test(raw) ? raw.slice(0, 7) : raw;
        if (!hex || hex === 'transparent') return;
        const cur = swatches[selected]; if (!cur) return;
        setSwatchValue(doc, cur.path, hex);
        cur.hex = colorToHex(hex) ?? hex; cur.raw = hex;
        tile.style.setProperty('--sw', cur.hex);
        const hexEl = tile.querySelector('.be-swatch-hex'); if (hexEl) hexEl.textContent = cur.hex;
        persist();
      },
    });
    // Position the popover under the tile, clamped to the editor box.
    const r = tile.getBoundingClientRect(), pr = root.getBoundingClientRect();
    editorEl.style.left = `${Math.min(Math.max(8, r.left - pr.left), pr.width - 280)}px`;
    editorEl.style.top = `${r.bottom - pr.top + 8}px`;
    editorEl.hidden = false;
    nameInput.focus();
  };
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
    catch (err) { showFontErr(String((err as { message?: unknown })?.message ?? err)); }
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
      repaintPalette(); await paintFonts(); void applyChromeBrandVars(host);
      announce('Brand loaded');
    } catch (err) { if (shareErr) { shareErr.textContent = String((err as { message?: unknown })?.message ?? err); shareErr.hidden = false; } }
  });

  return () => { clearTimeout(saveTimer); cleanups.forEach(fn => fn()); };
}
