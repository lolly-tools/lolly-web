// SPDX-License-Identifier: MPL-2.0
/**
 * Service-worker fetch-routing tests.
 *
 * `public/sw.js` ships as a classic (non-module) worker script, so it cannot be
 * imported: it registers `self.addEventListener` at top level and has no exports.
 * Instead the real file is read from disk and evaluated in a `node:vm` context
 * holding a minimal worker environment — a fake `self`, an in-memory Cache
 * Storage, and a `fetch` the test drives. The handlers under test are therefore
 * the SHIPPING ones, not a transcription of them.
 *
 * The regression this exists for: every successful navigation used to be written
 * to the `SHELL_URL` ('/') cache key, on the assumption that every navigation
 * resolves to the SPA's index.html. The /info docs site is ~41 pages × 27 locales
 * of real static HTML that does NOT, so opening the privacy policy replaced the
 * cached app shell with that page and the next offline load of the app served
 * documentation instead of the app.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const SW_SRC = fileURLToPath(new URL('../public/sw.js', import.meta.url));

/** Minimal in-memory stand-in for one Cache instance. */
class FakeCache {
  entries = new Map<string, string>();
  async match(req: { url?: string } | string) {
    const key = typeof req === 'string' ? req : (req.url ?? '');
    const body = this.entries.get(key) ?? this.entries.get(new URL(key, 'https://x').pathname);
    return body === undefined ? undefined : makeResponse(body);
  }
  async put(req: { url?: string } | string, res: { _body: string }) {
    const key = typeof req === 'string' ? req : (req.url ?? '');
    this.entries.set(key, res._body);
  }
  async addAll(urls: string[]) { for (const u of urls) this.entries.set(u, `precached:${u}`); }
  async add(url: string) { this.entries.set(url, `precached:${url}`); }
}

function makeResponse(body: string, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return { _body: body, status, ok: status >= 200 && status < 300, clone() { return this; } };
}

interface Harness {
  fetchHandler: (event: unknown) => void;
  caches: Map<string, FakeCache>;
  /** Set to make the network fail (simulates offline). */
  offline: { value: boolean };
  /** What the network returns, keyed by pathname. */
  server: Map<string, string>;
  activate: () => Promise<void>;
}

/** Evaluate the real sw.js in a sandbox and hand back its registered handlers. */
function loadServiceWorker(): Harness {
  const src = readFileSync(SW_SRC, 'utf8');
  const listeners = new Map<string, (event: unknown) => void>();
  const cacheStore = new Map<string, FakeCache>();
  const offline = { value: false };
  const server = new Map<string, string>();

  const cachesApi = {
    async open(name: string) {
      if (!cacheStore.has(name)) cacheStore.set(name, new FakeCache());
      return cacheStore.get(name)!;
    },
    async keys() { return [...cacheStore.keys()]; },
    async delete(name: string) { return cacheStore.delete(name); },
    async match(req: { url: string }, opts: { cacheName?: string } = {}) {
      const c = opts.cacheName ? cacheStore.get(opts.cacheName) : undefined;
      return c ? c.match(req) : undefined;
    },
  };

  const sandbox = {
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
      location: { origin: 'https://lolly.tools' },
    },
    caches: cachesApi,
    fetch: async (req: { url: string }) => {
      if (offline.value) throw new TypeError('Failed to fetch');
      const path = new URL(req.url).pathname;
      const body = server.get(path);
      return body === undefined ? makeResponse('not found', { status: 404 }) : makeResponse(body);
    },
    Response: function (body: string, init: { status?: number } = {}) { return makeResponse(body, init); },
    URL, setTimeout, clearTimeout, Promise, console,
  };
  runInContext(src, createContext(sandbox));

  return {
    fetchHandler: listeners.get('fetch')!,
    caches: cacheStore,
    offline,
    server,
    activate: async () => {
      let work: Promise<unknown> = Promise.resolve();
      listeners.get('activate')!({ waitUntil: (p: Promise<unknown>) => { work = p; } });
      await work;
    },
  };
}

