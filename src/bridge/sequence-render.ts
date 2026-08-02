// SPDX-License-Identifier: MPL-2.0
/**
 * sequence-render.ts — the EXECUTOR + ORCHESTRATOR for deterministic sequence
 * export (Fable timeline, phase 3 §2.5).
 *
 * The split this module lives on is the whole point of the phase-3 design (spike
 * §0.0, "DESIGN REQUIREMENT"):
 *
 *   sequence-plan.ts      decides WHAT is on screen at time t and where its media
 *                         is seeked to — pure, DOM-only-for-reading, node-testable.
 *   sequence-providers.ts turns one clip into pixels/PCM at a source time —
 *                         mediabunny + WebCodecs live ONLY behind that seam.
 *   sequence-render.worker.ts  the DOM-FREE executor: `drawItem`, the frame loop,
 *                         the provider lifecycle and the truncation reconciliation
 *                         (phase 4 Track B) — plus the Worker entry that runs it.
 *   THIS FILE             reads the LIVE DOM (stage parse, dom-to-image rasters,
 *                         the lottie player), mixes the audio graph, decides which
 *                         thread executes, and owns every output container.
 *
 * There is deliberately NO activity, alpha, crossfade or source-time arithmetic in
 * here. If a question is "should this be visible / how faded / which frame of the
 * source", it belongs in the planner and is already answered by the PlanItem. What
 * is left here is genuinely browser-only: dom-to-image, lottie-web, the
 * OfflineAudioContext, MediaRecorder and the container writers.
 *
 * WORKER OFFLOAD (phase 4 Track B), and the SPLIT RULE. `renderSequence` builds a
 * fully serialisable `SeqJob` — the layers minus their elements, the static
 * rasters, the clip bytes, the mixed PCM — and hands it to ONE executor,
 * `runSequenceJob`. Which thread that executor runs on is the only difference
 * between the two paths, so determinism is structural rather than asserted:
 *
 *   • no lottie layer  ⇒ the whole frame loop (decode, composite, encode, mux)
 *     runs in the Worker and the main thread only awaits the result;
 *   • a lottie layer   ⇒ HYBRID. lottie-web cannot run in a worker, so the worker
 *     asks the main thread for that layer's raster per frame ('need-live') and
 *     blocks on the answer, at most ONE request outstanding;
 *   • gif / apng / the MediaRecorder fallback, or any missing capability
 *     (`supportsWorkerSequenceRender()`), ⇒ the executor runs in-thread, exactly
 *     as it did before this change.
 *
 * The worker path is OPT-IN behind the same `lolly.workerEncode` flag that gates
 * bridge/video-encode.ts, and any non-coded worker failure falls back to a full
 * in-thread render (the static rasters are kept as canvases precisely so that
 * retry costs nothing).
 *
 * MEMORY. The mp4/webm path holds O(1) DECODED frames in duration: one canvas, at
 * most two decoded samples per open provider (the providers' own ledger enforces
 * that), and at most HIGH_WATER+1 VideoFrames inside the streaming mux. That is why
 * `maxVideoFrames()` — which exists purely because the old path buffered an
 * ImageBitmap per frame — is NOT applied to it. It is NOT O(1) overall: both muxers
 * accumulate the ENCODED stream (mp4-muxer's `fastStart:'in-memory'` by design,
 * webm-muxer's `_videoChunkQueue` until an audio chunk with a ≥ timestamp drains
 * it), so peak memory is O(duration × bitrate) in compressed bytes — ~45 MB for a
 * ten-minute 1080p clip, three orders of magnitude below the frame buffering this
 * path replaced. gif/apng buffer every frame as pixels, so they keep the cap; so
 * does the MediaRecorder fallback, which buffers an ImageBitmap per frame.
 *
 * WHAT IS DUPLICATED FROM export.ts, AND WHY. `pickWebCodecsVideo`,
 * `pickWebCodecsAudio`, `withVideoMeta`, `manualCaptureStream`, `recorderOpts`,
 * `maxVideoFrames`, `swapBlobUrls`, `getDomToImage`, the `rasterBox` technique and
 * `connectMusic`'s gain envelope are all module-private in bridge/export.ts. This
 * phase's brief allowed exactly three edits to that file (the stage sniff, the
 * dispatch branch, the snapshotMotion guard) — exporting nine more symbols is not
 * one of them — so they are reproduced here, each marked `// from export.ts:<name>`
 * and kept behaviourally identical. THIS IS A REPORTED DEBT: the right end state is
 * a shared bridge/video-shared.ts that both files import. See the build report.
 */

import {
  parseSequenceStage,
  applyDurationOverride,
  frameTimestamps,
  activeFrameWindow,
  crossfadeJunctions,
  sequenceError,
  toCodedError,
  SequenceError,
  type SeqLayer,
  type SeqErrorCode,
} from './sequence-plan.ts';
import {
  createClipAudio,
  type ClipAudio,
} from './sequence-providers.ts';
import {
  createStreamingMux,
  type EncodePick,
  type StreamingMux,
} from './video-encode-core.ts';
// The DOM-free executor. Imported as an ordinary module for the in-thread path
// AND spawned as a Worker below — one compositor, two hosts (see the header).
import {
  runSequenceJob,
  toJobLayer,
  jobTransferables,
  closeJobBitmaps,
  radiiOf,
  fitRect,
  type SeqJob,
  type SeqJobLayer,
  type SeqJobIO,
  type SeqWorkerAudio,
  type SeqWorkerIn,
  type SeqWorkerOut,
  type AnyCanvas,
  type AnyCtx,
} from './sequence-render.worker.ts';

// The geometry helpers moved to the executor with `drawItem`; re-exported so the
// module's public surface (and sequence-render.test.ts) is unchanged.
export { radiiOf, fitRect };
import { videoBitrate, videoMimeCandidates } from './video-mime.ts';
import { bedDuckEnvelope, scheduleGainEvents, MIX_RAMP_SEC, type DuckSpan } from './audio-envelope.ts';
import { insertPngPhys, insertPngMeta, insertPngIcc, iccWanted } from './export-image-meta.ts';
import {
  packApng,
  videoProvenanceTags,
  embedMp4Meta,
  embedWebmMeta,
  iccProfileBytes,
} from '@lolly/engine';
// The compositor photographs the LIVE artboard, and the phase-2 clock has been
// writing `.seq-off` (display:none) onto every box that is not under the playhead.
// Without clearing it, every clip except the one being scrubbed rasterises blank.
// The class name is imported rather than restated so the two can never drift apart —
// from sequence-dom.ts, which owns the DOM applier the clock itself now uses (that
// also drops one of the bridge → views edges).
import { OFF_CLASS } from './sequence-dom.ts';
// bridge → views. Phase 3 already has this edge (sequence-providers.ts reuses the
// clock's seek semantics); reusing the LIVE Lottie player instance is the only way
// a Lottie box can be exported at all — re-mounting a second player would double
// the memory and, worse, could resolve to a different build of the animation than
// the one the preview showed. Reported alongside the other layering note.
import { lottiePlayerFor } from '../views/lottie-mount.ts';
import { suspendNodeRasters, drainNodeRasters } from '../lib/clip-thumbs.ts';
import type { ExportOpts } from './export.ts';
// Type only — the encoders themselves stay out of this module's graph.
import type { AudioPcm } from '../lib/audio-encode.ts';

/** The slice of the web host this renderer needs. Log only — everything else is
 *  resolved from the DOM the tool already rendered. */
export interface SeqHost {
  log?(level: string, msg: string): void;
}

// ── policy constants ────────────────────────────────────────────────────────

/**
 * Providers (= open containers + decoders) alive at once.
 *
 * A MEMORY policy, NOT a decoder-count limit (spike rule 4): 16 concurrent
 * Input+sink pairs interleaved with no stall, and mediabunny self-caps its own
 * decoded queue at 8. What is unmeasurable from JS is the native frame memory —
 * the heap moved 1.6 MB while ~2.8 GB of frame data was nominally held — so the
 * cap is the only instrument we have. A composition needing more overlapping
 * clips than this fails with SEQ_TOO_HEAVY rather than thrashing.
 */
