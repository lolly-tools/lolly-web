// SPDX-License-Identifier: MPL-2.0
/**
 * #/data - an offline spreadsheet viewer/editor (plan 89).
 *
 * For someone with no internet, no Excel and no LibreOffice who still needs to open,
 * read and lightly edit a spreadsheet. Drop an .xlsx/.csv/.tsv/.json → it renders in
 * the virtualized data-grid (millions of cells stay responsive), with a sheet-tab bar
 * for a multi-sheet workbook and a download-as menu. Everything runs on-device.
 *
 * Honest about its limits (Andy's ask - "knowing what they can and can't change"): it
 * shows VALUES. Formulas appear as their computed result; styles, merged cells, charts
 * and multiple sheets do not survive a save. The banner says so plainly, because
 * pretending otherwise would lose a user's work silently.
 */
import type { HostV1 } from '@lolly-tools/core/host-v1';
import type { TableValue } from '@lolly/engine';
import { readXlsx, listXlsxSheets, parseTableText } from '@lolly/engine';
import { mountDataGrid, type DataGridHandle } from '../components/data-grid.ts';
import { sourceToGrid, gridToTarget } from './convert.ts';
import { t } from '../i18n.ts';
import { escape } from '../utils.ts';
import { backHomeHtml, mountBackPill } from '../components/back-pill.ts';
import { langFabHtml, attachLangMenu } from '../components/lang-menu.ts';
import { mountHomeFab } from '../components/home-fab.ts';
import { mountThemeFab } from '../components/theme-toggle.ts';
import '../styles/parts/platform.css';
import '../styles/parts/data-view.css';

/** A generous read cap for the viewer - the engine bounds it internally by MAX_CELLS
 *  (2M), so a pathological book can't blow memory; we note truncation when it bites. */
const VIEW_ROW_LIMIT = 200_000;

