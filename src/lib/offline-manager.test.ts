// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the "Available offline" download engine — the pure download
 * machinery (list downloads with resume/cancel/failure semantics, the docs
 * file-list selection). The IDB-backed part records and the actual service
 * worker serving are covered elsewhere (sw.test.ts drives the real sw.js).
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal Cache Storage + fetch stand-ins (same shape sw.test.ts fakes) ────

class FakeCache {
  entries = new Map<string, { body: string; headers: Map<string, string> }>();
  async match(key: string | { url?: string }) {
    const k = typeof key === 'string' ? k1(key) : k1(key.url ?? '');
    const held = this.entries.get(k);
    if (!held) return undefined;
    return { headers: { get: (n: string) => held.headers.get(n.toLowerCase()) ?? null } };
  }
  async put(key: string | { url?: string }, resp: { _body: string; headers: Headers | Map<string, string> }) {
    const k = typeof key === 'string' ? k1(key) : k1(key.url ?? '');
    const headers = new Map<string, string>();
    const h = resp.headers as { forEach?: (fn: (v: string, n: string) => void) => void };
    h.forEach?.((v, n) => headers.set(n.toLowerCase(), v));
    this.entries.set(k, { body: resp._body, headers });
  }
  async keys() { return [...this.entries.keys()].map(url => ({ url: `https://x${url}` })); }
  async delete(key: { url: string }) { return this.entries.delete(k1(key.url)); }
}
const k1 = (u: string): string => (u.startsWith('http') ? new URL(u).pathname : u);

const cacheStore = new Map<string, FakeCache>();
(globalThis as Record<string, unknown>).caches = {
  async open(name: string) {
    if (!cacheStore.has(name)) cacheStore.set(name, new FakeCache());
    return cacheStore.get(name)!;
  },
  async delete(name: string) { return cacheStore.delete(name); },
};

/** URLs the fake network serves, with sizes; a missing URL 404s. */
const server = new Map<string, number>();
let fetches: string[] = [];
(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { signal?: AbortSignal }) => {
  init?.signal?.throwIfAborted();
  fetches.push(url);
  const size = server.get(url);
  if (size === undefined) {
    return { ok: false, status: 404, headers: new Headers({ 'content-type': 'text/html' }), blob: async () => new Blob(['nope']) };
  }
  const body = 'x'.repeat(size);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    // content-encoding + a COMPRESSED content-length, the way a br/gzip host
    // answers — what the poisoning regression test needs on the wire.
    headers: new Headers({
      'content-type': 'application/octet-stream',
      'content-encoding': 'br',
      'content-length': String(Math.ceil(size / 2)),
    }),
    blob: async () => new Blob([body]),
    _body: body,
  };
};

const { downloadList, docsFileList } = await import('./offline-manager.ts');

beforeEach(() => {
  cacheStore.clear();
  server.clear();
  fetches = [];
});

