// SPDX-License-Identifier: MPL-2.0
/**
 * Catalog sync.
 *
 * On boot, fetch the tool catalog manifest and asset catalog manifest from
 * known URLs. Diff against IndexedDB. Update meta. Prefetch core-tier assets.
 *
 * The catalog base defaults to same-origin /catalog/, and every fetch here goes
 * through lib/instance.ts (instancePath/instanceFetch): when the user points
 * the shell at a remote Lolly deployment, the same sync runs against that
 * instance's catalog — checksum verification included. See lib/instance.ts's
 * module header for the offline/SW/signing consequences of a remote base.
 *
 * Sync is idempotent and resumable. Network failure ≠ broken app — we fall back
 * to whatever is in cache and flip `networkStatus.offline`, which surfaces a small
 * self-contained "offline" chip (and is readable by views that want their own
 * indicator).
 */

import { verifyAssetChecksum } from '../bridge/assets.ts';
import { assertToolIndexIntegrity } from './integrity.ts';
import { currentLang } from '../i18n.ts';
import { pinnedAssetIds, refreshPinnedToolFiles } from '../lib/offline-pins.ts';
import { initInstanceBase, instanceFetch, instancePath } from '../lib/instance.ts';

/** One resolvable file for a catalog asset (an entry in an asset's `formats`).
 *  Structurally matches the bridge's AssetFormat so it flows into
 *  verifyAssetChecksum unchanged. */
interface AssetFormat {
  format: string;
  url: string;
  checksum?: string;
}

/** A catalog asset's stored metadata, as it arrives in /catalog/assets/index.json
 *  and flows straight into host.assets._syncFromIndex. */
interface AssetMetaRecord {
  id: string;
  version?: string;
  tier?: string;
  /** Generative-AI provenance disclosure — flows verbatim into the asset-meta store. */
  aiGenerated?: 'full' | 'partial';
  formats: AssetFormat[];
  [key: string]: unknown;
}

/** The tool catalog index as fetched from /catalog/tools/index.json. */
interface ToolIndex {
  version?: string;
  /** Rolls only when the tool set actually changes (build-catalog-index.ts keeps
   *  it stable on idempotent regeneration) — the pin-refresh watermark. */
  generatedAt?: string;
  tools: Array<{ id: string } & Record<string, unknown>>;
}

/** The asset catalog index as fetched from /catalog/assets/index.json. */
interface AssetIndex {
  assets: AssetMetaRecord[];
  /** Curated asset ids every user starts with favourited (seeded once, on first run —
   *  see boot() in main.ts). SUSE-specific content, so it's authored here in the catalog
   *  data, not in shell code. */
  defaultFavourites?: string[];
}

/**
 * Overlay a tool's translated name/description/featured.blurb (the `i18n` block
 * scripts/build-catalog-index.ts folds into each index entry from the tool's own
 * `i18n/<lang>.json` sidecar — see engine/src/loader.ts's applyManifestI18n for
 * the full-manifest counterpart used when a tool is actually opened) onto the
 * flat index entries every tool-listing view reads via window.__toolIndex.
 * Mutates in place. Called at every point that assigns window.__toolIndex (below,
 * and main.ts's synchronous cache-priming path) so gallery/catalog/projects/
 * dashboard/picker all get the active language for free — no per-view changes.
 * No-op for English (the index's own fields already are English) and for any
 * tool whose sidecar doesn't cover the active language (English fallback).
 */
export function localizeToolIndex(index: ToolIndex): void {
  const lang = currentLang();
  if (lang === 'en') return;
  for (const tool of index.tools) {
    const i18n = tool.i18n as Record<string, { name?: string; description?: string; blurb?: string }> | undefined;
    const overlay = i18n?.[lang];
    if (!overlay) continue;
    if (overlay.name) tool.name = overlay.name;
    if (overlay.description) tool.description = overlay.description;
    if (overlay.blurb && tool.featured && typeof tool.featured === 'object') {
      (tool.featured as Record<string, unknown>).blurb = overlay.blurb;
    }
  }
}

declare global {
  interface Window {
    /** In-memory tool catalog index, populated at boot by syncTools. */
    __toolIndex?: ToolIndex;
  }
}

/** The slice of the host bridge catalog sync drives. */
interface SyncHost {
  log(level: string, msg: string, data?: Record<string, unknown>): void;
  assets: {
    _syncFromIndex(assets: AssetMetaRecord[]): Promise<unknown>;
    _pruneStale(assets: AssetMetaRecord[], sessionRefs: Set<string>): Promise<{ blobs: number; meta: number }>;
    _hasBlob(key: string): Promise<boolean>;
    _cacheBlob(key: string, blob: Blob): Promise<unknown>;
  };
  state: { _getAssetRefs(): Promise<Set<string>> };
}

