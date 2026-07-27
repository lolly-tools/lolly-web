// SPDX-License-Identifier: MPL-2.0
/**
 * sequence-providers.ts — frame + audio sources for the sequence compositor
 * (Fable timeline, phase 3 §2.2).
 *
 * The compositor must ask one question per clip per output frame — "paint the
 * pixels of THIS source at THIS source time into THIS rectangle" — and one
 * question per clip per export — "hand me the PCM for this span". Everything
 * behind those two questions (a WebCodecs decode pipeline, a hidden <video>
 * being seeked, a container demuxer) lives in this file and nowhere else.
 *
 * WHY THE INTERFACES ARE SHAPED LIKE THIS
 *
 * `FrameProvider` is DRAW-AND-RELEASE, not "give me an image source". The spike
 * (plans/fable-timeline-phase-3.md §0.0 rule 3) established that mediabunny's
 * `VideoSample` *is* the draw wrapper: `sample.draw(ctx, dx, dy, dw, dh)` applies
 * the container's rotation metadata into the destination rect for us, while
 * `toCanvasImageSource()` may be auto-closed in the next microtask and
 * `toVideoFrame()` mints a second object with its own lifetime. Handing a
 * `CanvasImageSource` to the caller would therefore be handing out a resource
 * whose close discipline the caller cannot get right. So the provider owns the
 * sample from decode to close, and the caller only ever supplies a context and a
 * rect.
 *
 * `ClipAudio.pcm()` returns PCM that is ALREADY TRIMMED to the exact sample
 * offsets. `AudioBufferSink.buffers(a, b)` respects its range only to packet
 * granularity (AAC = 1024 frames = 21.33 ms): it includes the packet straddling
 * `a` and the one straddling `b` (spike rule 6). A caller that just concatenated
 * what the sink yields would give every clip up to 21 ms of its neighbour's
 * audio, which is audible as a click at every cut. The trim is done here, once,
 * in a pure function, so it is unit-testable without a decoder.
 *
 * RESOURCE DISCIPLINE
 *
 * At most `MAX_IN_FLIGHT` (2) decoded samples are held at any instant and every
 * one is closed in the same tick as its draw. mediabunny already self-caps its
 * decode queue at 8, and the spike could NOT reproduce a hardware-decoder stall
 * at any N — so this cap is a MEMORY policy, not a decoder-count limit, and it
 * is honest about that: the JS heap moved 1.6 MB while ~2.8 GB of frame data was
 * nominally held, which means no JS instrument can see the real ceiling. The
 * in-flight count is exposed through `stats()` precisely because it is the only
 * observable the tests have.
 *
 * NEVER HANGS. Every await in this file is inside `withTimeout`, because a
 * stalled decoder is indistinguishable from a slow one and an export that hangs
 * is worse than an export that fails. Every failure is normalised through the
 * one `toCodedError` in ./sequence-plan.ts (spike rule 8: failures arrive as
 * mediabunny typed errors, raw WebCodecs `DOMException`s, and plain `Error`s).
 *
 * TRUNCATION IS SILENT (spike rule 7): a half-written container decodes a clean,
 * short iteration with no error at all. This module cannot decide what to do
 * about that — the renderer owns the fail-closed policy — so it exposes the
 * evidence instead: `stats().decoded`, `stats().missed` and
 * `stats().lastSourceSec` against `durationSec()`.
 *
 * BUNDLE SIZE. mediabunny is `import()`ed lazily and only the four container
 * singletons we actually accept (`MP4, QTFF, WEBM, MATROSKA`) are pulled in —
 * never `ALL_FORMATS`, which drags MP3/WAVE/Ogg/FLAC/ADTS/TS/HLS along for
 * 92 kB gzip instead of 60 kB. A static import would cost the preload entry
 * +352 kB (+89 kB gzip) versus +0.14 kB lazy. `sequence-providers.test.ts` has a
 * source guard that fails the build if either rule is ever broken by an
 * innocent-looking editor auto-import.
 *
 * BROWSER-ONLY, AND WHAT ISN'T. The decode/draw path needs WebCodecs and a real
 * canvas context, so it can only be proven in the Playwright tier. Everything
 * that decides *what* to do — the provider pick ladder, the primed-grid matcher,
 * the PCM window trim/resample, the in-flight accounting, error normalisation,
 * dispose idempotency — is injectable and covered headlessly.
 */

import { createSeekQueue, METADATA_TIMEOUT_MS, type SeekQueue } from '../lib/clip-thumbs.ts';
// The element-seek fallback must behave EXACTLY like the phase-2 preview seeker,
// or a clip would export frames the editor never showed. Rather than restate the
// rules (serialise per element, confirm with requestVideoFrameCallback's
// mediaTime, one quarter-frame nudge when the decoder lands short, hard timeout),
// this imports the shipped implementation and its tuning constants from the
// clock. Nothing there is modified — this is a read-only reuse.
import {
  waitSeekConfirmed,
  SEEK_TOLERANCE_S,
  SEEK_NUDGE_S,
  MEDIA_END_EPS_S,
} from '../views/sequence-clock.ts';
// The error vocabulary is the plan module's, not a second one invented here: the
// renderer switches on `SeqErrorCode`, and a provider that minted its own codes
// would be invisible to it. `toCodedError` is the single normaliser for the three
// flavours of throw (mediabunny typed / WebCodecs DOMException / plain Error).
import { sequenceError, toCodedError, SequenceError, type SeqErrorCode } from './sequence-plan.ts';

// ── tunables ────────────────────────────────────────────────────────────────

/**
 * Decoded samples held at once. A MEMORY policy (see the header) — 16 concurrent
 * decoders ran fine in the spike, so this is not about decoder count.
 */
