// SPDX-License-Identifier: MPL-2.0
/**
 * The "Available offline" download manager — the engine behind the profile
 * view's offline section.
 *
 * offline-pins.ts makes ONE TOOL a guarantee; this module makes the PROMISE a
 * guarantee: a user with an hour of airport wifi can pull down every part of
 * the app they'll need for a connectionless flight and watch a real progress
 * bar while it happens. Four downloadable parts, each landing in the
 * service-worker bucket (or store) that actually serves it offline:
 *
 *   app     — the full build payload (dist/precache.json `app` group: every
 *             hashed /assets/ chunk incl. lazy views + locale chunks +
 *             HarfBuzz wasm, the bundled UI fonts, icons, share stubs) into
 *             the APP_CACHE bucket. Closes the biggest hole in the offline
 *             story: before this, a lazy chunk cached only if its code path
 *             ran while online.
 *   docs    — the /info site (its manifest.json: the English pages, the
 *             shared screenshots, plus the active locale) into INFO_CACHE.
 *   verify  — the deep-scan machinery: the onnxruntime-web runtime
 *             (precache.json `ort` group) into ORT_CACHE, plus the TrustMark /
 *             Content Seal models through their own IndexedDB fetchers
 *             (lib/trustmark.ts, lib/contentseal.ts). ~220 MB — opt-in.
 *   catalog — brand/catalog assets beyond the core tier, whole or scoped by
 *             tag. The BYTES go through catalog/sync.ts's checksum-verified
 *             prefetch into the IDB blob cache (threaded in by the view, same
 *             cycle-avoidance as offline-pins' PrefetchAssets); this module
 *             owns the SELECTION (which tags / all), which sync.ts reads back
 *             at boot to keep those blobs out of the browsed-but-unsaved prune
 *             and refreshed with the core tier.
 *
 * (Tools stay offline-pins.ts's job — the profile section drives both.)
 *
 * Downloads are resumable and cancellable: every file already present (same
 * URL, and where sizes are known, same byte size) is skipped, so a dropped
 * connection or a cancelled run resumes from where it stopped, and a deploy
 * re-downloads only the delta (hashed /assets/ names miss the cache only when
 * their content actually changed). An AbortController threads through every
 * fetch. Part state (which parts are downloaded, at which manifest version)
 * persists in IndexedDB next to the pin map — device-local, never in the
 * portable backup.
 *
 * resyncOfflineParts() keeps a downloaded install current: called from the
 * boot idle path (catalog/sync.ts, beside the pinned-tool refresh), it
 * re-syncs any downloaded part whose manifest version watermark moved.
 */

import { openDB } from '../bridge/db.ts';
import { currentLang } from '../i18n.ts';

/** The page-owned, unversioned Cache Storage buckets sw.js serves offline
 *  fallbacks from. Mirrored by sw.js (APP_CACHE / ORT_CACHE / INFO_CACHE
 *  there) — keep the literals in sync, same contract as offline-pins.ts's
 *  PIN_CACHE. */
export const APP_CACHE = 'lolly-app';
export const ORT_CACHE = 'lolly-ort';
export const INFO_CACHE = 'lolly-info';

/** Key of the part-state record inside the 'profile' KV store (a sibling of
 *  offline-pins' map — device-local by design, see the module comment). */
const PARTS_KEY = 'offline-parts';

/** One downloadable file as the manifests list it. `hash` (sha256, base64url,
 *  truncated) is present for files whose URL does not already encode their
 *  content (everything except the content-hash-named /assets/ chunks and the
 *  huge, release-versioned /ort/ + /models/ binaries) — it is what lets a
 *  resume distinguish "current" from "same size, different bytes". */
export interface ManifestFile { url: string; size: number; hash?: string }

/** dist/precache.json — emitted by the vite build (see vite.config.js's
 *  precacheManifest plugin). Absent in dev (the dev server has no dist). */
export interface PrecacheManifest {
  version: string;
  /** `models` is size metadata only — those bytes download through
   *  lib/trustmark.ts's own IndexedDB path, never through downloadList. */
  groups: { app: ManifestFile[]; ort: ManifestFile[]; models: ManifestFile[] };
}

