// SPDX-License-Identifier: MPL-2.0
/**
 * Worker offload of the sequence compositor (phase 4 Track B) — the headless tier.
 *
 * The pixels and the bytes still belong to the browser tier
 * (tests/sequence-render.browser.test.ts), and phase 3's determinism harness is
 * what pins frame-exactness. What node CAN prove, and what this file asserts, is
 * everything around the offload:
 *
 *   • THE SPLIT RULE — a sequence with no live-raster layer never asks the main
 *     thread for anything (100 % worker-side); one with a lottie layer asks
 *     exactly once per active frame, with at most ONE request in flight, and
 *     releases every image it was handed.
 *   • THE MESSAGE PROTOCOL — `handleStart` driven against a stub port and stub
 *     encoder: start → progress ×N → done, log passthrough, need-live/live
 *     round trips, and a failure that aborts the muxer instead of posting bytes.
 *   • CAPABILITY GATING AND FALLBACK — `supportsWorkerSequenceRender()` is false
 *     the moment any piece is missing, and a NON-coded worker failure is
 *     distinguishable from a coded one (only the former may be retried
 *     in-thread; retrying a SEQ_TRUNCATED would just be slower).
 *   • ABORT TEARDOWN — the abort message reaches the worker, the run rejects
 *     coded, and the thread is terminated rather than leaked.
 *
 *   • DETERMINISM BY CONSTRUCTION — the source guard at the end. The worker path
 *     and the in-thread path cannot drift because there is only ONE compositor:
 *     `drawItem` and the frame loop exist in exactly one file, and both hosts
 *     call `runSequenceJob`.
 *
 * Run directly:  node --test shells/web/src/bridge/sequence-render-worker.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  runSequenceJob,
  handleStart,
  toJobLayer,
  hydrateJobLayer,
  pcmSourceOf,
  jobTransferables,
  type SeqJob,
  type SeqJobLayer,
  type SeqWorkerOut,
  type SeqWorkerStart,
  type AnyCanvas,
  type AnyCtx,
  isOffloadFailure,
  createRunRegistry,
} from './sequence-render.worker.ts';
import {
  supportsWorkerSequenceRender,
  workerSequenceRenderEnabled,
  abortSequenceWorkerRenders,
  SEQ_ABORT_GRACE_MS,
  renderSequenceInWorker,
  _setSequenceWorkerFactory,
  LIVE_RASTER_QUEUE,
} from './sequence-render.ts';
import { SequenceError, sequenceError } from './sequence-plan.ts';
import type { EncodePick } from './video-encode-core.ts';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// ── stubs ───────────────────────────────────────────────────────────────────

/** A 2D context that records nothing but never throws — the compositor's calls
 *  are proven by the browser tier; here only the CONTROL FLOW around them matters. */
function stubCtx(): AnyCtx & { draws: unknown[] } {
  const draws: unknown[] = [];
  const noop = (): void => {};
  return {
    draws,
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    clip: noop, clearRect: noop, setTransform: noop,
    drawImage: (src: unknown) => { draws.push(src); },
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  } as unknown as AnyCtx & { draws: unknown[] };
}

let layerIdx = 0;
function layer(over: Partial<SeqJobLayer> = {}): SeqJobLayer {
  const base = toJobLayer({
    el: null as never,
    idx: layerIdx++,
    startMs: 0, durMs: 1000, clipInMs: 0, speed: 1, mute: false,
    enter: null, enterMs: 0, exit: null, exitMs: 0, enterEase: '', exitEase: '',
    lane: 'seq', kind: 'static',
    rect: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
    opacity: 1, blend: '', radius: '', clipPath: '', openEnded: false,
  });
  return { ...base, ...over };
}

function job(layers: SeqJobLayer[], frames = 4, fps = 4): SeqJob {
  const grid = Array.from({ length: frames }, (_, i) => (i * 1000) / fps);
  return {
    layers, grid, frameCount: frames, fps, totalMs: (frames * 1000) / fps,
    outW: 100, outH: 100, scale: 1,
    bg: null, plates: layers.map((l) => ({ idx: l.idx, under: null, over: null })), clips: [],
    maxLiveProviders: 3, watchdogMs: 1000,
  };
}

