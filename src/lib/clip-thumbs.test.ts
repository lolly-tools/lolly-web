// SPDX-License-Identifier: MPL-2.0
/**
 * Tests for clip-thumbs.ts — the parts that are DOM-free or injectable.
 *
 * WHAT IS COVERED HERE (real logic, real module, no mock theatre):
 *   • frameTimes      — midpoint sampling, clamping, degenerate spans
 *   • bucketPeaks     — the audiogram normalisation, mono mix, silence
 *   • filmstripKey / peaksKey / withinDecodeBudget — cache identity + the ceiling
 *   • createLru       — recency, eviction order, dispose-on-evict/overwrite/clear
 *   • createSeekQueue — the Safari rule: never two seeks in flight; strict order;
 *                       latest-wins supersede; abort skipping
 *   • onIdle          — the setTimeout fallback path + cancellation
 *   • filmstrip()     — resolves empty (never throws) with no DOM present
 *
 * WHAT IS **NOT** COVERED — browser-only, must be exercised in phase 2B's
 * browser pass, because node has no media pipeline to fake honestly:
 *   • the pooled probe <video> lifecycle (creation, src reuse, idle teardown,
 *     releaseClipThumbs) and the single-run `withProbe` lock
 *   • waitSeekLanded's real rVFC-vs-`seeked` race and its timeout
 *   • waitMetadata, canvas drawImage/createImageBitmap, CORS tainting
 *   • peaks()'s decodeAudioData path (its pure tail bucketPeaks, its declared-size
 *     gate withinDecodeBudget, and its bounded body read readBounded are tested here;
 *     the decode itself needs a real Web Audio implementation)
 *   • ImageBitmap.close() actually running on eviction (the LRU test proves the
 *     dispose *hook* fires; that it frees GPU memory is a browser fact)
 * A jsdom stand-in would prove nothing about any of those — every one of them is
 * a real-decoder behaviour. They are listed so the browser pass can script them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameTimes,
  bucketPeaks,
  filmstripKey,
  peaksKey,
  withinDecodeBudget,
  createLru,
  createSeekQueue,
  onIdle,
  filmstrip,
  readBounded,
  MAX_AUDIO_DECODE_BYTES,
  MAX_FRAMES,
  type SeekableEl,
} from './clip-thumbs.ts';

// ── frameTimes ───────────────────────────────────────────────────────────────

test('frameTimes: samples slice midpoints, never the in-point itself', () => {
  const t = frameTimes(0, 4, 4, 10);
  assert.deepEqual(t, [0.5, 1.5, 2.5, 3.5]);
  assert.ok((t[0] ?? 0) > 0, 'first sample must not be the black leader frame');
});

test('frameTimes: honours the clip in-point offset', () => {
  assert.deepEqual(frameTimes(2, 6, 2, 30), [3, 5]);
});

test('frameTimes: a non-finite out-point means "to the end of the media"', () => {
  assert.deepEqual(frameTimes(0, Number.NaN, 2, 8), [2, 6]);
});

test('frameTimes: clamps inside the media and never returns a negative time', () => {
  const t = frameTimes(-5, 100, 3, 6);
  assert.equal(t.length, 3);
  for (const v of t) {
    assert.ok(v >= 0, `negative sample ${v}`);
    assert.ok(v <= 6 - 1 / 60 + 1e-9, `sample ${v} past the last decodable frame`);
  }
});

test('frameTimes: unknown duration + no out-point degenerates to one point, not NaN', () => {
  const t = frameTimes(1.5, Number.NaN, 3);
  assert.deepEqual(t, [1.5, 1.5, 1.5]);
});

test('frameTimes: out-point at or before the in-point does not go backwards', () => {
  const t = frameTimes(5, 3, 3, 20);
  assert.equal(t.length, 3);
  for (const v of t) assert.ok(v >= 5, `sample ${v} preceded the in-point`);
});

test('frameTimes: count is clamped to 1..MAX_FRAMES', () => {
  assert.equal(frameTimes(0, 10, 0, 10).length, 1);
  assert.equal(frameTimes(0, 10, -3, 10).length, 1);
  assert.equal(frameTimes(0, 10, 9999, 10).length, MAX_FRAMES);
  assert.equal(frameTimes(0, 10, Number.NaN, 10).length, 1);
});

// ── bucketPeaks ──────────────────────────────────────────────────────────────

test('bucketPeaks: normalises the loudest bucket to 1 with the 0.04 floor', () => {
  // 64 samples: first half quiet, second half loud (stride 32 hits index 0 and 32).
  const ch = new Float32Array(64);
  ch[0] = 0.1;
  ch[32] = 0.5;
  const out = bucketPeaks([ch], 2);
  assert.equal(out.length, 2);
  assert.ok(Math.abs((out[1] ?? 0) - 1) < 1e-6, 'loudest bucket is 1.0');
  assert.ok(Math.abs((out[0] ?? 0) - 0.2) < 1e-6, 'quiet bucket keeps its relative level');
});

test('bucketPeaks: applies the 0.04 visual floor to near-silent buckets', () => {
  const ch = new Float32Array(64);
  ch[0] = 0.0001;
  ch[32] = 1;
  const out = bucketPeaks([ch], 2);
  assert.ok(Math.abs((out[0] ?? 0) - 0.04) < 1e-7, `floor not applied: ${out[0]}`); // f32 storage

});

test('bucketPeaks: digital silence returns zeros (no synthetic placeholder)', () => {
  const out = bucketPeaks([new Float32Array(128)], 4);
  assert.deepEqual([...out], [0, 0, 0, 0]);
});

test('bucketPeaks: mixes two channels as (L+R)/2 and takes |sample|', () => {
  const l = new Float32Array(32);
  const r = new Float32Array(32);
  l[0] = -1; r[0] = 0; // mono mix -0.5, abs 0.5
  const mono = bucketPeaks([l], 1);
  const stereo = bucketPeaks([l, r], 1);
  assert.equal(mono[0], 1);   // normalised against itself
  assert.equal(stereo[0], 1); // also normalised against itself — the mix is proven below
  // Prove the mix by giving bucket B a level that only differs after mixing.
  const l2 = new Float32Array(64);
  const r2 = new Float32Array(64);
  l2[0] = 1; r2[0] = 1;   // bucket 0 mixes to 1.0
  l2[32] = 1; r2[32] = 0; // bucket 1 mixes to 0.5
  const out = bucketPeaks([l2, r2], 2);
  assert.ok(Math.abs((out[0] ?? 0) - 1) < 1e-6);
  assert.ok(Math.abs((out[1] ?? 0) - 0.5) < 1e-6);
});

test('bucketPeaks: empty/absent PCM yields a zero-filled array of the right length', () => {
  assert.equal(bucketPeaks([], 5).length, 5);
  assert.equal(bucketPeaks([new Float32Array(0)], 5).length, 5);
});

test('bucketPeaks: more buckets than samples still returns exactly `buckets` entries', () => {
  const ch = new Float32Array(4);
  ch[0] = 1;
  assert.equal(bucketPeaks([ch], 16).length, 16);
});

// ── cache keys + the decode ceiling ─────────────────────────────────────────

test('filmstripKey: distinguishes url, in, out, count and height', () => {
  const base = { count: 6, h: 40, clipInSec: 0, clipOutSec: 3 };
  const k = filmstripKey('a.mp4', base);
  assert.notEqual(k, filmstripKey('b.mp4', base));
  assert.notEqual(k, filmstripKey('a.mp4', { ...base, clipInSec: 1 }));
  assert.notEqual(k, filmstripKey('a.mp4', { ...base, clipOutSec: 4 }));
  assert.notEqual(k, filmstripKey('a.mp4', { ...base, count: 7 }));
  assert.notEqual(k, filmstripKey('a.mp4', { ...base, h: 41 }));
  assert.equal(k, filmstripKey('a.mp4', { ...base }));
});

test('filmstripKey: clamped inputs collapse to the same key', () => {
  const a = filmstripKey('a.mp4', { count: 999, h: 9999, clipInSec: -1, clipOutSec: 3 });
  const b = filmstripKey('a.mp4', { count: MAX_FRAMES, h: 240, clipInSec: 0, clipOutSec: 3 });
  assert.equal(a, b);
});

test('peaksKey: namespaced apart from filmstrip keys and keyed by bucket count', () => {
  assert.notEqual(peaksKey('a.mp3', 100), peaksKey('a.mp3', 101));
  assert.ok(peaksKey('a.mp3', 100).startsWith('p|'));
  assert.ok(filmstripKey('a.mp3', { count: 1, h: 10, clipInSec: 0, clipOutSec: 1 }).startsWith('f|'));
});

test('withinDecodeBudget: refuses oversized audio, allows the ceiling exactly', () => {
  assert.equal(withinDecodeBudget(MAX_AUDIO_DECODE_BYTES), true);
  assert.equal(withinDecodeBudget(MAX_AUDIO_DECODE_BYTES + 1), false);
  assert.equal(withinDecodeBudget(0), true);
  // Unknown length must not block — the post-fetch byteLength check catches it.
  assert.equal(withinDecodeBudget(null), true);
  assert.equal(withinDecodeBudget(Number.NaN), true);
});

// ── LRU ──────────────────────────────────────────────────────────────────────

test('createLru: evicts the least-recently-used and disposes exactly that value', () => {
  const closed: string[] = [];
  const lru = createLru<string>(2, (v) => closed.push(v));
  lru.set('a', 'A');
  lru.set('b', 'B');
  lru.get('a');            // refresh a → b is now oldest
  lru.set('c', 'C');
  assert.deepEqual(closed, ['B']);
  assert.deepEqual(lru.keys(), ['a', 'c']);
  assert.equal(lru.size(), 2);
});

test('createLru: overwriting a key disposes the replaced value only', () => {
  const closed: string[] = [];
  const lru = createLru<string>(4, (v) => closed.push(v));
  lru.set('a', 'A1');
  lru.set('a', 'A2');
  assert.deepEqual(closed, ['A1']);
  assert.equal(lru.get('a'), 'A2');
  assert.equal(lru.size(), 1);
});

test('createLru: re-setting the identical value does not dispose it', () => {
  const closed: string[] = [];
  const lru = createLru<string>(4, (v) => closed.push(v));
  lru.set('a', 'A');
  lru.set('a', 'A');
  assert.deepEqual(closed, []);
});

test('createLru: clear disposes everything it held', () => {
  const closed: string[] = [];
  const lru = createLru<string>(4, (v) => closed.push(v));
  lru.set('a', 'A');
  lru.set('b', 'B');
  lru.clear();
  assert.deepEqual(closed.sort(), ['A', 'B']);
  assert.equal(lru.size(), 0);
});

test('createLru: a throwing disposer cannot break eviction', () => {
  const lru = createLru<string>(1, () => { throw new Error('boom'); });
  lru.set('a', 'A');
  lru.set('b', 'B');
  assert.deepEqual(lru.keys(), ['b']);
});

test('createLru: closes real ImageBitmap-shaped values on eviction', () => {
  // Stands in for ImageBitmap: the only contract the cache relies on is close().
  interface Closable { closed: boolean; close(): void }
  const mk = (): Closable => ({ closed: false, close(): void { this.closed = true; } });
  const a = mk(), b = mk(), c = mk();
  const lru = createLru<Closable[]>(1, (arr) => { for (const bmp of arr) bmp.close(); });
  lru.set('x', [a, b]);
  lru.set('y', [c]);
  assert.equal(a.closed, true);
  assert.equal(b.closed, true);
  assert.equal(c.closed, false);
});

// ── seek queue (the Safari rule) ─────────────────────────────────────────────

/** A fake seekable with a manually-resolved frame confirmation. */
function fakeVideo(): {
  el: SeekableEl;
  seeks: number[];
  concurrent: number;
  maxConcurrent: number;
  waitFrame: (el: SeekableEl, signal?: AbortSignal) => Promise<number | null>;
  land(index?: number): void;
  landed: number;
} {
  const state = {
    el: { currentTime: 0 } as SeekableEl,
    seeks: [] as number[],
    concurrent: 0,
    maxConcurrent: 0,
    landed: 0,
    pendingResolvers: [] as ((v: number | null) => void)[],
    waitFrame: (el: SeekableEl): Promise<number | null> => {
      state.seeks.push(el.currentTime);
      state.concurrent++;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      return new Promise<number | null>((resolve) => {
        state.pendingResolvers.push((v) => { state.concurrent--; state.landed++; resolve(v); });
      });
    },
    land(): void {
      const r = state.pendingResolvers.shift();
      if (r) r(state.el.currentTime);
    },
  };
  return state as never;
}

