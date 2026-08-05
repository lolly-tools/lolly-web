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

/** Drive one request through the fetch handler and return the served body.
 *  Background work handed to waitUntil (cache freshens) is awaited too, so a
 *  test can assert on its effects. */
async function drive(h: Harness, url: string, mode: string): Promise<string | null> {
  const request = { method: 'GET', url, mode };
  // Held on an object, not a `let`: TypeScript's control-flow analysis cannot see
  // the assignment happen inside respondWith, so a local would narrow to `never`.
  const out: { responded: Promise<{ _body: string }> | null } = { responded: null };
  const background: Promise<unknown>[] = [];
  h.fetchHandler({ request, respondWith: (p: Promise<{ _body: string }>) => { out.responded = p; }, waitUntil: (p: Promise<unknown>) => background.push(p) });
  if (!out.responded) return null;   // handler declined → browser handles it (bypass)
  const body = (await out.responded)._body;
  await Promise.allSettled(background);
  return body;
}

/** Drive one navigation through the fetch handler and return the served body. */
const navigate = (h: Harness, url: string): Promise<string | null> => drive(h, url, 'navigate');
/** Drive one subresource request (a script/font/wasm fetch, not a navigation). */
const subresource = (h: Harness, url: string): Promise<string | null> => drive(h, url, 'no-cors');

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

  test('/info serves network-first and never populates the shell key', async () => {
    const h = loadServiceWorker();
    h.server.set('/', 'APP_SHELL');
    h.server.set('/info/using.html', 'USING_PAGE');
    await navigate(h, 'https://lolly.tools/');
    assert.equal(await navigate(h, 'https://lolly.tools/info/using.html'), 'USING_PAGE',
      'online, /info serves the live page');
    assert.equal(shellEntry(h), 'APP_SHELL',
      'an /info navigation must leave the shell key untouched');
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

  test('activate keeps every page-owned offline-download bucket', async () => {
    // The "Available offline" buckets (lib/offline-manager.ts) hold what the
    // user explicitly downloaded, and the speech buckets hold the ~92 MB
    // Kokoro model ('transformers-cache' — transformers.js's OWN bucket name)
    // plus the voice bins ('lolly-speech', lib/speech-kokoro-worker.ts) — a SW
    // deploy must never take any of them back. Before v14 the generation sweep
    // deleted the two speech buckets on every update.
    const KEEP = ['lolly-pins', 'lolly-app', 'lolly-ort', 'lolly-info', 'transformers-cache', 'lolly-speech'];
    const h = loadServiceWorker();
    for (const name of KEEP) h.caches.set(name, new FakeCache());
    h.caches.set('lolly-v11', new FakeCache());

    await h.activate();

    for (const name of KEEP) {
      assert.ok(h.caches.has(name), `${name} must survive a generation bump`);
    }
    assert.ok(!h.caches.has('lolly-v11'));
  });
});

