// SPDX-License-Identifier: MPL-2.0
/**
 * AssetsAPI — global catalog + user uploads, presented as one surface.
 *
 * Resolution order for host.assets.get(id):
 *   1. user-assets store (if id starts with 'user/')
 *   2. asset-blob store (cached library asset)
 *   3. on-demand fetch from catalog URL (if 'on-demand' tier and net OK)
 *   4. throw if unavailable
 *
 * Tier behaviour:
 *   - core      → bundled with shell, always present
 *   - catalog   → synced at boot via catalog/sync.js
 *   - on-demand → fetched lazily, then cached
 */

import { parseThemedAssetId, applyIconTheme, parseIconThemesDoc } from '../../../../engine/src/icon-theme.ts';
import { parseTreatedAssetId, parsePhotoTreatmentsDoc, wrapRasterWithTreatment, stripAssetModifiers } from '../../../../engine/src/photo-treatment.ts';
import type { AssetRef, AssetQuery } from '../../../../engine/src/bridge/host-v1.ts';
import type { IconTheme } from '../../../../engine/src/icon-theme.ts';
import type { PhotoTreatment } from '../../../../engine/src/photo-treatment.ts';

/** One resolvable file for a catalog asset (an entry in AssetMetaRecord.formats). */
interface AssetFormat {
  format: string;
  url: string;
  checksum?: string;
  width?: number;
  height?: number;
}

/** A catalog asset's stored metadata (the 'asset-meta' IDB store). */
interface AssetMetaRecord {
  id: string;
  type: AssetRef['type'];
  name?: string;
  tags?: string[];
  version?: string;
  tier?: string;
  deprecated?: boolean;
  checksum?: string;
  width?: number;
  height?: number;
  meta?: Record<string, unknown>;
  formats: AssetFormat[];
}

/** A user-uploaded asset (the 'user-assets' IDB store) — already resolved to one blob/format. */
interface UserAssetRecord {
  id: string;
  type: AssetRef['type'];
  format: string;
  blob?: Blob;
  version?: string;
  checksum?: string;
  width?: number;
  height?: number;
  meta?: Record<string, unknown>;
  // Preserved Content Credentials captured at ingest — the raw C2PA manifest
  // store only (no pixels/EXIF), so a placed credentialed image can carry its
  // provenance into an export without re-hoarding the metadata upload strips.
  credential?: Uint8Array;
  credentialFormat?: string;
}

/** The record shape toAssetRef consumes — a user record or a catalog record resolved
 *  to one concrete blob/format (plus an optional cacheKey override for themed bakes). */
interface AssetRefSource {
  id: string;
  type: AssetRef['type'];
  format: string;
  version?: string;
  blob?: Blob;
  checksum?: string;
  width?: number;
  height?: number;
  meta?: Record<string, unknown>;
  cacheKey?: string;
}