export const MAX_IN_FLIGHT = 2;
/** Budget for any single decode/seek/open step. A stall must fail, never hang. */
export const OP_TIMEOUT_MS = 10_000;
/** Budget for opening a container (demux + duration probe). */
export const OPEN_TIMEOUT_MS = 15_000;
/** Two timestamps closer than this are the same point on the export grid. */
export const TS_EPSILON_S = 1e-4;

/**
 * Marks a rejection produced by `withTimeout`.
 *
 * A timeout is a `SEQ_DECODE_FAILED` to the renderer like any other decode
 * failure, but INSIDE this module it needs distinguishing: it is the one failure
 * after which the primed generator's state is unknown and the fast path has to
 * be abandoned. A property rather than a distinct code, so the plan module's
 * vocabulary stays the only one anyone outside has to know.
 */
const TIMEOUT_FLAG = 'seqTimeout';

/** Did this rejection come from a deadline rather than a decoder saying no? */
export function isSeqTimeout(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as Record<string, unknown>)[TIMEOUT_FLAG] === true;
}

// ── the public contract ─────────────────────────────────────────────────────

/** Where a frame goes on the compositor's canvas, in device pixels. */
export interface DrawDest {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** What a provider can tell you about itself. The only resource observable. */
export interface ProviderStats {
  /** Which implementation answered `createVideoProvider`. */
  kind: 'mediabunny' | 'element';
  /** Samples held right now. Must never exceed MAX_IN_FLIGHT. */
  inFlight: number;
  /** High-water mark of the above, for the resource-discipline assertions. */
  maxInFlight: number;
  /** Frames successfully drawn. Half of the truncation reconciliation. */
  decoded: number;
  /** Requests that produced no frame (past the end, or a hole in the file). */
  missed: number;
  /**
   * `drawAt` calls, answered or not.
   *
   * `decoded` counts DRAWS and the compositor legitimately skips them (a fully
   * transparent box, a zero-size box, the first frame of a fade), so it is not a
   * measure of what was asked for. The truncation guard reconciles answers against
   * REQUESTS, which is what this is here for.
   */
  requests: number;
  /** Source time of the first request, seconds. -1 before the first. */
  firstRequestSec: number;
  /** Source time of the last request, seconds. -1 before the first. */
  lastRequestSec: number;
  /**
   * Requests that fell at or past the length the source CLAIMS to have.
   *
   * A clip may legitimately be trimmed longer than its media (the timeline clamps
   * `dur` to MAX_TIME_S, never to the file), and those frames can never be answered.
   * Counted separately so "the file stopped answering" stays distinguishable from
   * "we asked past the end on purpose".
   */
  unreachable: number;
  /**
   * The length the container CLAIMS, seconds — `max(computeDuration, metadata)`.
   *
   * This is the one signal that separates the two situations that look identical
   * from inside a decode: a clip trimmed past the end of an INTACT file (both
   * numbers agree, so the requests past the end are legitimately unanswerable) and a
   * TRUNCATED file (the header still claims the original length while the packets
   * stop early, so the same requests are evidence of a bad file). `computeDuration`
   * alone cannot tell them apart — it walks real packets, so on a truncated file it
   * reports the truncated length and the shortfall vanishes. 0 when unknown.
   */
  claimedDurationSec: number;
  /**
   * The source's own frame interval, seconds — the largest sample duration seen.
   * 0 when the source does not report one. The truncation tolerance needs it: a
   * decoded frame's PTS lags the requested time by up to one source frame.
   */
  sourceFrameSec: number;
  /** Source timestamp of the last frame drawn, seconds. -1 before the first. */
  lastSourceSec: number;
  /** True once the primed fast path has been abandoned (a timeout or a scrub). */
  randomAccess: boolean;
}

/**
 * One clip's pixels, addressable by source time.
 *
 * DRAW-AND-RELEASE: `drawAt` paints and disposes the underlying sample before it
 * resolves. No VideoSample, VideoFrame or CanvasImageSource ever crosses this
 * boundary — see the header for why that is a correctness rule, not a style one.
 */
export interface FrameProvider {
  /** Native display width of the source, px. */
  readonly w: number;
  /** Native display height of the source, px. */
  readonly h: number;
  /**
   * Draw the frame at `sourceSec` into `dest`. Resolves `false` when the source
   * has no frame there (past the end, or a gap) — that is not an error, and the
   * compositor is expected to leave whatever it already painted.
   */
  drawAt(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    sourceSec: number,
    dest: DrawDest,
  ): Promise<boolean>;
  /**
   * Hand over the sorted source times this export will ask for, up front. That
   * lets the mediabunny provider use `samplesAtTimestamps`, which decodes each
   * packet at most once for a monotonic list — the difference between a
   * sequential export and one random access per frame. Out-of-order requests
   * still work; they simply leave the fast path (see `stats().randomAccess`).
   */
  prime?(timestamps: number[]): void;
  /** Source duration in seconds, from a real packet walk. 0 when unknown. */
  durationSec(): number;
  /** Idempotent. Releases decoders, elements and object URLs on every path. */
  dispose(): Promise<void>;
}

/** One clip's audio, addressable by source time, already trimmed. */
export interface ClipAudio {
  /**
   * PCM for `[fromSec, toSec)`, resampled to `sampleRate` and trimmed to the
   * exact sample offsets — the sink's packet-granular range is corrected here
   * (spike rule 6). Channels are the source's; an empty array means silence.
   */
  pcm(fromSec: number, toSec: number, sampleRate: number): Promise<{ channels: Float32Array[]; sampleRate: number }>;
  /** Source duration in seconds. 0 when unknown. */
  durationSec(): number;
  /** Idempotent. */
  dispose(): Promise<void>;
}

/** Providers expose their counters through this (the interface stays minimal). */
export interface InstrumentedProvider extends FrameProvider {
  stats(): ProviderStats;
}

// ── mediabunny, structurally typed ──────────────────────────────────────────
//
// Deliberately NOT `import type { Input } from 'mediabunny'`: describing only
// the handful of members we touch keeps the fake a test can write down to a few
// lines, and makes it obvious at a glance how small the real surface area is. It
// also means a mediabunny major that changes something we don't use cannot break
// this file's types.

interface MbSample {
  readonly timestamp: number;
  readonly duration: number;
  draw(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dw?: number,
    dh?: number,
  ): void;
  close(): void;
}

interface MbVideoSink {
  getSample(timestamp: number): Promise<MbSample | null>;
  samplesAtTimestamps(timestamps: Iterable<number>): AsyncGenerator<MbSample | null, void, unknown>;
}

interface MbVideoTrack {
  canDecode(): Promise<boolean>;
  getDisplayWidth(): Promise<number>;
  getDisplayHeight(): Promise<number>;
}

interface MbAudioTrack {
  canDecode(): Promise<boolean>;
  getSampleRate(): Promise<number>;
}

interface MbWrappedAudioBuffer {
  buffer: {
    readonly sampleRate: number;
    readonly numberOfChannels: number;
    readonly length: number;
    getChannelData(channel: number): Float32Array;
  };
  timestamp: number;
  duration: number;
}

interface MbAudioSink {
  buffers(from?: number, to?: number): AsyncGenerator<MbWrappedAudioBuffer, void, unknown>;
}

interface MbInput {
  getPrimaryVideoTrack(): Promise<MbVideoTrack | null>;
  getPrimaryAudioTrack(): Promise<MbAudioTrack | null>;
  computeDuration(): Promise<number>;
  /** Optional: absent on a test fake, and null when the file states nothing. */
  getDurationFromMetadata?(): Promise<number | null>;
  dispose(): void;
}

/** The four constructors and four container singletons this module imports. */
export interface MediabunnyModule {
  Input: new (options: { formats: unknown[]; source: unknown }) => MbInput;
  BlobSource: new (blob: Blob) => unknown;
  UrlSource: new (url: string) => unknown;
  VideoSampleSink: new (track: MbVideoTrack) => MbVideoSink;
  AudioBufferSink: new (track: MbAudioTrack) => MbAudioSink;
  MP4: unknown;
  QTFF: unknown;
  WEBM: unknown;
  MATROSKA: unknown;
}

/**
 * The ONE place mediabunny is loaded.
 *
 * Named members only, and only the four format singletons — see the header. The
 * `as unknown as` is the seam between the real (much larger) declarations and
 * the structural subset above; it is a narrowing, so nothing unsafe crosses it.
 */
async function loadMediabunny(): Promise<MediabunnyModule> {
  // Literal specifier on purpose: a variable here would defeat Vite's chunking
  // and ship an unresolvable bare import to the browser.
  const m = await import('mediabunny');
  return {
    Input: m.Input,
    BlobSource: m.BlobSource,
    UrlSource: m.UrlSource,
    VideoSampleSink: m.VideoSampleSink,
    AudioBufferSink: m.AudioBufferSink,
    MP4: m.MP4,
    QTFF: m.QTFF,
    WEBM: m.WEBM,
    MATROSKA: m.MATROSKA,
  } as unknown as MediabunnyModule;
}

// ── failure normalisation + timeouts ────────────────────────────────────────

/**
 * Every throw in this file goes through here.
 *
 * `toCodedError` classifies by name and wording, which is right for a foreign
 * error but weaker than what the call site already knows — so when it can only
 * say "SEQ_DECODE_FAILED" and the caller has a specific reason (an unreadable
 * container, a refused codec), the caller's `fallback` wins. An error that is
 * already one of ours passes through untouched, so a code cannot be re-derived
 * (and downgraded) on its way up through two layers.
 */
function coded(err: unknown, fallback: SeqErrorCode): SequenceError {
  if (err instanceof SequenceError) return err;
  const c = toCodedError(err);
  const code = c.code === 'SEQ_DECODE_FAILED' && fallback !== 'SEQ_DECODE_FAILED' ? fallback : c.code;
  const out = sequenceError(code, c.message);
  if (isSeqTimeout(err)) (out as unknown as Record<string, unknown>)[TIMEOUT_FLAG] = true;
  return out;
}

/**
 * Await with a deadline. Not a cancellation — a `VideoDecoder` that has gone
 * quiet cannot be un-stuck — but it converts a hang into a coded failure the
 * renderer's watchdog can report, which is the whole difference between a stuck
 * export and a failed one.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = sequenceError('SEQ_DECODE_FAILED', `${label} timed out after ${ms}ms`);
      (e as unknown as Record<string, unknown>)[TIMEOUT_FLAG] = true;
      reject(e);
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── capability ──────────────────────────────────────────────────────────────

type CodecGlobal = typeof globalThis & {
  VideoDecoder?: { isConfigSupported?: unknown };
  AudioDecoder?: unknown;
};

/**
 * Can this browser decode through WebCodecs at all?
 *
 * Async by contract even though today's answer is synchronous: a future probe
 * (`VideoDecoder.isConfigSupported`) is per-codec and genuinely async, and
 * callers written against a sync answer would all have to change.
 */
export function providerCapability(): Promise<{ webcodecs: boolean }> {
  const g = globalThis as CodecGlobal;
  const webcodecs = typeof g.VideoDecoder !== 'undefined' && typeof g.VideoDecoder?.isConfigSupported === 'function';
  return Promise.resolve({ webcodecs });
}

// ── the primed-grid matcher (pure) ──────────────────────────────────────────

/** What `drawAt` should do with a request, given where the primed cursor sits. */
export interface PullPlan {
  /** 'primed' pulls from the sequential generator; 'random' does getSample(t). */
  mode: 'primed' | 'random';
  /**
   * For 'primed': how many samples to pull. The first `advance - 1` are frames
   * the caller skipped over and must be closed immediately; the last is the one
   * to draw.
   */
  advance: number;
  /** The primed index the cursor lands on (only meaningful for 'primed'). */
  index: number;
}

/**
 * Decide how to service a request for `t` against a primed timestamp grid.
 *
 * A fixed-fps export walks the grid in order, so the common case is `advance 1`.
 * Two things break that and both must be handled without wedging the generator:
 * a caller that skips frames (a clip that is only visible every other frame
 * because of a crossfade) walks FORWARD, which the generator can absorb by
 * pulling and discarding; a caller that goes BACKWARDS (scrub, or a second pass)
 * cannot, because an async generator has no rewind — that request falls to
 * random access.
 *
 * `window` bounds the forward scan so a wildly out-of-range request degrades to
 * one `getSample` instead of draining the whole grid.
 */
export function planPull(primed: number[], cursor: number, t: number, window = 256): PullPlan {
  if (cursor < 0 || cursor >= primed.length) return { mode: 'random', advance: 0, index: cursor };
  const last = Math.min(primed.length - 1, cursor + window);
  for (let i = cursor; i <= last; i++) {
    const ts = primed[i] as number;
    if (Math.abs(ts - t) <= TS_EPSILON_S) return { mode: 'primed', advance: i - cursor + 1, index: i };
    // The grid is sorted: once it has passed `t`, no later entry can match.
    if (ts > t + TS_EPSILON_S) break;
  }
  return { mode: 'random', advance: 0, index: cursor };
}

// ── the PCM window (pure) ───────────────────────────────────────────────────

/** One decoded audio chunk, stripped of any AudioBuffer dependency. */
export interface PcmChunk {
  /** Per-channel samples, all of the same length. */
  channels: Float32Array[];
  sampleRate: number;
  /** Presentation time of the chunk's FIRST sample, seconds. */
  timestamp: number;
}

/**
 * Linear resample of one channel. Deliberately linear, not windowed-sinc: this
 * only ever runs when a clip's own rate differs from the mix rate (48 kHz), the
 * output is a background layer under a video, and a polyphase resampler here
 * would be a large, untested chunk of DSP for an inaudible difference. If a
 * future mix needs better, `OfflineAudioContext` resampling is the drop-in.
 */
export function resampleLinear(src: Float32Array, srcRate: number, dstRate: number, dstLength: number): Float32Array {
  const out = new Float32Array(dstLength);
  if (src.length === 0 || !(srcRate > 0) || !(dstRate > 0)) return out;
  const ratio = srcRate / dstRate;
  for (let i = 0; i < dstLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    if (i0 >= src.length - 1) {
      out[i] = src[src.length - 1] as number;
      continue;
    }
    const frac = pos - i0;
    const a = src[i0] as number;
    const b = src[i0 + 1] as number;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Assemble the exact PCM window `[fromSec, toSec)` from packet-granular chunks.
 *
 * THIS IS THE TRIM (spike rule 6). `AudioBufferSink.buffers(a, b)` yields the
 * packet that straddles `a` and the packet that straddles `b`, so a naive
 * concatenation starts up to one packet (21.33 ms for AAC) EARLY and ends that
 * much late. Every clip would then bleed its neighbour's audio across the cut.
 * Here each chunk is placed at its true offset — `(chunk.timestamp - fromSec)`
 * in output samples — and anything landing outside the window is simply not
 * written, which trims both ends by construction and also fills gaps with
 * silence rather than sliding later audio earlier.
 *
 * Pure and AudioBuffer-free on purpose: this is the part of the audio path that
 * can be proven headlessly, and it is the part most likely to be subtly wrong.
 */
export function assemblePcmWindow(
  chunks: PcmChunk[],
  fromSec: number,
  toSec: number,
  sampleRate: number,
): { channels: Float32Array[]; sampleRate: number } {
  const span = Math.max(0, toSec - fromSec);
  const length = Math.max(0, Math.round(span * sampleRate));
  let channelCount = 0;
  for (const c of chunks) channelCount = Math.max(channelCount, c.channels.length);
  if (length === 0 || channelCount === 0) return { channels: [], sampleRate };

  const out: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) out.push(new Float32Array(length));

  for (const chunk of chunks) {
    if (!chunk.channels.length || !(chunk.sampleRate > 0)) continue;
    const srcLen = chunk.channels[0]?.length ?? 0;
    if (!srcLen) continue;
    const chunkEnd = chunk.timestamp + srcLen / chunk.sampleRate;
    if (chunkEnd <= fromSec || chunk.timestamp >= toSec) continue;   // wholly outside: the straddle trim

    // Resample first, then place: doing it the other way round would round the
    // offset at the source rate and drift by up to a sample per chunk.
    const needsResample = Math.abs(chunk.sampleRate - sampleRate) > 1e-6;
    const dstLen = needsResample ? Math.max(1, Math.round((srcLen / chunk.sampleRate) * sampleRate)) : srcLen;
    const dstStart = Math.round((chunk.timestamp - fromSec) * sampleRate);

    for (let c = 0; c < channelCount; c++) {
      // Mono source into a stereo window: duplicate rather than leave a dead channel.
      const src = chunk.channels[Math.min(c, chunk.channels.length - 1)] as Float32Array;
      const data = needsResample ? resampleLinear(src, chunk.sampleRate, sampleRate, dstLen) : src;
      const target = out[c] as Float32Array;
      // Head trim (chunk starts before the window) and tail trim (runs past it).
      const skip = dstStart < 0 ? -dstStart : 0;
      const writeAt = dstStart < 0 ? 0 : dstStart;
      const count = Math.min(data.length - skip, length - writeAt);
      for (let i = 0; i < count; i++) target[writeAt + i] = data[skip + i] as number;
    }
  }
  return { channels: out, sampleRate };
}

// ── in-flight accounting ────────────────────────────────────────────────────

/**
 * The sample ledger. Every acquire/release goes through it so `stats()` is not a
 * best-effort estimate but the actual count, and so an accounting bug trips a
 * coded error in a test rather than an OOM in a user's 30-second export.
 */
function createLedger(kind: 'mediabunny' | 'element') {
  const s: ProviderStats = {
    kind,
    inFlight: 0,
    maxInFlight: 0,
    decoded: 0,
    missed: 0,
    requests: 0,
    firstRequestSec: -1,
    lastRequestSec: -1,
    unreachable: 0,
    claimedDurationSec: 0,
    sourceFrameSec: 0,
    lastSourceSec: -1,
    randomAccess: false,
  };
  return {
    stats: (): ProviderStats => ({ ...s }),
    raw: s,
    /** Record one request, in the source's own time domain. */
    request(sec: number): void {
      s.requests++;
      if (s.firstRequestSec < 0) s.firstRequestSec = sec;
      s.lastRequestSec = sec;
      if (s.claimedDurationSec > 0 && sec >= s.claimedDurationSec) s.unreachable++;
    },
    acquire(): void {
      s.inFlight++;
      if (s.inFlight > s.maxInFlight) s.maxInFlight = s.inFlight;
      if (s.inFlight > MAX_IN_FLIGHT) {
        // Not a warning: exceeding the cap means a close was missed somewhere,
        // and the leak is invisible to the JS heap (see the header).
        throw coded(
          new Error(`sequence provider held ${s.inFlight} samples (max ${MAX_IN_FLIGHT})`),
          'SEQ_TOO_HEAVY',
        );
      }
    },
    release(): void {
      if (s.inFlight > 0) s.inFlight--;
    },
  };
}

// ── the mediabunny frame provider ───────────────────────────────────────────

export interface ProviderOpts {
  /** Per-operation deadline. Default OP_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Force the element-seek path (used by the renderer when a codec is refused). */
  forceElement?: boolean;
  /** Log sink; failures that are recovered from are logged, never thrown. */
  log?(level: string, msg: string): void;
  /** Test seams. Never set in production code. */
  deps?: ProviderDeps;
}

/** Everything a test needs to replace, in one bag. */
export interface ProviderDeps {
  loadMediabunny?(): Promise<MediabunnyModule>;
  hasWebCodecs?(): boolean;
  /** Build the fallback. Given a URL because a hidden <video> needs one. */
  elementProvider?(url: string, opts: ProviderOpts): Promise<InstrumentedProvider>;
}

const srcUrl = (src: Blob | string): { url: string; revoke: boolean } => {
  if (typeof src === 'string') return { url: src, revoke: false };
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw coded(new Error('no URL.createObjectURL for the element fallback'), 'SEQ_UNSUPPORTED_MEDIA');
  }
  return { url: URL.createObjectURL(src), revoke: true };
};

/**
 * Open a clip and return the best provider FOR THAT CLIP.
 *
 * Per-clip, not per-session (§2.2): a composition can mix an H.264 clip the
 * hardware decoder eats and a HEVC one it refuses, and one refusal must not
 * demote the whole export to element seeking. The ladder is:
 *
 *   no WebCodecs → element
 *   mediabunny opens + `track.canDecode()` → mediabunny
 *   anything else (unsupported container, no video track, a decoder that says
 *   no, a throw) → element, with the coded reason logged
 *
 * The element provider is genuinely last: if IT fails too, the coded error is
 * thrown, because at that point there is no way to paint the clip and silently
 * producing an export with a black hole in it is worse than failing.
 */
export async function createVideoProvider(src: Blob | string, opts: ProviderOpts = {}): Promise<InstrumentedProvider> {
  const deps = opts.deps ?? {};
  const log = opts.log ?? ((): void => {});
  const timeout = opts.timeoutMs ?? OPEN_TIMEOUT_MS;

  const wantElement = opts.forceElement === true;
  const hasWc = deps.hasWebCodecs ? deps.hasWebCodecs() : (await providerCapability()).webcodecs;

  if (!wantElement && hasWc) {
    try {
      return await withTimeout(openMediabunnyProvider(src, opts), timeout, 'open (mediabunny)');
    } catch (err) {
      const e = err as Error & { code?: string };
      log('warn', `sequence provider: mediabunny declined (${e.code ?? 'error'}: ${e.message}) — falling back to element seek`);
    }
  }
  const make = deps.elementProvider ?? createElementProvider;
  const { url, revoke } = srcUrl(src);
  try {
    return await make(url, opts);
  } catch (err) {
    if (revoke) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
    throw coded(err, 'SEQ_UNSUPPORTED_MEDIA');
  }
}

async function openMediabunnyProvider(src: Blob | string, opts: ProviderOpts): Promise<InstrumentedProvider> {
  const deps = opts.deps ?? {};
  const timeout = opts.timeoutMs ?? OP_TIMEOUT_MS;
  const mb = await (deps.loadMediabunny ?? loadMediabunny)();

  const source = typeof src === 'string' ? new mb.UrlSource(src) : new mb.BlobSource(src);
  // Explicit singletons only — see the header, and the source guard in the tests.
  const input = new mb.Input({ formats: [mb.MP4, mb.QTFF, mb.WEBM, mb.MATROSKA], source });

  let track: MbVideoTrack | null = null;
  try {
    track = await input.getPrimaryVideoTrack();
  } catch (err) {
    input.dispose();
    throw coded(err, 'SEQ_UNSUPPORTED_MEDIA');
  }
  if (!track) {
    input.dispose();
    throw coded(new Error('no video track'), 'SEQ_UNSUPPORTED_MEDIA');
  }
  // ALWAYS gate on canDecode: without it the sink throws a plain `Error` later,
  // mid-export, instead of here where the fallback is still available.
  let decodable = false;
  try {
    decodable = await track.canDecode();
  } catch { decodable = false; }
  if (!decodable) {
    input.dispose();
    throw coded(new Error('track cannot be decoded here'), 'SEQ_UNSUPPORTED_MEDIA');
  }

  let w = 0;
  let h = 0;
  let duration = 0;
  try {
    [w, h, duration] = await Promise.all([
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      // NEVER getDurationFromMetadata(): a fragmented MP4 out of MediaRecorder
      // reports 0.100 s for a 3.010 s file (spike rule 1). computeDuration costs
      // 0.2 ms and is the real answer.
      input.computeDuration(),
    ]);
  } catch (err) {
    input.dispose();
    throw coded(err, 'SEQ_UNSUPPORTED_MEDIA');
  }

  // What the file CLAIMS, alongside what it can actually deliver. Never as THE
  // duration (spike rule 1: a fragmented MP4 out of MediaRecorder reports 0.100 s
  // for a 3.010 s file) — only as the cross-check that makes a truncated container
  // distinguishable from a clip trimmed past the end of an intact one.
  let claimed = duration;
  try {
    const meta = await input.getDurationFromMetadata?.();
    if (typeof meta === 'number' && Number.isFinite(meta) && meta > claimed) claimed = meta;
  } catch { /* metadata duration is a bonus, never a requirement */ }

  const sink = new mb.VideoSampleSink(track);
  const ledger = createLedger('mediabunny');
  ledger.raw.claimedDurationSec = claimed;

  let primed: number[] = [];
  let cursor = 0;
  let gen: AsyncGenerator<MbSample | null, void, unknown> | null = null;
  let disposed = false;

  /**
   * Let the primed generator go.
   *
   * `abandoned` distinguishes the two reasons, because they mean opposite things
   * to whoever reads `stats().randomAccess`: reaching the end of the grid is the
   * fast path SUCCEEDING, while a stall or a re-prime is it being given up on.
   */
  const dropGenerator = (abandoned = true): void => {
    const g = gen;
    gen = null;
    primed = [];
    cursor = 0;
    if (abandoned) ledger.raw.randomAccess = true;
    if (g) { void Promise.resolve(g.return(undefined)).catch(() => { /* already finished */ }); }
  };

  /** Pull one sample off the primed generator, counted and time-boxed. */
  const pull = async (): Promise<MbSample | null> => {
    const g = gen;
    if (!g) return null;
    const res = await withTimeout(g.next(), timeout, 'decode (primed)');
    if (res.done) { gen = null; return null; }
    const sample = res.value;
    if (sample) ledger.acquire();
    return sample;
  };

  const closeSample = (sample: MbSample): void => {
    try { sample.close(); } finally { ledger.release(); }
  };

  const provider: InstrumentedProvider = {
    get w() { return w; },
    get h() { return h; },
    durationSec: () => duration,
    stats: ledger.stats,

    prime(timestamps) {
      if (disposed) return;
      dropGenerator();
      const list = timestamps.filter((t) => Number.isFinite(t)).map((t) => Math.max(0, t));
      // A grid that is not sorted would defeat the whole point of
      // samplesAtTimestamps (one decode per packet), so it is refused rather
      // than silently sorted — a caller handing an unsorted grid has a bug the
      // renderer needs to see, and random access still produces correct pixels.
      for (let i = 1; i < list.length; i++) {
        if ((list[i] as number) < (list[i - 1] as number)) return;
      }
      if (!list.length) return;
      primed = list;
      cursor = 0;
      ledger.raw.randomAccess = false;
      gen = sink.samplesAtTimestamps(list);
    },

    async drawAt(ctx, sourceSec, dest) {
      if (disposed) throw coded(new Error('provider disposed'), 'SEQ_ABORTED');
      const t = Number.isFinite(sourceSec) ? Math.max(0, sourceSec) : 0;
      ledger.request(t);
      let sample: MbSample | null = null;

      const plan = gen ? planPull(primed, cursor, t) : { mode: 'random' as const, advance: 0, index: cursor };
      if (plan.mode === 'primed') {
        try {
          for (let i = 0; i < plan.advance; i++) {
            const next = await pull();
            // Frames the caller skipped over: close IMMEDIATELY, never batched —
            // holding them to the end of the loop is exactly how a two-sample
            // cap becomes a hundred.
            if (sample) closeSample(sample);
            sample = next;
          }
          cursor = plan.index + 1;
          // The grid is spent: release the generator, but this is the fast path
          // finishing its job, not being abandoned.
          if (cursor >= primed.length) dropGenerator(false);
        } catch (err) {
          if (sample) closeSample(sample);
          sample = null;
          // A timeout leaves the generator in an unknown state — abandon the
          // fast path for the rest of this clip and retry the frame through
          // random access. A real decode error, though, is the file's answer for
          // this frame and retrying would just get it twice.
          dropGenerator();
          if (!isSeqTimeout(err)) throw coded(err, 'SEQ_DECODE_FAILED');
        }
      }

      if (!sample) {
        try {
          sample = await withTimeout(sink.getSample(t), timeout, 'decode (random access)');
          if (sample) ledger.acquire();
        } catch (err) {
          throw coded(err, 'SEQ_DECODE_FAILED');
        }
      }

      if (!sample) { ledger.raw.missed++; return false; }
      try {
        sample.draw(ctx, dest.dx, dest.dy, dest.dw, dest.dh);
        ledger.raw.decoded++;
        ledger.raw.lastSourceSec = sample.timestamp;
        // The source's own frame interval, straight off the sample — the truncation
        // tolerance has to absorb one of these (a PTS lags its request by up to that).
        if (Number.isFinite(sample.duration) && sample.duration > 0) {
          ledger.raw.sourceFrameSec = Math.max(ledger.raw.sourceFrameSec, sample.duration);
        }
        return true;
      } catch (err) {
        throw coded(err, 'SEQ_UNSUPPORTED_MEDIA');
      } finally {
        // Same tick as the draw, on every path including a throwing draw.
        closeSample(sample);
      }
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      dropGenerator();
      // Give the abandoned generator its return() a microtask to land before the
      // input pulls the decoders out from under it.
      await Promise.resolve();
      try { input.dispose(); } catch { /* already disposed */ }
    },
  };
  return provider;
}

// ── the element-seek fallback provider ──────────────────────────────────────

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?(cb: (now: number, meta: { mediaTime?: number }) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
};

const isCrossOrigin = (url: string): boolean => {
  if (typeof location === 'undefined') return false;
  if (!/^https?:/i.test(url)) return false;
  try { return new URL(url, location.href).origin !== location.origin; } catch { return false; }
};

function waitMetadata(v: HTMLVideoElement, timeoutMs: number): Promise<boolean> {
  if (v.readyState >= 1 /* HAVE_METADATA */) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeEventListener('loadedmetadata', onOk);
      v.removeEventListener('error', onFail);
      resolve(ok);
    };
    const onOk = (): void => finish(true);
    const onFail = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    v.addEventListener('loadedmetadata', onOk, { once: true });
    v.addEventListener('error', onFail, { once: true });
  });
}