/** Stored conditional-request validators for a catalog resource. */
interface CatalogMeta {
  etag?: string | null;
  lastModified?: string | null;
}

const CATALOG_BASE = '/catalog';
const LS_PREFIX = 'sbt-catalog:';

/**
 * Set true whenever a catalog/asset sync falls back to cache instead of fresh
 * network data (offline or a failed fetch). Exported as a live, mutable object so
 * views can read `networkStatus.offline` without importing a getter.
 */
export const networkStatus = { offline: false };

function setOffline(value: boolean): void {
  networkStatus.offline = value;
  renderOfflineChip(value);
}

/**
 * Minimal, self-contained offline chip. Non-interactive (pointer-events:none) so
 * it can never steal focus or intercept clicks — a richer indicator belongs in a
 * view, which can read networkStatus.offline directly.
 */
function renderOfflineChip(offline: boolean): void {
  if (typeof document === 'undefined' || !document.body) return;
  let chip = document.getElementById('sbt-offline-chip');
  if (!offline) {
    if (chip) chip.hidden = true;
    return;
  }
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'sbt-offline-chip';
    chip.setAttribute('role', 'status');
    chip.setAttribute('aria-live', 'polite');
    chip.textContent = 'Offline — showing saved content';
    chip.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483647',
      'pointer-events:none', 'padding:6px 10px', 'border-radius:999px',
      'font:500 12px/1.2 system-ui,-apple-system,sans-serif', 'color:#fff',
      'background:rgba(20,20,20,.82)', 'box-shadow:0 1px 4px rgba(0,0,0,.3)',
    ].join(';');
    document.body.appendChild(chip);
  }
  chip.hidden = false;
}

// The tool index is the one fetch the whole gallery depends on. A single
// transient failure on a cold first load would otherwise leave a brand-new user
// (no localStorage fallback) with an empty gallery and no recovery short of a
// manual hard refresh — so retry a few times with linear backoff before giving up.
const CATALOG_FETCH_ATTEMPTS = 3;
const CATALOG_RETRY_BASE_MS = 400; // waits ~400ms, ~800ms between attempts
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function getCatalogMeta(key: string): CatalogMeta | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? (JSON.parse(raw) as CatalogMeta) : null;
  } catch {
    return null;
  }
}

function setCatalogMeta(key: string, value: CatalogMeta): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage quota exceeded — non-fatal, ETags are a perf hint only.
  }
}

// Stash the parsed asset index from the most recent fresh (200) fetch so
// syncCorePrefetch can consume the core subset without re-fetching index.json.
let cachedAssetIndex: AssetIndex | null = null;

export async function syncCatalog(host: SyncHost): Promise<void> {
  // Load the persisted instance base BEFORE the first fetch. Wired here (not in
  // main.ts) so the sync bootstrap is self-contained: every entry point that
  // syncs gets the right base with no boot-order coordination. Never throws.
  await initInstanceBase();
  setOffline(false);
  try {
    await Promise.all([
      syncTools(host),
      syncAssets(host),
    ]);
  } catch (e) {
    setOffline(true);
    host.log('warn', 'Catalog sync failed; using cached', { error: String(e) });
  }
}

async function conditionalFetch(url: string, etagKey: string): Promise<Response | null> {
  const stored = getCatalogMeta(etagKey);
  const headers: Record<string, string> = {};
  if (stored?.etag) headers['If-None-Match'] = stored.etag;
  else if (stored?.lastModified) headers['If-Modified-Since'] = stored.lastModified;

  const resp = await instanceFetch(url, { headers });
  if (resp.status === 304) return null; // unchanged

  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);

  const etag = resp.headers.get('ETag');
  const lastModified = resp.headers.get('Last-Modified');
  if (etag || lastModified) {
    setCatalogMeta(etagKey, { etag, lastModified });
  }
  return resp;
}

