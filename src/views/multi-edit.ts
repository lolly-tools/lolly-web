// SPDX-License-Identifier: MPL-2.0
/**
 * Multi-edit — 2–8 saved sessions edited side by side (#/multi?s=slot,slot…).
 *
 * The batch grid (/pro) stays the power path for large render queues; this view
 * is the *editing* counterpart for a small, manageable selection: a grid of live
 * canvases (one engine runtime per session — the same createRuntime → hydrate →
 * paint path as the single-tool view) and ONE combined sidebar:
 *
 *   • "Shared" — a collapsible card of every input declared (same id, same type,
 *     same constraints — the /pro column-merge rule) by 2+ of the selected
 *     sessions. Editing a shared control fans the value out to every session
 *     that declares the input, live.
 *   • One collapsed card per session with ALL of its own inputs — rendered by
 *     the SAME renderInputs/syncInputs the tool sidebar uses (full fidelity:
 *     asset pickers, blocks, colour fields) — plus a condensed export block
 *     (format + width/height/unit/dpi + download; no copy/save/share tiers).
 *   • A search field that filters controls across every card.
 *
 * Clicking a canvas opens + scrolls to that session's card. "Save all" writes
 * every session back to its slot; "Download all" renders each through the same
 * offscreen export path the batch grid uses (pro/render-export.renderRowToBlob).
 *
 * Reuse, not reinvention: controls come from tool-inputs.ts, canvas lifecycle
 * from render-lifecycle/scope-css/embed, session storage from bridge/state, and
 * the shared-input rule from pro/model.constraintSignature.
 */
import '../styles/parts/tool.css';        // .tool-inputs control styles (shared chunk with the tool view)
import '../styles/parts/multi-edit.css';
import { createRuntime, UNITS } from '@lolly/engine';
import { getTool, chooseFormat, isExportable } from '../bridge/tool-loader.ts';
import { neutralizeEmbeds, hydrateEmbeds } from '../bridge/embed.ts';
import { runTemplateScripts } from '../lib/render-lifecycle.ts';
import { scopeCss } from '../lib/scope-css.ts';
import { syncInputs } from './tool-inputs.ts';
import { escape } from '../utils.ts';
import { announce } from '../a11y.ts';
import { t } from '../i18n.ts';
import { langFabHtml, attachLangMenu } from '../components/lang-menu.ts';
import { mountZoomHud } from '../components/zoom-hud.ts';

import type { WebToolHost, PanelEl } from './tool.ts';
import type { InputModelItem, InputValue, InputSpec } from '../../../../engine/src/inputs.js';
import type { LoadedTool } from '../../../../engine/src/loader.js';
import type { Runtime } from '../../../../engine/src/runtime.js';
import type { Unit } from '../../../../engine/src/units.js';
import type { SavedStateData, WebStateAPI } from '../bridge/state.ts';

interface ViewElement extends HTMLElement { _cleanup?: () => void; }

/** One mounted session: its record, tool, runtime and per-cell paint state. */
interface Member {
  slot: string;
  label: string;
  toolName: string;
  tool: LoadedTool;
  runtime: Runtime;
  data: SavedStateData;
  thumb: string | null;
  canvasEl: HTMLElement;
  panelEl: PanelEl;
  panelModel: InputModelItem[] | null;
  lastPainted: string | null;
  paintRaf: number;
  renderGen: number;
  dirty: boolean;
}

const MIN_SEL = 2;
const MAX_SEL = 8;

// Preview-zoom bounds. Card width is a single CSS var on the grid; auto-fill
// reflows the columns to fit. Each press multiplies/divides by ZOOM_STEP ("a few
// factors"); "Fit" jumps to the largest size at which every design still fits the
// viewport. Persisted per-browser so a chosen size survives revisits.
const ZOOM_MIN = 160;
const ZOOM_MAX = 1100;
const ZOOM_STEP = 1.25;
const ZOOM_KEY = 'me-zoom-cardw';

