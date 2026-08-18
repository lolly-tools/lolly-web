// SPDX-License-Identifier: MPL-2.0
/**
 * Streaming on-device VIDEO processing (plans/124 section 10, WP-G). ONE pipeline,
 * three ops hung off it:
 *
 *   1. MATTE (the marquee) - per-frame background removal to a TRANSPARENT
 *      animated WebP / APNG. Every RGB pixel is the source; only the alpha is
 *      model-computed, then temporally smoothed (EMA + scene-cut reset) to kill
 *      per-frame flicker. Alpha survives end-to-end: canvas.toBlob keeps the
 *      alpha channel, and engine/apng.ts / engine/webp-anim.ts splice the frames'
 *      bitstreams VERBATIM (no premultiply/flatten). Transparent formats can't
 *      carry audio, so matte-to-transparent DROPS it (the dialog says so).
 *   2. CROP - rect crop (even-dimension rounded for the encoders) to a normal
 *      video, KEEPING the source audio track.
 *   3. UPSCALE - per-frame Real-ESRGAN to a normal video, keeping audio. Desktop-
 *      first; on wasm the dialog shows an honest time estimate from a 3-frame
 *      probe and lets the user decide.
 *
 * ── ARCHITECTURE: a source → op → sink loop, strictly streaming ───────────────
 * The pure loop `runFramePipeline` pulls one DecodedFrame at a time from a
 * VideoFrameReader, passes it through a FrameOp `(RGBA) → RGBA`, and hands the
 * result to a VideoFrameWriter. Memory is bounded by the reader's window, never
 * the whole clip - the wasm address space is the ceiling (the video-render
 * parallelism rule). It reports progress per frame to a WP-F job and is
 * cancellable BETWEEN frames.
 *
 * The reader/writer are SEAMS: the real ones decode with mediabunny (the
 * clip-proxy approach) and encode with the streaming WebCodecs mux
 * (bridge/video-encode-core.ts) or the alpha packers. The seams let the loop and
 * every op be unit-tested with a synthetic decoder/encoder pair - there are no
 * real codecs in jsdom.
 *
 * ── HONESTY LEDGER (same convention as lib/matter.ts / lib/upscaler.ts) ───────
 * The PURE parts below - the frame loop, the EMA/scene-cut smoother, even-crop
 * rounding, the provenance branch, the estimate extrapolation - are unit-tested
 * headless (video-jobs.test.ts). The mediabunny decode and the WebCodecs/alpha
 * encode adapters have NOT been run in this environment (no codecs under node);
 * they are verified by Andy's in-browser smoke test. Their shape mirrors the
 * already-shipping clip-proxy transcode and sequence-render streaming mux.
 *
 * ── PROVENANCE (plans/124 section 2 table, fixed) ────────────────────────────
 * Container-level C2PA on the OUTPUT (the existing video rule - never per-frame
 * imprints), the source video carried as an ingredient. Matte = plain
 * `c2pa.edited` ("Background removed…"); crop = plain `c2pa.cropped`; upscale =
 * the genAI-partial stamp (compositeWithTrainedAlgorithmicMedia). A catalog-
 * initiated job saves a PLAIN derived asset - the 'renders' tag is WP-B's
 * download-path contract only.
 */

import { packApng, packWebpAnim, extractC2paStore, prepareC2paIngredientFromStore, COMPOSITE_SOURCE_TYPE, chromaKeyAlpha } from '@lolly/engine';
import { packGifAlpha } from './gif-alpha.ts';
import { startJob, type JobHandle } from './jobs.ts';
import { t, tRaw } from '../i18n.ts';
import type {
  AssetRef, HostV1, MatteModelId, UpscaleModelId,
} from '@lolly-tools/core/host-v1';

// ── The op set + per-op params ───────────────────────────────────────────────

export type VideoOp = 'matte' | 'crop' | 'upscale';

/** A rectangle in source pixels. */
export interface CropRect { x: number; y: number; w: number; h: number; }

export interface MatteVideoParams {
  /** Default u2netp for video - fast; birefnet-lite is "best (much slower)".
   *  Read only for the 'model' method; the colour key ignores it. */
  model: MatteModelId;
  /** Transparent output container. WebP/PNG carry the matte's SOFT alpha verbatim;
   *  GIF thins it to 1-bit (hard-edged) - the dialog says so. */
  format: 'webp' | 'png' | 'gif';
  /** Output frame rate. Whole frames are stored, so this is a real size lever. */
  fps: number;
  /** Longest output edge in px - bounds both memory and file size, and (WP-resolution)
   *  the destination resolution the user chose: a smaller edge is faster to work with
   *  and a smaller file. Both methods honour it (the model via maxEdge, the colour key
   *  by scaling the frame before it keys). */
  longEdge: number;
  /** How the alpha is derived. 'model' (default) runs the on-device matte net;
   *  'chroma' is a deterministic COLOUR-RANGE key for footage shot against a flat
   *  wall/screen - no model download, cheaper per frame, and often cleaner on a clean
   *  background. Absent reads as 'model' (back-compat with every existing caller). */
  method?: 'model' | 'chroma';
  /** Colour-key parameters, read only when method === 'chroma'. */
  chroma?: ChromaKeyParams;
}

/** Colour-range keying params: remove a flat background colour by its PERCEPTUAL
 *  (OKLab) distance. Distances are in OKLab ΔEOK units (0 = the key, black↔white ≈ 1,
 *  a just-noticeable difference ≈ 0.02) - the same metric the engine's chromaKeyAlpha
 *  keys on, so the dialog's sliders and the render agree. */
export interface ChromaKeyParams {
  /** The background colour to remove, 0..255 per channel. */
  keyColor: { r: number; g: number; b: number };
  /** OKLab distance at/below which a pixel is fully removed (0..1). */
  tolerance: number;
  /** Ramp width above `tolerance` over which alpha climbs back to fully opaque (0..1) -
   *  the soft edge. */
  softness: number;
  /** 0..1 spill suppression: de-saturate near-key edge pixels toward their luma, so a
   *  green/blue rim does not survive the key. 0 disables. */
  spill?: number;
}

export interface CropVideoParams {
  rect: CropRect;
  fps: number;
  /** Output video bitrate, bits/s. */
  bitrate: number;
}

