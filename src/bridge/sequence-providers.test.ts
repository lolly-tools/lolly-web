// SPDX-License-Identifier: MPL-2.0
/**
 * sequence-providers.test.ts — the headless half of the phase-3 provider layer.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. Node has no WebCodecs, no canvas and no
 * <video>, so nothing here touches a real decoder. What it does cover is every
 * decision the module makes *around* the decoder, which is where the bugs that
 * silently corrupt an export live:
 *
 *   • the provider pick ladder (per clip, not per session) with injected fakes
 *   • the primed-grid matcher — forward runs, skips, backwards requests
 *   • the in-flight ledger: never more than MAX_IN_FLIGHT, every sample closed,
 *     including the ones skipped over and the ones whose draw threw
 *   • the PCM window trim (spike rule 6) and its resample
 *   • error normalisation through the plan module's `toCodedError` vocabulary
 *   • dispose idempotency and post-dispose behaviour
 *   • a source guard: no static mediabunny import, no ALL_FORMATS
 *
 * ONLY THE BROWSER TIER CAN PROVE: that a real `VideoSample.draw` lands the
 * right pixels in the right rect (including container rotation), that
 * `samplesAtTimestamps` really is frame-accurate on a fixed grid, that a real
 * hidden <video> seek confirms through rVFC, and that the memory ceiling the
 * MAX_IN_FLIGHT policy exists for is actually respected by the platform. Those
 * belong to the Playwright tier and must be gated on a codec-capable channel —
 * Playwright's bundled Chromium has no H.264/AAC.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MAX_IN_FLIGHT,
  TS_EPSILON_S,
  assemblePcmWindow,
  createClipAudio,
  createElementProvider,
  createVideoProvider,
  isSeqTimeout,
  planPull,
  providerCapability,
  resampleLinear,
  withTimeout,
  type InstrumentedProvider,
  type MediabunnyModule,
  type PcmChunk,
  type ProviderOpts,
} from './sequence-providers.ts';
import { SequenceError, reconcileDecoded } from './sequence-plan.ts';

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeSample {
  timestamp: number;
  duration: number;
  draws: number;
  closes: number;
  throwOnDraw?: boolean;
  draw(): void;
  close(): void;
}

function makeSample(timestamp: number, throwOnDraw = false): FakeSample {
  return {
    timestamp,
    duration: 1 / 30,
    draws: 0,
    closes: 0,
    throwOnDraw,
    draw() {
      this.draws++;
      if (this.throwOnDraw) throw new Error('draw failed');
    },
    close() { this.closes++; },
  };
}

interface FakeVideoOpts {
  /** Timestamps the source actually has. A request past the last yields null. */
  frames?: number[];
  /** Stop the primed generator after this many yields (silent truncation). */
  truncateAfter?: number;
  /** Make the sample at this index throw from draw(). */
  throwDrawAt?: number;
  /** Never settle the Nth primed pull (a stalled decoder). */
  stallPullAt?: number;
  canDecode?: boolean;
  hasVideoTrack?: boolean;
  hasAudioTrack?: boolean;
  audioChunks?: PcmChunk[];
  durationSec?: number;
  /** Throw from `new Input(...)`'s first read, with this error. */
  openError?: unknown;
}

interface FakeWorld {
  module: MediabunnyModule;
  samples: FakeSample[];
  disposeCount: number;
  generatorReturns: number;
  audioRanges: { from?: number; to?: number }[];
}

