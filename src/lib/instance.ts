// SPDX-License-Identifier: MPL-2.0
/**
 * Instance base - point this installed shell at a REMOTE Lolly deployment for
 * its catalog + tools (first-run instance choice). '' (the default) means the
 * bundled same-origin content, and every helper here is a byte-identical
 * passthrough in that state.
 *
 * The base persists in IndexedDB (its own key in the 'profile' KV store, like
 * lib/offline-pins.ts - never localStorage) and is loaded by initInstanceBase()
 * BEFORE the first catalog sync (catalog/sync.ts awaits it at the top of
 * syncCatalog, so no main.ts wiring is needed).
 *
 * Fetch routing: under Tauri (window.__TAURI_INTERNALS__) a cross-origin
 * instance fetch goes through the tauri-plugin-http Rust client - the WebView's
 * own fetch would be CORS-bound, and both Tauri shells register
 * tauri_plugin_http::init() with an `https://*:*` allow scope in their
 * capabilities/default.json. Everywhere else (browser PWA, or same-origin URLs
 * under Tauri) it is plain window.fetch - which means a browser pointed at a
 * cross-origin instance needs that deployment to serve CORS headers.
 *
 * `https://*:*` is deliberately ANY https host/port, not scoped to LAN/private
 * ranges: a "Lolly instance" is any Lolly deployment the user names, which is
 * just as often a hosted/cloud one as a device on the same network - narrowing
 * the capability scope would break the ordinary case. The connect flow's own
 * copy (components/instance-sheet.ts) carries the trust warning instead
 * ("connect only to instances you trust"), since normalizeInstanceBase below
 * only validates well-formedness (https, no embedded credentials) - it isn't,
 * and isn't meant to be, an allowlist of trusted hosts.
 *
 * The plugin-http guest binding is re-implemented minimally below via
 * __TAURI_INTERNALS__.invoke rather than imported: this file is bundled by the
 * web shell's Vite (where @tauri-apps/* is not a dependency) AND by the Tauri
 * shells' Vite (which roots at ../web), so a static import would break the web
 * build - and invoke is the only primitive the binding actually uses.
 *
 * OFFLINE / CACHING interplay with a remote base set (verified against
 * public/sw.js, lib/offline-pins.ts and catalog/integrity.ts):
 *   - sw.js returns early for every cross-origin request (`url.origin !==
 *     self.location.origin`), so the /tools/ network-first cache, the
 *     /catalog/previews/ stale-while-revalidate cache and the PIN_CACHE
 *     fallback never see instance traffic (Tauri plugin-http requests bypass
 *     the SW entirely, by construction). Remote-instance mode therefore
 *     degrades offline to the SW default for cross-origin: the app shell and
 *     same-origin chrome still load, the tool INDEX falls back to its
 *     localStorage copy and already-cached asset BLOBS still resolve from
 *     IndexedDB, but un-cached tool files / previews / on-demand assets fail
 *     until the network returns.
 *   - Offline pins fetch AND key their PIN_CACHE entries through instancePath,
 *     so a pin made in remote mode caches the remote bytes under the remote URL
 *     (never poisoning the same-origin fallback keys) - but since the SW only
 *     serves PIN_CACHE for same-origin requests, pinned tools are not
 *     offline-servable while a remote base is active.
 *   - Catalog signing (catalog/integrity.ts) fetches its envelope through the
 *     base too: a key-pinned build requires the remote instance to be signed by
 *     the SAME pinned key, or sync fails closed. Asset checksum verification
 *     (verifyAssetChecksum) keeps running on remote bytes unchanged - the
 *     remote index's checksums travel with its format entries.
 */

// Deep engine imports, NOT the `@lolly/engine` barrel: this module is on the
// boot path, and engine/src/index.ts is one shared facade whose retained export
// set is the UNION over every importer - touching it here drags createRuntime
// (Handlebars) + loadTool/validate (Ajv) + c2pa onto first paint. See
// scripts/check-bundle-budget.ts.
import { ENGINE_VERSION } from '../../../../engine/src/version.ts';
import { openDB } from '../bridge/db.ts';
import { initPackStore, packActive, packAssetEntries, packFetch } from './pack-store.ts';

/** Key of the persisted base inside the 'profile' KV store. */
const INSTANCE_KEY = 'instance-base';

let base = '';
let initPromise: Promise<void> | null = null;

/** The active instance base URL ('' = bundled same-origin content). */
export function getInstanceBase(): string {
  return base;
}

/**
 * Validate + normalize a user-entered instance URL: https only, no embedded
 * credentials, query/hash dropped (a base is a prefix, not a page), trailing
 * slashes stripped. Throws with a plain message on anything unusable.
 */
