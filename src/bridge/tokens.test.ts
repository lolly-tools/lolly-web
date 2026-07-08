// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the tokens bridge: brand-agnostic discovery order and the
 * empty-set degradation/retry semantics.
 * Run directly:  node --test shells/web/src/bridge/tokens.test.ts
 *
 * These live next to the bridge (not the repo-root tests/ suite) because they
 * cover shell-side loading, not engine token semantics. DOM-free: the bridge
 * touches only the injected host slice and global fetch — both stubbed here
 * with plain objects (Node ≥18 supplies Blob/Response natively).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTokensAPI } from './tokens.ts';

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
