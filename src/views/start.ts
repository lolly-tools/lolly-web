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
import { coerceTokensDoc, summarizeTokensDoc, extractPenpotProject, extractSvgColors, deriveBrandTokens } from '@lolly/engine';
import { installUserTokens } from '../bridge/tokens.ts';
import { applyChromeBrandVars, brandRadiusValue } from '../brand-vars.ts';
import { mountBrandEditor } from '../lib/brand-editor.ts';
import { carryUserFontTokens, setBrandRadius } from '../user-fonts.ts';
import type { UserFontsHost } from '../user-fonts.ts';
import { importBrandPack, unzipBrandBytes } from '../brand-transfer.ts';
import type { BrandTransferHost } from '../brand-transfer.ts';
import { addSwatch } from '../lib/brand-doc.ts';
import { markWelcomeDismissed, closeWelcomeDialog } from '../components/welcome-dialog.ts';
import { announce } from '../a11y.ts';
import { escape } from '../utils.ts';
import { applyTheme } from '../theme.ts';
import { strFromU8 } from 'fflate';

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

          <!-- Already have a brand? Bring a tokens JSON, a Penpot file, an SVG, or a Lolly brand file. -->
          <section class="be-panel start-import" aria-label="Import a brand">
            <div class="be-panel-head"><h3 class="be-panel-title">Already have a brand?</h3>
              <p class="be-panel-sub">Bring a W3C design-tokens / Tokens Studio JSON export, a <strong>Penpot</strong> file (its design tokens), an <strong>SVG</strong> (we'll read the colours it uses), or a Lolly <strong>brand file</strong> (.zip) someone shared.</p></div>
            <label class="be-btn start-import-btn">
              Import a design or brand file&hellip;
              <input type="file" class="start-import-file" accept=".json,application/json,.penpot,.svg,image/svg+xml,.zip,application/zip" hidden>
            </label>
            <div class="start-import-result" hidden></div>
          </section>
        </div>
      </div>

      <p class="start-done-note">Everything you set here is saved on this device as your brand — every tool, page and export follows it. Adjust it any time from your dashboard.</p>
    </div>
    <button type="button" class="start-float-cta" id="start-float-save">
      Save &amp; begin
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
    </button>`;

  const importResult = viewEl.querySelector<HTMLElement>('.start-import-result')!;
  const showImportResult = (html: string): void => {
    importResult.innerHTML = html;
    importResult.hidden = false;
  };

  // ── The shared brand editor (fonts · colour · palette · share) ───────────────
  const editorMount = viewEl.querySelector<HTMLElement>('[data-start-editor]')!;
  let editor: Awaited<ReturnType<typeof mountBrandEditor>> | null = null;
  try {
    editor = await mountBrandEditor(editorMount, host as unknown as Parameters<typeof mountBrandEditor>[1]);
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

  // Shared "N sets · N themes · N tokens, N colours" blurb — every doc-shaped
  // import path (JSON tokens, Penpot tokens) shows the same stats before the
  // user commits.
  function statLineFor(doc: Record<string, unknown>): string {
    try {
      const s = summarizeTokensDoc(doc);
      return [
        s.sets.length ? `${s.sets.length} set${s.sets.length === 1 ? '' : 's'}` : null,
        s.themes.length ? `${s.themes.length} theme${s.themes.length === 1 ? '' : 's'}` : null,
        `${s.tokenCount} token${s.tokenCount === 1 ? '' : 's'}`,
        `${s.colorCount} colour${s.colorCount === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · ');
    } catch { return ''; } // stats are decorative — the install button still stands
  }

  // A tiny local mirror of brand-transfer.ts's private readJson (not exported —
  // this is the only other place that needs to peek at a zip's manifest before
  // deciding which importer owns it).
  function readManifest(files: Record<string, Uint8Array>): { format?: string; type?: string } | null {
    const bytes = files['manifest.json'];
    if (!bytes) return null;
    try { return JSON.parse(strFromU8(bytes)); } catch { return null; }
  }

  // extractSvgColors can return a bare named colour ("rebeccapurple") verbatim
  // — deriveBrandTokens's parser only understands hex/rgb()/hsl()/oklch()/lch(),
  // NOT bare names, and throws on anything else. The browser itself is the one
  // dependency-free place that resolves every CSS colour name it recognises
  // (not just a hand-copied subset), so ask it via a detached element rather
  // than hand-rolling a second named-colour table here.
  function toHexForDerive(value: string): string | null {
    if (value.startsWith('#')) return value;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;left:-9999px;top:-9999px;';
    probe.style.color = value;
    if (!probe.style.color) return null; // the browser didn't recognise it
    document.body.appendChild(probe);
    const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
    probe.remove();
    if (!rgb) return null;
    const hex = (n: string): string => Number(n).toString(16).padStart(2, '0');
    return `#${hex(rgb[1]!)}${hex(rgb[2]!)}${hex(rgb[3]!)}`;
  }

  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    importFile.value = ''; // so re-picking the same file re-fires change
    if (!file) return;
    importedDoc = null;

    // SVG has no formal-token concept — every colour it uses is "not a token",
    // so scan for what's actually there and let the user pick which to keep
    // (see the checkbox review below) rather than treating every incidental
    // fill as part of the brand.
    if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') {
      if (file.size > 10 * 1024 * 1024) {
        showImportResult(`<p class="start-import-err">${escape(file.name)} is too large for an SVG scan (max 10 MB).</p>`);
        return;
      }
      let svgColors: string[] = [];
      try {
        svgColors = extractSvgColors(await file.text());
      } catch {
        showImportResult(`<p class="start-import-err">Couldn't read ${escape(file.name)} as SVG.</p>`);
        return;
      }
      if (!svgColors.length) {
        showImportResult(`<p class="start-import-err">No colours found in ${escape(file.name)}.</p>`);
        return;
      }
      importedLabel = file.name.replace(/\.svg$/i, '') || 'My brand';
      showImportResult(`
        <p class="start-import-name">${escape(file.name)}<span class="start-import-source">colours in use</span></p>
        <p class="start-import-warn">Found ${svgColors.length} colour${svgColors.length === 1 ? '' : 's'} — none are linked to a design token, so review and drop any you don't want. The first one kept becomes your main brand colour.</p>
        <div class="start-color-actions">
          <button type="button" class="be-btn be-btn--sm" data-colors-all>Select all</button>
          <button type="button" class="be-btn be-btn--sm" data-colors-none>Select none</button>
        </div>
        <ul class="start-color-grid" role="list">
          ${svgColors.map((hex, i) => `
            <li class="start-color-chip">
              <label>
                <input type="checkbox" data-color-idx="${i}" checked>
                <span class="start-color-swatch" style="background:${escape(hex)}" aria-hidden="true"></span>
                <span class="start-color-hex">${escape(hex)}</span>
              </label>
            </li>`).join('')}
        </ul>
        <button type="button" class="be-cta start-cta--import" data-install-colors disabled>Use these colours</button>`);
      // The colour-review path builds its doc lazily from whichever boxes are
      // still checked at click time (see data-install-colors below) rather
      // than from importedDoc/data-install-import.
      return;
    }

    // A zip archive is either a Lolly BRAND FILE (tokens + fonts + theme,
    // installed in one step — no preview leg, because the pack carries its own
    // integrity map) or a Penpot project export (its FORMAL design tokens only
    // — Penpot shape/layer fills that aren't tied to a token are out of scope
    // here, same "prefer tokens" stance as the SVG path's opposite case).
    // Sniff the manifest once to route between the two; a .penpot file is a
    // zip archive under a different extension.
    if (/\.(zip|penpot)$/i.test(file.name) || file.type === 'application/zip') {
      if (file.size > 64 * 1024 * 1024) {
        showImportResult(`<p class="start-import-err">${escape(file.name)} is too large (max 64 MB).</p>`);
        return;
      }
      let files: Record<string, Uint8Array>;
      try {
        files = await unzipBrandBytes(await file.arrayBuffer());
      } catch (err) {
        showImportResult(`<p class="start-import-err">${escape(String((err as { message?: unknown })?.message ?? err))}</p>`);
        return;
      }
      const manifest = readManifest(files);

      if (manifest?.format === 'lolly-brand') {
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

      if (manifest?.type === 'penpot/export-files') {
        const { doc, warnings } = extractPenpotProject(files);
        if (!doc) {
          showImportResult(`<p class="start-import-err">No design tokens found in ${escape(file.name)}${warnings[0] ? ` — ${escape(warnings[0])}` : ''}. Try exporting an SVG instead so we can read its colours.</p>`);
          return;
        }
        importedDoc = doc;
        importedLabel = file.name.replace(/\.(penpot|zip)$/i, '') || 'My brand';
        const statLine = statLineFor(doc);
        showImportResult(`
          <p class="start-import-name">${escape(file.name)}<span class="start-import-source">penpot tokens</span></p>
          ${statLine ? `<p class="start-import-stats">${escape(statLine)}</p>` : ''}
          ${warnings.length ? `<p class="start-import-warn">${escape(warnings.join(' · '))}</p>` : ''}
          <button type="button" class="be-cta start-cta--import" data-install-import>Install these tokens</button>`);
        return;
      }

      showImportResult(`<p class="start-import-err">${escape(file.name)} isn't a brand file or a Penpot export we recognise.</p>`);
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
    const statLine = statLineFor(doc);
    showImportResult(`
      <p class="start-import-name">${escape(file.name)}<span class="start-import-source">${escape(source)}</span></p>
      ${statLine ? `<p class="start-import-stats">${escape(statLine)}</p>` : ''}
      ${warnings.length ? `<p class="start-import-warn">${escape(warnings.join(' · '))}</p>` : ''}
      <button type="button" class="be-cta start-cta--import" data-install-import>Install these tokens</button>`);
  });

  // Colour-review checkboxes (the SVG path): select all/none, enable "Use
  // these colours" only while at least one is checked, and build the doc from
  // whatever's checked at click time.
  importResult.addEventListener('input', (e) => {
    if (!(e.target as HTMLElement).matches('[data-color-idx]')) return;
    const installBtn = importResult.querySelector<HTMLButtonElement>('[data-install-colors]');
    const anyChecked = !!importResult.querySelector('[data-color-idx]:checked');
    if (installBtn) installBtn.disabled = !anyChecked;
  });
  importResult.addEventListener('click', (e) => {
    const all = (e.target as HTMLElement).closest('[data-colors-all]');
    const none = (e.target as HTMLElement).closest('[data-colors-none]');
    if (!all && !none) return;
    importResult.querySelectorAll<HTMLInputElement>('[data-color-idx]').forEach(cb => { cb.checked = !!all; });
    const installBtn = importResult.querySelector<HTMLButtonElement>('[data-install-colors]');
    if (installBtn) installBtn.disabled = !all;
  });

  // Delegated: the install button is re-created with every result render.
  importResult.addEventListener('click', (e) => {
    const importBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-install-import]');
    if (importBtn && importedDoc) { void install(importedDoc, importedLabel, importBtn); return; }

    const colorsBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-install-colors]');
    if (!colorsBtn) return;
    const swatches = importResult.querySelectorAll<HTMLElement>('.start-color-chip');
    const kept: string[] = [];
    swatches.forEach(li => {
      const cb = li.querySelector<HTMLInputElement>('[data-color-idx]');
      const raw = li.querySelector<HTMLElement>('.start-color-hex')?.textContent;
      const hex = raw && toHexForDerive(raw);
      if (cb?.checked && hex) kept.push(hex);
    });
    if (!kept.length) {
      showImportResult('<p class="start-import-err">None of the kept colours could be used — try a different selection.</p>');
      return;
    }
    const doc = deriveBrandTokens({ primary: kept[0]!, name: importedLabel });
    kept.slice(1).forEach((hex, i) => addSwatch(doc, 'custom', `Extracted ${i + 2}`, hex));
    void install(doc, importedLabel, colorsBtn);
  });

  // ── Floating "Save & begin" — the one explicit way out. Palette/font/logo
  // edits already persist immediately; saveDraft() covers the one thing that
  // doesn't — an unsaved Colour-panel derive, which teardown would otherwise
  // silently discard (see mountBrandEditor). Gives the wizard a single,
  // always-visible, unmistakable finish line instead of the old inline link
  // (removed above) plus whatever install button a given import path happens
  // to be showing.
  viewEl.querySelector<HTMLButtonElement>('#start-float-save')?.addEventListener('click', () => {
    editor?.saveDraft();
    window.location.hash = '#/';
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
    editor?.teardown();
  };
}
