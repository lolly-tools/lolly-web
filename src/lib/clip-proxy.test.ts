// SPDX-License-Identifier: MPL-2.0
/**
 * Tests for clip-proxy.ts — the import-time scrub proxies (phase 4 Track A).
 *
 * WHAT IS COVERED HERE (real module, real logic, injected seams — no mock theatre):
 *   • proxySkipReason / shouldBuildProxy — every threshold and its boundary, in
 *     the order that makes the reason stable
 *   • proxyDimensions — 720 long-edge clamp, aspect, even edges, passthrough
 *   • proxyKey / proxyMatchesSource — the key shape and the invalidation rule
 *   • ensureProxy — the whole contract against a FAKE converter and a FAKE store:
 *     reuse, staleness, force, skip, every failure path, quota-less environments,
 *     and the "never throws into the caller" promise on all of them
 *   • getProxy / deleteProxy / derivedMediaSize
 *   • the media-url → asset-id registry, peek/prime/dedup/eviction and reset
 *   • THE EXPORT GUARD — a source scan proving no export-path module can reach a
 *     proxy, and that the assets bridge imports only the lifecycle helpers
 *
 * WHAT IS **NOT** COVERED — browser-only, and a fake would prove nothing:
 *   • the actual mediabunny transcode (`Conversion` with `keyFrameInterval`) —
 *     it needs WebCodecs and a real encoder; that the output really carries a
 *     keyframe every ~0.5 s and really scrubs faster is a browser measurement
 *     (spec Track A's verify step: pointerdown→painted-frame in Safari)
 *   • `getFirstEncodableVideoCodec`'s answer on any given browser
 *   • the IndexedDB-backed ProxyStore (node has no indexedDB — the degraded
 *     "no database" path IS covered, since that is what node produces)
 *   • `navigator.storage.estimate()` quota refusal (node has no storage manager;
 *     the "cannot estimate → allow the write" branch is what runs here)
 *
 * TRACK A FOLLOW-UP, REPORTED NOT DONE (files owned by the concurrent phase-4.5
 * workflow this cycle). The filmstrip/waveform swap ships here; the *element*
 * swap does not. When those files are free, the change is:
 *   1. views/timeline-panel.ts `mediaOf()` and views/free-canvas.ts (wherever a
 *      clip's <video> is mounted): set `src` to `peekScrubUrl(url)` and, in the
 *      SAME edit, stamp `data-original-src="<original url>"` on the element.
 *   2. bridge/sequence-render.ts `mediaUrl(el)` (and any other export-side DOM
 *      read): prefer `el.getAttribute('data-original-src')` over
 *      `currentSrc || src`.
 * Step 2 MUST land with or before step 1 — sequence-render reads the live
 * element's `src` today with no original-vs-preview distinction, so swapping the
 * element first would silently export the proxy. Until then the element pool
 * scrubs the original, which is slower but always correct.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PROXY_LONG_EDGE,
  MIN_PROXY_DURATION_SEC,
  MIN_PROXY_BYTES,
  MIN_PROXY_LONG_EDGE,
  MAX_PROXY_SOURCE_BYTES,
  MAX_PROXY_DURATION_SEC,
  SCRUB_REGISTRY_LIMIT,
  proxyKey,
  proxyMatchesSource,
  proxySkipReason,
  shouldBuildProxy,
  proxyDimensions,
  ensureProxy,
  abortProxyBuilds,
  PROXY_DURATION_TOLERANCE_SEC,
  getProxy,
  deleteProxy,
  derivedMediaSize,
  setProxyStore,
  setProxyConverter,
  noteScrubSource,
  scrubSourceId,
  peekScrubUrl,
  primeScrubUrl,
  revokeProxyUrl,
  resetScrubCache,
  type ProxyRecord,
  type ProxyStore,
  type ProxyConverter,
} from './clip-proxy.ts';

// ── fakes (state holders, not behaviour stand-ins) ──────────────────────────

interface FakeStore extends ProxyStore {
  rows: Map<string, ProxyRecord>;
  gets: number;
  puts: number;
  deletes: number;
}

function fakeStore(opts: { failGet?: boolean; failPut?: boolean } = {}): FakeStore {
  const rows = new Map<string, ProxyRecord>();
  const s: FakeStore = {
    rows, gets: 0, puts: 0, deletes: 0,
    async get(key) {
      s.gets++;
      if (opts.failGet) throw new Error('idb read exploded');
      return rows.get(key);
    },
    async put(rec) {
      s.puts++;
      if (opts.failPut) throw new Error('idb write exploded');
      rows.set(rec.key, rec);
    },
    async delete(key) { s.deletes++; rows.delete(key); },
    async all() { return [...rows.values()]; },
  };
  return s;
}

interface FakeConverter extends ProxyConverter {
  probes: number;
  converts: number;
  lastPlan: { width: number; height: number } | null;
}

function fakeConverter(cfg: {
  probe?: { durationSec: number; width: number; height: number; hasAudio?: boolean } | null;
  probeThrows?: boolean;
  out?: Blob | null;
  /** The proxy's OWN measured duration. Defaults to the source's (a healthy transcode). */
  outDurationSec?: number;
  /** Did the transcode keep an audio track? */
  outHasAudio?: boolean;
  convertThrows?: boolean;
  /** Resolves only once `release()` is called — for the serialisation test. */
  gate?: { promise: Promise<void> };
} = {}): FakeConverter {
  const c: FakeConverter = {
    probes: 0, converts: 0, lastPlan: null,
    async probe() {
      c.probes++;
      if (cfg.probeThrows) throw new Error('unreadable container');
      return cfg.probe === undefined ? { durationSec: 30, width: 1920, height: 1080, hasAudio: true } : cfg.probe;
    },
    async convert(_src, plan) {
      c.converts++;
      c.lastPlan = plan;
      if (cfg.gate) await cfg.gate.promise;
      if (cfg.convertThrows) throw new Error('encoder refused');
      const blob = cfg.out === undefined ? blobOf(1000) : cfg.out;
      if (!blob) return null;
      return {
        blob,
        durationSec: cfg.outDurationSec ?? (cfg.probe?.durationSec ?? 30),
        hasAudio: cfg.outHasAudio ?? true,
      };
    },
  };
  return c;
}