export function normalizeInstanceBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (u.protocol !== 'https:') throw new Error('Instance URL must be https');
  if (u.username || u.password) throw new Error('Instance URL must not contain credentials');
  // origin keeps any explicit port; pathname keeps a sub-path deployment.
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/**
 * Persist (or with null/'' clear) the instance base. Takes effect for code that
 * reads instancePath()/instanceFetch() from now on; callers should resync or
 * reload so already-fetched catalog data is replaced.
 */
export async function setInstanceBase(url: string | null): Promise<void> {
  const next = url ? normalizeInstanceBase(url) : '';
  const db = await openDB();
  if (next) await db.put('profile', next, INSTANCE_KEY);
  else await db.delete('profile', INSTANCE_KEY);
  base = next;
  // Drop catalog/sync.ts's conditional-request validators (perf-hint ETags it
  // already keeps in localStorage - not tool state): they validate the PREVIOUS
  // base's copies, and a stale 304 against the new base would skip the first
  // full sync of the instance's index. Also drop the actual cached tool-index
  // CONTENT ('sbt-tool-index', a separate key) - main.ts primes window.__toolIndex
  // from it for the pre-sync fast paint, and catalog/sync.ts falls back to it when
  // every fetch attempt fails, so leaving the PREVIOUS base's bytes in it would
  // resurface a foreign catalog on the next cold/offline boot.
  try {
    localStorage.removeItem('sbt-catalog:tool-index');
    localStorage.removeItem('sbt-catalog:assets-index');
    localStorage.removeItem('sbt-tool-index');
  } catch { /* storage unavailable — sync will just revalidate */ }
}

/** Load the persisted base. Memoised; never throws (unreadable → bundled).
 *  Also initialises the instance-pack store (plans/131): catalog/sync.ts awaits
 *  this before its first fetch, so the pack overlay below is ready without any
 *  main.ts wiring - the same trick the base itself uses. */
export function initInstanceBase(): Promise<void> {
  initPromise ??= (async () => {
    try {
      const stored = await (await openDB()).get('profile', INSTANCE_KEY);
      if (typeof stored === 'string' && stored) base = normalizeInstanceBase(stored);
    } catch {
      base = ''; // unreadable/invalid - fall back to bundled content
    }
    await initPackStore();
  })();
  return initPromise;
}

/** TEST-ONLY: set the in-memory base without persistence (unit tests have no
 *  IndexedDB). Same pattern as the engine's exported-mutable HOOK_BUDGET_MS. */
export function _setBaseForTests(value: string): void {
  base = value;
}

/**
 * Prefix a root-relative catalog/tools path with the instance base. Passthrough
 * when no base is set, and for already-absolute URLs (e.g. asset format URLs a
 * remote sync has absolutized once already).
 */
export function instancePath(p: string): string {
  if (!base) return p;
  if (/^https?:/i.test(p)) return p;
  return p.startsWith('/') ? base + p : `${base}/${p}`;
}

/**
 * fetch() for instance-base traffic: tauri-plugin-http for cross-origin URLs
 * under Tauri (CORS-free, scope-checked in Rust), window.fetch otherwise.
 *
 * A loaded instance pack (lib/pack-store.ts) overlays this - CATALOG paths
 * only: pack asset/font files answer by canonical path BEFORE any transport,
 * and the ASSET index comes back MERGED (pack entries over the underlying
 * source's, pack winning on id - profiles.json's later-roots-win, at
 * runtime). With the underlying source unreachable the pack's own entries
 * still answer. Pack TOOLS are deliberately not served here: they ride the
 * installed-tools sideload path (INSTALLED_CACHE + the sw.js fallback + the
 * boot-time index merge), which keeps the remote TOOL index pristine for the
 * pinned-key signed-envelope check in catalog/integrity.ts.
 */
export function instanceFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (packActive()) {
    const path = pathOf(url);
    if (path === '/catalog/assets/index.json') return packMergedAssetIndex(url, init);
    if (path.startsWith('/catalog/')) {
      return packFetch(path).then(r => r ?? transportFetch(url, init));
    }
  }
  return transportFetch(url, init);
}

function transportFetch(url: string, init?: RequestInit): Promise<Response> {
  if (hasTauriInternals() && isCrossOrigin(url)) return tauriHttpFetch(url, withClientHeader(init));
  return fetch(url, isCrossOrigin(url) ? init : withClientHeader(init));
}

