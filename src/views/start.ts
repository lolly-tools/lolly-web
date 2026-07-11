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
import type { BrandTabKey, BrandEditorHandle } from '../lib/brand-editor.ts';
import { setupMobileSheet } from '../lib/mobile-sheet.ts';
import type { MobileSheetHandle } from '../lib/mobile-sheet.ts';
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

// ── The import card's format marks ───────────────────────────────────────────
// Recognition beats description: the four accepted formats lead the card as
// icon tiles, in preference order. Lolly's own brand file wears the full-colour
// app mark; the rest are mono inline SVGs on currentColor so they follow the
// theme like any glyph.
const PENPOT_ICON = `<svg viewBox="0 -1 7.6 10.075" width="26" height="26" fill="none" stroke="currentColor" stroke-width="0.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M 1.1,2.4513642 V 0.65136419 l 0.9,-1.3 0.9,1.3 V 1.0513642 L 3.8,-0.24863581 4.7,1.0513642 V 0.65136419 l 0.9,-1.3 0.9,1.3 V 2.4513642 m -2.7,1.4 v 5 m -2.7,-7.3 -0.9,0.5 v 5 l 3.6,1.8 3.6,-1.8 v -5 l -0.9,-0.5 m -6.3,0.5 3.6,1.8 3.6,-1.8 m -4.5,-1 v 2.3 m 1.8,-2.3 v 2.3 m -3,-3.50000001 h 0.6 m 1.2,0.4 h 0.6 m 1.2,-0.4 h 0.6"/><path stroke-width="0.3" d="m 1.1,0.85136419 h 1.8 m 0,0.40000001 h 1.8 m 0,-0.40000001 h 1.8 m -4.5,0 V 2.8513642 m 1.8,-1.6 v 2.6 M 5.6,0.85136419 V 2.9513642"/></svg>`;
const TOKENS_ICON = `<svg viewBox="0 0 26.0005 20.000443" width="28" height="22" fill="currentColor" aria-hidden="true"><path d="M 21.034696,6.7857749 C 19.657911,6.5152605 18.584202,5.5233742 18.29198,4.2542941 17.730078,1.8096451 14.90387,1.0874383 13.00025,2.0851691 c 0.772302,0.5310098 1.294128,1.3408833 1.415191,2.2584616 0.04342,0.2554858 0.123569,0.5059622 0.223759,0.7480893 a 3.6987005,3.6987005 0 0 0 1.576331,1.7341311 c 0.435829,0.2563208 0.936782,0.3899082 1.422706,0.5176511 0.399092,0.1319176 0.764788,0.3256193 1.071204,0.582775 1.284108,1.0219434 1.284108,3.1267798 0,4.1487228 -0.306416,0.257156 -0.672112,0.450857 -1.071204,0.582775 -0.484254,0.127743 -0.986877,0.260495 -1.422706,0.517651 -0.921753,0.515146 -1.619747,1.436064 -1.80009,2.482221 -0.121063,0.918413 -0.642889,1.728286 -1.415191,2.259296 1.90195,0.996061 4.728158,0.272184 5.29173,-2.16996 0.292222,-1.26908 1.365931,-2.260966 2.742716,-2.531481 3.75965,-0.737235 3.75965,-5.6908219 0,-6.4288921 z M 11.585059,15.658481 A 3.5066687,3.5066687 0 0 0 11.3613,14.909557 3.6987005,3.6987005 0 0 0 9.7849688,13.175426 C 9.34914,12.91994 8.8481873,12.786353 8.3622632,12.657775 A 3.2561923,3.2561923 0 0 1 7.2910594,12.075 c -1.2841087,-1.021943 -1.2841087,-3.1267794 0,-4.1487228 C 7.5974755,7.6691215 7.9631709,7.4754198 8.3622632,7.3435022 8.8465175,7.2149244 9.34914,7.0830069 9.7849688,6.8258511 10.707557,6.3107048 11.404716,5.3897868 11.585059,4.3427958 11.706122,3.4243825 12.227948,2.614509 13.00025,2.0843341 11.0983,1.0874383 8.2720917,1.8096451 7.70852,4.2534592 7.4162976,5.5225393 6.3417541,6.5152605 4.9658041,6.78494 c -3.7596498,0.7380703 -3.7596498,5.692492 0,6.429727 1.3751151,0.26968 2.4504935,1.262401 2.7427159,2.531481 0.5619019,2.443814 3.38811,3.166856 5.29173,2.169125 -0.772302,-0.53101 -1.294128,-1.340883 -1.415191,-2.258461 z"/></svg>`;
const SVG_ICON = `<svg viewBox="0 0 390 390" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="m 216.63,37.47 53.15,53.98 c 5.04,5.15 4.97,15.13 2.15,18 L 245.54,88.34 240.35,119.6 218.3,107.96 182.99,130.27 171.3,83.24 152.33,116.06 h -29 c -11.82,0 -13.21,-15 -2.47,-25.74 18.76,-20.25 40.29,-40.89 51.99,-52.85 11.76,-12.02 32.25,-11.68 43.78,0 z M 131,238.6 c 3.59,2.23 57.89,13.26 71.16,15.46 4.6,0.97 1.34,5.71 -5,8.91 C 182.86,266.77 113.5,238.6 131,238.6 Z M 163.15,27.83 28.81,165.3 C -16.58,221.51 59.7,214.97 92.4,231.16 104.13,243.15 47.44,252 59.17,264 c 11.73,11.99 70.93,23.1 82.68,35.09 11.73,11.99 -24.01,24.71 -12.28,36.7 11.73,11.99 38.86,0.63 43.94,28.31 3.62,19.78 48.89,8.5 71.03,-7.7 11.73,-12 -22.44,-10.87 -10.71,-22.86 29.17,-29.83 56.33,-10.84 66.31,-40.73 4.93,-14.77 -42.94,-22.77 -31.19,-34.76 33.75,-19.71 150.4,-32.54 95.05,-87.89 L 224.75,27.83 c -17.03,-16.35 -45.45,-16.53 -61.6,0 z m 154.31,264.98 c 0,6.82 50.25,11.29 50.25,-1.61 -7.16,-20.72 -44.31,-19.32 -50.25,1.61 z M 91.1,329.05 c 11.9,10.29 30.28,-2.56 35.79,-16.92 -11.53,-15.32 -54.69,0.55 -35.79,16.92 z m 220.06,-22.23 c -15.34,13.76 1.72,27.72 16.84,18.83 3.37,-3.42 -0.09,-15.41 -16.84,-18.83 z"/></svg>`;