const blobOf = (bytes: number): Blob => new Blob([new Uint8Array(bytes)], { type: 'video/webm' });

/** A source that is comfortably inside every threshold. */
const GOOD_SOURCE = blobOf(6 * 1024 * 1024);

function reset(store: FakeStore | null, converter: FakeConverter | null): void {
  setProxyStore(store);
  setProxyConverter(converter);
  resetScrubCache();
}

// ── the skip ladder ─────────────────────────────────────────────────────────

const probeOf = (over: Partial<{ bytes: number; durationSec: number; width: number; height: number }> = {}) => ({
  bytes: 6 * 1024 * 1024, durationSec: 30, width: 1920, height: 1080, ...over,
});

test('proxySkipReason: a typical phone/screen-recording upload is worth a proxy', () => {
  assert.equal(proxySkipReason(probeOf()), null);
  assert.equal(shouldBuildProxy(probeOf()), true);
});

test('proxySkipReason: short clips are skipped, at the boundary', () => {
  assert.equal(proxySkipReason(probeOf({ durationSec: MIN_PROXY_DURATION_SEC - 0.01 })), 'too-short');
  assert.equal(proxySkipReason(probeOf({ durationSec: MIN_PROXY_DURATION_SEC })), null);
});

test('proxySkipReason: small files are skipped, at the boundary', () => {
  assert.equal(proxySkipReason(probeOf({ bytes: MIN_PROXY_BYTES - 1 })), 'too-small');
  assert.equal(proxySkipReason(probeOf({ bytes: MIN_PROXY_BYTES })), null);
});

test('proxySkipReason: low-resolution sources are skipped on their LONG edge', () => {
  // 480x854 portrait: the long edge is 854, so this is NOT low-res.
  assert.equal(proxySkipReason(probeOf({ width: 480, height: 854 })), null);
  assert.equal(proxySkipReason(probeOf({ width: 320, height: MIN_PROXY_LONG_EDGE - 1 })), 'too-low-res');
  assert.equal(proxySkipReason(probeOf({ width: 320, height: MIN_PROXY_LONG_EDGE })), null);
});

test('proxySkipReason: the defensive ceilings win over every other reason', () => {
  // Oversized AND short — the ceiling is reported, so a huge file is never
  // reclassified as a cheap skip and silently reconsidered later.
  assert.equal(proxySkipReason(probeOf({ bytes: MAX_PROXY_SOURCE_BYTES + 1, durationSec: 1 })), 'too-large');
  assert.equal(proxySkipReason(probeOf({ durationSec: MAX_PROXY_DURATION_SEC + 1 })), 'too-long');
});

test('proxySkipReason: garbage measurements are "unreadable", never a build', () => {
  for (const bad of [
    probeOf({ bytes: 0 }),
    probeOf({ bytes: Number.NaN }),
    probeOf({ durationSec: 0 }),
    probeOf({ durationSec: Number.POSITIVE_INFINITY }),
    probeOf({ width: 0 }),
    probeOf({ height: Number.NaN }),
  ]) {
    assert.equal(proxySkipReason(bad), 'unreadable');
    assert.equal(shouldBuildProxy(bad), false);
  }
});

