// SPDX-License-Identifier: MPL-2.0
/**
 * Pro / Batch mode — pure row assembly for folder (group) exports.
 *
 * Converts saved sessions into batch rows with nested export paths. Kept free of
 * any render/zip/DOM/CSS imports so it stays unit-testable and so pro/index.js can
 * use it to flatten a folder into the grid without pulling the run-overlay shell.
 */

import { BATCH_SLOT_PREFIX, isBatchSlot } from '../lib/batch-slots.ts';

/** An assembled batch row with an optional nested export path. */
export interface ExportRow {
  toolId: string | undefined;
  values: Record<string, unknown>;
  format?: string;
  filename?: string;
  outWidth?: number;
  outHeight?: number;
  unit?: string;
  dpi?: number;
}

/** One snapshot row inside a saved batch session. */
interface BatchSessionRow {
  toolId: string;
  values?: Record<string, unknown>;
  format?: string;
  filename?: string;
  outWidth?: number;
  outHeight?: number;
  unit?: string;
  dpi?: number;
}

/**
 * An untrusted session record loaded from host.state — either a single-tool
 * session (flat input values + `__`-prefixed export meta) or a batch snapshot.
 */
interface StoredSession {
  __batch?: unknown;
  __label?: string;
  __toolId?: string;
  __export_filename?: string;
  __export_format?: string;
  __export_width?: string;
  __export_height?: string;
  __export_unit?: string;
  __export_dpi?: string;
  rows?: BatchSessionRow[];
}

/** One item in a saved folder. */
interface FolderItem {
  type: string;
  ref: string;
}

/** A saved folder (group) of sessions/assets. */
interface Folder {
  id?: string;
  name: string;
  parentId?: string | null;
  items?: FolderItem[];
}

/** The slice of the host this module needs: loading a stored session. */
interface FolderHost {
  state: { load(slot: string): Promise<StoredSession | null> };
}

const META = (k: string) => k.startsWith('__');

/** Drop the extension from a filename stem; fall back to the tool id. */
export function stemOf(filename: string | undefined, toolId: string | undefined): string {
  const f = filename?.trim();
  return (f ? f.replace(/\.[a-z0-9]{1,5}$/i, '') : '') || toolId || 'render';
}

/** Filesystem-safe-ish path segment for zip names (batch.js sanitizes again). */
export const slug = (s: unknown): string => String(s ?? '').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');

// Motion export formats — a live clip captured in REAL TIME (rAF-driven), not a single
// frame. They pause when the tab isn't visible, so a batch that includes them needs the
// tab kept active. Single source of truth (render-export imports this too).
export const MOTION_EXPORT_FORMATS = new Set(['webm', 'mp4', 'gif', 'apng']);
/** True if a row renders to a real-time motion clip (video/animation). */
export const isMotionRow = (r: ExportRow): boolean => !!r.format && MOTION_EXPORT_FORMATS.has(r.format.toLowerCase());

const posNum = (v: string | undefined): number | undefined => { const n = parseFloat(v as string); return n > 0 ? n : undefined; };

/**
 * Convert a saved single-tool session's `data` into one batch row.
 *
 * A tool session stores its input values alongside `__`-prefixed export meta; the
 * row's `values` is exactly the inputs (every non-`__` key — render-export seeds
 * those straight into the runtime), and `__export_*` maps 1:1 onto the row's
 * format/filename/size fields. With `pathParts`, the filename becomes the nested
 * export path (`group/.../stem`).
 */
export function rowFromToolSession(data: StoredSession, pathParts: string[] = []): ExportRow {
  const values = Object.fromEntries(Object.entries(data).filter(([k]) => !META(k)));
  const leaf = stemOf(data.__export_filename, data.__toolId);
  return {
    toolId: data.__toolId,
    values,
    format: data.__export_format || undefined,
    filename: pathParts.length ? [...pathParts, leaf].join('/') : (data.__export_filename || undefined),
    outWidth: posNum(data.__export_width),
    outHeight: posNum(data.__export_height),
    unit: data.__export_unit || 'px',
    dpi: posNum(data.__export_dpi),
  };
}

/** Convert one snapshot row (from a batch session) into a path-stamped export row. */
export function rowFromBatchRow(r: BatchSessionRow, pathParts: string[]): ExportRow {
  const leaf = stemOf(r.filename, r.toolId);
  return {
    toolId: r.toolId,
    values: r.values ?? {},
    format: r.format,
    filename: [...pathParts, leaf].join('/'),
    outWidth: r.outWidth,
    outHeight: r.outHeight,
    unit: r.unit,
    dpi: r.dpi,
  };
}

/**
 * Assemble every renderable row for a folder, with nested export paths:
 *   - a batch session (subgroup) → all its rows, under `<group>/<subgroup>/…`
 *   - a single-tool session      → one row, under `<group>/…`
 * Image items are inputs, not renderable tools, so they're skipped.
 *
 * When `allFolders` is supplied, the folder's SUB-FOLDERS are recursed into as well, so
 * a nested tree exports under nested paths (`<group>/<child>/…`). Omitting it keeps the
 * legacy single-level behaviour (used by pro/index.js to flatten one folder into a grid).
 * `basePath` is the ancestor path prefix accumulated during recursion.
 */
export async function rowsForFolder(host: FolderHost, folder: Folder, allFolders: Folder[] | null = null, basePath: string[] = []): Promise<ExportRow[]> {
  const path = [...basePath, folder.name];
  const rows: ExportRow[] = [];
  for (const item of folder.items ?? []) {
    if (item.type !== 'session') continue;
    const data = await host.state.load(item.ref);
    if (!data) continue;
    if (data.__batch || isBatchSlot(item.ref)) {
      const sub = data.__label || item.ref.slice(BATCH_SLOT_PREFIX.length);
      for (const r of data.rows ?? []) {
        if (r.toolId) rows.push(rowFromBatchRow(r, [...path, sub]));
      }
    } else if (data.__toolId) {
      rows.push(rowFromToolSession(data, path));
    }
  }
  if (allFolders) {
    for (const child of allFolders.filter(f => (f.parentId ?? null) === folder.id)) {
      rows.push(...await rowsForFolder(host, child, allFolders, path));
    }
  }
  return rows;
}