export const MAX_LIVE_PROVIDERS = 3;

/** Sanity ceiling on a sequence, ms. Not a memory bound (the streaming path has
 *  none) — it is the "somebody hand-edited seq-ms in the URL" guard. */
export const MAX_SEQUENCE_MS = 600_000;

/** No frame completed for this long ⇒ the export is stuck; fail, never hang. */
export const WATCHDOG_MS = 10_000;

/** Everything mixes at 48 kHz stereo — the rate both AAC and Opus want. */
export const MIX_RATE = 48_000;
export const MIX_CHANNELS = 2;

/** Fixed GIF frame rate (the gif encoder's own; it ignores opts.fps). */
const GIF_FPS = 15;

/** CSS pixels per inch — the APNG pHYs default, matching export.ts's exportDims. */
const CSS_DPI = 96;

const AUDIO_BITRATE = 128_000;

/** Lottie/live-raster requests the worker may have outstanding at once. One is
 *  the whole bound: the executor asks, then blocks, so a slow main thread can
 *  never queue frames up in worker memory. */
export const LIVE_RASTER_QUEUE = 1;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── small helpers reproduced from export.ts (see the header) ────────────────

// from export.ts:getDomToImage
let domToImageMore: any = null;
async function getDomToImage(): Promise<any> {
  if (!domToImageMore) {
    const mod: any = await import('dom-to-image-more');
    domToImageMore = mod.default ?? mod;
  }
  return domToImageMore;
}

// from export.ts:blobToDataUrl
function blobToDataUrl(url: string): Promise<string> {
  return fetch(url)
    .then((r) => r.blob())
    .then((b) => new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(new Error('blob read failed'));
      fr.readAsDataURL(b);
    }));
}

// from export.ts:swapBlobUrls — dom-to-image cannot serialise a blob: URL, so any
// <img>/<image> pointing at one is temporarily rewritten to a data: URL.
async function swapBlobUrls(node: Element): Promise<() => void> {
  const swaps: { el: Element; attr: string; url: string }[] = [];
  await Promise.all([...node.querySelectorAll('image, img')].map(async (el) => {
    for (const attr of ['href', 'src']) {
      const url = el.getAttribute(attr);
      if (url?.startsWith('blob:')) {
        try {
          el.setAttribute(attr, await blobToDataUrl(url));
          swaps.push({ el, attr, url });
        } catch { /* leave as-is */ }
      }
    }
  }));
  return () => swaps.forEach(({ el, attr, url }) => el.setAttribute(attr, url));
}

// from export.ts:maxVideoFrames — only the buffering (gif/apng) path uses it.
function maxVideoFrames(): number {
  const gb = (navigator as { deviceMemory?: number }).deviceMemory;
  if (!gb) return 600;
  return Math.max(200, Math.round((Math.min(8, gb) / 8) * 600));
}

// from export.ts:pickWebCodecsVideo
async function pickWebCodecsVideo(preferred: string, width: number, height: number, fps: number, bitrate: number): Promise<EncodePick | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const mp4: EncodePick[] = [
    { container: 'mp4', codec: 'avc1.640033', muxCodec: 'avc' },
    { container: 'mp4', codec: 'avc1.4d0033', muxCodec: 'avc' },
  ];
  const webm: EncodePick[] = [
    { container: 'webm', codec: 'vp09.00.10.08', muxCodec: 'V_VP9' },
    { container: 'webm', codec: 'vp8', muxCodec: 'V_VP8' },
  ];
  for (const pick of preferred === 'mp4' ? [...mp4, ...webm] : [...webm, ...mp4]) {
    try {
      const support = await VideoEncoder.isConfigSupported({ codec: pick.codec, width, height, bitrate, framerate: fps });
      if (support?.supported) return pick;
    } catch { /* try the next candidate */ }
  }
  return null;
}

interface SeqAudioPick { codec: string; muxCodec: string; sampleRate: number; numberOfChannels: number; bitrate: number }

// from export.ts:pickWebCodecsAudio
async function pickWebCodecsAudio(container: 'mp4' | 'webm'): Promise<SeqAudioPick | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  const sampleRate = MIX_RATE, numberOfChannels = MIX_CHANNELS, bitrate = AUDIO_BITRATE;
  const cand = container === 'mp4'
    ? { codec: 'mp4a.40.2', muxCodec: 'aac' }
    : { codec: 'opus', muxCodec: 'A_OPUS' };
  try {
    const s = await AudioEncoder.isConfigSupported({ codec: cand.codec, sampleRate, numberOfChannels, bitrate });
    if (s?.supported) return { ...cand, sampleRate, numberOfChannels, bitrate };
  } catch { /* unsupported */ }
  return null;
}

// from export.ts:withVideoMeta — provenance tags into the container, before the
// C2PA stamp renderFormat applies to whatever this function returns.
async function withVideoMeta(blob: Blob, container: string, meta: ExportOpts['meta'], host: SeqHost | null): Promise<Blob> {
  if (!meta) return blob;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const tags = videoProvenanceTags(meta as never, new Date());
    const out = container === 'video/mp4' ? embedMp4Meta(bytes, tags) : embedWebmMeta(bytes, tags);
    if (out === bytes) host?.log?.('warn', 'Provenance metadata not embedded (unrecognised container structure).');
    return new Blob([out as BlobPart], { type: container });
  } catch (err) {
    host?.log?.('warn', `Provenance metadata not embedded (${(err as { message?: string })?.message ?? err}).`);
    return blob;
  }
}

// from export.ts:manualCaptureStream
function manualCaptureStream(canvas: HTMLCanvasElement, fps: number): { stream: MediaStream; deliver: () => void } {
  const s = canvas.captureStream(0);
  const track = s.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  if (typeof track?.requestFrame === 'function') return { stream: s, deliver: () => track.requestFrame() };
  s.getTracks().forEach((t) => t.stop());
  return { stream: canvas.captureStream(fps), deliver: () => {} };
}

// from export.ts:videoMimeType (inlined — two lines, and importing it statically
// would drag the whole rasteriser into this lazy chunk's dependency graph).
function videoMimeType(preferred: string, audio: boolean): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return videoMimeCandidates(preferred, { audio }).find((t) => MediaRecorder.isTypeSupported?.(t)) ?? null;
}

// ── the audio envelope (from export.ts:connectMusic) ────────────────────────

interface BedFade {
  fadeIn?: number;
  fadeOut?: number;
  clipSec?: number;
  volume?: number;
  /** Duck the bed under the sequence's own audio: `level` is the centre gain
   *  multiplier, `spans` the clip-time windows where sequence audio plays. The
   *  bed runs at full volume between and around them (top/tail intro-outro). */
  duck?: { level: number; spans: DuckSpan[] };
  /** Gain ramp seconds. Defaults to the legacy snappy 0.25 for clip ducks
   *  (speech-under-bed; a short clip must SIT at the ducked level — pinned by
   *  tests/sequence-render.browser.test.ts). The §6.1 mix-in path passes the
   *  slower musical MIX_RAMP_SEC. */
  rampSec?: number;
  /** In-point into the SOURCE, seconds. Independent of the envelope, which is
   *  still timed from t0 against clipSec. */
  start?: number;
}

/**
 * Connect a looping music bed through a gain envelope, scheduled at t=0.
 *
 * The automation itself is bedDuckEnvelope (audio-envelope.ts) — the same math
 * export.ts's mix graphs consume, so a bed ducks identically in a tool export
 * and a sequence render: fade in, glide down to volume·level over each span of
 * sequence audio (~0.8 s ramps, never steps), back to full between spans, fade
 * out. Started immediately because an OfflineAudioContext's currentTime is 0 and
 * never advances until rendering.
 */