const IMPORT_FORMATS: ReadonlyArray<{ icon: string; name: string; ext: string }> = [
  { icon: `<img src="/icons/icon-192.png" alt="" width="26" height="26" decoding="async">`, name: 'LollyBrand', ext: '.zip' },
  { icon: PENPOT_ICON, name: 'Penpot', ext: '.penpot' },
  { icon: TOKENS_ICON, name: 'Design Tokens', ext: '.json' },
  { icon: SVG_ICON, name: 'Plain SVG', ext: '.svg' },
];

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
        <button type="button" class="be-btn" data-start-import aria-expanded="false">↓ Import&hellip;</button>
        <button type="button" class="be-btn" data-start-export data-sfx="whoosh">↑ Export</button>
        <span class="start-actions-note" data-start-note aria-live="polite"></span>
        <button type="button" class="be-cta start-save" data-start-save hidden></button>
      </div>
      <div class="start-import-panel" data-start-import-panel hidden>
        <!-- The whole card is the control: click anywhere (it's the file input's
             label) or drop a file on it. The format tiles lead so people
             recognise THEIR export at a glance, in preference order. -->
        <label class="start-import-drop" data-start-import-drop>
          <input type="file" class="start-import-file visually-hidden" accept=".json,application/json,.penpot,.svg,image/svg+xml,.zip,application/zip" aria-label="Choose a design or brand file">
          <span class="start-import-formats" role="list" aria-label="Accepted formats, in preference order">
            ${IMPORT_FORMATS.map(f => `
              <span class="start-import-fmt" role="listitem">
                <span class="start-import-fmt-icon" aria-hidden="true">${f.icon}</span>
                <span class="start-import-fmt-name">${escape(f.name)}</span>
                <span class="start-import-fmt-ext">${escape(f.ext)}</span>
              </span>`).join('')}
          </span>
          <span class="be-btn start-import-btn" aria-hidden="true">Choose a design or brand file&hellip;</span>
          <span class="start-import-drophint">or drag &amp; drop it here</span>
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

  // ── Mobile palette sheet (≤640px) — mounted only while the Colour tab shows,
  // and only when the editor actually mounted (a locked build renders no studio;
  // a failed mount leaves editor null / editorRoot missing — nothing to mirror).
  // Torn down on every tab switch away and on view unmount.
  let paletteSheet: PaletteSheet | null = null;
  const syncPaletteSheet = (): void => {
    const want = activeTab === 'color' && editor !== null && !!editorRoot;
    if (want && !paletteSheet) paletteSheet = mountPaletteSheet(shell, editor!, editorRoot!);
    else if (!want && paletteSheet) { paletteSheet.teardown(); paletteSheet = null; }
  };

  // ── Tabs ─────────────────────────────────────────────────────────────────────
  const selectTab = (key: BrandTabKey, { focus = false } = {}): void => {
    activeTab = key;
    editor?.closeOverlays(); // a popover anchored to the outgoing tab must not linger
    editorRoot?.setAttribute('data-active-tab', key);
    syncPaletteSheet();
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
    if (file) await handleImportFile(file);
  });

  // Drag & drop lands on the same routing as the picker — the card is one
  // control with two mouths.
  const dropEl = viewEl.querySelector<HTMLElement>('[data-start-import-drop]')!;
  dropEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dropEl.classList.add('is-dragover');
  });
  dropEl.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && dropEl.contains(e.relatedTarget as Node)) return;
    dropEl.classList.remove('is-dragover');
  });
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.classList.remove('is-dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleImportFile(file);
  });

  async function handleImportFile(file: File): Promise<void> {
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
  }

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
    // The Esc stack: floating popovers first (they close themselves and
    // stopImmediatePropagation before this handler — the query is a
    // belt-and-braces guard so the sheet never folds under a popover that
    // somehow let the key through), then an expanded palette sheet folds to
    // peek, then the import panel, then back to the gallery.
    const popoverOpen = !!editorMount.querySelector(
      '[data-be-editor]:not([hidden]), [data-grad-pop]:not([hidden]), .color-picker-field:not(.color-field--inline) .color-popover:not([hidden])');
    if (!popoverOpen && paletteSheet?.collapse()) { e.preventDefault(); return; }
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
    paletteSheet?.teardown();
    paletteSheet = null;
    editor?.teardown();
  };
}

