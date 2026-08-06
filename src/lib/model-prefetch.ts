// SPDX-License-Identifier: MPL-2.0
/**
 * Main-thread PREFETCH of the on-device image-AI model weights (host.upscale,
 * host.matte) into the exact IndexedDB object stores their worker runners read —
 * so the profile's "Available offline" section can pull them down in ANTICIPATION
 * of work, not only when a dialog first needs them.
 *
 * The twin of trustmark.ts's prefetchTrustmarkModels, and the reason it can live
 * outside the ORT-heavy worker modules (upscaler.ts / matter.ts): ort.ts imports
 * onnxruntime-web TYPE-ONLY, so `createModelFetcher` (fetch → IndexedDB, no ORT) is
 * a light main-thread import that never drags the runtime into the bundle.
 *
 * CACHE PARITY IS THE WHOLE POINT: the store / dir / version below MUST match the
 * worker fetchers (upscaler.ts, matter.ts) exactly, or the pre-downloaded bytes are
 * invisible to them and the dialog re-downloads on first use. They come from the
 * shared pure catalogue modules (upscale-models.ts / matte-models.ts) for exactly
 * that reason — one source of truth. The service worker bypasses `/models/`, so
 * there is only ever ONE on-device copy (the IDB one), never a duplicate SW-cache
 * copy — which is why this uses the model fetcher, not offline-manager's
 * downloadList (that would write an unread SW-cache bucket).
 */

import { createDebugLogger, createModelFetcher, type FetchProgress } from './ort.ts';
import { openDB } from '../bridge/db.ts';
import type { DownloadProgress } from './offline-manager.ts';
import {
  UPSCALE_MODEL_STORE, UPSCALE_MODEL_DIR, UPSCALE_MODEL_CACHE_VERSION, UPSCALE_MODEL_FILES,
  UPSCALE_FACE_DETECT_FILE, UPSCALE_WDN_FILE, UPSCALE_DENOISE_STAGED, stagedUpscaleModels,
} from './upscale-models.ts';
import {
  MATTE_MODEL_STORE, MATTE_MODEL_DIR, MATTE_MODEL_CACHE_VERSION, MATTE_MODEL_FILES, stagedMatteModels,
} from './matte-models.ts';

const upscaleFetch = createModelFetcher({
  store: UPSCALE_MODEL_STORE, dir: UPSCALE_MODEL_DIR, version: UPSCALE_MODEL_CACHE_VERSION,
  dbg: createDebugLogger({ tag: 'upscale-prefetch', storageKey: 'lolly:upscale:debug', globalFlag: '__UPSCALE_DEBUG__' }),
});
const matteFetch = createModelFetcher({
  store: MATTE_MODEL_STORE, dir: MATTE_MODEL_DIR, version: MATTE_MODEL_CACHE_VERSION,
  dbg: createDebugLogger({ tag: 'matte-prefetch', storageKey: 'lolly:matte:debug', globalFlag: '__MATTE_DEBUG__' }),
});

export interface PrefetchResult { ok: boolean; bytes: number; files: number }
type OnProgress = (p: DownloadProgress) => void;

/** The upscale files the offline part vendors: every staged model, plus GFPGAN's
 *  small face-detector helper, plus the WDN denoise partner only when it's staged.
 *  The default (general) model is first — stagedUpscaleModels preserves roster order. */
export function upscaleOfflineFiles(): string[] {
  const files = stagedUpscaleModels().map(m => UPSCALE_MODEL_FILES[m.id]);
  files.push(UPSCALE_FACE_DETECT_FILE);
  if (UPSCALE_DENOISE_STAGED) files.push(UPSCALE_WDN_FILE);
  return files;
}

/** The matte files the offline part vendors: every staged background-removal model. */
export function matteOfflineFiles(): string[] {
  return stagedMatteModels().map(m => MATTE_MODEL_FILES[m.id]);
}

/**
 * Fetch a list of model files into one detector's IDB store, reporting a single
 * running-total bar across them (a cache hit / 404 folds its file's size in without
 * a per-chunk callback, so the bar only ever reflects observed bytes; `total` goes
 * null the moment any file never reports a Content-Length). `required` names the
 * files that must succeed for the part to count as complete — aux helpers are
 * best-effort. The fetchers take no AbortSignal (they finish a file in flight), so
 * a cancel lands between files at the latest.
 */