function connectBed(ctx: BaseAudioContext, buffer: AudioBuffer, dest: AudioNode, fade: BedFade, log: (l: string, m: string) => void): void {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  // In-point, reproduced from export.ts:bedStartOffset (importing it would drag that
  // module's whole graph into this lazy chunk — the same reason rasterBox is copied).
  // loopStart/loopEnd move with it: loopStart defaults to 0, so a wrap would otherwise
  // replay the head of the track the visuals deliberately skipped, and loopEnd only
  // means "end of buffer" while untouched.
  let offset = fade.start ?? 0;
  if (!Number.isFinite(offset) || offset <= 0) offset = 0;
  else if (offset >= buffer.duration) {
    log('warn', `Audio starts at ${offset}s but the track is only ${buffer.duration.toFixed(2)}s long; playing it from 0:00.`);
    offset = 0;
  }
  if (offset > 0) { src.loopStart = offset; src.loopEnd = buffer.duration; }
  const gain = ctx.createGain();
  src.connect(gain).connect(dest);
  const events = bedDuckEnvelope({
    clipSec: fade.clipSec ?? 0,
    volume: fade.volume,
    centre: fade.duck?.level ?? 1,
    spans: fade.duck?.spans ?? [],
    fadeIn: fade.fadeIn,
    fadeOut: fade.fadeOut,
    // Clip ducks are speech-under-bed: the legacy 0.25s ramps, so a short clip
    // actually SITS at the ducked level instead of riding a 0.8s triangle
    // (tests/sequence-render.browser.test.ts pins this). The §6.1 mix-in call
    // passes the slower musical MIX_RAMP_SEC explicitly.
    rampSec: fade.rampSec ?? 0.25,
  });
  scheduleGainEvents(gain.gain, events, ctx.currentTime);
  src.start(0, offset);
}

// ── rasterisation (the renderRecord technique) ──────────────────────────────

/**
 * Rasterise ONE box, unrotated, at capture scale.
 *
 * Reproduced from export.ts:renderRecord's `rasterBox` (it is module-private
 * there): render the element at its authored size but transform-scaled to the
 * export's pixel size, so text and vectors are resampled rather than upscaled.
 * `hide` is temporarily display:none'd for the shot — that is how a video box's
 * background/chrome is captured without the (blank-serialising) <video> in it.
 */
interface RasterOpts {
  /** Shoot the element with no background of its own (the video "over" plate). */
  transparentBg?: boolean;
  /**
   * Shoot the element at full opacity.
   *
   * A box's authored `opacity` belongs to the PLANNER: `PlanItem.alpha` is already
   * `layer.opacity x transition alpha`, and `drawItem` puts it on `globalAlpha`. If
   * the raster also carried the element's own opacity it would be applied twice and
   * a 0.45 box would export at 0.20. Every `.lolly-box` raster must set this; the
   * stage raster must not, because the artboard is not a planned layer.
   */
  opaque?: boolean;
}

async function rasterBox(
  el: HTMLElement, S: number, hide: Element[] = [], ropts: RasterOpts = {},
): Promise<HTMLCanvasElement | null> {
  const lib = await getDomToImage();
  const bw = Math.max(1, parseFloat(el.style.width) || el.offsetWidth || 1);
  const bh = Math.max(1, parseFloat(el.style.height) || el.offsetHeight || 1);
  const restore: (() => void)[] = [];
  // THE STAGE IS LIVE, AND THE CLOCK HAS BEEN ON IT. Every box outside the
  // playhead window carries `.seq-off`, which timeline.css turns into
  // `display:none !important`, and dom-to-image copies the computed cssText
  // wholesale into its clone — so a box that is merely "not under the playhead"
  // rasterises BLANK, and an export taken with the playhead at 4 s would ship
  // picture for exactly one clip. Cleared for the duration of the shot only (so
  // nothing flickers on screen for longer than a frame) and restored on every
  // path, including a thrown serialisation.
  for (const off of [
    ...(el.classList?.contains?.(OFF_CLASS) ? [el] : []),
    ...(el.querySelectorAll?.(`.${OFF_CLASS}`) ?? []),
  ]) {
    off.classList.remove(OFF_CLASS);
    restore.push(() => off.classList.add(OFF_CLASS));
  }
  for (const h of hide) {
    const s = (h as HTMLElement).style;
    const prev = s.display;
    s.display = 'none';
    restore.push(() => { s.display = prev; });
  }
  if (ropts.transparentBg) {
    const prev = el.style.background;
    el.style.background = 'transparent';
    restore.push(() => { el.style.background = prev; });
  }
  if (ropts.opaque) {
    const prev = el.style.opacity;
    el.style.opacity = '1';
    restore.push(() => { el.style.opacity = prev; });
  }
  try {
    return await lib.toCanvas(el, {
      width: Math.max(1, Math.round(bw * S)),
      height: Math.max(1, Math.round(bh * S)),
      style: {
        transform: `scale(${S})`, transformOrigin: 'top left',
        width: `${bw}px`, height: `${bh}px`, left: '0', top: '0', margin: '0',
      },
    });
  } catch {
    return null;
  } finally {
    for (const r of restore.reverse()) r();
  }
}

// ── the audio mix ───────────────────────────────────────────────────────────

interface MixResult {
  buffer: AudioBuffer | null;
  hasClipAudio: boolean;
  /** Whether a music bed actually CONNECTED — false when none was picked and false
   *  when the pick could not be fetched or decoded. Not the same as `opts.audio.url`
   *  being set, which is only the request. The video path does not care (a bed that
   *  failed leaves silent-but-harmless space under the picture); an audio-only
   *  export does, because with no clip audio either the whole file would be that
   *  silence. */
  hasBed: boolean;
}

/**
 * One OfflineAudioContext carrying every clip's own sound plus the export bar's
 * music bed, ducked under the clips.
 *
 * v1 rule: a clip whose `speed !== 1` is MUTED with a warning. Resampling PCM to
 * a new rate is easy; time-stretching it without a pitch shift is a real DSP
 * project, and a chipmunk voiceover is worse than a silent one.
 */