describe('service worker: the offline-download buckets', () => {
  test('offline, a downloaded /info page serves from lolly-info, per URL', async () => {
    const h = loadServiceWorker();
    const info = new FakeCache();
    info.entries.set('/info/using.html', 'DOWNLOADED_USING_PAGE');
    info.entries.set('/info/index.html', 'DOWNLOADED_INDEX');
    h.caches.set('lolly-info', info);

    h.offline.value = true;
    assert.equal(await navigate(h, 'https://lolly.tools/info/using.html'), 'DOWNLOADED_USING_PAGE');
    assert.equal(await navigate(h, 'https://lolly.tools/info/'), 'DOWNLOADED_INDEX',
      'a directory URL must normalise to its index.html key');
    assert.equal(await navigate(h, 'https://lolly.tools/info/missing.html'), 'Offline',
      'a page that was never downloaded gets the sentinel, not a wrong page');
  });

  test('online, a successful /info fetch refreshes an already-downloaded copy in passing', async () => {
    const h = loadServiceWorker();
    const info = new FakeCache();
    info.entries.set('/info/using.html', 'STALE_DOWNLOAD');
    h.caches.set('lolly-info', info);
    h.server.set('/info/using.html', 'FRESH_PAGE');

    assert.equal(await navigate(h, 'https://lolly.tools/info/using.html'), 'FRESH_PAGE');
    assert.equal(info.entries.get('/info/using.html'), 'FRESH_PAGE',
      'the held copy must track the live site, not freeze at download time');
  });

  test('online, a page never downloaded is NOT hoarded into lolly-info', async () => {
    const h = loadServiceWorker();
    h.server.set('/info/using.html', 'USING_PAGE');
    await navigate(h, 'https://lolly.tools/info/using.html');
    assert.ok(!h.caches.get('lolly-info')?.entries.has('/info/using.html'),
      'only the explicit docs download decides what lives in the bucket');
  });

  test('/ort is cache-first from lolly-ort and self-populates on first use', async () => {
    const h = loadServiceWorker();
    h.server.set('/ort/ort-wasm-simd-threaded.wasm', 'WASM_BYTES');

    assert.equal(await subresource(h, 'https://lolly.tools/ort/ort-wasm-simd-threaded.wasm'), 'WASM_BYTES');
    h.offline.value = true;
    assert.equal(await subresource(h, 'https://lolly.tools/ort/ort-wasm-simd-threaded.wasm'), 'WASM_BYTES',
      'once fetched, the runtime must serve offline from its bucket');
  });

  test('/ort-hf (the speech worker\'s pinned transformers.js runtime) rides the same bucket', async () => {
    // The served path is versioned (/ort-hf/<onnxruntime-web version>/ —
    // scripts/copy-transformers-ort.ts), so a transformers.js upgrade is a
    // cache MISS instead of a stale wasm pinned forever. ORT_PATTERN is a
    // prefix match, so the versioned subdir must route exactly like /ort/.
    const h = loadServiceWorker();
    const url = 'https://lolly.tools/ort-hf/1.22.0-dev.20250409-89f8206ba4/ort-wasm-simd-threaded.jsep.wasm';
    h.server.set('/ort-hf/1.22.0-dev.20250409-89f8206ba4/ort-wasm-simd-threaded.jsep.wasm', 'HF_WASM_BYTES');

    assert.equal(await subresource(h, url), 'HF_WASM_BYTES');
    h.offline.value = true;
    assert.equal(await subresource(h, url), 'HF_WASM_BYTES',
      'the two runtimes are different builds but share lolly-ort cache-first behaviour');
  });

  test('the whole app group serves offline — not just /assets/: voice, viz-presets, share stubs', async () => {
    // Regression pin for the review finding that downloadApp filled lolly-app
    // with /voice/, /viz-presets/, /t/ etc. but no fetch-handler rule ever
    // read the bucket for those paths — "downloaded" yet unservable.
    const h = loadServiceWorker();
    const app = new FakeCache();
    app.entries.set('/voice/welcome.mp3', 'MP3_BYTES');
    app.entries.set('/viz-presets/stock.json', 'PRESETS');
    app.entries.set('/t/qr-code.html', 'SHARE_STUB');
    h.caches.set('lolly-app', app);

    h.offline.value = true;
    assert.equal(await subresource(h, 'https://lolly.tools/voice/welcome.mp3'), 'MP3_BYTES');
    assert.equal(await subresource(h, 'https://lolly.tools/viz-presets/stock.json'), 'PRESETS');
    assert.equal(await subresource(h, 'https://lolly.tools/t/qr-code.html'), 'SHARE_STUB');
  });

  test('online, the generic app fallback never intercepts or hoards the network copy', async () => {
    const h = loadServiceWorker();
    h.server.set('/viz-presets/stock.json', 'LIVE_PRESETS');
    assert.equal(await subresource(h, 'https://lolly.tools/viz-presets/stock.json'), 'LIVE_PRESETS');
    assert.ok(!h.caches.get('lolly-app')?.entries.has('/viz-presets/stock.json'),
      'only the explicit app download writes the bucket');
  });

  test('the shell cold-boots from the downloaded app bucket when the generation cache is empty', async () => {
    const h = loadServiceWorker();
    const app = new FakeCache();
    app.entries.set('/index.html', 'DOWNLOADED_SHELL');
    h.caches.set('lolly-app', app);

    h.offline.value = true;
    assert.equal(await navigate(h, 'https://lolly.tools/pro'), 'DOWNLOADED_SHELL',
      'an explicit "download the app" must survive a wiped/fresh CACHE generation');
  });

  test('offline, an extensionless /info locale URL resolves to its downloaded index.html', async () => {
    const h = loadServiceWorker();
    const info = new FakeCache();
    info.entries.set('/info/de/index.html', 'GERMAN_DOCS_INDEX');
    h.caches.set('lolly-info', info);

    h.offline.value = true;
    assert.equal(await navigate(h, 'https://lolly.tools/info/de'), 'GERMAN_DOCS_INDEX',
      '/info/de (no trailing slash) is how a typed locale URL arrives');
  });

  test('immutable assets fall back to the pre-downloaded lolly-app bucket', async () => {
    // A fresh CACHE generation is empty; a user who pre-downloaded the app must
    // still get every chunk and font offline.
    const h = loadServiceWorker();
    const app = new FakeCache();
    app.entries.set('https://lolly.tools/assets/lazy-view-abc123.js', 'CHUNK');
    app.entries.set('https://lolly.tools/fonts/Outfit-latin%5Bwght%5D.woff2', 'FONT');
    h.caches.set('lolly-app', app);

    h.offline.value = true;
    assert.equal(await subresource(h, 'https://lolly.tools/assets/lazy-view-abc123.js'), 'CHUNK');
    assert.equal(await subresource(h, 'https://lolly.tools/fonts/Outfit-latin%5Bwght%5D.woff2'), 'FONT',
      '/fonts/ must have an offline path — before v13 it had no rule at all');
  });
});

