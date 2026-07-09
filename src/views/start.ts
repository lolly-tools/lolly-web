// SPDX-License-Identifier: MPL-2.0
/**
 * #/start — the brand wizard, and the product's first impression for an
 * unbranded install. It is now the SAME editor the Dashboard's "Your brand"
 * section mounts (lib/brand-editor.ts) — colour (pick one, derive a full token
 * system live), fonts (add any Google Font, on-device), and the palette (every
 * swatch editable) — so a first-run user configures a complete brand here in
 * place, with dashboard parity. Two things sit around that shared editor:
 *
 *   - a Corner-style slider (the one brand control the editor doesn't carry —
 *     it lives on Profile too, wired through setBrandRadius); and
 *   - an "Already have a brand?" import path for a W3C/Tokens-Studio JSON export
 *     or a Lolly brand file (.zip), which lands the user straight on a branded
 *     gallery.
 *
 * Everything persists to the one `user/tokens/brand` install via the bridge's
 * single write chokepoint (installUserTokens → bust). A LOCKED catalog owns its
 * brand and can't be adjusted, so the route degrades to a read-only note.
 * Esc or the Back link returns to the gallery.
 */

import '../styles/parts/start.css';       // this view's shell/layout (lazy chunk)
import '../styles/parts/dashboard.css';   // the mounted editor's .be-* styles live here
import { coerceTokensDoc, summarizeTokensDoc } from '@lolly/engine';
import { installUserTokens } from '../bridge/tokens.ts';
import { applyChromeBrandVars, brandRadiusValue } from '../brand-vars.ts';
import { mountBrandEditor } from '../lib/brand-editor.ts';
import { carryUserFontTokens, setBrandRadius } from '../user-fonts.ts';
import type { UserFontsHost } from '../user-fonts.ts';
import { importBrandPack } from '../brand-transfer.ts';
import type { BrandTransferHost } from '../brand-transfer.ts';
import { markWelcomeDismissed, closeWelcomeDialog } from '../components/welcome-dialog.ts';
import { announce } from '../a11y.ts';
import { escape } from '../utils.ts';
import { applyTheme } from '../theme.ts';

/** The view container, which main.ts reads a teardown fn off (see navigate()). */
type ViewElement = HTMLElement & { _cleanup?: () => void };

/** Whatever host installUserTokens needs — stays in lock-step with the bridge. */
type StartHost = Parameters<typeof installUserTokens>[0];