/** /info/manifest.json — emitted by docs/build.ts. */
export interface InfoManifest {
  version: string;
  groups: { en: ManifestFile[]; shots: ManifestFile[]; locales: Record<string, ManifestFile[]> };
}

export type OfflinePartId = 'app' | 'docs' | 'verify' | 'catalog';

/** What one downloaded part records. `version` is the manifest watermark the
 *  download completed against; resyncOfflineParts re-downloads the delta when
 *  the live manifest's version differs. */
export interface PartRecord {
  at: string;
  version: string;
  bytes: number;
  files: number;
  /** docs: the locale downloaded alongside English. */
  lang?: string;
  /** catalog: the scope — 'all' or the selected tag list. */
  tags?: 'all' | string[];
}

export type PartState = Partial<Record<OfflinePartId, PartRecord>>;

/** Byte-level progress for one running download. `total` is the sum of the
 *  manifest-listed sizes (bytes already on device count as loaded, so a resume
 *  starts the bar where it left off); null while a phase can't know its total
 *  (the model fetchers report a running total that goes null on any file
 *  without a Content-Length). */
export interface DownloadProgress {
  loaded: number;
  total: number | null;
  done: number;
  count: number;
}
export type OnProgress = (p: DownloadProgress) => void;

async function readParts(): Promise<PartState> {
  const db = await openDB();
  return ((await db.get('profile', PARTS_KEY)) as PartState | undefined) ?? {};
}

async function writeParts(parts: PartState): Promise<void> {
  const db = await openDB();
  await db.put('profile', parts, PARTS_KEY);
}

/** The recorded state of every downloaded part. */
export async function partRecords(): Promise<PartState> {
  return readParts();
}

// Every read-modify-write of the part map goes through one in-page queue: the
// profile UI and the boot-idle resync can both finish a download in the same
// session, and two interleaved readParts→writeParts round-trips would lose one
// record (or resurrect a part the user just removed).
let partsChain: Promise<unknown> = Promise.resolve();
function withParts<T>(fn: () => Promise<T>): Promise<T> {
  const next = partsChain.then(fn, fn);
  partsChain = next.catch(() => {});
  return next;
}

function recordPart(id: OfflinePartId, rec: PartRecord): Promise<void> {
  return withParts(async () => {
    const parts = await readParts();
    parts[id] = rec;
    await writeParts(parts);
  });
}

function forgetPart(id: OfflinePartId): Promise<void> {
  return withParts(async () => {
    const parts = await readParts();
    if (parts[id]) {
      delete parts[id];
      await writeParts(parts);
    }
  });
}

/** Fetch + parse a download manifest; null when it isn't there (dev server, or
 *  an instance built before manifests existed). The SPA-fallback guard matters:
 *  a missing /precache.json comes back as the app shell's HTML with a 200. */
async function fetchManifest<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok || (resp.headers.get('content-type') ?? '').includes('text/html')) return null;
    return await resp.json() as T;
  } catch {
    return null;
  }
}

export function fetchPrecacheManifest(): Promise<PrecacheManifest | null> {
  return fetchManifest<PrecacheManifest>('/precache.json');
}

export function fetchInfoManifest(): Promise<InfoManifest | null> {
  return fetchManifest<InfoManifest>('/info/manifest.json');
}

/** The docs file list for one install: English pages + shared shots + the
 *  active locale's pages (English needs no extra group). */
export function docsFileList(manifest: InfoManifest, lang: string): ManifestFile[] {
  const { en, shots, locales } = manifest.groups;
  return [...en, ...shots, ...(lang !== 'en' ? locales[lang] ?? [] : [])];
}

/** The header a downloaded entry records its manifest identity under — what a
 *  resume compares instead of guessing from transfer headers. */
const HASH_HEADER = 'x-lolly-manifest-hash';
const SIZE_HEADER = 'x-lolly-manifest-size';

/** Is this cached copy still the manifest's copy? Hashed /assets/ names make
 *  existence proof enough. Everything else compares the manifest identity the
 *  download stamped onto the stored response: the content hash when the
 *  manifest carries one, else the DECODED byte size (never the wire
 *  Content-Length — that is the compressed transfer size on a br/gzip host
 *  and comparing it to the on-disk manifest size would re-download every file
 *  on every resume). A stale or unstamped entry is treated as absent. */