describe('precache.json grouping (vite.config.js)', () => {
  // The manifest groups are what offline-manager.ts downloads into the SW's
  // buckets, so their routing is SW behaviour by proxy: a file in the wrong
  // group lands in a bucket no fetch rule ever reads back. Regression pins for
  // the review findings that /ort-hf/ rode the `app` group (lolly-app can
  // never serve it — ORT_PATTERN routes /ort-hf/ to lolly-ort) and that
  // /models/kokoro/ inflated the verify part's models size by ~95 MB.
  const urls = [
    '/index.html',
    '/assets/index-abc123.js',
    '/fonts/Outfit-latin[wght].woff2',
    '/ort/ort-wasm-simd-threaded.wasm',
    '/ort/ort.min.mjs',
    '/ort-hf/1.22.0-dev.20250409-89f8206ba4/ort-wasm-simd-threaded.jsep.wasm',
    '/ort-hf/1.22.0-dev.20250409-89f8206ba4/ort-wasm-simd-threaded.mjs',
    '/models/trustmark/decoder_Q.onnx',
    '/models/kokoro/onnx/model_quantized.onnx',
    '/models/kokoro/voices/af_heart.bin',
    '/models/whisper/onnx/encoder_model_quantized.onnx',
    '/models/upscale/realesr-general-x4v3.onnx',
    '/models/matte/birefnet-lite.onnx',
  ];

  test('groups route each path to the bucket the SW actually serves it from', async () => {
    const { groupPrecacheFiles } = await import('../vite.config.js');
    const all = urls.map(url => ({ url, size: 1 }));
    const groups = groupPrecacheFiles(all);
    const names = (list: { url: string }[]) => list.map(f => f.url);

    assert.deepEqual(names(groups.app), ['/index.html', '/assets/index-abc123.js', '/fonts/Outfit-latin[wght].woff2'],
      'the app group must exclude /ort/, /ort-hf/ and /models/ — lolly-app never serves those');
    assert.deepEqual(names(groups.ort), [
      '/ort/ort-wasm-simd-threaded.wasm',
      '/ort-hf/1.22.0-dev.20250409-89f8206ba4/ort-wasm-simd-threaded.jsep.wasm',
      '/ort-hf/1.22.0-dev.20250409-89f8206ba4/ort-wasm-simd-threaded.mjs',
    ], 'the ort group is the ort-wasm-* files (wasm + mjs glue) of BOTH runtimes, and nothing else');
    assert.deepEqual(names(groups.models), ['/models/trustmark/decoder_Q.onnx'],
      'verify\'s models are the TrustMark ones only — kokoro belongs to the speech part');
    assert.deepEqual(names(groups.speech), [
      '/models/kokoro/onnx/model_quantized.onnx',
      '/models/kokoro/voices/af_heart.bin',
      '/models/whisper/onnx/encoder_model_quantized.onnx',
    ], 'the speech group is the kokoro + whisper model sets — nothing else');
    assert.deepEqual(names(groups.upscale), ['/models/upscale/realesr-general-x4v3.onnx'],
      'the upscale group is the AI-upscaler models only (host.upscale) — SW-bypassed like the others');
    assert.deepEqual(names(groups.matte), ['/models/matte/birefnet-lite.onnx'],
      'the matte group is the background-removal models only (host.matte) — SW-bypassed like the others');
  });

  test('release-versioned binaries are exempt from content hashing', async () => {
    const { precacheNeedsHash } = await import('../vite.config.js');
    assert.equal(precacheNeedsHash('/ort/ort-wasm-simd-threaded.wasm'), false);
    assert.equal(precacheNeedsHash('/ort-hf/1.22.0-dev.20250409-89f8206ba4/ort-wasm-simd-threaded.wasm'), false,
      '/ort-hf/ carries its version in the path, like /ort/ and /models/');
    assert.equal(precacheNeedsHash('/models/trustmark/decoder_Q.onnx'), false);
    assert.equal(precacheNeedsHash('/fonts/Outfit-latin[wght].woff2'), true,
      'stable-named files still need the hash to catch same-size content changes');
  });
});