// ── Mobile palette sheet (≤640px, Colour tab only) ───────────────────────────
// A fixed bottom sheet + sibling grip (both DIRECT children of `.start`, which
// the CSS specificity depends on — see brand-studio.css) mirroring the
// COMMITTED palette so it stays visible while the derive/generate panels
// scroll; the desktop split side pane serves ≥1100px, this serves phones. The
// mirror is READ-ONLY and never reparents live tiles: tapping a chip snaps the
// sheet to peek FIRST, then centres the real [data-be-tile] and forwards a
// click, so the swatch editor opens on the real grid above the peek strip.
// It re-renders off the palette-change seam (editor.onPalette — fired from
// BOTH repaintPalette and persist(), double-fires included), by re-reading the
// grid the editor just painted — the same walkSwatches output, same theme.
interface PaletteSheet {
  /** Fold an expanded sheet back to peek; true when the Esc was consumed. */
  collapse: () => boolean;
  teardown: () => void;
}

function mountPaletteSheet(shell: HTMLElement, editor: BrandEditorHandle, editorRoot: HTMLElement): PaletteSheet {
  const sheet = document.createElement('div');
  sheet.className = 'stu-sheet';
  sheet.setAttribute('role', 'region');
  sheet.setAttribute('aria-label', 'Your palette');
  sheet.innerHTML = `
    <div class="stu-sheet-head">
      <div class="stu-sheet-strip" data-stu-strip aria-label="Brand palette"></div>
    </div>
    <div class="stu-sheet-body" data-stu-groups></div>`;
  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'stu-sheet-grip';
  grip.setAttribute('aria-label', 'Drag to resize the palette, tap to expand');
  shell.append(sheet, grip);

  const stripEl = sheet.querySelector<HTMLElement>('[data-stu-strip]')!;
  const groupsEl = sheet.querySelector<HTMLElement>('[data-stu-groups]')!;
  let handle: MobileSheetHandle | null = null;

  const chipHtml = (t: HTMLElement): string => {
    const sw = t.style.getPropertyValue('--sw').trim() || 'transparent';
    const label = t.getAttribute('aria-label') ?? '';
    return `<button type="button" class="stu-chip" data-stu-tile="${escape(t.dataset.beTile ?? '')}"
      style="--sw:${escape(sw)}" aria-label="${escape(label)}" title="${escape(label)}"></button>`;
  };
  const render = (): void => {
    let stripHtml = '', bodyHtml = '';
    editorRoot.querySelectorAll<HTMLElement>('[data-be-pal] .be-pal-group').forEach(g => {
      // The group label's first node is the name text (a count <span> follows).
      const name = g.querySelector('.be-pal-group-label')?.firstChild?.textContent?.trim() ?? 'Colours';
      const chips = [...g.querySelectorAll<HTMLElement>('[data-be-tile]')].map(chipHtml).join('');
      if (!chips) return;
      stripHtml += chips;
      bodyHtml += `
        <div class="stu-sheet-group">
          <span class="stu-sheet-group-label">${escape(name)}</span>
          <div class="stu-sheet-grid">${chips}</div>
        </div>`;
    });
    stripEl.innerHTML = stripHtml;
    groupsEl.innerHTML = bodyHtml;
    handle?.refresh(); // the peek strip's height may have changed — re-measure
  };
  render(); // populate BEFORE the driver mounts so its first peek measure is real

  handle = setupMobileSheet(shell, sheet, grip, {
    anchor: 'bottom',
    initial: 'peek', // the always-visible guarantee, without burying the page
    names: {
      heightVar: '--stu-sheet-h',
      stateAttr: 'data-stu-sheet',
      peekVar: '--stu-peek-h',
      draggingClass: 'is-stu-sheet-dragging',
      headerSel: '.stu-sheet-head',
    },
  });

  // The driver's grip handling is pointer-only, so keyboard activation
  // (Enter/Space — a click with detail 0 and no pointer sequence) would
  // otherwise do nothing on a focusable button. Step through the stops with
  // the same bounce as a tap; real pointer taps (detail ≥ 1) already went
  // through the driver's pointerup, so they're ignored here.
  let keyDir: 1 | -1 = 1;
  grip.addEventListener('click', (e) => {
    if (e.detail !== 0 || !handle) return;
    const states = ['peek', 'half', 'full'] as const;
    const idx = Math.max(0, states.indexOf(handle.state()));
    if (idx === 0) keyDir = 1;
    else if (idx === states.length - 1) keyDir = -1;
    handle.setState(states[idx + keyDir]!);
  });

  const unsubPalette = editor.onPalette(render);
  const refresh = (): void => handle?.refresh();
  const mql = window.matchMedia('(max-width: 640px)');
  window.addEventListener('orientationchange', refresh);
  mql.addEventListener('change', refresh); // a display:none-at-mount head measures 0 — re-measure when the sheet appears

  // Tap = navigate, not edit-in-place.
  sheet.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-stu-tile]');
    if (!chip) return;
    handle?.setState('peek');
    const tile = editorRoot.querySelector<HTMLElement>(`[data-be-tile="${chip.dataset.stuTile}"]`);
    if (!tile) return;
    // The tile's palette group is a <details> the user may have folded — a
    // hidden tile can't be scrolled to or anchor the editor popover, so unfold.
    const group = tile.closest<HTMLDetailsElement>('details.be-pal-group');
    if (group && !group.open) group.open = true;
    tile.scrollIntoView({ block: 'center' });
    tile.click();
  });

  return {
    collapse: () => {
      if (!mql.matches || !handle || handle.state() === 'peek') return false;
      handle.setState('peek');
      return true;
    },
    teardown: () => {
      unsubPalette();
      window.removeEventListener('orientationchange', refresh);
      mql.removeEventListener('change', refresh);
      handle?.teardown();
      sheet.remove();
      grip.remove();
    },
  };
}