// ── the split rule ──────────────────────────────────────────────────────────

test('split rule: a sequence with no live-raster layer never calls back to the main thread', async () => {
  const j = job([layer(), layer({ kind: 'lottie', needsLiveRaster: false })]);
  let asked = 0;
  const frames: number[] = [];
  await runSequenceJob(j, {} as AnyCanvas, stubCtx(), {
    frame: async (_c, _x, i) => { frames.push(i); },
    lottieAt: async () => { asked++; return null; },
  });
  assert.equal(asked, 0, 'nothing needs the DOM, so the worker runs the whole sequence alone');
  assert.deepEqual(frames, [0, 1, 2, 3], 'and every frame was still composed');
});

test('split rule: a live-raster lottie layer is asked once per active frame, one at a time', async () => {
  const j = job([layer({ kind: 'lottie', needsLiveRaster: true, durMs: 500 })]);
  let inFlight = 0;
  let peak = 0;
  const calls: { frame: number; sourceSec: number }[] = [];
  const released: unknown[] = [];
  const img = { tag: 'raster' } as unknown as CanvasImageSource;
  await runSequenceJob(j, {} as AnyCanvas, stubCtx(), {
    frame: async () => {},
    lottieAt: async (_idx, frame, sourceSec) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      calls.push({ frame, sourceSec });
      return img;
    },
    releaseLottie: (i) => { released.push(i); },
  });
  // durMs 500 over a 4 fps grid: frames 0 and 1 are inside [0, 500).
  assert.deepEqual(calls.map((c) => c.frame), [0, 1], 'only the frames the layer is live for');
  assert.deepEqual(calls.map((c) => c.sourceSec), [0, 0.25], 'and each with its own source time');
  assert.equal(peak, LIVE_RASTER_QUEUE, 'the queue bound is one outstanding request');
  assert.equal(released.length, 2, 'everything handed over is released, so a transferred bitmap cannot leak');
});

test('split rule: a null answer falls back to the static plate rather than failing the frame', async () => {
  const j = job([layer({ kind: 'lottie', needsLiveRaster: true })]);
  const ctx = stubCtx();
  const plate = { tag: 'under' } as unknown as CanvasImageSource;
  j.plates = [{ idx: j.layers[0]!.idx, under: plate, over: null }];
  await runSequenceJob(j, {} as AnyCanvas, ctx, {
    frame: async () => {},
    lottieAt: async () => null,
    releaseLottie: () => { assert.fail('nothing was handed over'); },
  });
  assert.equal(ctx.draws.length, 4, 'every frame still drew');
  assert.ok(ctx.draws.every((d) => d === plate), 'and drew the static plate');
});

test('the executor aborts between frames when the host says so', async () => {
  const j = job([layer()], 10, 10);
  let done = 0;
  const err = await runSequenceJob(j, {} as AnyCanvas, stubCtx(), {
    frame: async () => { done++; },
    aborted: () => done >= 3,
  }).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof SequenceError, 'a cancel is a coded failure');
  assert.equal((err as SequenceError).code, 'SEQ_ABORTED');
  assert.equal(done, 3, 'and it stops where it was told to, not at the end');
});

test('hydrateJobLayer round-trips every field the planner reads', () => {
  const w = layer({ kind: 'video', speed: 2, clipInMs: 500, blend: 'multiply', objectFit: 'cover' });
  const h = hydrateJobLayer(w);
  for (const k of ['idx', 'startMs', 'durMs', 'clipInMs', 'speed', 'mute', 'enter', 'enterMs',
    'exit', 'exitMs', 'lane', 'kind', 'opacity', 'blend', 'radius', 'clipPath', 'openEnded'] as const) {
    assert.deepEqual((h as never as Record<string, unknown>)[k], (w as never as Record<string, unknown>)[k], k);
  }
  assert.deepEqual(h.rect, w.rect);
  assert.ok(h.el && typeof h.el === 'object', 'the element stand-in is an object, so a defensive read cannot throw');
});