describe('offline-manager: downloadList', () => {
  test('downloads every file, reports byte progress, and lands them in the bucket', async () => {
    server.set('/assets/a.js', 100);
    server.set('/fonts/b.woff2', 50);
    const seen: Array<{ loaded: number; total: number | null }> = [];
    const res = await downloadList('bucket', [
      { url: '/assets/a.js', size: 100 },
      { url: '/fonts/b.woff2', size: 50 },
    ], { onProgress: p => seen.push({ loaded: p.loaded, total: p.total }) });

    assert.deepEqual(res, { bytes: 150, files: 2 });
    assert.equal(cacheStore.get('bucket')!.entries.size, 2);
    assert.equal(seen[0]!.loaded, 0, 'progress starts at zero');
    assert.equal(seen.at(-1)!.loaded, 150, 'progress ends at the full byte total');
    assert.ok(seen.every(p => p.total === 150));
  });

  test('stored responses carry no transfer headers and a manifest-size stamp', async () => {
    // Regression pin for the content-decoding poisoning: fetch() hands back a
    // DECODED body, so replaying the wire content-encoding header over it
    // breaks every offline load of that file. The stored entry must drop the
    // encoding headers and stamp the manifest identity for resumes.
    server.set('/fonts/a.woff2', 64);
    await downloadList('bucket', [{ url: '/fonts/a.woff2', size: 64 }]);
    const held = cacheStore.get('bucket')!.entries.get('/fonts/a.woff2')!;
    assert.equal(held.headers.get('content-encoding'), undefined, 'wire encoding must not survive');
    assert.equal(held.headers.get('x-lolly-manifest-size'), '64');
  });

  test('a hash-carrying manifest entry revalidates by hash, not size', async () => {
    server.set('/icons/logo.svg', 40);
    await downloadList('bucket', [{ url: '/icons/logo.svg', size: 40, hash: 'aaaa' }]);
    fetches = [];
    // Same URL, same size, DIFFERENT bytes (new hash) — must re-download.
    await downloadList('bucket', [{ url: '/icons/logo.svg', size: 40, hash: 'bbbb' }]);
    assert.deepEqual(fetches, ['/icons/logo.svg'], 'a same-size content change must not be invisible');
    fetches = [];
    // Unchanged hash — must skip.
    await downloadList('bucket', [{ url: '/icons/logo.svg', size: 40, hash: 'bbbb' }]);
    assert.deepEqual(fetches, [], 'an unchanged file must resume for free');
  });

  test('resumes: files already present and current are not re-fetched', async () => {
    server.set('/assets/a.js', 100);
    server.set('/data/big.bin', 500);
    await downloadList('bucket', [{ url: '/assets/a.js', size: 100 }]);
    fetches = [];

    const res = await downloadList('bucket', [
      { url: '/assets/a.js', size: 100 },       // hashed name — existence is proof
      { url: '/data/big.bin', size: 500 },      // new file — must fetch
    ]);
    assert.deepEqual(res, { bytes: 600, files: 2 });
    assert.deepEqual(fetches, ['/data/big.bin'], 'the already-downloaded file must be skipped');
  });

  test('a size mismatch on a non-hashed path re-downloads (stale copy ≠ downloaded)', async () => {
    server.set('/info/page.html', 80);
    await downloadList('bucket', [{ url: '/info/page.html', size: 80 }]);
    fetches = [];
    // The deploy changed the page: manifest now says 90 bytes.
    server.set('/info/page.html', 90);
    await downloadList('bucket', [{ url: '/info/page.html', size: 90 }]);
    assert.deepEqual(fetches, ['/info/page.html'], 'a stale-size copy must re-fetch');
  });

  test('throws when any file fails, after draining the rest — never silently partial', async () => {
    server.set('/assets/a.js', 10);
    // /assets/missing.js is not served → 404 (an HTML body, the SPA-fallback shape)
    await assert.rejects(
      downloadList('bucket', [
        { url: '/assets/a.js', size: 10 },
        { url: '/assets/missing.js', size: 20 },
      ]),
      /1 of 2 files failed/,
    );
    assert.ok(cacheStore.get('bucket')!.entries.has('/assets/a.js'),
      'the good file stays cached for the retry to resume from');
  });

  test('cancel aborts the queue and leaves already-fetched files for the resume', async () => {
    const controller = new AbortController();
    server.set('/a', 10);
    server.set('/b', 10);
    let calls = 0;
    const onProgress = () => { if (++calls === 2) controller.abort(); }; // after the first file lands
    await assert.rejects(
      downloadList('bucket', [{ url: '/a', size: 10 }, { url: '/b', size: 10 }],
        { signal: controller.signal, onProgress }),
    );
    assert.ok(cacheStore.get('bucket')!.entries.size >= 1, 'completed files survive the cancel');
  });
});

describe('offline-manager: docsFileList', () => {
  const manifest = {
    version: 'v1',
    groups: {
      en: [{ url: '/info/index.html', size: 1 }],
      shots: [{ url: '/info/shots/a.svg', size: 2 }],
      locales: { fr: [{ url: '/info/fr/index.html', size: 3 }] },
    },
  };

  test('English installs take the root pages + shots only', () => {
    assert.deepEqual(docsFileList(manifest, 'en').map(f => f.url),
      ['/info/index.html', '/info/shots/a.svg']);
  });

  test('a translated install adds its locale on top', () => {
    assert.deepEqual(docsFileList(manifest, 'fr').map(f => f.url),
      ['/info/index.html', '/info/shots/a.svg', '/info/fr/index.html']);
  });

  test('an unknown locale degrades to the English set', () => {
    assert.deepEqual(docsFileList(manifest, 'xx').map(f => f.url),
      ['/info/index.html', '/info/shots/a.svg']);
  });
});
