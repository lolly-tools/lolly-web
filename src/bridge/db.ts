// SPDX-License-Identifier: MPL-2.0
/**
 * IndexedDB schema for the web shell.
 *
 * Stores:
 *   - profile       — single record, the user's profile
 *   - state         — saved tool states, keyed by slot id
 *   - asset-meta    — catalog metadata (id, version, tags, format list)
 *   - asset-blob    — cached asset bytes, keyed by id+format+version
 *   - user-assets   — user-uploaded assets (headshots, custom images)
 *
 * Why IndexedDB over localStorage: blobs (images), no 5MB ceiling, structured
 * queries. The capability bridge hides this from tools — they call
 * host.state.save() without knowing what's underneath.
 */

import { openDB as idbOpen, deleteDB as idbDelete } from 'idb';
import type { IDBPDatabase } from 'idb';

const DB_NAME = 'lolly';
const DB_VERSION = 5;

// How long to wait for the DB to open before giving up. A healthy open is
// near-instant; this only trips when the connection is genuinely wedged.
const OPEN_TIMEOUT_MS = 8000;

// The functional stores every healthy DB must have. If the DB reports the
// current version but is missing any of these, it was left half-initialized by
// an interrupted upgrade and must be rebuilt (see openDB) — a rebuild that wipes
// the whole DB, so ONLY stores holding irreplaceable user data belong here. Two
// stores are deliberately excluded: 'catalog-meta' (deprecated/unused) and
// 'generated-previews' (pure regenerable cache — its absence must never escalate
// into wiping the user's profile/sessions/assets; host.previews degrades to
// committed previews if it's missing). 'identity' is excluded too: losing it just
// means enrolling again (see bridge/identity.js) — never worth wiping sessions.
const REQUIRED_STORES = ['profile', 'state', 'asset-meta', 'asset-blob', 'user-assets'];

function openOnce(timeoutMs = OPEN_TIMEOUT_MS): Promise<IDBPDatabase> {
  // Set when the browser tells us our open is queued behind an older connection
  // (a version upgrade blocked by another tab / a bfcache-frozen page). Lets the
  // timeout below mark the error as recoverable so boot() can offer a retry
  // instead of a dead end — the open succeeds the moment that connection closes.
  let wasBlocked = false;
  const opening = idbOpen(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('profile');
        const stateStore = db.createObjectStore('state', { keyPath: 'slot' });
        stateStore.createIndex('toolId', 'toolId');
        stateStore.createIndex('updatedAt', 'updatedAt');
        const assetMetaStore = db.createObjectStore('asset-meta', { keyPath: 'id' });
        assetMetaStore.createIndex('tier', 'tier');
        assetMetaStore.createIndex('type', 'type');
        // key = `${assetId}:${format}:${version}`
        db.createObjectStore('asset-blob');
        db.createObjectStore('user-assets', { keyPath: 'id' });
      }
      if (oldVersion < 2) {
        // DEPRECATED / RESERVED — 'catalog-meta' was added in v2 to hold catalog
        // ETags, but those moved to localStorage and no code reads or writes this
        // store anymore. It is intentionally NOT removed: deleting a store requires
        // a further version bump + migration, and leaving it costs nothing. Kept so
        // browsers that already upgraded to v2 still open at the declared schema.
        db.createObjectStore('catalog-meta');
      }
      if (oldVersion < 3) {
        // Profile-personalized gallery preview thumbnails, keyed by toolId. Pure
        // regenerable cache (re-rendered from the tool + current profile on demand;
        // see shells/web/src/personalize-previews.js), so — like asset-blob — it is
        // intentionally NOT carried in the portable backup (data-transfer.js).
        db.createObjectStore('generated-previews', { keyPath: 'toolId' });
      }
      if (oldVersion < 4) {
        // Content Credentials device identity — 'keypair' + 'cert' records (see bridge/identity.js).
        db.createObjectStore('identity');
      }
      if (oldVersion < 5) {
        // Export history — one record per download (id, toolId, filename, format, thumb,
        // query, at). A convenience log the Dashboard's "Latest exports" reads; capped to
        // a couple dozen. Like 'generated-previews'/'identity' it's regenerable-adjacent
        // (losing it just forgets the list), so it is NOT in REQUIRED_STORES — its absence
        // must never escalate into wiping the user's real data.
        db.createObjectStore('exports', { keyPath: 'id' });
      }
    },
    blocking() {
      // A newer version of the app wants to open the DB; close this connection
      // so the upgrade isn't blocked across tabs.
      (this as unknown as IDBPDatabase).close();
    },
    blocked() {
      // Our open is queued behind an older connection (usually another Lolly tab
      // that didn't close, or one stuck mid-upgrade). Without this it would just
      // hang silently; the timeout below turns that into an actionable error.
      wasBlocked = true;
      console.warn('[db] IndexedDB open is blocked — another Lolly tab/window is holding the database open.');
    },
    terminated() {
      console.error('[db] IndexedDB connection terminated unexpectedly.');
    },
  });

  // A wedged IndexedDB (e.g. a connection in another tab stuck in a versionchange
  // transaction) can leave the open pending forever — which would freeze the
  // whole app on the "Loading…" splash with no feedback, since createBridge()
  // awaits this. Time it out so boot() surfaces a real error the user can act on
  // instead of an indefinite hang. The orphaned open (if it ever resolves) is
  // harmless: the page is reloaded after the user clears the offending tab.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        'Local database is locked — another Lolly tab or window may be open. ' +
        'Close other Lolly/localhost tabs (or fully restart your browser) and reload.'
      );
      // Tag recoverability so boot() can offer a retry. A blocked open clears as
      // soon as the holding connection closes; a non-blocked timeout is a wedged
      // open that a reload may still shake loose.
      (err as Error & { code: string }).code = wasBlocked ? 'DB_BLOCKED' : 'DB_OPEN_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([opening, timeout]).finally(() => clearTimeout(timer)).catch((err) => {
    // If the timeout won the race but the real open resolves a moment later, that's an
    // orphaned LIVE connection — close it, or a retry would leave a handle open that
    // itself blocks the next upgrade (the exact pile-up we're preventing).
    opening.then((db) => { try { db.close(); } catch { /* already closed */ } }, () => { /* open failed too — nothing to close */ });
    throw err;
  });
}