function fakeMediabunny(o: FakeVideoOpts = {}): FakeWorld {
  const frames = o.frames ?? Array.from({ length: 12 }, (_, i) => i / 30);
  const world: FakeWorld = { module: null as unknown as MediabunnyModule, samples: [], disposeCount: 0, generatorReturns: 0, audioRanges: [] };
  let pulled = 0;

  const sampleFor = (t: number): FakeSample | null => {
    // The nearest frame at or before t — the real sink's contract.
    let best: number | null = null;
    for (const f of frames) if (f <= t + TS_EPSILON_S && (best === null || f > best)) best = f;
    if (best === null) return null;
    const s = makeSample(best, world.samples.length === o.throwDrawAt);
    world.samples.push(s);
    return s;
  };

  class FakeVideoSink {
    async getSample(t: number): Promise<FakeSample | null> {
      return sampleFor(t);
    }
    async *samplesAtTimestamps(timestamps: Iterable<number>): AsyncGenerator<FakeSample | null, void, unknown> {
      try {
        let n = 0;
        for (const t of timestamps) {
          if (o.truncateAfter !== undefined && n >= o.truncateAfter) return;
          if (o.stallPullAt !== undefined && n === o.stallPullAt) {
            await new Promise(() => { /* never settles: a stalled decoder */ });
          }
          n++;
          pulled++;
          yield sampleFor(t);
        }
      } finally {
        world.generatorReturns++;
      }
    }
    get pulls(): number { return pulled; }
  }

  class FakeAudioSink {
    async *buffers(from?: number, to?: number): AsyncGenerator<unknown, void, unknown> {
      world.audioRanges.push({ from, to });
      for (const chunk of o.audioChunks ?? []) {
        yield {
          timestamp: chunk.timestamp,
          duration: (chunk.channels[0]?.length ?? 0) / chunk.sampleRate,
          buffer: {
            sampleRate: chunk.sampleRate,
            numberOfChannels: chunk.channels.length,
            length: chunk.channels[0]?.length ?? 0,
            getChannelData: (c: number) => chunk.channels[c] as Float32Array,
          },
        };
      }
    }
  }

  const videoTrack = {
    canDecode: async () => o.canDecode !== false,
    getDisplayWidth: async () => 640,
    getDisplayHeight: async () => 360,
  };
  const audioTrack = {
    canDecode: async () => o.canDecode !== false,
    getSampleRate: async () => 48000,
  };

  class FakeInput {
    async getPrimaryVideoTrack() {
      if (o.openError) throw o.openError;
      return o.hasVideoTrack === false ? null : videoTrack;
    }
    async getPrimaryAudioTrack() {
      if (o.openError) throw o.openError;
      return o.hasAudioTrack === false ? null : audioTrack;
    }
    async computeDuration() { return o.durationSec ?? frames.length / 30; }
    dispose() { world.disposeCount++; }
  }

  world.module = {
    Input: FakeInput as unknown as MediabunnyModule['Input'],
    BlobSource: class { blob: Blob; constructor(b: Blob) { this.blob = b; } } as unknown as MediabunnyModule['BlobSource'],
    UrlSource: class { url: string; constructor(u: string) { this.url = u; } } as unknown as MediabunnyModule['UrlSource'],
    VideoSampleSink: FakeVideoSink as unknown as MediabunnyModule['VideoSampleSink'],
    AudioBufferSink: FakeAudioSink as unknown as MediabunnyModule['AudioBufferSink'],
    MP4: 'MP4',
    QTFF: 'QTFF',
    WEBM: 'WEBM',
    MATROSKA: 'MATROSKA',
  };
  return world;
}

const fakeCtx = {} as CanvasRenderingContext2D;
const dest = { dx: 0, dy: 0, dw: 640, dh: 360 };

function mbOpts(world: FakeWorld, extra: Partial<ProviderOpts> = {}): ProviderOpts {
  return {
    ...extra,
    deps: { loadMediabunny: async () => world.module, hasWebCodecs: () => true, ...(extra.deps ?? {}) },
  };
}

// ── source guard (rule 5: lazy, explicit singletons only) ───────────────────

