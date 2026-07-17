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
 * that installs new tokens must call bust() so the next read re-discovers —
 * installUserTokens (below) is the canonical write path: it stores the user's
 * own DTCG doc as the `user/tokens/brand` asset, which discovery returns ahead
 * of any catalog tokens (assets._findMetaByType checks the user store first).
 *
 * This is an *additive* v1 capability (HostV1.tokens?), like net/text — a shell
 * that doesn't provide it just doesn't offer token-driven swatches.
 */

import { createTokenSet, aliasPath } from '../../../../engine/src/tokens.ts';
import { instanceFetch, instancePath } from '../lib/instance.ts';
import type { TokensAPI, TokenSet } from '../../../../engine/src/bridge/host-v1.ts';
// The exclusion read lives in its own leaf module (not lib/brand-doc.ts, whose
// engine-barrel import would drag studio code into this bridge's boot graph).
import { getExcludedSwatches } from '../lib/brand-exclusions.ts';

/** The catalog-asset slice discovery needs: an id to read the cached blob by,
 *  the file URL to fall back to, and the `brandLock` flag (tokens assets only).
 *  Structurally satisfied both by the asset bridge's stored metadata records and
 *  by raw index.json entries. */
interface TokensAssetMeta {
  id: string;
  formats: Array<{ url: string }>;
  brandLock?: boolean;
}

/** The slice of the host this bridge reads: the asset store's synced metadata
 *  lookup and raw blob access. `catalogOnly` skips the user store — needed to
 *  read the SHIPPED brand's lock flag, which a user asset must not shadow. */
interface TokensHost {
  assets: {
    _getBlob(id: string): Promise<Blob | null>;
    _findMetaByType(type: string, opts?: { catalogOnly?: boolean }): Promise<TokensAssetMeta | null>;
  };
}

/** The web shell's tokens surface: HostV1's TokensAPI plus the cache-buster and
 *  the brand-lock query. */
export interface WebTokensAPI extends TokensAPI {
  /** Drop caches (e.g. after the user imports their own tokens). */
  bust(): void;
  /**
   * The raw effective DTCG document — the user install if present, else the
   * shipped catalog brand (a locked build always yields the catalog doc). This
   * is the SAME document get()/resolve() read, handed back unresolved so the
   * brand editor can mutate a colour leaf's `$value` and re-install it. Null
   * when no tokens are reachable yet. Memoised alongside the token sets, so a
   * bust() (after installUserTokens) makes the next call re-load the new doc.
   */
  raw(): Promise<unknown>;
  /**
   * True when the SHIPPED catalog brand declares itself authoritative
   * (`brandLock` on its tokens asset): the app resolves ITS colours/fonts and
   * ignores any user-installed brand, and the brand-customisation UI is
   * disabled. False for a customisable brand (e.g. lolly-start). Cached.
   */
  isLocked(): Promise<boolean>;
}

const ASSET_INDEX_URL = '/catalog/assets/index.json';

/** The user-installed brand tokens' well-known asset id. Its presence flips
 *  discovery away from the catalog's tokens (e.g. `lolly/tokens/brand`) — the
 *  shell's branded/unbranded signal (plans/brand-token-contract.md §5). */
export const USER_TOKENS_ID = 'user/tokens/brand';

/** The host slice installUserTokens needs: the asset store's user-upload writer
 *  plus (when wired) this module's own live tokens instance, to bust its caches
 *  and honour the brand lock. The record parameter mirrors bridge/assets.ts's
 *  UserAssetRecord for the fields we set — the same contract the picker's
 *  uploads write. */
interface InstallTokensHost {
  assets: {
    _uploadUserAsset(record: {
      id: string;
      type: 'tokens';
      format: string;
      blob: Blob;
      version?: string;
      meta?: Record<string, unknown>;
    }): Promise<void>;
  };
  tokens?: TokensAPI & { bust?(): void; isLocked?(): Promise<boolean> };
}

/** Thrown when a brand override is attempted on a locked (authoritative) brand.
 *  UI should gate on host.tokens.isLocked() so this stays a defence-in-depth
 *  backstop rather than a path users reach. */
export class BrandLockedError extends Error {
  constructor() {
    super('This build’s brand is fixed and can’t be changed.');
    this.name = 'BrandLockedError';
  }
}

/**
 * Install the user's own brand tokens (plans/brand-token-contract.md §5):
 * validate + write the DTCG document as the well-known `user/tokens/brand`
 * asset, then bust the tokens caches so the very next get()/resolve() re-runs
 * discovery — which now returns the user asset ahead of the shipped brand.
 *
 * Refuses when the shipped brand is LOCKED (brandLock): a locked catalog eats
 * what it is given, so user brand tokens are never installed. This is the single
 * write chokepoint every override path funnels through (the #/start wizard,
 * brand-file import, and every set/add/remove-font action), so one guard here
 * covers them all.
 */
export async function installUserTokens(
  host: InstallTokensHost, doc: unknown, opts: { label?: string } = {},
): Promise<void> {
  if (await host.tokens?.isLocked?.()) throw new BrandLockedError();
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error('installUserTokens: expected a DTCG token document (a plain object)');
  }
  await host.assets._uploadUserAsset({
    id: USER_TOKENS_ID,
    type: 'tokens',
    format: 'json',
    blob: new Blob([JSON.stringify(doc)], { type: 'application/json' }),
    version: '1.0.0',
    meta: { name: opts.label ?? 'Brand tokens' },
  });
  // The web tokens API memoises the doc + per-theme sets (see createTokensAPI);
  // bust so nothing keeps serving the outgoing brand. Optional-chained: a host
  // without the tokens capability just installs for the next boot.
  host.tokens?.bust?.();
}