// ── dimensions ──────────────────────────────────────────────────────────────

test('proxyDimensions: the LONG edge is what gets clamped, either orientation', () => {
  // Orientation-independent by design: a portrait phone clip must shrink by the
  // same rule as a landscape screen recording, so the cap is on max(w,h).
  assert.deepEqual(proxyDimensions(1920, 1080), { width: PROXY_LONG_EDGE, height: 406 });
  assert.deepEqual(proxyDimensions(1080, 1920), { width: 406, height: PROXY_LONG_EDGE });
  assert.deepEqual(proxyDimensions(4096, 4096), { width: PROXY_LONG_EDGE, height: PROXY_LONG_EDGE });
});

test('proxyDimensions: a source already at or under the target is untouched', () => {
  assert.deepEqual(proxyDimensions(640, 360), { width: 640, height: 360 });
  assert.deepEqual(proxyDimensions(PROXY_LONG_EDGE, 400), { width: PROXY_LONG_EDGE, height: 400 });
});

test('proxyDimensions: both edges come back even and non-zero', () => {
  for (const [w, h] of [[1921, 1081], [999, 333], [3, 1], [1, 1]] as const) {
    const d = proxyDimensions(w, h);
    assert.equal(d.width % 2, 0, `${w}x${h} width`);
    assert.equal(d.height % 2, 0, `${w}x${h} height`);
    assert.ok(d.width >= 2 && d.height >= 2);
  }
});

test('proxyDimensions: degenerate input still yields a usable box', () => {
  assert.deepEqual(proxyDimensions(0, 0), { width: PROXY_LONG_EDGE, height: PROXY_LONG_EDGE });
  assert.deepEqual(proxyDimensions(Number.NaN, 100), { width: PROXY_LONG_EDGE, height: PROXY_LONG_EDGE });
});

// ── key + invalidation ──────────────────────────────────────────────────────

test('proxyKey: one row per asset, so a rebuild overwrites instead of orphaning', () => {
  assert.equal(proxyKey('user/upload/123-clip.mp4'), 'user/upload/123-clip.mp4:proxy');
  assert.notEqual(proxyKey('a'), proxyKey('b'));
});

test('proxyMatchesSource: byte length is the fingerprint; unknown means accept', () => {
  const rec = { srcBytes: 4242 };
  assert.equal(proxyMatchesSource(rec, 4242), true);
  assert.equal(proxyMatchesSource(rec, 4243), false);
  assert.equal(proxyMatchesSource(rec, undefined), true);
  assert.equal(proxyMatchesSource(rec, Number.NaN), true);
});

// ── ensureProxy ─────────────────────────────────────────────────────────────

test('ensureProxy: builds, stores, and returns the proxy for a worthwhile clip', async () => {
  const store = fakeStore();
  const conv = fakeConverter();
  reset(store, conv);

  const out = await ensureProxy('user/upload/1-a.mp4', GOOD_SOURCE);
  assert.ok(out, 'a proxy blob comes back');
  assert.equal(conv.converts, 1);
  assert.deepEqual(conv.lastPlan, { width: PROXY_LONG_EDGE, height: 406 });

  const rec = store.rows.get('user/upload/1-a.mp4:proxy');
  assert.ok(rec);
  assert.equal(rec.assetId, 'user/upload/1-a.mp4');
  assert.equal(rec.kind, 'proxy');
  assert.equal(rec.srcBytes, GOOD_SOURCE.size);
  assert.equal(rec.w, PROXY_LONG_EDGE);
  assert.equal(rec.h, 406);
  assert.ok(rec.createdAt > 0);
});

test('ensureProxy: an existing matching row is reused — no second transcode', async () => {
  const store = fakeStore();
  const conv = fakeConverter();
  reset(store, conv);

  await ensureProxy('user/x', GOOD_SOURCE);
  assert.equal(conv.converts, 1);
  const again = await ensureProxy('user/x', GOOD_SOURCE);
  assert.ok(again);
  assert.equal(conv.converts, 1, 'the cached row short-circuits the converter');
  assert.equal(conv.probes, 1, 'and the probe too');
});