async function cachedMatches(cache: Cache, file: ManifestFile): Promise<boolean> {
  const held = await cache.match(file.url);
  if (!held) return false;
  if (/^\/assets\//.test(file.url)) return true;
  if (file.hash) return held.headers.get(HASH_HEADER) === file.hash;
  const stamped = held.headers.get(SIZE_HEADER);
  return stamped !== null && Number(stamped) === file.size;
}

/** Store one fetched file. The response is REBUILT around the decoded body:
 *  fetch() transparently decodes br/gzip but leaves the wire headers, so
 *  putting the original headers with a decoded body poisons the entry — the
 *  browser would try to decode it AGAIN when the SW replays it offline
 *  (net::ERR_CONTENT_DECODING_FAILED on the exact chunk the download existed
 *  to guarantee). Strip the transfer headers, set the true length, and stamp
 *  the manifest identity for cachedMatches. */
async function putFile(cache: Cache, file: ManifestFile, resp: Response): Promise<void> {
  const blob = await resp.blob();
  const headers = new Headers(resp.headers);
  headers.delete('content-encoding');
  headers.delete('content-range');
  headers.delete('transfer-encoding');
  headers.set('content-length', String(blob.size));
  headers.set(SIZE_HEADER, String(blob.size));
  if (file.hash) headers.set(HASH_HEADER, file.hash);
  await cache.put(file.url, new Response(blob, { status: resp.status, statusText: resp.statusText, headers }));
}

const DOWNLOAD_CONCURRENCY = 4;

/**
 * Download a manifest file list into a named bucket. Resumable (files already
 * present and current are folded into `loaded` without a fetch), cancellable
 * (`signal` aborts the in-flight fetches and stops the queue), and honest
 * about failures: any file that can't be fetched throws once the queue
 * drains, so a "downloaded" part is never silently partial.
 */
export async function downloadList(
  cacheName: string,
  files: ManifestFile[],
  opts: { signal?: AbortSignal; onProgress?: OnProgress } = {},
): Promise<{ bytes: number; files: number }> {
  if (!('caches' in globalThis)) throw new Error('offline download: Cache Storage unavailable');
  const { signal, onProgress } = opts;
  const cache = await caches.open(cacheName);
  const total = files.reduce((n, f) => n + f.size, 0);
  let loaded = 0;
  let done = 0;
  const failures: string[] = [];
  const report = () => onProgress?.({ loaded, total, done, count: files.length });
  report();

  const queue = [...files];
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      signal?.throwIfAborted();
      try {
        if (await cachedMatches(cache, file)) {
          loaded += file.size;
          done++;
          report();
          continue;
        }
        const resp = await fetch(file.url, { signal });
        const ct = resp.headers.get('content-type') ?? '';
        // SPA-fallback guard: HTML for a non-.html path = the file is gone.
        if (!resp.ok || (ct.includes('text/html') && !file.url.endsWith('.html'))) {
          failures.push(file.url);
          continue;
        }
        await putFile(cache, file, resp);
        loaded += file.size;
        done++;
        report();
      } catch (err) {
        if (signal?.aborted) throw err;
        failures.push(file.url);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, files.length) }, worker));
  signal?.throwIfAborted();
  if (failures.length) throw new Error(`offline download: ${failures.length} of ${files.length} files failed (first: ${failures[0]})`);
  return { bytes: total, files: files.length };
}

/** Evict every entry in a bucket that a fresh manifest no longer lists —
 *  yesterday's hashed chunks and retired docs pages don't deserve quota. */
async function pruneList(cacheName: string, files: ManifestFile[]): Promise<void> {
  const cache = await caches.open(cacheName);
  const keep = new Set(files.map(f => f.url));
  for (const req of await cache.keys()) {
    if (!keep.has(new URL(req.url).pathname)) await cache.delete(req);
  }
}