export function createTokensAPI(host: TokensHost): WebTokensAPI {
  const setByTheme = new Map<string, TokenSet>(); // theme key ('' = default) → token set, cached once non-empty
  let docPromise: Promise<unknown> | null = null;
  let catalogMetaPromise: Promise<TokensAssetMeta | null> | null = null;

  /** The first catalog asset with `type: 'tokens'`, or null if there is none
   *  reachable. Synced metadata first — present and offline-safe once boot
   *  sync ran — then the network index (cold first load, before sync).
   *  `catalogOnly` reads the SHIPPED brand (skips the user store) — used to read
   *  the un-shadowable `brandLock` flag. */
  async function findTokensAsset(catalogOnly = false): Promise<TokensAssetMeta | null> {
    try {
      const meta = await host.assets._findMetaByType('tokens', { catalogOnly });
      if (meta) return meta;
    } catch { /* IDB unavailable / not synced yet — fall through to the index */ }
    try {
      // The catalog index carries only shipped assets, so it is catalog-only by
      // construction — the right cold-load source for both callers.
      const resp = await instanceFetch(instancePath(ASSET_INDEX_URL));
      if (resp.ok) {
        const idx = await resp.json() as { assets?: Array<TokensAssetMeta & { type?: string }> };
        return idx.assets?.find(a => a.type === 'tokens') ?? null;
      }
    } catch { /* offline with nothing synced */ }
    return null;
  }

  /** The SHIPPED brand's tokens asset (never a user install). Memoised — its
   *  brandLock flag is a build fact that doesn't change within a session. */
  function catalogTokensAsset(): Promise<TokensAssetMeta | null> {
    if (!catalogMetaPromise) {
      catalogMetaPromise = findTokensAsset(true).then(m => { if (!m) catalogMetaPromise = null; return m; });
    }
    return catalogMetaPromise;
  }

  /** Read + parse one tokens asset's DTCG document (cached blob first, then a
   *  direct fetch of its file). Null when neither is reachable yet. */
  async function readAssetDoc(asset: TokensAssetMeta): Promise<unknown> {
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
        // instancePath: cold-load metas come from the raw network index, whose
        // format URLs are root-relative (synced metas are already absolute).
        const resp = await instanceFetch(instancePath(url), { cache: 'no-store' });
        if (resp.ok) return await resp.json();
      }
    } catch { /* offline and not yet prefetched */ }
    return null;
  }

  async function loadDoc(): Promise<unknown> {
    // A LOCKED brand is authoritative: resolve the shipped catalog doc and
    // ignore any user install (which the guard in installUserTokens also
    // prevents from ever being written — but a leftover from an earlier,
    // unlocked profile must still be shadowed here).
    const catalog = await catalogTokensAsset();
    if (catalog?.brandLock) return readAssetDoc(catalog);
    // Unlocked: a USER install wins. _findMetaByType is user-first AND IDB-only
    // (the index fallback lives here in the bridge, not in it), so consult it for
    // a user asset and otherwise reuse the catalog asset already resolved above —
    // this avoids a second index fetch on a cold boot.
    let userMeta: TokensAssetMeta | null = null;
    try { userMeta = await host.assets._findMetaByType('tokens'); } catch { /* IDB unavailable */ }
    if (userMeta && userMeta.id.startsWith('user/')) return readAssetDoc(userMeta);
    return catalog ? readAssetDoc(catalog) : null; // no tokens anywhere → empty set, retried next call
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
    /** Colour tokens as picker-ready swatches ({ ref, value, name, group, cmyk }).
     *  Swatches on the doc's exclusion list (a "deleted" derived ramp step —
     *  the studio hides it, the token keeps resolving) are filtered here so
     *  every picker honours the exclusion without each caller re-reading it. */
    colors: async (opts = {}) => {
      const list = (await ensure(opts.theme)).colors();
      const excluded = new Set(getExcludedSwatches(await doc()));
      if (!excluded.size) return list;
      // Exclusion keys are brand-doc keys, which ALWAYS carry a `color.` root
      // (brand-doc.ts prepends one when a doc's colour leaves live under some
      // other top-level group) — the engine's token paths for such docs don't.
      // Match both forms so an exclusion written against the prefixed key
      // still hides that swatch here.
      return list.filter(c => {
        const p = aliasPath(c.ref) ?? c.ref;
        return !excluded.has(p) && !excluded.has(p.startsWith('color.') ? p : `color.${p}`);
      });
    },
    /** Resolve a `{path}` alias (or bare path) to its value. */
    resolve: async (ref, opts = {}) => (await ensure(opts.theme)).resolve(ref),
    /** The raw effective DTCG document (see WebTokensAPI.raw). */
    raw: () => doc(),
    /** Theme names declared in the document. */
    themes: async () => (await ensure()).themes(),
    /** True when the shipped brand is locked (see WebTokensAPI.isLocked). */
    async isLocked() { return !!(await catalogTokensAsset())?.brandLock; },
    /** Drop caches (e.g. after the user imports their own tokens). The lock is a
     *  build fact, not user state, so its cache survives a bust. */
    bust() { setByTheme.clear(); docPromise = null; },
  };
}