/**
 * The fallback: a hidden <video>, seeked one frame at a time.
 *
 * Semantics are the phase-2 clock's, not a re-derivation — `createSeekQueue`
 * (never two seeks in flight on one element, the Safari rule) and
 * `waitSeekConfirmed` (rVFC `mediaTime` is the frame actually presented;
 * `currentTime` is merely what we asked for) are imported, and the single
 * quarter-frame nudge on a short landing uses the clock's own tolerance
 * constants. ONE nudge: a decoder that cannot hit a time will not hit it on the
 * third try either, and a retry loop on a long-GOP file is a hang.
 *
 * Slower than decode by an order of magnitude, and only as accurate as the
 * engine's seeking — which is why it is the fallback and not the default.
 */
export async function createElementProvider(url: string, opts: ProviderOpts = {}): Promise<InstrumentedProvider> {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw coded(new Error('no DOM for the element-seek provider'), 'SEQ_UNSUPPORTED_MEDIA');
  }
  const timeout = opts.timeoutMs ?? OP_TIMEOUT_MS;
  const ledger = createLedger('element');
  const objectUrl = url.startsWith('blob:');

  const v = document.createElement('video') as RvfcVideo;
  v.preload = 'auto';
  v.muted = true;
  v.defaultMuted = true;
  v.autoplay = false;
  v.setAttribute('playsinline', '');
  v.setAttribute('aria-hidden', 'true');
  // Attached but off-screen: a detached <video> is allowed to skip decoding in
  // some engines, and then no seek ever presents a frame.
  v.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  if (isCrossOrigin(url)) v.crossOrigin = 'anonymous';
  document.body.appendChild(v);
  v.src = url;
  try { v.load(); } catch { /* some engines auto-load */ }

  let disposed = false;
  let queue: SeekQueue | null = null;

  const teardown = (): void => {
    queue?.clear();
    queue = null;
    try {
      v.pause?.();
      v.removeAttribute('src');
      v.load?.();
      v.remove();
    } catch { /* already detached */ }
    if (objectUrl) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
  };

  const ok = await waitMetadata(v, Math.min(timeout, METADATA_TIMEOUT_MS));
  if (!ok) {
    teardown();
    throw coded(new Error(`element provider could not load metadata for ${url}`), 'SEQ_UNSUPPORTED_MEDIA');
  }
  queue = createSeekQueue(v, (el, signal) => waitSeekConfirmed(el as HTMLVideoElement & { currentTime: number }, signal));

  const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  const w = v.videoWidth || 0;
  const h = v.videoHeight || 0;
  // An element reports the length the CONTAINER states, which is exactly the
  // "claimed" number the truncation guard wants (a truncated file still states its
  // original length in its header). There is no second, packet-walked number here.
  ledger.raw.claimedDurationSec = duration;

  return {
    get w() { return w; },
    get h() { return h; },
    durationSec: () => duration,
    stats: ledger.stats,

    async drawAt(ctx, sourceSec, dest) {
      if (disposed) throw coded(new Error('provider disposed'), 'SEQ_ABORTED');
      const q = queue;
      if (!q) return false;
      const raw = Number.isFinite(sourceSec) ? Math.max(0, sourceSec) : 0;
      ledger.request(raw);
      // Past the source's end the target stops moving; hold the last frame
      // rather than asking for a time the decoder will never present.
      const target = duration > 0 ? Math.min(raw, Math.max(0, duration - MEDIA_END_EPS_S)) : raw;

      let landed: number | null;
      try {
        landed = await withTimeout(q.seek(target, { supersede: false }), timeout, 'seek');
        if (landed != null && Math.abs(landed - target) > SEEK_TOLERANCE_S) {
          // One nudge, a quarter-frame past the target — decoders routinely land
          // on the preceding keyframe.
          landed = await withTimeout(q.seek(target + SEEK_NUDGE_S), timeout, 'seek (nudge)');
        }
      } catch (err) {
        throw coded(err, 'SEQ_DECODE_FAILED');
      }
      if (landed == null && v.readyState < 2 /* HAVE_CURRENT_DATA */) { ledger.raw.missed++; return false; }

      // The element IS the sample here: it is acquired and released around the
      // single draw so the in-flight ledger reads the same way as mediabunny's.
      ledger.acquire();
      try {
        ctx.drawImage(v as unknown as CanvasImageSource, dest.dx, dest.dy, dest.dw, dest.dh);
        ledger.raw.decoded++;
        ledger.raw.lastSourceSec = landed ?? target;
        // An element seek has no sample duration to report, but it DOES accept
        // landing up to SEEK_TOLERANCE_S short of the target — so that is this
        // provider's PTS lag, and the truncation tolerance must absorb it.
        ledger.raw.sourceFrameSec = SEEK_TOLERANCE_S;
        return true;
      } catch (err) {
        // A tainted canvas (no CORS headers) is not recoverable by retrying.
        throw coded(err, 'SEQ_UNSUPPORTED_MEDIA');
      } finally {
        ledger.release();
      }
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      teardown();
      await Promise.resolve();
    },
  };
}

