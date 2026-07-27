// SPDX-License-Identifier: MPL-2.0
/**
 * scrub-registry.ts — the tiny, synchronous, PREVIEW-ONLY half of the scrub
 * proxy feature (Fable timeline, phase 4 Track A).
 *
 * WHY IT IS ITS OWN MODULE. Two reasons, and the second is the load-bearing one:
 *
 *  1. WEIGHT. `bridge/assets.ts` needs exactly one function from the proxy
 *     feature on a hot synchronous path (`noteScrubSource`, called as each user
 *     asset's object URL is minted). assets.ts is in the first-paint graph, so a
 *     static import of `lib/clip-proxy.ts` dragged that whole module — including
 *     its `import('mediabunny')` site and its IndexedDB seam — into boot. This
 *     file is ~1 kB of maps and has no dependencies at all.
 *  2. OWNERSHIP. Everything here is memory-only and synchronous; everything in
 *     clip-proxy.ts is IO. Keeping the two apart is what lets the caches be
 *     bounded and revoked in one place, with no chance of a database round-trip
 *     hiding inside a cache eviction.
 *
 * THE NON-NEGOTIABLE RULE, restated because this is where it is enforced:
 * **EXPORT ALWAYS USES THE ORIGINAL.** `peekScrubUrl` is the only way to obtain a
 * proxy URL, it is reachable only from `lib/clip-thumbs.ts` (filmstrips and
 * waveforms), and `clip-proxy.test.ts` carries a whole-tree source guard that
 * fails if any other module ever imports either half of this feature.
 *
 * BOUNDS. Every map here is capped and oldest-out. A proxy object URL pins its
 * blob in memory for as long as it exists, so eviction REVOKES — a session that
 * touches fifty clips holds at most `PROXY_URL_LIMIT` of them, not fifty.
 */

/** Bound on the media-url → asset-id registry. */
export const SCRUB_REGISTRY_LIMIT = 256;
/**
 * Bound on live proxy object URLs. Each one pins a whole proxy blob (a 60 s proxy
 * is ~15 MB), so this is a memory ceiling, not a tidiness rule. 32 matches the
 * filmstrip cache's LRU: a bar whose URL was just evicted re-primes on its next
 * capture, which costs one IDB read.
 */
export const PROXY_URL_LIMIT = 32;
/** Bound on the "this asset has no proxy" memo. Purely to stop a long session growing it. */
export const NO_PROXY_LIMIT = 256;

/** media URL → asset id. The only way a URL-only consumer can reach an asset id. */
const scrubSources = new Map<string, string>();
/** asset id → { proxy object URL, does that proxy still carry an audio track }. */
const proxyUrls = new Map<string, { url: string; hasAudio: boolean }>();
/** asset ids known to have no proxy, so a hot scrub path stops re-querying IDB. */
const noProxy = new Set<string>();

/** Evict oldest-first until `map` is within `limit`, running `onEvict` for each. */
function trim<K, V>(map: Map<K, V>, limit: number, onEvict?: (v: V) => void): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    const value = map.get(oldest.value);
    map.delete(oldest.value);
    if (value !== undefined) onEvict?.(value);
  }
}

/** Record that `mediaUrl` resolves the asset `assetId`. Cheap and synchronous. */
export function noteScrubSource(mediaUrl: string, assetId: string): void {
  if (!mediaUrl || !assetId) return;
  // Delete-then-set even when the pairing is unchanged: a Map keeps insertion
  // order, so this is what moves a URL that is still in USE to the front. An
  // early return for the unchanged case would let an actively scrubbed clip be
  // evicted while a URL nobody has touched since page load survives.
  scrubSources.delete(mediaUrl);
  scrubSources.set(mediaUrl, assetId);
  trim(scrubSources, SCRUB_REGISTRY_LIMIT);
}

/** The asset id a media URL came from, if anyone registered it. */
export function scrubSourceId(mediaUrl: string): string | undefined {
  return scrubSources.get(mediaUrl);
}

/**
 * The URL a PREVIEW consumer should read, decided synchronously.
 *
 * Returns the proxy's object URL when one is already primed, otherwise the
 * original unchanged. Synchronous by design: the filmstrip/waveform entry points
 * have a same-tick cache hit path, and making them await a database round-trip on
 * every call would cost more than the proxy saves. `primeScrubUrl` warms it.
 *
 * `need.audio` is not a nicety. A proxy is transcoded into whichever container
 * the browser can encode, and an AAC source track cannot ride in WebM — so a
 * proxy may legitimately exist with its audio dropped. A waveform read off such a
 * proxy would be FLAT SILENCE against an export that mixes the real audio, which
 * is a lie in the UI. A caller that needs the audio asks for it and gets the
 * original whenever the proxy cannot answer.
 *
 * NEVER call this on an export path. See the module header.
 */
export function peekScrubUrl(mediaUrl: string, need: { audio?: boolean } = {}): string {
  const id = scrubSources.get(mediaUrl);
  if (!id) return mediaUrl;
  const hit = proxyUrls.get(id);
  if (!hit) return mediaUrl;
  if (need.audio && !hit.hasAudio) return mediaUrl;
  return hit.url;
}

/** Remember a freshly minted proxy object URL. Evicts + revokes the oldest if full. */
export function setProxyUrl(assetId: string, url: string, hasAudio: boolean): void {
  const prev = proxyUrls.get(assetId);
  if (prev && prev.url !== url) revoke(prev.url);
  proxyUrls.delete(assetId);
  proxyUrls.set(assetId, { url, hasAudio });
  noProxy.delete(assetId);
  trim(proxyUrls, PROXY_URL_LIMIT, (v) => revoke(v.url));
}

/** The primed proxy URL for an asset, if it is still resident. */
export function proxyUrlFor(assetId: string): string | undefined {
  return proxyUrls.get(assetId)?.url;
}

/** Remember that an asset has no proxy, so the hot path stops asking IndexedDB. */
export function markNoProxy(assetId: string): void {
  noProxy.add(assetId);
  while (noProxy.size > NO_PROXY_LIMIT) {
    const oldest = noProxy.values().next();
    if (oldest.done) break;
    noProxy.delete(oldest.value);
  }
}

/** Has this asset already been found to have no proxy? */
export function isKnownNoProxy(assetId: string): boolean {
  return noProxy.has(assetId);
}

/**
 * Forget the "no proxy" memo for an asset.
 *
 * Called the moment a proxy is successfully built. Without it the memo poisons
 * itself in exactly the case the feature exists for: a clip dropped on the
 * timeline while its idle transcode is still running answers "no proxy", and the
 * proxy that lands a few seconds later would be dead for the page's lifetime.
 */
export function clearNoProxy(assetId: string): void {
  noProxy.delete(assetId);
}

function revoke(url: string): void {
  try { URL.revokeObjectURL(url); } catch { /* already gone, or no URL API */ }
}

/** Revoke and forget one asset's proxy object URL (and its no-proxy memo). */
export function revokeProxyUrl(assetId: string): void {
  const hit = proxyUrls.get(assetId);
  if (hit) {
    revoke(hit.url);
    proxyUrls.delete(assetId);
  }
  noProxy.delete(assetId);
}

/** Drop every cached URL + registry entry (view teardown, tests). */
export function resetScrubCache(): void {
  for (const [, hit] of proxyUrls) revoke(hit.url);
  proxyUrls.clear();
  scrubSources.clear();
  noProxy.clear();
}