export async function mountStart(viewEl: HTMLElement, host: StartHost): Promise<void> {
  document.title = 'Make it yours · Lolly';

  // A locked catalog is authoritative — its brand (colours, fonts, radius) can't
  // be adjusted; every write funnels through installUserTokens, which refuses. So
  // skip the whole editor and say why, rather than dead-ending on an error.
  if (await host.tokens?.isLocked?.().catch(() => false)) {
    document.title = 'Brand · Lolly';
    viewEl.innerHTML = `
      <div class="start">
        <a class="start-back" href="#/">&larr; Tools</a>
        <header class="start-head">
          <p class="start-eyebrow">Brand</p>
          <h1 class="start-title">This brand is set</h1>
          <p class="start-sub">This build ships with a fixed brand — its colours, fonts and tokens are what every tool and export use. Brand adjustment is turned off here, so there’s nothing to change.</p>
        </header>
      </div>`;
    return;
  }

  // Corner radius seed: the installed brand's --radius, else the shell default
  // (1rem). parseFloat tolerates a stored px/em value from a hand-authored
  // import; the slider always writes back in rem.
  const currentRadius = await (host.tokens as { resolve?(ref: string): Promise<unknown> } | undefined)
    ?.resolve?.('{shape.radius}').then(v => brandRadiusValue(v)).catch(() => null) ?? null;
  const currentRadiusRem = currentRadius ? parseFloat(currentRadius) : 1;

  viewEl.innerHTML = `
    <div class="start start--editor">
      <a class="start-back" href="#/">&larr; Tools</a>
      <header class="start-head">
        <p class="start-eyebrow">Brand setup</p>
        <h1 class="start-title">Make it yours</h1>
        <p class="start-sub">Pick a colour and Lolly derives a full brand — ramps, both themes, every role. Add fonts, fine-tune the palette, set the corner style. Everything stays on this device.</p>
      </header>

      <div class="start-editor-wrap">
        <!-- The shared brand editor: colour, logo, fonts, palette (swatches), share. -->
        <div class="start-editor-mount" data-start-editor><p class="start-editor-loading">Loading your brand…</p></div>

        <!-- Secondary utilities: corner style + import, side by side below the brand work. -->
        <div class="start-utils">
          <!-- Corner style — the one control the editor doesn't carry (setBrandRadius). -->
          <section class="be-panel start-radius-panel" aria-label="Corner style">
            <div class="be-panel-head"><h3 class="be-panel-title">Corner style</h3>
              <p class="be-panel-sub">How rounded your cards, buttons and panels read across the whole app.</p></div>
            <div class="brand-radius-row">
              <span class="brand-radius-preview" id="start-radius-preview" style="border-radius:${currentRadiusRem}rem" aria-hidden="true"></span>
              <input type="range" class="brand-radius-slider" id="start-radius-slider" min="0" max="1.5" step="0.05" value="${currentRadiusRem}" aria-label="Corner radius">
              <span class="brand-radius-value" id="start-radius-value">${currentRadiusRem}rem</span>
            </div>
            <p class="be-err" id="start-radius-error" role="alert" hidden></p>
          </section>

          <!-- Already have a brand? Bring a tokens JSON or a Lolly brand file. -->
          <section class="be-panel start-import" aria-label="Import a brand">
            <div class="be-panel-head"><h3 class="be-panel-title">Already have a brand?</h3>
              <p class="be-panel-sub">Bring a W3C design-tokens / Tokens Studio JSON export, or a Lolly <strong>brand file</strong> (.zip) someone shared — tokens, fonts, logos and theme in one.</p></div>
            <label class="be-btn start-import-btn">
              Import tokens or brand file&hellip;
              <input type="file" class="start-import-file" accept=".json,application/json,.zip,application/zip" hidden>
            </label>
            <div class="start-import-result" hidden></div>
          </section>
        </div>
      </div>

      <div class="start-done-row">
        <p class="start-done-note">Everything you set here is saved on this device as your brand — every tool, page and export follows it. Adjust it any time from your dashboard.</p>
        <a class="start-cta start-done" href="#/">Done — take me to my tools &rarr;</a>
      </div>
    </div>`;

  const importResult = viewEl.querySelector<HTMLElement>('.start-import-result')!;
  const showImportResult = (html: string): void => {
    importResult.innerHTML = html;
    importResult.hidden = false;
  };

  // ── The shared brand editor (fonts · colour · palette · share) ───────────────
  const editorMount = viewEl.querySelector<HTMLElement>('[data-start-editor]')!;
  let editorTeardown: (() => void) | null = null;
  try {
    editorTeardown = await mountBrandEditor(editorMount, host as unknown as Parameters<typeof mountBrandEditor>[1]);
  } catch (err) {
    editorMount.innerHTML = `<p class="be-err">Couldn't open the brand editor: ${escape(String((err as { message?: unknown })?.message ?? err))}</p>`;
  }

  // ── Corner radius ────────────────────────────────────────────────────────────
  // Live app-wide preview on every drag tick (set --radius directly — instant,
  // no round trip), persisted debounced so a drag doesn't spam writes.
  const radiusSlider = viewEl.querySelector<HTMLInputElement>('#start-radius-slider');
  const radiusPreview = viewEl.querySelector<HTMLElement>('#start-radius-preview');
  const radiusValueEl = viewEl.querySelector<HTMLElement>('#start-radius-value');
  const radiusErr = viewEl.querySelector<HTMLElement>('#start-radius-error');
  let radiusDebounce: ReturnType<typeof setTimeout> | undefined;
  radiusSlider?.addEventListener('input', () => {
    const css = `${radiusSlider.value}rem`;
    if (radiusPreview) radiusPreview.style.borderRadius = css;
    if (radiusValueEl) radiusValueEl.textContent = css;
    document.documentElement.style.setProperty('--radius', css);
    clearTimeout(radiusDebounce);
    radiusDebounce = setTimeout(() => {
      setBrandRadius(host as unknown as UserFontsHost, css).catch(err => {
        if (radiusErr) { radiusErr.textContent = String((err as { message?: unknown })?.message ?? err); radiusErr.hidden = false; }
      });
    }, 400);
  });

  // ── Install (the JSON-import path funnels here) ──────────────────────────────
  let installing = false;
  async function install(doc: Record<string, unknown>, label: string, btn: HTMLButtonElement): Promise<void> {
    if (installing) return;
    installing = true;
    btn.disabled = true;
    const prevLabel = btn.textContent;
    btn.textContent = 'Installing…';
    try {
      // A doc with no font group inherits the fonts already installed here, so an
      // import never silently undoes a chosen face.
      const withFonts = await carryUserFontTokens(host as unknown as UserFontsHost, doc);
      await installUserTokens(host, withFonts, { label });
      void applyChromeBrandVars(host);         // bust() cleared caches; nothing repaints chrome by itself
      markWelcomeDismissed();
      closeWelcomeDialog();
      if (viewEl.isConnected) window.location.hash = '#/';
    } catch (err) {
      installing = false;
      btn.disabled = false;
      btn.textContent = prevLabel;
      const msg = `Couldn't install the brand: ${String((err as { message?: unknown })?.message ?? err)}`;
      showImportResult(`<p class="start-import-err">${escape(msg)}</p>`);
      announce(msg, { assertive: true });
    }
  }

  // ── Import path — a raw tokens JSON (W3C DTCG / Tokens Studio) or a .zip pack ─
  const importFile = viewEl.querySelector<HTMLInputElement>('.start-import-file')!;
  let importedDoc: Record<string, unknown> | null = null;
  let importedLabel = 'My brand';

  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    importFile.value = ''; // so re-picking the same file re-fires change
    if (!file) return;
    importedDoc = null;

    // A .zip is a Lolly BRAND FILE (brand-transfer.ts): tokens + fonts + theme,
    // installed in one step — no preview/confirm leg like the raw-tokens path,
    // because the pack was exported by Lolly and carries its own integrity map.
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
      if (file.size > 64 * 1024 * 1024) {
        showImportResult(`<p class="start-import-err">${escape(file.name)} is too large for a brand file (max 64 MB).</p>`);
        return;
      }
      showImportResult(`<p class="start-import-stats">Loading ${escape(file.name)}…</p>`);
      try {
        const summary = await importBrandPack(
          { host: host as unknown as BrandTransferHost, storage: localStorage },
          await file.arrayBuffer());
        applyTheme(localStorage.getItem('theme') || 'light');
        markWelcomeDismissed();
        closeWelcomeDialog();
        announce(`Brand loaded — ${summary.fontFamilies} font ${summary.fontFamilies === 1 ? 'family' : 'families'}${summary.tokens ? ', tokens installed' : ''}`);
        if (viewEl.isConnected) window.location.hash = '#/'; // land on the freshly-branded gallery
      } catch (err) {
        showImportResult(`<p class="start-import-err">${escape(String((err as { message?: unknown })?.message ?? err))}</p>`);
      }
      return;
    }

    // Token documents are hand-authored JSON, a few KB to a few MB — bound the
    // read so a mispicked/hostile multi-GB file can't be parsed into memory.
    if (file.size > 10 * 1024 * 1024) {
      showImportResult(`<p class="start-import-err">${escape(file.name)} is too large for a token file (max 10 MB).</p>`);
      return;
    }
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
      <button type="button" class="be-cta start-cta--import" data-install-import>Install these tokens</button>`);
  });

  // Delegated: the install button is re-created with every result render.
  importResult.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-install-import]');
    if (btn && importedDoc) void install(importedDoc, importedLabel, btn);
  });

  // ── Escape returns to the gallery (colour-popover Escapes stopPropagation at
  //    the field, so they never reach this) ─────────────────────────────────────
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || installing) return; // no Esc-teardown mid-install
    e.preventDefault();
    window.location.hash = '#/';
  };
  document.addEventListener('keydown', onKey);
  (viewEl as ViewElement)._cleanup = () => {
    document.removeEventListener('keydown', onKey);
    editorTeardown?.();
  };
}