test('createSeekQueue: never issues a second seek while one is in flight', async () => {
  const fake = fakeVideo();
  const q = createSeekQueue(fake.el, fake.waitFrame);
  const p1 = q.seek(1);
  const p2 = q.seek(2);
  const p3 = q.seek(3);
  await Promise.resolve();
  assert.equal(fake.seeks.length, 1, 'only the first seek may have been issued');
  assert.equal(q.inFlight(), true);
  assert.equal(q.pending(), 2);

  fake.land();
  assert.equal(await p1, 1);
  await Promise.resolve();
  assert.equal(fake.seeks.length, 2);

  fake.land();
  assert.equal(await p2, 2);
  fake.land();
  assert.equal(await p3, 3);
  assert.equal(fake.maxConcurrent, 1, 'two seeks were in flight at once');
  assert.deepEqual(fake.seeks, [1, 2, 3], 'seeks must land in request order');
  assert.equal(q.inFlight(), false);
});

test('createSeekQueue: supersede is latest-wins for QUEUED requests only', async () => {
  const fake = fakeVideo();
  const q = createSeekQueue(fake.el, fake.waitFrame);
  const first = q.seek(1);                        // starts immediately, uninterruptible
  const stale = q.seek(2, { supersede: true });
  const stale2 = q.seek(3, { supersede: true });
  const latest = q.seek(4, { supersede: true });
  await Promise.resolve();
  assert.equal(q.pending(), 1, 'only the newest supersede request survives');
  assert.equal(await stale, null);
  assert.equal(await stale2, null);

  fake.land();
  assert.equal(await first, 1, 'an in-flight seek is never cancelled');
  await Promise.resolve();
  fake.land();
  assert.equal(await latest, 4);
  assert.deepEqual(fake.seeks, [1, 4]);
});