export interface UpscaleVideoParams {
  model: UpscaleModelId;
  fps: number;
  bitrate: number;
}

// ── Caps (refuse, never OOM) ─────────────────────────────────────────────────

/** Longest INPUT edge a job will accept before refusing. Above this the per-frame
 *  op (a wasm model, a full-frame crop) risks the tab. */
export const VIDEO_JOB_MAX_LONG_EDGE = 3840;
/** Longest input edge for the MATTE op specifically - a per-frame transformer at
 *  1024² over hundreds of frames is far heavier than a crop, so it caps lower. */
export const MATTE_MAX_INPUT_LONG_EDGE = 1920;
/** Longest input edge for UPSCALE - Real-ESRGAN x4 quadruples every dimension, so
 *  a 1024px source already targets 4096px (a common H.264 encoder ceiling). Cap
 *  the input so the 4× output stays inside what the encoder will accept. */
export const UPSCALE_MAX_INPUT_LONG_EDGE = 1024;
/** Duration ceiling (s). A background job must stay a background job. */
export const VIDEO_JOB_MAX_DURATION_SEC = 120;
/** Source-byte ceiling - fetched whole for decode + the C2PA ingredient scan. */
export const VIDEO_JOB_MAX_SOURCE_BYTES = 300 * 1024 * 1024;
/** Whole animated-WebP/APNG frames live in memory until finalize, so the matte
 *  output's frame COUNT is capped (fps × duration). 720p×360 frames ≈ a big file. */
export const MATTE_MAX_OUTPUT_FRAMES = 450;

/** Transparent-output defaults (WP-H honesty: whole frames, so keep them small). */
export const MATTE_DEFAULT_LONG_EDGE = 720;
export const MATTE_DEFAULT_FPS = 12;
/** The fast model is the video default (birefnet-lite is offered as "best, slower"). */
export const MATTE_VIDEO_DEFAULT_MODEL: MatteModelId = 'u2netp';

/** Destination-resolution choices the dialog offers (longest output edge, px). The
 *  dialog clamps the list to the source's own long edge so it never offers to upscale. */
export const MATTE_LONG_EDGE_PRESETS = [360, 480, 720, 1080] as const;

/** Colour-key defaults: a standard chroma green (#00b140), a moderate OKLab tolerance,
 *  a soft edge, and half-strength spill suppression (tolerance/softness in ΔEOK units). */
export const CHROMA_DEFAULT_KEY: { r: number; g: number; b: number } = { r: 0, g: 177, b: 64 };
export const CHROMA_DEFAULT_TOLERANCE = 0.12;
export const CHROMA_DEFAULT_SOFTNESS = 0.1;
export const CHROMA_DEFAULT_SPILL = 0.5;
const DEFAULT_CHROMA: ChromaKeyParams = {
  keyColor: CHROMA_DEFAULT_KEY, tolerance: CHROMA_DEFAULT_TOLERANCE,
  softness: CHROMA_DEFAULT_SOFTNESS, spill: CHROMA_DEFAULT_SPILL,
};

/** EMA weight on the PREVIOUS smoothed alpha: new = a·prev + (1−a)·current. */
export const MATTE_EMA_ALPHA = 0.6;
/** Total-variation distance (0..1) between successive luma histograms above which
 *  the frame is a scene cut and the EMA resets (no blend across the cut). */
export const SCENE_CUT_THRESHOLD = 0.45;

// ── The streamed frame + the seams ───────────────────────────────────────────

/** One decoded frame: straight-alpha RGBA plus its place on the timeline. */
export interface DecodedFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  timestampUs: number;
  durationUs: number;
}

/** A per-frame op stage: RGBA in, RGBA out (may change dimensions - crop/upscale). */
export type FrameOp = (frame: DecodedFrame) => DecodedFrame | Promise<DecodedFrame>;

/** Sequential frame source. The real one decodes with mediabunny; tests inject a
 *  fake. `frameCount` is the expected total for the progress bar. */
export interface VideoFrameReader {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frameCount: number;
  read(): AsyncGenerator<DecodedFrame, void, unknown>;
  close(): Promise<void> | void;
}

/** What a finished write produced. */
export interface WriterResult { blob: Blob; format: string; width: number; height: number; }

/** Frame sink. Crop/upscale → the streaming video mux; matte → the alpha packers. */
export interface VideoFrameWriter {
  write(frame: DecodedFrame): Promise<void> | void;
  finalize(): Promise<WriterResult>;
  abort(reason?: unknown): Promise<void> | void;
}

/** Cooperative controls the loop honours between frames. */
export interface PipelineCtx {
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export interface PipelineResult { cancelled: boolean; result?: WriterResult; }

/**
 * The streaming loop: reader → op → writer, one frame at a time.
 *
 * Cancellation is checked BEFORE each op (cooperative, between frames); a
 * cancelled loop aborts the writer and returns `{ cancelled: true }` without a
 * result. Any thrown error aborts the writer and closes the reader before
 * rethrowing, so neither a decoder nor an encoder is ever left running.
 */
export async function runFramePipeline(
  reader: VideoFrameReader, op: FrameOp, writer: VideoFrameWriter, ctx: PipelineCtx = {},
): Promise<PipelineResult> {
  let done = 0;
  const total = reader.frameCount;
  try {
    for await (const frame of reader.read()) {
      if (ctx.isCancelled?.()) {
        await writer.abort('cancelled');
        await reader.close();
        return { cancelled: true };
      }
      const out = await op(frame);
      await writer.write(out);
      done++;
      ctx.onProgress?.(done, total);
    }
    const result = await writer.finalize();
    await reader.close();
    return { cancelled: false, result };
  } catch (err) {
    try { await writer.abort(err); } catch { /* already down */ }
    try { await reader.close(); } catch { /* already down */ }
    throw err;
  }
}

// ── Pure math: luma histogram + scene-cut EMA smoother ───────────────────────

/** A normalized (sum = 1) luma histogram of an RGBA frame - the scene-cut signal. */
export function lumaHistogram(data: ArrayLike<number>, bins = 64): Float64Array {
  const hist = new Float64Array(bins);
  const n = Math.floor(data.length / 4);
  if (n <= 0) return hist;
  const scale = bins / 256;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const y = 0.299 * (data[o] as number) + 0.587 * (data[o + 1] as number) + 0.114 * (data[o + 2] as number);
    let b = Math.floor(y * scale);
    if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
    hist[b]!++;
  }
  for (let i = 0; i < bins; i++) hist[i]! /= n;
  return hist;
}

