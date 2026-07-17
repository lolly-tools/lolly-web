/**
 * Service worker — three strategies, chosen per request:
 *
 *   1. Navigations (the app shell document) → NETWORK-FIRST with a cached-shell
 *      fallback. A healthy network always serves the current deploy's HTML, so a
 *      new deploy is picked up on the next load. When the network fails (offline
 *      cold load), we serve the last cached shell instead, so the app still boots.
 *
 *   2. Immutable, content-hashed build assets (/assets/index-*.js, *.css) and the
 *      bundled variable fonts → CACHE-FIRST. Vite content-hashes these filenames,
 *      so a cached copy can never be stale: a new deploy emits new filenames that
 *      simply miss the cache and fetch fresh. This is what makes the offline cold
 *      load actually serve the app's JS/CSS — without the stale-chunk risk a
 *      precache-everything approach would create. (Fonts keep the same filename;
 *      a font swap propagates on the next CACHE bump.)
 *
 *   3. Tool files under /tools/ (template.html, styles.css, hooks.js, tool-local
 *      assets) → NETWORK-FIRST with a timeout race, so a deploy propagates
 *      immediately and a slow/dead connection still falls back to cache — first
 *      this generation's cache, then the separate PIN_CACHE bucket that holds
 *      tools the user pinned "available offline" (lib/offline-pins.ts).
 *
 *   4. Preview images + the preview-look bundle under /catalog/previews/ →
 *      STALE-WHILE-REVALIDATE: serve the cached copy instantly (no blocking
 *      network on repeat loads, and they work offline) while a background fetch
 *      freshens the cache for next time. Previews are regenerable, non-critical
 *      art (a one-load-stale thumbnail is harmless, and a stale look self-heals —
 *      preview-bundle.ts rejects a sig mismatch and live-renders), so unlike the
 *      catalog INDEX they don't need to be fetch-fresh. This is the repeat-visit
 *      request cut: dozens of preview + look-bundle requests become cache hits.
 *
 * The catalog INDEX files (/catalog/tools|assets/index.json) need fresh data, so
 * they still bypass the service worker entirely (checked after the previews path).
 *
 * Because hashed assets are immutable, the new SW claiming clients mid-session is
 * safe (it can't swap a running page's chunks), so no skipWaiting update-prompt
 * flow is needed.
 *
 * Bump CACHE on any change to this file to evict the previous generation's
 * entries on activate (a one-time clear of anything already gone stale).
 */

const CACHE = 'lolly-v11';

// Tools pinned "available offline": the page writes /tools/<id>/* copies into
// this SEPARATE, unversioned bucket (shells/web/src/lib/offline-pins.ts — keep
// the two literals in sync). Deliberately NOT tied to the CACHE generation:
// activate below never deletes it, so pins survive service-worker updates. The
// page owns its lifecycle (pin writes, unpin deletes); the fetch path only
// READS it, as the last-resort fallback for /tools/ requests.
const PIN_CACHE = 'lolly-pins';

// Stable key the app-shell document is cached under for the offline fallback.
// Every navigation (/, /pro, /tool/...) resolves to the same SPA index.html, so
// one canonical entry serves them all.
const SHELL_URL = '/';

// How long a tool-file fetch may run before we give up and serve cache instead.
// Long enough that a healthy connection always wins (fresh); short enough that a
// dead/flaky one fails over to cache without a painful stall.
const NETWORK_TIMEOUT_MS = 2500;

// Assets pre-cached on install so map tools work offline / after session restore.
// Offline-first: precache the app SHELL at install so a cold offline load works
// immediately (even before the first successful navigation caches it). We do NOT
// precache tool-specific libs — the old ~395 KB meeting-planner map bundle (d3 +
// countries-110m) was paid by every visitor on install regardless of ever opening
// that tool; it now caches network-first under /tools/ on first actual use, so
// meeting-planner still works offline for anyone who's opened it once online.
const PRECACHE_URLS = [
  SHELL_URL,
];

// The preview-look bundle — one small file that lets every example carousel + featured look
// render from cache instead of live-rendering on the client. Precached (best-effort, so a
// missing/404 bundle can't fail the atomic shell install) so it's ready before the first
// carousel hydrates on a return visit, and works offline.
const PREVIEW_BUNDLE_URL = '/catalog/previews/bundle.json';

// Preview images + the look bundle: stale-while-revalidate (see strategy #4). Matched BEFORE
// the /catalog/ bypass, exactly like /catalog/fonts/ above.
const PREVIEW_PATTERN = /^\/catalog\/previews\//;

// Cache-first: content-hashed Vite build output, plus the bundled variable fonts
// (stable filenames, effectively immutable — refreshed by a CACHE bump). Checked
// before CACHE_PATTERNS so fonts under /tools/ take this path, not network-first.
const IMMUTABLE_PATTERNS = [
  /^\/assets\//,
  // The app UI fonts (variable woff2) live under /catalog/fonts/ and are
  // preloaded on every page. Stable filenames → cache-first (refreshed by a CACHE
  // bump). Must be matched BEFORE the /catalog/ bypass below, so this list is
  // checked first in the fetch handler.
  /^\/catalog\/fonts\//,
];

// Network-first tool assets; let catalog + API requests pass through to network.
const CACHE_PATTERNS = [
  /^\/tools\//,
];