/** One readwrite transaction over a single store. */
interface AssetsTx {
  store: {
    put(value: AssetMetaRecord): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
  done: Promise<void>;
}

/** The slice of the idb database this API touches (the asset-* + user-assets stores). */
interface AssetsDb {
  get(store: 'user-assets', id: string): Promise<UserAssetRecord | undefined>;
  get(store: 'asset-meta', id: string): Promise<AssetMetaRecord | undefined>;
  get(store: 'asset-blob', key: string): Promise<Blob | undefined>;
  getAll(store: 'user-assets'): Promise<UserAssetRecord[]>;
  getAll(store: 'asset-meta'): Promise<AssetMetaRecord[]>;
  getAll(store: 'asset-blob'): Promise<Blob[]>;
  getAllKeys(store: 'user-assets' | 'asset-meta' | 'asset-blob'): Promise<string[]>;
  put(store: 'user-assets', record: UserAssetRecord): Promise<unknown>;
  put(store: 'asset-blob', blob: Blob, key: string): Promise<unknown>;
  delete(store: 'user-assets', id: string): Promise<void>;
  transaction(store: 'asset-meta' | 'asset-blob', mode: 'readwrite'): AssetsTx;
}

const OBJECT_URL_CACHE = new Map<string, string>(); // key → blob URL, kept alive while bridge is.

// Parsed theme list from the catalog's icon-themes palette asset (a palette-type
// asset tagged "icon-themes"). Cached per session; reset when the catalog syncs.
let ICON_THEMES_CACHE: Promise<IconTheme[]> | null = null;

// Parsed treatment list from the catalog's photo-treatments palette asset (a
// palette-type asset tagged "photo-treatments"). Cached like ICON_THEMES_CACHE.
let PHOTO_TREATMENTS_CACHE: Promise<PhotoTreatment[]> | null = null;

/**
 * There is no hard cap on how many device images a user may keep — the library
 * is theirs to fill, and assertQuotaRoom() (below) is the real backstop, refusing
 * a write only when device storage is genuinely tight.
 *
 * Instead, as the library grows past these friendly milestones the UI nudges once
 * (see lib/asset-milestone.ts) to explain that device images stay on this device:
 * they don't travel inside share links, so an image only reaches someone else when
 * it's rendered into a file — and images everyone should always have belong in the
 * catalog. The nudge is informational, never blocking.
 */
export const USER_ASSET_MILESTONES = [20, 100, 500] as const;

// Refuse a write that would push storage past this fraction of the quota,
// rather than letting IndexedDB throw a QuotaExceededError mid-write.
const QUOTA_SAFETY_FRACTION = 0.9;

export function createAssetsAPI(db: AssetsDb) {
  const api = {
    async get(id: string, opts: { format?: string; version?: string } = {}): Promise<AssetRef> {
      if (id.startsWith('user/')) {
        const userAsset = await db.get('user-assets', id);
        if (!userAsset) throw new Error(`User asset not found: ${id}`);
        return toAssetRef(userAsset, 'user');
      }

      // A presentation modifier can ride in the id, chosen at pick time and baked
      // into a derived copy at resolve — the base asset is always resolved
      // normally first (blob cache keyed by base id):
      //   `<baseId>?theme=<themeId>`      — a themable two-colour icon pairing
      //   `<baseId>?treatment=<id>`       — a raster photo colour treatment
      // An id carries at most one, so baseId comes from whichever matched.
      const { baseId: themedBase, theme } = parseThemedAssetId(id);
      const { baseId: treatedBase, treatment } = parseTreatedAssetId(id);
      const baseId = theme ? themedBase : treatedBase;

      const meta = await db.get('asset-meta', baseId);
      if (!meta) throw new Error(`Asset not in catalog: ${id}`);

      const format = pickFormat(meta, opts.format);
      const version = opts.version ?? meta.version;
      const blobKey = `${baseId}:${format.format}:${version}`;
      const refMeta = { name: meta.name, tags: meta.tags };

      const loadBlob = async (): Promise<Blob> => {
        let blob = await db.get('asset-blob', blobKey);
        if (!blob) {
          if (meta.tier === 'on-demand') {
            blob = await fetchAndCache(meta, format, blobKey, db);
          } else {
            throw new Error(`Asset not cached: ${id} (tier: ${meta.tier})`);
          }
        }
        return blob;
      };

      if (theme) {
        const def = (await api._iconThemes()).find(t => t.id === theme);
        if (def) {
          // Cache key carries the pairing's colours, so palette edits re-bake,
          // and a resolve whose bake is already minted skips the blob entirely.
          const cacheKey = `library:${blobKey}:t:${theme}:${def.c1},${def.c2}`;
          const common = { ...meta, id, format: format.format, cacheKey, meta: { ...refMeta, theme, baseId } };
          if (OBJECT_URL_CACHE.has(cacheKey)) return toAssetRef(common, 'library');
          const baked = applyIconTheme(await (await loadBlob()).text(), def);
          if (baked) {
            return toAssetRef({ ...common, blob: new Blob([baked], { type: 'image/svg+xml' }) }, 'library');
          }
        }
        // Unknown theme or a non-themable file: serve the plain bytes but KEEP
        // the requested id — a theme that's temporarily unresolvable must not
        // be stripped from state the next save persists (and the CLI bridge
        // behaves the same way). Shares the base asset's object URL.
        return toAssetRef({
          ...meta, id, blob: await loadBlob(), format: format.format,
          cacheKey: `library:${blobKey}`, meta: refMeta,
        }, 'library');
      }

      if (treatment && meta.type === 'raster') {
        const def = (await api._photoTreatments()).find(t => t.id === treatment);
        // The wrapper is a fixed-size SVG, so it needs the photo's pixel dimensions.
        // The primary (jpg) format entry frequently omits them, so fall back to any
        // sibling format that carries a pair (e.g. the thumb) — all share the source
        // aspect, which is all the viewBox needs. Without this fallback the bake
        // silently no-ops and the plain (untreated) photo is served, so a picked
        // treatment wouldn't survive into the tool render.
        const dimSrc = (format.width && format.height) ? format : meta.formats.find(f => f.width && f.height);
        const w = dimSrc?.width, h = dimSrc?.height;
        if (def && w && h) {
          // The derived ref keeps the BASE format (jpg), not svg: it's still the
          // jpg blob that backs it, and pruning protects `<baseId>:jpg:<version>`
          // — the key the derived object URL depends on.
          const cacheKey = `library:${blobKey}:pt:${treatment}`;
          const common = { ...meta, id, format: format.format, cacheKey, meta: { ...refMeta, treatment, baseId } };
          if (OBJECT_URL_CACHE.has(cacheKey)) return toAssetRef(common, 'library');
          const href = await blobToDataUri(await loadBlob());
          const svg = wrapRasterWithTreatment({ href, width: w, height: h, treatment: def });
          return toAssetRef({ ...common, blob: new Blob([svg], { type: 'image/svg+xml' }) }, 'library');
        }
        // Unknown/invalid treatment or missing dimensions: plain bytes, keep the
        // id (same reasoning as the theme fallback above).
        return toAssetRef({
          ...meta, id, blob: await loadBlob(), format: format.format,
          cacheKey: `library:${blobKey}`, meta: refMeta,
        }, 'library');
      }

      return toAssetRef({ ...meta, blob: await loadBlob(), format: format.format, meta: refMeta }, 'library');
    },

    /**
     * Internal: colour pairings for themable icons, from the catalog's
     * palette asset tagged "icon-themes". [] when the catalog has none.
     * First entry is the default pairing (matches the fills baked into icons).
     * Caches the in-flight promise so concurrent cold-cache resolves share one
     * metadata scan; a transient failure is NOT cached (next call retries).
     */
    async _iconThemes(): Promise<IconTheme[]> {
      ICON_THEMES_CACHE ??= (async (): Promise<IconTheme[]> => {
        const all = await db.getAll('asset-meta');
        const pal = all.find(m => m.type === 'palette' && m.tags?.includes('icon-themes'));
        if (!pal) {
          // Distinguish "synced catalog has no themes" (cacheable) from
          // "metadata hasn't synced yet" (retry once it has).
          if (!all.length) throw new Error('asset metadata not synced yet');
          return [];
        }
        const blob = await api._getBlob(pal.id);
        return parseIconThemesDoc(JSON.parse(await blob!.text()));
      })().catch(() => {
        ICON_THEMES_CACHE = null; // unavailable ≠ broken: icons stay default, retry later
        return [];
      });
      return ICON_THEMES_CACHE;
    },

    /**
     * Internal: colour treatments for raster photos, from the catalog's palette
     * asset tagged "photo-treatments". [] when the catalog has none. Same caching
     * discipline as _iconThemes(); "None" is not listed here (it's the plain
     * photo with no id suffix — the picker prepends it).
     */
    async _photoTreatments(): Promise<PhotoTreatment[]> {
      PHOTO_TREATMENTS_CACHE ??= (async (): Promise<PhotoTreatment[]> => {
        const all = await db.getAll('asset-meta');
        const pal = all.find(m => m.type === 'palette' && m.tags?.includes('photo-treatments'));
        if (!pal) {
          if (!all.length) throw new Error('asset metadata not synced yet');
          return [];
        }
        const blob = await api._getBlob(pal.id);
        return parsePhotoTreatmentsDoc(JSON.parse(await blob!.text()));
      })().catch(() => {
        PHOTO_TREATMENTS_CACHE = null; // unavailable ≠ broken: photos stay untreated, retry later
        return [];
      });
      return PHOTO_TREATMENTS_CACHE;
    },

    async query(filter: AssetQuery = {}): Promise<AssetRef[]> {
      const all = await db.getAll('asset-meta');
      const filtered = all.filter(m => matchesFilter(m, filter));
      // Don't pre-resolve blob URLs — that forces every cached blob into memory.
      // Every format carries a static catalog URL (same-origin for core/catalog,
      // CDN for on-demand), so the picker can show a thumbnail directly without a
      // cached blob first. Only flag a placeholder when there's genuinely no URL
      // to resolve (an unresolved/on-demand tier with no static formats[0].url).
      return filtered.map((m): AssetRef => {
        // Pick the format the picker should point at: for video the actual clip (a
        // <video> plays it), for everything else formats[0] — never a companion still.
        const primary = m.type === 'video'
          ? (m.formats.find(f => /^(mp4|webm|mov)$/i.test(f.format)) ?? m.formats[0])
          : m.formats[0];
        // A still poster (a non-animation companion format) for the types that need
        // one: a lottie thumbnails from it (an <img> can't show the json); a video
        // can use it as its <video poster>. Excludes the animation/clip formats.
        const still = m.formats.find(f => !/^(json|mp4|webm|mov)$/i.test(f.format))?.url ?? '';
        const lottiePoster = m.type === 'lottie' ? still : '';
        const videoPoster = m.type === 'video' ? still : '';
        const directUrl = lottiePoster || (primary?.url ?? '');
        // Catalog animated rasters (gif/apng/animated-webp) are authored type:'raster'
        // and tagged "animated" so the picker badges the motion (user uploads carry the
        // same flag from ingest). Same-MIME still/animated can't be told apart otherwise.
        const animated = m.type === 'raster' && (m.tags?.includes('animated') ?? false);
        const posterUrl = lottiePoster || videoPoster;
        // The small WebP derivative (scripts/build-thumbnails.ts), if this raster has one.
        // Surfaced so a grid/list view can show the ~30 KB thumb instead of the full-res
        // original while a details/zoom view still resolves `url` (the original) for quality.
        const thumbUrl = m.formats.find(f => f.format === 'thumb')?.url ?? '';
        // The playable animation (JSON) for a lottie: `directUrl`/`url` point at the still
        // poster so an <img> thumbnail works, so surface the json separately for a looping
        // motion preview (catalog/picker). Video needs none — its directUrl is the clip.
        const animationUrl = m.type === 'lottie' ? (m.formats.find(f => f.format === 'json')?.url ?? '') : '';
        return {
          source: 'library',
          id: m.id,
          type: m.type,
          format: primary?.format ?? 'svg',
          url: directUrl,
          version: m.version,
          meta: {
            name: m.name, tags: m.tags, _placeholder: !directUrl,
            ...(posterUrl ? { posterUrl } : {}),
            ...(animated ? { animated: true } : {}),
            ...(thumbUrl ? { thumbUrl } : {}),
            ...(animationUrl ? { animationUrl } : {}),
          },
        };
      });
    },

    /**
     * Internal: called only by the picker UI to stash an uploaded blob.
     * Tools cannot call this directly — it's prefixed with _ to mark it as
     * non-public, and not declared in the v1 bridge contract.
     *
     * No count cap (see USER_ASSET_MILESTONES) — assertQuotaRoom() is the only
     * guard, at the bridge boundary so it can't be bypassed by a different caller,
     * and it refuses a write only when device storage is genuinely tight.
     */
    async _uploadUserAsset(record: UserAssetRecord): Promise<void> {
      await assertQuotaRoom(record.blob?.size ?? 0);
      await db.put('user-assets', record);
    },

    /** Internal: list the user's saved images, newest first, as resolved AssetRefs. */
    async _listUserAssets(): Promise<AssetRef[]> {
      const all = await db.getAll('user-assets');
      return all
        .sort((a, b) => String(b.id).localeCompare(String(a.id)))
        .map(rec => toAssetRef(rec, 'user'));
    },

    /**
     * Internal: full user-asset records *including the raw Blob*, for the data
     * backup/export. Unlike _listUserAssets (which returns AssetRefs without the
     * bytes), this hands back exactly what's stored so a bundle can round-trip it.
     */
    async _exportUserAssets(): Promise<UserAssetRecord[]> {
      return db.getAll('user-assets');
    },

    /**
     * Internal: write a user-asset record straight back in from a backup import.
     * Deliberately bypasses the personal-library cap and quota check — a restore
     * should faithfully reproduce the library the user exported, not be rejected
     * for being "too big" on arrival.
     */
    async _importUserAsset(record: UserAssetRecord): Promise<void> {
      await db.put('user-assets', record);
    },

    /** Internal: how many images are in the user's personal library. */
    async _userAssetsCount(): Promise<number> {
      return (await db.getAllKeys('user-assets')).length;
    },

    /** Internal: total bytes the user's images occupy (for the storage UI). */
    async _userAssetsSize(): Promise<number> {
      const all = await db.getAll('user-assets');
      return all.reduce((sum, r) => sum + (r?.blob?.size ?? 0), 0);
    },

    /** Internal: delete one user image and revoke its cached object URL. */
    async _deleteUserAsset(id: string): Promise<void> {
      await db.delete('user-assets', id);
      // toAssetRef keys user URLs as `user:<id>:<format>:<version>` — evict any.
      evictObjectUrlsByPrefix(`user:${id}:`);
    },

    /**
     * Internal: rename one user image — a read-modify-write of only `meta.name`.
     * Deliberately does NOT route through _uploadUserAsset: that would re-run
     * assertQuotaRoom against the (unchanged) blob size and could spuriously trip
     * STORAGE_FULL near quota. The id and `version` are untouched, so the cached
     * object URL stays valid (no eviction) and _listUserAssets order is preserved.
     * No-op if the asset is gone.
     */
    async _renameUserAsset(id: string, name: string): Promise<void> {
      const rec = await db.get('user-assets', id);
      if (!rec) return;
      rec.meta = { ...rec.meta, name };
      await db.put('user-assets', rec);
    },

    /**
     * Internal: called by catalog/sync.js at boot to populate asset metadata.
     * Not part of the public HostV1 bridge contract.
     */
    async _syncFromIndex(assets: AssetMetaRecord[]): Promise<void> {
      const tx = db.transaction('asset-meta', 'readwrite');
      await Promise.all(assets.map(a => tx.store.put(a)));
      await tx.done;
      ICON_THEMES_CACHE = null;       // the icon-themes palette may have changed
      PHOTO_TREATMENTS_CACHE = null;  // …as may the photo-treatments palette
    },

    /**
     * Internal: cache a pre-fetched asset blob, keyed by id:format:version.
     * Called by prefetchAsset in catalog/sync.js.
     */
    async _cacheBlob(key: string, blob: Blob): Promise<void> {
      await db.put('asset-blob', blob, key);
    },

    async _hasBlob(key: string): Promise<boolean> {
      return (await db.get('asset-blob', key)) !== undefined;
    },

    /**
     * Internal: the raw cached Blob for an asset, without minting an object URL.
     * Used by callers that just want the bytes (e.g. tokens.loadDoc reading a
     * JSON document) so they don't pin an unused URL in OBJECT_URL_CACHE.
     * Resolves on-demand tiers the same way get() does. Returns null if absent.
     */
    async _getBlob(id: string, opts: { format?: string; version?: string } = {}): Promise<Blob | null> {
      const meta = await db.get('asset-meta', id);
      if (!meta) return null;
      const format = pickFormat(meta, opts.format);
      const version = opts.version ?? meta.version;
      const blobKey = `${id}:${format.format}:${version}`;
      let blob = await db.get('asset-blob', blobKey);
      if (!blob && meta.tier === 'on-demand') {
        blob = await fetchAndCache(meta, format, blobKey, db);
      }
      return blob ?? null;
    },

    /**
     * Internal: the first synced catalog asset of a given type, or null. Lets a
     * sibling bridge discover a well-known singleton document (e.g. the brand
     * `tokens` asset) from the stored metadata — offline-safe once boot sync has
     * run — instead of hardcoding a brand-specific id. Same rule as the MCP
     * server's tokens resource (`idx.assets.find(a => a.type === …)`); getAll
     * returns id order rather than index order, which only differs if a catalog
     * ships more than one asset of a singleton type.
     */
    async _findMetaByType(type: AssetRef['type']): Promise<AssetMetaRecord | null> {
      const all = await db.getAll('asset-meta');
      return all.find(m => m.type === type) ?? null;
    },

    async _blobCacheSize(): Promise<number> {
      const blobs = await db.getAll('asset-blob');
      return blobs.reduce((sum, b) => sum + (b?.size ?? 0), 0);
    },

    /**
     * Internal: called by syncAssets after writing new metadata.
     *
     * Keeps a blob only if it passes both tests:
     *   1. Its version is current (matches the catalog index).
     *   2. It is either core-tier (always prefetched) OR referenced by a saved session.
     *
     * This prevents on-demand blobs from accumulating when a user browses the
     * asset picker without saving a session.
     *
     * Also prunes metadata for assets no longer in the catalog.
     * Returns { blobs, meta } counts of records deleted.
     */
    async _pruneStale(currentAssets: AssetMetaRecord[], sessionBlobKeys: Set<string> = new Set()): Promise<{ blobs: number; meta: number }> {
      // All keys that exist at the current catalog version.
      const currentVersionKeys = new Set(
        currentAssets.flatMap(a => a.formats.map(f => `${a.id}:${f.format}:${a.version}`)),
      );

      // Core-tier blobs are kept unconditionally (needed for offline).
      const keepBlobKeys = new Set(
        currentAssets
          .filter(a => a.tier === 'core')
          .flatMap(a => a.formats.map(f => `${a.id}:${f.format}:${a.version}`)),
      );

      // Non-core blobs are kept only if a saved session references them (and they're current).
      for (const key of sessionBlobKeys) {
        if (currentVersionKeys.has(key)) keepBlobKeys.add(key);
      }

      const validIds = new Set(currentAssets.map(a => a.id));

      const [allBlobKeys, allMetaKeys] = await Promise.all([
        db.getAllKeys('asset-blob'),
        db.getAllKeys('asset-meta'),
      ]);

      const staleBlobs = allBlobKeys.filter(k => !keepBlobKeys.has(k));
      const staleMeta  = allMetaKeys.filter(k => !validIds.has(k));

      if (staleBlobs.length) {
        const tx = db.transaction('asset-blob', 'readwrite');
        await Promise.all(staleBlobs.map(k => tx.store.delete(k)));
        await tx.done;
        // Revoke any live object URLs minted for these now-deleted blobs.
        // toAssetRef keys library URLs as `library:<blobKey>` and themed icon
        // bakes as `library:<blobKey>:t:<theme>:<colours>` — evict both forms,
        // else the OBJECT_URL_CACHE leaks one entry per pruned blob per sync.
        for (const k of staleBlobs) {
          evictObjectUrl(`library:${k}`);
          evictObjectUrlsByPrefix(`library:${k}:t:`);   // themed icon bakes
          evictObjectUrlsByPrefix(`library:${k}:pt:`);  // photo treatment bakes
        }
      }
      if (staleMeta.length) {
        const tx = db.transaction('asset-meta', 'readwrite');
        await Promise.all(staleMeta.map(k => tx.store.delete(k)));
        await tx.done;
      }

      return { blobs: staleBlobs.length, meta: staleMeta.length };
    },

    async isAvailable(id: string): Promise<boolean> {
      if (id.startsWith('user/')) {
        return Boolean(await db.get('user-assets', id));
      }
      const baseId = stripAssetModifiers(id);
      const meta = await db.get('asset-meta', baseId);
      if (!meta) return false;
      if (meta.tier === 'on-demand') return navigator.onLine;
      // For core/catalog, check if at least one format is cached.
      const cached = await Promise.all(
        meta.formats.map(f => db.get('asset-blob', `${baseId}:${f.format}:${meta.version}`)),
      );
      return cached.some(Boolean);
    },

    // The Content Credentials captured for a user upload at ingest, if any — the
    // raw C2PA manifest store + its original container format. The runtime uses
    // this to preserve a placed credentialed asset's provenance as an export
    // ingredient. Only user uploads can carry one; everything else is null.
    async credential(id: string): Promise<{ store: Uint8Array; format: string } | null> {
      if (!id.startsWith('user/')) return null;
      const rec = await db.get('user-assets', id);
      if (!rec?.credential || !rec.credentialFormat) return null;
      return { store: rec.credential, format: rec.credentialFormat };
    },
  };
  return api;
}

/** Revoke + drop a single object-URL cache entry, if present. */
function evictObjectUrl(cacheKey: string): void {
  const url = OBJECT_URL_CACHE.get(cacheKey);
  if (url) {
    URL.revokeObjectURL(url);
    OBJECT_URL_CACHE.delete(cacheKey);
  }
}

/** Revoke + drop every object-URL cache entry whose key starts with `prefix`. */
function evictObjectUrlsByPrefix(prefix: string): void {
  for (const [key, url] of OBJECT_URL_CACHE) {
    if (key.startsWith(prefix)) {
      URL.revokeObjectURL(url);
      OBJECT_URL_CACHE.delete(key);
    }
  }
}

interface UserAssetError extends Error {
  code: string;
}

function userAssetError(message: string, code: string): UserAssetError {
  const err = new Error(message) as UserAssetError;
  err.code = code;
  return err;
}

/**
 * Best-effort quota guard. Throws STORAGE_FULL if writing `incomingBytes` would
 * push usage past the safety fraction of the quota. If the platform can't
 * estimate (older browsers, private mode), we allow the write — the IDB layer
 * remains the hard backstop.
 */
async function assertQuotaRoom(incomingBytes: number): Promise<void> {
  let est: StorageEstimate | undefined;
  try {
    est = await navigator.storage?.estimate?.();
  } catch {
    return; // estimate() failing must not block uploads.
  }
  if (!est || !est.quota) return;
  const projected = (est.usage ?? 0) + incomingBytes;
  if (projected > est.quota * QUOTA_SAFETY_FRACTION) {
    throw userAssetError(
      'Not enough local storage space for this image. Remove some saved images or sessions and try again.',
      'STORAGE_FULL',
    );
  }
}

function pickFormat(meta: AssetMetaRecord, requested?: string): AssetFormat {
  if (requested) {
    const exact = meta.formats.find(f => f.format === requested);
    if (exact) return exact;
  }
  // Sensible default per type.
  if (meta.type === 'vector') return meta.formats.find(f => f.format === 'svg') ?? meta.formats[0]!;
  // A lottie entry carries the animation (json) plus a static poster variant;
  // tools always want the animation regardless of listing order.
  if (meta.type === 'lottie') return meta.formats.find(f => f.format === 'json') ?? meta.formats[0]!;
  // A video entry may ship a still poster alongside the clip; always resolve to the
  // clip (a <video> needs the real container), regardless of listing order.
  if (meta.type === 'video') return meta.formats.find(f => /^(mp4|webm|mov)$/i.test(f.format)) ?? meta.formats[0]!;
  return meta.formats[0]!;
}

function toAssetRef(record: AssetRefSource, source: 'user' | 'library'): AssetRef {
  // record.cacheKey overrides the default key — themed icon refs key on the
  // base blob + pairing colours (see get()) so identical bakes share one URL.
  const cacheKey = record.cacheKey ?? `${source}:${record.id}:${record.format}:${record.version ?? 'x'}`;
  let url = OBJECT_URL_CACHE.get(cacheKey);
  if (!url && record.blob) {
    url = URL.createObjectURL(record.blob);
    OBJECT_URL_CACHE.set(cacheKey, url);
  }
  return {
    source,
    id: record.id,
    type: record.type,
    format: record.format,
    url: url ?? '',
    version: record.version,
    checksum: record.checksum,
    width: record.width,
    height: record.height,
    meta: record.meta,
  };
}

// An `image` slot accepts any still image — raster OR vector (SVG). It's the
// superset an image input wants (not `any`, which would also surface video/lottie).
function typeMatches(assetType: string, want: string | undefined): boolean {
  if (!want) return true;
  if (want === 'image') return assetType === 'raster' || assetType === 'vector';
  return assetType === want;
}

function matchesFilter(meta: AssetMetaRecord, filter: AssetQuery): boolean {
  if (filter.type && !typeMatches(meta.type, filter.type)) return false;
  if (filter.namespace && !meta.id.startsWith(filter.namespace + '/') && meta.id !== filter.namespace) return false;
  if (filter.tags?.length) {
    const tags = new Set(meta.tags ?? []);
    if (!filter.tags.every(t => tags.has(t))) return false;
  }
  if (!filter.includeDeprecated && meta.deprecated) return false;
  return true;
}

async function fetchAndCache(meta: AssetMetaRecord, format: AssetFormat, blobKey: string, db: AssetsDb): Promise<Blob> {
  const resp = await fetch(format.url);
  if (!resp.ok) throw new Error(`Failed to fetch asset: ${resp.status}`);
  const blob = await resp.blob();
  await verifyAssetChecksum(blob, format);
  await db.put('asset-blob', blob, blobKey);
  return blob;
}

/**
 * A blob's bytes as a `data:<mime>;base64,…` URI. Used to inline a photo into a
 * treatment's SVG wrapper — an SVG used as an image may not fetch external
 * resources, so the raster has to travel inside it.
 */
async function blobToDataUri(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
}

/**
 * SRI SHA-256 (`sha256-<base64>`) for a blob's bytes, byte-for-byte matching the
 * build-time format from scripts/checksum-assets.ts — there it's
 * createHash('sha256').digest('base64'); Node's base64 alphabet + `=` padding is
 * identical to btoa over the raw digest, so the strings compare equal.
 */
async function sriForBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `sha256-${btoa(bin)}`;
}

/**
 * Verify freshly-fetched bytes against the catalog checksum, throwing on a real
 * mismatch (tampered/corrupt download). No-ops when the format carries no
 * checksum or the runtime lacks crypto.subtle (non-secure context) — integrity
 * is a guard, not a hard gate that should brick loading on edge runtimes. The
 * deployed catalog's checksums are kept current by validate-catalog.js (CI), so
 * this never false-positives on a correctly-published asset.
 */
export async function verifyAssetChecksum(blob: Blob, format: AssetFormat | undefined): Promise<void> {
  if (!format?.checksum || !globalThis.crypto?.subtle) return;
  const actual = await sriForBlob(blob);
  if (actual !== format.checksum) {
    throw new Error(
      `Asset checksum mismatch for ${format.url}: expected ${format.checksum}, got ${actual}`,
    );
  }
}