test('createSeekQueue: an aborted queued seek is skipped without touching the element', async () => {
  const fake = fakeVideo();
  const q = createSeekQueue(fake.el, fake.waitFrame);
  const ctrl = new AbortController();
  const p1 = q.seek(1);
  const p2 = q.seek(2, { signal: ctrl.signal });
  const p3 = q.seek(3);
  await Promise.resolve();
  ctrl.abort();
  fake.land();
  assert.equal(await p1, 1);
  assert.equal(await p2, null, 'aborted seek resolves null');
  await Promise.resolve();
  fake.land();
  assert.equal(await p3, 3);
  assert.deepEqual(fake.seeks, [1, 3], 'the aborted target was never seeked to');
});

test('createSeekQueue: many aborted entries drain without recursion or stalling', async () => {
  const fake = fakeVideo();
  const q = createSeekQueue(fake.el, fake.waitFrame);
  const ctrl = new AbortController();
  ctrl.abort();
  const aborted = Array.from({ length: 5000 }, (_, i) => q.seek(i, { signal: ctrl.signal }));
  const real = q.seek(99);
  assert.deepEqual(await Promise.all(aborted.slice(0, 3)), [null, null, null]);
  await Promise.resolve();
  fake.land();
  assert.equal(await real, 99);
  assert.deepEqual(fake.seeks, [99]);
});