// The ONE shared connection for the whole page, memoised so the bridge, export-history,
// and anything else all reuse it. Opening a fresh connection per caller (export-history
// used to, per read/write) is not just wasteful — every extra LIVE connection needlessly
// blocks a version upgrade (an upgrade needs all other connections closed first), so a
// pile-up of un-closed connections was a direct cause of the "Local database is locked"
// boot hang. A failed open clears this so a later call (e.g. after the blocking tab
// finally closes) can retry from scratch.
let dbPromise: Promise<IDBPDatabase> | null = null;

export function openDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openResilient().catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

/** openHealed(), but a BLOCKED open (another tab holding an older version) is retried for
 *  a while before giving up. Our own blocking() closes our connection when a newer version
 *  wants in, and an active sibling tab closes on the versionchange each re-open fires — so
 *  a blocked open usually clears within a second or two. Retrying recovers that common case
 *  automatically; only a genuinely wedged/frozen holder (which a reload can't fix silently)
 *  falls through to the actionable error boot() surfaces. */
async function openResilient(): Promise<IDBPDatabase> {
  const deadline = Date.now() + 16000;
  for (;;) {
    try {
      // Short per-attempt timeout while retrying — each re-open re-nudges a stuck sibling
      // to close far sooner than one long 8s wait would (a healthy open is near-instant).
      return await openHealed(4000);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if ((code === 'DB_BLOCKED' || code === 'DB_OPEN_TIMEOUT') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw e;
    }
  }
}

async function openHealed(timeoutMs?: number): Promise<IDBPDatabase> {
  let db = await openOnce(timeoutMs);

  // Self-heal a half-initialized DB. An interrupted upgrade (e.g. a tab killed
  // mid-`versionchange`) can leave the DB at the current version yet missing
  // stores — and because the version already matches, the upgrade callback never
  // re-runs to create them, so every transaction throws "object store not found".
  // The only repair is to drop and recreate. This is safe: it triggers solely
  // when a required store is already absent (so there is no data in it to lose),
  // never on a healthy DB.
  const missing = REQUIRED_STORES.filter(name => !db.objectStoreNames.contains(name));
  if (missing.length) {
    console.warn('[db] Rebuilding corrupted lolly DB — missing stores:', missing.join(', '));
    db.close();
    await idbDelete(DB_NAME);
    db = await openOnce(timeoutMs);
  }

  return db;
}
