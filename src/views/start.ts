// SPDX-License-Identifier: MPL-2.0
/**
 * #/start — the brand wizard. The product's first impression for an unbranded
 * install: pick ONE colour (plus scheme / surface / contrast), watch a full
 * token system derive live — primary + neutral ramps and both themes' semantic
 * slots as specimen cards — then install it as YOUR brand, entirely on-device.
 *
 * Derivation is the engine's (deriveBrandTokens → the same DTCG doc shape the
 * catalog ships), and the preview resolves it through createTokenSet exactly
 * like the runtime will, so what you see here is what every tool renders.
 * A secondary path imports an existing tokens JSON (W3C DTCG / Tokens Studio,
 * monolithic export) via coerceTokensDoc; either path lands in
 * installUserTokens (bridge/tokens.ts), which writes the `user/tokens/brand`
 * asset and busts the tokens cache.
 *
 * Chrome uses the shell's design vocabulary (tokens.css HSL vars, the shared
 * colour field, .view-seg segments); ONLY the preview swatches/specimens carry
 * the derived brand values, inline, so the brand is felt rather than described.
 * Esc or the Back link returns to the gallery.
 */

import '../styles/parts/start.css';   // async CSS chunk (lazy view — not on the landing)
import {
  deriveBrandTokens, createTokenSet, coerceTokensDoc, summarizeTokensDoc,
  colorToHex, contrastRatio,
} from '@lolly/engine';
import type { BrandDeriveOptions } from '@lolly/engine';
import type { TokenSet } from '../../../../engine/src/bridge/host-v1.ts';
import { installUserTokens } from '../bridge/tokens.ts';
import { colorFieldHtml, wireColorField } from '../components/color-field.ts';
import { markWelcomeDismissed } from '../components/welcome-dialog.ts';
import { escape } from '../utils.ts';

/** The view container, which main.ts reads a teardown fn off (see navigate()). */
type ViewElement = HTMLElement & { _cleanup?: () => void };

/** Whatever host installUserTokens needs — stays in lock-step with the bridge. */
type StartHost = Parameters<typeof installUserTokens>[0];

type Scheme = NonNullable<BrandDeriveOptions['scheme']>;
type Surface = NonNullable<BrandDeriveOptions['surface']>;
type Contrast = NonNullable<BrandDeriveOptions['contrast']>;

const SCHEMES: ReadonlyArray<{ id: Scheme; label: string }> = [
  { id: 'mono', label: 'Mono' },
  { id: 'complement', label: 'Complement' },
  { id: 'analogous', label: 'Analogous' },
  { id: 'triad', label: 'Triad' },
];
const SURFACES: ReadonlyArray<{ id: Surface; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'primary', label: 'Deep primary' },
];
const CONTRASTS: ReadonlyArray<{ id: Contrast; label: string }> = [
  { id: 'comfort', label: 'Comfort' },
  { id: 'high', label: 'High' },
];

// Matches the templates' canonical `var(--primary, #4f83cc)` fallback — a calm,
// trustworthy blue the user immediately overwrites with their own.
const DEFAULT_PRIMARY = '#4f83cc';

const segHtml = (name: string, options: ReadonlyArray<{ id: string; label: string }>, active: string, ariaLabel: string): string => `
  <div class="view-seg start-seg" role="group" aria-label="${escape(ariaLabel)}" data-seg="${escape(name)}">
    ${options.map(o => `<button type="button" class="view-seg-btn" data-val="${escape(o.id)}" aria-pressed="${o.id === active}">${escape(o.label)}</button>`).join('')}
  </div>`;