async function syncTools(host: SyncHost): Promise<void> {
  // Conditional (ETag) fetch, same as syncAssets. window.__toolIndex is primed
  // from the localStorage copy at boot (main.ts) BEFORE this runs, so a 304 is
  // safe — the already-loaded index stays and we skip the 116 KB download plus
  // the re-stringify + synchronous localStorage rewrite. We keep the localStorage
  // copy (rewritten only on a fresh 200) so the gallery can fall back offline.
  for (let attempt = 0; attempt < CATALOG_FETCH_ATTEMPTS; attempt++) {
    try {
      const resp = await conditionalFetch(instancePath(`${CATALOG_BASE}/tools/index.json`), 'tool-index');
      if (!resp) {
        host.log('info', 'Tool catalog unchanged (304)');
        return;
      }
      const text = await resp.text();
      // Fail closed when this build pins a catalog signing key; inert otherwise
      // (catalog/integrity.ts). Throwing lands in the retry/offline path below.
      await assertToolIndexIntegrity(text);
      const index = JSON.parse(text) as ToolIndex;
      // Cache the PRISTINE (English-keyed, every locale's overlay intact) index —
      // localizeToolIndex runs after, on the in-memory copy only, so a later
      // language switch (or a different device/session) always re-derives from
      // the untranslated source rather than a copy some other language baked in.
      const json = JSON.stringify(index);
      // Record whether the fetched bytes actually differ from the cached copy, reusing
      // this same stringify. boot()'s fast-path reads toolIndexChanged() instead of
      // re-stringifying the 131 KB index twice on the pre-paint critical path. Must be
      // a content compare, not 200-vs-304: ETag-less hosts serve identical 200s.
      try { toolIndexDidChange = localStorage.getItem('sbt-tool-index') !== json; localStorage.setItem('sbt-tool-index', json); } catch { /* quota */ }
      localizeToolIndex(index);
      window.__toolIndex = index;
      host.log('info', `Tool catalog: ${index.tools.length} tools`);
      return;
    } catch (e) {
      if (attempt < CATALOG_FETCH_ATTEMPTS - 1) {
        await delay(CATALOG_RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      // Every attempt failed — restore from localStorage cache if available.
      setOffline(true);
      const cached = localStorage.getItem('sbt-tool-index');
      if (cached) {
        const offlineIndex = JSON.parse(cached) as ToolIndex;
        localizeToolIndex(offlineIndex);
        window.__toolIndex = offlineIndex;
        host.log('info', 'Tool catalog loaded from cache (offline)');
      } else {
        host.log('warn', `Tool catalog fetch failed: ${(e as Error).message}`);
      }
    }
  }
}

// The catalog's curated default-favourite asset ids, captured from the asset index on
// the boot that fetches it (a 304 keeps the prior value). boot() reads this to seed a
// brand-new user's favourites once. Empty until the first non-304 asset sync — which is
// guaranteed the first time this ships, since adding the list changes index.json's bytes.
// True iff the last tool-index sync fetched bytes differing from the cached copy.
// boot()'s fast-path reads this to decide whether to replay the gallery entrance
// cascade — false on a 304 or an offline cache-restore (both leave it untouched).
let toolIndexDidChange = false;
/** Whether the most recent tool-index sync actually changed the catalog data. */
export function toolIndexChanged(): boolean { return toolIndexDidChange; }

let defaultFavouriteIds: readonly string[] = [];
/** Ordered asset ids flagged `defaultFavourites` in the catalog index (empty if the index
 *  hasn't been fetched this session). Read once at boot to seed first-run favourites. */
export function defaultFavouriteAssetIds(): readonly string[] { return defaultFavouriteIds; }

/**
 * With a remote instance base set, rewrite the index's root-relative format
 * URLs to absolute instance URLs BEFORE they reach the asset-meta store — one
 * chokepoint that makes every downstream consumer (prefetch here, on-demand
 * fetchAndCache, picker thumbnail <img>s, tokens doc reads) follow the instance
 * without further threading. Passthrough (byte-identical) when no base is set.
 */
function absolutizeAssetUrls(index: AssetIndex): AssetIndex {
  for (const a of index.assets) {
    for (const f of a.formats) f.url = instancePath(f.url);
  }
  return index;
}

async function syncAssets(host: SyncHost): Promise<void> {
  const resp = await conditionalFetch(instancePath(`${CATALOG_BASE}/assets/index.json`), 'assets-index');
  if (!resp) {
    host.log('info', 'Asset catalog unchanged (304)');
    return;
  }
  const index = absolutizeAssetUrls(await resp.json() as AssetIndex);
  cachedAssetIndex = index; // let syncCorePrefetch reuse this fresh fetch
  if (Array.isArray(index.defaultFavourites)) {
    defaultFavouriteIds = index.defaultFavourites.filter((x): x is string => typeof x === 'string');
  }

  // Write metadata into IndexedDB so host.assets.get(id) can resolve any asset.
  await host.assets._syncFromIndex(index.assets);

  // Remove stale blobs: old versions, removed assets, and on-demand blobs not
  // referenced by any saved session (browsed-but-unsaved fetches don't accumulate).
  const sessionRefs = await host.state._getAssetRefs();
  // Assets referenced by a pinned ("available offline") tool count as referenced
  // too — a pin must survive the browsed-but-unsaved prune, at the CURRENT
  // catalog version (a version bump re-prefetches below, in syncCorePrefetch).
  try {
    const pinned = await pinnedAssetIds();
    if (pinned.size) {
      for (const a of index.assets) {
        if (!pinned.has(a.id)) continue;
        for (const f of a.formats) sessionRefs.add(`${a.id}:${f.format}:${a.version}`);
      }
    }
  } catch { /* pins unreadable — prune with session refs only */ }
  const pruned = await host.assets._pruneStale(index.assets, sessionRefs);
  if (pruned.blobs || pruned.meta) {
    host.log('info', `Pruned stale assets: ${pruned.blobs} blobs, ${pruned.meta} metadata entries`);
  }

  host.log('info', `Asset catalog synced: ${index.assets.length} assets`);
}

async function prefetchAsset(host: SyncHost, meta: AssetMetaRecord): Promise<void> {
  for (const fmt of meta.formats) {
    const key = `${meta.id}:${fmt.format}:${meta.version}`;
    if (await host.assets._hasBlob(key)) continue;
    const resp = await instanceFetch(fmt.url);
    if (!resp.ok) continue;
    const blob = await resp.blob();
    try {
      await verifyAssetChecksum(blob, fmt);
    } catch (e) {
      // Corrupt/tampered bytes — skip caching rather than storing a bad blob.
      host.log('warn', `Skipping prefetch (checksum mismatch): ${fmt.url}`, { error: String(e) });
      continue;
    }
    await host.assets._cacheBlob(key, blob);
  }
}

export async function syncCorePrefetch(host: SyncHost): Promise<void> {
  try {
    // Reuse the index syncAssets already fetched this boot. Only fall back to a
    // network fetch if it ran a 304 (unchanged) and never stashed one.
    let index = cachedAssetIndex;
    if (!index) {
      const resp = await instanceFetch(instancePath(`${CATALOG_BASE}/assets/index.json`));
      if (!resp.ok) return;
      index = absolutizeAssetUrls(await resp.json() as AssetIndex);
    }
    // Pinned tool FILES freshen on this idle path — keyed on a PERSISTED index
    // watermark, not this session's toolIndexChanged() flag: the flag is only
    // ever true in the one session that fetched fresh bytes, so a tab closed
    // mid-refresh would strand offline pins on the old deploy across every
    // later 304 boot (offline-pins.ts owns the watermark + retry semantics).
    // Runs BEFORE the asset pass below so a manifest that gained an asset ref
    // prefetches it this boot.
    const toolIndex = window.__toolIndex;
    if (toolIndex?.generatedAt) {
      await refreshPinnedToolFiles(`${toolIndex.version ?? ''}|${toolIndex.generatedAt}`).catch(() => {});
    }
    // Pinned ("available offline") tools' asset refs ride the core prefetch, so
    // a catalog version bump re-fetches them at the new version each boot.
    const pinned = await pinnedAssetIds().catch(() => new Set<string>());
    const wanted = index.assets.filter(a => a.tier === 'core' || pinned.has(a.id));
    await Promise.allSettled(wanted.map(a => prefetchAsset(host, a)));
  } catch (e) {
    host.log('warn', 'Core prefetch failed', { error: String(e) });
  }
}

/**
 * Prefetch specific catalog assets (by id) through the same checksum-verified
 * path as the core-tier boot prefetch. Offline pinning calls this at pin time —
 * threaded in by the view, since lib/offline-pins.ts can't import this module
 * without a cycle (syncAssets/syncCorePrefetch read pin state above).
 */
export async function prefetchAssetsById(host: SyncHost, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  let index = cachedAssetIndex;
  if (!index) {
    const resp = await instanceFetch(instancePath(`${CATALOG_BASE}/assets/index.json`));
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching asset index`);
    index = absolutizeAssetUrls(await resp.json() as AssetIndex);
    cachedAssetIndex = index;
  }
  const want = new Set(ids);
  await Promise.allSettled(index.assets.filter(a => want.has(a.id)).map(a => prefetchAsset(host, a)));
}