const DOWNLOAD_TARGETS = [
  { id: 'csv', label: 'CSV (.csv)', ext: 'csv', mime: 'text/csv' },
  { id: 'xlsx', label: 'Excel (.xlsx)', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { id: 'json', label: 'JSON (.json)', ext: 'json', mime: 'application/json' },
  { id: 'tsv', label: 'TSV (.tsv)', ext: 'tsv', mime: 'text/tab-separated-values' },
];

export async function mountDataView(viewEl: HTMLElement, host: HostV1, _params = ''): Promise<void> {
  document.title = 'Spreadsheet - Lolly';
  viewEl.innerHTML = `
    ${backHomeHtml()}
    <div class="gallery-topright">${langFabHtml()}</div>
    <div class="platform-layout data-view">
      <header class="plat-header">
        <h1 class="plat-title">${t('Spreadsheet')}</h1>
        <p class="plat-sub">${t('Open, read and edit a spreadsheet on your device - no internet, no Excel needed. Nothing is uploaded.')}</p>
      </header>
      <div class="data-drop" data-drop tabindex="0" role="button" aria-label="${t('Drop a spreadsheet to open')}">
        <p>${t('Drop an .xlsx, .csv, .tsv or .json here, or choose one.')}</p>
        <button type="button" class="btn" data-pick>${t('Choose a file…')}</button>
        <input type="file" hidden data-file accept=".xlsx,.csv,.tsv,.json,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      </div>
      <div class="data-workspace" data-workspace hidden>
        <div class="data-tabs" data-tabs role="tablist" hidden></div>
        <p class="data-limits" data-limits hidden></p>
        <div class="data-grid-host" data-grid></div>
        <div class="data-actions" data-actions hidden>
          <span class="data-actions-label">${t('Download as')}</span>
          ${DOWNLOAD_TARGETS.map((d) => `<button type="button" class="btn" data-dl="${d.id}">${d.label}</button>`).join('')}
        </div>
      </div>
    </div>`;

  // Reached as a tile OR a deep link - carry the full escape chrome (back pill +
  // always-home) plus the language + theme FABs, so nobody sent straight to the
  // spreadsheet is stranded with no way out.
  mountBackPill(viewEl);
  mountHomeFab(viewEl);
  mountThemeFab(viewEl.querySelector('.gallery-topright'), host);
  attachLangMenu(viewEl.querySelector<HTMLElement>('.lang-fab'), host);

  const drop = viewEl.querySelector<HTMLElement>('[data-drop]')!;
  const fileInput = viewEl.querySelector<HTMLInputElement>('[data-file]')!;
  const workspace = viewEl.querySelector<HTMLElement>('[data-workspace]')!;
  const tabsEl = viewEl.querySelector<HTMLElement>('[data-tabs]')!;
  const limitsEl = viewEl.querySelector<HTMLElement>('[data-limits]')!;
  const gridHost = viewEl.querySelector<HTMLElement>('[data-grid]')!;
  const actionsEl = viewEl.querySelector<HTMLElement>('[data-actions]')!;

  let grid: DataGridHandle | null = null;
  let baseName = 'sheet';
  // For an xlsx we keep the bytes so a sheet-tab switch re-reads without re-picking.
  let xlsxBytes: Uint8Array | null = null;

  viewEl.querySelector('[data-pick]')?.addEventListener('click', () => fileInput.click());
  drop.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) return; fileInput.click(); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0]; if (f) void onFile(f);
  });
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) void onFile(f); });

  // The honest-limits banner (Andy's ask): stated once the data is showing.
  const LIMITS_HTML = escape(t(
    'Lolly shows the data and lets you edit it - it doesn’t pretend to be Excel. Formulas appear as their current value; styles, merged cells, charts and extra sheets won’t survive a download. Your data will.',
  ));

  function showGrid(value: TableValue, truncatedNote?: string): void {
    grid?.destroy();
    grid = mountDataGrid(gridHost, { value, editable: true });
    workspace.hidden = false;
    actionsEl.hidden = false;
    limitsEl.hidden = false;
    limitsEl.innerHTML = `${LIMITS_HTML}${truncatedNote ? ` <b>${escape(truncatedNote)}</b>` : ''}`;
  }

  function renderTabs(names: string[], active: number): void {
    if (names.length <= 1) { tabsEl.hidden = true; return; }
    tabsEl.hidden = false;
    tabsEl.innerHTML = names.map((n, i) =>
      `<button type="button" class="data-tab${i === active ? ' is-active' : ''}" role="tab" aria-selected="${i === active}" data-sheet="${i}">${escape(n)}</button>`).join('');
    tabsEl.querySelectorAll<HTMLButtonElement>('[data-sheet]').forEach((btn) =>
      btn.addEventListener('click', () => { if (xlsxBytes) loadXlsxSheet(xlsxBytes, Number(btn.dataset.sheet), names); }));
  }

  function loadXlsxSheet(bytes: Uint8Array, sheet: number, names: string[]): void {
    try {
      const { rows, truncated } = readXlsx(bytes, { sheet, limit: VIEW_ROW_LIMIT });
      renderTabs(names, sheet);
      showGrid(gridFromRows(rows), truncated ? t('Showing the first {n} rows.').replace('{n}', String(VIEW_ROW_LIMIT)) : undefined);
    } catch (e) {
      announceError((e as Error).message);
    }
  }

  async function onFile(file: File): Promise<void> {
    baseName = file.name.replace(/\.[^.]+$/, '') || 'sheet';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (/\.xlsx$/i.test(file.name)) {
        xlsxBytes = bytes;
        const names = listXlsxSheets(bytes).map((s) => s.name);
        loadXlsxSheet(bytes, 0, names.length ? names : ['Sheet 1']);
        return;
      }
      xlsxBytes = null;
      tabsEl.hidden = true;
      const kind = /\.tsv$/i.test(file.name) ? 'tsv' : /\.json$/i.test(file.name) ? 'json' : 'csv';
      showGrid(gridFromRows(sourceToGrid(kind, bytes)));
    } catch (e) {
      announceError((e as Error).message);
    }
  }

  // Download the CURRENT grid value (post-edit) in the chosen format.
  actionsEl.querySelectorAll<HTMLButtonElement>('[data-dl]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!grid) return;
      const target = DOWNLOAD_TARGETS.find((d) => d.id === btn.dataset.dl)!;
      const value = grid.getValue();
      const out = gridToTarget([value.columns, ...value.rows], target.id);
      const blob = new Blob([out as BlobPart], { type: target.mime });
      await host.export.download(blob, `${baseName}.${target.ext}`);
    });
  });

  function announceError(msg: string): void {
    workspace.hidden = false;
    limitsEl.hidden = false;
    limitsEl.innerHTML = `<b>${escape(msg || t('That file could not be read.'))}</b>`;
  }
}

/** A ragged grid (row 0 = header) → the grid's {columns, rows} value. */
function gridFromRows(rows: string[][]): TableValue {
  const [header = [], ...body] = rows;
  return { columns: header, rows: body };
}