test('source guard: mediabunny is lazy-imported and never via ALL_FORMATS', () => {
  const src = readFileSync(fileURLToPath(new URL('./sequence-providers.ts', import.meta.url)), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments (the header talks about all of this)
    .replace(/^\s*\/\/.*$/gm, '');         // line comments

  assert.equal(/^\s*import[\s\S]*?from\s+['"]mediabunny['"]/m.test(code), false,
    'static import of mediabunny: +352kB (+89kB gzip) on the preload entry');
  assert.equal(code.includes('ALL_FORMATS'), false,
    'ALL_FORMATS drags MP3/WAVE/Ogg/FLAC/ADTS/TS/HLS in: 92kB gzip vs 60kB');
  assert.match(code, /await import\('mediabunny'\)/, 'the lazy import must survive with a literal specifier');
  for (const singleton of ['MP4', 'QTFF', 'WEBM', 'MATROSKA']) {
    assert.match(code, new RegExp(`m\\.${singleton}\\b`), `explicit ${singleton} singleton must be imported`);
  }
});

// ── capability ──────────────────────────────────────────────────────────────

test('providerCapability reports WebCodecs presence', async () => {
  const g = globalThis as Record<string, unknown>;
  assert.equal((await providerCapability()).webcodecs, false, 'node has no VideoDecoder');
  g.VideoDecoder = { isConfigSupported: () => Promise.resolve({ supported: true }) };
  try {
    assert.equal((await providerCapability()).webcodecs, true);
  } finally {
    delete g.VideoDecoder;
  }
});

// ── withTimeout ─────────────────────────────────────────────────────────────

test('withTimeout resolves, rejects coded, and is a no-op for a non-positive budget', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'x'), 7);

  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, 'decode'),
    (err: unknown) => {
      assert.ok(err instanceof SequenceError);
      assert.equal((err as SequenceError).code, 'SEQ_DECODE_FAILED');
      assert.equal(isSeqTimeout(err), true, 'a deadline must be distinguishable from a decoder refusal');
      return true;
    },
  );

  // 0 means "no deadline" — the same promise object comes back, so a caller that
  // disables the budget pays nothing at all.
  const p = Promise.resolve(1);
  assert.equal(withTimeout(p, 0, 'x'), p);
});

// ── the primed-grid matcher ─────────────────────────────────────────────────

test('planPull walks a monotonic grid one frame at a time', () => {
  const grid = [0, 1 / 30, 2 / 30, 3 / 30];
  assert.deepEqual(planPull(grid, 0, 0), { mode: 'primed', advance: 1, index: 0 });
  assert.deepEqual(planPull(grid, 1, 1 / 30), { mode: 'primed', advance: 1, index: 1 });
});

test('planPull absorbs a forward skip by pulling and discarding', () => {
  const grid = [0, 1, 2, 3, 4];
  // The caller jumped from index 0 to index 3 (a clip hidden for two frames).
  assert.deepEqual(planPull(grid, 0, 3), { mode: 'primed', advance: 4, index: 3 });
});

test('planPull sends backwards and off-grid requests to random access', () => {
  const grid = [0, 1, 2, 3];
  assert.equal(planPull(grid, 2, 1).mode, 'random', 'an async generator cannot rewind');
  assert.equal(planPull(grid, 0, 1.5).mode, 'random', 'a time between grid points is not on the grid');
  assert.equal(planPull(grid, 4, 0).mode, 'random', 'cursor past the end');
  assert.equal(planPull([], 0, 0).mode, 'random');
});

test('planPull matches within TS_EPSILON_S and bounds its forward scan', () => {
  const grid = [0, 1, 2];
  assert.equal(planPull(grid, 0, TS_EPSILON_S / 2).mode, 'primed', 'float noise must not fall off the fast path');
  const long = Array.from({ length: 1000 }, (_, i) => i);
  assert.equal(planPull(long, 0, 900, 16).mode, 'random', 'a far-forward jump degrades to one getSample');
});

// ── PCM window: the packet-granularity trim (spike rule 6) ──────────────────

const ramp = (n: number, start = 0): Float32Array => Float32Array.from({ length: n }, (_, i) => start + i);