/** Total-variation distance between two normalized histograms: 0 (identical) .. 1
 *  (disjoint). Half the summed absolute difference. */
export function histogramDelta(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += Math.abs((a[i] as number) - (b[i] as number));
  return s / 2;
}

/**
 * Temporal alpha smoother for a matte video: an EMA over the alpha channel that
 * RESETS on a scene cut so a hard cut isn't smeared into the next shot.
 *
 * `apply` mutates the frame's alpha IN PLACE. The RGB is never touched (a matte
 * invents no colour); only the model's noisy per-frame alpha is calmed, which is
 * what kills the shimmer around hair/edges between otherwise-identical frames.
 */
export class MatteAlphaSmoother {
  private prevAlpha: Uint8ClampedArray | null = null;
  private prevHist: Float64Array | null = null;
  private prevW = 0;
  private prevH = 0;
  private readonly alpha: number;
  private readonly threshold: number;
  /** True when the last apply() treated the frame as a scene cut (test hook). */
  lastWasCut = true;

  constructor(alpha = MATTE_EMA_ALPHA, threshold = SCENE_CUT_THRESHOLD) {
    this.alpha = alpha;
    this.threshold = threshold;
  }

  apply(frame: { data: Uint8ClampedArray; width: number; height: number }): void {
    const hist = lumaHistogram(frame.data);
    const dimsChanged = frame.width !== this.prevW || frame.height !== this.prevH;
    const cut = !this.prevAlpha || dimsChanged
      || (this.prevHist ? histogramDelta(hist, this.prevHist) > this.threshold : true);
    this.lastWasCut = cut;

    const data = frame.data;
    if (!cut && this.prevAlpha) {
      const a = this.alpha;
      const prev = this.prevAlpha;
      for (let i = 3; i < data.length; i += 4) {
        data[i] = Math.round(a * (prev[i] as number) + (1 - a) * (data[i] as number));
      }
    }
    // Store the POST-smoothing alpha as the next frame's history.
    if (!this.prevAlpha || this.prevAlpha.length !== data.length) this.prevAlpha = new Uint8ClampedArray(data.length);
    const prev = this.prevAlpha;
    for (let i = 3; i < data.length; i += 4) prev[i] = data[i]!;
    this.prevHist = hist;
    this.prevW = frame.width;
    this.prevH = frame.height;
  }

  reset(): void {
    this.prevAlpha = null;
    this.prevHist = null;
    this.prevW = this.prevH = 0;
    this.lastWasCut = true;
  }
}

// ── Pure math: even-dimension crop rounding + the crop op ─────────────────────

/** Round a length DOWN to an even value ≥ 2 (encoders reject odd 4:2:0 dims). */
export function evenFloor(n: number): number {
  const v = Math.floor(n / 2) * 2;
  return v < 2 ? 2 : v;
}

/**
 * Clamp + even-round a crop rect into a source frame. x/y are snapped to even
 * offsets (chroma alignment) and w/h to even lengths that stay inside the frame.
 */
export function roundCropRect(rect: CropRect, srcW: number, srcH: number): CropRect {
  let x = Math.max(0, Math.min(Math.floor(rect.x), Math.max(0, srcW - 2)));
  let y = Math.max(0, Math.min(Math.floor(rect.y), Math.max(0, srcH - 2)));
  x -= x % 2;
  y -= y % 2;
  const w = evenFloor(Math.min(rect.w, srcW - x));
  const h = evenFloor(Math.min(rect.h, srcH - y));
  return { x, y, w, h };
}

/** Copy a rect out of a frame's RGBA into a new, smaller frame. Pure. */
export function cropFrame(frame: DecodedFrame, rect: CropRect): DecodedFrame {
  const { x, y, w, h } = rect;
  const out = new Uint8ClampedArray(w * h * 4);
  const sw = frame.width;
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * sw + x) * 4;
    out.set(frame.data.subarray(srcStart, srcStart + w * 4), row * w * 4);
  }
  return { data: out, width: w, height: h, timestampUs: frame.timestampUs, durationUs: frame.durationUs };
}

// ── Provenance branch (plans/124 section 2 table) ────────────────────────────

export interface VideoC2paAction { action: string; digitalSourceType?: string; description?: string; }
export interface VideoProvenance {
  /** The export assertion's `tool`. */
  tool: string;
  /** The honest c2pa action step(s). */
  actions: VideoC2paAction[];
  /** Set only for the upscale op (the model invents high-frequency detail). */
  aiGenerated?: 'partial';
}

/**
 * The container-level provenance for a finished video job. Matte and crop are
 * plain edits; upscale is the genAI-partial stamp. The source video is added as
 * an ingredient by the caller (not here - this is the action branch only).
 */
export function videoProvenanceFor(
  op: VideoOp,
  p: { model?: string; version?: string; scale?: number; method?: 'model' | 'chroma' } = {},
): VideoProvenance {
  if (op === 'crop') {
    return { tool: 'Crop', actions: [{ action: 'c2pa.cropped', description: 'Cropped' }] };
  }
  if (op === 'matte') {
    // A colour key runs no model and invents nothing - record it as a plain edit with
    // no model name and, deliberately, NO aiGenerated flag (unlike upscale below).
    if (p.method === 'chroma') {
      return {
        tool: 'Remove background',
        actions: [{ action: 'c2pa.edited', description: 'Background removed with a colour key (on-device)' }],
      };
    }
    const who = `${p.model ?? 'a model'} ${p.version ?? ''}`.trim();
    return {
      tool: 'Remove background',
      actions: [{ action: 'c2pa.edited', description: `Background removed with ${who} (on-device)` }],
    };
  }
  // upscale - a super-resolver infers pixels from a trained model.
  const who = `${p.model ?? 'a model'} ${p.version ?? ''}`.trim();
  return {
    tool: 'Upscale',
    actions: [{
      action: 'c2pa.edited',
      digitalSourceType: COMPOSITE_SOURCE_TYPE,
      description: `Upscaled ${p.scale ?? 4}× with ${who} (on-device)`,
    }],
    aiGenerated: 'partial',
  };
}

// ── Refusals + estimate (pure) ───────────────────────────────────────────────