test('ensureProxy: a row built from different bytes is dropped and rebuilt', async () => {
  const store = fakeStore();
  const conv = fakeConverter();
  reset(store, conv);

  await ensureProxy('user/x', GOOD_SOURCE);
  const replaced = blobOf(GOOD_SOURCE.size + 1024);
  const out = await ensureProxy('user/x', replaced);

  assert.ok(out);
  assert.equal(conv.converts, 2, 'the stale proxy was not served');
  assert.equal(store.deletes, 1, 'and it was evicted before the rebuild');
  assert.equal(store.rows.get('user/x:proxy')?.srcBytes, replaced.size);
});

test('ensureProxy: force rebuilds even when a matching row exists', async () => {
  const store = fakeStore();
  const conv = fakeConverter();
  reset(store, conv);

  await ensureProxy('user/x', GOOD_SOURCE);
  await ensureProxy('user/x', GOOD_SOURCE, { force: true });
  assert.equal(conv.converts, 2);
});

test('ensureProxy: a skipped source is never transcoded and never stored', async () => {
  const store = fakeStore();
  const conv = fakeConverter({ probe: { durationSec: 3, width: 1920, height: 1080 } });
  reset(store, conv);

  const logged: string[] = [];
  const out = await ensureProxy('user/short', GOOD_SOURCE, { log: (_l, m) => { logged.push(m); } });
  assert.equal(out, null);
  assert.equal(conv.converts, 0);
  assert.equal(store.puts, 0);
  assert.ok(logged.some(m => m.includes('too-short')), 'the reason is stated, not swallowed');
});

test('ensureProxy: the caller hint skips the container probe entirely', async () => {
  const store = fakeStore();
  const conv = fakeConverter();
  reset(store, conv);

  await ensureProxy('user/x', GOOD_SOURCE, { hint: { durationSec: 30, width: 1920, height: 1080 } });
  assert.equal(conv.probes, 0, 'ingest already measured this — do not walk the container twice');
  assert.equal(conv.converts, 1);
});

test('ensureProxy: a PARTIAL hint still falls back to the real probe', async () => {
  const store = fakeStore();
  const conv = fakeConverter();
  reset(store, conv);

  await ensureProxy('user/x', GOOD_SOURCE, { hint: { durationSec: 30 } });
  assert.equal(conv.probes, 1);
});

test('ensureProxy: every failure resolves null instead of throwing', async () => {
  const cases: Array<[string, FakeConverter | null, FakeStore]> = [
    ['probe throws', fakeConverter({ probeThrows: true }), fakeStore()],
    ['probe unreadable', fakeConverter({ probe: null }), fakeStore()],
    ['convert throws', fakeConverter({ convertThrows: true }), fakeStore()],
    ['convert declines', fakeConverter({ out: null }), fakeStore()],
    ['empty output', fakeConverter({ out: blobOf(0) }), fakeStore()],
    ['store read throws', fakeConverter({ probe: { durationSec: 3, width: 100, height: 100 } }), fakeStore({ failGet: true })],
  ];
  for (const [name, conv, store] of cases) {
    reset(store, conv);
    const out = await ensureProxy('user/x', GOOD_SOURCE, { log: () => {} });
    assert.equal(out, null, name);
    assert.equal(store.rows.size, 0, `${name}: nothing was stored`);
  }
});

test('ensureProxy: a store read that throws does not stop the build', async () => {
  const store = fakeStore({ failGet: true });
  const conv = fakeConverter();
  reset(store, conv);
  const out = await ensureProxy('user/x', GOOD_SOURCE, { log: () => {} });
  assert.ok(out, 'a broken cache read degrades to "build it"');
});

test('ensureProxy: a store write that throws still hands the caller its proxy', async () => {
  const store = fakeStore({ failPut: true });
  const conv = fakeConverter();
  reset(store, conv);
  const out = await ensureProxy('user/x', GOOD_SOURCE, { log: () => {} });
  assert.ok(out, 'built but unstored is still usable right now');
  assert.equal(store.rows.size, 0);
});

test('ensureProxy: a proxy no smaller than its source is discarded', async () => {
  const store = fakeStore();
  const conv = fakeConverter({ out: blobOf(GOOD_SOURCE.size) });
  reset(store, conv);
  const logged: string[] = [];
  const out = await ensureProxy('user/x', GOOD_SOURCE, { log: (_l, m) => { logged.push(m); } });
  assert.equal(out, null, 'same decode cost plus extra bytes is a worse deal on every axis');
  assert.equal(store.puts, 0);
  assert.ok(logged.some(m => m.includes('not smaller')));
});

test('ensureProxy: nonsense arguments are refused before anything is opened', async () => {
  const store = fakeStore();
  const conv = fakeConverter();
  reset(store, conv);
  assert.equal(await ensureProxy('', GOOD_SOURCE), null);
  assert.equal(await ensureProxy('user/x', blobOf(0)), null);
  assert.equal(conv.probes + conv.converts + store.gets, 0);
});