async function mixSequenceAudio(
  layers: SeqLayer[], totalSec: number, opts: ExportOpts, host: SeqHost | null,
): Promise<MixResult> {
  const OAC = (globalThis as any).OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext;
  if (!OAC || !(totalSec > 0)) return { buffer: null, hasClipAudio: false, hasBed: false };
  const log = (l: string, m: string): void => host?.log?.(l, m);

  const octx: OfflineAudioContext = new OAC(MIX_CHANNELS, Math.max(1, Math.ceil(totalSec * MIX_RATE)), MIX_RATE);
  const spans: { from: number; to: number }[] = [];

  for (const L of layers) {
    if (L.kind !== 'video' && L.kind !== 'audio') continue;
    if (L.mute) continue;
    if (L.durMs <= 0) continue;
    if (L.speed !== 1) {
      log('warn', `sequence audio: a clip at ${Math.round(L.startMs)}ms plays at ${L.speed}× — muted (v1 does not time-stretch audio).`);
      continue;
    }
    const url = mediaSrc(L);
    if (!url) {
      if (L.kind === 'audio') {
        log('warn', `sequence audio: the audio box at ${Math.round(L.startMs)}ms has no source — it will be silent.`);
      }
      continue;
    }
    let clip: ClipAudio | null = null;
    try {
      clip = await createClipAudio(url, { log });
    } catch (err) {
      log('warn', `sequence audio: ${toCodedError(err).message} — clip will be silent`);
      continue;
    }
    if (!clip) {
      // createClipAudio returns null for BOTH "this file has no audio track" and
      // "nothing here could open it". For a video layer the first is the common,
      // correct answer and warning would be noise. For an AUDIO BOX it never is:
      // the user placed it precisely to be heard, so a null is always worth
      // saying out loud. This branch used to be a bare `continue`, which is how
      // an unregistered container (Ogg/Opus and MP3 — i.e. the entire shipped
      // music catalog) produced a silent export with nothing in the log at all.
      if (L.kind === 'audio') {
        log('warn', `sequence audio: could not decode the audio box at ${Math.round(L.startMs)}ms (${url.slice(0, 120)}) — it will be silent. If this is an unusual container, re-encode it as mp3, m4a, ogg, wav or flac.`);
      }
      continue;
    }
    try {
      const from = L.clipInMs / 1000;
      const srcDur = clip.durationSec();
      // Never ask for audio past the end of the MIX. The OfflineAudioContext is
      // only `totalSec` long, so a sample starting at `startMs` can contribute at
      // most `totalSec - startMs` of sound and everything beyond that is
      // allocated, resampled, copied and then thrown away. For a decoded file the
      // source's own end already caps it — but a PROCEDURAL clip reports
      // `durationSec() === 0` by design ("I am composed to fit"), so it has no cap
      // at all: an audio box left at the parser's ceiling (MAX_TIME_MS = 1 hour)
      // would allocate ~1.4 GB of Float32 for a five-second render, twice over.
      const room = Math.max(0, totalSec - L.startMs / 1000);
      const span = Math.min(L.durMs / 1000, room);
      const to = srcDur > 0 ? Math.min(from + span, srcDur) : from + span;
      if (!(to > from)) continue;
      const { channels } = await clip.pcm(from, to, MIX_RATE);
      const frames = channels[0]?.length ?? 0;
      if (!frames) continue;
      const buf = octx.createBuffer(Math.max(1, Math.min(MIX_CHANNELS, channels.length)), frames, MIX_RATE);
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        // The provider's planes may be views on a shared buffer; copyToChannel's
        // lib.dom signature insists on a plain ArrayBuffer-backed view.
        buf.copyToChannel(channels[Math.min(ch, channels.length - 1)] as unknown as Float32Array<ArrayBuffer>, ch);
      }
      const node = octx.createBufferSource();
      node.buffer = buf;
      node.connect(octx.destination);
      node.start(Math.max(0, L.startMs / 1000));
      spans.push({ from: L.startMs / 1000, to: L.startMs / 1000 + frames / MIX_RATE });
    } catch (err) {
      log('warn', `sequence audio: ${toCodedError(err).message} — clip will be silent`);
    } finally {
      await clip.dispose().catch(() => { /* already released */ });
    }
  }

  let hasBed = false;
  if (opts.audio?.url) {
    try {
      const bytes = await (await fetch(opts.audio.url)).arrayBuffer();
      const bed = await octx.decodeAudioData(bytes);
      // Per-span ducking: the bed returns to full volume BETWEEN clips too, not
      // just before the first and after the last (bedDuckEnvelope merges spans
      // whose gap is too short for the bed to meaningfully come back up).
      const duckLevel = clamp01(opts.audio.duck ?? 1);
      const duck = spans.length && duckLevel < 1 ? { level: duckLevel, spans } : undefined;
      connectBed(octx, bed, octx.destination, {
        fadeIn: opts.audio.fadeIn, fadeOut: opts.audio.fadeOut,
        clipSec: totalSec, volume: opts.audio.volume, duck, start: opts.audio.start,
      }, log);
      hasBed = true;
      // A mix-in track (a tool with its own audio, §6.1). The primary bed above
      // loops the whole clip here, so the mix-in ducks to its centre level for
      // the full duration rather than being silently dropped.
      if (opts.audio.mix?.url) {
        try {
          const bed2 = await octx.decodeAudioData(await (await fetch(opts.audio.mix.url)).arrayBuffer());
          const centre = clamp01(opts.audio.mix.centre ?? 1);
          connectBed(octx, bed2, octx.destination, {
            fadeIn: opts.audio.mix.fadeIn, fadeOut: opts.audio.mix.fadeOut,
            clipSec: totalSec, volume: opts.audio.mix.volume,
            duck: centre < 1 ? { level: centre, spans: [{ from: 0, to: totalSec }] } : undefined,
            rampSec: MIX_RAMP_SEC,
          }, log);
        } catch (err) {
          log('warn', `Mix-in track unavailable (${(err as { message?: string })?.message ?? err}); exporting without it.`);
        }
      }
    } catch (err) {
      log('warn', `Music bed unavailable (${(err as { message?: string })?.message ?? err}); exporting without it.`);
    }
  }

  if (!spans.length && !hasBed) return { buffer: null, hasClipAudio: false, hasBed: false };
  try {
    return { buffer: await octx.startRendering(), hasClipAudio: spans.length > 0, hasBed };
  } catch (err) {
    log('warn', `Audio mix failed (${(err as { message?: string })?.message ?? err}); exporting silent.`);
    return { buffer: null, hasClipAudio: false, hasBed: false };
  }
}

/** The URL a media layer decodes from — the <video>'s src, or the audio marker's. */
function mediaSrc(L: SeqLayer): string {
  const el = L.el;
  if (L.kind === 'audio') {
    const m = el.matches?.('[data-audio-src]') ? el : el.querySelector?.('[data-audio-src]');
    return m?.getAttribute('data-audio-src') ?? '';
  }
  const v = (el.matches?.('video') ? el : el.querySelector?.('video')) as HTMLVideoElement | null;
  return v ? (v.currentSrc || v.getAttribute('src') || '') : '';
}

/**
 * The mixed timeline audio as planar PCM: every unmuted clip's own sound plus the
 * export bar's music bed, ducked under them. This is what an audio-only export
 * (wav/mp3/m4a/opus) of a sequence IS — the soundtrack of the video export, in a
 * file with no picture.
 *
 * It runs the SAME `mixSequenceAudio` the mp4/webm path feeds to the muxer, over
 * the same layers at the same length, because a second mixer would drift and the
 * exported wav would stop matching the exported mp4's sound — which is the whole
 * point of offering the format.
 *
 * `null` means there is genuinely nothing to mix (no bed, and no unmuted clip that
 * carries sound). That is exactly the case in which the video path exports silent
 * video; the audio-only caller turns it into a refusal instead, because a file
 * that is only silence reads as a broken export rather than an empty one.
 *
 * Shape matches `AudioPcm` in lib/audio-encode.ts, which is the DOM convention
 * export.ts's `lollyAudioSource()` reads. The import is type-only so the encoders
 * (lamejs, the muxers) stay off this module's graph.
 */
export async function sequenceAudioPcm(
  node: Element, opts: ExportOpts, host: SeqHost | null = null,
): Promise<AudioPcm | null> {
  const parsed = parseSequenceStage(node as HTMLElement);
  const stage = parsed ? applyDurationOverride(parsed, opts) : null;
  if (!stage || !stage.totalMs) throw sequenceError('SEQ_DECODE_FAILED', 'not a timed sequence stage');
  if (stage.totalMs > MAX_SEQUENCE_MS) {
    throw sequenceError('SEQ_TOO_HEAVY', `sequence is ${Math.round(stage.totalMs / 1000)}s; the export ceiling is ${MAX_SEQUENCE_MS / 1000}s`);
  }
  // Length is derived through the frame grid rather than from totalMs directly,
  // so it is the identical number renderSequence hands the mix for mp4/webm (the
  // streaming path never caps the grid). Same fps default, same rounding.
  const fps = Math.max(1, Math.round(opts.fps ?? 30));
  const grid = frameTimestamps(stage.totalMs, fps);
  if (!grid.length) throw sequenceError('SEQ_DECODE_FAILED', 'sequence has no frames');

  const mix = await mixSequenceAudio(stage.layers, grid.length / fps, opts, host);
  if (!mix.buffer || (!mix.hasClipAudio && !mix.hasBed)) return null;
  const buffer = mix.buffer;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch));
  return { channels, sampleRate: buffer.sampleRate };
}

// ── the orchestrator ────────────────────────────────────────────────────────

/**
 * Render a `[data-sequence]` stage to a motion file.
 *
 * Contract with the export funnel: this returns the finished container with
 * provenance tags already embedded (like every other video renderer); the C2PA
 * stamp is applied uniformly by renderFormat afterwards.
 */
