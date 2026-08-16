// SPDX-License-Identifier: MPL-2.0
/**
 * DOM-free WebCodecs encode + mux core - the compute half of the video export's fast
 * path, extracted from bridge/export.ts so it runs UNCHANGED in either context:
 *   • the main thread (export.ts encodeVideoWithWebCodecs wraps it + adds provenance);
 *   • a Web Worker (video-encode.worker.ts), fed transferred ImageBitmaps + planar PCM,
 *     so the encode/mux runs off the main thread.
 *
 * Everything here is DOM-free: VideoEncoder / VideoFrame / AudioEncoder / AudioData are
 * globals in both window and worker scope, and the muxers (mp4-muxer / webm-muxer) are
 * pure-JS + lazily imported. Audio arrives as PLANAR channel Float32Arrays (not an
 * AudioBuffer, which isn't transferable) so the worker path can transfer it. Returns the
 * muxed bytes + container type; the CALLER wraps them in a Blob and embeds provenance
 * (withVideoMeta) - kept on the main thread where the metadata writers already live.
 *
 * The per-frame timing + keyframe cadence and the audio chunking come from the pure
 * schedules in video-mime.ts, so the ordering is unit-tested and identical to before.
 */
import { videoFrameSchedule, audioChunkSchedule } from './video-mime.ts';

export interface EncodePick { container: 'mp4' | 'webm'; codec: string; muxCodec: string }

/** Audio for the encode as planar channels (worker-transferable), plus its codec. */
export interface EncodeAudio {
  channels: Float32Array[];
  sampleRate: number;
  numberOfChannels: number;
  codec: string;
  muxCodec: string;
  bitrate: number;
}

export interface EncodeOpts {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  audio?: EncodeAudio | null;
}

// ── Muxer wiring (shared seam) ────────────────────────────────────────────────
// The lazy muxer import + Muxer construction, lifted verbatim out of
// encodeMuxWebCodecs so the streaming encoder below builds an IDENTICAL muxer
// instead of duplicating (and drifting from) the container config. The
// buffered and streaming paths differ only in how frames are supplied.

/** The slice of mp4-muxer / webm-muxer's Muxer this module actually uses. */
export interface MuxerLike {
  addVideoChunk(chunk: unknown, metadata?: unknown): void;
  addAudioChunk(chunk: unknown, metadata?: unknown): void;
  finalize(): void;
}

/** A built muxer + the ArrayBufferTarget it writes into + the container MIME. */
export interface BuiltMuxer { muxer: MuxerLike; target: { buffer: ArrayBuffer }; type: string }

/** Factory for the muxer - swappable so the encode paths are testable without a real muxer. */
export type MuxerFactory = (pick: EncodePick, o: EncodeOpts) => Promise<BuiltMuxer>;

/** Lazily import the right muxer and construct it for `pick`/`o`. */
export const defaultMuxerFactory: MuxerFactory = async (pick, o) => {
  const { width, height, fps } = o;
  const a = o.audio ?? null;
  const isMp4 = pick.container === 'mp4';
  const mux: any = isMp4 ? await import('mp4-muxer') : await import('webm-muxer');
  const target = new mux.ArrayBufferTarget();
  const audioTrack = a ? { codec: a.muxCodec, numberOfChannels: a.numberOfChannels, sampleRate: a.sampleRate } : null;
  const muxer = new mux.Muxer(isMp4
    ? { target, fastStart: 'in-memory', video: { codec: 'avc', width, height }, ...(audioTrack ? { audio: audioTrack } : {}) }
    : { target, firstTimestampBehavior: 'offset', video: { codec: pick.muxCodec, width, height, frameRate: fps }, ...(audioTrack ? { audio: audioTrack } : {}) });
  return { muxer, target, type: isMp4 ? 'video/mp4' : 'video/webm' };
};

/** Encode frames (+ optional audio) and mux → { muxed bytes, container MIME }. Throws on
 *  any encoder error. Identical logic to the former inline loop in export.ts. */
