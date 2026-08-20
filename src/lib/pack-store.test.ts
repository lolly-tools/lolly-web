// SPDX-License-Identifier: MPL-2.0
/**
 * Instance-pack store + overlay (plans/131 WP-D).
 *
 * Headless via the _setDbForTests seam (a Map-backed idb fake - node has no
 * IndexedDB) plus a stubbed global fetch for the underlying-index legs. The
 * signature suite exercises the FAIL-CLOSED path with a real P-256 keypair:
 * pinned+unsigned refuses, pinned+wrong-key refuses, pinned+right-key verifies -
 * the properties the trust story actually rests on.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  _resetPackStoreForTests, _setDbForTests, _setPinnedKeyForTests,
  clearInstancePack, getPackMeta, importInstancePackParts, initPackStore,
  packActive, packAssetEntries, packFetch, packToolEntries,
} from './pack-store.ts';
import { _setBaseForTests, instanceFetch } from './instance.ts';

const enc = new TextEncoder();

/** Map-backed fake of the narrow idb surface pack-store uses. */
function fakeDb() {
  const stores = new Map<string, Map<string, unknown>>();
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    stores,
    async get(s: string, key: string) { return store(s).get(key); },
    async put(s: string, value: unknown, key: string) { store(s).set(key, value); },
    async delete(s: string, key: string) { store(s).delete(key); },
    async clear(s: string) { store(s).clear(); },
    async getAllKeys(s: string) { return [...store(s).keys()]; },
    transaction(names: string[], _mode: 'readwrite') {
      return {
        objectStore: (name: string) => ({
          put: (value: unknown, key: string) => { store(name).set(key, value); },
          clear: () => { store(name).clear(); },
        }),
        done: Promise.resolve(),
      };
    },
  };
}

/** A minimal instance-pack file set (already-unzipped shape). */
function packFiles(opts: { instance?: string; sig?: Uint8Array } = {}): Record<string, Uint8Array> {
  const manifest = enc.encode(JSON.stringify({ format: 'lolly-brand', formatVersion: 3, minReader: 1 }));
  const files: Record<string, Uint8Array> = {
    'manifest.json': manifest,
    'instance.json': enc.encode(JSON.stringify({
      kind: 'instance-pack', name: 'Test Brand', publisher: 'Testers', version: '1.0.0',
      ...(opts.instance ? { instance: opts.instance } : {}),
    })),
    'tools.json': enc.encode(JSON.stringify({
      tools: [{ id: 'brand-x', name: 'Brand X' }],
      files: { 'brand-x': ['tool.json', 'template.html'] },
    })),
    'catalog.json': enc.encode(JSON.stringify({
      assets: [{ id: 'test/logo/a', formats: [{ url: '/catalog/assets/test/a.svg' }] }],
    })),
    'tools/brand-x/tool.json': enc.encode('{"id":"brand-x"}'),
    'tools/brand-x/template.html': enc.encode('<div></div>'),
    'catalog/assets/test/a.svg': enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'tokens.json': enc.encode('{}'), // brand part - must NOT land in the pack store
  };
  if (opts.sig) files['pack.sig'] = opts.sig;
  return files;
}

let db: ReturnType<typeof fakeDb>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  db = fakeDb();
  _resetPackStoreForTests();
  _setDbForTests(db);
  _setPinnedKeyForTests('');
  _setBaseForTests('');
});

afterEach(() => {
  _setDbForTests(null);
  _setPinnedKeyForTests('');
  _resetPackStoreForTests();
  globalThis.fetch = realFetch;
});

test('import lands tool + catalog bytes at canonical paths, brand parts stay out', async () => {
  const result = await importInstancePackParts(packFiles({ instance: 'https://packs.example.com' }));
  assert.equal(result.tools, 1);
  assert.equal(result.assets, 1);
  assert.equal(result.name, 'Test Brand');
  assert.equal(result.signature, 'unsigned');
  assert.equal(result.instance, 'https://packs.example.com');
  assert.ok(packActive());
  assert.equal(getPackMeta()?.publisher, 'Testers');

  const tool = await packFetch('/tools/brand-x/tool.json');
  assert.ok(tool);
  assert.equal(tool.headers.get('content-type'), 'application/json');
  assert.equal((await tool.json()).id, 'brand-x');

  const svg = await packFetch('/catalog/assets/test/a.svg');
  assert.equal(svg?.headers.get('content-type'), 'image/svg+xml');

  // Brand parts (tokens.json) belong to brand-transfer, not the pack store.
  assert.equal(await packFetch('/tokens.json'), null);
  assert.equal(db.stores.get('pack-files')?.has('tokens.json'), false);

  assert.deepEqual((await packToolEntries()).map(t => t.id), ['brand-x']);
  assert.deepEqual((await packAssetEntries()).map(a => a.id), ['test/logo/a']);
});