/** Download the whole app build for offline (see module comment: `app` part). */
export async function downloadApp(
  manifest: PrecacheManifest,
  opts: { signal?: AbortSignal; onProgress?: OnProgress } = {},
): Promise<PartRecord> {
  const res = await downloadList(APP_CACHE, manifest.groups.app, opts);
  await pruneList(APP_CACHE, manifest.groups.app);
  const rec: PartRecord = { at: new Date().toISOString(), version: manifest.version, ...res };
  await recordPart('app', rec);
  return rec;
}

/** Download the /info docs site (English + shots + the active locale). */
export async function downloadDocs(
  manifest: InfoManifest,
  opts: { signal?: AbortSignal; onProgress?: OnProgress } = {},
): Promise<PartRecord> {
  const lang = currentLang();
  const files = docsFileList(manifest, lang);
  const res = await downloadList(INFO_CACHE, files, opts);
  await pruneList(INFO_CACHE, files);
  const rec: PartRecord = { at: new Date().toISOString(), version: manifest.version, lang, ...res };
  await recordPart('docs', rec);
  return rec;
}

/**
 * Download the /verify deep-scan machinery: the ORT runtime into ORT_CACHE,
 * then the TrustMark + Content Seal models through their own IDB fetchers
 * (lazy-imported — those modules must stay off the boot graph). Model bytes
 * report as a running total on top of the runtime's known size, going
 * null-total (indeterminate) if any model omits Content-Length.
 */
export async function downloadVerify(
  manifest: PrecacheManifest,
  opts: { signal?: AbortSignal; onProgress?: OnProgress } = {},
): Promise<PartRecord> {
  const { signal, onProgress } = opts;
  const ortTotal = manifest.groups.ort.reduce((n, f) => n + f.size, 0);
  // Seed the model share of the bar from the manifest's size metadata — the
  // fetchers only learn sizes file by file, and a total that grows under the
  // bar makes it jump backwards. The running total takes over only if it ever
  // exceeds the plan (a bigger model shipped than the manifest knew).
  const plannedModels = manifest.groups.models.reduce((n, f) => n + f.size, 0);
  let modelLoaded = 0;
  let modelTotal: number | null = 0;
  let ortLoaded = 0;
  let ortDone = 0;
  const report = () => onProgress?.({
    loaded: ortLoaded + modelLoaded,
    total: modelTotal === null ? null : ortTotal + Math.max(plannedModels, modelTotal),
    done: ortDone,
    count: manifest.groups.ort.length,
  });

  const res = await downloadList(ORT_CACHE, manifest.groups.ort, {
    signal,
    onProgress: p => { ortLoaded = p.loaded; ortDone = p.done; report(); },
  });
  await pruneList(ORT_CACHE, manifest.groups.ort);

  // Model downloads are the same fetch-once-into-IDB path the /verify header's
  // own "enable deep scan" button uses — one copy, shared consent.
  signal?.throwIfAborted();
  const [{ prefetchTrustmarkModels }, { prefetchContentSealModel }] = await Promise.all([
    import('./trustmark.ts'),
    import('./contentseal.ts'),
  ]);
  const onModel = (p: { loaded: number; total: number | null }): void => {
    modelLoaded = p.loaded;
    modelTotal = p.total;
    report();
  };
  const okTm = await prefetchTrustmarkModels({ onProgress: p => onModel({ loaded: p.loaded, total: p.total }) });
  const modelBase = modelLoaded;
  signal?.throwIfAborted();
  // Best-effort: the Content Seal extractor is usually never vendored at all
  // (its prefetch returns false on the routine 404) — only the TrustMark
  // decoder decides whether this part counts as downloaded.
  await prefetchContentSealModel({ onProgress: p => onModel({ loaded: modelBase + p.loaded, total: p.total === null || modelTotal === null ? null : modelBase + p.total }) });
  if (!okTm) throw new Error('offline download: TrustMark model download incomplete');
  // The model fetchers take no AbortSignal (they finish the file in flight),
  // so a cancel lands HERE at the latest — a cancelled run must never record
  // itself as a completed part.
  signal?.throwIfAborted();

  const rec: PartRecord = {
    at: new Date().toISOString(),
    version: manifest.version,
    bytes: res.bytes + modelLoaded,
    files: res.files,
  };
  await recordPart('verify', rec);
  return rec;
}

