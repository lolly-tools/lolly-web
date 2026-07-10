// SPDX-License-Identifier: MPL-2.0
/**
 * #/start — the brand studio, and the product's first impression for an
 * unbranded install. This is THE place brand primitives are set, saved,
 * edited and deleted; the Dashboard's Design-system tab renders the result
 * read-only, and user preferences (theme, sound) live on Profile. The studio
 * itself is lib/brand-editor.ts, mounted once with every panel wired; this
 * view owns what sits around it:
 *
 *   - the STEP TABS (Logos → Colours → Type → Tokens → Catalogue) — the editor
 *     renders all five panels and this view flips `data-active-tab` on it, so
 *     switching tabs never re-mounts anything;
 *   - the persistent ACTION ROW: Import… (a W3C/Tokens-Studio JSON, a Penpot
 *     file, an SVG's colours, or a Lolly brand file) and Export are always on;
 *     a primary "Save & continue" appears the moment anything changes and
 *     walks the user to the next step;
 *   - the FINISH card — after the last step, the three ways onward
 *     (Profile, or Tools / Projects / Dashboard).
 *
 * Everything persists to the one `user/tokens/brand` install via the bridge's
 * single write chokepoint (installUserTokens → bust). A LOCKED catalog owns its
 * brand and can't be adjusted, so the route degrades to a read-only note.
 * Esc or the Back link returns to the gallery. `?tab=<key>` deep-links a step.
 */

import '../styles/parts/start.css';       // this view's shell/layout (lazy chunk)
import { coerceTokensDoc, summarizeTokensDoc, extractPenpotProject, extractSvgColors, deriveBrandTokens } from '@lolly/engine';
import { installUserTokens } from '../bridge/tokens.ts';
import { applyChromeBrandVars } from '../brand-vars.ts';
import { mountBrandEditor, BRAND_TABS } from '../lib/brand-editor.ts';
import type { BrandTabKey } from '../lib/brand-editor.ts';
import { carryUserFontTokens } from '../user-fonts.ts';
import type { UserFontsHost } from '../user-fonts.ts';
import { unzipBrandBytes } from '../brand-transfer.ts';
import { addSwatch } from '../lib/brand-doc.ts';
import { markWelcomeDismissed, closeWelcomeDialog } from '../components/welcome-dialog.ts';
import { applyTheme } from '../theme.ts';
import { announce } from '../a11y.ts';
import { escape } from '../utils.ts';
import { playSfx } from '../lib/sfx.ts';
import { strFromU8 } from 'fflate';

/** The view container, which main.ts reads a teardown fn off (see navigate()). */
type ViewElement = HTMLElement & { _cleanup?: () => void };

/** Whatever host installUserTokens needs — stays in lock-step with the bridge. */
type StartHost = Parameters<typeof installUserTokens>[0];

const TAB_KEYS = new Set<string>(BRAND_TABS.map(t => t.id));