test('createSeekQueue: a rejecting frame-wait resolves null and keeps draining', async () => {
  const el: SeekableEl = { currentTime: 0 };
  let calls = 0;
  const q = createSeekQueue(el, () => {
    calls++;
    return calls === 1 ? Promise.reject(new Error('decoder blew up')) : Promise.resolve(el.currentTime);
  });
  assert.equal(await q.seek(1), null);
  assert.equal(await q.seek(2), 2);
  assert.equal(q.inFlight(), false);
});

test('createSeekQueue: clear() drains the backlog without seeking to it', async () => {
  const fake = fakeVideo();
  const q = createSeekQueue(fake.el, fake.waitFrame);
  const p1 = q.seek(1);
  const p2 = q.seek(2);
  await Promise.resolve();
  q.clear();
  assert.equal(await p2, null);
  fake.land();
  assert.equal(await p1, 1);
  assert.deepEqual(fake.seeks, [1]);
});

// ── idle scheduling ──────────────────────────────────────────────────────────

test('onIdle: runs the callback on the setTimeout fallback path', async () => {
  let ran = false;
  onIdle(() => { ran = true; }, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran, true);
});

test('onIdle: the returned canceller prevents the callback', async () => {
  let ran = false;
  const cancel = onIdle(() => { ran = true; }, 0);
  cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran, false);
});