// ── the message protocol ────────────────────────────────────────────────────

interface StubMux {
  frames: number[];
  audio: number[];
  aborted: number;
  finalized: number;
  addFrame(src: unknown, tsUs: number): Promise<void>;
  addAudio(b: { length: number }): Promise<void>;
  finalize(): Promise<Blob>;
  abort(): Promise<void>;
}

function stubMux(fail?: Error): StubMux {
  const m: StubMux = {
    frames: [], audio: [], aborted: 0, finalized: 0,
    addFrame: async (_s, ts) => { if (fail && m.frames.length === 2) throw fail; m.frames.push(ts); },
    addAudio: async (b) => { m.audio.push(b.length); },
    finalize: async () => { m.finalized++; return new Blob([new Uint8Array([1, 2, 3])], { type: 'video/webm' }); },
    abort: async () => { m.aborted++; },
  };
  return m;
}

const PICK: EncodePick = { container: 'webm', codec: 'vp8', muxCodec: 'V_VP8' };

function startMsg(j: SeqJob, audio: SeqWorkerStart['audio'] = null): SeqWorkerStart {
  return { type: 'start', id: 7, job: j, pick: PICK, bitrate: 1_000_000, audio };
}

function stubPort(): { post(m: SeqWorkerOut, t?: Transferable[]): void; sent: SeqWorkerOut[] } {
  const sent: SeqWorkerOut[] = [];
  return { sent, post: (m) => { sent.push(m); } };
}

test('protocol: start → progress per frame → done, with the muxer finalized once', async () => {
  const mux = stubMux();
  const port = stubPort();
  await handleStart(startMsg(job([layer()])), port, { aborted: () => false, awaitLive: async () => null }, {
    makeCanvas: () => ({ getContext: () => stubCtx() }) as unknown as AnyCanvas,
    makeMux: async () => mux as never,
  });
  const progress = port.sent.filter((m) => m.type === 'progress');
  assert.deepEqual(progress.map((p) => (p as { done: number }).done), [1, 2, 3, 4]);
  assert.deepEqual(mux.frames, [0, 250_000, 500_000, 750_000], 'timestamps are the µs grid');
  assert.equal(mux.finalized, 1);
  assert.equal(mux.aborted, 0);
  const done = port.sent.at(-1);
  assert.equal(done?.type, 'done');
  assert.equal((done as { mime: string }).mime, 'video/webm');
  assert.equal((done as { buffer: ArrayBuffer }).buffer.byteLength, 3);
});

test('protocol: a live-raster layer emits need-live with a fresh token, and the reply is drawn', async () => {
  const port = stubPort();
  const answered: number[] = [];
  await handleStart(
    startMsg(job([layer({ kind: 'lottie', needsLiveRaster: true })], 2, 4)),
    port,
    {
      aborted: () => false,
      awaitLive: async (token) => { answered.push(token); return null; },
    },
    { makeCanvas: () => ({ getContext: () => stubCtx() }) as unknown as AnyCanvas, makeMux: async () => stubMux() as never },
  );
  const needs = port.sent.filter((m) => m.type === 'need-live') as { token: number; frame: number }[];
  assert.deepEqual(needs.map((n) => n.frame), [0, 1]);
  assert.deepEqual(needs.map((n) => n.token), [1, 2], 'tokens are unique so a late reply cannot be mistaken');
  assert.deepEqual(answered, [1, 2], 'and every request was awaited before the frame was drawn');
});