export async function mountStart(viewEl: HTMLElement, host: StartHost, params = ''): Promise<void> {
  document.title = 'Make it yours · Lolly';

  // A locked catalog is authoritative — its brand (colours, fonts, radius) can't
  // be adjusted; every write funnels through installUserTokens, which refuses. So
  // skip the whole studio and say why, rather than dead-ending on an error.
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

  const tabParam = new URLSearchParams(params).get('tab') ?? '';
  let activeTab: BrandTabKey = (TAB_KEYS.has(tabParam) ? tabParam : 'logos') as BrandTabKey;

  viewEl.innerHTML = `
    <div class="start start--studio">
      <a class="start-back" href="#/">&larr; Tools</a>
      <header class="start-head">
        <p class="start-eyebrow">Brand setup</p>
        <h1 class="start-title">Make it yours</h1>
        <p class="start-sub">Work through the steps — logos, colours, type, the other tokens, your files. Everything stays on this device, and every tool, page and export follows it.</p>
      </header>

      <!-- Step tabs: numbered, in working order. The next step nudges once the
           current one has changes, so the path forward is always visible. -->
      <nav class="start-tabs" role="tablist" aria-label="Brand setup steps">
        ${BRAND_TABS.map((t, i) => `
          <button type="button" class="start-tab${t.id === activeTab ? ' is-active' : ''}" role="tab"
            aria-selected="${t.id === activeTab}" aria-controls="start-panel-${t.id}" tabindex="${t.id === activeTab ? 0 : -1}"
            data-start-tab="${t.id}" id="start-tab-${t.id}">
            <span class="start-tab-n">${i + 1}</span><span class="start-tab-label">${escape(t.label)}</span>
          </button>`).join('')}
      </nav>

      <!-- The persistent action row: Import/Export always on; Save & continue
           appears on change. One row, one place, whichever step is open. -->
      <div class="start-actions" role="toolbar" aria-label="Brand actions">
        <button type="button" class="be-btn" data-start-import aria-expanded="false">Import&hellip;</button>
        <button type="button" class="be-btn" data-start-export data-sfx="whoosh">Export</button>
        <span class="start-actions-note" data-start-note aria-live="polite"></span>
        <button type="button" class="be-cta start-save" data-start-save hidden></button>
      </div>
      <div class="start-import-panel" data-start-import-panel hidden>
        <p class="start-import-blurb">Bring a <strong>W3C design-tokens / Tokens Studio</strong> JSON export, a <strong>Penpot</strong> file (its design tokens), an <strong>SVG</strong> (we'll read the colours it uses), or a Lolly <strong>brand file</strong> (.zip) someone shared.</p>
        <label class="be-btn start-import-btn">
          Choose a design or brand file&hellip;
          <input type="file" class="start-import-file" accept=".json,application/json,.penpot,.svg,image/svg+xml,.zip,application/zip" hidden>
        </label>
        <div class="start-import-result" hidden></div>
      </div>

      <div class="start-editor-wrap">
        <div class="start-editor-mount" data-start-editor><p class="start-editor-loading">Loading your brand…</p></div>
      </div>

      <!-- The way onward — revealed by finishing the last step. -->
      <section class="start-finish" data-start-finish hidden aria-label="All set">
        <h2 class="start-finish-title">Your brand is in force</h2>
        <p class="start-finish-sub">Every tool, page and export now follows it. Where to next?</p>
        <div class="start-finish-links">
          <a class="be-cta start-finish-primary" href="#/profile" data-sfx="click">Set up your Profile &rarr;</a>
          <span class="start-finish-or">or visit</span>
          <a class="be-btn" href="#/">Tools</a>
          <a class="be-btn" href="#/p">Projects</a>
          <a class="be-btn" href="#/d" data-sfx="dashboard">Dashboard</a>
        </div>
      </section>
    </div>`;

  // Mount liveness: #view itself is the router's persistent container (it never
  // disconnects — navigation just replaces its innerHTML), so "are we still the
  // mounted view" must be asked of a node THIS mount created.
  const shell = viewEl.querySelector<HTMLElement>('.start')!;
  const importResult = viewEl.querySelector<HTMLElement>('.start-import-result')!;
  const showImportResult = (html: string): void => {
    importResult.innerHTML = html;
    importResult.hidden = false;
  };

  // ── The studio (all five tab panels, mounted once) ───────────────────────────
  const editorMount = viewEl.querySelector<HTMLElement>('[data-start-editor]')!;
  const saveBtn = viewEl.querySelector<HTMLButtonElement>('[data-start-save]')!;
  const noteEl = viewEl.querySelector<HTMLElement>('[data-start-note]');
  const finishEl = viewEl.querySelector<HTMLElement>('[data-start-finish]')!;

  const tabIndex = (key: BrandTabKey): number => BRAND_TABS.findIndex(t => t.id === key);
  const nextTab = (key: BrandTabKey): BrandTabKey | null => BRAND_TABS[tabIndex(key) + 1]?.id ?? null;

  // "Save & continue" appears the moment a step reports a change (the editor's
  // onChange), labelled for where it goes; on the last step it becomes Finish.
  const syncSaveBtn = (show?: boolean): void => {
    if (show !== undefined) saveBtn.hidden = !show;
    const next = nextTab(activeTab);
    saveBtn.textContent = next ? 'Save & continue' : 'Save & finish';
  };
  const nudge = (tab: BrandTabKey): void => {
    const next = nextTab(tab);
    viewEl.querySelectorAll('.start-tab.is-nudge').forEach(t => t.classList.remove('is-nudge'));
    if (next && tab === activeTab) viewEl.querySelector(`[data-start-tab="${next}"]`)?.classList.add('is-nudge');
  };

  let editor: Awaited<ReturnType<typeof mountBrandEditor>> | null = null;
  try {
    editor = await mountBrandEditor(editorMount, host as unknown as Parameters<typeof mountBrandEditor>[1], {
      onChange: (tab) => {
        if (!shell.isConnected) return;
        syncSaveBtn(true);
        nudge(tab);
      },
    });
  } catch (err) {
    editorMount.innerHTML = `<p class="be-err">Couldn't open the brand editor: ${escape(String((err as { message?: unknown })?.message ?? err))}</p>`;
  }
  const editorRoot = editorMount.querySelector<HTMLElement>('[data-brand-editor]');
  // Complete the ARIA tabs contract on the editor's panel wrappers (the editor
  // renders them; only this view knows they're driven as tabs).
  editorRoot?.querySelectorAll<HTMLElement>('[data-be-tab-panel]').forEach(panel => {
    const key = panel.dataset.beTabPanel!;
    panel.id = `start-panel-${key}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `start-tab-${key}`);
  });

  // ── Tabs ─────────────────────────────────────────────────────────────────────
  const selectTab = (key: BrandTabKey, { focus = false } = {}): void => {
    activeTab = key;
    editor?.closeOverlays(); // a popover anchored to the outgoing tab must not linger
    editorRoot?.setAttribute('data-active-tab', key);
    viewEl.querySelectorAll<HTMLElement>('[data-start-tab]').forEach(btn => {
      const on = btn.dataset.startTab === key;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1; // roving tabindex — one tab stop for the strip
      if (on) btn.classList.remove('is-nudge');
      if (on && focus) btn.focus();
    });
    syncSaveBtn();
    // Keep the URL shareable without spamming history.
    try { history.replaceState(null, '', `#/start?tab=${key}`); } catch { /* sandboxed */ }
  };
  selectTab(activeTab);
  const tabsNav = viewEl.querySelector<HTMLElement>('.start-tabs');
  tabsNav?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-start-tab]');
    if (btn) { selectTab(btn.dataset.startTab as BrandTabKey); playSfx('click'); }
  });
  // Arrow-key navigation, per the ARIA tabs pattern (Left/Right wrap, Home/End).
  tabsNav?.addEventListener('keydown', (e) => {
    const keys = BRAND_TABS.map(t => t.id);
    const i = keys.indexOf(activeTab);
    let next: BrandTabKey | undefined;
    if (e.key === 'ArrowRight') next = keys[(i + 1) % keys.length];
    else if (e.key === 'ArrowLeft') next = keys[(i - 1 + keys.length) % keys.length];
    else if (e.key === 'Home') next = keys[0];
    else if (e.key === 'End') next = keys[keys.length - 1];
    if (!next) return;
    e.preventDefault();
    selectTab(next, { focus: true });
  });

  // ── Save & continue / finish ─────────────────────────────────────────────────
  const finish = (): void => {
    markWelcomeDismissed();
    closeWelcomeDialog();
    finishEl.hidden = false;
    finishEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    playSfx('saveProfile');
    announce('Brand saved — pick where to go next');
  };
  saveBtn.addEventListener('click', () => {
    editor?.saveDraft();
    saveBtn.hidden = true;
    const next = nextTab(activeTab);
    if (next) { selectTab(next, { focus: true }); playSfx('click'); }
    else finish();
  });

  // ── Export (always on) ───────────────────────────────────────────────────────
  const showNote = (msg: string, isError = false): void => {
    if (!noteEl) return;
    noteEl.textContent = msg;
    noteEl.classList.toggle('is-error', isError);
    if (msg) setTimeout(() => { if (noteEl.isConnected && noteEl.textContent === msg) noteEl.textContent = ''; }, 4000);
  };
  viewEl.querySelector<HTMLButtonElement>('[data-start-export]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (!editor) { showNote("The brand editor didn't open — reload to export.", true); return; }
    btn.disabled = true;
    try { const { filename } = await editor.exportPack(); showNote(`Exported ${filename}`); }
    catch (err) { showNote(String((err as { message?: unknown })?.message ?? err), true); }
    btn.disabled = false;
  });

  // ── Import panel toggle ──────────────────────────────────────────────────────
  const importBtn = viewEl.querySelector<HTMLButtonElement>('[data-start-import]');
  const importPanel = viewEl.querySelector<HTMLElement>('[data-start-import-panel]')!;
  importBtn?.addEventListener('click', () => {
    importPanel.hidden = !importPanel.hidden;
    importBtn.setAttribute('aria-expanded', String(!importPanel.hidden));
  });

  // ── Install (the JSON-import path funnels here) ──────────────────────────────
  // Unlike the old wizard (which bounced to the gallery), an install keeps the
  // user IN the studio: the editor reloads around the new tokens so the palette,
  // fonts and logos panels show what just landed, and the finish card offers the
  // ways onward.
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
      await editor?.reload();
      markWelcomeDismissed();
      installing = false;
      // The user may have navigated away while the install ran — the tokens
      // landed either way, but only a still-mounted view touches its own DOM
      // (or the URL: selectTab replaceStates, which would rewrite the NEW view's).
      if (!shell.isConnected) return;
      importPanel.hidden = true;
      importBtn?.setAttribute('aria-expanded', 'false');
      importResult.hidden = true;
      btn.disabled = false;
      btn.textContent = prevLabel;
      selectTab('color');
      announce(`${label} installed — the studio now shows it`);
      playSfx('saveProfile');
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
        if (!editor) {
          showImportResult('<p class="start-import-err">The brand editor didn\'t open — reload the page and try again.</p>');
          return;
        }
        showImportResult(`<p class="start-import-stats">Loading ${escape(file.name)}…</p>`);
        try {
          await editor.importPack(file);
          // The pack carries its own theme preference (prefs.json → localStorage);
          // apply it, same as the old wizard's pack path did.
          applyTheme(localStorage.getItem('theme') || 'light');
          markWelcomeDismissed();
          if (!shell.isConnected) return;
          importPanel.hidden = true;
          importBtn?.setAttribute('aria-expanded', 'false');
          importResult.hidden = true;
          selectTab('color');
          playSfx('saveProfile');
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
    const importBtnEl = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-install-import]');
    if (importBtnEl && importedDoc) { void install(importedDoc, importedLabel, importBtnEl); return; }

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

  // ── Escape returns to the gallery (colour-popover Escapes stopPropagation at
  //    the field, so they never reach this) ─────────────────────────────────────
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || installing) return; // no Esc-teardown mid-install
    e.preventDefault();
    // An open import panel folds first; a second Esc leaves.
    if (!importPanel.hidden) {
      importPanel.hidden = true;
      importBtn?.setAttribute('aria-expanded', 'false');
      return;
    }
    window.location.hash = '#/';
  };
  document.addEventListener('keydown', onKey);
  (viewEl as ViewElement)._cleanup = () => {
    document.removeEventListener('keydown', onKey);
    editor?.teardown();
  };
}