test('meta + paths survive a fresh init (new session over the same DB)', async () => {
  await importInstancePackParts(packFiles());
  _resetPackStoreForTests();
  _setDbForTests(db);
  assert.ok(!packActive());
  await initPackStore();
  assert.ok(packActive());
  assert.equal(getPackMeta()?.name, 'Test Brand');
});

test('clearInstancePack removes everything', async () => {
  await importInstancePackParts(packFiles());
  await clearInstancePack();
  assert.ok(!packActive());
  assert.equal(await packFetch('/tools/brand-x/tool.json'), null);
  assert.equal(db.stores.get('pack-files')?.size, 0);
});

test('instanceFetch serves pack files before any transport', async () => {
  await importInstancePackParts(packFiles());
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return new Response('nope', { status: 404 }); }) as typeof fetch;
  const resp = await instanceFetch('/tools/brand-x/template.html');
  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), '<div></div>');
  assert.equal(fetched, 0);
});

test('instanceFetch merges the tool index - pack wins on id collision', async () => {
  await importInstancePackParts(packFiles());
  globalThis.fetch = (async () => new Response(JSON.stringify({
    version: '9',
    tools: [{ id: 'community-a' }, { id: 'brand-x', stale: true }],
  }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const index = await (await instanceFetch('/catalog/tools/index.json')).json();
  assert.equal(index.version, '9');
  assert.deepEqual(index.tools.map((t: { id: string }) => t.id), ['community-a', 'brand-x']);
  const packRow = index.tools.find((t: { id: string }) => t.id === 'brand-x');
  assert.equal(packRow.stale, undefined, 'the pack entry replaced the underlying one');
});

test('index merge degrades to pack-only entries when the underlying source is down', async () => {
  await importInstancePackParts(packFiles());
  globalThis.fetch = (async () => { throw new TypeError('offline'); }) as typeof fetch;
  const index = await (await instanceFetch('/catalog/assets/index.json')).json();
  assert.deepEqual(index.assets.map((a: { id: string }) => a.id), ['test/logo/a']);
});

test('with no pack loaded, instanceFetch is a passthrough', async () => {
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return new Response('{}'); }) as typeof fetch;
  await instanceFetch('/catalog/tools/index.json');
  assert.equal(fetched, 1);
});

// ── signature policy ─────────────────────────────────────────────────────────

async function keypair() {
  const kp = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const pub = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
  return { kp, pubJson: JSON.stringify(pub) };
}

async function signed(files: Record<string, Uint8Array>, key: CryptoKey): Promise<Record<string, Uint8Array>> {
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, files['manifest.json'] as unknown as NodeJS.BufferSource,
  );
  return {
    ...files,
    'pack.sig': enc.encode(JSON.stringify({
      alg: 'ECDSA-P256-SHA256',
      signature: Buffer.from(sig).toString('base64'),
    })),
  };
}

test('no pinned key: signed pack reads as unverified, unsigned as unsigned', async () => {
  const { kp } = await keypair();
  const result = await importInstancePackParts(await signed(packFiles(), kp.privateKey));
  assert.equal(result.signature, 'unverified');
});

test('pinned key: an unsigned pack is refused', async () => {
  const { pubJson } = await keypair();
  _setPinnedKeyForTests(pubJson);
  await assert.rejects(() => importInstancePackParts(packFiles()), /signed packs/);
  assert.ok(!packActive(), 'nothing may land from a refused pack');
});

test('pinned key: the matching signature verifies', async () => {
  const { kp, pubJson } = await keypair();
  _setPinnedKeyForTests(pubJson);
  const result = await importInstancePackParts(await signed(packFiles(), kp.privateKey));
  assert.equal(result.signature, 'verified');
});

test('pinned key: a foreign signature is refused', async () => {
  const { pubJson } = await keypair();
  const other = await keypair();
  _setPinnedKeyForTests(pubJson);
  const files = await signed(packFiles(), other.kp.privateKey);
  await assert.rejects(() => importInstancePackParts(files), /doesn't match/);
  assert.ok(!packActive());
});

test('pinned key: tampered manifest bytes are refused', async () => {
  const { kp, pubJson } = await keypair();
  _setPinnedKeyForTests(pubJson);
  const files = await signed(packFiles(), kp.privateKey);
  files['manifest.json'] = enc.encode(JSON.stringify({ format: 'lolly-brand', formatVersion: 3, minReader: 1, evil: true }));
  await assert.rejects(() => importInstancePackParts(files), /doesn't match/);
});