export async function encodeMuxWebCodecs(
  frames: ImageBitmap[], pick: EncodePick, o: EncodeOpts,
): Promise<{ buffer: ArrayBuffer; type: string }> {
  const { width, height, fps, bitrate } = o;
  const a = o.audio ?? null;
  const isMp4 = pick.container === 'mp4';
  const { muxer, target } = await defaultMuxerFactory(pick, o);

  let encErr: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => { try { muxer.addVideoChunk(chunk, metadata); } catch (e) { encErr = e; } },
    error: (e) => { encErr = e; },
  });
  const config: any = { codec: pick.codec, width, height, bitrate, framerate: fps };
  if (isMp4) config.avc = { format: 'avc' };   // length-prefixed avcC, as mp4-muxer expects
  encoder.configure(config);

  for (const t of videoFrameSchedule(frames.length, fps)) {
    if (encErr) break;
    const frame = new VideoFrame(frames[t.index]!, { timestamp: t.timestampUs, duration: t.durationUs });
    encoder.encode(frame, { keyFrame: t.keyFrame });
    frame.close();
    if (encoder.encodeQueueSize > 20) await new Promise<void>((r) => setTimeout(r, 0));
  }
  await encoder.flush();
  encoder.close();

  if (a && !encErr) {
    const { channels, sampleRate, numberOfChannels, bitrate: aBitrate } = a;
    const aEnc = new AudioEncoder({
      output: (chunk, metadata) => { try { muxer.addAudioChunk(chunk, metadata); } catch (e) { encErr = e; } },
      error: (e) => { encErr = e; },
    });
    aEnc.configure({ codec: a.codec, sampleRate, numberOfChannels, bitrate: aBitrate });
    const total = channels[0]?.length ?? 0;      // frames per channel
    const CHUNK = 4800;                           // ~0.1s @ 48k
    const planar = new Float32Array(CHUNK * numberOfChannels);
    for (const span of audioChunkSchedule(total, sampleRate, CHUNK)) {
      if (encErr) break;
      const n = span.numFrames;
      // f32-planar layout for this chunk: [ch0: n samples][ch1: n samples] (stride n).
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const plane = channels[Math.min(ch, channels.length - 1)]!;
        planar.set(plane.subarray(span.offsetFrames, span.offsetFrames + n), ch * n);
      }
      const audioData = new AudioData({
        format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels,
        timestamp: span.timestampUs,                       // microseconds
        data: planar.subarray(0, n * numberOfChannels),    // AudioData copies the data
      });
      aEnc.encode(audioData);
      audioData.close();
      if (aEnc.encodeQueueSize > 20) await new Promise<void>((r) => setTimeout(r, 0));
    }
    await aEnc.flush();
    aEnc.close();
  }

  if (encErr) throw encErr instanceof Error ? encErr : new Error('VideoEncoder error');
  muxer.finalize();
  return { buffer: target.buffer as ArrayBuffer, type: isMp4 ? 'video/mp4' : 'video/webm' };
}

// ── Streaming encode + mux ────────────────────────────────────────────────────
// encodeMuxWebCodecs above needs EVERY frame up front as an ImageBitmap, which is
// why the callers cap a clip at maxVideoFrames(): memory grows with duration. A
// sequence export can't work that way - it draws one frame, hands it over, and
// reuses the same canvas. createStreamingMux is that shape: push a frame, push
// audio, finalize. Memory is O(1) in duration because at most HIGH_WATER + 1
// VideoFrames are ever alive, each closed in the same tick it was encoded.
//
// Backpressure waits on the encoder's own 'dequeue' event rather than polling a
// timer, so a slow hardware encoder throttles the producer precisely (the spike
// measured a peak queue of 7 against a `> 6` gate). A short timer runs alongside
// purely as a liveness net for an encoder that doesn't emit 'dequeue'.

/** Queue depth above which addFrame/addAudio await the encoder draining. */
export const HIGH_WATER = 6;

/** Poll interval (ms) backing up the 'dequeue' event, for encoders that don't fire it. */
const DEQUEUE_FALLBACK_MS = 25;

/**
 * The slice of `AudioBuffer` addAudio actually reads.
 *
 * A real `AudioBuffer` satisfies this structurally, so every existing caller is
 * unchanged. It is spelled out because `AudioBuffer` is a main-thread-only
 * global: the sequence-render worker receives planar `Float32Array`s over
 * postMessage and wraps them in this shape, and there is no other way to feed
 * the same PCM to the same encoder from worker scope.
 */