export async function renderSequence(
  node: Element, format: 'mp4' | 'webm' | 'gif' | 'apng', opts: ExportOpts, host: SeqHost | null = null,
): Promise<Blob> {
  const log = (l: string, m: string): void => host?.log?.(l, m);
  // The stage declares its own length (data-seq-ms), which is the default and tracks
  // the timeline. A duration the USER typed into the export bar overrides it — the
  // override lands here, before the ceiling check and before anything is sized off
  // totalMs, so the whole render (frame grid, open-ended layers, audio, the
  // truncation verdict) is derived from one number.
  const parsed = parseSequenceStage(node as HTMLElement);
  const stage = parsed ? applyDurationOverride(parsed, opts) : null;
  if (!stage || !stage.totalMs) throw sequenceError('SEQ_DECODE_FAILED', 'not a timed sequence stage');
  if (stage.totalMs > MAX_SEQUENCE_MS) {
    throw sequenceError('SEQ_TOO_HEAVY', `sequence is ${Math.round(stage.totalMs / 1000)}s; the export ceiling is ${MAX_SEQUENCE_MS / 1000}s`);
  }

  const stageEl = ((node as HTMLElement).matches?.('[data-sequence]') ? node : node.querySelector('[data-sequence]')) as HTMLElement;
  const nativeW = Math.max(1, stageEl.offsetWidth || 1920);
  const nativeH = Math.max(1, stageEl.offsetHeight || 1080);
  const wantW = Number(opts.width);
  const wantH = Number(opts.height);
  // Even dimensions: H.264 chroma subsampling refuses an odd width or height. The
  // rounding happens BEFORE the scale is derived, so an odd requested width is
  // resampled to fit rather than losing its last pixel column of content.
  const outW = Math.max(2, Math.round(Number.isFinite(wantW) && wantW > 0 ? wantW : nativeW)) & ~1;
  const S = outW / nativeW;
  const targetH = Math.max(2, Math.round(nativeH * S) & ~1);
  if (Number.isFinite(wantH) && wantH > 0 && Math.abs(wantH - targetH) > 2) {
    log('warn', `sequence: exporting ${outW}x${targetH} — a sequence keeps the stage's aspect ratio, so the requested height (${Math.round(wantH)}) is derived from the width.`);
  }

  const fps = format === 'gif' ? GIF_FPS : Math.max(1, Math.round(opts.fps ?? 30));
  const grid = frameTimestamps(stage.totalMs, fps);
  if (!grid.length) throw sequenceError('SEQ_DECODE_FAILED', 'sequence has no frames');

  const streaming = format === 'mp4' || format === 'webm';
  // Encoder selection happens HERE, before anything is sized against the frame
  // count, because whether WebCodecs can encode decides whether the frame cap
  // applies: the streaming muxer holds no frames, the MediaRecorder fallback holds
  // an ImageBitmap for every one of them.
  const bitrate = videoBitrate(outW, targetH, fps);
  const pick = streaming ? await pickWebCodecsVideo(format, outW, targetH, fps, bitrate) : null;
  if (streaming && !pick) {
    log('warn', 'sequence: WebCodecs encode unavailable — falling back to a real-time MediaRecorder replay (correct, but as slow as the clip is long).');
  }

  let frameCount = grid.length;
  if (streaming && pick) {
    if (frameCount > fps * (MAX_SEQUENCE_MS / 1000)) {
      throw sequenceError('SEQ_TOO_HEAVY', `sequence needs ${frameCount} frames`);
    }
  } else {
    // Every non-streaming path buffers each frame — gif/apng as pixels or encoded
    // PNGs, the MediaRecorder fallback as ImageBitmaps — so the historical memory
    // cap applies to all of them (see the header).
    const cap = maxVideoFrames();
    if (frameCount > cap) {
      log('warn', `${format.toUpperCase()} capped at ${cap} frames (requested ${frameCount}); shorten the sequence, or export mp4/webm, to fit it all in.`);
      frameCount = cap;
    }
  }
  // ONE grid for everything downstream: the frame loop, every layer's activity
  // window, the overlap budget and the truncation verdict. Deriving any of those
  // from the uncapped grid is how a complete gif export dies as SEQ_TRUNCATED.
  const usedGrid = frameCount === grid.length ? grid : grid.slice(0, frameCount);

  // Overlapping-clip budget, checked BEFORE any decoder is opened so a hopeless
  // composition fails in milliseconds instead of half way through a render.
  const junctions = crossfadeJunctions(stage.layers);
  const ext = new Map(junctions.map((j) => [j.aIdx, j.ms]));
  for (const j of junctions) {
    const a = stage.layers.find((l) => l.idx === j.aIdx);
    if (a && a.exitMs > j.ms) {
      log('info', `sequence: the crossfade at ${Math.round(a.startMs + a.durMs)}ms runs ${j.ms}ms — the shorter of the two clips' fade lengths (this clip authored ${a.exitMs}ms). Match the two fade lengths to get the longer dissolve.`);
    }
  }
  // Activity windows for the OVERLAP BUDGET only — the executor derives its own
  // from the same wire layers and the same grid, so the two cannot disagree.
  const win = new Map<number, { first: number; last: number; span: number[] }>();
  for (const L of stage.layers) win.set(L.idx, activeFrameWindow(L, usedGrid, ext.get(L.idx) ?? 0));
  {
    let peak = 0;
    for (let i = 0; i < frameCount; i++) {
      let n = 0;
      for (const L of stage.layers) {
        if (L.kind !== 'video') continue;
        const r = win.get(L.idx)!;
        if (r.first >= 0 && i >= r.first && i <= r.last) n++;
      }
      peak = Math.max(peak, n);
    }
    if (peak > MAX_LIVE_PROVIDERS) {
      throw sequenceError('SEQ_TOO_HEAVY', `${peak} video clips overlap; at most ${MAX_LIVE_PROVIDERS} can be decoded at once`);
    }
  }

  const transparent = opts.background === 'transparent';
  const wire: SeqJobLayer[] = [];
  const plates: SeqJob['plates'] = [];
  const clips: SeqJob['clips'] = [];
  /** Layers whose picture must be re-rastered off the LIVE player every frame. */
  const liveBoxes = new Map<number, { marker: Element; box: HTMLElement }>();
  let bgRaster: HTMLCanvasElement | null = null;
  // The timeline panel's frame thumbnails run through the SAME dom-to-image instance
  // this render is about to drive, and that library's options / url cache / sandbox
  // iframe are module-global — whichever call tears down first clears them out from
  // under the other, corrupting both pictures. Hold them for the whole render.
  const resumeThumbRasters = suspendNodeRasters();

  try {
    // Suspending stops the NEXT thumbnail shot; the one already inside the library
    // cannot be cancelled, only waited out — and its teardown would clear the sandbox
    // iframe and url cache out from under the first rasterBox below.
    await drainNodeRasters();
    // ── static + chrome rasters (once each) ───────────────────────────────
    // dom-to-image needs the live DOM, so this is the half of the render that can
    // never move to a worker. Everything downstream consumes the canvases it
    // produces and nothing else.
    const restoreBlobs = await swapBlobUrls(stageEl);
    try {
      if (!transparent) {
        bgRaster = await rasterBox(stageEl, S, [...stageEl.querySelectorAll('.lolly-box')]);
      }
      for (const L of stage.layers) {
        const w = win.get(L.idx)!;
        const el = L.el;
        let under: HTMLCanvasElement | null = null;
        let over: HTMLCanvasElement | null = null;
        let media: HTMLElement | null = null;
        let needsLiveRaster = false;
        if (w.first >= 0 && L.kind !== 'audio') {
          if (L.kind === 'video') {
            media = (el.matches?.('video') ? el : el.querySelector('video')) as HTMLElement | null;
            // A ZIP bundle re-dispatches each sub-format through renderFormat, whose
            // motion guard keys on the OUTER format ('zip'), so snapshotMotion has
            // already frozen every <video> into a sibling <img>. That still must be
            // hidden too or it bakes into `over` and sits frozen on top of every
            // decoded frame for the clip's whole span.
            const hide = [
              ...(media ? [media] : []),
              ...el.querySelectorAll('[data-motion-still]'),
            ];
            under = await rasterBox(el, S, hide, { opaque: true });
            over = await rasterBox(el, S, hide, { transparentBg: true, opaque: true });
          } else if (L.kind === 'lottie') {
            const marker = el.matches?.('[data-lottie-src]') ? el : el.querySelector('[data-lottie-src]');
            under = await rasterBox(el, S, [], { opaque: true }); // the still fallback if no player mounted
            // A lottie layer only forces the hybrid split when a live player is
            // actually mounted; without one the static plate IS the picture, and
            // the sequence still runs fully worker-side.
            const player = marker ? (lottiePlayerFor(marker) as LottieScrubber | null) : null;
            if (marker && player?.goToAndStop) {
              liveBoxes.set(L.idx, { marker, box: el });
              needsLiveRaster = true;
            }
          } else {
            under = await rasterBox(el, S, [], { opaque: true });
          }
        }
        plates.push({ idx: L.idx, under, over });
        wire.push(toJobLayer(L, {
          // The inline style, exactly as the old in-draw read took it.
          objectFit: media?.style?.objectFit ?? '',
          objectPosition: media?.style?.objectPosition ?? '',
          needsLiveRaster,
        }));
        if (L.kind === 'video' && w.first >= 0) {
          const url = mediaSrc(L);
          if (url) clips.push({ idx: L.idx, src: url });
        }
      }
    } finally {
      restoreBlobs();
    }

    // ── audio (independent of the frame loop, so it is resolved up front) ──
    // Length is the ACTUAL clip length (frameCount/fps), not the authored one, so a
    // capped gif/apng and a full-length mp4 both get a bed that ends where they do.
    // OfflineAudioContext is main-thread only; the worker receives the rendered PCM.
    const mix = streaming ? await mixSequenceAudio(stage.layers, (frameCount / fps), opts, host) : { buffer: null, hasClipAudio: false, hasBed: false };
    const audioPick = pick && mix.buffer ? await pickWebCodecsAudio(pick.container) : null;

    const job: SeqJob = {
      layers: wire, grid: usedGrid, frameCount, fps, totalMs: stage.totalMs,
      outW, outH: targetH, scale: S,
      bg: bgRaster, plates, clips,
      maxLiveProviders: MAX_LIVE_PROVIDERS, watchdogMs: WATCHDOG_MS,
    };
    const liveRaster = makeLiveRaster(liveBoxes, S);
    const hybrid = liveBoxes.size > 0;

    // ── which thread executes ─────────────────────────────────────────────
    if (pick && supportsWorkerSequenceRender()) {
      log('info', `sequence: worker offload — ${hybrid
        ? `HYBRID (${liveBoxes.size} lottie layer(s) rastered on the main thread, one request in flight)`
        : 'fully worker-side (decode, composite, encode and mux all off the main thread)'}`);
      try {
        const blob = await renderSequenceInWorker(job, pick, bitrate, audioPick, mix.buffer, {
          log,
          progress: (d, t) => opts.onProgress?.(d, t),
          live: liveRaster,
        });
        return await withVideoMeta(blob, blob.type, opts.meta, host);
      } catch (err) {
        // A CODED failure is the render's real verdict (a truncated source, a
        // codec that isn't there, a cancel) — re-running it in-thread would only
        // reach the same answer more slowly. Anything else is the offload itself
        // failing, and the in-thread path is the honest fallback: the plates are
        // still canvases, so the retry costs no re-rasterisation.
        if (err instanceof SequenceError) throw err;
        log('warn', `sequence: worker offload unavailable (${(err as { message?: string })?.message ?? err}) — rendering in-thread.`);
      }
    }

    return await renderInThread(job, mix, audioPick, liveRaster);
  } catch (err) {
    const coded = toCodedError(err);
    log('error', `sequence export failed (${coded.code}): ${coded.message}`);
    throw err;
  } finally {
    resumeThumbRasters();
  }

  // ── inner helpers (closures over the render's state) ──────────────────────

  /**
   * The historical path: one compositor (`runSequenceJob`), driven here, with the
   * frame sink chosen by output format. Unchanged in behaviour — the loop, the
   * watchdog labels, the provider lifecycle and the reconciliation all now live
   * in the executor the worker runs too, which is what makes the two identical.
   */
  async function renderInThread(
    job: SeqJob, mix: MixResult, audioPick: SeqAudioPick | null, liveRaster: SeqJobIO['lottieAt'],
  ): Promise<Blob> {
    const canvas: AnyCanvas = streaming && typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(outW, targetH)
      : Object.assign(document.createElement('canvas'), { width: outW, height: targetH });
    const ctx = (canvas as unknown as { getContext(id: string, o?: unknown): unknown }).getContext('2d', { alpha: true }) as AnyCtx | null;
    if (!ctx) throw sequenceError('SEQ_DECODE_FAILED', 'no 2D context for the sequence canvas');

    let mux: StreamingMux | null = null;
    const bitmaps: ImageBitmap[] = [];             // MediaRecorder fallback only
    const apngFrames: Uint8Array[] = [];
    const gifPixels: Uint8ClampedArray[] = [];
    try {
      if (pick) {
        mux = await createStreamingMux(pick, {
          width: outW, height: targetH, fps, bitrate,
          audio: audioPick ? { ...audioPick, channels: [] } : null,
        });
        log('info', `sequence: WebCodecs ${pick.container}/${pick.codec}${audioPick ? `+${audioPick.codec}` : ''} ${outW}×${targetH}@${fps} ${frameCount}f (in-thread)`);
      }

      await runSequenceJob(job, canvas, ctx, {
        log,
        lottieAt: liveRaster,
        progress: (done, total) => opts.onProgress?.(done, total),
        frame: async (c, cx, _i, tsUs) => {
          if (mux) await mux.addFrame(c as CanvasImageSource, tsUs);
          else if (streaming) bitmaps.push(await createImageBitmap(c as ImageBitmapSource));
          else if (format === 'apng') apngFrames.push(new Uint8Array(await (await canvasBlob(c, 'image/png')).arrayBuffer()));
          else gifPixels.push((cx as CanvasRenderingContext2D).getImageData(0, 0, outW, targetH).data);
        },
      });

      if (mux) {
        if (mix.buffer && audioPick) await mux.addAudio(mix.buffer);
        const blob = await mux.finalize();
        mux = null;
        return await withVideoMeta(blob, blob.type, opts.meta, host);
      }
      if (streaming) return await recorderReplay(bitmaps, canvas as HTMLCanvasElement, ctx as CanvasRenderingContext2D, format, fps, opts, host);
      if (format === 'apng') return await apngBlob(apngFrames, fps, opts);
      return await gifBlob(gifPixels, outW, targetH, opts);
    } finally {
      if (mux) { try { await mux.abort(); } catch { /* already down */ } }
    }
  }
}