// ── clip audio ──────────────────────────────────────────────────────────────

export interface ClipAudioOpts {
  timeoutMs?: number;
  log?(level: string, msg: string): void;
  deps?: { loadMediabunny?(): Promise<MediabunnyModule>; hasWebCodecs?(): boolean };
}

/**
 * A clip's audio track, or null when there isn't one.
 *
 * `null` is the ordinary answer, not a failure: most boxes are silent, and the
 * mix must not care. It is also the answer when the platform has no `AudioDecoder`
 * or the track's codec is refused — there is no element-based fallback for PCM
 * (an <audio> element cannot hand you sample data offline), so the renderer's
 * choice is a silent clip or a failed export, and a silent clip is the one that
 * still produces a usable file.
 */
export async function createClipAudio(src: Blob | string, opts: ClipAudioOpts = {}): Promise<ClipAudio | null> {
  const deps = opts.deps ?? {};
  const log = opts.log ?? ((): void => {});
  const timeout = opts.timeoutMs ?? OPEN_TIMEOUT_MS;
  const hasWc = deps.hasWebCodecs ? deps.hasWebCodecs() : (await providerCapability()).webcodecs;
  if (!hasWc) return null;

  try {
    return await withTimeout(openClipAudio(src, opts), timeout, 'open (audio)');
  } catch (err) {
    const e = err as Error & { code?: string };
    log('warn', `sequence audio: ${e.code ?? 'error'}: ${e.message} — clip will be silent`);
    return null;
  }
}

