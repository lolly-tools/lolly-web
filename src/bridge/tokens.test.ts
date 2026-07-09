// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the tokens bridge: brand-agnostic discovery order and the
 * empty-set degradation/retry semantics.
 * Run directly:  node --test shells/web/src/bridge/tokens.test.ts
 *
 * These live next to the bridge (not the repo-root tests/ suite) because they
 * cover shell-side loading, not engine token semantics. DOM-free: the bridge
 * touches only the injected host slice and global fetch — both stubbed here
 * with plain objects (Node ≥18 supplies Blob/Response natively). The user-
 * tokens tests further down compose the REAL assets bridge over an in-memory
 * idb stand-in, so the user-beats-catalog discovery order is exercised
 * end-to-end rather than restated in a stub.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTokensAPI, installUserTokens, BrandLockedError } from './tokens.ts';
import { createAssetsAPI } from './assets.ts';
import { applyBrandVars } from '../brand-vars.ts';

// Minimal DTCG doc — one colour token, enough for a non-empty set.
const DOC  = { color: { brand: { jungle: { $type: 'color', $value: '#30ba78' } } } };
const DOC2 = { color: { brand: { jungle: { $type: 'color', $value: '#123456' } } } };

const docBlob = (doc: unknown) => new Blob([JSON.stringify(doc)], { type: 'application/json' });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replace global fetch with a url → JSON body table; misses 404. Records every url hit. */
function stubFetch(routes: Record<string, unknown>, log: string[] = []): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    log.push(url);
    if (url in routes) return new Response(JSON.stringify(routes[url]), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

test('synced metadata + cached blob resolve fully offline (no fetch at all)', async () => {
  const fetchLog: string[] = [];
  stubFetch({}, fetchLog);
  const api = createTokensAPI({ assets: {
    _findMetaByType: async type => (type === 'tokens'
      ? { id: 'acme/tokens/brand', formats: [{ url: '/catalog/assets/acme/tokens/brand.json' }] }
      : null),
    _getBlob: async id => (id === 'acme/tokens/brand' ? docBlob(DOC) : null),
  } });
  assert.equal(await api.resolve('{color.brand.jungle}'), '#30ba78');
  assert.deepEqual(fetchLog, []);
});

test('falls back to the catalog index, then the asset file, when nothing is synced', async () => {
  const fetchLog: string[] = [];
  stubFetch({
    '/catalog/assets/index.json': { assets: [
      { id: 'acme/logo', type: 'vector', formats: [{ url: '/logo.svg' }] },
      { id: 'acme/tokens/brand', type: 'tokens', formats: [{ url: '/catalog/assets/acme/tokens/brand.json' }] },
    ] },
    '/catalog/assets/acme/tokens/brand.json': DOC,
  }, fetchLog);
  const api = createTokensAPI({ assets: {
    _findMetaByType: async () => { throw new Error('idb unavailable'); }, // private mode / IDB broken
    _getBlob: async () => null,                                           // nothing cached either
  } });
  assert.equal(await api.resolve('color.brand.jungle'), '#30ba78');
  // First tokens-type asset in index order wins, then its formats[0].url is fetched.
  assert.deepEqual(fetchLog, ['/catalog/assets/index.json', '/catalog/assets/acme/tokens/brand.json']);
});

test('fresh boot (IDB open, asset-meta empty → resolves NULL) still reaches the index fallback', async () => {
  // The true pre-sync state is _findMetaByType RESOLVING null (getAll → [] →
  // find → undefined ?? null), not throwing — a refactor that only falls back
  // on throw would silently lose tokens on every online cold boot.
  const fetchLog: string[] = [];
  stubFetch({
    '/catalog/assets/index.json': { assets: [
      { id: 'acme/tokens/brand', type: 'tokens', formats: [{ url: '/catalog/assets/acme/tokens/brand.json' }] },
    ] },
    '/catalog/assets/acme/tokens/brand.json': DOC,
  }, fetchLog);
  const api = createTokensAPI({ assets: {
    _findMetaByType: async () => null, // pre-sync: store exists but is empty
    _getBlob: async () => null,
  } });
  assert.equal(await api.resolve('color.brand.jungle'), '#30ba78');
  assert.deepEqual(fetchLog, ['/catalog/assets/index.json', '/catalog/assets/acme/tokens/brand.json']);
});

test('total failure yields an empty set that is never cached — the next call retries', async () => {
  stubFetch({}); // index fetch 404s too
  let blob: Blob | null = null;
  const api = createTokensAPI({ assets: {
    _findMetaByType: async () => ({ id: 'acme/tokens/brand', formats: [] }),
    _getBlob: async () => blob,
  } });
  assert.equal((await api.get()).size, 0);   // discovery ok but no bytes anywhere
  blob = docBlob(DOC);                       // …then boot sync finishes caching the blob
  assert.equal(await api.resolve('color.brand.jungle'), '#30ba78'); // retried, not stuck empty
});

test('bust() drops the memoised document and per-theme sets', async () => {
  stubFetch({});
  let blob = docBlob(DOC);
  const api = createTokensAPI({ assets: {
    _findMetaByType: async () => ({ id: 'acme/tokens/brand', formats: [] }),
    _getBlob: async () => blob,
  } });
  assert.equal(await api.resolve('color.brand.jungle'), '#30ba78');
  blob = docBlob(DOC2);                                             // e.g. a brand ingest installed new tokens
  assert.equal(await api.resolve('color.brand.jungle'), '#30ba78'); // still the cached set
  api.bust();
  assert.equal(await api.resolve('color.brand.jungle'), '#123456'); // re-discovered + reloaded
});

// ── User tokens (the runtime brand) — real assets bridge over an in-memory db ──

/** Minimal in-memory stand-in for the idb slice bridge/assets.ts consumes —
 *  just the user-assets / asset-meta / asset-blob reads and writes these tests
 *  exercise (the transaction form is only needed by sync/prune, unused here). */
function memDb(seed: {
  meta?: Array<Record<string, unknown>>;
  blobs?: Record<string, Blob>;
  users?: Array<Record<string, unknown>>;
} = {}) {
  const stores: Record<string, Map<string, unknown>> = {
    'user-assets': new Map((seed.users ?? []).map(r => [String(r.id), r])),
    'asset-meta':  new Map((seed.meta ?? []).map(r => [String(r.id), r])),
    'asset-blob':  new Map(Object.entries(seed.blobs ?? {})),
  };
  return {
    async get(store: string, key: string) { return stores[store]!.get(key); },
    async getAll(store: string) { return [...stores[store]!.values()]; },
    async getAllKeys(store: string) { return [...stores[store]!.keys()]; },
    async put(store: string, value: unknown, key?: string) {
      stores[store]!.set(key ?? String((value as { id: string }).id), value);
    },
    async delete(store: string, key: string) { stores[store]!.delete(key); },
  } as unknown as Parameters<typeof createAssetsAPI>[0];
}

/** A synced catalog carrying the shipped starter brand (the unbranded state). */
const CATALOG_TOKENS = () => ({
  meta: [{
    id: 'lolly/tokens/brand', type: 'tokens', version: '1.0.0', tier: 'core',
    formats: [{ format: 'json', url: '/catalog/assets/lolly/tokens/brand.json' }],
  }],
  blobs: { 'lolly/tokens/brand:json:1.0.0': docBlob(DOC) },
});

test('a user tokens asset wins discovery over the catalog brand — its doc is served', async () => {
  stubFetch({});
  const assets = createAssetsAPI(memDb({
    ...CATALOG_TOKENS(),
    users: [{ id: 'user/tokens/brand', type: 'tokens', format: 'json', blob: docBlob(DOC2), version: '1.0.0' }],
  }));
  const api = createTokensAPI({ assets });
  assert.equal((await assets._findMetaByType('tokens'))?.id, 'user/tokens/brand');
  assert.equal(await api.resolve('{color.brand.jungle}'), '#123456'); // DOC2 (user), not the catalog DOC
});

test('installUserTokens writes + busts — the very next resolve() sees the new doc', async () => {
  stubFetch({});
  const assets = createAssetsAPI(memDb(CATALOG_TOKENS()));
  const tokens = createTokensAPI({ assets });
  const host = { assets, tokens };
  assert.equal(await tokens.resolve('color.brand.jungle'), '#30ba78'); // shipped brand, now memoised
  await installUserTokens(host, DOC2, { label: 'Acme brand' });
  assert.equal(await tokens.resolve('color.brand.jungle'), '#123456'); // no manual bust() — install did it
});

test('installUserTokens rejects a non-object document without touching the store', async () => {
  stubFetch({});
  const assets = createAssetsAPI(memDb(CATALOG_TOKENS()));
  const tokens = createTokensAPI({ assets });
  for (const bad of [null, undefined, 'oklch(60% 0.1 250)', 42, ['not', 'a', 'doc']]) {
    await assert.rejects(installUserTokens({ assets, tokens }, bad), /DTCG token document/);
  }
  assert.equal((await assets._findMetaByType('tokens'))?.id, 'lolly/tokens/brand'); // still unbranded
});

test('discovery id flips lolly/tokens/brand → user/tokens/brand after install (the branded signal)', async () => {
  stubFetch({});
  const assets = createAssetsAPI(memDb(CATALOG_TOKENS()));
  const tokens = createTokensAPI({ assets });
  // Unbranded detection (welcome trigger): the discovered tokens id is the shipped one…
  assert.equal((await assets._findMetaByType('tokens'))?.id, 'lolly/tokens/brand');
  await installUserTokens({ assets, tokens }, DOC2);
  // …and installing user tokens flips it, which is exactly what "branded" means.
  assert.equal((await assets._findMetaByType('tokens'))?.id, 'user/tokens/brand');
});

// ── Brand lock (an authoritative, non-overridable catalog brand) ──────────────

/** A synced catalog whose tokens asset declares brandLock — the app must resolve
 *  ITS doc and ignore any user install (the SUSE profile's stance). */
const LOCKED_CATALOG_TOKENS = () => ({
  meta: [{
    id: 'suse/tokens/brand', type: 'tokens', version: '1.0.0', tier: 'core', brandLock: true,
    formats: [{ format: 'json', url: '/catalog/assets/suse/tokens/brand.json' }],
  }],
  blobs: { 'suse/tokens/brand:json:1.0.0': docBlob(DOC) },
});

test('isLocked reflects the SHIPPED catalog flag (true for a locked brand, false otherwise)', async () => {
  stubFetch({});
  const locked = createTokensAPI({ assets: createAssetsAPI(memDb(LOCKED_CATALOG_TOKENS())) });
  assert.equal(await locked.isLocked(), true);
  const open = createTokensAPI({ assets: createAssetsAPI(memDb(CATALOG_TOKENS())) });
  assert.equal(await open.isLocked(), false);
});

test('a locked brand IGNORES a pre-existing user tokens asset — the catalog doc is served', async () => {
  stubFetch({});
  const assets = createAssetsAPI(memDb({
    ...LOCKED_CATALOG_TOKENS(),
    // A leftover from an earlier, unlocked profile — user-first discovery would normally serve it.
    users: [{ id: 'user/tokens/brand', type: 'tokens', format: 'json', blob: docBlob(DOC2), version: '1.0.0' }],
  }));
  const api = createTokensAPI({ assets });
  // Default (user-first) discovery still points at the user asset…
  assert.equal((await assets._findMetaByType('tokens'))?.id, 'user/tokens/brand');
  // …but catalogOnly sees the locked shipped brand, and resolution follows it.
  assert.equal((await assets._findMetaByType('tokens', { catalogOnly: true }))?.id, 'suse/tokens/brand');
  assert.equal(await api.isLocked(), true);
  assert.equal(await api.resolve('{color.brand.jungle}'), '#30ba78'); // catalog DOC, NOT the user DOC2
});

test('installUserTokens refuses on a locked brand (BrandLockedError) and writes nothing', async () => {
  stubFetch({});
  const assets = createAssetsAPI(memDb(LOCKED_CATALOG_TOKENS()));
  const tokens = createTokensAPI({ assets });
  await assert.rejects(installUserTokens({ assets, tokens }, DOC2, { label: 'Nope' }), BrandLockedError);
  // No user asset was written — the shipped brand still stands.
  assert.equal((await assets._findMetaByType('tokens'))?.id, 'suse/tokens/brand');
  assert.equal(await tokens.resolve('{color.brand.jungle}'), '#30ba78');
});

// ── applyBrandVars (brand-vars.ts) — the contract-§3 injection rules ───────────
// DOM-free like the rest of this file: applyBrandVars only touches
// el.style.setProperty/removeProperty, so a recording stand-in suffices.

/** Style-only HTMLElement stand-in recording custom-property writes. */
function stubEl(seed: Record<string, string> = {}) {
  const props = new Map(Object.entries(seed));
  const el = { style: {
    setProperty: (k: string, v: string) => { props.set(k, v); },
    removeProperty: (k: string) => { props.delete(k); },
  } } as unknown as HTMLElement;
  return { el, props };
}

/** A tokens host resolving `{color.semantic.<slot>}` refs from a slot table. */
const hostFor = (slots: Record<string, unknown>) => ({
  tokens: { resolve: async (ref: string) => slots[ref.slice('{color.semantic.'.length, -1)] },
});

test('applyBrandVars sets the seven slots under the --brand-* namespace, never the bare shell names', async () => {
  const { el, props } = stubEl();
  await applyBrandVars(el, hostFor({
    'primary': 'oklch(60% 0.1 250)', 'on-primary': '#ffffff', 'secondary': '#123456',
    'surface': '#fafafa', 'text': '#111111', 'muted': '#666666', 'edge': '#dddddd',
  }));
  assert.equal(props.get('--brand-primary'), 'oklch(60% 0.1 250)'); // raw oklch passes through (browser-native)
  assert.equal(props.get('--brand-on-primary'), '#ffffff');
  assert.deepEqual([...props.keys()].sort(), [
    '--brand-edge', '--brand-muted', '--brand-on-primary', '--brand-primary',
    '--brand-secondary', '--brand-surface', '--brand-text',
  ]);
  // Bare --primary/--muted/… are the SHELL's shadcn HSL-triple vocabulary
  // (styles/tokens.css) that community tools consume via hsl(var(--primary)) —
  // injecting full colours under those names would break them (contract §3).
  assert.equal(props.has('--primary'), false);
});

test('applyBrandVars treats alias residue as a missing slot — removed, never injected verbatim', async () => {
  const { el, props } = stubEl({ '--brand-surface': '#eeeeee' }); // stale value from a prior brand
  await applyBrandVars(el, hostFor({ primary: '#30ba78', surface: '{color.ramp.neutral.9}' }));
  assert.equal(props.get('--brand-primary'), '#30ba78');
  // An unresolvable alias would DEFINE the var, so `var(--brand-surface, #fff)`
  // would substitute garbage instead of the fallback. It must be unset.
  assert.equal(props.has('--brand-surface'), false);
});

test('applyBrandVars normalises structured DTCG colour objects via the engine (CLI parity)', async () => {
  const { el, props } = stubEl();
  await applyBrandVars(el, hostFor({
    primary: { components: [0, 1, 0] }, // modern DTCG object form → hex, matching the CLI
    secondary: { nonsense: true },      // unreadable object → missing slot
  }));
  assert.equal(props.get('--brand-primary'), '#00ff00');
  assert.equal(props.has('--brand-secondary'), false);
});

test('applyBrandVars removes every slot when tokens are absent (missing slot ⇒ var not set, never \'\')', async () => {
  const { el, props } = stubEl({ '--brand-primary': '#30ba78', '--brand-text': '#111111' });
  await applyBrandVars(el, {}); // a host without the tokens capability
  assert.equal(props.size, 0);
});
