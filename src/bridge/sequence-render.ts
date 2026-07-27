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
 *   THIS FILE             issues canvas calls for a plan, drives the frame loop,
 *                         mixes the audio graph, and feeds the streaming muxer.
 *
 * There is deliberately NO activity, alpha, crossfade or source-time arithmetic in
 * here. If a question is "should this be visible / how faded / which frame of the
 * source", it belongs in the planner and is already answered by the PlanItem. What
 * is left here is genuinely browser-only: `ctx.save()`, `setTransform`, `Path2D`,
 * `drawImage`, `VideoEncoder`.
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
  sequenceDrawPlan,
  frameTimestamps,
  activeFrameWindow,
  crossfadeJunctions,
  reconcileDecoded,
  sequenceError,
  toCodedError,
  type SeqLayer,
  type PlanItem,
} from './sequence-plan.ts';
import {
  createVideoProvider,
  createClipAudio,
  type InstrumentedProvider,
  type ProviderStats,
  type ClipAudio,
} from './sequence-providers.ts';
import {
  createStreamingMux,
  type EncodePick,
  type StreamingMux,
} from './video-encode-core.ts';
import { videoBitrate, videoMimeCandidates } from './video-mime.ts';
import { insertPngPhys, insertPngMeta, insertPngIcc, iccWanted } from './export-image-meta.ts';
import {
  packApng,
  parseClipShape,
  videoProvenanceTags,
  embedMp4Meta,
  embedWebmMeta,
  iccProfileBytes,
} from '@lolly/engine';
// bridge → views, part two. The compositor photographs the LIVE artboard, and the
// phase-2 clock has been writing `.seq-off` (display:none) onto every box that is
// not under the playhead. Without clearing it, every clip except the one being
// scrubbed rasterises blank. The class name is imported rather than restated so the
// two can never drift apart.
import { OFF_CLASS } from '../views/sequence-clock.ts';
// bridge → views. Phase 3 already has this edge (sequence-providers.ts reuses the
// clock's seek semantics); reusing the LIVE Lottie player instance is the only way
// a Lottie box can be exported at all — re-mounting a second player would double
// the memory and, worse, could resolve to a different build of the animation than
// the one the preview showed. Reported alongside the other layering note.
import { lottiePlayerFor } from '../views/lottie-mount.ts';
import type { ExportOpts } from './export.ts';

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

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

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
  duck?: { level: number; startSec: number; endSec: number };
}

/**
 * Connect a looping music bed through a gain envelope, scheduled at t=0.
 *
 * Byte-for-byte the same automation as export.ts's connectMusic (fade in, duck
 * window with 0.25 s ramps, fade out), started immediately because an
 * OfflineAudioContext's currentTime is 0 and never advances until rendering.
 */
function connectBed(ctx: BaseAudioContext, buffer: AudioBuffer, dest: AudioNode, fade: BedFade): void {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const gain = ctx.createGain();
  src.connect(gain).connect(dest);
  const t0 = ctx.currentTime;
  const g = gain.gain;
  const vol = clamp01(fade.volume ?? 1);
  const fadeIn = Math.max(0, fade.fadeIn ?? 0);
  const fadeOut = Math.max(0, fade.fadeOut ?? 0);
  const clip = fade.clipSec ?? 0;
  if (fadeIn > 0) { g.setValueAtTime(0, t0); g.linearRampToValueAtTime(vol, t0 + fadeIn); }
  else g.setValueAtTime(vol, t0);
  const d = fade.duck;
  if (d && d.level < 1 && d.endSec - d.startSec > 0.6) {
    const RAMP = 0.25;
    const downStart = t0 + Math.max(fadeIn, d.startSec);
    const downEnd = downStart + RAMP;
    const upStart = t0 + d.endSec - RAMP;
    const upEnd = t0 + d.endSec;
    if (upStart > downEnd) {
      g.setValueAtTime(vol, downStart);
      g.linearRampToValueAtTime(vol * d.level, downEnd);
      g.setValueAtTime(vol * d.level, upStart);
      g.linearRampToValueAtTime(vol, upEnd);
    }
  }
  if (fadeOut > 0 && clip > fadeIn) {
    const fs = Math.max(t0 + fadeIn, t0 + clip - fadeOut);
    g.setValueAtTime(vol, fs);
    g.linearRampToValueAtTime(0, t0 + clip);
  }
  src.start(0);
}

