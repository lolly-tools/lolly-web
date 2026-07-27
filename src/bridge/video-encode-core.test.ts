// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the STREAMING encode+mux session (createStreamingMux).
 *
 * WebCodecs doesn't exist in node, so the session is driven through its injection
 * seam: stub VideoEncoder / AudioEncoder / VideoFrame / AudioData classes plus a
 * stub muxer factory. That covers everything except the actual codec — frame
 * timing, keyframe cadence, backpressure, VideoFrame lifetime, flush ordering,
 * abort teardown and post-finalize rejection are all exercised here rather than
 * only in a browser.
 *
 * Run directly:  node --test shells/web/src/bridge/video-encode-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamingMux, HIGH_WATER, type EncodePick, type EncodeOpts } from './video-encode-core.ts';
import { videoFrameSchedule } from './video-mime.ts';

// ── Stubs ─────────────────────────────────────────────────────────────────────

interface FrameLog { src: unknown; timestamp: number; duration: number; closes: number }

/** Every VideoFrame the session constructs, in order — so a leak or a double
 *  close is directly assertable. */
let frameLog: FrameLog[] = [];

class StubVideoFrame {
  rec: FrameLog;
  constructor(src: unknown, init: { timestamp: number; duration: number }) {
    this.rec = { src, timestamp: init.timestamp, duration: init.duration, closes: 0 };
    frameLog.push(this.rec);
  }
  close(): void { this.rec.closes++; }
}

let audioLog: { timestamp: number; numberOfFrames: number; sample: number; closes: number }[] = [];

class StubAudioData {
  rec: { timestamp: number; numberOfFrames: number; sample: number; closes: number };
  constructor(init: any) {
    this.rec = { timestamp: init.timestamp, numberOfFrames: init.numberOfFrames, sample: init.data[0], closes: 0 };
    audioLog.push(this.rec);
  }
  close(): void { this.rec.closes++; }
}