export async function mountStart(viewEl: HTMLElement, host: StartHost): Promise<void> {
  document.title = 'Make it yours · Lolly';

  let primary = DEFAULT_PRIMARY;
  let scheme: Scheme = 'mono';
  let surface: Surface = 'light';
  let contrast: Contrast = 'comfort';

  viewEl.innerHTML = `
    <div class="start">
      <a class="start-back" href="#/">&larr; Tools</a>
      <header class="start-head">
        <p class="start-eyebrow">Brand setup</p>
        <h1 class="start-title">Make it yours</h1>
        <p class="start-sub">One colour is enough — Lolly derives the ramps, both themes and every semantic slot from it. Nothing leaves this device.</p>
      </header>
      <div class="start-grid">
        <div class="start-controls">
          <section class="start-panel" aria-label="Brand controls">
            <div class="start-field">
              <span class="start-label" id="start-primary-label">Primary colour</span>
              ${colorFieldHtml('start-primary', primary)}
            </div>
            <div class="start-field">
              <span class="start-label">Scheme</span>
              ${segHtml('scheme', SCHEMES, scheme, 'Colour scheme')}
            </div>
            <div class="start-field">
              <span class="start-label">Surface</span>
              ${segHtml('surface', SURFACES, surface, 'Default surface')}
            </div>
            <div class="start-field">
              <span class="start-label">Contrast</span>
              ${segHtml('contrast', CONTRASTS, contrast, 'Contrast target')}
            </div>
            <button type="button" class="start-cta" data-install-derived>Use this brand</button>
            <p class="start-cta-note">Saved on this device as your brand — re-run this any time from the profile menu.</p>
            <p class="start-error" role="alert" hidden></p>
          </section>
          <section class="start-panel start-import" aria-label="Import tokens">
            <h2 class="start-import-title">Already have tokens?</h2>
            <p class="start-import-sub">Bring a W3C design-tokens or Tokens Studio JSON export (single file).</p>
            <label class="start-import-btn">
              Import tokens (.json)&hellip;
              <input type="file" class="start-import-file" accept=".json,application/json" hidden>
            </label>
            <div class="start-import-result" hidden></div>
          </section>
        </div>
        <section class="start-preview" aria-label="Live preview">
          <div class="start-preview-mount"></div>
        </section>
      </div>
    </div>`;

  const previewMount = viewEl.querySelector<HTMLElement>('.start-preview-mount')!;
  const errorEl = viewEl.querySelector<HTMLElement>('.start-error')!;

  // ── Live preview ─────────────────────────────────────────────────────────────

  /** A semantic slot's resolved value ('' when the doc/engine can't supply it). */
  const slot = (set: TokenSet, name: string): string => {
    const v = set.resolve(`color.semantic.${name}`);
    return typeof v === 'string' ? v : '';
  };

  /** "7.2" — WCAG ratio of two resolved colours, '' when either won't parse. */
  const ratioOf = (fg: string, bg: string): string => {
    try {
      const f = colorToHex(fg);
      const b = colorToHex(bg);
      return f && b ? contrastRatio(f, b).toFixed(1) : '';
    } catch { return ''; }
  };

  const rampRow = (set: TokenSet, ramp: string, label: string): string => {
    let cells = '';
    for (let i = 1; i <= 9; i++) {
      const v = set.resolve(`color.ramp.${ramp}.${i}`);
      const css = typeof v === 'string' ? v : 'transparent';
      cells += `<span class="start-ramp-cell" style="background:${escape(css)}" title="${escape(`${label} ${i} · ${css}`)}"></span>`;
    }
    return `
      <div class="start-ramp-row">
        <span class="start-ramp-label">${escape(label)}</span>
        <div class="start-ramp" role="img" aria-label="${escape(label)} ramp, dark to light">${cells}</div>
      </div>`;
  };

  // A specimen card per theme: its own surface, the text hierarchy (heading in
  // --text, body in --muted, a hairline in --edge) and the primary button (bg
  // primary, label on-primary) — the tone is felt, not described. All colours
  // inline: these are BRAND values, never shell-chrome tokens.
  const specCard = (themeName: 'light' | 'dark', set: TokenSet, isDefault: boolean): string => {
    const surfaceC = slot(set, 'surface');
    const text = slot(set, 'text');
    const muted = slot(set, 'muted');
    const edge = slot(set, 'edge');
    const prim = slot(set, 'primary');
    const onPrim = slot(set, 'on-primary');
    const ratio = ratioOf(text, surfaceC);
    return `
      <article class="start-spec" style="background:${escape(surfaceC)};border-color:${escape(edge)}">
        <header class="start-spec-top">
          <span class="start-spec-name" style="color:${escape(muted)}">${themeName === 'light' ? 'Light' : 'Dark'}</span>
          ${isDefault ? `<span class="start-spec-default" style="background:${escape(prim)};color:${escape(onPrim)}">Default</span>` : ''}
        </header>
        <h3 class="start-spec-heading" style="color:${escape(text)}">The quick brown fox</h3>
        <p class="start-spec-body" style="color:${escape(muted)}">Body copy sits one step back — calm, readable, unmistakably yours.</p>
        <hr class="start-spec-rule" style="border-color:${escape(edge)}">
        <div class="start-spec-row">
          <span class="start-spec-btn" style="background:${escape(prim)};color:${escape(onPrim)}">Primary action</span>
          ${ratio ? `<span class="start-spec-ratio" style="color:${escape(muted)}">${escape(ratio)}:1 text</span>` : ''}
        </div>
      </article>`;
  };

  const deriveOpts = (): BrandDeriveOptions => ({ primary, scheme, surface, contrast, name: 'My brand' });

  function renderPreview(): void {
    let doc: Record<string, unknown>;
    try {
      doc = deriveBrandTokens(deriveOpts()) as Record<string, unknown>;
    } catch { return; } // a half-typed colour mid-edit — keep the last good preview
    const light = createTokenSet(doc, { theme: 'light' });
    const dark = createTokenSet(doc, { theme: 'dark' });
    // The `surface` option orders $themes (chosen look first = default theme).
    const defaultTheme = createTokenSet(doc).themes()[0]?.name ?? 'light';
    previewMount.innerHTML = `
      <div class="start-ramps">
        ${rampRow(light, 'primary', 'Primary')}
        ${rampRow(light, 'neutral', 'Neutral')}
      </div>
      <div class="start-specs">
        ${specCard('light', light, defaultTheme === 'light')}
        ${specCard('dark', dark, defaultTheme !== 'light')}
      </div>`;
  }
  renderPreview();

  // ── Controls ─────────────────────────────────────────────────────────────────

  wireColorField(viewEl, {
    onChange: (_id, value) => {
      const raw = typeof value === 'string' ? value : value.value;
      if (!raw || raw === 'transparent') return; // a transparent primary derives nothing useful
      // Derivation wants an opaque colour; drop a hex8's alpha channel.
      primary = /^#[0-9a-fA-F]{8}$/.test(raw) ? raw.slice(0, 7) : raw;
      renderPreview();
    },
  });

  const wireSeg = (name: string, apply: (v: string) => void): void => {
    const seg = viewEl.querySelector<HTMLElement>(`[data-seg="${name}"]`);
    seg?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-val]');
      if (!btn) return;
      apply(btn.dataset.val!);
      seg.querySelectorAll<HTMLElement>('[data-val]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      renderPreview();
    });
  };
  wireSeg('scheme', v => { scheme = v as Scheme; });
  wireSeg('surface', v => { surface = v as Surface; });
  wireSeg('contrast', v => { contrast = v as Contrast; });

  // ── Install (both paths funnel here) ─────────────────────────────────────────

  let installing = false;
  async function install(doc: Record<string, unknown>, label: string, btn: HTMLButtonElement): Promise<void> {
    if (installing) return;
    installing = true;
    errorEl.hidden = true;
    btn.disabled = true;
    const prevLabel = btn.textContent;
    btn.textContent = 'Installing…';
    try {
      await installUserTokens(host, doc, { label });
      // The brand question is settled — the welcome must not re-prompt.
      markWelcomeDismissed();
      window.location.hash = '#/';
    } catch (err) {
      installing = false;
      btn.disabled = false;
      btn.textContent = prevLabel;
      errorEl.textContent = `Couldn't install the brand: ${String((err as { message?: unknown })?.message ?? err)}`;
      errorEl.hidden = false;
    }
  }

  viewEl.querySelector<HTMLButtonElement>('[data-install-derived]')?.addEventListener('click', (e) => {
    let doc: Record<string, unknown>;
    try {
      doc = deriveBrandTokens(deriveOpts()) as Record<string, unknown>;
    } catch (err) {
      errorEl.textContent = `Couldn't derive a brand from ${primary}: ${String((err as { message?: unknown })?.message ?? err)}`;
      errorEl.hidden = false;
      return;
    }
    void install(doc, 'My brand', e.currentTarget as HTMLButtonElement);
  });

  // ── Import path (monolithic JSON only this pass — zips/.penpot come later) ──

  const importResult = viewEl.querySelector<HTMLElement>('.start-import-result')!;
  const importFile = viewEl.querySelector<HTMLInputElement>('.start-import-file')!;
  let importedDoc: Record<string, unknown> | null = null;
  let importedLabel = 'My brand';

  const showImportResult = (html: string): void => {
    importResult.innerHTML = html;
    importResult.hidden = false;
  };

  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    importFile.value = ''; // so re-picking the same file re-fires change
    if (!file) return;
    importedDoc = null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      showImportResult(`<p class="start-import-err">Couldn't read ${escape(file.name)} — is it valid JSON?</p>`);
      return;
    }
    const { doc, warnings, source } = coerceTokensDoc(parsed);
    if (!doc) {
      showImportResult(`<p class="start-import-err">No tokens found: ${escape(warnings[0] ?? 'unrecognised document')}.</p>`);
      return;
    }
    importedDoc = doc;
    importedLabel = file.name.replace(/\.json$/i, '') || 'My brand';
    let statLine = '';
    try {
      const s = summarizeTokensDoc(doc);
      statLine = [
        s.sets.length ? `${s.sets.length} set${s.sets.length === 1 ? '' : 's'}` : null,
        s.themes.length ? `${s.themes.length} theme${s.themes.length === 1 ? '' : 's'}` : null,
        `${s.tokenCount} token${s.tokenCount === 1 ? '' : 's'}`,
        `${s.colorCount} colour${s.colorCount === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · ');
    } catch { /* stats are decorative — the install button still stands */ }
    showImportResult(`
      <p class="start-import-name">${escape(file.name)}<span class="start-import-source">${escape(source)}</span></p>
      ${statLine ? `<p class="start-import-stats">${escape(statLine)}</p>` : ''}
      ${warnings.length ? `<p class="start-import-warn">${escape(warnings.join(' · '))}</p>` : ''}
      <button type="button" class="start-cta start-cta--import" data-install-import>Install these tokens</button>`);
  });

  // Delegated: the install button is re-created with every result render.
  importResult.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-install-import]');
    if (btn && importedDoc) void install(importedDoc, importedLabel, btn);
  });

  // ── Escape returns to the gallery (colour-popover Escapes stopPropagation
  //    at the field, so they never reach this) ─────────────────────────────────
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    window.location.hash = '#/';
  };
  document.addEventListener('keydown', onKey);
  (viewEl as ViewElement)._cleanup = () => document.removeEventListener('keydown', onKey);
}