// ── geometry: clip shapes and object-fit (pure, so they can be reasoned about) ──

/**
 * `border-radius` shorthand → four corner radii in UNSCALED box px.
 *
 * The 1–4 value form with px / % only; the elliptical `a / b` form collapses to
 * its horizontal radii. That is the whole vocabulary the box editor authors
 * (`0`, `12px`, `9999px`), and an unparsed value degrades to a square corner —
 * a visible-but-harmless difference, never a thrown export.
 */
export function radiiOf(borderRadius: string, w: number, h: number): [number, number, number, number] {
  const s = (borderRadius || '').split('/')[0]?.trim() ?? '';
  if (!s || s === '0') return [0, 0, 0, 0];
  const toks = s.split(/\s+/).slice(0, 4);
  const min = Math.min(w, h);
  const one = (tok: string | undefined, ref: number): number => {
    if (!tok) return 0;
    const v = parseFloat(tok);
    if (!Number.isFinite(v)) return 0;
    return tok.endsWith('%') ? (v / 100) * ref : v;
  };
  const a = one(toks[0], min);
  const b = one(toks[1] ?? toks[0], min);
  const c = one(toks[2] ?? toks[0], min);
  const d = one(toks[3] ?? toks[1] ?? toks[0], min);
  // CSS shrinks every radius by one factor when a pair overflows its edge.
  const f = Math.min(1, w / Math.max(1e-6, a + b), w / Math.max(1e-6, d + c), h / Math.max(1e-6, a + d), h / Math.max(1e-6, b + c));
  const k = Math.min(1, f);
  return [a * k, b * k, c * k, d * k];
}

/** Where the media lands inside its box, honouring object-fit / object-position. */
export function fitRect(
  fit: string, pos: string, natW: number, natH: number, boxW: number, boxH: number,
): { x: number; y: number; w: number; h: number } {
  const nw = natW > 0 ? natW : boxW;
  const nh = natH > 0 ? natH : boxH;
  let w = boxW;
  let h = boxH;
  if (fit === 'contain' || fit === 'scale-down') {
    const s = Math.min(boxW / nw, boxH / nh, fit === 'scale-down' ? 1 : Infinity);
    w = nw * s; h = nh * s;
  } else if (fit === 'cover') {
    const s = Math.max(boxW / nw, boxH / nh);
    w = nw * s; h = nh * s;
  } else if (fit === 'none') {
    w = nw; h = nh;
  } // 'fill' (the CSS default) stretches to the box — w/h already are the box.
  const frac = (token: string, fallback: number): number => {
    const t = token.trim().toLowerCase();
    if (t === 'left' || t === 'top') return 0;
    if (t === 'right' || t === 'bottom') return 1;
    if (t === 'center' || t === '') return fallback;
    const v = parseFloat(t);
    return Number.isFinite(v) && t.endsWith('%') ? v / 100 : fallback;
  };
  const parts = (pos || '').trim() ? pos.trim().split(/\s+/) : [];
  const fx = frac(parts[0] ?? '', 0.5);
  const fy = frac(parts[1] ?? parts[0] ?? '', 0.5);
  return { x: (boxW - w) * fx, y: (boxH - h) * fy, w, h };
}