test('assemblePcmWindow trims the straddling first and last packets', () => {
  // Packets of 10 samples at 10 Hz (1 s each). Window is [1.5, 2.5) — the sink
  // hands back the packets straddling both ends, and an untrimmed concat would
  // start 0.5 s of a neighbour early and run 0.5 s late.
  const chunks: PcmChunk[] = [
    { channels: [ramp(10, 100)], sampleRate: 10, timestamp: 1 },
    { channels: [ramp(10, 200)], sampleRate: 10, timestamp: 2 },
  ];
  const out = assemblePcmWindow(chunks, 1.5, 2.5, 10);
  assert.equal(out.channels.length, 1);
  const ch = out.channels[0] as Float32Array;
  assert.equal(ch.length, 10, 'exactly one second at 10 Hz');
  // First half is the SECOND half of packet one (105..109), second half is the
  // FIRST half of packet two (200..204).
  assert.deepEqual([...ch], [105, 106, 107, 108, 109, 200, 201, 202, 203, 204]);
});

test('assemblePcmWindow leaves silence in a gap rather than sliding audio earlier', () => {
  const chunks: PcmChunk[] = [{ channels: [ramp(5, 1)], sampleRate: 10, timestamp: 0.5 }];
  const out = assemblePcmWindow(chunks, 0, 1, 10);
  assert.deepEqual([...(out.channels[0] as Float32Array)], [0, 0, 0, 0, 0, 1, 2, 3, 4, 5]);
});

test('assemblePcmWindow duplicates a mono source across the window channels', () => {
  const chunks: PcmChunk[] = [
    { channels: [ramp(4, 1), ramp(4, 10)], sampleRate: 10, timestamp: 0 },
    { channels: [ramp(4, 100)], sampleRate: 10, timestamp: 0.4 },
  ];
  const out = assemblePcmWindow(chunks, 0, 0.8, 10);
  assert.equal(out.channels.length, 2);
  assert.deepEqual([...(out.channels[0] as Float32Array)], [1, 2, 3, 4, 100, 101, 102, 103]);
  assert.deepEqual([...(out.channels[1] as Float32Array)], [10, 11, 12, 13, 100, 101, 102, 103]);
});

test('assemblePcmWindow drops packets wholly outside the window', () => {
  const chunks: PcmChunk[] = [
    { channels: [ramp(10, 1)], sampleRate: 10, timestamp: 0 },
    { channels: [ramp(10, 50)], sampleRate: 10, timestamp: 5 },
  ];
  const out = assemblePcmWindow(chunks, 2, 3, 10);
  assert.deepEqual([...(out.channels[0] as Float32Array)], new Array(10).fill(0));
});

test('assemblePcmWindow resamples a mismatched clip rate onto the mix rate', () => {
  const chunks: PcmChunk[] = [{ channels: [Float32Array.from([0, 1, 0, 1])], sampleRate: 8000, timestamp: 0 }];
  const out = assemblePcmWindow(chunks, 0, 4 / 8000, 16000);
  assert.equal(out.sampleRate, 16000);
  assert.equal((out.channels[0] as Float32Array).length, 8);
  // Halfway between 0 and 1 is 0.5 with linear interpolation.
  assert.equal((out.channels[0] as Float32Array)[1], 0.5);
});

test('assemblePcmWindow returns no channels for an empty or degenerate window', () => {
  assert.deepEqual(assemblePcmWindow([], 0, 1, 48000).channels, []);
  const chunks: PcmChunk[] = [{ channels: [ramp(10)], sampleRate: 10, timestamp: 0 }];
  assert.deepEqual(assemblePcmWindow(chunks, 1, 1, 10).channels, []);
});

test('resampleLinear holds the last sample rather than reading past the end', () => {
  const out = resampleLinear(Float32Array.from([0, 2]), 10, 20, 5);
  assert.deepEqual([...out], [0, 1, 2, 2, 2]);
  assert.deepEqual([...resampleLinear(new Float32Array(0), 10, 20, 3)], [0, 0, 0]);
});

// ── the pick ladder (per clip, not per session) ─────────────────────────────

