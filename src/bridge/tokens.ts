// SPDX-License-Identifier: MPL-2.0
/**
 * TokensAPI — design tokens for the host UI and token-aware tools.
 *
 * The canonical brand tokens live in the catalog as a `tokens`-type asset (a
 * DTCG document). Discovery is brand-agnostic: the bridge takes the FIRST
 * catalog asset with `type: 'tokens'` — the same rule the MCP server's tokens
 * resource applies — rather than pinning a brand-specific id, so a different
 * brand profile's catalog supplies its own tokens with no shell change. The
 * document is handed to engine/src/tokens.js for resolution — so the colour
 * picker can source its swatches from tokens, brand-bound input values can
 * resolve their references, and a token-aware tool can read the whole tree.
 *
 * Loading is offline-safe and degrades gracefully. Discovery prefers the
 * synced asset metadata in IndexedDB (the service worker deliberately BYPASSES
 * /catalog/, so network fetches there fail offline), falling back to a fetch
 * of the catalog index for a cold first load; the document itself prefers the
 * core-prefetched blob in IndexedDB (cached at boot by catalog/sync.js) over a
 * direct fetch of the asset's file. If nothing resolves, an empty set is
 * returned — the picker quietly falls back to its built-in palette — and
 * nothing is memoised, so every subsequent call retries. A brand-ingest flow
 * that installs new tokens must call bust() so the next read re-discovers.
 *
 * This is an *additive* v1 capability (HostV1.tokens?), like net/text — a shell
 * that doesn't provide it just doesn't offer token-driven swatches.
 */

import { createTokenSet } from '../../../../engine/src/tokens.ts';
import type { TokensAPI, TokenSet } from '../../../../engine/src/bridge/host-v1.ts';

/** The catalog-asset slice discovery needs: an id to read the cached blob by,
 *  and the file URL to fall back to. Structurally satisfied both by the asset
 *  bridge's stored metadata records and by raw index.json entries. */
interface TokensAssetMeta {
  id: string;
  formats: Array<{ url: string }>;
}

/** The slice of the host this bridge reads: the asset store's synced metadata
 *  lookup and raw blob access. */
interface TokensHost {
  assets: {
    _getBlob(id: string): Promise<Blob | null>;
    _findMetaByType(type: string): Promise<TokensAssetMeta | null>;
  };
}

/** The web shell's tokens surface: HostV1's TokensAPI plus the cache-buster. */
export interface WebTokensAPI extends TokensAPI {
  /** Drop caches (e.g. after the user imports their own tokens). */
  bust(): void;
}

const ASSET_INDEX_URL = '/catalog/assets/index.json';

export function createTokensAPI(host: TokensHost): WebTokensAPI {
  const setByTheme = new Map<string, TokenSet>(); // theme key ('' = default) → token set, cached once non-empty
  let docPromise: Promise<unknown> | null = null;

  /** The first catalog asset with `type: 'tokens'`, or null if there is none
   *  reachable. Synced metadata first — present and offline-safe once boot
   *  sync ran — then the network index (cold first load, before sync). */
  async function findTokensAsset(): Promise<TokensAssetMeta | null> {
    try {
      const meta = await host.assets._findMetaByType('tokens');
      if (meta) return meta;
    } catch { /* IDB unavailable / not synced yet — fall through to the index */ }
    try {
      const resp = await fetch(ASSET_INDEX_URL);
      if (resp.ok) {
        const idx = await resp.json() as { assets?: Array<TokensAssetMeta & { type?: string }> };
        return idx.assets?.find(a => a.type === 'tokens') ?? null;
      }
    } catch { /* offline with nothing synced */ }
    return null;
  }

  async function loadDoc(): Promise<unknown> {
    const asset = await findTokensAsset();
    if (!asset) return null; // no tokens asset anywhere → empty set, retried next call
    // 1) The core-prefetched blob — present and offline-safe once boot sync ran.
    //    Read the bytes directly; minting/fetching an object URL just to re-parse
    //    in-memory JSON would pin an unused URL in the asset bridge's cache.
    try {
      const blob = await host.assets._getBlob(asset.id);
      if (blob) return JSON.parse(await blob.text());
    } catch { /* not cached yet — fall through to a direct fetch */ }
    // 2) Direct fetch of the asset's file — first load, before the blob is cached.
    try {
      const url = asset.formats[0]?.url;
      if (url) {
        const resp = await fetch(url, { cache: 'no-store' });
        if (resp.ok) return await resp.json();
      }
    } catch { /* offline and not yet prefetched */ }
    return null;
  }

  async function doc(): Promise<unknown> {
    // Memoise a successful load; clear on failure so the next call retries
    // (e.g. after boot sync finishes caching the blob).
    if (!docPromise) docPromise = loadDoc().then(d => { if (!d) docPromise = null; return d; });
    return docPromise;
  }

  async function ensure(theme?: string): Promise<TokenSet> {
    const key = theme ?? '';
    if (setByTheme.has(key)) return setByTheme.get(key)!;
    const set = createTokenSet(await doc(), { theme });
    if (set.size > 0) setByTheme.set(key, set); // don't cache an empty (failed) load
    return set;
  }

  return {
    /** The resolved token set for the active (or named) theme. */
    get: (opts = {}) => ensure(opts.theme),
    /** Colour tokens as picker-ready swatches ({ ref, value, name, group, cmyk }). */
    colors: async (opts = {}) => (await ensure(opts.theme)).colors(),
    /** Resolve a `{path}` alias (or bare path) to its value. */
    resolve: async (ref, opts = {}) => (await ensure(opts.theme)).resolve(ref),
    /** Theme names declared in the document. */
    themes: async () => (await ensure()).themes(),
    /** Drop caches (e.g. after the user imports their own tokens). */
    bust() { setByTheme.clear(); docPromise = null; },
  };
}