export interface SourceProbe { longEdge: number; durationSec: number; bytes: number; }

/** A refusal message for a source a given op can't safely process, or null. */
export function videoJobRefusal(op: VideoOp, probe: SourceProbe): string | null {
  if (probe.bytes > VIDEO_JOB_MAX_SOURCE_BYTES) {
    return t('This video is too large to process in the browser.');
  }
  if (!(probe.durationSec > 0) || probe.durationSec > VIDEO_JOB_MAX_DURATION_SEC) {
    if (probe.durationSec > VIDEO_JOB_MAX_DURATION_SEC) {
      return t('This video is too long to process in the browser ({sec}s max).', { sec: VIDEO_JOB_MAX_DURATION_SEC });
    }
    return t("Couldn't read this video's length.");
  }
  const cap = op === 'matte' ? MATTE_MAX_INPUT_LONG_EDGE
    : op === 'upscale' ? UPSCALE_MAX_INPUT_LONG_EDGE
    : VIDEO_JOB_MAX_LONG_EDGE;
  if (probe.longEdge > cap) {
    return t('This video is too high-resolution to process on this device ({px}px max on the long edge).', { px: cap });
  }
  return null;
}

/** Expected matte output frame count at `fps` over `durationSec`, clamped to the
 *  in-memory frame cap. */
export function matteOutputFrames(durationSec: number, fps: number): number {
  const n = Math.max(1, Math.round(durationSec * Math.max(1, fps)));
  return Math.min(MATTE_MAX_OUTPUT_FRAMES, n);
}

/** Extrapolate a whole-job estimate from a small probe (WP-G/H honesty). */
export function extrapolateEstimate(
  sample: { perFrameMs: number; sampleFrameBytes: number }, frameCount: number,
): { totalMs: number; totalBytes: number } {
  return {
    totalMs: Math.round(sample.perFrameMs * frameCount),
    totalBytes: Math.round(sample.sampleFrameBytes * frameCount),
  };
}

// ── Output dimensions ────────────────────────────────────────────────────────

/** Even-clamped dims for a source scaled so its long edge is `longEdge`. */
export function scaledEvenDims(srcW: number, srcH: number, longEdge: number): { width: number; height: number } {
  const long = Math.max(srcW, srcH);
  const scale = long > longEdge ? longEdge / long : 1;
  return { width: evenFloor(srcW * scale), height: evenFloor(srcH * scale) };
}

/** The destination long edge a matte actually renders at, for a chosen preset and a
 *  known source: the request, never ABOVE the source's own long edge (no upscaling
 *  here) nor the matte input cap. This is the contract the dialog's Resolution select
 *  feeds into `params.longEdge`; an unknown/zero source falls back to the request. */
export function clampMatteLongEdge(requested: number, srcLongEdge: number): number {
  const source = srcLongEdge > 0 ? srcLongEdge : requested;
  return Math.max(1, Math.min(requested, source, MATTE_MAX_INPUT_LONG_EDGE));
}

// ── The ops (browser side; matte/upscale call host models) ───────────────────