test('ensureProxy: with no database at all it still builds and returns (nothing stored)', async () => {
  // setProxyStore(null) restores the REAL IndexedDB-backed store, which cannot
  // open under node — the genuine "degraded environment" path, not a fake.
  const conv = fakeConverter();
  reset(null, conv);
  const out = await ensureProxy('user/x', GOOD_SOURCE, { log: () => {} });
  assert.ok(out);
  assert.equal(conv.converts, 1);
});

// ── read + evict ────────────────────────────────────────────────────────────

test('getProxy / deleteProxy / derivedMediaSize over the store', async () => {
  const store = fakeStore();
  reset(store, fakeConverter());

  assert.equal(await getProxy('user/x'), null, 'nothing stored yet');
  assert.equal(await derivedMediaSize(), 0);

  await ensureProxy('user/x', GOOD_SOURCE);
  await ensureProxy('user/y', GOOD_SOURCE);

  const got = await getProxy('user/x');
  assert.ok(got);
  assert.equal(await derivedMediaSize(), 2000, 'the meter sees both derived blobs');

  // A source-size mismatch reads as "no proxy" without deleting anything.
  assert.equal(await getProxy('user/x', GOOD_SOURCE.size + 1), null);
  assert.ok(await getProxy('user/x', GOOD_SOURCE.size));

  await deleteProxy('user/x');
  assert.equal(await getProxy('user/x'), null);
  assert.equal(await derivedMediaSize(), 1000);
});

test('getProxy / derivedMediaSize never throw when the store is broken', async () => {
  reset(fakeStore({ failGet: true }), fakeConverter());
  assert.equal(await getProxy('user/x'), null);
  await deleteProxy('user/x'); // must not reject
});

// ── the preview-side URL registry ───────────────────────────────────────────

test('noteScrubSource / scrubSourceId: the url→id pairing round-trips', () => {
  reset(fakeStore(), fakeConverter());
  noteScrubSource('blob:https://x/aaa', 'user/upload/1');
  assert.equal(scrubSourceId('blob:https://x/aaa'), 'user/upload/1');
  assert.equal(scrubSourceId('blob:https://x/unknown'), undefined);
});

test('noteScrubSource: the registry is bounded, oldest out', () => {
  reset(fakeStore(), fakeConverter());
  for (let i = 0; i < SCRUB_REGISTRY_LIMIT + 10; i++) noteScrubSource(`blob:${i}`, `user/${i}`);
  assert.equal(scrubSourceId('blob:0'), undefined, 'the oldest entries were dropped');
  assert.equal(scrubSourceId(`blob:${SCRUB_REGISTRY_LIMIT + 9}`), `user/${SCRUB_REGISTRY_LIMIT + 9}`);
});

test('noteScrubSource: ignores empty arguments and re-registration is a no-op', () => {
  reset(fakeStore(), fakeConverter());
  noteScrubSource('', 'user/1');
  noteScrubSource('blob:a', '');
  assert.equal(scrubSourceId(''), undefined);
  noteScrubSource('blob:a', 'user/1');
  noteScrubSource('blob:a', 'user/1');
  assert.equal(scrubSourceId('blob:a'), 'user/1');
});

test('peekScrubUrl: returns the ORIGINAL until a proxy is primed', async () => {
  const store = fakeStore();
  reset(store, fakeConverter());
  noteScrubSource('blob:a', 'user/x');

  assert.equal(peekScrubUrl('blob:a'), 'blob:a', 'unknown/unprimed → unchanged');
  assert.equal(peekScrubUrl('blob:unregistered'), 'blob:unregistered');

  await ensureProxy('user/x', GOOD_SOURCE);
  assert.equal(peekScrubUrl('blob:a'), 'blob:a', 'a stored proxy is still not used until primed');

  const primed = await primeScrubUrl('blob:a');
  assert.ok(primed);
  assert.notEqual(primed, 'blob:a');
  assert.equal(peekScrubUrl('blob:a'), primed, 'and now the swap is live');
});

test('primeScrubUrl: N concurrent callers cause ONE store read', async () => {
  const store = fakeStore();
  reset(store, fakeConverter());
  noteScrubSource('blob:a', 'user/x');
  await ensureProxy('user/x', GOOD_SOURCE);
  const before = store.gets;

  const all = await Promise.all([primeScrubUrl('blob:a'), primeScrubUrl('blob:a'), primeScrubUrl('blob:a')]);
  assert.equal(new Set(all).size, 1, 'everyone gets the same object URL');
  assert.equal(store.gets - before, 1);
});

