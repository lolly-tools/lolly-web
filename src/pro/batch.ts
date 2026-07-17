// SPDX-License-Identifier: MPL-2.0
/**
 * Pro / Batch mode — render the whole batch, sequentially.
 *
 * Rows are rendered one at a time (concurrency 1) on purpose: tool templates
 * run arbitrary scripts that may touch window globals and the document font
 * loader, and each render mounts a full-size offscreen node. Serial execution
 * keeps memory bounded and avoids cross-tool interference; the export work is
 * the bottleneck regardless, so parallelism buys little here.
 *
 * Failures are isolated — one bad row is recorded and the batch continues.
 */
import { renderRowToBlob, getTool, isExportable } from './render-export.ts';
import { playSfx } from '../lib/sfx.ts';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';

/** A batch row with the per-row export overrides the grid / CSV can set. */
export interface BatchRow {
  toolId: string;
  values: Record<string, unknown>;
  unit?: string;
  dpi?: number;
  format?: string;
  outWidth?: number;
  outHeight?: number;
  filename?: string;
}

/** A rendered output ready for packaging. */
export interface BatchFile {
  name: string;
  blob: Blob;
  ms: number;
  fmt: string;
  url: string;
}

/** Per-row outcome of a run. */
export type BatchResult =
  | { index: number; row: BatchRow; ok: true; name: string; size: number; ms: number }
  | { index: number; row: BatchRow; ok: false; error: string };

/** Progress event emitted per row as a run proceeds. */
export type BatchProgress =
  | { index: number; total: number; status: 'cancelled' }
  | { index: number; total: number; status: 'rendering'; row: BatchRow }
  | { index: number; total: number; status: 'done'; row: BatchRow; name: string; blob: Blob; fmt: string; ms: number }
  | { index: number; total: number; status: 'error'; row: BatchRow; error: string };

/** Options controlling a batch run. */
export interface RunBatchOpts {
  format?: string;
  unit?: string;
  dpi?: number;
  onProgress?: (p: BatchProgress) => void;
  isCancelled?: () => boolean;
  pathAware?: boolean;
  /** AES-256 lock applied to any pdf/pdf-cmyk rows (ignored for other formats). */
  strongPassword?: string;
  /**
   * Lolly pixel imprint, forwarded to every row (renderRowToBlob opts.imprint —
   * the bridge embeds it on raster formats and ignores it elsewhere). Opt-in
   * only, never a default: unlike c2pa/watermark (policy defaults renderRowToBlob
   * applies itself), imprint mirrors the export panel's toggle (tool-actions
   * [data-action="imprint"], seeded by ?imprint=). Sessions don't persist it
   * (sessionSnapshot writes no __export_imprint), so there's no per-row channel —
   * callers thread the live toggle's run-level value here.
   */
  imprint?: boolean;
}

const FMT_EXT: Record<string, string> = { 'pdf-cmyk': 'pdf', jpeg: 'jpg', 'eps-cmyk': 'eps', 'svg-anim': 'svg', 'webp-anim': 'webp' };
const extFor = (fmt: string): string => FMT_EXT[fmt] ?? fmt;

const sanitizeSeg = (s: string): string => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Ensure unique, filesystem-safe names within the zip. With `pathAware`, the
 * base may carry `/` separators (a grouped/folder export wants nested zip
 * directories) — each path segment is sanitized but the separators are kept, so
 * fflate writes a real folder tree. Without it, slashes are flattened to `-`
 * exactly as before, so ordinary grid runs are unchanged.
 */
function uniqueName(used: Set<string>, base: string, ext: string, pathAware = false): string {
  const safe = pathAware
    ? (base.split('/').map(sanitizeSeg).filter(Boolean).join('/') || 'render')
    : (base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'render');
  let name = `${safe}.${ext}`;
  let n = 2;
  while (used.has(name)) name = `${safe}-${n++}.${ext}`;
  used.add(name);
  return name;
}

/**
 * @param {Array<{toolId:string, values:object}>} rows  rows with a chosen tool
 * @param {HostV1} host
 * @param {object} opts
 * @param {string} [opts.format]                 preferred export format
 * @param {(p:object)=>void} [opts.onProgress]   progress callback
 * @param {()=>boolean} [opts.isCancelled]       cooperative cancel check
 * @returns {Promise<{files:Array<{name,blob}>, results:Array}>}
 */