test('protocol: the transferred plates are closed even when SETUP fails', async () => {
  // The plates were TRANSFERRED, so this thread is their only owner. A throw from
  // getContext / createStreamingMux — both of which run before the frame loop —
  // used to skip the close entirely, stranding ~170 MB of native bitmap memory
  // for a 1080p ten-layer job, once per failed attempt.
  let closed = 0;
  // closeJobBitmaps only closes REAL ImageBitmaps (a canvas plate, on the
  // in-thread path, is not ours to close). Node has no ImageBitmap, so stand one
  // up for the length of this test.
  const g = globalThis as { ImageBitmap?: unknown };
  const had = 'ImageBitmap' in g;
  class FakeBitmap { close(): void { closed++; } }
  g.ImageBitmap = FakeBitmap;
  const bitmap = new FakeBitmap() as unknown as ImageBitmap;
  const j = job([layer()]);
  j.plates = [{ idx: 0, under: bitmap, over: null }];
  const err = await handleStart(startMsg(j), stubPort(), { aborted: () => false, awaitLive: async () => null }, {
    makeCanvas: () => ({ getContext: () => stubCtx() }) as unknown as AnyCanvas,
    makeMux: async () => { throw new Error('no muxer here'); },
  }).then(() => null, (e: unknown) => e);
  if (!had) delete g.ImageBitmap;
  assert.ok(err instanceof Error);
  assert.equal(closed, 1, 'the job\'s bitmaps are released on every exit, not only the happy one');
});

test('isOffloadFailure: an uncoded throw is the offload; a coded verdict is not', () => {
  assert.equal(isOffloadFailure(new Error('the muxer chunk would not load')), true);
  assert.equal(isOffloadFailure(sequenceError('SEQ_TRUNCATED', 'short file')), false);
  const tagged = sequenceError('SEQ_UNSUPPORTED_MEDIA', 'no DOM for the element-seek provider');
  (tagged as unknown as Record<string, unknown>).offload = true;
  assert.equal(isOffloadFailure(tagged), true,
    'the element-seek provider is missing only BECAUSE we are in a worker — that must retry in-thread');
});

test('two OVERLAPPING runs cannot resolve each other\'s live rasters', async () => {
  // The corruption this guards: both runs mint tokens 1, 2, 3… A single-slot
  // worker resolves run 1's waiter with run 2's frame, so run 1 silently
  // composites the WRONG lottie picture — wrong pixels, no error, and the
  // in-run uniqueness the older test asserts is exactly the property that does
  // not hold across runs.
  const reg = createRunRegistry();
  const a = reg.begin(1);
  const b = reg.begin(2);
  const bmA = { id: 'A' } as unknown as ImageBitmap;
  const bmB = { id: 'B' } as unknown as ImageBitmap;

  const gotA = a.awaitLive(1);
  const gotB = b.awaitLive(1);                 // the SAME token number
  assert.equal(reg.deliver(2, 1, bmB), true);
  assert.equal(await gotB, bmB);
  assert.equal(reg.deliver(1, 1, bmA), true);
  assert.equal(await gotA, bmA, 'each run got its own frame');
});

test('aborting one run leaves the other running', async () => {
  const reg = createRunRegistry();
  const a = reg.begin(1);
  const b = reg.begin(2);
  const pending = a.awaitLive(7);
  reg.abort(1);
  assert.equal(await pending, null, 'the cancelled run is unblocked rather than left to its watchdog');
  assert.equal(a.aborted(), true);
  assert.equal(b.aborted(), false, 'a second start must not clear an abort the first run had not yet observed');
  reg.end(1); reg.end(2);
  assert.equal(reg.size(), 0);
});

test('a live raster nobody is waiting for is reported so the caller can close it', () => {
  const reg = createRunRegistry();
  reg.begin(1);
  assert.equal(reg.deliver(1, 99, {} as unknown as ImageBitmap), false, 'unknown token');
  assert.equal(reg.deliver(42, 1, {} as unknown as ImageBitmap), false, 'unknown run');
});

test('protocol: a failure aborts the muxer and posts no bytes', async () => {
  const boom = new Error('encoder exploded');
  const mux = stubMux(boom);
  const port = stubPort();
  const err = await handleStart(startMsg(job([layer()])), port, { aborted: () => false, awaitLive: async () => null }, {
    makeCanvas: () => ({ getContext: () => stubCtx() }) as unknown as AnyCanvas,
    makeMux: async () => mux as never,
  }).then(() => null, (e: unknown) => e);
  assert.equal(err, boom, 'the failure propagates to the worker entry, which codes it');
  assert.equal(mux.aborted, 1, 'the muxer is torn down');
  assert.equal(mux.finalized, 0);
  assert.ok(!port.sent.some((m) => m.type === 'done'), 'and nothing was claimed as output');
});