/** Drive one navigation through the fetch handler and return the served body. */
async function navigate(h: Harness, url: string): Promise<string | null> {
  const request = { method: 'GET', url, mode: 'navigate' };
  // Held on an object, not a `let`: TypeScript's control-flow analysis cannot see
  // the assignment happen inside respondWith, so a local would narrow to `never`.
  const out: { responded: Promise<{ _body: string }> | null } = { responded: null };
  h.fetchHandler({ request, respondWith: (p: Promise<{ _body: string }>) => { out.responded = p; }, waitUntil: () => {} });
  if (!out.responded) return null;   // handler declined → browser handles it (bypass)
  return (await out.responded)._body;
}

/** The generation cache the worker is currently writing to. */
function shellEntry(h: Harness): string | undefined {
  for (const [name, cache] of h.caches) {
    if (name.startsWith('lolly-v')) return cache.entries.get('/');
  }
  return undefined;
}

describe('service worker: the app shell key', () => {
  test('an SPA navigation is cached as the shell and served offline', async () => {
    const h = loadServiceWorker();
    h.server.set('/', 'APP_SHELL');
    assert.equal(await navigate(h, 'https://lolly.tools/'), 'APP_SHELL');
    assert.equal(shellEntry(h), 'APP_SHELL', 'a real SPA navigation must populate the shell key');

    h.offline.value = true;
    assert.equal(await navigate(h, 'https://lolly.tools/pro'), 'APP_SHELL',
      'offline, an extensionless route falls back to the cached shell');
  });

  test('a docs navigation does NOT replace the cached app shell', async () => {
    const h = loadServiceWorker();
    h.server.set('/', 'APP_SHELL');
    h.server.set('/info/privacy.html', 'PRIVACY_POLICY_PAGE');
    await navigate(h, 'https://lolly.tools/');
    assert.equal(shellEntry(h), 'APP_SHELL');

    // Reading the privacy policy — the exact reproduction of the bug.
    await navigate(h, 'https://lolly.tools/info/privacy.html');
    assert.equal(shellEntry(h), 'APP_SHELL',
      'visiting an /info page must leave the cached app shell untouched');

    h.offline.value = true;
    assert.equal(await navigate(h, 'https://lolly.tools/'), 'APP_SHELL',
      'the offline app must still boot into the app, not into documentation');
  });

  test('/info is passed through to the browser rather than answered by the worker', async () => {
    const h = loadServiceWorker();
    h.server.set('/info/using.html', 'USING_PAGE');
    assert.equal(await navigate(h, 'https://lolly.tools/info/using.html'), null,
      '/info must be bypassed, so the worker never stores or serves it');
  });

  test('a navigation to a real file is never stored as the shell', async () => {
    // The backstop for paths that are NOT in BYPASS_PATTERNS: the hot-link render
    // URLs (/tool/<id>.<ext>) are reachable by a top-level navigation and return
    // an image, which would be just as wrong under the shell key.
    const h = loadServiceWorker();
    h.server.set('/', 'APP_SHELL');
    h.server.set('/tool/qr-code.png', 'PNG_BYTES');
    await navigate(h, 'https://lolly.tools/');
    await navigate(h, 'https://lolly.tools/tool/qr-code.png');
    assert.equal(shellEntry(h), 'APP_SHELL',
      'an extension in the last path segment means it is not the SPA shell');
  });

  test('offline, a non-shell document gets the offline sentinel, not the app', async () => {
    const h = loadServiceWorker();
    h.server.set('/', 'APP_SHELL');
    await navigate(h, 'https://lolly.tools/');
    h.offline.value = true;
    assert.equal(await navigate(h, 'https://lolly.tools/tool/qr-code.png'), 'Offline',
      'answering a document request with the app shell is the same lie in reverse');
  });

  test('activate drops the previous generation, remediating an already-poisoned shell', async () => {
    const h = loadServiceWorker();
    const stale = new FakeCache();
    stale.entries.set('/', 'PRIVACY_POLICY_PAGE');   // what v11 installs are holding
    h.caches.set('lolly-v11', stale);
    h.caches.set('lolly-pins', new FakeCache());

    await h.activate();

    assert.ok(!h.caches.has('lolly-v11'), 'the poisoned generation must be deleted on activate');
    assert.ok(h.caches.has('lolly-pins'), 'the unversioned pin bucket must survive a generation bump');
  });
});
