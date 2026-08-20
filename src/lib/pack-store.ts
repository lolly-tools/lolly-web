// SPDX-License-Identifier: MPL-2.0
/**
 * Instance-pack store (plans/131 WP-D) - the THIRD content source.
 *
 * The shell serves tools + catalog from bundled same-origin content, or from a
 * remote instance base (lib/instance.ts). A loaded `.lolly` instance pack adds
 * this one: pack bytes ingested into IndexedDB ('pack-files', keyed by their
 * canonical root-relative path - '/tools/<id>/tool.json',
 * '/catalog/assets/suse/...') and served by the overlay lib/instance.ts runs
 * inside instanceFetch, BEFORE any transport. Sync, pins, checksum
 * verification and the tool loader all fetch through that seam, so none of
 * them know packs exist - a pack answers like a very fast instance.
 *
 * The two catalog indexes are the exception: the pack MERGES its entries over
 * whatever the underlying source returns (pack wins on id collision, mirroring
 * profiles.json's later-roots-win), so the gallery lists pack tools beside the
 * community set. When the underlying fetch fails entirely (offline, no
 * instance chosen) the pack's own entries still answer - pack mode is the best
 * offline mode there is.
 *
 * Trust: a pack carries tools, and tools carry hooks.js - loading one is
 * installing code. importInstancePackParts verifies the pack signature
 * (pack.sig: ECDSA P-256/SHA-256 over the exact manifest.json bytes, whose
 * integrity map covers every part) against the SAME pinned key catalog
 * signing uses (VITE_CATALOG_PUBLIC_KEY_JWK). Key pinned ⇒ fail closed;
 * no key pinned ⇒ the result records 'unsigned'/'unverified' for the UI to
 * say so. The zip-level SHA-256 integrity map is enforced upstream by
 * brand-transfer's verifyIntegrity either way.
 *
 * Boot cost: initPackStore loads the meta record and the path SET only (no
 * bytes); with no pack loaded it is one IDB get. The signature-verification
 * engine import is dynamic - never on the boot path.
 */

import { openDB } from '../bridge/db.ts';

/** The idb surface this module actually uses - narrow so the unit tests can
 *  hand in a Map-backed fake (node has no IndexedDB; the pattern user-fonts
 *  uses for its host seam). */
interface PackDb {
  get(store: string, key: string): Promise<unknown>;
  put(store: string, value: unknown, key: string): Promise<unknown>;
  delete(store: string, key: string): Promise<unknown>;
  clear(store: string): Promise<unknown>;
  getAllKeys(store: string): Promise<unknown[]>;
  transaction(stores: string[], mode: 'readwrite'): {
    objectStore(name: string): { put(value: unknown, key: string): unknown; clear(): unknown };
    done: Promise<unknown>;
  };
}

let dbOverride: PackDb | null = null;
const getDb = async (): Promise<PackDb> => dbOverride ?? (openDB() as unknown as Promise<PackDb>);

/** TEST-ONLY: swap the IDB connection for a fake. */
export function _setDbForTests(db: PackDb | null): void {
  dbOverride = db;
}

/** Kept in sync with catalog/integrity.ts's PINNED_KEY - one deployment key
 *  vouches for both the catalog index and any loadable pack. Mutable only for
 *  the unit tests (the exported-mutable HOOK_BUDGET_MS pattern) - the fail-
 *  closed path must be testable or it will quietly stop failing closed. */
let pinnedKey: string = import.meta.env?.VITE_CATALOG_PUBLIC_KEY_JWK ?? '';

/** TEST-ONLY: pin/unpin the pack-signature key. */
export function _setPinnedKeyForTests(key: string): void {
  pinnedKey = key;
}

const STORE = 'pack-files';
/** Meta record's key in the 'profile' KV store (same home as the instance base). */
const META_KEY = 'instance-pack-meta';
/** Synthetic paths for the pack's own index parts - '//' so they can never
 *  collide with a real root-relative request path. */
const TOOLS_PART = '//pack/tools.json';
const CATALOG_PART = '//pack/catalog.json';

export interface InstancePackMeta {
  kind: 'instance-pack';
  name: string;
  publisher?: string;
  version?: string;
  /** Where community content comes from while this pack is loaded. */
  instance?: string;
  engineVersion?: string;
  toolCount?: number;
  assetCount?: number;
  loadedAt: string;
  signature: 'verified' | 'unverified' | 'unsigned';
}

export interface PackImportResult {
  tools: number;
  assets: number;
  files: number;
  name: string;
  signature: InstancePackMeta['signature'];
  /** The instance base the pack asks for; the CALLER applies it (keeps this
   *  module import-cycle-free with lib/instance.ts, which imports us). */
  instance: string | null;
}

let meta: InstancePackMeta | null = null;
let paths: Set<string> | null = null;
let initPromise: Promise<void> | null = null;

const MIME: Record<string, string> = {
  json: 'application/json', html: 'text/html; charset=utf-8', js: 'application/javascript',
  css: 'text/css', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  ics: 'text/calendar', vcf: 'text/vcard', csv: 'text/csv',
};

const mimeOf = (path: string): string =>
  MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

/** Load meta + the path set. Memoised, never throws - failure reads as "no pack". */
export function initPackStore(): Promise<void> {
  initPromise ??= (async () => {
    try {
      const db = await getDb();
      const stored = await db.get('profile', META_KEY);
      if (!stored || (stored as InstancePackMeta).kind !== 'instance-pack') return;
      meta = stored as InstancePackMeta;
      paths = new Set((await db.getAllKeys(STORE)) as string[]);
    } catch {
      meta = null;
      paths = null;
    }
  })();
  return initPromise;
}