function stubElementProvider(record: { calls: number; url?: string }): NonNullable<ProviderOpts['deps']>['elementProvider'] {
  return async (url) => {
    record.calls++;
    record.url = url;
    const stats = {
      kind: 'element' as const, inFlight: 0, maxInFlight: 0, decoded: 0, missed: 0,
      requests: 0, firstRequestSec: -1, lastRequestSec: -1, unreachable: 0,
      claimedDurationSec: 1, sourceFrameSec: 0, lastSourceSec: -1, randomAccess: true,
    };
    const p: InstrumentedProvider = {
      w: 320, h: 180,
      durationSec: () => 1,
      stats: () => ({ ...stats }),
      drawAt: async () => true,
      dispose: async () => {},
    };
    return p;
  };
}

test('pick ladder: no WebCodecs goes straight to element seek, without loading mediabunny', async () => {
  const rec = { calls: 0 };
  let loaded = 0;
  const p = await createVideoProvider('https://example.test/clip.mp4', {
    deps: {
      hasWebCodecs: () => false,
      loadMediabunny: async () => { loaded++; return fakeMediabunny().module; },
      elementProvider: stubElementProvider(rec),
    },
  });
  assert.equal(p.stats().kind, 'element');
  assert.equal(rec.calls, 1);
  assert.equal(loaded, 0, 'the 60kB chunk must not be fetched when it cannot be used');
});

test('pick ladder: forceElement wins even where WebCodecs exists', async () => {
  const rec = { calls: 0 };
  const world = fakeMediabunny();
  const p = await createVideoProvider('https://example.test/clip.mp4', {
    forceElement: true,
    deps: { hasWebCodecs: () => true, loadMediabunny: async () => world.module, elementProvider: stubElementProvider(rec) },
  });
  assert.equal(p.stats().kind, 'element');
  assert.equal(rec.calls, 1);
});

test('pick ladder: a decodable track picks mediabunny and reports real dimensions', async () => {
  const world = fakeMediabunny({ durationSec: 4 });
  const p = await createVideoProvider(new Blob([new Uint8Array([1, 2, 3])]), mbOpts(world));
  assert.equal(p.stats().kind, 'mediabunny');
  assert.equal(p.w, 640);
  assert.equal(p.h, 360);
  assert.equal(p.durationSec(), 4, 'duration comes from computeDuration(), never metadata');
  await p.dispose();
});

test('pick ladder: no video track, a refused codec, or a throw all fall back PER CLIP', async () => {
  for (const [label, opts] of [
    ['no video track', { hasVideoTrack: false }],
    ['codec refused', { canDecode: false }],
    ['unreadable container', { openError: Object.assign(new Error('bad magic'), { name: 'UnsupportedInputFormatError' }) }],
  ] as [string, FakeVideoOpts][]) {
    const world = fakeMediabunny(opts);
    const rec = { calls: 0 };
    const logs: string[] = [];
    const p = await createVideoProvider('https://example.test/clip.mp4', {
      log: (_l, m) => { logs.push(m); },
      deps: { hasWebCodecs: () => true, loadMediabunny: async () => world.module, elementProvider: stubElementProvider(rec) },
    });
    assert.equal(p.stats().kind, 'element', label);
    assert.equal(rec.calls, 1, label);
    assert.equal(world.disposeCount, 1, `${label}: the half-open Input must be disposed before falling back`);
    assert.ok(logs.some((m) => m.includes('falling back')), `${label}: the reason must be logged, not swallowed`);
  }
});