// TrustMark ONNX watermark-decoder models (/verify's "Deep scan for
// watermarks", tens of MB each) bypass the SW's own Cache Storage entirely —
// shells/web/src/lib/trustmark.ts fetches and caches the bytes itself in
// IndexedDB (mirroring the Google-Fonts fetch-once pattern), so letting the
// SW ALSO cache them here would just double the on-device copies for no
// benefit. Listed explicitly (rather than relying on falling through
// unmatched) so a future edit to CACHE_PATTERNS can't accidentally catch it.
const BYPASS_PATTERNS = [
  /^\/catalog\//,
  /^\/api\//,
  /^\/models\//,
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(async cache => {
      await cache.addAll(PRECACHE_URLS);                    // shell — atomic, must succeed
      await cache.add(PREVIEW_BUNDLE_URL).catch(() => {});  // best-effort, never fails install
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  // Remove caches from previous versions (never the pin bucket — see PIN_CACHE).
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== PIN_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Immutable hashed build assets + fonts: cache-first (safe — filenames are
  // content-hashed or stable). Checked BEFORE the bypass so /catalog/fonts/ is
  // cached rather than passed straight to network like the rest of /catalog/.
  if (IMMUTABLE_PATTERNS.some(p => p.test(url.pathname))) {
    event.respondWith(cacheFirst(event));
    return;
  }

  // Preview images + the look bundle under /catalog/previews/: stale-while-revalidate.
  // Checked BEFORE the /catalog/ bypass so they're cached (repeat loads = cache hits, and
  // offline), while the catalog INDEX just below still bypasses to stay fetch-fresh.
  if (PREVIEW_PATTERN.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }

  // Same-origin /api/ + /catalog/: always straight to the network — even for a
  // navigation. The CA OAuth popup NAVIGATES to /api/ca/auth/<provider>, which
  // must 302 to the provider; serving it the cached SPA shell (as the navigate
  // branch below would) lands the popup on the gallery and enrollment can never
  // start. Checked BEFORE the navigate branch for exactly that reason.
  if (BYPASS_PATTERNS.some(p => p.test(url.pathname))) return;

  // Navigations: network-first so a new deploy is picked up, with the cached
  // shell as the offline fallback (this is what enables the offline cold load).
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstDocument(event));
    return;
  }

  if (!CACHE_PATTERNS.some(p => p.test(url.pathname))) return;

  event.respondWith(networkFirst(event));
});

// Cache-first for immutable resources: serve the cached copy if present;
// otherwise fetch, cache an ok response, and return it.
async function cacheFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// Stale-while-revalidate for preview art: serve the cached copy immediately (fast, offline-
// capable) and kick off a background fetch that refreshes the cache for next time. With
// nothing cached yet, wait on the network. Only ok responses are cached, so a transient 404/
// 5xx never poisons the cache. Used for /catalog/previews/ (thumbnails + the look bundle) —
// regenerable art where one-load staleness is harmless, unlike the fetch-fresh catalog index.
async function staleWhileRevalidate(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(response => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network); // freshen in the background; don't block the response
    return cached;
  }
  return (await network) || new Response('Offline', { status: 503 });
}

// Network-first for the app-shell document: when online, ALWAYS serve (and re-cache)
// the current deploy's HTML, then fall back to the last cached shell only when the
// network actually fails (offline). This is deliberately NOT stale-while-revalidate:
// serving a one-deploy-stale shell is unsafe because the shell's module graph points
// at that build's content-hashed chunk names, and its LAZY chunks (the tool view, the
// profile view, …) were never cached during the session — so after a new deploy removes
// those files, the first navigation into a tool fetches a chunk that's gone and dies
// with "Failed to fetch dynamically imported module". Network-first eliminates that at
// the source; the cost is only the small HTML round-trip (the hashed JS/CSS it pulls
// stay cache-first, so first paint's heavy assets are still instant). Cold with no
// cache yet returns the 503 offline sentinel. (See also the vite:preloadError reload
// handler in main.ts, which recovers any client already holding a stale shell.)
async function networkFirstDocument(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) { cache.put(SHELL_URL, fresh.clone()); return fresh; }
    // Server reachable but unhappy (5xx) — a cached shell beats an error page.
    const cached = await cache.match(SHELL_URL);
    return cached || fresh;
  } catch {
    // Offline — serve the last good shell so the app still boots.
    const cached = await cache.match(SHELL_URL);
    return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

// Race the network against NETWORK_TIMEOUT_MS. A fresh, ok response wins and
// refreshes the cache. A timeout / network error / non-ok response falls back to
// the cached copy (keeping the in-flight fetch alive via waitUntil so the cache
// still freshens for next time). With nothing cached, return whatever the
// network ultimately gives, or a 503 if it never arrives.
async function networkFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);

  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });
  const network = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  const winner = await Promise.race([network, timeout]);
  clearTimeout(timer);
  if (winner && winner.ok) return winner;

  // Network lost the race (slow), failed, or returned non-ok → try this
  // generation's cache, then the pinned-tools bucket (a pinned tool must serve
  // even if it was never opened during this cache generation).
  const cached = await cache.match(request)
    || await caches.match(request, { cacheName: PIN_CACHE }).catch(() => undefined);
  if (cached) {
    event.waitUntil(network); // let the slow fetch finish and update the cache
    return cached;
  }
  return (await network) || new Response('Offline', { status: 503 });
}