export interface PcmSource {
  /** Sample frames per channel. */
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** A push-based encode+mux session. Frames stream in; memory stays O(1) in duration. */
export interface StreamingMux {
  /** Encode one frame at `tsUs` (µs). Resolves once the encoder has room for the next. */
  addFrame(src: CanvasImageSource, tsUs: number): Promise<void>;
  /** Encode one buffer's PCM (an AudioBuffer, or its planar equivalent in a
   *  worker), appended after everything added so far. */
  addAudio(buffer: PcmSource): Promise<void>;
  /** Flush both encoders, finalize the muxer, and return the container. */
  finalize(): Promise<Blob>;
  /** Tear everything down without producing output. Safe to call more than once. */
  abort(reason?: unknown): Promise<void>;
}

/** Injection seam: the WebCodecs globals + the muxer factory, so the streaming
 *  encoder is drivable by stubs in node (no WebCodecs there). Every field
 *  defaults to the real global / the real lazy muxer import. */
export interface StreamingDeps {
  muxerFactory?: MuxerFactory;
  VideoEncoder?: any;
  AudioEncoder?: any;
  VideoFrame?: any;
  AudioData?: any;
}

/** Wait until `enc.encodeQueueSize <= HIGH_WATER`, yielding to 'dequeue'. */
async function drain(enc: any): Promise<void> {
  while (enc.encodeQueueSize > HIGH_WATER) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { enc.removeEventListener?.('dequeue', done); } catch { /* stub without listeners */ }
        resolve();
      };
      const timer = setTimeout(done, DEQUEUE_FALLBACK_MS);
      try { enc.addEventListener?.('dequeue', done); } catch { done(); }
    });
  }
}

/**
 * Open a streaming encode+mux session for `pick`/`opts`.
 *
 * `opts.audio` DECLARES the audio track (codec / sampleRate / numberOfChannels /
 * bitrate) so the muxer can be constructed with it; its `channels` payload is
 * ignored here - PCM arrives incrementally through addAudio().
 */