async function prefetchList(
  fetcher: (file: string, cacheOnly?: boolean, onProgress?: (p: FetchProgress) => void) => Promise<ArrayBuffer | null>,
  files: string[],
  required: ReadonlySet<string>,
  opts: { signal?: AbortSignal; onProgress?: OnProgress },
): Promise<PrefetchResult> {
  const { signal, onProgress } = opts;
  const count = files.length;
  // doneBytes/doneTotal accrue only on SETTLE (a file's final byteLength); during a
  // file's stream the bar shows the settled totals plus this file's live figures, so
  // it never double-counts and never jumps backwards. `unknownTotal` latches null.
  let doneBytes = 0, doneTotal = 0, unknownTotal = false, done = 0, missingRequired = 0;
  const onFile = (p: FetchProgress): void => {
    if (p.total == null) unknownTotal = true;
    onProgress?.({ loaded: doneBytes + p.loaded, total: unknownTotal ? null : doneTotal + (p.total ?? 0), done, count });
  };
  const settle = (bytes: ArrayBuffer | null, file: string): void => {
    if (bytes) { doneBytes += bytes.byteLength; doneTotal += bytes.byteLength; }
    else { unknownTotal = true; if (required.has(file)) missingRequired++; }
    done++;
    onProgress?.({ loaded: doneBytes, total: unknownTotal ? null : doneTotal, done, count });
  };
  for (const file of files) {
    signal?.throwIfAborted();
    const bytes = await fetcher(file, false, onFile).catch(() => null);
    settle(bytes, file);
  }
  signal?.throwIfAborted();
  return { ok: missingRequired === 0, bytes: doneBytes, files: done };
}

/** Pre-download every staged upscale model into the `upscale-models` IDB store.
 *  `ok` is true only when all staged MODEL files landed (the face-detector is
 *  best-effort). */
export function prefetchUpscaleModels(opts: { signal?: AbortSignal; onProgress?: OnProgress } = {}): Promise<PrefetchResult> {
  const required = new Set(stagedUpscaleModels().map(m => UPSCALE_MODEL_FILES[m.id]));
  return prefetchList(upscaleFetch, upscaleOfflineFiles(), required, opts);
}

/** Pre-download every staged matte model into the `matte-models` IDB store. */
export function prefetchMatteModels(opts: { signal?: AbortSignal; onProgress?: OnProgress } = {}): Promise<PrefetchResult> {
  const required = new Set(matteOfflineFiles());
  return prefetchList(matteFetch, matteOfflineFiles(), required, opts);
}

// ─── Measurement (for the /profile storage-reconciliation meter) ──────────────
//
// Measures what is ACTUALLY on device in a model store — filled by this prefetch OR
// by the dialog's own on-demand download — the twin of offline-manager's
// speechCacheBytes. Reads only the KEYS (filenames, cheap) and sums the roster's
// exact declared sizes, so it never deserialises the multi-hundred-MB ArrayBuffers
// just to weigh them. An aux file with no roster entry (the tiny face detector)
// counts 0 and folds into the meter's honest "Other" remainder.
async function modelStoreBytes(store: string, sizeByFile: Map<string, number>): Promise<{ bytes: number; files: number }> {
  try {
    const db = await openDB();
    const keys = await db.getAllKeys(store);
    let bytes = 0, files = 0;
    for (const k of keys) { bytes += sizeByFile.get(String(k)) ?? 0; files++; }
    return { bytes, files };
  } catch { return { bytes: 0, files: 0 }; }
}

/** Bytes of the staged upscale models currently cached in `upscale-models` IDB. */
export function upscaleCacheBytes(): Promise<{ bytes: number; files: number }> {
  const sizeByFile = new Map(stagedUpscaleModels().map(m => [UPSCALE_MODEL_FILES[m.id], m.approxBytes]));
  return modelStoreBytes(UPSCALE_MODEL_STORE, sizeByFile);
}

/** Bytes of the staged matte models currently cached in `matte-models` IDB. */
export function matteCacheBytes(): Promise<{ bytes: number; files: number }> {
  const sizeByFile = new Map(stagedMatteModels().map(m => [MATTE_MODEL_FILES[m.id], m.approxBytes]));
  return modelStoreBytes(MATTE_MODEL_STORE, sizeByFile);
}