const svg = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ZOOM_OUT_ICON = svg('<line x1="5" y1="12" x2="19" y2="12"/>');
const ZOOM_IN_ICON = svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>');
const FIT_ICON = svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>');

/** Current values of a runtime's model as a plain map (what a session persists). */
function modelValues(runtime: Runtime): Record<string, InputValue> {
  return Object.fromEntries(runtime.getModel().map(i => [i.id, i.value]));
}

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export async function mountMultiEdit(viewEl: ViewElement, host: WebToolHost, params: string): Promise<void> {
  const slots = (new URLSearchParams(params).get('s') ?? '')
    .split(',').map(s => decodeURIComponent(s.trim())).filter(Boolean);

  const fail = (msg: string): void => {
    viewEl.innerHTML = `
      <div class="me-error">
        <p>${escape(msg)}</p>
        <a class="btn" href="#/p">Back to Projects</a>
      </div>`;
  };
  if (slots.length < MIN_SEL || slots.length > MAX_SEL) {
    fail(`Multi-edit works on ${MIN_SEL}–${MAX_SEL} saved sessions — got ${slots.length}.`);
    return;
  }

  // ── Load sessions + tools, one runtime each ────────────────────────────────
  // The web shell's state surface (list() with thumbs, typed load()) — HostV1's
  // StateAPI is the narrow portable contract, this view is web-only.
  const state = host.state as unknown as WebStateAPI;
  const entries = await state.list();
  const bySlot = new Map(entries.map(e => [e.slot, e]));
  const members: Member[] = [];
  for (const slot of slots) {
    const entry = bySlot.get(slot);
    const data = await state.load(slot);
    if (!entry || !data) { fail('A selected session no longer exists.'); return; }
    const toolId = String(data.__toolId ?? entry.toolId ?? '');
    let tool: LoadedTool;
    try { tool = await getTool(toolId); }
    catch { fail(`The tool "${toolId}" for one session isn't in this catalog.`); return; }
    const values: Record<string, InputValue> = {};
    for (const [k, v] of Object.entries(data)) if (!k.startsWith('__')) values[k] = v as InputValue;
    const runtime = await createRuntime(tool, host, values);
    members.push({
      slot,
      label: String(entry.label || data.__label || tool.manifest.name || toolId),
      toolName: tool.manifest.name ?? toolId,
      tool, runtime, data,
      thumb: entry.thumb ?? null,
      canvasEl: null as unknown as HTMLElement,
      panelEl: null as unknown as PanelEl,
      panelModel: null,
      lastPainted: null,
      paintRaf: 0,
      renderGen: 0,
      dirty: false,
    });
  }

  // ── Shared inputs: same id + same type + same constraints on 2+ sessions ───
  // The /pro grid's column-merge rule (pro/model.deriveColumns), recomputed per
  // SESSION rather than per tool so two sessions of the same tool still share.
  const { constraintSignature } = await import('../pro/model.ts');
  interface SharedEntry { id: string; lead: Member; count: number; }
  const shared: SharedEntry[] = [];
  {
    const byId = new Map<string, { decl: InputSpec; members: Member[]; sigs: Set<string> }>();
    for (const m of members) {
      for (const input of (m.tool.manifest.inputs ?? []) as InputSpec[]) {
        if (!input || typeof input.id !== 'string') continue;
        if ((input as { group?: string }).group === 'export') continue; // sheet-owned, not sidebar inputs
        const cur = byId.get(input.id);
        if (!cur) byId.set(input.id, { decl: input, members: [m], sigs: new Set([constraintSignature(input)]) });
        else { cur.members.push(m); cur.sigs.add(constraintSignature(input)); }
      }
    }
    for (const [id, col] of byId) {
      if (col.members.length < 2) continue;
      if (new Set(col.members.map(m => (m.tool.manifest.inputs ?? []).find(i => i.id === id)?.type)).size !== 1) continue;
      if (col.sigs.size !== 1) continue;
      shared.push({ id, lead: col.members[0]!, count: col.members.length });
    }
  }
  const sharedIds = new Set(shared.map(s => s.id));
  const sharedMembersOf = (id: string): Member[] =>
    members.filter(m => (m.tool.manifest.inputs ?? []).some(i => i.id === id));

  // ── Markup ──────────────────────────────────────────────────────────────────
  const cellHtml = (m: Member, i: number): string => {
    const w = m.tool.manifest.render?.width ?? 800;
    const h = m.tool.manifest.render?.height ?? 600;
    return `
      <figure class="me-cell" data-me-cell="${i}" tabindex="0" role="button"
        aria-label="${escape(t('Show the inputs for {label}', { label: m.label }))}">
        <div class="me-stage" style="aspect-ratio:${w} / ${h}">
          <div class="me-scale" data-me-scale="${i}" style="width:${w}px;height:${h}px">
            <div class="me-canvas" id="me-c${i}"></div>
          </div>
        </div>
        <figcaption class="me-cap">
          <span class="me-cap-label">${escape(m.label)}</span>
          <span class="me-cap-tool">${escape(m.toolName)}</span>
        </figcaption>
      </figure>`;
  };

  const exportBlockHtml = (m: Member, i: number): string => {
    const formats = (m.tool.manifest.render?.formats ?? []).filter(f => f !== 'html');
    const fmt = chooseFormat(m.tool.manifest, String(m.data.__export_format ?? '') || undefined);
    const w = String(m.data.__export_width ?? '');
    const h = String(m.data.__export_height ?? '');
    const unit = String(m.data.__export_unit ?? 'px');
    const dpi = String(m.data.__export_dpi ?? '');
    if (!isExportable(m.tool.manifest)) return `<p class="me-export-note">${t('This tool is render-only — it has no file export.')}</p>`;
    return `
      <div class="me-export" data-me-export="${i}">
        <span class="me-export-label">${t('Export')}</span>
        <label class="me-exp-field">${t('Format')}
          <select data-me-fmt="${i}">${formats.map(f => `<option value="${escape(f)}"${f === fmt ? ' selected' : ''}>${escape(f.toUpperCase())}</option>`).join('')}</select>
        </label>
        <label class="me-exp-field">${t('W')} <input type="number" min="1" inputmode="numeric" placeholder="${escape(t('auto'))}" data-me-w="${i}" value="${escape(w)}"></label>
        <label class="me-exp-field">${t('H')} <input type="number" min="1" inputmode="numeric" placeholder="${escape(t('auto'))}" data-me-h="${i}" value="${escape(h)}"></label>
        <label class="me-exp-field">${t('Unit')}
          <select data-me-unit="${i}">${UNITS.map(u => `<option value="${u}"${u === unit ? ' selected' : ''}>${u}</option>`).join('')}</select>
        </label>
        <label class="me-exp-field me-exp-dpi" ${unit === 'px' ? 'hidden' : ''}>${t('DPI')} <input type="number" min="1" inputmode="numeric" placeholder="300" data-me-dpi="${i}" value="${escape(dpi)}"></label>
        <button type="button" class="btn me-download" data-me-download="${i}" data-sfx="whoosh">${t('Download')}</button>
      </div>`;
  };

  viewEl.innerHTML = `
    <div class="me-layout">
      <header class="me-head">
        <a class="me-back" href="#/p" aria-label="${escape(t('Back to Projects'))}">←</a>
        <h1 class="me-title">${t('Multi-edit')} <span class="me-count">${t('{n} designs', { n: members.length })}</span></h1>
        <div class="me-head-actions">
          <button type="button" class="btn" data-me-saveall data-sfx="save">${t('Save all')}</button>
          <button type="button" class="btn me-primary" data-me-downloadall data-sfx="whoosh">${t('Download all')}</button>
          ${langFabHtml()}
        </div>
      </header>
      <div class="me-body">
        <aside class="me-sidebar" aria-label="${escape(t('Combined inputs'))}">
          <div class="me-search">
            <input type="search" placeholder="${escape(t('Filter inputs…'))}" aria-label="${escape(t('Filter inputs'))}" data-me-search>
          </div>
          <details class="me-card me-card--shared" data-me-shared-card ${shared.length ? 'open' : ''} ${shared.length ? '' : 'hidden'}>
            <summary><span class="me-card-title">${t('Shared')}</span><span class="me-card-count">${shared.length === 1 ? t('1 input · applies to every design') : t('{n} inputs · applies to every design', { n: shared.length })}</span></summary>
            <div class="tool-inputs me-inputs" data-me-shared-panel></div>
          </details>
          ${members.map((m, i) => `
          <details class="me-card" data-me-card="${i}">
            <summary><span class="me-card-title">${escape(m.label)}</span><span class="me-card-count">${escape(m.toolName)}</span></summary>
            <div class="tool-inputs me-inputs" data-me-panel="${i}"></div>
            ${exportBlockHtml(m, i)}
          </details>`).join('')}
        </aside>
        <div class="me-gridwrap">
          <div class="me-gridbar">
            <div class="me-zoom" data-me-zoom></div>
          </div>
          <div class="me-grid" data-me-grid>
            ${members.map(cellHtml).join('')}
          </div>
        </div>
      </div>
    </div>`;

  const cleanups: Array<() => void> = [];

  cleanups.push(attachLangMenu(viewEl.querySelector<HTMLElement>('.lang-fab'), host));

  // Declared ahead of the cell loop: runtime.subscribe emits synchronously, so
  // scheduleSidebar (hoisted fn) runs before the sidebar block below is reached.
  let sidebarRaf = 0;

  // ── Canvas cells: scoped styles + rAF-coalesced live paint per runtime ─────
  members.forEach((m, i) => {
    m.canvasEl = viewEl.querySelector<HTMLElement>(`#me-c${i}`)!;
    m.panelEl = viewEl.querySelector<PanelEl>(`[data-me-panel="${i}"]`)!;
    if (m.tool.styles) {
      const styleEl = document.createElement('style');
      styleEl.textContent = scopeCss(m.tool.styles, `#me-c${i}`);
      m.canvasEl.before(styleEl);
    }
    const w = m.tool.manifest.render?.width ?? 800;
    // Scale the native-size canvas to the cell (transform, so tool layout math
    // sees its true pixel size — same trick as the single-tool stage fit).
    const scaleHost = viewEl.querySelector<HTMLElement>(`[data-me-scale="${i}"]`)!;
    const stage = scaleHost.parentElement!;
    const ro = new ResizeObserver(() => {
      const s = stage.clientWidth / w;
      scaleHost.style.transform = `scale(${s})`;
    });
    ro.observe(stage);
    cleanups.push(() => ro.disconnect());

    const paint = (): void => {
      m.paintRaf = 0;
      const hydrated = m.runtime.getHydrated();
      if (hydrated === m.lastPainted) return;
      const gen = ++m.renderGen;
      try {
        m.canvasEl.innerHTML = neutralizeEmbeds(hydrated);
        runTemplateScripts(m.canvasEl);
        void hydrateEmbeds(m.canvasEl, { host, isCurrent: () => gen === m.renderGen });
        m.lastPainted = hydrated;
      } catch (err) {
        console.warn('multi-edit paint failed:', err);
      }
    };
    const schedulePaint = (): void => { if (!m.paintRaf) m.paintRaf = requestAnimationFrame(paint); };
    schedulePaint();
    cleanups.push(m.runtime.subscribe(() => { schedulePaint(); scheduleSidebar(); }));
    cleanups.push(() => { if (m.paintRaf) cancelAnimationFrame(m.paintRaf); });
  });

  // ── The combined sidebar ────────────────────────────────────────────────────
  // Shared card: a fan-out "runtime" — the ONLY members renderInputs touches are
  // setInput and getModel (verified), so this adapter is the full contract it
  // exercises. setInput writes to every session that declares the input.
  const sharedPanel = viewEl.querySelector<PanelEl>('[data-me-shared-panel]');
  let sharedModelPrev: InputModelItem[] | null = null;
  const sharedModel = (): InputModelItem[] =>
    shared.flatMap(({ id, lead }) => {
      const item = lead.runtime.getModel().find(it => it.id === id);
      // showIf deps may live outside the shared set — always show shared items.
      return item ? [{ ...item, showIf: undefined }] : [];
    });
  const fanRuntime = {
    async setInput(id: string, value: InputValue): Promise<void> {
      for (const m of sharedMembersOf(id)) { await m.runtime.setInput(id, value); m.dirty = true; }
    },
    getModel: () => sharedModel(),
  } as unknown as Runtime;

  // Per-panel sync with a focus guard: a rebuild of one card must never steal
  // focus from the control being typed in inside ANOTHER card (renderInputs
  // restores focus by data-input-id, and ids repeat across cards).
  const syncGuarded = (fn: () => void): void => {
    const before = document.activeElement as HTMLElement | null;
    fn();
    const after = document.activeElement as HTMLElement | null;
    if (before && before.isConnected && after !== before) before.focus({ preventScroll: true });
  };

  function syncSidebar(): void {
    sidebarRaf = 0;
    if (sharedPanel && shared.length) {
      syncGuarded(() => { sharedModelPrev = syncInputs(sharedPanel, sharedModel(), sharedModelPrev, fanRuntime, host, () => { /* dirty set in fan-out */ }); });
    }
    members.forEach((m, i) => {
      const card = viewEl.querySelector<HTMLDetailsElement>(`details[data-me-card="${i}"]`);
      if (!card?.open) { m.panelModel = null; return; } // sync lazily on open
      const model = m.runtime.getModel();
      syncGuarded(() => { m.panelModel = syncInputs(m.panelEl, model, m.panelModel, m.runtime, host, () => { m.dirty = true; }); });
    });
  }
  function scheduleSidebar(): void { if (!sidebarRaf) sidebarRaf = requestAnimationFrame(syncSidebar); }
  syncSidebar();
  cleanups.push(() => { if (sidebarRaf) cancelAnimationFrame(sidebarRaf); });

  // Opening a collapsed card renders its (lazily-skipped) panel.
  viewEl.querySelectorAll<HTMLDetailsElement>('details[data-me-card]').forEach(card => {
    card.addEventListener('toggle', () => { if (card.open) scheduleSidebar(); });
  });

  // ── Grid → sidebar: click a canvas, open + scroll to its card ──────────────
  const activateCell = (i: number): void => {
    viewEl.querySelectorAll('.me-cell').forEach((c, ci) => c.classList.toggle('is-active', ci === i));
    const card = viewEl.querySelector<HTMLDetailsElement>(`details[data-me-card="${i}"]`);
    if (!card) return;
    card.open = true;
    scheduleSidebar();
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card.classList.remove('me-flash'); void card.offsetWidth; card.classList.add('me-flash');
  };
  viewEl.querySelectorAll<HTMLElement>('[data-me-cell]').forEach(cell => {
    const i = Number(cell.dataset.meCell);
    cell.addEventListener('click', () => activateCell(i));
    cell.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateCell(i); } });
  });

  // ── Preview zoom: scale every card up (scroll to inspect) or down (fit more on
  //    screen). One --me-card-w on the grid drives an auto-fill layout; each cell's
  //    ResizeObserver (above) rescales its canvas to whatever width results. ───────
  const gridEl = viewEl.querySelector<HTMLElement>('[data-me-grid]')!;
  const clampZoom = (w: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(w)));
  // Native aspect ratio per member — the fit calc needs each card's real height.
  const aspects = members.map(m => (m.tool.manifest.render?.width ?? 800) / (m.tool.manifest.render?.height ?? 600));

  // Live column count (auto-fill resolves 1fr tracks to px, space-separated).
  const gridCols = (): number => getComputedStyle(gridEl).gridTemplateColumns.split(' ').filter(Boolean).length || 1;

  /** The largest card width at which every design still clears the viewport height
   *  — i.e. the fewest columns whose stacked rows fit without scrolling. */
  function fitCardW(): number {
    const cs = getComputedStyle(gridEl);
    const innerW = gridEl.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const gap = parseFloat(cs.rowGap) || 16;
    const availH = window.innerHeight - gridEl.getBoundingClientRect().top - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    if (!(innerW > 0) || !(availH > 0)) return clampZoom(340); // pre-layout fallback
    const CAP = 44; // caption strip + borders, approx px
    for (let cols = 1; cols <= members.length; cols++) {
      const colW = (innerW - (cols - 1) * gap) / cols;
      if (colW <= 0) continue;
      let total = 0;
      for (let r = 0; r * cols < members.length; r++) {
        let rowH = 0;
        for (let c = 0; c < cols && r * cols + c < members.length; c++) rowH = Math.max(rowH, colW / aspects[r * cols + c]! + CAP);
        total += rowH;
      }
      total += (Math.ceil(members.length / cols) - 1) * gap;
      // fewest cols that fits → biggest cards. The −1px bias keeps auto-fill from
      // rounding a hair down to one FEWER column (which would overflow the fit).
      if (total <= availH) return clampZoom(Math.floor(colW) - 1);
    }
    // Even at max columns the rows overflow — use the tightest (smallest) width.
    return clampZoom(Math.floor((innerW - (members.length - 1) * gap) / members.length) - 1);
  }

  let cardW: number;
  try { const saved = Number(localStorage.getItem(ZOOM_KEY)); cardW = saved >= ZOOM_MIN && saved <= ZOOM_MAX ? saved : fitCardW(); }
  catch { cardW = fitCardW(); }

  // The zoom HUD: Fit first, then −/read/+ (multi-edit's long-standing order —
  // unlike the tool stage's Fit-last stage-nav). The readout stays a plain,
  // announced-only span (never a control) — clicking a card's readout to fit
  // isn't a gesture anyone's asked for here, so parity keeps it inert.
  const zoomHud = mountZoomHud(viewEl.querySelector<HTMLElement>('[data-me-zoom]')!, {
    ariaLabel: t('Preview size'),
    classes: { btn: 'me-zoom-btn', pct: 'me-zoom-read', fit: 'me-zoom-fit' },
    fitPosition: 'start',
    pctInteractive: false,
    pctAriaLive: 'polite',
    onZoom: (dir) => { cardW = dir > 0 ? cardW * ZOOM_STEP : cardW / ZOOM_STEP; applyZoom(); },
    onFit: () => { cardW = fitCardW(); applyZoom(); },
    outContent: ZOOM_OUT_ICON,
    inContent: ZOOM_IN_ICON,
    fitContent: FIT_ICON,
    outAriaLabel: t('Smaller previews'),
    inAriaLabel: t('Larger previews'),
    fitAriaLabel: t('Fit all on screen'),
    fitTitle: t('Fit all on screen'),
    min: ZOOM_MIN,
    max: ZOOM_MAX,
  });
  cleanups.push(() => zoomHud.destroy());

  const updateReadout = (): void => zoomHud.setReadout(t('{n} across', { n: gridCols() }));
  function applyZoom(): void {
    cardW = clampZoom(cardW);
    gridEl.style.setProperty('--me-card-w', `${cardW}px`);
    try { localStorage.setItem(ZOOM_KEY, String(cardW)); } catch { /* private mode */ }
    zoomHud.setValue(cardW);
    updateReadout();
  }
  applyZoom();

  // Keep "N across" honest as the window resizes (auto-fill reflows columns).
  const zoomRO = new ResizeObserver(() => updateReadout());
  zoomRO.observe(gridEl);
  cleanups.push(() => zoomRO.disconnect());

  // ── Search: filter controls across every card ───────────────────────────────
  const searchEl = viewEl.querySelector<HTMLInputElement>('[data-me-search]');
  searchEl?.addEventListener('input', () => {
    const q = searchEl.value.trim().toLowerCase();
    viewEl.querySelectorAll<HTMLDetailsElement>('.me-card').forEach(card => {
      // Ensure lazily-skipped panels exist before filtering them.
      if (q && !card.open) { card.open = true; syncSidebar(); }
      let hits = 0;
      // Filter whole control ROWS — the label text lives on .input-row; the
      // [data-input-id] attribute rides the control element inside it.
      card.querySelectorAll<HTMLElement>('.me-inputs .input-row').forEach(row => {
        const id = row.querySelector<HTMLElement>('[data-input-id]')?.dataset.inputId ?? '';
        const text = `${id} ${row.textContent ?? ''}`.toLowerCase();
        const hit = !q || text.includes(q);
        row.hidden = !hit;
        if (hit) hits++;
      });
      const title = card.querySelector('.me-card-title')?.textContent?.toLowerCase() ?? '';
      const titleHit = q !== '' && title.includes(q);
      if (titleHit) { card.querySelectorAll<HTMLElement>('.me-inputs .input-row').forEach(r => { r.hidden = false; }); hits++; }
      card.classList.toggle('me-card--nomatch', q !== '' && hits === 0);
    });
    if (!q) {
      // Restore the resting state: everything visible, no dimmed cards.
      viewEl.querySelectorAll<HTMLElement>('.me-card .me-inputs .input-row').forEach(r => { r.hidden = false; });
      viewEl.querySelectorAll<HTMLDetailsElement>('.me-card').forEach(c => c.classList.remove('me-card--nomatch'));
    }
  });

  // ── Condensed export blocks + downloads ─────────────────────────────────────
  const exportOpts = (i: number): { format?: string; width?: number; height?: number; unit?: Unit; dpi?: number } => ({
    format: viewEl.querySelector<HTMLSelectElement>(`[data-me-fmt="${i}"]`)?.value,
    width: num(viewEl.querySelector<HTMLInputElement>(`[data-me-w="${i}"]`)?.value),
    height: num(viewEl.querySelector<HTMLInputElement>(`[data-me-h="${i}"]`)?.value),
    unit: (viewEl.querySelector<HTMLSelectElement>(`[data-me-unit="${i}"]`)?.value ?? 'px') as Unit,
    dpi: num(viewEl.querySelector<HTMLInputElement>(`[data-me-dpi="${i}"]`)?.value),
  });
  viewEl.querySelectorAll<HTMLSelectElement>('select[data-me-unit]').forEach(sel => {
    sel.addEventListener('change', () => {
      sel.closest('.me-export')?.querySelector<HTMLElement>('.me-exp-dpi')?.toggleAttribute('hidden', sel.value === 'px');
    });
  });

  // Save one session back to its slot: current model values + this card's export
  // settings, preserving markers this view doesn't edit (profile/bleed/marks…).
  // The thumb is kept as-is; the tool view refreshes it on its own saves.
  async function saveOne(i: number): Promise<void> {
    const m = members[i]!;
    const opts = exportOpts(i);
    const data: SavedStateData = {
      ...m.data,
      ...modelValues(m.runtime),
      __toolId: m.tool.manifest.id,
      __toolVersion: m.tool.manifest.version,
      __export_format: opts.format ?? '',
      __export_width: opts.width != null ? String(opts.width) : '',
      __export_height: opts.height != null ? String(opts.height) : '',
      __export_unit: opts.unit ?? 'px',
      __export_dpi: opts.dpi != null ? String(opts.dpi) : '',
    };
    await state.save(m.slot, data, m.thumb);
    m.data = data;
    m.dirty = false;
  }
  async function saveAll(): Promise<void> {
    for (let i = 0; i < members.length; i++) await saveOne(i);
  }

  // Progress toast for the render pipeline — the same chrome the Projects view
  // floats for its batch exports (classes live in app-level CSS).
  const toasts = new Set<HTMLElement>();
  cleanups.push(() => toasts.forEach(t => t.remove()));
  function renderViaToast(run: (mount: HTMLElement) => unknown): void {
    const toast = document.createElement('div');
    toast.className = 'pro-toast projects-toast';
    toast.innerHTML = `<button type="button" class="pro-toast-close" aria-label="${escape(t('Close'))}">✕</button><div class="pro-toast-mount"></div>`;
    document.body.appendChild(toast);
    toasts.add(toast);
    const mount = toast.querySelector<HTMLElement>('.pro-toast-mount')!;
    toast.querySelector('.pro-toast-close')!.addEventListener('click', () => { toast.remove(); toasts.delete(toast); });
    Promise.resolve(run(mount)).catch((err) => {
      mount.innerHTML = `<p class="pro-progress-msg pro-log-err">${escape(String((err as { message?: unknown })?.message ?? err))}</p>`;
    });
  }
  const authorForExport = async () => {
    const profile = await host.profile.get().catch(() => null);
    return (profile as { useDetails?: boolean } | null)?.useDetails ? profile : null;
  };

  let exporting = false;
  viewEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement; // not `t` — that's the i18n lookup
    const one = target.closest<HTMLElement>('[data-me-download]');
    const all = target.closest<HTMLElement>('[data-me-downloadall]');
    const save = target.closest<HTMLElement>('[data-me-saveall]');
    if (!one && !all && !save) return;
    if (exporting) return;
    exporting = true;
    const busy = (one ?? all ?? save)!;
    busy.setAttribute('aria-busy', 'true');
    try {
      if (one) {
        // Save first so the standard session-export path (which reads the SAVED
        // slot — same code the Projects tile menu runs) renders what's on screen,
        // with the tool's own filename/format and Content Credentials intact.
        const i = Number(one.dataset.meDownload);
        await saveOne(i);
        const author = await authorForExport();
        renderViaToast(async (mount) => {
          const { renderSessionToFile } = await import('../pro/folder-export.ts');
          await renderSessionToFile(host, members[i]!.slot, { mount, author });
        });
      } else if (all) {
        // One nested, C2PA-signed zip via the SAME pipeline as the Projects
        // "Render selection" action — with the optional AES-256 export lock.
        await saveAll();
        const { askExportLock } = await import('../lib/export-lock.ts');
        const { ok, strongPassword, zipLock } = await askExportLock('these designs', true);
        if (!ok) return;
        const author = await authorForExport();
        renderViaToast(async (mount) => {
          const { exportSelectionAsBatch } = await import('../pro/folder-export.ts');
          await exportSelectionAsBatch(host, {
            label: 'Multi-edit', sessionRefs: members.map(m => m.slot), folderIds: [], allFolders: [],
            mount, author, strongPassword, zipLock,
          });
        });
      } else if (save) {
        await saveAll();
        announce(t('Saved {n} sessions', { n: members.length }));
      }
    } catch (err) {
      console.warn('multi-edit action failed:', err);
      announce(t('Something went wrong — see the console.'));
    } finally {
      busy.removeAttribute('aria-busy');
      exporting = false;
    }
  });

  viewEl._cleanup = () => { cleanups.forEach(fn => { try { fn(); } catch { /* teardown */ } }); };
}