/** The root-relative path of an instance URL (absolute or already relative).
 *  A sub-path deployment's base prefixes every instancePath URL - strip it so
 *  pack keys stay canonical root-relative paths. */
function pathOf(url: string): string {
  if (!/^https?:/i.test(url)) return url.split(/[?#]/, 1)[0] ?? url;
  let path: string;
  try { path = new URL(url).pathname; } catch { return url; }
  if (base) {
    try {
      const basePath = new URL(base).pathname.replace(/\/+$/, '');
      if (basePath && path.startsWith(`${basePath}/`)) path = path.slice(basePath.length);
    } catch { /* malformed base - leave the path as-is */ }
  }
  return path;
}

/**
 * The asset index, merged: the underlying source's entries (bundled seed or
 * remote instance) with the pack's laid over them. An unreachable underlying
 * index degrades to pack-only entries rather than failing the sync. (The
 * asset index carries no signed envelope - only the TOOL index does, and
 * that one passes through unmerged.)
 */
async function packMergedAssetIndex(url: string, init: RequestInit | undefined): Promise<Response> {
  let baseIndex: Record<string, unknown> | null = null;
  try {
    const resp = await transportFetch(url, init);
    if (resp.ok) baseIndex = await resp.json() as Record<string, unknown>;
  } catch { /* offline / no instance yet - the pack still answers */ }
  const packEntries = await packAssetEntries();
  if (!baseIndex) baseIndex = { version: '1', assets: [] };
  const packIds = new Set(packEntries.map(e => e.id));
  const underlying = Array.isArray(baseIndex.assets) ? baseIndex.assets as Array<{ id: string }> : [];
  baseIndex.assets = [...underlying.filter(e => !packIds.has(e.id)), ...packEntries];
  return new Response(JSON.stringify(baseIndex), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Tag instance traffic with the shell kind + engine version - the same
 * information a User-Agent would carry if browsers let pages set one, so a
 * deployment's operator can tell which Lolly versions are in the field.
 * Same-origin and Tauri-native requests only: a custom header on a browser
 * CROSS-origin fetch forces a CORS preflight, which a plain static host
 * serving a remote instance would fail - those requests stay untagged.
 */
function withClientHeader(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has('x-lolly-client')) {
    headers.set('x-lolly-client', `${hasTauriInternals() ? 'tauri' : 'web'} engine/${ENGINE_VERSION}`);
  }
  return { ...init, headers };
}

// ── Tauri plugin-http guest binding (minimal) ────────────────────────────────

interface TauriInternals {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__?.invoke === 'function';
}

function isCrossOrigin(url: string): boolean {
  if (!/^https?:/i.test(url)) return false;
  try {
    return new URL(url).origin !== location.origin;
  } catch {
    return false;
  }
}

/** What plugin:http|fetch_send resolves with (see @tauri-apps/plugin-http dist-js). */
interface TauriFetchSendResponse {
  status: number;
  statusText: string;
  url: string;
  headers: Array<[string, string]>;
  rid: number;
}

/**
 * Mirror of @tauri-apps/plugin-http's fetch(), reduced to what instance traffic
 * needs (whole-body responses, no streaming/abort). Protocol per the plugin's
 * guest binding: fetch → fetch_send → fetch_read_body chunks, each chunk's LAST
 * byte a close flag (1 = done, payload discarded; 0 = data, payload = rest).
 */
async function tauriHttpFetch(url: string, init?: RequestInit): Promise<Response> {
  const { invoke } = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
  const req = new Request(url, init);
  const bodyBuf = await req.arrayBuffer();
  const rid = await invoke<number>('plugin:http|fetch', {
    clientConfig: {
      method: req.method,
      url: req.url,
      headers: Array.from(req.headers.entries()),
      data: bodyBuf.byteLength ? Array.from(new Uint8Array(bodyBuf)) : null,
    },
  });
  const resp = await invoke<TauriFetchSendResponse>('plugin:http|fetch_send', { rid });
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const data = await invoke<number[] | ArrayBuffer>('plugin:http|fetch_read_body', { rid: resp.rid });
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
    if (!bytes.length || bytes[bytes.length - 1] === 1) break;
    if (bytes.length > 1) {
      const chunk = bytes.slice(0, -1);
      chunks.push(chunk);
      total += chunk.length;
    }
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.length;
  }
  // Null-body statuses (fetch spec) - Response() throws if handed bytes for them.
  const nullBody = [101, 103, 204, 205, 304].includes(resp.status);
  const out = new Response(nullBody ? null : body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: new Headers(resp.headers),
  });
  Object.defineProperty(out, 'url', { value: resp.url, writable: false });
  return out;
}