test('protocol: the mixed PCM is fed through the same addAudio the in-thread path uses', async () => {
  const mux = stubMux();
  const port = stubPort();
  const channels = [new Float32Array(480), new Float32Array(480)];
  await handleStart(
    startMsg(job([layer()]), {
      codec: 'opus', muxCodec: 'A_OPUS', sampleRate: 48_000, numberOfChannels: 2,
      bitrate: 128_000, channels, length: 480,
    }),
    port,
    { aborted: () => false, awaitLive: async () => null },
    { makeCanvas: () => ({ getContext: () => stubCtx() }) as unknown as AnyCanvas, makeMux: async () => mux as never },
  );
  assert.deepEqual(mux.audio, [480]);
});

test('pcmSourceOf presents planar channels as the AudioBuffer slice addAudio reads', () => {
  const a = { codec: '', muxCodec: '', sampleRate: 48_000, numberOfChannels: 2, bitrate: 0, length: 3,
    channels: [Float32Array.of(1, 2, 3)] };
  const p = pcmSourceOf(a);
  assert.equal(p.length, 3);
  assert.equal(p.numberOfChannels, 2);
  assert.deepEqual([...p.getChannelData(0)], [1, 2, 3]);
  assert.deepEqual([...p.getChannelData(1)], [1, 2, 3], 'a mono mix feeds both declared channels');
});

test('jobTransferables lists nothing when the plates are canvases (the in-thread job)', () => {
  const j = job([layer()]);
  j.plates = [{ idx: 0, under: {} as unknown as CanvasImageSource, over: null }];
  assert.deepEqual(jobTransferables(j), [], 'only real ImageBitmaps are transferred');
});

// ── capability gating and fallback ──────────────────────────────────────────

function withGlobals(patch: Record<string, unknown>, fn: () => void): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const had = new Map<string, { present: boolean; value: unknown }>();
  for (const [k, v] of Object.entries(patch)) {
    had.set(k, { present: k in g, value: g[k] });
    if (v === undefined) delete g[k]; else g[k] = v;
  }
  try { fn(); } finally {
    for (const [k, { present, value }] of had) {
      if (present) g[k] = value; else delete g[k];
    }
  }
}

const ALL_PRESENT = {
  Worker: class {},
  OffscreenCanvas: class {},
  VideoEncoder: class {},
  createImageBitmap: (): void => {},
  localStorage: { getItem: (k: string) => (k === 'lolly.workerEncode' ? '1' : null) },
};

test('gating: every capability plus the opt-in flag is required', () => {
  withGlobals(ALL_PRESENT, () => {
    assert.equal(workerSequenceRenderEnabled(), true);
    assert.equal(supportsWorkerSequenceRender(), true);
  });
  for (const missing of ['Worker', 'OffscreenCanvas', 'VideoEncoder', 'createImageBitmap']) {
    withGlobals({ ...ALL_PRESENT, [missing]: undefined }, () => {
      assert.equal(supportsWorkerSequenceRender(), false, `${missing} missing must fall back in-thread`);
    });
  }
  withGlobals({ ...ALL_PRESENT, localStorage: { getItem: () => null } }, () => {
    assert.equal(supportsWorkerSequenceRender(), false, 'the offload is opt-in, so OFF is the default');
  });
  withGlobals({ ...ALL_PRESENT, localStorage: undefined }, () => {
    assert.equal(workerSequenceRenderEnabled(), false, 'no storage at all is not an error');
  });
});