test('primeScrubUrl: "there is no proxy" is remembered, not re-queried', async () => {
  const store = fakeStore();
  reset(store, fakeConverter());
  noteScrubSource('blob:a', 'user/none');

  assert.equal(await primeScrubUrl('blob:a'), null);
  const after = store.gets;
  assert.equal(await primeScrubUrl('blob:a'), null);
  assert.equal(store.gets, after, 'the negative answer is cached — scrub is a hot path');
  assert.equal(peekScrubUrl('blob:a'), 'blob:a');
});

test('primeScrubUrl: an unregistered URL resolves null without touching the store', async () => {
  const store = fakeStore();
  reset(store, fakeConverter());
  assert.equal(await primeScrubUrl('blob:nobody'), null);
  assert.equal(store.gets, 0);
});

test('revokeProxyUrl / resetScrubCache: the swap is undone and the registry cleared', async () => {
  const store = fakeStore();
  reset(store, fakeConverter());
  noteScrubSource('blob:a', 'user/x');
  await ensureProxy('user/x', GOOD_SOURCE);
  await primeScrubUrl('blob:a');
  assert.notEqual(peekScrubUrl('blob:a'), 'blob:a');

  revokeProxyUrl('user/x');
  assert.equal(peekScrubUrl('blob:a'), 'blob:a', 'back to the original');

  await primeScrubUrl('blob:a');
  resetScrubCache();
  assert.equal(scrubSourceId('blob:a'), undefined);
  assert.equal(peekScrubUrl('blob:a'), 'blob:a');
});

test('deleteProxy also revokes the live object URL, so nothing keeps scrubbing a deleted clip', async () => {
  const store = fakeStore();
  reset(store, fakeConverter());
  noteScrubSource('blob:a', 'user/x');
  await ensureProxy('user/x', GOOD_SOURCE);
  await primeScrubUrl('blob:a');
  assert.notEqual(peekScrubUrl('blob:a'), 'blob:a');

  await deleteProxy('user/x');
  assert.equal(peekScrubUrl('blob:a'), 'blob:a');
  assert.equal(await getProxy('user/x'), null);
});

// ── output acceptance, serialisation and cancellation ───────────────────────

test('a proxy that ended EARLY is discarded, not stored', async () => {
  // Truncation is silent (phase 3 rule 7): a transcode that stops early yields a
  // clean, complete-looking short container. Stored, it would spread a 30 s clip's
  // first four seconds across the whole filmstrip bar with no error anywhere.
  const store = fakeStore();
  const logged: string[] = [];
  reset(store, fakeConverter({ outDurationSec: 4 }));
  const out = await ensureProxy('user/short', GOOD_SOURCE, { log: (_l, m) => logged.push(m) });
  assert.equal(out, null, 'a short proxy is worse than no proxy');
  assert.equal(store.rows.size, 0, 'and it is never written');
  assert.ok(logged.some(m => /ended early/.test(m)), 'the reason is stated');
  reset(null, null);
});

test('a proxy within the duration tolerance is accepted', async () => {
  const store = fakeStore();
  reset(store, fakeConverter({ outDurationSec: 30 - PROXY_DURATION_TOLERANCE_SEC / 2 }));
  assert.ok(await ensureProxy('user/ok', GOOD_SOURCE), 'a hair short is a re-container, not a truncation');
  assert.equal(store.rows.size, 1);
  reset(null, null);
});

test('a converter that cannot measure its own output is trusted (no regression)', async () => {
  const store = fakeStore();
  reset(store, fakeConverter({ outDurationSec: 0 }));
  assert.ok(await ensureProxy('user/unmeasured', GOOD_SOURCE));
  assert.equal(store.rows.size, 1, '0 means "unmeasured", never "zero seconds long"');
  reset(null, null);
});

test('a transcode that DROPPED the audio track is stored, and says so', async () => {
  // Storing it is right — the pictures are still the point — but the fact has to
  // travel, so a waveform read can refuse the swap. See scrub-registry.test.ts.
  const store = fakeStore();
  reset(store, fakeConverter({ outHasAudio: false }));
  await ensureProxy('user/aac', GOOD_SOURCE);
  const rec = store.rows.get(proxyKey('user/aac'))!;
  assert.equal(rec.hasAudio, false);
  reset(null, null);
});