// ── the live (lottie) raster, the one thing the worker cannot do ────────────

/** The slice of a lottie-web player the exporter scrubs. */
interface LottieScrubber { goToAndStop?(v: number, isFrame?: boolean): void; frameRate?: number }

/**
 * Build the per-frame live-raster function, or `undefined` when no layer needs one.
 *
 * Memoised on the animation's OWN frame number, so a 30 fps export of a 12 fps
 * Lottie rasterises 12 times a second, not 30. A single-entry memo per layer is
 * enough (the grid is monotonic, so repeats are always consecutive) and keeps
 * the cache O(1) instead of growing with the clip. That memo is also what makes
 * the worker's per-frame request cheap: most frames are answered from it without
 * touching lottie-web or dom-to-image at all.
 */
function makeLiveRaster(
  boxes: Map<number, { marker: Element; box: HTMLElement }>, S: number,
): SeqJobIO['lottieAt'] {
  if (!boxes.size) return undefined;
  const memo = new Map<number, { key: number; shot: HTMLCanvasElement }>();
  return async (layerIdx, _frame, sourceSec) => {
    const entry = boxes.get(layerIdx);
    if (!entry) return null;
    const player = lottiePlayerFor(entry.marker) as LottieScrubber | null;
    if (!player?.goToAndStop) return null;
    const rate = Number.isFinite(player.frameRate) && (player.frameRate as number) > 0 ? (player.frameRate as number) : 30;
    const key = Math.round(sourceSec * rate);
    const prev = memo.get(layerIdx);
    if (prev && prev.key === key) return prev.shot;
    try { player.goToAndStop((key / rate) * 1000, false); } catch { return prev?.shot ?? null; }
    const shot = await rasterBox(entry.box, S, [], { opaque: true });
    if (shot) { memo.set(layerIdx, { key, shot }); return shot; }
    return prev?.shot ?? null;
  };
}

// ── the Worker client (modelled on bridge/video-encode.ts) ──────────────────
//
// Same conventions as the shipped video-encode worker client: ONE lazily spawned
// module worker, respawned on error, runs keyed by id, an opt-in localStorage
// gate and an up-front capability probe. The differences are inherent to this
// being a long render rather than a single call: progress and log messages flow
// back during the run, the main thread answers 'need-live' requests mid-render,
// and an abort has to reach a loop that is already going.