// ── headless failure policy ──────────────────────────────────────────────────

test('filmstrip: resolves empty (never throws) with no DOM available', async () => {
  const out = await filmstrip('video.mp4', { count: 4, h: 40, clipInSec: 0, clipOutSec: 2 });
  assert.deepEqual(out, []);
});

test('filmstrip: an empty url resolves empty', async () => {
  assert.deepEqual(await filmstrip('', { count: 4, h: 40, clipInSec: 0, clipOutSec: 2 }), []);
});

test('filmstrip: an already-aborted signal resolves empty promptly', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  assert.deepEqual(await filmstrip('video.mp4', { count: 4, h: 40, clipInSec: 0, clipOutSec: 2 }, ctrl.signal), []);
});

// ── readBounded (the audio ceiling has to bound the FETCH, not just the decode) ──

/** A Response-shaped stub that streams `chunks` and records whether it was cancelled. */
function bodyOf(chunks: number[]): { res: { body: { getReader(): ReadableStreamDefaultReader<Uint8Array> }; arrayBuffer(): Promise<ArrayBuffer> }; state: { cancelled: boolean; read: number } } {
  const state = { cancelled: false, read: 0 };
  let i = 0;
  const reader = {
    read: async () => {
      if (i >= chunks.length) return { done: true, value: undefined };
      const n = chunks[i++]!;
      state.read += n;
      return { done: false, value: new Uint8Array(n).fill(7) };
    },
    cancel: async () => { state.cancelled = true; },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  return {
    res: {
      body: { getReader: () => reader },
      arrayBuffer: async () => { throw new Error('arrayBuffer() must not be used when a stream is available'); },
    },
    state,
  };
}

test('readBounded: assembles a small body byte-for-byte', async () => {
  const { res } = bodyOf([4, 4, 2]);
  const buf = await readBounded(res, 1000);
  assert.ok(buf, 'a body inside the ceiling comes back whole');
  assert.equal(buf.byteLength, 10);
  assert.deepEqual([...new Uint8Array(buf)], new Array(10).fill(7));
});

test('readBounded: abandons an oversized body mid-stream instead of buffering it', async () => {
  // The failure this pins: a chunked response with no Content-Length used to be read
  // in full by arrayBuffer() and only THEN refused, so the allocation happened anyway.
  const { res, state } = bodyOf([100, 100, 100, 100, 100]);
  assert.equal(await readBounded(res, 250), null, 'oversized bodies resolve null');
  assert.equal(state.cancelled, true, 'the stream is cancelled, not drained');
  assert.equal(state.read, 300, 'stopped at the first chunk past the ceiling, not at the end');
});

test('readBounded: an already-aborted signal stops the read and cancels', async () => {
  const { res, state } = bodyOf([10, 10, 10]);
  assert.equal(await readBounded(res, 1000, { aborted: true }), null);
  assert.equal(state.cancelled, true);
});

test('readBounded: falls back to arrayBuffer() only when there is no stream, and still bounds it', async () => {
  const small = { arrayBuffer: async () => new Uint8Array(8).buffer };
  const big = { arrayBuffer: async () => new Uint8Array(4096).buffer };
  assert.equal((await readBounded(small, 100))?.byteLength, 8);
  assert.equal(await readBounded(big, 100), null);
});

test('readBounded: a throwing stream resolves null rather than rejecting into peaks()', async () => {
  const res = {
    body: { getReader: () => ({ read: async () => { throw new Error('network'); }, cancel: async () => {} }) as unknown as ReadableStreamDefaultReader<Uint8Array> },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  assert.equal(await readBounded(res, MAX_AUDIO_DECODE_BYTES), null);
});