/** Record a completed catalog download's scope + measured size. The BYTES went
 *  through catalog/sync.ts's prefetch (threaded in by the view); this record is
 *  what keeps them protected + refreshed at every boot (sync.ts reads it back
 *  via offlineCatalogScope). */
export async function recordCatalogDownload(tags: 'all' | string[], bytes: number, files: number): Promise<void> {
  await recordPart('catalog', { at: new Date().toISOString(), version: '', bytes, files, tags });
}

/** The saved catalog scope, or null when no catalog download is recorded.
 *  catalog/sync.ts reads this at boot to extend the prune keep-set and the
 *  core-tier refresh to the downloaded selection. */
export async function offlineCatalogScope(): Promise<'all' | string[] | null> {
  try {
    return (await readParts()).catalog?.tags ?? null;
  } catch {
    return null;
  }
}

/** Remove one downloaded part. app/docs/verify delete their buckets (verify
 *  also clears the model stores — the same bytes /verify's own banner offers,
 *  so removing here re-offers the download there). catalog only forgets the
 *  SELECTION: the blobs are shared with sessions and pins, so the next catalog
 *  sync's prune reclaims whatever nothing else references. */
export async function removePart(id: OfflinePartId): Promise<void> {
  if ('caches' in globalThis) {
    if (id === 'app') await caches.delete(APP_CACHE);
    if (id === 'docs') await caches.delete(INFO_CACHE);
    if (id === 'verify') await caches.delete(ORT_CACHE);
  }
  if (id === 'verify') {
    try {
      const db = await openDB();
      await db.clear('trustmark-models').catch(() => {});
      await db.clear('contentseal-models').catch(() => {});
    } catch { /* stores absent — nothing to clear */ }
  }
  await forgetPart(id);
}

/**
 * Re-sync every downloaded part whose manifest watermark moved — called from
 * the boot idle path (catalog/sync.ts, beside refreshPinnedToolFiles). Cheap
 * when nothing changed (two small manifest fetches); after a deploy it
 * re-downloads only the delta, since unchanged files skip via cachedMatches.
 * Best-effort: a failed re-sync keeps the old record so the next boot retries.
 */
export async function resyncOfflineParts(): Promise<void> {
  const parts = await readParts();
  if (parts.app || parts.verify) {
    const manifest = await fetchPrecacheManifest();
    if (manifest) {
      if (parts.app && parts.app.version !== manifest.version) {
        await downloadApp(manifest).catch(() => {});
      }
      if (parts.verify && parts.verify.version !== manifest.version) {
        await downloadVerify(manifest).catch(() => {});
      }
    }
  }
  if (parts.docs) {
    const manifest = await fetchInfoManifest();
    // A language switch re-downloads too — the docs part promises the ACTIVE locale.
    if (manifest && (parts.docs.version !== manifest.version || parts.docs.lang !== currentLang())) {
      await downloadDocs(manifest).catch(() => {});
    }
  }
}

/** Storage headroom for a planned download. `fits` applies the same safety
 *  fraction the asset store's quota guard uses — a download that would land
 *  the device on the quota ceiling breaks saves everywhere else. */
export async function storageHeadroom(plannedBytes: number): Promise<{ fits: boolean; free: number | null }> {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (!quota) return { fits: true, free: null };
    const free = Math.max(0, quota * 0.9 - usage);
    return { fits: plannedBytes <= free, free };
  } catch {
    return { fits: true, free: null };
  }
}

/** Whether the browser granted persistent storage — surfaced in the offline
 *  section because it's the difference between "downloaded" and "downloaded
 *  until the browser feels storage pressure". Requested (silently, once) at
 *  bridge construction; this re-requests on demand from a user gesture, which
 *  is exactly when browsers are most willing to grant it. */
export async function persistenceState(request = false): Promise<'granted' | 'denied' | 'unsupported'> {
  try {
    if (!navigator.storage?.persisted) return 'unsupported';
    if (await navigator.storage.persisted()) return 'granted';
    if (request && await navigator.storage.persist()) return 'granted';
    return 'denied';
  } catch {
    return 'unsupported';
  }
}