test('pick ladder: when the element fallback also fails, the coded error is thrown', async () => {
  const world = fakeMediabunny({ hasVideoTrack: false });
  await assert.rejects(
    createVideoProvider('https://example.test/clip.mp4', {
      deps: {
        hasWebCodecs: () => true,
        loadMediabunny: async () => world.module,
        elementProvider: async () => { throw Object.assign(new Error('nope'), { name: 'NotSupportedError' }); },
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof SequenceError, 'a raw DOMException-shaped throw must be normalised');
      assert.equal((err as SequenceError).code, 'SEQ_NO_CODEC');
      return true;
    },
  );
});

test('the element provider refuses cleanly with no DOM instead of hanging', async () => {
  await assert.rejects(createElementProvider('https://example.test/clip.mp4'), (err: unknown) => {
    assert.ok(err instanceof SequenceError);
    assert.equal((err as SequenceError).code, 'SEQ_UNSUPPORTED_MEDIA');
    return true;
  });
});

// ── in-flight discipline ────────────────────────────────────────────────────

test('a primed sequential walk holds one sample at a time and closes every one', async () => {
  const grid = Array.from({ length: 8 }, (_, i) => i / 30);
  const world = fakeMediabunny({ frames: grid });
  const p = await createVideoProvider('https://example.test/clip.mp4', mbOpts(world));
  p.prime?.(grid);

  for (const t of grid) assert.equal(await p.drawAt(fakeCtx, t, dest), true);

  const s = p.stats();
  assert.equal(s.decoded, 8);
  assert.equal(s.inFlight, 0);
  assert.ok(s.maxInFlight <= MAX_IN_FLIGHT, `held ${s.maxInFlight} samples`);
  assert.equal(s.maxInFlight, 1, 'a straight walk never needs a second sample alive');
  assert.equal(s.randomAccess, false, 'the whole walk stayed on samplesAtTimestamps');
  assert.equal(Math.round(s.lastSourceSec * 30), 7);
  assert.ok(world.samples.every((x) => x.closes === 1), 'every sample closed exactly once');
  assert.ok(world.samples.every((x) => x.draws === 1), 'no sample decoded and then thrown away');
  await p.dispose();
});

test('frames skipped over are pulled and closed immediately, not accumulated', async () => {
  const grid = Array.from({ length: 10 }, (_, i) => i / 30);
  const world = fakeMediabunny({ frames: grid });
  const p = await createVideoProvider('https://example.test/clip.mp4', mbOpts(world));
  p.prime?.(grid);

  await p.drawAt(fakeCtx, grid[0] as number, dest);
  await p.drawAt(fakeCtx, grid[6] as number, dest);   // jumped five frames

  const s = p.stats();
  assert.ok(s.maxInFlight <= MAX_IN_FLIGHT, `held ${s.maxInFlight} — a skip must not batch closes`);
  assert.equal(s.decoded, 2, 'the skipped frames are discarded, not counted as drawn');
  assert.equal(world.samples.length, 7, 'the generator really did decode through the skip');
  assert.ok(world.samples.every((x) => x.closes === 1));
  await p.dispose();
});

test('a backwards request falls to random access and leaves the primed cursor intact', async () => {
  const grid = [0, 1 / 30, 2 / 30, 3 / 30];
  const world = fakeMediabunny({ frames: grid });
  const p = await createVideoProvider('https://example.test/clip.mp4', mbOpts(world));
  p.prime?.(grid);

  await p.drawAt(fakeCtx, grid[0] as number, dest);
  await p.drawAt(fakeCtx, grid[1] as number, dest);
  await p.drawAt(fakeCtx, grid[0] as number, dest);   // a scrub backwards
  await p.drawAt(fakeCtx, grid[2] as number, dest);   // ...and the walk resumes

  const s = p.stats();
  assert.equal(s.decoded, 4);
  assert.equal(s.inFlight, 0);
  assert.ok(world.samples.every((x) => x.closes === 1));
  await p.dispose();
});

test('an unsorted prime is refused, and every frame is served by random access', async () => {
  const world = fakeMediabunny({ frames: [0, 1 / 30, 2 / 30] });
  const p = await createVideoProvider('https://example.test/clip.mp4', mbOpts(world));
  p.prime?.([2 / 30, 0, 1 / 30]);
  assert.equal(p.stats().randomAccess, true, 'an unsorted grid defeats one-decode-per-packet — refuse it loudly');
  assert.equal(await p.drawAt(fakeCtx, 1 / 30, dest), true);
  assert.equal(p.stats().decoded, 1);
  await p.dispose();
});

test('a sample whose draw throws is still closed, and the failure is coded', async () => {
  const world = fakeMediabunny({ frames: [0], throwDrawAt: 0 });
  const p = await createVideoProvider('https://example.test/clip.mp4', mbOpts(world));
  await assert.rejects(p.drawAt(fakeCtx, 0, dest), (err: unknown) => err instanceof SequenceError);
  assert.equal(p.stats().inFlight, 0, 'the finally must run on the throwing path too');
  assert.equal((world.samples[0] as FakeSample).closes, 1);
  await p.dispose();
});

test('a stalled decoder times out, abandons the fast path, and recovers via random access', async () => {
  const grid = [0, 1 / 30, 2 / 30];
  const world = fakeMediabunny({ frames: grid, stallPullAt: 1 });
  const p = await createVideoProvider('https://example.test/clip.mp4', mbOpts(world, { timeoutMs: 20 }));
  p.prime?.(grid);

  assert.equal(await p.drawAt(fakeCtx, grid[0] as number, dest), true);
  // The second pull never settles: the deadline fires, the generator is dropped,
  // and the frame is re-served by getSample rather than failing the export.
  assert.equal(await p.drawAt(fakeCtx, grid[1] as number, dest), true);
  assert.equal(p.stats().randomAccess, true);
  assert.equal(p.stats().inFlight, 0);
  await p.dispose();
});

test('a hole in the source is a miss, not an error', async () => {
  // A source whose first frame is at 1 s (a container with a start offset): a
  // request before it has no frame to paint, and the compositor must be told
  // "nothing" rather than handed a throw that fails the whole export.
  const world = fakeMediabunny({ frames: [1, 1 + 1 / 30] });
  const p = await createVideoProvider('https://example.test/clip.mp4', mbOpts(world));
  assert.equal(await p.drawAt(fakeCtx, 0.5, dest), false);
  assert.equal(p.stats().missed, 1);
  assert.equal(p.stats().decoded, 0);
  await p.dispose();
});

// ── silent truncation: the evidence this module owes the renderer ───────────

test('a truncated container yields a short clean decode — stats feed reconcileDecoded', async () => {
  const grid = Array.from({ length: 30 }, (_, i) => i / 30);        // 1 s at 30 fps
  const world = fakeMediabunny({ frames: grid, truncateAfter: 10, durationSec: 1 });
  const p = await createVideoProvider('https://example.test/clip.mp4', mbOpts(world));
  p.prime?.(grid);
  for (const t of grid) await p.drawAt(fakeCtx, t, dest);

  const s = p.stats();
  // Nothing threw. That is the whole trap (spike rule 7) — only arithmetic sees it.
  const full = reconcileDecoded({ expectedSec: p.durationSec(), decodedFrames: s.decoded, lastTsSec: s.lastSourceSec, fps: 30 });
  assert.equal(full.ok, true, 'the fake still random-accesses the rest of the (present) file');
  const asIfTruncated = reconcileDecoded({ expectedSec: 3, decodedFrames: s.decoded, lastTsSec: s.lastSourceSec, fps: 30 });
  assert.equal(asIfTruncated.ok, false, 'a 3s source that decoded 1s must fail closed');
  assert.ok(asIfTruncated.shortfallSec > 1.9);
  await p.dispose();
});

// ── dispose ─────────────────────────────────────────────────────────────────

test('dispose is idempotent, releases the input once, and closes the generator', async () => {
  const grid = [0, 1 / 30, 2 / 30];
  const world = fakeMediabunny({ frames: grid });
  const p = await createVideoProvider('https://example.test/clip.mp4', mbOpts(world));
  p.prime?.(grid);
  await p.drawAt(fakeCtx, 0, dest);

  await p.dispose();
  await p.dispose();
  await p.dispose();

  assert.equal(world.disposeCount, 1, 'a double dispose must not double-free the decoders');
  assert.equal(world.generatorReturns, 1, 'the abandoned generator gets its return()');
  await assert.rejects(p.drawAt(fakeCtx, 0, dest), (err: unknown) => {
    assert.ok(err instanceof SequenceError);
    assert.equal((err as SequenceError).code, 'SEQ_ABORTED');
    return true;
  });
});

test('prime after dispose is a no-op rather than resurrecting a decoder', async () => {
  const world = fakeMediabunny();
  const p = await createVideoProvider('https://example.test/clip.mp4', mbOpts(world));
  await p.dispose();
  p.prime?.([0, 1 / 30]);
  assert.equal(world.generatorReturns, 0, 'no generator was ever created');
});

// ── clip audio ──────────────────────────────────────────────────────────────

test('createClipAudio returns null without WebCodecs, without a track, and on a refused codec', async () => {
  const world = fakeMediabunny();
  assert.equal(await createClipAudio('a.mp4', { deps: { hasWebCodecs: () => false, loadMediabunny: async () => world.module } }), null);

  const noTrack = fakeMediabunny({ hasAudioTrack: false });
  assert.equal(await createClipAudio('a.mp4', { deps: { hasWebCodecs: () => true, loadMediabunny: async () => noTrack.module } }), null);
  assert.equal(noTrack.disposeCount, 1, 'a silent clip must not leak its Input');

  const refused = fakeMediabunny({ canDecode: false });
  assert.equal(await createClipAudio('a.mp4', { deps: { hasWebCodecs: () => true, loadMediabunny: async () => refused.module } }), null);
  assert.equal(refused.disposeCount, 1);
});

test('createClipAudio degrades to silence (null) instead of failing an export', async () => {
  const broken = fakeMediabunny({ openError: new Error('unexpected end of file') });
  const logs: string[] = [];
  const audio = await createClipAudio('a.mp4', {
    log: (_l, m) => { logs.push(m); },
    deps: { hasWebCodecs: () => true, loadMediabunny: async () => broken.module },
  });
  assert.equal(audio, null);
  assert.ok(logs.some((m) => m.includes('SEQ_TRUNCATED')), `expected a coded reason, got ${JSON.stringify(logs)}`);
});

test('ClipAudio.pcm asks the sink for the span and returns it trimmed', async () => {
  const world = fakeMediabunny({
    audioChunks: [
      { channels: [ramp(10, 100)], sampleRate: 10, timestamp: 1 },
      { channels: [ramp(10, 200)], sampleRate: 10, timestamp: 2 },
    ],
  });
  const audio = await createClipAudio('a.mp4', { deps: { hasWebCodecs: () => true, loadMediabunny: async () => world.module } });
  assert.ok(audio);
  const out = await audio.pcm(1.5, 2.5, 10);
  assert.deepEqual(world.audioRanges, [{ from: 1.5, to: 2.5 }]);
  assert.deepEqual([...(out.channels[0] as Float32Array)], [105, 106, 107, 108, 109, 200, 201, 202, 203, 204]);

  await audio.dispose();
  await audio.dispose();
  assert.equal(world.disposeCount, 1);
  await assert.rejects(audio.pcm(0, 1, 10), (err: unknown) => err instanceof SequenceError);
});

test('ClipAudio.pcm copies the sink buffers so a recycled AudioBuffer cannot corrupt the mix', async () => {
  const shared = ramp(4, 1);
  const world = fakeMediabunny({ audioChunks: [{ channels: [shared], sampleRate: 10, timestamp: 0 }] });
  const audio = await createClipAudio('a.mp4', { deps: { hasWebCodecs: () => true, loadMediabunny: async () => world.module } });
  assert.ok(audio);
  const out = await audio.pcm(0, 0.4, 10);
  shared.fill(-1);                                    // the sink reuses its storage
  assert.deepEqual([...(out.channels[0] as Float32Array)], [1, 2, 3, 4]);
  await audio.dispose();
});