test('builds are SERIALISED: a burst of uploads never transcodes concurrently', async () => {
  // An idle callback is not a concurrency limit. Five dropped files would open
  // five decoder/encoder pairs and five whole output buffers in the same idle
  // period — the exact thing the idle scheduling was supposed to prevent.
  const store = fakeStore();
  let release: () => void = () => {};
  const gate = { promise: new Promise<void>((r) => { release = r; }) };
  const conv = fakeConverter({ gate });
  reset(store, conv);

  const all = Promise.all([0, 1, 2, 3, 4].map(i => ensureProxy(`user/burst${i}`, GOOD_SOURCE)));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(conv.converts, 1, 'exactly one transcode is in flight while the first is blocked');
  release();
  await all;
  assert.equal(conv.converts, 5, 'and the rest ran, in turn');
  reset(null, null);
});

test('a build can be cancelled, and a cancelled one stores nothing', async () => {
  const store = fakeStore();
  let release: () => void = () => {};
  const gate = { promise: new Promise<void>((r) => { release = r; }) };
  reset(store, fakeConverter({ gate }));

  const ctl = new AbortController();
  const p = ensureProxy('user/long', GOOD_SOURCE, { signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 5));
  ctl.abort();
  release();
  assert.equal(await p, null, 'a cancelled build resolves null — it never throws into its caller');
  assert.equal(store.rows.size, 0);
  reset(null, null);
});

test('abortProxyBuilds cancels everything queued behind it', async () => {
  const store = fakeStore();
  let release: () => void = () => {};
  const gate = { promise: new Promise<void>((r) => { release = r; }) };
  reset(store, fakeConverter({ gate }));
  const p = Promise.all([ensureProxy('user/q1', GOOD_SOURCE), ensureProxy('user/q2', GOOD_SOURCE)]);
  await new Promise((r) => setTimeout(r, 5));
  abortProxyBuilds();
  release();
  assert.deepEqual(await p, [null, null]);
  assert.equal(store.rows.size, 0, 'navigating away must not leave a transcode running to completion');
  reset(null, null);
});

test('a proxy that lands AFTER a "no proxy" answer is still picked up', async () => {
  // The negative-cache poisoning bug, end to end: a clip dropped on the timeline
  // while its idle transcode runs asks first, is told "none", and would otherwise
  // never use the proxy that arrives seconds later for the rest of the session.
  const store = fakeStore();
  reset(store, fakeConverter());
  noteScrubSource('blob:late', 'user/late');

  assert.equal(await primeScrubUrl('blob:late'), null, 'no proxy yet');
  assert.equal(peekScrubUrl('blob:late'), 'blob:late');

  await ensureProxy('user/late', GOOD_SOURCE);
  const url = await primeScrubUrl('blob:late');
  assert.ok(url, 'the memo was cleared when the proxy landed');
  assert.equal(peekScrubUrl('blob:late'), url);
  reset(null, null);
});

// ── THE EXPORT GUARD ────────────────────────────────────────────────────────
//
// The one rule that cannot be allowed to rot: a proxy is a lossy, downscaled
// re-encode and must never reach an exported frame. It is enforced structurally
// — the export path has no way to name a proxy — so the guard is a source scan.
// If one of these fails, do not "fix" the test: an export just became lossy.

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, '..');
const read = (rel: string): string => readFileSync(join(webSrc, rel), 'utf8');

/**
 * Every module allowed to mention the proxy feature, and what it is allowed to
 * use it FOR.
 *
 * INVERTED ON PURPOSE. The previous version of this guard listed the export-path
 * files and asserted they were clean — which is a guard that passes by default
 * for any file nobody remembered to add, and it had already missed
 * `bridge/video-encode.worker.ts` (a module that emits exported bytes) before
 * `bridge/sequence-render.worker.ts` existed at all. This walks the WHOLE tree
 * instead: any file that mentions the feature and is not on this list fails, so a
 * new export module is a failure by construction rather than by remembering.
 */
const PROXY_CONSUMERS: Record<string, string> = {
  'lib/clip-proxy.ts': 'the feature itself',
  'lib/clip-proxy.test.ts': 'this file',
  'lib/scrub-registry.ts': 'the synchronous half of the feature',
  'lib/scrub-registry.test.ts': 'its tests',
  'lib/clip-thumbs.ts': 'THE preview consumer — filmstrips and waveforms',
  'bridge/assets.ts': 'lifecycle only: register the url→id pairing, evict on delete',
  'views/picker.ts': 'schedules the build at ingest',
  'views/profile.ts': 'storage meter + clear cache',
  'bridge/db.ts': 'comments only: it declares the derived-media store the proxies live in',
};