export async function runBatch(
  rows: BatchRow[],
  host: HostV1,
  { format, unit, dpi, onProgress, isCancelled, pathAware = false, strongPassword, imprint }: RunBatchOpts = {},
): Promise<{ files: BatchFile[]; results: BatchResult[] }> {
  const files: BatchFile[] = [];
  const results: BatchResult[] = [];
  const usedNames = new Set<string>();
  const total = rows.length;
  // Every file is prefixed with its 1-based position in the batch, zero-padded to
  // the batch size, so the names sort in row order in the zip / file explorer —
  // named rows included. Pad width tracks the count so e.g. row 100 sorts after
  // row 99 (a fixed 2-digit pad would order "100" before "99" lexically).
  const seqWidth = Math.max(2, String(total).length);

  for (let i = 0; i < total; i++) {
    if (isCancelled?.()) {
      onProgress?.({ index: i, total, status: 'cancelled' });
      break;
    }
    const row = rows[i]!;
    onProgress?.({ index: i, total, status: 'rendering', row });
    try {
      // A row may carry its own format + output dimensions (e.g. set via CSV);
      // else fall back to the global format and the tool's native size.
      // Per-row unit/DPI fall back to the toolbar defaults. DPI only matters for
      // physical units + raster, so px rows keep the export's native 96.
      const rowUnit = row.unit ?? unit ?? 'px';
      const rowDpi = rowUnit === 'px' ? undefined : (row.dpi ?? dpi ?? 300);
      const t0 = Date.now();
      const { blob, format: fmt, url } = await renderRowToBlob(row as Parameters<typeof renderRowToBlob>[0], host, {
        format: row.format || format, width: row.outWidth, height: row.outHeight, unit: rowUnit as NonNullable<Parameters<typeof renderRowToBlob>[2]>['unit'], dpi: rowDpi, strongPassword, imprint,
      });
      const ms = Date.now() - t0; // render time, surfaced in the zip manifest
      // Per-row filename wins for the stem (extension stripped — we add the
      // format's); else the tool id. Either way it's prefixed with the row number
      // so files always sort the way the rows appeared in the table.
      const stem = row.filename?.trim()
        ? row.filename.trim().replace(/\.[a-z0-9]{1,5}$/i, '')
        : row.toolId;
      // The seq prefix goes on the basename only so files sort within their
      // folder when the stem carries a nested path (e.g. "event/badges/badge").
      const seq = String(i + 1).padStart(seqWidth, '0');
      const slash = pathAware ? stem.lastIndexOf('/') : -1;
      const base = slash >= 0
        ? `${stem.slice(0, slash + 1)}${seq}-${stem.slice(slash + 1)}`
        : `${seq}-${stem}`;
      const name = uniqueName(usedNames, base, extFor(fmt), pathAware);
      files.push({ name, blob, ms, fmt, url }); // fmt distinguishes pdf-cmyk from pdf; url = reopen-in-Lolly link
      results.push({ index: i, row, ok: true, name, size: blob.size, ms });
      onProgress?.({ index: i, total, status: 'done', row, name, blob, fmt, ms });
      playSfx('ding'); // a quiet, satisfying "one done" — fires for EVERY render path through runBatch
    } catch (err) {
      // `err` is unknown in a strict catch; read `.message` off it exactly as the
      // JS did (cast is erased, runtime behaviour unchanged).
      results.push({ index: i, row, ok: false, error: String((err as { message?: unknown })?.message ?? err) });
      onProgress?.({ index: i, total, status: 'error', row, error: String((err as { message?: unknown })?.message ?? err) });
    }
  }

  return { files, results };
}

/**
 * Validate rows before a run: drop empties, flag render-only tools. Returns
 * { renderable, skipped } so the UI can warn before committing to a batch.
 */
export async function planBatch(
  rows: BatchRow[],
): Promise<{ renderable: BatchRow[]; skipped: Array<{ row: BatchRow; reason: string }> }> {
  const renderable: BatchRow[] = [];
  const skipped: Array<{ row: BatchRow; reason: string }> = [];
  for (const row of rows) {
    if (!row.toolId) { skipped.push({ row, reason: 'No template selected' }); continue; }
    try {
      const tool = await getTool(row.toolId);
      if (!isExportable(tool.manifest)) {
        skipped.push({ row, reason: 'Render-only tool' });
      } else {
        renderable.push(row);
      }
    } catch {
      skipped.push({ row, reason: 'Failed to load template' });
    }
  }
  return { renderable, skipped };
}
