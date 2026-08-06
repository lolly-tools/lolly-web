// SPDX-License-Identifier: MPL-2.0
/**
 * A framework-free, virtualized datagrid (plan 89).
 *
 * Renders only the rows inside the scroll viewport (+ a small overscan), recycling
 * DOM as you scroll, so a 100k-row spreadsheet stays responsive on a fixed DOM
 * budget. Real DOM (not canvas), so it themes, is keyboard-accessible, and exports
 * through the normal SVG walker. In/out is `TableValue` ({columns, rows}) — a drop-in
 * for the `table` input control, `/pro` grids, and the `#/data` viewer.
 *
 * The windowing math (`visibleRange`) is pure and unit-tested; the mount function is
 * the DOM glue. Editing commits through `onChange`, so the host keeps ownership of
 * undo/state (the grid never forks its own store).
 */

import type { TableValue } from '@lolly/engine';
import '../styles/parts/data-grid.css';

/** The slice of rows to render for a given scroll position, plus the offset + total
 *  height that place that slice inside a full-height scroll canvas. Pure. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = 4,
): { first: number; last: number; offsetY: number; totalHeight: number } {
  const rh = Math.max(1, rowHeight);
  const totalHeight = total * rh;
  if (total <= 0 || viewportHeight <= 0) return { first: 0, last: 0, offsetY: 0, totalHeight };
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rh);
  const first = Math.max(0, firstVisible - overscan);
  const visible = Math.ceil(viewportHeight / rh) + overscan * 2;
  const last = Math.min(total, first + visible);
  return { first, last, offsetY: first * rh, totalHeight };
}

export interface DataGridOptions {
  value: TableValue;
  /** Editable (viewer read-only when false). Default true. */
  editable?: boolean;
  /** Debounced-commit callback with the whole updated table. */
  onChange?: (next: TableValue) => void;
  /** Column indices that are read-only even when the grid is editable (e.g. a
   *  formula column shown as its computed value — the honest-limits marker). */
  readOnlyCols?: number[];
  /** Fixed row height in px (default 28). */
  rowHeight?: number;
  /** Rows above/below the viewport to keep rendered (default 4). */
  overscan?: number;
}

export interface DataGridHandle {
  setValue(next: TableValue): void;
  getValue(): TableValue;
  destroy(): void;
}

const ROW_H = 28;
const MIN_COL = 64;
const DEFAULT_COL = 128;

/** Sample the first N rows of a column to pick a sensible width (clamped). */
function colWidth(value: TableValue, col: number, sample = 40): number {
  let max = (value.columns[col] ?? '').length;
  const n = Math.min(sample, value.rows.length);
  for (let r = 0; r < n; r++) max = Math.max(max, (value.rows[r]?.[col] ?? '').length);
  return Math.max(MIN_COL, Math.min(DEFAULT_COL * 3, 12 + max * 8));
}

/**
 * Mount a virtualized grid into `container`. Returns a handle to update the value or
 * tear down. The container is emptied and given the grid's own markup.
 */