/** A Worker stand-in whose posted messages a test can inspect and answer. */
class FakeWorker {
  static last: FakeWorker | null = null;
  posted: unknown[] = [];
  terminated = 0;
  onmessage: ((e: { data: SeqWorkerOut }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeWorker.last = this; }
  postMessage(m: unknown): void { this.posted.push(m); }
  terminate(): void { this.terminated++; }
  reply(m: SeqWorkerOut): void { this.onmessage?.({ data: m }); }
}

function useFakeWorker(): void {
  FakeWorker.last = null;
  _setSequenceWorkerFactory(() => new FakeWorker() as unknown as Worker);
}

/** Let renderSequenceInWorker's own awaits run so the worker has been spawned. */
const spawned = async (): Promise<FakeWorker> => {
  for (let i = 0; i < 50 && !FakeWorker.last; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(FakeWorker.last, 'the client spawned a worker');
  return FakeWorker.last;
};

const emptyIo = { log: (): void => {}, progress: (): void => {} };

test('fallback: a NON-coded worker failure is retryable in-thread; a coded one is not', async () => {
  useFakeWorker();
  const j = job([layer()]);

  const p1 = renderSequenceInWorker(j, PICK, 1000, null, null, emptyIo);
  const w1 = await spawned();
  w1.reply({ type: 'error', id: (w1.posted[0] as { id: number }).id, code: 'SEQ_TRUNCATED', message: 'short file', offload: false });
  const e1 = await p1.then(() => null, (e: unknown) => e);
  assert.ok(e1 instanceof SequenceError, 'a coded verdict crosses the boundary as a SequenceError');
  assert.equal((e1 as SequenceError).code, 'SEQ_TRUNCATED');

  // The SAME worker is reused after a coded verdict — nothing was wrong with it.
  const p2 = renderSequenceInWorker(j, PICK, 1000, null, null, emptyIo);
  await new Promise((r) => setTimeout(r, 0));
  const w2 = FakeWorker.last!;
  assert.equal(w2, w1, 'a coded render failure does not throw the thread away');
  w2.onerror?.();
  const e2 = await p2.then(() => null, (e: unknown) => e);
  assert.ok(e2 instanceof Error && !(e2 instanceof SequenceError),
    'an offload failure is a PLAIN Error — that is what licenses the in-thread retry');
  assert.equal(w2.terminated, 1, 'and the broken worker is not kept around');
  _setSequenceWorkerFactory(null);
});

test('fallback: a coded error the worker TAGGED as an offload failure still retries in-thread', async () => {
  // The case that made the fallback unreachable before `offload` existed:
  // `toCodedError` has no uncoded outcome, so a muxer the worker could not build —
  // or the element-seek provider it structurally cannot run — arrived as
  // SEQ_DECODE_FAILED / SEQ_UNSUPPORTED_MEDIA and read as the render's verdict.
  useFakeWorker();
  const p = renderSequenceInWorker(job([layer()]), PICK, 1000, null, null, emptyIo);
  const w = await spawned();
  w.reply({
    type: 'error', id: (w.posted[0] as { id: number }).id,
    code: 'SEQ_UNSUPPORTED_MEDIA', message: 'no DOM for the element-seek provider', offload: true,
  });
  const err = await p.then(() => null, (e: unknown) => e);
  assert.ok(err instanceof Error && !(err instanceof SequenceError),
    'a tagged offload failure is a PLAIN Error, so renderSequence retries in-thread');
  assert.match((err as Error).message, /SEQ_UNSUPPORTED_MEDIA/, 'the real code survives in the message');
  assert.equal(w.terminated, 1, 'and the worker that could not do the job is dropped');
  _setSequenceWorkerFactory(null);
});

test('protocol (client): progress, log and done all reach the caller', async () => {
  useFakeWorker();
  const logs: string[] = [];
  const progress: number[] = [];
  const p = renderSequenceInWorker(job([layer()]), PICK, 1000, null, null, {
    log: (_l, m) => logs.push(m),
    progress: (d) => progress.push(d),
  });
  const w = await spawned();
  const id = (w.posted[0] as { id: number; type: string }).id;
  assert.equal((w.posted[0] as { type: string }).type, 'start');
  w.reply({ type: 'log', id, level: 'info', msg: 'hello' });
  w.reply({ type: 'progress', id, done: 1, total: 4 });
  w.reply({ type: 'done', id, buffer: new Uint8Array([9, 9]).buffer, mime: 'video/webm' });
  const blob = await p;
  assert.deepEqual(logs, ['hello']);
  assert.deepEqual(progress, [1]);
  assert.equal(blob.type, 'video/webm');
  assert.equal(blob.size, 2);
  _setSequenceWorkerFactory(null);
});

test('abort teardown: the worker is told, the run rejects coded, and the thread is terminated', async () => {
  useFakeWorker();
  const p = renderSequenceInWorker(job([layer()]), PICK, 1000, null, null, emptyIo);
  const w = await spawned();
  abortSequenceWorkerRenders('user cancelled');
  const err = await p.then(() => null, (e: unknown) => e);
  assert.ok(err instanceof SequenceError);
  assert.equal((err as SequenceError).code, 'SEQ_ABORTED');
  assert.equal((w.posted.at(-1) as { type: string }).type, 'abort', 'the loop is asked to unwind itself');
  // Terminating in the SAME task would mean the worker never even dequeues the
  // abort we just posted, making every cancel a hard kill mid-decode. It is given
  // one grace period to dispose its decoders and abort its muxer, and is then
  // killed regardless — the thread is never leaked.
  assert.equal(w.terminated, 0, 'not killed before it can act on the abort');
  await new Promise((r) => setTimeout(r, SEQ_ABORT_GRACE_MS + 20));
  assert.equal(w.terminated, 1, 'and the thread is not leaked even if it never answers');
  abortSequenceWorkerRenders();                 // idempotent
  assert.equal(w.terminated, 1);

  // A later render spawns a FRESH worker rather than reusing the dead one.
  FakeWorker.last = null;
  const p2 = renderSequenceInWorker(job([layer()]), PICK, 1000, null, null, emptyIo);
  const w2 = await spawned();
  assert.notEqual(w2, w, 'the next run gets a new thread');
  abortSequenceWorkerRenders();
  await p2.catch(() => {});
  _setSequenceWorkerFactory(null);
});

// ── determinism by construction ─────────────────────────────────────────────

test('contract: there is exactly ONE compositor, so the two paths cannot drift', () => {
  const worker = strip(read('./sequence-render.worker.ts'));
  const render = strip(read('./sequence-render.ts'));
  assert.match(worker, /export async function drawItem\(/, 'drawItem lives in the executor');
  assert.ok(!/function drawItem\(/.test(render), 'and nowhere else');
  // The one drawImage left in sequence-render.ts is the MediaRecorder fallback's
  // replay of ALREADY-COMPOSED frames — a playback pump, not a compositor.
  const paints = render.match(/ctx\.drawImage\(/g) ?? [];
  assert.equal(paints.length, 1, 'sequence-render.ts composites nothing; the executor draws');
  assert.match(render, /drawImage\(bitmaps\[i\+\+\]/, 'and that one is the recorder replay');
  assert.match(render, /await runSequenceJob\(job, canvas, ctx,/, 'the in-thread path drives the shared executor');
  assert.match(worker, /await runSequenceJob\(job, canvas, ctx,/, 'and so does the worker');
});

test('contract: the executor is DOM-free, so it can actually load in worker scope', () => {
  const worker = strip(read('./sequence-render.worker.ts'));
  for (const banned of [/\bdocument\./, /\bwindow\./, /dom-to-image/, /from '\.\.\/views\//]) {
    assert.ok(!banned.test(worker), `the worker module must not reference ${String(banned)}`);
  }
  // The one document reference allowed is the worker-scope PROBE, which reads
  // `typeof document` to prove it is NOT on the main thread.
  assert.match(worker, /typeof g\.document === 'undefined'/, 'and it guards its own message listener');
});

test('contract: the offload is opt-in behind the same flag as the video-encode worker', () => {
  assert.match(strip(read('./sequence-render.ts')), /localStorage\.getItem\('lolly\.workerEncode'\)/);
  assert.match(strip(read('./video-encode.ts')), /localStorage\.getItem\('lolly\.workerEncode'\)/);
});