/** CSS mix-blend-mode values that are also canvas composite operations. */
const BLEND_OPS = new Set([
  'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]);

// ── per-layer resources ─────────────────────────────────────────────────────

interface LayerRes {
  /** Statics: the whole box. Media: the box with its media element hidden. */
  under: AnyCanvas | null;
  /** Media only: the box's text/overlay chrome over a transparent background. */
  over: AnyCanvas | null;
  provider: InstrumentedProvider | null;
  /** Element the provider decodes, so its src / object-fit can be read. */
  media: HTMLElement | null;
  /** Lottie marker, when kind === 'lottie'. */
  lottie: Element | null;
  /** Single-entry memo: a 30 fps output over a 12 fps Lottie re-uses the raster. */
  lottieKey: number;
  lottieCanvas: AnyCanvas | null;
  /** Output-grid frame indices this layer is on screen for, inclusive. */
  first: number;
  last: number;
  /** The source times the provider will be asked for, ascending (seconds). */
  span: number[];
  /** Counters copied off the provider just before it was disposed — the
   *  truncation reconciliation runs after every provider is already gone. */
  lastStats: ProviderStats | null;
  /** The length this clip's source CLAIMS, copied off the provider for the same
   *  reason: a clip trimmed past the end of an INTACT file is not truncated, while
   *  the same requests against a file whose header outruns its packets are. */
  srcClaimedSec: number;
}

// ── the executor ────────────────────────────────────────────────────────────

/**
 * Draw ONE plan item. No decisions live here beyond "how do I express this on a
 * canvas" — activity, alpha, rotation and source time all arrive decided.
 *
 * The transform order reproduces sequence-clock's composed CSS transform exactly:
 * `translate(anim) → rotate(authored + anim) → scale(anim)` about the box centre,
 * which is the same matrix the preview builds and the same one renderRecord's
 * drawObject issues.
 */
async function drawItem(ctx: AnyCtx, item: PlanItem, res: LayerRes | undefined, S: number): Promise<void> {
  const L = item.layer;
  if (L.kind === 'audio') return;                 // a timeline citizen with no picture
  if (item.alpha <= 0) return;
  const w = L.rect.w * S;
  const h = L.rect.h * S;
  if (w <= 0 || h <= 0) return;

  ctx.save();
  try {
    ctx.globalAlpha = clamp01(item.alpha);
    if (L.blend && BLEND_OPS.has(L.blend)) ctx.globalCompositeOperation = L.blend as GlobalCompositeOperation;
    ctx.translate((L.rect.x + L.rect.w / 2) * S + item.dx * S, (L.rect.y + L.rect.h / 2) * S + item.dy * S);
    if (item.rot) ctx.rotate((item.rot * Math.PI) / 180);
    if (item.scale !== 1) ctx.scale(item.scale, item.scale);

    // Clips are authored against the UNSCALED box, so they are parsed there and
    // scaled — a `12px` radius must grow with the export, a `50%` must not drift.
    const ox = -w / 2;
    const oy = -h / 2;
    if (L.clipPath) {
      const shape = parseClipShape(L.clipPath, L.rect.w, L.rect.h);
      if (shape) {
        if (shape.kind === 'empty') return;       // a well-formed clip enclosing nothing
        const p = new Path2D();
        if (shape.kind === 'circle') p.arc(ox + shape.cx * S, oy + shape.cy * S, shape.r * S, 0, Math.PI * 2);
        else if (shape.kind === 'ellipse') p.ellipse(ox + shape.cx * S, oy + shape.cy * S, shape.rx * S, shape.ry * S, 0, 0, Math.PI * 2);
        else if (shape.kind === 'inset') p.rect(ox + shape.x * S, oy + shape.y * S, shape.w * S, shape.h * S);
        else {
          shape.points.forEach(([px, py], i) => (i ? p.lineTo(ox + px * S, oy + py * S) : p.moveTo(ox + px * S, oy + py * S)));
          p.closePath();
        }
        ctx.clip(p);
      }
    } else if (L.radius) {
      const r = radiiOf(L.radius, L.rect.w, L.rect.h).map((v) => v * S) as [number, number, number, number];
      if (r.some((v) => v > 0)) {
        const p = new Path2D();
        p.roundRect(ox, oy, w, h, r);
        ctx.clip(p);
      }
    }

    if (L.kind === 'lottie') {
      if (res?.lottieCanvas) ctx.drawImage(res.lottieCanvas as CanvasImageSource, ox, oy, w, h);
      else if (res?.under) ctx.drawImage(res.under as CanvasImageSource, ox, oy, w, h);
      return;
    }

    if (L.kind === 'video') {
      // Background + anything painted UNDER the media, then the frame, then the
      // box's own text back on top (the DOM order the preview paints in).
      if (res?.under) ctx.drawImage(res.under as CanvasImageSource, ox, oy, w, h);
      if (res?.provider && item.sourceSec != null) {
        const el = res.media;
        const cs = el ? el.style : null;
        const f = fitRect(cs?.objectFit || 'contain', cs?.objectPosition || '', res.provider.w, res.provider.h, w, h);
        await res.provider.drawAt(ctx, item.sourceSec, { dx: ox + f.x, dy: oy + f.y, dw: f.w, dh: f.h });
      }
      if (res?.over) ctx.drawImage(res.over as CanvasImageSource, ox, oy, w, h);
      return;
    }

    if (res?.under) ctx.drawImage(res.under as CanvasImageSource, ox, oy, w, h);
  } finally {
    ctx.restore();
  }
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

interface MixResult { buffer: AudioBuffer | null; hasClipAudio: boolean }

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
  if (!OAC || !(totalSec > 0)) return { buffer: null, hasClipAudio: false };
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
    if (!url) continue;
    let clip: ClipAudio | null = null;
    try {
      clip = await createClipAudio(url, { log });
    } catch (err) {
      log('warn', `sequence audio: ${toCodedError(err).message} — clip will be silent`);
      continue;
    }
    if (!clip) continue;
    try {
      const from = L.clipInMs / 1000;
      const srcDur = clip.durationSec();
      const to = srcDur > 0 ? Math.min(from + L.durMs / 1000, srcDur) : from + L.durMs / 1000;
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

  if (opts.audio?.url) {
    try {
      const bytes = await (await fetch(opts.audio.url)).arrayBuffer();
      const bed = await octx.decodeAudioData(bytes);
      const duckLevel = clamp01(opts.audio.duck ?? 1);
      const duck = spans.length && duckLevel < 1
        ? { level: duckLevel, startSec: Math.min(...spans.map((s) => s.from)), endSec: Math.max(...spans.map((s) => s.to)) }
        : undefined;
      connectBed(octx, bed, octx.destination, {
        fadeIn: opts.audio.fadeIn, fadeOut: opts.audio.fadeOut,
        clipSec: totalSec, volume: opts.audio.volume, duck,
      });
    } catch (err) {
      log('warn', `Music bed unavailable (${(err as { message?: string })?.message ?? err}); exporting without it.`);
    }
  }

  if (!spans.length && !opts.audio?.url) return { buffer: null, hasClipAudio: false };
  try {
    return { buffer: await octx.startRendering(), hasClipAudio: spans.length > 0 };
  } catch (err) {
    log('warn', `Audio mix failed (${(err as { message?: string })?.message ?? err}); exporting silent.`);
    return { buffer: null, hasClipAudio: false };
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
  const stage = parseSequenceStage(node as HTMLElement);
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
  const res = new Map<number, LayerRes>();
  for (const L of stage.layers) {
    const win = activeFrameWindow(L, usedGrid, ext.get(L.idx) ?? 0);
    res.set(L.idx, {
      under: null, over: null, provider: null, media: null, lottie: null,
      lottieKey: Number.NaN, lottieCanvas: null,
      first: win.first, last: win.last, span: win.span,
      lastStats: null, srcClaimedSec: 0,
    });
  }
  {
    let peak = 0;
    for (let i = 0; i < frameCount; i++) {
      let n = 0;
      for (const L of stage.layers) {
        if (L.kind !== 'video') continue;
        const r = res.get(L.idx)!;
        if (r.first >= 0 && i >= r.first && i <= r.last) n++;
      }
      peak = Math.max(peak, n);
    }
    if (peak > MAX_LIVE_PROVIDERS) {
      throw sequenceError('SEQ_TOO_HEAVY', `${peak} video clips overlap; at most ${MAX_LIVE_PROVIDERS} can be decoded at once`);
    }
  }

  const canvas: AnyCanvas = streaming && typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(outW, targetH)
    : Object.assign(document.createElement('canvas'), { width: outW, height: targetH });
  const ctx = (canvas as any).getContext('2d', { alpha: true }) as AnyCtx;
  if (!ctx) throw sequenceError('SEQ_DECODE_FAILED', 'no 2D context for the sequence canvas');

  const transparent = opts.background === 'transparent';
  let bgRaster: HTMLCanvasElement | null = null;
  let mux: StreamingMux | null = null;
  const openProviders = new Set<InstrumentedProvider>();

  const disposeAll = async (): Promise<void> => {
    for (const p of [...openProviders]) { try { await p.dispose(); } catch { /* already gone */ } }
    openProviders.clear();
  };

  try {
    // ── static + chrome rasters (once each) ───────────────────────────────
    const restoreBlobs = await swapBlobUrls(stageEl);
    try {
      if (!transparent) {
        bgRaster = await rasterBox(stageEl, S, [...stageEl.querySelectorAll('.lolly-box')]);
      }
      for (const L of stage.layers) {
        const r = res.get(L.idx)!;
        if (r.first < 0 || L.kind === 'audio') continue;
        const el = L.el;
        if (L.kind === 'video') {
          r.media = (el.matches?.('video') ? el : el.querySelector('video')) as HTMLElement | null;
          // A ZIP bundle re-dispatches each sub-format through renderFormat, whose
          // motion guard keys on the OUTER format ('zip'), so snapshotMotion has
          // already frozen every <video> into a sibling <img>. That still must be
          // hidden too or it bakes into `over` and sits frozen on top of every
          // decoded frame for the clip's whole span.
          const hide = [
            ...(r.media ? [r.media] : []),
            ...el.querySelectorAll('[data-motion-still]'),
          ];
          r.under = await rasterBox(el, S, hide, { opaque: true });
          r.over = await rasterBox(el, S, hide, { transparentBg: true, opaque: true });
        } else if (L.kind === 'lottie') {
          r.lottie = el.matches?.('[data-lottie-src]') ? el : el.querySelector('[data-lottie-src]');
          r.under = await rasterBox(el, S, [], { opaque: true }); // the still fallback if no player mounted
        } else {
          r.under = await rasterBox(el, S, [], { opaque: true });
        }
      }
    } finally {
      restoreBlobs();
    }

    // ── audio (independent of the frame loop, so it is resolved up front) ──
    // Length is the ACTUAL clip length (frameCount/fps), not the authored one, so a
    // capped gif/apng and a full-length mp4 both get a bed that ends where they do.
    const mix = streaming ? await mixSequenceAudio(stage.layers, (frameCount / fps), opts, host) : { buffer: null, hasClipAudio: false };

    // ── the muxer (the codec ladder already ran, before the frame budget) ──
    const audioPick = pick && mix.buffer ? await pickWebCodecsAudio(pick.container) : null;

    const gifFrames: Uint8Array[] = [];
    const gifPixels: Uint8ClampedArray[] = [];

    if (pick) {
      mux = await createStreamingMux(pick, {
        width: outW, height: targetH, fps, bitrate,
        audio: audioPick ? { ...audioPick, channels: [] } : null,
      });
      log('info', `sequence: WebCodecs ${pick.container}/${pick.codec}${audioPick ? `+${audioPick.codec}` : ''} ${outW}×${targetH}@${fps} ${frameCount}f`);
    }

    // ── the frame loop ────────────────────────────────────────────────────
    const bitmaps: ImageBitmap[] = [];             // MediaRecorder fallback only
    for (let i = 0; i < frameCount; i++) {
      const t = usedGrid[i] as number;
      await watchdog(composeFrame(i, t), `frame ${i + 1}/${frameCount}`);

      if (mux) {
        await watchdog(mux.addFrame(canvas as CanvasImageSource, Math.round((i * 1e6) / fps)), `encode ${i + 1}/${frameCount}`);
      } else if (streaming) {
        bitmaps.push(await createImageBitmap(canvas as any));
      } else if (format === 'apng') {
        gifFrames.push(new Uint8Array(await (await canvasBlob(canvas, 'image/png')).arrayBuffer()));
      } else {
        gifPixels.push((ctx as CanvasRenderingContext2D).getImageData(0, 0, outW, targetH).data);
      }
      opts.onProgress?.(i + 1, frameCount);
    }

    // Every provider has finished; only now is a shortfall meaningful.
    reconcileProviders(stage.layers, res, fps, log);
    await disposeAll();

    if (mux) {
      if (mix.buffer && audioPick) await mux.addAudio(mix.buffer);
      const blob = await mux.finalize();
      mux = null;
      return await withVideoMeta(blob, blob.type, opts.meta, host);
    }
    if (streaming) return await recorderReplay(bitmaps, canvas as HTMLCanvasElement, ctx as CanvasRenderingContext2D, format, fps, opts, host);
    if (format === 'apng') return await apngBlob(gifFrames, fps, opts);
    return await gifBlob(gifPixels, outW, targetH, opts);
  } catch (err) {
    const coded = toCodedError(err);
    log('error', `sequence export failed (${coded.code}): ${coded.message}`);
    throw err;
  } finally {
    if (mux) { try { await mux.abort(); } catch { /* already down */ } }
    await disposeAll();
  }

  // ── inner helpers (closures over the render's state) ──────────────────────

  /** Fail rather than hang: a decoder that has gone quiet cannot be un-stuck. */
  async function watchdog<T>(p: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(sequenceError('SEQ_ABORTED', `sequence export stalled: ${label} made no progress for ${WATCHDOG_MS / 1000}s`)), WATCHDOG_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Paint the whole stage at `t`, opening/closing providers on their edges. */
  async function composeFrame(i: number, t: number): Promise<void> {
    // Providers are created at a clip's FIRST active frame and disposed at its
    // last, so a 12-clip sequence never has 12 decoders open.
    for (const L of stage!.layers) {
      if (L.kind !== 'video') continue;
      const r = res.get(L.idx)!;
      if (i !== r.first || r.provider) continue;
      const url = mediaSrc(L);
      if (!url) continue;
      const p = await createVideoProvider(url, { log });
      openProviders.add(p);
      r.provider = p;
      r.srcClaimedSec = p.stats().claimedDurationSec;
      if (r.span.length) p.prime?.(r.span);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, outW, targetH);
    if (bgRaster) ctx.drawImage(bgRaster as CanvasImageSource, 0, 0, outW, targetH);

    for (const item of sequenceDrawPlan(stage!.layers, t, stage!.totalMs)) {
      const r = res.get(item.layer.idx);
      if (item.layer.kind === 'lottie' && r) await primeLottie(r, item);
      await drawItem(ctx, item, r, S);
    }

    for (const L of stage!.layers) {
      if (L.kind !== 'video') continue;
      const r = res.get(L.idx)!;
      if (i === r.last && r.provider) {
        const p = r.provider;
        r.lastStats = p.stats();          // the only evidence the truncation guard gets
        r.provider = null;
        openProviders.delete(p);
        await p.dispose().catch(() => {});
      }
    }
  }

  /**
   * Advance the live Lottie player to this frame and re-raster the box.
   *
   * Memoised on the animation's OWN frame number, so a 30 fps export of a 12 fps
   * Lottie rasterises 12 times a second, not 30. A single-entry memo is enough
   * (the grid is monotonic, so repeats are always consecutive) and keeps the
   * cache O(1) instead of growing with the clip.
   */
  async function primeLottie(r: LayerRes, item: PlanItem): Promise<void> {
    if (!r.lottie || item.sourceSec == null) return;
    const player = lottiePlayerFor(r.lottie) as { goToAndStop?(v: number, isFrame?: boolean): void; frameRate?: number } | null;
    if (!player?.goToAndStop) return;
    const rate = Number.isFinite(player.frameRate) && (player.frameRate as number) > 0 ? (player.frameRate as number) : 30;
    const key = Math.round(item.sourceSec * rate);
    if (key === r.lottieKey && r.lottieCanvas) return;
    try { player.goToAndStop((key / rate) * 1000, false); } catch { return; }
    const shot = await rasterBox(item.layer.el, S, [], { opaque: true });
    if (shot) { r.lottieCanvas = shot; r.lottieKey = key; }
  }
}

// ── truncation reconciliation (spike rule 7) ────────────────────────────────

/**
 * Did every clip actually answer the requests we made of it?
 *
 * A truncated container decodes a clean, short iteration with no error, so the only
 * evidence is arithmetic. Getting the arithmetic right means reconciling the
 * provider's ANSWERS against its own REQUESTS, in the SOURCE's time domain, with
 * four corrections that each turned a healthy export into a false SEQ_TRUNCATED:
 *
 *  • speed. The span is in source seconds and a speed-s clip walks it s times
 *    faster than the output grid, so the sampling rate is `fps / speed`, not `fps`.
 *  • requests, not draws. `decoded` counts DRAWS, and the compositor skips them for
 *    a transparent or zero-size box (a hidden clip kept only for its audio draws
 *    nothing at all, and every fade's first frame has alpha exactly 0).
 *  • the source's own end. A clip may be trimmed longer than its media, and a
 *    crossfade tail deliberately samples past the out-point; those requests can
 *    never be answered and are not evidence of anything.
 *  • PTS granularity. `lastSourceSec` is the decoded sample's presentation time,
 *    which lags the request by up to one SOURCE frame — 83 ms on a 12 fps screen
 *    recording, against a tolerance that would otherwise be 67 ms.
 */
function reconcileProviders(
  layers: SeqLayer[], res: Map<number, LayerRes>, fps: number, log: (l: string, m: string) => void,
): void {
  for (const L of layers) {
    if (L.kind !== 'video') continue;
    const r = res.get(L.idx);
    if (!r || !r.span.length) continue;
    const s = r.provider?.stats() ?? r.lastStats;
    if (!s) continue;
    if (!s.requests) {
      log('info', 'sequence: a clip was never asked for a frame (invisible or zero-size) — nothing to reconcile.');
      continue;
    }
    const srcFps = fps / (Number.isFinite(L.speed) && L.speed > 0 ? L.speed : 1);
    const from = s.firstRequestSec >= 0 ? s.firstRequestSec : (r.span[0] as number);
    // What the source could actually have answered: our last request, but never
    // past the media's own end.
    const dur = r.srcClaimedSec > 0 ? r.srcClaimedSec : 0;
    const askedEnd = s.lastRequestSec >= 0 ? s.lastRequestSec : (r.span[r.span.length - 1] as number);
    const reachEnd = dur > 0 ? Math.min(askedEnd, dur) : askedEnd;
    const expected = Math.max(0, reachEnd - from) + 1 / srcFps;
    const check = reconcileDecoded({
      expectedSec: expected,
      decodedFrames: s.decoded,
      lastTsSec: Math.max(0, s.lastSourceSec - from),
      fps: srcFps,
      requestedFrames: s.requests,
      unreachableFrames: s.unreachable,
      sourceFrameSec: s.sourceFrameSec,
    });
    if (!check.ok) {
      throw sequenceError('SEQ_TRUNCATED', `a clip decoded ${check.shortfallSec.toFixed(2)}s short of its ${expected.toFixed(2)}s span — the source file looks truncated`);
    }
    log('info', `sequence: clip answered ${s.decoded}/${s.requests} requests (${s.missed} missed, ${s.unreachable} past its end, ${s.randomAccess ? 'random access' : 'primed'})`);
  }
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