export function packActive(): boolean {
  return meta !== null && paths !== null && paths.size > 0;
}

export function getPackMeta(): InstancePackMeta | null {
  return meta;
}

/** Serve one pack file as a Response, or null when the pack doesn't carry it. */
export async function packFetch(path: string): Promise<Response | null> {
  if (!packActive() || !paths!.has(path)) return null;
  try {
    const bytes = await (await getDb()).get(STORE, path) as Uint8Array | undefined;
    if (!bytes) return null;
    // Copy into a fresh buffer: stored views can sit on larger shared buffers.
    const body = new Uint8Array(bytes);
    return new Response(body as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': mimeOf(path), 'content-length': String(body.byteLength) },
    });
  } catch {
    return null;
  }
}

/** The pack's tool-index entries (as generated by the brand's build:catalog). */
export async function packToolEntries(): Promise<Array<{ id: string }>> {
  const resp = await packFetch(TOOLS_PART);
  if (!resp) return [];
  try { return ((await resp.json()) as { tools?: Array<{ id: string }> }).tools ?? []; }
  catch { return []; }
}

/** The pack's asset-index entries (checksums intact from the brand catalog). */
export async function packAssetEntries(): Promise<Array<{ id: string }>> {
  const resp = await packFetch(CATALOG_PART);
  if (!resp) return [];
  try { return ((await resp.json()) as { assets?: Array<{ id: string }> }).assets ?? []; }
  catch { return []; }
}

export async function clearInstancePack(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE);
  await db.delete('profile', META_KEY);
  meta = null;
  paths = null;
}

const decoder = new TextDecoder();

/**
 * Ingest the instance-pack parts of an unzipped `.lolly` bundle. Called by
 * brand-transfer's importBrandPack AFTER the brand parts (tokens/fonts/logos)
 * have landed and AFTER the zip integrity map verified. Replaces any
 * previously loaded pack whole - two half-packs is a broken instance.
 */
export async function importInstancePackParts(
  files: Record<string, Uint8Array>,
): Promise<PackImportResult> {
  const packMeta = readPart(files, 'instance.json') as Omit<InstancePackMeta, 'loadedAt' | 'signature'> | null;
  if (!packMeta || packMeta.kind !== 'instance-pack') {
    throw new Error('Not an instance pack (no instance.json part).');
  }

  const signature = await verifyPackSignature(files);

  const toolsPart = readPart(files, 'tools.json') as { tools?: Array<{ id: string }> } | null;
  const catalogPart = readPart(files, 'catalog.json') as { assets?: Array<{ id: string }> } | null;
  const tools = toolsPart?.tools ?? [];
  const assets = catalogPart?.assets ?? [];

  const db = await getDb();
  const tx = db.transaction([STORE], 'readwrite');
  await tx.objectStore(STORE).clear();
  let count = 0;
  for (const [path, bytes] of Object.entries(files)) {
    let key: string | null = null;
    if (path.startsWith('tools/')) key = `/${path}`;
    else if (path.startsWith('catalog/')) key = `/${path}`;
    else if (path === 'tools.json') key = TOOLS_PART;
    else if (path === 'catalog.json') key = CATALOG_PART;
    if (!key) continue;
    tx.objectStore(STORE).put(bytes, key);
    count++;
  }
  await tx.done;

  const stored: InstancePackMeta = {
    ...packMeta,
    kind: 'instance-pack',
    loadedAt: new Date().toISOString(),
    signature,
  };
  await db.put('profile', stored, META_KEY);
  meta = stored;
  paths = new Set((await db.getAllKeys(STORE)) as string[]);

  return {
    tools: tools.length,
    assets: assets.length,
    files: count,
    name: stored.name,
    signature,
    instance: typeof packMeta.instance === 'string' ? packMeta.instance : null,
  };
}

function readPart(files: Record<string, Uint8Array>, name: string): unknown {
  const raw = files[name];
  if (!raw) return null;
  try { return JSON.parse(decoder.decode(raw)); } catch { return null; }
}

/**
 * pack.sig: ECDSA P-256/SHA-256 over the EXACT manifest.json bytes. Key pinned
 * ⇒ a missing or failing signature refuses the pack (fail closed, same posture
 * as catalog/integrity.ts). No key pinned ⇒ record what we saw so the UI can
 * say "unsigned"/"unverified" - the zip integrity map still guarantees the
 * parts match the manifest either way.
 */
async function verifyPackSignature(
  files: Record<string, Uint8Array>,
): Promise<InstancePackMeta['signature']> {
  const sig = readPart(files, 'pack.sig') as { signature?: string } | null;
  const manifestBytes = files['manifest.json'];
  if (!pinnedKey) return sig?.signature ? 'unverified' : 'unsigned';
  if (!sig?.signature || !manifestBytes) {
    throw new Error('This build only loads signed packs, and this pack has no valid signature.');
  }
  const { importSpkiOrJwkPublicKey } = await import('../../../../engine/src/catalog-integrity.ts');
  const key = await importSpkiOrJwkPublicKey(pinnedKey);
  const raw = Uint8Array.from(atob(sig.signature), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    raw as unknown as BufferSource, manifestBytes as unknown as BufferSource,
  );
  if (!ok) throw new Error("This pack's signature doesn't match the key this build trusts.");
  return 'verified';
}

/** TEST-ONLY: reset module memoisation (unit tests re-init per case). */
export function _resetPackStoreForTests(): void {
  meta = null;
  paths = null;
  initPromise = null;
}