/** Build the matte op: run the model per frame, then smooth the alpha in place. */
export function makeMatteOp(
  host: HostV1, params: MatteVideoParams, smoother: MatteAlphaSmoother, signal?: AbortSignal,
): FrameOp {
  const matte = host.matte;
  if (!matte) throw new Error('host.matte is unavailable');
  return async (frame: DecodedFrame): Promise<DecodedFrame> => {
    // matte.run TRANSFERS (neuters) the frame buffer to the worker - hand it a copy.
    const runFrame = { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
    const out = await matte.run(runFrame, { model: params.model, maxEdge: params.longEdge, ...(signal ? { signal } : {}) });
    smoother.apply(out);
    return { data: out.data, width: out.width, height: out.height, timestampUs: frame.timestampUs, durationUs: frame.durationUs };
  };
}

// ── Pure math: bilinear resize + the colour-range (chroma) key ───────────────

/** Bilinear-resample an RGBA frame to `outW`×`outH`. Returns a fresh buffer (never
 *  aliases the source), so a same-size call is a defensive copy. Pure. */
export function resizeFrameRGBA(
  frame: { data: Uint8ClampedArray; width: number; height: number }, outW: number, outH: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const { data, width: sw, height: sh } = frame;
  if (outW === sw && outH === sh) return { data: new Uint8ClampedArray(data), width: sw, height: sh };
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = sw / outW;
  const sy = sh / outH;
  for (let y = 0; y < outH; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < outW; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const p00 = (y0 * sw + x0) * 4, p01 = (y0 * sw + x1) * 4, p10 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[p00 + c]! * (1 - wx) + data[p01 + c]! * wx;
        const bot = data[p10 + c]! * (1 - wx) + data[p11 + c]! * wx;
        out[o + c] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Build the colour-key op: scale the frame to the chosen long edge (the destination
 *  resolution), then key it with the engine's perceptual (OKLab) chromaKeyAlpha. No host
 *  model is touched - this is why the chroma method works without any staged matte model,
 *  and the keying MATH lives in engine/chroma-key.ts so web and CLI key identically. Full
 *  OKLab distance (lightness included) is what keeps a NEUTRAL key (a white/grey/black
 *  wall) from wiping the frame, with no special-case luma weighting needed. */
export function makeChromaKeyOp(params: ChromaKeyParams, longEdge: number): FrameOp {
  return (frame: DecodedFrame): DecodedFrame => {
    const dims = scaledEvenDims(frame.width, frame.height, longEdge);
    const scaled = resizeFrameRGBA(frame, dims.width, dims.height);
    const keyed = chromaKeyAlpha(scaled.data, scaled.width, scaled.height, {
      keyColor: [params.keyColor.r, params.keyColor.g, params.keyColor.b],
      tolerance: params.tolerance, softness: params.softness, spill: params.spill ?? 0,
    });
    return { data: keyed, width: scaled.width, height: scaled.height, timestampUs: frame.timestampUs, durationUs: frame.durationUs };
  };
}

/** Build the upscale op: run the model per frame (dims grow by the model scale). */
export function makeUpscaleOp(host: HostV1, params: UpscaleVideoParams, signal?: AbortSignal): FrameOp {
  const upscale = host.upscale;
  if (!upscale) throw new Error('host.upscale is unavailable');
  return async (frame: DecodedFrame): Promise<DecodedFrame> => {
    const runFrame = { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
    const out = await upscale.run(runFrame, { model: params.model, ...(signal ? { signal } : {}) });
    // Encoders need even dims; a model scale keeps parity, but guard anyway by
    // trusting the model output (dims are its own multiple of the source).
    return { data: out.data, width: out.width, height: out.height, timestampUs: frame.timestampUs, durationUs: frame.durationUs };
  };
}

/** Build the crop op from a pre-rounded rect. */
export function makeCropOp(rect: CropRect): FrameOp {
  return (frame: DecodedFrame): DecodedFrame => cropFrame(frame, rect);
}

// ── Real adapters (browser-only, lazily built; honesty ledger) ───────────────
//
// These touch mediabunny / WebCodecs / <canvas> and are NOT exercised under node.
// Tests inject fake readers/writers. Their shape mirrors lib/clip-proxy.ts (decode)
// and bridge/video-encode-core.ts (encode), both already shipping.

/** Decode a video Blob into a sequential RGBA frame reader at `fps` (mediabunny). */
export async function mediabunnyFrameReader(blob: Blob, fps: number): Promise<VideoFrameReader> {
  const m = await import('mediabunny');
  const input = new m.Input({ formats: [m.MP4, m.QTFF, m.WEBM, m.MATROSKA], source: new m.BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) { input.dispose?.(); throw new Error(t("Couldn't read this video.")); }
  if (!(await track.canDecode())) { input.dispose?.(); throw new Error(t("This browser can't decode this video.")); }
  const width = track.displayWidth;
  const height = track.displayHeight;
  const duration = await input.computeDuration();
  const f = Math.max(1, fps);
  const frameCount = Math.max(1, Math.round(duration * f));
  const sink = new m.VideoSampleSink(track);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;

  async function* read(): AsyncGenerator<DecodedFrame, void, unknown> {
    // A deterministic timestamp grid at 1/fps - one output frame per grid point,
    // decoded from the nearest source sample (samplesAtTimestamps handles the seek).
    function* grid(): Generator<number> {
      for (let i = 0; i < frameCount; i++) yield Math.min(duration - 1e-4, i / f);
    }
    let i = 0;
    for await (const sample of sink.samplesAtTimestamps(grid())) {
      if (sample) {
        ctx.clearRect(0, 0, width, height);
        sample.draw(ctx, 0, 0, width, height);
        sample.close();
      }
      const data = ctx.getImageData(0, 0, width, height).data;
      yield {
        data, width, height,
        timestampUs: Math.round((i / f) * 1e6),
        durationUs: Math.round(1e6 / f),
      };
      i++;
    }
  }

  return { width, height, fps: f, frameCount, read, close: () => { try { input.dispose?.(); } catch { /* gone */ } } };
}

/** A matte transparent-video writer for the three alpha formats:
 *   - WebP/PNG: encode each RGBA frame to a still (alpha kept by canvas.toBlob),
 *     then splice the bitstreams alpha-safe with packWebpAnim / packApng - the
 *     matte's SOFT alpha survives verbatim.
 *   - GIF: keep the RAW RGBA and pack with packGifAlpha at finalize, which thins
 *     the alpha to 1 bit against a reserved transparent index (HARD-edged). */
export function alphaAnimWriter(format: 'webp' | 'png' | 'gif', fps: number): VideoFrameWriter {
  // WebP/PNG store per-frame ENCODED still bytes; GIF stores per-frame RAW RGBA.
  const frames: Uint8Array[] = [];
  let w = 0;
  let h = 0;
  const mime = format === 'webp' ? 'image/webp' : format === 'png' ? 'image/png' : 'image/gif';
  // GIF packs from raw RGBA, so it needs no canvas round-trip.
  const canvas = format === 'gif' ? null : document.createElement('canvas');

  const encodeFrame = async (frame: DecodedFrame): Promise<Uint8Array> => {
    const cv = canvas as HTMLCanvasElement;
    cv.width = frame.width;
    cv.height = frame.height;
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
    const img = ctx.createImageData(frame.width, frame.height);
    img.data.set(frame.data);
    ctx.putImageData(img, 0, 0);
    // quality 1 keeps a near-lossless WebP that still carries its ALPH chunk; PNG
    // is always lossless RGBA. Either way the alpha channel survives untouched.
    const blob = await new Promise<Blob | null>((res) =>
      format === 'webp' ? cv.toBlob((b) => res(b), mime, 1) : cv.toBlob((b) => res(b), mime));
    if (!blob) throw new Error('frame encode failed');
    return new Uint8Array(await blob.arrayBuffer());
  };

  return {
    async write(frame: DecodedFrame): Promise<void> {
      if (!w) { w = frame.width; h = frame.height; }
      // GIF: keep a straight-alpha RGBA copy (frame.data may be reused downstream).
      frames.push(format === 'gif' ? new Uint8Array(frame.data) : await encodeFrame(frame));
    },
    async finalize(): Promise<WriterResult> {
      if (frames.length === 0) throw new Error('no frames');
      const delayMs = Math.max(1, Math.round(1000 / Math.max(1, fps)));
      const bytes = format === 'webp'
        ? packWebpAnim(frames, { delayMs, loops: 0, width: w, height: h })
        : format === 'png'
          ? packApng(frames, { delayMs, loops: 0 })
          : packGifAlpha(frames, { delayMs, loops: 0, width: w, height: h });
      // Copy into a fresh ArrayBuffer-backed view for the Blob.
      const blob = new Blob([bytes.slice()], { type: mime });
      return { blob, format, width: w, height: h };
    },
    abort(): void { frames.length = 0; },
  };
}

interface CodecPick { container: 'mp4' | 'webm'; codec: string; muxCodec: string; }

/** Pick an encodable WebCodecs video codec (mirrors export.ts's candidate list). */
async function pickVideoCodec(width: number, height: number, fps: number, bitrate: number): Promise<CodecPick | null> {
  const VE = (globalThis as { VideoEncoder?: { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> } }).VideoEncoder;
  if (!VE?.isConfigSupported) return null;
  const cands: CodecPick[] = [
    { container: 'mp4', codec: 'avc1.640033', muxCodec: 'avc' },
    { container: 'mp4', codec: 'avc1.4d0033', muxCodec: 'avc' },
    { container: 'webm', codec: 'vp09.00.10.08', muxCodec: 'V_VP9' },
    { container: 'webm', codec: 'vp8', muxCodec: 'V_VP8' },
  ];
  for (const pick of cands) {
    try {
      const s = await VE.isConfigSupported({ codec: pick.codec, width, height, bitrate, framerate: fps });
      if (s?.supported) return pick;
    } catch { /* next */ }
  }
  return null;
}

async function pickAudioCodec(container: 'mp4' | 'webm', sampleRate: number, numberOfChannels: number, bitrate: number): Promise<{ codec: string; muxCodec: string } | null> {
  const AE = (globalThis as { AudioEncoder?: { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> } }).AudioEncoder;
  if (!AE?.isConfigSupported) return null;
  const cand = container === 'mp4' ? { codec: 'mp4a.40.2', muxCodec: 'aac' } : { codec: 'opus', muxCodec: 'A_OPUS' };
  try {
    const s = await AE.isConfigSupported({ codec: cand.codec, sampleRate, numberOfChannels, bitrate });
    if (s?.supported) return cand;
  } catch { /* unsupported */ }
  return null;
}

/** A normal-video writer over the streaming WebCodecs mux (crop/upscale). Keeps
 *  `audio` (a decoded AudioBuffer) when the encoder can carry it. */
export async function videoEncodeWriter(
  plan: { width: number; height: number; fps: number; bitrate: number; audio?: AudioBufferLike | null },
): Promise<VideoFrameWriter> {
  const { createStreamingMux } = await import('../bridge/video-encode-core.ts');
  const pick = await pickVideoCodec(plan.width, plan.height, plan.fps, plan.bitrate);
  if (!pick) throw new Error(t("This browser can't encode video."));

  let audioDecl: import('../bridge/video-encode-core.ts').EncodeAudio | null = null;
  if (plan.audio && plan.audio.length > 0) {
    const chans = Math.min(2, Math.max(1, plan.audio.numberOfChannels));
    const ac = await pickAudioCodec(pick.container, plan.audio.sampleRate, chans, 128_000);
    if (ac) {
      audioDecl = { channels: [], sampleRate: plan.audio.sampleRate, numberOfChannels: chans, codec: ac.codec, muxCodec: ac.muxCodec, bitrate: 128_000 };
    }
  }

  const mux = await createStreamingMux(pick, {
    width: plan.width, height: plan.height, fps: plan.fps, bitrate: plan.bitrate, audio: audioDecl,
  });

  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  return {
    async write(frame: DecodedFrame): Promise<void> {
      // Frame may already be the plan size (crop/upscale target); putImageData
      // writes it 1:1, and the encoder frame size is fixed at the plan dims.
      if (frame.width === plan.width && frame.height === plan.height) {
        const img = ctx.createImageData(frame.width, frame.height);
        img.data.set(frame.data);
        ctx.putImageData(img, 0, 0);
      } else {
        // Defensive fit (should not happen: ops target the plan dims).
        const tmp = document.createElement('canvas');
        tmp.width = frame.width; tmp.height = frame.height;
        const timg = (tmp.getContext('2d') as CanvasRenderingContext2D).createImageData(frame.width, frame.height);
        timg.data.set(frame.data);
        (tmp.getContext('2d') as CanvasRenderingContext2D).putImageData(timg, 0, 0);
        ctx.clearRect(0, 0, plan.width, plan.height);
        ctx.drawImage(tmp, 0, 0, plan.width, plan.height);
      }
      await mux.addFrame(canvas, frame.timestampUs);
    },
    async finalize(): Promise<WriterResult> {
      if (audioDecl && plan.audio) {
        try { await mux.addAudio(plan.audio); } catch { /* drop audio rather than fail the whole job */ }
      }
      const blob = await mux.finalize();
      return { blob, format: pick.container, width: plan.width, height: plan.height };
    },
    async abort(reason?: unknown): Promise<void> { await mux.abort(reason); },
  };
}

/** The subset of AudioBuffer videoEncodeWriter needs (structurally satisfied by a
 *  real AudioBuffer; the streaming mux reads the same shape). */
export interface AudioBufferLike {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/** Decode a source video's audio track to one AudioBuffer (kept for crop/upscale).
 *  Returns null when there is no audio or the browser can't decode it. */
export async function decodeSourceAudio(bytes: ArrayBuffer): Promise<AudioBufferLike | null> {
  const AC = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    return (buf.length > 0 && buf.numberOfChannels > 0) ? (buf as unknown as AudioBufferLike) : null;
  } catch {
    return null;
  } finally {
    ctx.close().catch(() => { /* already closed */ });
  }
}

// ── Ids + the host surface ───────────────────────────────────────────────────

/** The user-asset record this module writes (mirrors upscale/extract-audio). */
export interface VideoJobAssetRecordInput {
  id: string;
  type: AssetRef['type'];
  format: string;
  blob?: Blob;
  version?: string;
  width?: number;
  height?: number;
  aiGenerated?: 'full' | 'partial';
  meta?: Record<string, unknown>;
}

export interface VideoJobHost extends HostV1 {
  assets: HostV1['assets'] & {
    _uploadUserAsset(record: VideoJobAssetRecordInput): Promise<void>;
  };
}

/** A file-safe id + a display name for a finished job. */
export function videoJobIds(op: VideoOp, sourceName: string, format: string, now: number): { id: string; name: string } {
  const base = sourceName.replace(/\.[a-z0-9]+$/i, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || op;
  const kind = op === 'matte' ? 'cutout' : op;
  const label = op === 'matte' ? tRaw('Cutout of {name}', { name: base || t('video') })
    : op === 'crop' ? tRaw('Cropped {name}', { name: base || t('video') })
    : tRaw('Upscaled {name}', { name: base || t('video') });
  return { id: `user/video/${now}-${slug}-${kind}.${format}`, name: label };
}

// ── The request + the driver ─────────────────────────────────────────────────

export type VideoJobSource = AssetRef | Blob | string;

export interface VideoJobRequest {
  op: VideoOp;
  source: VideoJobSource;
  sourceName: string;
  matte?: MatteVideoParams;
  crop?: Omit<CropVideoParams, 'rect'> & { rect: CropRect };
  upscale?: UpscaleVideoParams;
  /** Carried from the source when it discloses AI content (kept on the derivative). */
  aiGeneratedSource?: 'full' | 'partial';
}

/** Injection seam so the whole driver is unit-testable with a fake decode/encode. */
/** The container-level C2PA stamp options runVideoJob assembles (subset of
 *  stampDerivedC2pa's `o`). */
export interface VideoStampOpts {
  title?: string;
  tool: string;
  actions: VideoC2paAction[];
  ingredients?: unknown[];
  dimensions?: string;
}

export interface VideoJobDeps {
  openReader?: (blob: Blob, fps: number) => Promise<VideoFrameReader>;
  openMatteWriter?: (format: 'webp' | 'png' | 'gif', fps: number) => VideoFrameWriter;
  openVideoWriter?: (plan: { width: number; height: number; fps: number; bitrate: number; audio?: AudioBufferLike | null }) => Promise<VideoFrameWriter>;
  decodeAudio?: (bytes: ArrayBuffer) => Promise<AudioBufferLike | null>;
  fetchBytes?: (source: VideoJobSource) => Promise<{ blob: Blob; bytes: Uint8Array }>;
  /** Extract the source video's own credential as a C2PA ingredient, or null. */
  extractIngredient?: (bytes: Uint8Array) => unknown | null;
  /** Sign the output bytes with the assembled container-level credential. */
  stamp?: (host: VideoJobHost, blob: Blob, format: string, o: VideoStampOpts) => Promise<Blob>;
}

/** Default ingredient extraction: the source video's preserved C2PA store. */
function defaultExtractIngredient(bytes: Uint8Array): unknown | null {
  const ex = extractC2paStore(bytes);
  return ex ? prepareC2paIngredientFromStore(ex.store, ex.format) : null;
}

/** Default container-level stamp: the shared stampDerivedC2pa (lazily imported so
 *  the pure module stays node-importable). Best-effort - a failed sign ships the
 *  unstamped blob. */
async function defaultStamp(host: VideoJobHost, blob: Blob, format: string, o: VideoStampOpts): Promise<Blob> {
  const { stampDerivedC2pa } = await import('../bridge/export.ts');
  return stampDerivedC2pa(host, blob, format, {
    ...(o.title ? { title: o.title } : {}),
    tool: o.tool,
    actions: o.actions as never,
    ...(o.ingredients ? { ingredients: o.ingredients as never } : {}),
    ...(o.dimensions ? { dimensions: o.dimensions } : {}),
  });
}

/** A fresh, standalone ArrayBuffer holding a view's bytes (drops any SharedArrayBuffer
 *  / offset ambiguity - decodeAudioData wants a plain, detachable ArrayBuffer). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

async function defaultFetchBytes(source: VideoJobSource): Promise<{ blob: Blob; bytes: Uint8Array }> {
  let blob: Blob;
  if (source instanceof Blob) blob = source;
  else {
    const url = typeof source === 'string' ? source : source.url;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    blob = await res.blob();
  }
  return { blob, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

/**
 * Run one video job end-to-end: fetch → decode → op → encode → stamp → save.
 * Reports progress + honours cancellation through `ctx`. Resolves the saved
 * AssetRef, or null when cancelled before any output.
 *
 * The pure `runFramePipeline` does the frame work; this wires the op, the
 * reader/writer, the source-audio pass-through (crop/upscale), the provenance
 * stamp and the user-asset save around it.
 */
export async function runVideoJob(
  host: VideoJobHost, req: VideoJobRequest, ctx: PipelineCtx & { signal?: AbortSignal } = {}, deps: VideoJobDeps = {},
): Promise<AssetRef | null> {
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
  const { blob: sourceBlob, bytes: sourceBytes } = await fetchBytes(req.source);
  if (sourceBytes.byteLength > VIDEO_JOB_MAX_SOURCE_BYTES) {
    throw new Error(t('This video is too large to process in the browser.'));
  }

  const openReader = deps.openReader ?? mediabunnyFrameReader;

  // Choose the working fps per op.
  const fps = req.op === 'matte' ? (req.matte?.fps ?? MATTE_DEFAULT_FPS)
    : req.op === 'crop' ? (req.crop?.fps ?? 30)
    : (req.upscale?.fps ?? 30);

  const reader = await openReader(sourceBlob, fps);

  // Build the op + the writer per op.
  let op: FrameOp;
  let writer: VideoFrameWriter;
  let outFormat: string;
  let assetType: AssetRef['type'];
  let prov: VideoProvenance;
  let animated = false;

  if (req.op === 'matte') {
    const params = req.matte ?? { model: MATTE_VIDEO_DEFAULT_MODEL, format: 'webp', fps: MATTE_DEFAULT_FPS, longEdge: MATTE_DEFAULT_LONG_EDGE };
    if (params.method === 'chroma') {
      // Deterministic colour key - no host.matte, no model download.
      op = makeChromaKeyOp(params.chroma ?? DEFAULT_CHROMA, params.longEdge);
      prov = videoProvenanceFor('matte', { method: 'chroma' });
    } else {
      const info = host.matte?.models().find((m) => m.id === params.model);
      op = makeMatteOp(host, params, new MatteAlphaSmoother(), ctx.signal);
      prov = videoProvenanceFor('matte', { model: info?.name ?? params.model, version: info?.version });
    }
    writer = (deps.openMatteWriter ?? alphaAnimWriter)(params.format, params.fps);
    outFormat = params.format;
    assetType = 'raster';
    animated = true;
  } else if (req.op === 'crop') {
    const params = req.crop ?? { rect: { x: 0, y: 0, w: reader.width, h: reader.height }, fps: 30, bitrate: 8_000_000 };
    const rect = roundCropRect(params.rect, reader.width, reader.height);
    op = makeCropOp(rect);
    const audio = await (deps.decodeAudio ?? decodeSourceAudio)(toArrayBuffer(sourceBytes));
    writer = await (deps.openVideoWriter ?? videoEncodeWriter)({ width: rect.w, height: rect.h, fps, bitrate: params.bitrate, audio });
    outFormat = ''; // filled from the writer result
    assetType = 'video';
    prov = videoProvenanceFor('crop');
  } else {
    const params = req.upscale ?? { model: 'realesr-general-x4v3' as UpscaleModelId, fps: 30, bitrate: 12_000_000 };
    const info = host.upscale?.models().find((m) => m.id === params.model);
    const scale = info?.scale ?? 4;
    op = makeUpscaleOp(host, params, ctx.signal);
    const audio = await (deps.decodeAudio ?? decodeSourceAudio)(toArrayBuffer(sourceBytes));
    const outW = evenFloor(reader.width * scale);
    const outH = evenFloor(reader.height * scale);
    writer = await (deps.openVideoWriter ?? videoEncodeWriter)({ width: outW, height: outH, fps, bitrate: params.bitrate, audio });
    outFormat = '';
    assetType = 'video';
    prov = videoProvenanceFor('upscale', { model: info?.name ?? params.model, version: info?.version, scale });
  }

  const piped = await runFramePipeline(reader, op, writer, ctx);
  if (piped.cancelled || !piped.result) return null;
  const result = piped.result;
  outFormat = outFormat || result.format;

  // Container-level C2PA: stamp the OUTPUT bytes with the op's plain/genAI edit and
  // carry the source video as an ingredient. Best-effort - a failed sign still ships.
  let blob = result.blob;
  try {
    const ingredient = (deps.extractIngredient ?? defaultExtractIngredient)(sourceBytes);
    blob = await (deps.stamp ?? defaultStamp)(host, result.blob, outFormat, {
      title: req.sourceName,
      tool: prov.tool,
      actions: prov.actions,
      ...(ingredient ? { ingredients: [ingredient] } : {}),
      dimensions: `${result.width}×${result.height}`,
    });
  } catch (e) {
    host.log?.('warn', 'Video job: provenance stamp failed', { error: String(e) });
  }

  const now = Date.now();
  const { id, name } = videoJobIds(req.op, req.sourceName, outFormat, now);
  const aiGenerated = prov.aiGenerated ?? req.aiGeneratedSource;
  await host.assets._uploadUserAsset({
    id,
    type: assetType,
    format: outFormat,
    blob,
    width: result.width,
    height: result.height,
    version: '1.0.0',
    ...(aiGenerated ? { aiGenerated } : {}),
    meta: {
      name,
      bytes: blob.size,
      ...(animated ? { animated: true } : {}),
      // A catalog-initiated job is a PLAIN derived asset - NOT tagged 'renders'
      // (that is WP-B's download-path contract only).
    },
  });
  return await host.assets.get(id);
}

/**
 * A cheap up-front probe for the dialog's HONEST estimate (WP-G/H): decode a few
 * frames, run the op on them, and measure the per-frame time + one processed
 * frame's encoded size. `extrapolateEstimate` scales those to the whole clip. All
 * of this is browser-only (real decode/model); it degrades to null on any error,
 * so the dialog never blocks on it. `frameCount` comes back so the caller can
 * extrapolate without re-opening the reader.
 */
export async function probeVideoJob(
  host: VideoJobHost, req: VideoJobRequest, deps: VideoJobDeps = {}, sampleFrames = 3,
): Promise<{ perFrameMs: number; sampleFrameBytes: number; frameCount: number; width: number; height: number } | null> {
  try {
    const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
    const { blob } = await fetchBytes(req.source);
    const fps = req.op === 'matte' ? (req.matte?.fps ?? MATTE_DEFAULT_FPS) : (req.op === 'crop' ? (req.crop?.fps ?? 30) : (req.upscale?.fps ?? 30));
    const reader = await (deps.openReader ?? mediabunnyFrameReader)(blob, fps);
    let op: FrameOp;
    if (req.op === 'matte') {
      const params = req.matte ?? { model: MATTE_VIDEO_DEFAULT_MODEL, format: 'webp' as const, fps, longEdge: MATTE_DEFAULT_LONG_EDGE };
      op = params.method === 'chroma'
        ? makeChromaKeyOp(params.chroma ?? DEFAULT_CHROMA, params.longEdge)
        : makeMatteOp(host, params, new MatteAlphaSmoother());
    } else if (req.op === 'upscale') {
      const params = req.upscale ?? { model: 'realesr-general-x4v3' as UpscaleModelId, fps, bitrate: 12_000_000 };
      op = makeUpscaleOp(host, params);
    } else {
      op = makeCropOp(roundCropRect(req.crop?.rect ?? { x: 0, y: 0, w: reader.width, h: reader.height }, reader.width, reader.height));
    }
    let count = 0;
    let totalMs = 0;
    let sampleBytes = 0;
    for await (const frame of reader.read()) {
      const t0 = (globalThis.performance ?? Date).now();
      const out = await op(frame);
      totalMs += (globalThis.performance ?? Date).now() - t0;
      if (count === 0) sampleBytes = out.data.length; // raw RGBA; a rough size floor
      count++;
      if (count >= sampleFrames) break;
    }
    await reader.close();
    if (count === 0) return null;
    return { perFrameMs: totalMs / count, sampleFrameBytes: sampleBytes, frameCount: reader.frameCount, width: reader.width, height: reader.height };
  } catch {
    return null;
  }
}

/**
 * Drive a video job through a WP-F job (serial heavy queue + global toast +
 * desktop notification). Returns the JobHandle immediately; the work runs in the
 * background and survives navigating away from the catalog. `onComplete` fires
 * with the saved AssetRef so a still-open view can refresh.
 */
export function runVideoJobAsJob(
  host: VideoJobHost, req: VideoJobRequest,
  hooks: { onComplete?: (ref: AssetRef) => void; onError?: (err: unknown) => void } = {},
  deps: VideoJobDeps = {},
): JobHandle {
  const title = req.op === 'matte' ? t('Removing background')
    : req.op === 'crop' ? t('Cropping video')
    : t('Upscaling video');
  const controller = new AbortController();
  const job = startJob({ title, cancel: () => controller.abort() });
  void (async (): Promise<void> => {
    await job.started;
    if (job.cancelled) return;
    try {
      const ref = await runVideoJob(host, req, {
        signal: controller.signal,
        isCancelled: () => job.cancelled,
        onProgress: (done, total) => job.progress(done, total),
      }, deps);
      if (job.cancelled) return;
      if (ref) { job.finish(ref); hooks.onComplete?.(ref); }
      else job.finish();
    } catch (err) {
      job.fail(err);
      hooks.onError?.(err);
    }
  })();
  return job;
}