export async function createStreamingMux(
  pick: EncodePick, opts: EncodeOpts, deps: StreamingDeps = {},
): Promise<StreamingMux> {
  const { width, height, fps, bitrate } = opts;
  const a = opts.audio ?? null;
  const isMp4 = pick.container === 'mp4';
  const g = globalThis as any;
  const VEnc = deps.VideoEncoder ?? g.VideoEncoder;
  const AEnc = deps.AudioEncoder ?? g.AudioEncoder;
  const VFrame = deps.VideoFrame ?? g.VideoFrame;
  const AData = deps.AudioData ?? g.AudioData;

  const { muxer, target, type } = await (deps.muxerFactory ?? defaultMuxerFactory)(pick, opts);

  let encErr: unknown = null;
  const fail = (e: unknown): void => { encErr ??= e; };
  const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e ?? 'encoder error')));

  // Deterministic interleave. The two encoders' output callbacks fire on their
  // own schedule, and an audio chunk lands every 100000µs - a timestamp every
  // third 30fps video frame TIES exactly - so feeding the muxer in arrival
  // order made the interleave (and therefore the file's bytes) depend on
  // scheduler load: same render, same pixels, same size, different sha. The
  // callbacks queue per stream instead, and finalize() drains both queues in
  // one canonical order (ascending timestamp, video first on a tie - the same
  // rule webm-muxer's own video-queue drain applies). Memory is unchanged:
  // both muxers already accumulate the whole encoded stream (see the MEMORY
  // note in sequence-render.ts).
  const vQ: Array<{ chunk: unknown; metadata: unknown }> = [];
  const aQ: Array<{ chunk: unknown; metadata: unknown }> = [];
  const tsOf = (c: unknown): number => Number((c as { timestamp?: number } | null)?.timestamp ?? 0);

  const encoder = new VEnc({
    output: (chunk: unknown, metadata: unknown) => { vQ.push({ chunk, metadata }); },
    error: (e: unknown) => { fail(e); },
  });
  const config: any = { codec: pick.codec, width, height, bitrate, framerate: fps };
  if (isMp4) config.avc = { format: 'avc' };   // length-prefixed avcC, as mp4-muxer expects
  encoder.configure(config);

  let aEnc: any = null;
  if (a) {
    aEnc = new AEnc({
      output: (chunk: unknown, metadata: unknown) => { aQ.push({ chunk, metadata }); },
      error: (e: unknown) => { fail(e); },
    });
    aEnc.configure({ codec: a.codec, sampleRate: a.sampleRate, numberOfChannels: a.numberOfChannels, bitrate: a.bitrate });
  }

  const f = Math.max(1, fps);
  const keyEvery = Math.max(1, Math.round(f * 2));   // same ~2s cadence as videoFrameSchedule
  const durationUs = Math.round(1e6 / f);
  let frameIndex = 0;
  let audioFrames = 0;                                // running PCM position, in sample frames
  let state: 'open' | 'closed' = 'open';

  /** Close an encoder without letting a double-close mask the real failure. */
  const shut = (e: any): void => { try { e?.close?.(); } catch { /* already closed */ } };

  const guard = (): void => {
    if (state === 'closed') throw new Error('streaming mux is closed');
    if (encErr) throw asError(encErr);
  };

  return {
    async addFrame(src: CanvasImageSource, tsUs: number): Promise<void> {
      guard();
      const frame = new VFrame(src, { timestamp: Math.round(tsUs), duration: durationUs });
      try {
        encoder.encode(frame, { keyFrame: frameIndex % keyEvery === 0 });
      } finally {
        frame.close();                                // exactly one close, same tick as the encode
        frameIndex++;
      }
      await drain(encoder);
      if (encErr) throw asError(encErr);
    },

    async addAudio(buffer: PcmSource): Promise<void> {
      guard();
      if (!aEnc) throw new Error('streaming mux has no audio track (opts.audio was not set)');
      const sampleRate = a!.sampleRate;
      const numberOfChannels = a!.numberOfChannels;
      const total = buffer.length ?? 0;
      if (!total) return;
      const CHUNK = 4800;                             // ~0.1s @ 48k, as the buffered path uses
      const planes: Float32Array[] = [];
      for (let ch = 0; ch < numberOfChannels; ch++) {
        planes.push(buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1)));
      }
      const planar = new Float32Array(CHUNK * numberOfChannels);
      for (const span of audioChunkSchedule(total, sampleRate, CHUNK)) {
        if (encErr) throw asError(encErr);
        const n = span.numFrames;
        for (let ch = 0; ch < numberOfChannels; ch++) {
          planar.set(planes[ch]!.subarray(span.offsetFrames, span.offsetFrames + n), ch * n);
        }
        const audioData = new AData({
          format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels,
          // Timestamps continue from everything already pushed - the spans are
          // buffer-relative, the session's clock is not.
          timestamp: Math.round(((audioFrames + span.offsetFrames) / Math.max(1, sampleRate)) * 1e6),
          data: planar.subarray(0, n * numberOfChannels),
        });
        try { aEnc.encode(audioData); } finally { audioData.close(); }
        await drain(aEnc);
      }
      audioFrames += total;
      if (encErr) throw asError(encErr);
    },

    async finalize(): Promise<Blob> {
      guard();
      state = 'closed';
      try {
        await encoder.flush();
        shut(encoder);
        if (aEnc) { await aEnc.flush(); shut(aEnc); }
      } catch (e) {
        shut(encoder); shut(aEnc);
        throw asError(e);
      }
      if (encErr) throw asError(encErr);
      // Canonical drain - the only place chunks meet the muxer. Per-stream
      // order is each encoder's emit order (monotonic; neither codec path
      // produces B-frames); only the interleave between streams is decided
      // here, so it is decided the same way every run.
      try {
        let vi = 0;
        let ai = 0;
        while (vi < vQ.length || ai < aQ.length) {
          const takeVideo = ai >= aQ.length
            || (vi < vQ.length && tsOf(vQ[vi]!.chunk) <= tsOf(aQ[ai]!.chunk));
          if (takeVideo) { muxer.addVideoChunk(vQ[vi]!.chunk, vQ[vi]!.metadata); vi++; }
          else { muxer.addAudioChunk(aQ[ai]!.chunk, aQ[ai]!.metadata); ai++; }
        }
      } catch (e) {
        throw asError(e);
      }
      muxer.finalize();
      return new Blob([target.buffer as ArrayBuffer], { type });
    },

    async abort(reason?: unknown): Promise<void> {
      if (state === 'closed') return;
      state = 'closed';
      if (reason !== undefined) fail(reason);
      // No flush: a flush would await work whose output we're discarding, and a
      // failing encoder may never settle it. Just release both encoders.
      shut(encoder);
      shut(aEnc);
    },
  };
}