/** Minimal VideoEncoder/AudioEncoder shape: records calls, supports 'dequeue'. */
class StubEncoder {
  static instances: StubEncoder[] = [];
  config: any = null;
  encodes: { frame: any; opts: any }[] = [];
  flushed = 0;
  closed = 0;
  encodeQueueSize = 0;
  order: string[];
  listeners: (() => void)[] = [];
  cb: { output: (c: unknown, m: unknown) => void; error: (e: unknown) => void };
  constructor(cb: any, order: string[] = []) { this.cb = cb; this.order = order; StubEncoder.instances.push(this); }
  configure(c: any): void { this.config = c; }
  encode(frame: any, opts?: any): void { this.encodes.push({ frame, opts }); }
  addEventListener(_type: string, fn: () => void): void { this.listeners.push(fn); }
  removeEventListener(_type: string, fn: () => void): void {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  dispatchDequeue(): void { for (const fn of [...this.listeners]) fn(); }
  async flush(): Promise<void> { this.flushed++; this.order.push(`flush:${this.tag}`); }
  close(): void { this.closed++; this.order.push(`close:${this.tag}`); }
  tag = 'enc';
}

class StubMuxer {
  video: unknown[] = [];
  audio: unknown[] = [];
  finalized = 0;
  order: string[];
  constructor(order: string[]) { this.order = order; }
  addVideoChunk(c: unknown): void { this.video.push(c); }
  addAudioChunk(c: unknown): void { this.audio.push(c); }
  finalize(): void { this.finalized++; this.order.push('mux:finalize'); }
}

function stubAudioBuffer(length: number, channels = 2, sampleRate = 48_000): any {
  const data = Array.from({ length: channels }, (_, ch) => {
    const arr = new Float32Array(length);
    for (let i = 0; i < length; i++) arr[i] = ch + i / 1e6;
    return arr;
  });
  return { length, numberOfChannels: channels, sampleRate, getChannelData: (ch: number) => data[ch]! };
}

const PICK_WEBM: EncodePick = { container: 'webm', codec: 'vp09.00.10.08', muxCodec: 'V_VP9' };
const PICK_MP4: EncodePick = { container: 'mp4', codec: 'avc1.42001f', muxCodec: 'avc' };

interface Harness {
  order: string[];
  muxer: StubMuxer;
  video: StubEncoder;
  audio: StubEncoder | null;
  target: { buffer: ArrayBuffer };
}

function harness(opts: Partial<EncodeOpts> = {}, pick: EncodePick = PICK_WEBM) {
  frameLog = [];
  audioLog = [];
  StubEncoder.instances = [];
  const order: string[] = [];
  const muxer = new StubMuxer(order);
  const target = { buffer: new ArrayBuffer(8) };
  const o: EncodeOpts = { width: 640, height: 360, fps: 24, bitrate: 1_000_000, ...opts };
  const h: Harness = { order, muxer, video: null as any, audio: null, target };
  const session = createStreamingMux(pick, o, {
    muxerFactory: async () => ({ muxer, target, type: pick.container === 'mp4' ? 'video/mp4' : 'video/webm' }),
    VideoEncoder: class extends StubEncoder {
      constructor(cb: any) { super(cb, order); this.tag = 'video'; h.video = this; }
    },
    AudioEncoder: class extends StubEncoder {
      constructor(cb: any) { super(cb, order); this.tag = 'audio'; h.audio = this; }
    },
    VideoFrame: StubVideoFrame,
    AudioData: StubAudioData,
  });
  return { session, h };
}

const AUDIO = { channels: [], sampleRate: 48_000, numberOfChannels: 2, codec: 'opus', muxCodec: 'A_OPUS', bitrate: 128_000 };

/** Let pending microtasks + one macrotask turn run, without reaching the 25ms
 *  dequeue fallback timer. */
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

// ── Tests ─────────────────────────────────────────────────────────────────────

test('createStreamingMux: encodes each frame once and closes every VideoFrame exactly once', async () => {
  const { session, h } = harness();
  const mux = await session;
  const canvas = { tag: 'canvas' } as any;
  for (let i = 0; i < 5; i++) await mux.addFrame(canvas, Math.round(i * 1e6 / 24));

  assert.equal(h.video.encodes.length, 5);
  assert.equal(frameLog.length, 5);
  assert.deepEqual(frameLog.map((f) => f.closes), [1, 1, 1, 1, 1]);
  assert.deepEqual(frameLog.map((f) => f.src), Array(5).fill(canvas));
});

test('createStreamingMux: timestamps + keyframe cadence match videoFrameSchedule', async () => {
  const fps = 24;
  const { session, h } = harness({ fps });
  const mux = await session;
  const want = videoFrameSchedule(50, fps);
  for (const t of want) await mux.addFrame({} as any, t.timestampUs);

  assert.deepEqual(frameLog.map((f) => f.timestamp), want.map((t) => t.timestampUs));
  assert.deepEqual(frameLog.map((f) => f.duration), want.map((t) => t.durationUs));
  assert.deepEqual(h.video.encodes.map((e) => e.opts.keyFrame), want.map((t) => t.keyFrame));
  // keyEvery = round(24*2) = 48 → frames 0 and 48 only
  assert.deepEqual(
    h.video.encodes.map((e, i) => (e.opts.keyFrame ? i : -1)).filter((i) => i >= 0),
    [0, 48],
  );
});

test('createStreamingMux: addFrame awaits while encodeQueueSize > HIGH_WATER, resumes on dequeue', async () => {
  const { session, h } = harness();
  const mux = await session;

  h.video.encodeQueueSize = HIGH_WATER + 1;
  let settled = false;
  const p = mux.addFrame({} as any, 0).then(() => { settled = true; });

  await tick(); await tick();
  assert.equal(settled, false, 'addFrame must not resolve while the encoder queue is above the high-water mark');
  assert.equal(h.video.encodes.length, 1, 'the frame is handed to the encoder before the wait');
  assert.equal(frameLog[0]!.closes, 1, 'and closed before the wait — never held across backpressure');

  // A dequeue that does not drop the queue below the mark keeps us waiting.
  h.video.dispatchDequeue();
  await tick(); await tick();
  assert.equal(settled, false);

  h.video.encodeQueueSize = 0;
  h.video.dispatchDequeue();
  await p;
  assert.equal(settled, true);
  assert.equal(h.video.listeners.length, 0, 'every dequeue listener is removed again');
});

test('createStreamingMux: at most HIGH_WATER+1 frames are alive at once', async () => {
  const { session, h } = harness();
  const mux = await session;
  // The encoder drains one slot per encode; the session must never run ahead of it.
  let live = 0, peak = 0;
  const origEncode = h.video.encode.bind(h.video);
  h.video.encode = (frame: any, opts: any) => {
    live++; peak = Math.max(peak, live);
    h.video.encodeQueueSize = live;
    origEncode(frame, opts);
    queueMicrotask(() => { live = Math.max(0, live - 1); h.video.encodeQueueSize = live; h.video.dispatchDequeue(); });
  };
  for (let i = 0; i < 40; i++) await mux.addFrame({} as any, i * 1000);
  assert.ok(peak <= HIGH_WATER + 1, `peak in-flight ${peak} exceeded HIGH_WATER+1 (${HIGH_WATER + 1})`);
  assert.deepEqual([...new Set(frameLog.map((f) => f.closes))], [1]);
});

test('createStreamingMux: finalize flushes video, then audio, then the muxer, and returns a Blob', async () => {
  const { session, h } = harness({ audio: AUDIO });
  const mux = await session;
  await mux.addFrame({} as any, 0);
  const blob = await mux.finalize();

  assert.deepEqual(h.order, ['flush:video', 'close:video', 'flush:audio', 'close:audio', 'mux:finalize']);
  assert.equal(h.muxer.finalized, 1);
  assert.equal(blob.type, 'video/webm');
  assert.equal(blob.size, 8);
});

test('createStreamingMux: mp4 pins avc format, webm does not', async () => {
  const a = harness({}, PICK_MP4);
  await a.session;
  assert.deepEqual(a.h.video.config.avc, { format: 'avc' });
  assert.equal(a.h.video.config.codec, 'avc1.42001f');

  const b = harness({}, PICK_WEBM);
  await b.session;
  assert.equal(b.h.video.config.avc, undefined);
});

test('createStreamingMux: addFrame/addAudio/finalize after finalize reject cleanly', async () => {
  const { session } = harness({ audio: AUDIO });
  const mux = await session;
  await mux.addFrame({} as any, 0);
  await mux.finalize();

  await assert.rejects(() => mux.addFrame({} as any, 1000), /streaming mux is closed/);
  await assert.rejects(() => mux.addAudio(stubAudioBuffer(100)), /streaming mux is closed/);
  await assert.rejects(() => mux.finalize(), /streaming mux is closed/);
  assert.equal(frameLog.length, 1, 'a rejected addFrame must not construct a VideoFrame');
});

test('createStreamingMux: abort after N frames leaves nothing pending and never finalizes', async () => {
  const { session, h } = harness({ audio: AUDIO });
  const mux = await session;
  for (let i = 0; i < 3; i++) await mux.addFrame({} as any, i * 1000);

  await mux.abort(new Error('cancelled'));

  assert.equal(h.video.closed, 1);
  assert.equal(h.audio!.closed, 1);
  assert.equal(h.video.flushed, 0, 'abort must not flush — the output is being discarded');
  assert.equal(h.muxer.finalized, 0);
  assert.deepEqual([...new Set(frameLog.map((f) => f.closes))], [1], 'no VideoFrame leaked past abort');
  assert.equal(h.video.listeners.length, 0);

  await mux.abort();                                    // idempotent
  assert.equal(h.video.closed, 1);
  await assert.rejects(() => mux.addFrame({} as any, 0), /streaming mux is closed/);
});

test('createStreamingMux: an encoder error surfaces on the next addFrame and on finalize', async () => {
  const { session, h } = harness();
  const mux = await session;
  await mux.addFrame({} as any, 0);
  h.video.cb.error(new Error('encoder exploded'));

  await assert.rejects(() => mux.addFrame({} as any, 1000), /encoder exploded/);
  await assert.rejects(() => mux.finalize(), /encoder exploded/);
  assert.equal(h.muxer.finalized, 0, 'a failed session must not produce a container');
});

test('createStreamingMux: video chunks reach the muxer through the encoder output callback', async () => {
  const { session, h } = harness();
  const mux = await session;
  await mux.addFrame({} as any, 0);
  h.video.cb.output({ chunk: 1 }, { meta: true });
  assert.deepEqual(h.muxer.video, [{ chunk: 1 }]);
});

test('createStreamingMux: addAudio chunks PCM and continues timestamps across buffers', async () => {
  const { session, h } = harness({ audio: AUDIO });
  const mux = await session;

  await mux.addAudio(stubAudioBuffer(11_000));          // 4800 + 4800 + 1400
  await mux.addAudio(stubAudioBuffer(4800));

  assert.deepEqual(audioLog.map((a) => a.numberOfFrames), [4800, 4800, 1400, 4800]);
  const us = (frames: number): number => Math.round((frames / 48_000) * 1e6);
  assert.deepEqual(audioLog.map((a) => a.timestamp), [us(0), us(4800), us(9600), us(11_000)]);
  assert.deepEqual([...new Set(audioLog.map((a) => a.closes))], [1], 'every AudioData is closed exactly once');
  assert.equal(h.audio!.encodes.length, 4);
});

test('createStreamingMux: addAudio without a declared audio track rejects; empty buffer is a no-op', async () => {
  const { session } = harness();                        // no opts.audio
  const mux = await session;
  await assert.rejects(() => mux.addAudio(stubAudioBuffer(100)), /no audio track/);

  const withAudio = harness({ audio: AUDIO });
  const m2 = await withAudio.session;
  await m2.addAudio(stubAudioBuffer(0));
  assert.equal(audioLog.length, 0);
});