export function mountDataGrid(container: HTMLElement, opts: DataGridOptions): DataGridHandle {
  const rowHeight = opts.rowHeight ?? ROW_H;
  const overscan = opts.overscan ?? 4;
  const editable = opts.editable !== false;
  const readOnly = new Set(opts.readOnlyCols ?? []);
  let value: TableValue = clone(opts.value);
  let widths = value.columns.map((_, c) => colWidth(value, c));

  container.classList.add('data-grid');
  container.setAttribute('role', 'grid');
  container.innerHTML = `
    <div class="dg-viewport" tabindex="0">
      <div class="dg-inner">
        <div class="dg-header" role="row"></div>
        <div class="dg-canvas"><div class="dg-rows"></div></div>
      </div>
    </div>`;
  const viewport = container.querySelector<HTMLElement>('.dg-viewport')!;
  const inner = container.querySelector<HTMLElement>('.dg-inner')!;
  const header = container.querySelector<HTMLElement>('.dg-header')!;
  const canvas = container.querySelector<HTMLElement>('.dg-canvas')!;
  const rowsEl = container.querySelector<HTMLElement>('.dg-rows')!;

  const totalWidth = () => widths.reduce((a, b) => a + b, 0);

  function renderHeader(): void {
    inner.style.width = `${totalWidth()}px`;
    header.style.height = `${rowHeight}px`;
    header.innerHTML = value.columns
      .map((c, i) => `<div class="dg-cell dg-head-cell${readOnly.has(i) ? ' dg-ro' : ''}" role="columnheader" style="width:${widths[i]}px" data-col="${i}">${esc(c)}</div>`)
      .join('');
  }

  let rangeFirst = -1;
  let rangeLast = -1;
  function renderRows(force = false): void {
    const { first, last, offsetY, totalHeight } = visibleRange(
      viewport.scrollTop, viewport.clientHeight, rowHeight, value.rows.length, overscan,
    );
    canvas.style.height = `${totalHeight}px`;
    if (!force && first === rangeFirst && last === rangeLast) return;
    rangeFirst = first; rangeLast = last;
    rowsEl.style.transform = `translateY(${offsetY}px)`;
    let html = '';
    for (let r = first; r < last; r++) {
      const row = value.rows[r] ?? [];
      html += `<div class="dg-row" role="row" aria-rowindex="${r + 2}" style="height:${rowHeight}px" data-row="${r}">`;
      for (let c = 0; c < value.columns.length; c++) {
        const ro = !editable || readOnly.has(c);
        html += `<div class="dg-cell${ro ? ' dg-ro' : ''}" role="gridcell" style="width:${widths[c]}px" data-row="${r}" data-col="${c}"${ro ? '' : ' tabindex="-1"'}>${esc(row[c] ?? '')}</div>`;
      }
      html += '</div>';
    }
    rowsEl.innerHTML = html;
  }

  function refreshAria(): void {
    container.setAttribute('aria-rowcount', String(value.rows.length + 1));
    container.setAttribute('aria-colcount', String(value.columns.length));
  }

  // ── editing: click a cell → a single floating <input> over it ────────────────
  let editor: HTMLInputElement | null = null;
  function commit(): void {
    if (!editor) return;
    const r = Number(editor.dataset.row), c = Number(editor.dataset.col);
    const next = clone(value);
    (next.rows[r] ??= [])[c] = editor.value;
    value = next;
    const cell = rowsEl.querySelector<HTMLElement>(`.dg-cell[data-row="${r}"][data-col="${c}"]`);
    if (cell) cell.textContent = editor.value;
    editor.remove(); editor = null;
    opts.onChange?.(clone(value));
  }
  function beginEdit(cell: HTMLElement): void {
    if (!editable) return;
    const c = Number(cell.dataset.col);
    if (readOnly.has(c)) return;
    commit();
    const r = Number(cell.dataset.row);
    const box = cell.getBoundingClientRect();
    const host = viewport.getBoundingClientRect();
    editor = document.createElement('input');
    editor.className = 'dg-editor';
    editor.value = value.rows[r]?.[c] ?? '';
    editor.dataset.row = String(r); editor.dataset.col = String(c);
    editor.style.left = `${box.left - host.left + viewport.scrollLeft}px`;
    editor.style.top = `${box.top - host.top + viewport.scrollTop}px`;
    editor.style.width = `${box.width}px`;
    editor.style.height = `${box.height}px`;
    inner.appendChild(editor);
    editor.focus(); editor.select();
    editor.addEventListener('blur', commit, { once: true });
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); viewport.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); editor?.remove(); editor = null; viewport.focus(); }
    });
  }

  const onScroll = (): void => { if (editor) commit(); renderRows(); };
  const onDblClick = (e: MouseEvent): void => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.dg-row .dg-cell');
    if (cell) beginEdit(cell);
  };
  viewport.addEventListener('scroll', onScroll, { passive: true });
  rowsEl.addEventListener('dblclick', onDblClick);

  // A resize observer keeps the window correct when the viewport grows/shrinks.
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => renderRows(true)) : null;
  ro?.observe(viewport);

  function full(): void { renderHeader(); refreshAria(); renderRows(true); }
  full();

  return {
    setValue(next) { value = clone(next); widths = value.columns.map((_, c) => colWidth(value, c)); full(); },
    getValue() { return clone(value); },
    destroy() {
      viewport.removeEventListener('scroll', onScroll);
      rowsEl.removeEventListener('dblclick', onDblClick);
      ro?.disconnect();
      editor?.remove();
      container.replaceChildren();
      container.classList.remove('data-grid');
      for (const a of ['role', 'aria-rowcount', 'aria-colcount']) container.removeAttribute(a);
    },
  };
}

function clone(t: TableValue): TableValue {
  return { columns: [...t.columns], rows: t.rows.map((r) => [...r]) };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