/** What one in-flight worker render needs from its caller. */
interface SeqWorkerRun {
  resolve(b: Blob): void;
  reject(e: unknown): void;
  log(level: string, msg: string): void;
  progress(done: number, total: number): void;
  live?: SeqJobIO['lottieAt'];
  /** Restart the liveness deadline — called for every message this run sends. */
  touch(): void;
  /** Stop the liveness deadline (the run settled). */
  clear(): void;
}

/**
 * How long the CLIENT waits without hearing anything from a run before it gives up.
 *
 * The executor's own `watchdogMs` protects the frame loop, but it runs on the
 * WORKER's event loop: a thread killed for memory pressure (Chrome does not
 * reliably surface that as an `error` on the parent) or wedged inside a
 * synchronous native decode cannot fire its own timer either, and the returned
 * promise would then never settle — the export UI hangs with no error at all.
 * This is the only deadline that survives the worker dying silently. Generous by
 * design: a frame that is merely slow is the worker's watchdog's business, not this
 * one's, and every message a run emits (progress, log, need-live) resets it.
 */
const SEQ_CLIENT_SILENCE_MS = 60_000;

let seqWorker: Worker | null = null;
let seqRunSeq = 0;
const seqPending = new Map<number, SeqWorkerRun>();

/** Swappable so a test can drive the protocol against a stub port. */
let seqWorkerFactory: () => Worker = () =>
  new Worker(new URL('./sequence-render.worker.ts', import.meta.url), { type: 'module' });

/** TEST SEAM: replace the worker factory (pass null to restore the real one). */
export function _setSequenceWorkerFactory(f: (() => Worker) | null): void {
  // Swapping the factory tears the current worker down, so any run still on it
  // would hang forever waiting for a thread that no longer exists. Settle them.
  abortSequenceWorkerRenders('the worker factory was replaced');
  seqWorkerFactory = f ?? (() => new Worker(new URL('./sequence-render.worker.ts', import.meta.url), { type: 'module' }));
  disposeSequenceWorker();
}

/** Drop the worker instance itself (does not touch pending runs). */
function disposeSequenceWorker(): void {
  const w = seqWorker;
  seqWorker = null;
  if (!w) return;
  w.onmessage = null;
  w.onerror = null;
  try { w.terminate(); } catch { /* already gone */ }
}

/**
 * Cancel every render when the page goes away.
 *
 * Armed on first spawn rather than at import (this module is lazily loaded, and a
 * listener that only matters once a worker exists should not be a side effect of
 * loading the file). Without it, navigating away mid-export leaves a full
 * decode+composite+encode of the whole sequence running invisibly off-thread,
 * holding its providers, its canvas and a growing muxer buffer, until the tab
 * closes. In-thread that work died with the render; off-thread it does not.
 */
let seqPageHideArmed = false;
function armSeqPageHide(): void {
  if (seqPageHideArmed) return;
  seqPageHideArmed = true;
  try {
    globalThis.addEventListener?.('pagehide', () => abortSequenceWorkerRenders('the page was closed'));
  } catch { /* no event target (node tests) */ }
}

function ensureSeqWorker(): Worker {
  if (seqWorker) return seqWorker;
  armSeqPageHide();
  const w = seqWorkerFactory();
  w.onmessage = (e: MessageEvent<SeqWorkerOut>): void => { void onSeqWorkerMessage(w, e.data); };
  w.onerror = (): void => {
    for (const run of seqPending.values()) { run.clear(); run.reject(new Error('sequence-render worker error')); }
    seqPending.clear();
    disposeSequenceWorker();      // the next render spawns a fresh one
  };
  seqWorker = w;
  return w;
}

async function onSeqWorkerMessage(w: Worker, m: SeqWorkerOut): Promise<void> {
  const run = seqPending.get(m.id);
  if (!run) return;
  run.touch();
  if (m.type === 'log') { run.log(m.level, m.msg); return; }
  if (m.type === 'progress') { run.progress(m.done, m.total); return; }
  if (m.type === 'need-live') {
    // The bounded queue in practice: the worker is blocked until this reply, so
    // exactly one live raster exists at a time and a slow main thread simply
    // slows the render instead of growing worker memory.
    let bitmap: ImageBitmap | null = null;
    try {
      const img = await run.live?.(m.layerIdx, m.frame, m.sourceSec);
      if (img) bitmap = await createImageBitmap(img as ImageBitmapSource);
    } catch { bitmap = null; }
    const reply: SeqWorkerIn = { type: 'live', id: m.id, token: m.token, bitmap };
    try {
      w.postMessage(reply, bitmap ? [bitmap] : []);
    } catch {
      // The worker went away between the request and this reply (a terminate on
      // abort, or onerror). The bitmap was neither transferred nor consumed, so
      // it is still ours to close — the run itself is settled elsewhere.
      try { bitmap?.close(); } catch { /* already closed */ }
    }
    return;
  }
  seqPending.delete(m.id);
  run.clear();
  if (m.type === 'done') { run.resolve(new Blob([m.buffer], { type: m.mime })); return; }
  // An OFFLOAD failure is rejected as a PLAIN Error on purpose: that is the exact
  // signal `renderSequence`'s catch tests for before retrying in-thread. Rejecting
  // it as a coded SequenceError would present an infrastructure failure to the user
  // as the render's verdict and skip a fallback that would have succeeded.
  run.reject(m.offload
    ? new Error(`worker offload failed (${m.code}): ${m.message}`)
    : sequenceError(m.code as SeqErrorCode, m.message));
  // A worker that failed on its own infrastructure (a muxer it could not build, a
  // dynamic import that would not load) is not trustworthy for the retry, and it
  // may still be holding the run's transferred plates. Drop the thread; the next
  // render spawns a fresh one.
  if (m.offload) disposeSequenceWorker();
}

/** The opt-in flag — the same one bridge/video-encode.ts uses. */
export function workerSequenceRenderEnabled(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('lolly.workerEncode') === '1'; }
  catch { return false; }
}

/**
 * Can (and should) the composite+encode run in a Worker?
 *
 * Needs module Workers, an OffscreenCanvas to composite onto, WebCodecs to encode
 * with, `createImageBitmap` to ship the plates over — and the opt-in. Anything
 * missing falls back to the in-thread executor, which is the same code.
 */
export function supportsWorkerSequenceRender(): boolean {
  return typeof Worker !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof VideoEncoder !== 'undefined'
    && typeof createImageBitmap === 'function'
    && workerSequenceRenderEnabled();
}

/**
 * Cancel every in-flight worker render and tear the worker down.
 *
 * Both halves matter: the `abort` message lets the worker unwind its own frame
 * loop (disposing decoders, aborting the muxer) rather than being killed mid
 * decode, and `terminate()` guarantees the thread is gone even if it never
 * answers. Idempotent.
 */
export function abortSequenceWorkerRenders(reason?: string): void {
  const w = seqWorker;
  const had = seqPending.size > 0;
  for (const [id, run] of seqPending) {
    if (w) { try { w.postMessage({ type: 'abort', id } satisfies SeqWorkerIn); } catch { /* already gone */ } }
    run.clear();
    run.reject(sequenceError('SEQ_ABORTED', reason ?? 'sequence export cancelled'));
  }
  seqPending.clear();
  if (!w) { disposeSequenceWorker(); return; }
  // Terminating in this same task would mean the worker never even DEQUEUES the
  // abort we just posted, making every cancel a hard kill mid-decode. Detach the
  // instance now (so the next render spawns a clean one and nothing here can
  // observe its messages) and give its event loop one turn to unwind — dispose
  // providers, abort the muxer — before pulling the thread out from under it.
  seqWorker = null;
  w.onmessage = null;
  w.onerror = null;
  const kill = (): void => { try { w.terminate(); } catch { /* already gone */ } };
  if (had) setTimeout(kill, SEQ_ABORT_GRACE_MS);
  else kill();
}

/** How long a cancelled worker gets to unwind before it is terminated. */
export const SEQ_ABORT_GRACE_MS = 250;