async function openClipAudio(src: Blob | string, opts: ClipAudioOpts): Promise<ClipAudio | null> {
  const deps = opts.deps ?? {};
  const timeout = opts.timeoutMs ?? OP_TIMEOUT_MS;
  const mb = await (deps.loadMediabunny ?? loadMediabunny)();
  const source = typeof src === 'string' ? new mb.UrlSource(src) : new mb.BlobSource(src);
  const input = new mb.Input({ formats: [mb.MP4, mb.QTFF, mb.WEBM, mb.MATROSKA], source });

  let track: MbAudioTrack | null = null;
  try {
    track = await input.getPrimaryAudioTrack();
  } catch (err) {
    input.dispose();
    throw coded(err, 'SEQ_UNSUPPORTED_MEDIA');
  }
  if (!track) { input.dispose(); return null; }
  let decodable = false;
  try { decodable = await track.canDecode(); } catch { decodable = false; }
  if (!decodable) { input.dispose(); return null; }

  let duration = 0;
  try { duration = await input.computeDuration(); } catch { duration = 0; }

  const sink = new mb.AudioBufferSink(track);
  let disposed = false;

  return {
    durationSec: () => duration,

    async pcm(fromSec, toSec, sampleRate) {
      if (disposed) throw coded(new Error('clip audio disposed'), 'SEQ_ABORTED');
      const from = Math.max(0, Number.isFinite(fromSec) ? fromSec : 0);
      const to = Math.max(from, Number.isFinite(toSec) ? toSec : from);
      const chunks: PcmChunk[] = [];
      // A manual next() loop would have to call it.return() itself; `for await`
      // does that on break/throw, which is why the whole read is inside one.
      const iter = sink.buffers(from, to);
      const deadline = withTimeout(
        (async () => {
          for await (const wrapped of iter) {
            const buf = wrapped.buffer;
            const channels: Float32Array[] = [];
            for (let c = 0; c < buf.numberOfChannels; c++) {
              // Copy: the sink is free to recycle the underlying storage once
              // the iterator advances, and these outlive the loop.
              channels.push(Float32Array.from(buf.getChannelData(c)));
            }
            chunks.push({ channels, sampleRate: buf.sampleRate, timestamp: wrapped.timestamp });
          }
        })(),
        timeout,
        'audio decode',
      );
      try {
        await deadline;
      } catch (err) {
        try { await iter.return(undefined); } catch { /* generator already finished */ }
        throw coded(err, 'SEQ_DECODE_FAILED');
      }
      // The trim (spike rule 6) happens here, in the pure assembler.
      return assemblePcmWindow(chunks, from, to, sampleRate);
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      try { input.dispose(); } catch { /* already disposed */ }
      await Promise.resolve();
    },
  };
}