/** Every .ts under shells/web/src, repo-relative to it. */
function everySource(dir = webSrc, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...everySource(join(dir, e.name), rel));
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/** The symbols by which a module could obtain, or cause, a proxy URL. */
const PROXY_SYMBOLS = [
  'clip-proxy', 'scrub-registry', 'peekScrubUrl', 'primeScrubUrl',
  'ensureProxy', 'getProxy', 'scrubSourceId', 'noteScrubSource',
];

test('GUARD: NOTHING outside the declared consumers can reach a proxy', () => {
  const offenders: string[] = [];
  for (const rel of everySource()) {
    if (rel in PROXY_CONSUMERS) continue;
    const src = read(rel);
    const hit = PROXY_SYMBOLS.find(sym => src.includes(sym));
    if (hit) offenders.push(`${rel} (mentions ${hit})`);
  }
  assert.deepEqual(offenders, [],
    'a proxy is a lossy downscaled re-encode: if a new module needs it, it must be declared here AND proven not to be on an export path');
});

test('GUARD: every declared consumer still exists and still uses it', () => {
  // The other half of set-equality: a stale allowlist entry is how a guard quietly
  // stops guarding anything.
  const all = new Set(everySource());
  for (const rel of Object.keys(PROXY_CONSUMERS)) {
    assert.ok(all.has(rel), `${rel} is on the proxy allowlist but no longer exists`);
    assert.ok(PROXY_SYMBOLS.some(sym => read(rel).includes(sym)), `${rel} no longer touches the proxy feature — drop it from the allowlist`);
  }
});

test('GUARD: the executors that produce exported bytes are clean', () => {
  // Named explicitly as well as covered by the sweep above, because these are the
  // files where a leak would actually corrupt a deliverable — including the two
  // WORKERS, which the old allowlist-shaped guard did not know about.
  for (const rel of [
    'bridge/export.ts', 'bridge/sequence-render.ts', 'bridge/sequence-render.worker.ts',
    'bridge/sequence-providers.ts', 'bridge/sequence-cuts.ts', 'bridge/sequence-dom.ts',
    'bridge/video-encode-core.ts', 'bridge/video-encode.ts', 'bridge/video-encode.worker.ts',
  ]) {
    assert.ok(!(rel in PROXY_CONSUMERS), `${rel} must never be an allowed proxy consumer`);
    const src = read(rel);
    for (const sym of PROXY_SYMBOLS) {
      assert.ok(!src.includes(sym), `${rel} must not reference ${sym} — export always uses the original`);
    }
  }
});

test('GUARD: the assets bridge wires lifecycle ONLY, and never proxy resolution', () => {
  const src = read('bridge/assets.ts');
  // The synchronous registry is the only STATIC import (it is also what keeps
  // clip-proxy — and the mediabunny import site inside it — out of first paint).
  const m = src.match(/import \{([^}]*)\} from '\.\.\/lib\/scrub-registry\.ts';/);
  assert.ok(m, 'assets.ts is expected to register the url→id pairing');
  const named = m[1]!.split(',').map(x => x.trim()).filter(Boolean).sort();
  assert.deepEqual(named, ['noteScrubSource'],
    'asset RESOLUTION must never be able to return a proxy — only registration belongs here');
  assert.ok(!/^import .*clip-proxy/m.test(src),
    'clip-proxy must be reached only through a dynamic import, off the first-paint graph');
  assert.ok(src.includes("import('../lib/clip-proxy.ts')"), 'eviction is still wired, just lazily');
  // And the resolved AssetRef must still carry the original URL.
  assert.ok(!/url:\s*(peekScrubUrl|proxy)/.test(src));
});

test('GUARD: the only consumer of the swap is the preview thumbnailer', () => {
  const thumbs = read('lib/clip-thumbs.ts');
  assert.ok(thumbs.includes('peekScrubUrl'), 'filmstrips/waveforms are the shipped consumer');
});

test('GUARD: mediabunny stays lazy, and never ALL_FORMATS', () => {
  const src = read('lib/clip-proxy.ts');
  assert.ok(!/^import .*from 'mediabunny'/m.test(src), 'a static import would cost the preload entry ~89 kB gzip');
  assert.ok(src.includes("await import('mediabunny')"));
  assert.ok(!/\bALL_FORMATS\b/.test(src.replace(/`ALL_FORMATS`/g, '')), 'explicit container singletons only');
});

test('GUARD: the phase-3 duration rule holds — computeDuration, never the metadata claim', () => {
  const src = read('lib/clip-proxy.ts');
  assert.ok(src.includes('input.computeDuration()'));
  assert.ok(!/\.getDurationFromMetadata\b/.test(src),
    'a truncated container still claims its original length — never trust the header');
});