/**
 * Render one job in the Worker. Rejects with a `SequenceError` for a coded
 * failure the render itself produced, and a plain Error for an offload failure
 * the caller should retry in-thread.
 *
 * Exported as a test seam (with `_setSequenceWorkerFactory`) so the whole
 * message protocol — start, progress, log, need-live, done, error, abort — is
 * provable in node against a stub port, not only in a browser.
 */
export async function renderSequenceInWorker(
  job: SeqJob, pick: EncodePick, bitrate: number, audioPick: SeqAudioPick | null,
  mixBuffer: AudioBuffer | null,
  io: { log(l: string, m: string): void; progress(d: number, t: number): void; live?: SeqJobIO['lottieAt'] },
): Promise<Blob> {
  // The plates are canvases (the in-thread fallback still needs them), so the
  // worker gets transferable COPIES. createImageBitmap does not consume its source.
  const bitmapOf = async (c: CanvasImageSource | null): Promise<ImageBitmap | null> =>
    (c ? await createImageBitmap(c as ImageBitmapSource) : null);
  const wireJob: SeqJob = {
    ...job,
    bg: await bitmapOf(job.bg),
    plates: await Promise.all(job.plates.map(async (p) => ({
      idx: p.idx, under: await bitmapOf(p.under), over: await bitmapOf(p.over),
    }))),
    // A blob: URL is resolvable from a worker, but handing over the Blob itself
    // is both cheaper (structured clone is by reference) and keeps the worker
    // free of any dependency on the document's URL store. A remote URL is passed
    // through so mediabunny can range-request it rather than us buffering it all.
    clips: await Promise.all(job.clips.map(async (c) => ({
      idx: c.idx,
      src: typeof c.src === 'string' && c.src.startsWith('blob:')
        ? await (await fetch(c.src)).blob()
        : c.src,
    }))),
  };

  const audio: SeqWorkerAudio | null = audioPick && mixBuffer
    ? {
        ...audioPick,
        length: mixBuffer.length,
        // COPIES, not the AudioBuffer's own views: these are transferred, and
        // detaching the buffer the in-thread fallback would re-use is not a
        // trade worth making for one memcpy of a few MB.
        channels: Array.from({ length: audioPick.numberOfChannels }, (_, ch) =>
          new Float32Array(mixBuffer.getChannelData(Math.min(ch, mixBuffer.numberOfChannels - 1)))),
      }
    : null;

  const w = ensureSeqWorker();
  const id = ++seqRunSeq;
  const transfer: Transferable[] = jobTransferables(wireJob);
  if (audio) for (const ch of audio.channels) transfer.push(ch.buffer);

  return await new Promise<Blob>((resolve, reject) => {
    let silence: ReturnType<typeof setTimeout> | undefined;
    const clear = (): void => { if (silence) { clearTimeout(silence); silence = undefined; } };
    const touch = (): void => {
      clear();
      silence = setTimeout(() => {
        seqPending.delete(id);
        // A plain Error, not a coded one: a silent worker is the offload failing,
        // and the in-thread path is the honest retry.
        reject(new Error(`the render worker went silent for ${SEQ_CLIENT_SILENCE_MS / 1000}s`));
        disposeSequenceWorker();
      }, SEQ_CLIENT_SILENCE_MS);
      // Never hold the process open for this in a node test run.
      (silence as unknown as { unref?: () => void }).unref?.();
    };
    seqPending.set(id, { resolve, reject, log: io.log, progress: io.progress, live: io.live, touch, clear });
    const start: SeqWorkerIn = { type: 'start', id, job: wireJob, pick, bitrate, audio };
    try {
      w.postMessage(start, transfer);
      touch();
    } catch (err) {
      seqPending.delete(id);
      clear();
      closeJobBitmaps(wireJob);
      reject(err);
    }
  });
}

// ── output encoders ─────────────────────────────────────────────────────────

function canvasBlob(canvas: AnyCanvas, type: string, quality?: number): Promise<Blob> {
  if (typeof (canvas as OffscreenCanvas).convertToBlob === 'function') {
    return (canvas as OffscreenCanvas).convertToBlob({ type, quality });
  }
  return new Promise<Blob>((res, rej) =>
    (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('frame encode failed'))), type, quality));
}

/**
 * APNG: the engine splices already-encoded PNGs at the chunk level.
 *
 * DPI + provenance + colour profile are stamped exactly as export.ts's renderApng
 * stamps them, including the 96 dpi default (a sequence is authored in CSS px, so
 * the physical-unit 300 dpi branch of `exportDims` never applies here) and the ICC
 * profile, whose absence would silently drop a colour profile the user selected.
 */
async function apngBlob(frames: Uint8Array[], fps: number, opts: ExportOpts): Promise<Blob> {
  let bytes = packApng(frames, {
    delayMs: Math.round(1000 / fps),
    loops: opts.repeat === -1 ? 1 : (opts.repeat ?? 0),
  });
  const wantDpi = Number(opts.dpi);
  const dpi = Number.isFinite(wantDpi) && wantDpi > 0 ? wantDpi : CSS_DPI;
  bytes = insertPngPhys(bytes, dpi) || bytes;
  bytes = insertPngMeta(bytes, opts.meta as never);
  const icc = iccWanted(opts) ? iccProfileBytes(opts.colorProfile) : null;
  if (icc) bytes = await insertPngIcc(bytes, icc);
  return new Blob([bytes as BlobPart], { type: 'image/png' });
}

/** GIF: gifenc, one local palette per frame (the renderGif no-dither policy). */
async function gifBlob(frames: Uint8ClampedArray[], w: number, h: number, opts: ExportOpts): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = (await import('gifenc')) as any;
  const gif = GIFEncoder();
  const delay = Math.round(1000 / GIF_FPS);
  const repeat = opts.repeat != null ? opts.repeat : 0;
  frames.forEach((pixels, i) => {
    const palette = quantize(pixels, 256);
    const indexed = applyPalette(pixels, palette);
    gif.writeFrame(indexed, w, h, i === 0 ? { palette, delay, repeat } : { palette, delay });
  });
  gif.finish();
  return new Blob([gif.bytesView()], { type: 'image/gif' });
}

/**
 * MediaRecorder fallback: replay the already-composed frames at wall pace.
 *
 * Reached only when WebCodecs cannot encode at all. Correct but real-time, and
 * it re-introduces the buffered-frame memory profile — which is why the composed
 * frames were kept as ImageBitmaps for this path only.
 */
async function recorderReplay(
  bitmaps: ImageBitmap[], canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
  format: 'mp4' | 'webm', fps: number, opts: ExportOpts, host: SeqHost | null,
): Promise<Blob> {
  const mimeType = videoMimeType(format, false);
  if (!mimeType) {
    bitmaps.forEach((b) => b.close());
    throw sequenceError('SEQ_NO_CODEC', 'Video recording is not supported in this browser. Use GIF instead, or try Chrome or Firefox for WebM.');
  }
  const frameMs = 1000 / fps;
  const { stream, deliver } = manualCaptureStream(canvas, fps);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: videoBitrate(canvas.width, canvas.height, fps) });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  const container = mimeType.includes('mp4') ? 'video/mp4' : 'video/webm';
  const blob = await new Promise<Blob>((resolve, reject) => {
    recorder.onerror = (e) => {
      stream.getTracks().forEach((t) => t.stop());
      bitmaps.forEach((b) => b.close());
      reject((e as { error?: Error }).error ?? new Error('MediaRecorder error'));
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      bitmaps.forEach((b) => b.close());
      resolve(new Blob(chunks, { type: container }));
    };
    recorder.start();
    let i = 0;
    // setTimeout, not rAF: rAF stops entirely in a backgrounded tab and would
    // strand the export mid-record (the renderVideo Phase-2 pump's reasoning).
    const pump = (): void => {
      if (i >= bitmaps.length) {
        setTimeout(() => { try { recorder.stop(); } catch { /* already stopping */ } }, Math.max(frameMs, 40));
        return;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmaps[i++]!, 0, 0);
      deliver();
      setTimeout(pump, frameMs);
    };
    pump();
  });
  return await withVideoMeta(blob, container, opts.meta, host);
}
