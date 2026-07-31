// SPDX-License-Identifier: MPL-2.0
/**
 * sequence-render.worker.ts — the DOM-FREE HALF of the sequence compositor, and
 * the Worker entry that runs it off the main thread (Fable timeline, phase 4
 * Track B).
 *
 * WHY THIS FILE IS BOTH A MODULE AND A WORKER. Determinism is the hard
 * requirement: the worker path must produce output IDENTICAL to the in-thread
 * path (phase 3 pinned frame-exactness with a sha256 across two runs). The only
 * way to guarantee that without a second sha is to have exactly ONE compositor.
 * So the frame loop, `drawItem`, the provider lifecycle and the truncation
 * reconciliation live here, and BOTH callers drive them:
 *
 *   • sequence-render.ts imports `runSequenceJob` and calls it directly for the
 *     in-thread path (and for gif / apng / the MediaRecorder fallback, which can
 *     never leave the main thread);
 *   • this same file, loaded as a module Worker, calls `runSequenceJob` with an
 *     IO that feeds a streaming muxer and posts the bytes back.
 *
 * The `addEventListener('message', …)` registration at the bottom is therefore
 * guarded on actually being in worker scope — importing this module on the main
 * thread must not install a window message listener.
 *
 * THE SPLIT RULE (the crux of Track B). Three things cannot leave the main
 * thread, and none of them are in this file:
 *   1. dom-to-image rasterisation of a box — it needs the live DOM and computed
 *      styles. Statics are shot ONCE up front and arrive here as ImageBitmaps.
 *   2. the OfflineAudioContext mix — main-thread only. It arrives here as planar
 *      Float32Array PCM.
 *   3. a LOTTIE layer, which must be advanced on the live lottie-web player and
 *      re-rasterised per frame. lottie-web is not runnable in a worker, so a
 *      lottie frame is requested back over the message channel (`need-lottie`)
 *      and the worker blocks on it. At most ONE such request is ever outstanding
 *      — the tightest possible bound on the queue, so a slow main thread cannot
 *      balloon worker memory.
 * Consequently: a sequence with NO lottie layer runs 100 % worker-side; one with
 * a lottie layer runs hybrid, and the compositor reports which.
 *
 * MEMORY. Unchanged from the in-thread path: one canvas, at most two decoded
 * samples per open provider, at most HIGH_WATER+1 VideoFrames in the mux, and at
 * most one lottie ImageBitmap in flight. Nothing here is O(frames).
 */

import {
  sequenceDrawPlan,
  activeFrameWindow,
  crossfadeJunctions,
  reconcileDecoded,
  sequenceError,
  SequenceError,
  toCodedError,
  type SeqLayer,
  type PlanItem,
} from './sequence-plan.ts';
import {
  createVideoProvider,
  type InstrumentedProvider,
  type ProviderStats,
} from './sequence-providers.ts';
import {
  createStreamingMux,
  type EncodePick,
  type EncodeAudio,
  type PcmSource,
  type StreamingMux,
} from './video-encode-core.ts';
import { parseClipShape } from '@lolly/engine';

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

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

// ── the wire shape of a layer ───────────────────────────────────────────────

/**
 * A `SeqLayer` with the DOM taken out of it — everything the compositor needs,
 * and nothing that cannot cross a `postMessage`.
 *
 * The two readings that USED to be taken off the live `<video>` inside the draw
 * call (`style.objectFit` / `style.objectPosition`) are lifted here, so the
 * executor never touches an element. `el` is deliberately absent: the planner
 * (`sequenceDrawPlan`, `crossfadeJunctions`, `activeFrameWindow`) never
 * dereferences it, which is what makes hydrating a `SeqLayer` without one safe.
 */
export interface SeqJobLayer {
  idx: number;
  startMs: number;
  durMs: number;
  clipInMs: number;
  speed: number;
  mute: boolean;
  enter: SeqLayer['enter'];
  enterMs: number;
  exit: SeqLayer['exit'];
  exitMs: number;
  /** The authored geometry curves, carried verbatim — the planner is the validator. */
  enterEase: string;
  exitEase: string;
  lane: SeqLayer['lane'];
  kind: SeqLayer['kind'];
  rect: { x: number; y: number; w: number; h: number; rot: number };
  opacity: number;
  blend: string;
  radius: string;
  clipPath: string;
  openEnded: boolean;
  /** Computed object-fit of the layer's media element ('' when it has none). */
  objectFit: string;
  /** Computed object-position of the layer's media element. */
  objectPosition: string;
  /**
   * True when this layer's picture comes from a LIVE DOM raster taken per frame
   * (a lottie box with a mounted player). The one thing that forces the hybrid
   * split — see the header.
   */
  needsLiveRaster: boolean;
}

/** Strip a parsed `SeqLayer` to its wire form. `media` supplies the two style reads. */
export function toJobLayer(
  L: SeqLayer, extra: { objectFit?: string; objectPosition?: string; needsLiveRaster?: boolean } = {},
): SeqJobLayer {
  return {
    idx: L.idx, startMs: L.startMs, durMs: L.durMs, clipInMs: L.clipInMs, speed: L.speed,
    mute: L.mute, enter: L.enter, enterMs: L.enterMs, exit: L.exit, exitMs: L.exitMs,
    enterEase: L.enterEase, exitEase: L.exitEase,
    lane: L.lane, kind: L.kind,
    rect: { x: L.rect.x, y: L.rect.y, w: L.rect.w, h: L.rect.h, rot: L.rect.rot },
    opacity: L.opacity, blend: L.blend, radius: L.radius, clipPath: L.clipPath,
    openEnded: L.openEnded,
    objectFit: extra.objectFit ?? '',
    objectPosition: extra.objectPosition ?? '',
    needsLiveRaster: extra.needsLiveRaster ?? false,
  };
}

/**
 * The element-free stand-in a hydrated layer carries.
 *
 * A frozen empty object, not `null`: the plan module reads `layer.el` nowhere,
 * but a defensive `l.el?.something` somewhere downstream should read as "no
 * element" rather than throwing inside a frame loop.
 */
const NO_EL = Object.freeze({}) as unknown as HTMLElement;

/** Wire form → the `SeqLayer` the pure planner consumes. */
export function hydrateJobLayer(w: SeqJobLayer): SeqLayer {
  return {
    el: NO_EL,
    idx: w.idx, startMs: w.startMs, durMs: w.durMs, clipInMs: w.clipInMs, speed: w.speed,
    mute: w.mute, enter: w.enter, enterMs: w.enterMs, exit: w.exit, exitMs: w.exitMs,
    enterEase: w.enterEase || '', exitEase: w.exitEase || '',
    lane: w.lane, kind: w.kind, rect: { ...w.rect }, opacity: w.opacity, blend: w.blend,
    radius: w.radius, clipPath: w.clipPath, openEnded: w.openEnded,
  };
}

// ── the job ─────────────────────────────────────────────────────────────────

/**
 * The already-rasterised plates for one layer (see `SeqJob.plates`).
 *
 * `CanvasImageSource`, not `ImageBitmap`, because the SAME job shape drives both
 * threads: in-thread the plates are the `HTMLCanvasElement`s dom-to-image just
 * produced, and only the worker path converts them to transferable bitmaps.
 * `drawImage` cannot tell the two apart, which is what keeps the output identical.
 */
export interface SeqJobPlate {
  idx: number;
  /** Statics: the whole box. Media: the box with its media element hidden. */
  under: CanvasImageSource | null;
  /** Media only: the box's text/overlay chrome over a transparent background. */
  over: CanvasImageSource | null;
}

/** One clip's bytes (worker path) or its URL (in-thread path). */
export interface SeqJobClip { idx: number; src: Blob | string }

/**
 * Everything the DOM-free executor needs for one render. Every field is
 * structured-cloneable, so the exact same object drives the in-thread call and
 * the worker `postMessage`.
 */
export interface SeqJob {
  layers: SeqJobLayer[];
  /** Output frame times, ms — already capped to `frameCount`. */
  grid: number[];
  frameCount: number;
  fps: number;
  totalMs: number;
  outW: number;
  outH: number;
  /** Export pixels per authored px. */
  scale: number;
  /** The artboard behind every layer, or null for a transparent export. */
  bg: CanvasImageSource | null;
  plates: SeqJobPlate[];
  clips: SeqJobClip[];
  /** Copied from the renderer's policy constants so the worker holds no second copy. */
  maxLiveProviders: number;
  watchdogMs: number;
}

const isBitmap = (v: unknown): v is ImageBitmap =>
  typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap;

/** Collect every transferable inside a job, for `postMessage`'s transfer list. */
export function jobTransferables(job: SeqJob): Transferable[] {
  const out: Transferable[] = [];
  for (const v of [job.bg, ...job.plates.flatMap((p) => [p.under, p.over])]) {
    if (isBitmap(v)) out.push(v);
  }
  return out;
}

/** Close every ImageBitmap a job carries (canvases are left alone). */
export function closeJobBitmaps(job: SeqJob): void {
  for (const v of [job.bg, ...job.plates.flatMap((p) => [p.under, p.over])]) {
    if (isBitmap(v)) { try { v.close(); } catch { /* already closed */ } }
  }
}

/** The host side of one run: where frames go, and how a live raster is fetched. */
export interface SeqJobIO {
  log?(level: string, msg: string): void;
  /** A composed frame is on the canvas. `tsUs` is its presentation time, µs. */
  frame(canvas: AnyCanvas, ctx: AnyCtx, i: number, tsUs: number): Promise<void>;
  /**
   * The live-DOM raster for a `needsLiveRaster` layer at this frame, or null to
   * fall back to the layer's static plate. Called at most once per layer per
   * frame, and never concurrently — that IS the bounded queue.
   */
  lottieAt?(layerIdx: number, frameIndex: number, sourceSec: number): Promise<CanvasImageSource | null>;
  /** Release what `lottieAt` handed over (the worker closes a transferred bitmap). */
  releaseLottie?(img: CanvasImageSource): void;
  progress?(done: number, total: number): void;
  /** Polled once per frame; true tears the render down with SEQ_ABORTED. */
  aborted?(): boolean;
}

// ── per-layer resources ─────────────────────────────────────────────────────

interface LayerRes {
  under: CanvasImageSource | null;
  over: CanvasImageSource | null;
  provider: InstrumentedProvider | null;
  objectFit: string;
  objectPosition: string;
  /** The live raster for the frame being composed, when one was supplied. */
  live: CanvasImageSource | null;
  /** Output-grid frame indices this layer is on screen for, inclusive. */
  first: number;
  last: number;
  /** The source times the provider will be asked for, ascending (seconds). */
  span: number[];
  /** Counters copied off the provider just before it was disposed. */
  lastStats: ProviderStats | null;
  /** The length this clip's source CLAIMS, copied off the provider. */
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
export async function drawItem(ctx: AnyCtx, item: PlanItem, res: LayerRes | undefined, S: number): Promise<void> {
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
      if (res?.live) ctx.drawImage(res.live, ox, oy, w, h);
      else if (res?.under) ctx.drawImage(res.under, ox, oy, w, h);
      return;
    }

    if (L.kind === 'video') {
      // Background + anything painted UNDER the media, then the frame, then the
      // box's own text back on top (the DOM order the preview paints in).
      if (res?.under) ctx.drawImage(res.under, ox, oy, w, h);
      if (res?.provider && item.sourceSec != null) {
        const f = fitRect(res.objectFit || 'contain', res.objectPosition || '', res.provider.w, res.provider.h, w, h);
        await res.provider.drawAt(ctx, item.sourceSec, { dx: ox + f.x, dy: oy + f.y, dw: f.w, dh: f.h });
      }
      if (res?.over) ctx.drawImage(res.over, ox, oy, w, h);
      return;
    }

    if (res?.under) ctx.drawImage(res.under, ox, oy, w, h);
  } finally {
    ctx.restore();
  }
}

/**
 * Compose every frame of `job` onto `ctx`, handing each one to `io.frame`.
 *
 * This is the ENTIRE frame loop for every output format and both threads. It
 * opens a clip's decoder at its first active frame and disposes it at its last,
 * runs the silent-truncation reconciliation once every provider has finished,
 * and guarantees no decoder outlives the call.
 */
export async function runSequenceJob(job: SeqJob, canvas: AnyCanvas, ctx: AnyCtx, io: SeqJobIO): Promise<void> {
  const log = (l: string, m: string): void => io.log?.(l, m);
  const layers = job.layers.map(hydrateJobLayer);
  const wireOf = new Map(job.layers.map((w) => [w.idx, w]));
  const clipOf = new Map(job.clips.map((c) => [c.idx, c.src]));
  const plateOf = new Map(job.plates.map((p) => [p.idx, p]));
  const S = job.scale;

  const ext = new Map(crossfadeJunctions(layers).map((j) => [j.aIdx, j.ms]));
  const res = new Map<number, LayerRes>();
  for (const L of layers) {
    const win = activeFrameWindow(L, job.grid, ext.get(L.idx) ?? 0);
    const w = wireOf.get(L.idx);
    const plate = plateOf.get(L.idx);
    res.set(L.idx, {
      under: plate?.under ?? null,
      over: plate?.over ?? null,
      provider: null,
      objectFit: w?.objectFit ?? '',
      objectPosition: w?.objectPosition ?? '',
      live: null,
      first: win.first, last: win.last, span: win.span,
      lastStats: null, srcClaimedSec: 0,
    });
  }

  const openProviders = new Set<InstrumentedProvider>();
  const disposeAll = async (): Promise<void> => {
    for (const p of [...openProviders]) { try { await p.dispose(); } catch { /* already gone */ } }
    openProviders.clear();
  };

  /** Fail rather than hang: a decoder that has gone quiet cannot be un-stuck. */
  const watchdog = async <T>(p: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(sequenceError('SEQ_ABORTED', `sequence export stalled: ${label} made no progress for ${job.watchdogMs / 1000}s`)), job.watchdogMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    for (let i = 0; i < job.frameCount; i++) {
      if (io.aborted?.()) throw sequenceError('SEQ_ABORTED', 'sequence export cancelled');
      const t = job.grid[i] as number;
      await watchdog(composeFrame(i, t), `frame ${i + 1}/${job.frameCount}`);
      await watchdog(io.frame(canvas, ctx, i, Math.round((i * 1e6) / job.fps)), `encode ${i + 1}/${job.frameCount}`);
      io.progress?.(i + 1, job.frameCount);
    }
    // Every provider has finished; only now is a shortfall meaningful.
    reconcileProviders(layers, res, job.fps, log);
  } finally {
    await disposeAll();
  }

  /** Paint the whole stage at `t`, opening/closing providers on their edges. */
  async function composeFrame(i: number, t: number): Promise<void> {
    // Providers are created at a clip's FIRST active frame and disposed at its
    // last, so a 12-clip sequence never has 12 decoders open.
    for (const L of layers) {
      if (L.kind !== 'video') continue;
      const r = res.get(L.idx)!;
      if (i !== r.first || r.provider) continue;
      const src = clipOf.get(L.idx);
      if (!src) continue;
      if (openProviders.size >= job.maxLiveProviders) {
        throw sequenceError('SEQ_TOO_HEAVY', `more than ${job.maxLiveProviders} video clips are decoding at once`);
      }
      const p = await createVideoProvider(src, { log });
      openProviders.add(p);
      r.provider = p;
      r.srcClaimedSec = p.stats().claimedDurationSec;
      if (r.span.length) p.prime?.(r.span);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, job.outW, job.outH);
    if (job.bg) ctx.drawImage(job.bg, 0, 0, job.outW, job.outH);

    const plan = sequenceDrawPlan(layers, t, job.totalMs);
    // The live-DOM rasters for this frame, fetched BEFORE any drawing so the
    // request/response hop overlaps nothing and stays strictly one-at-a-time.
    const taken: { r: LayerRes; img: CanvasImageSource }[] = [];
    try {
      if (io.lottieAt) {
        for (const item of plan) {
          const w = wireOf.get(item.layer.idx);
          if (!w?.needsLiveRaster || item.sourceSec == null) continue;
          const r = res.get(item.layer.idx);
          if (!r) continue;
          const img = await watchdog(io.lottieAt(item.layer.idx, i, item.sourceSec), `live raster ${i + 1}/${job.frameCount}`);
          if (img) { r.live = img; taken.push({ r, img }); }
        }
      }
      for (const item of plan) await drawItem(ctx, item, res.get(item.layer.idx), S);
    } finally {
      for (const { r, img } of taken) { r.live = null; io.releaseLottie?.(img); }
    }

    for (const L of layers) {
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

// ── the message protocol (mirrors video-encode.worker.ts's shape) ───────────

/** Planar PCM for the mix, already rendered by the main thread's OfflineAudioContext. */
export interface SeqWorkerAudio {
  codec: string;
  muxCodec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
  /** One Float32Array per channel; TRANSFERRED, so the sender loses them. */
  channels: Float32Array[];
  /** Sample frames per channel. */
  length: number;
}

export interface SeqWorkerStart {
  type: 'start';
  id: number;
  job: SeqJob;
  pick: EncodePick;
  bitrate: number;
  audio: SeqWorkerAudio | null;
}
/** The main thread's answer to `need-live`; `bitmap` null means "use the static plate". */
export interface SeqWorkerLive { type: 'live'; id: number; token: number; bitmap: ImageBitmap | null }
export interface SeqWorkerAbortMsg { type: 'abort'; id: number }
export type SeqWorkerIn = SeqWorkerStart | SeqWorkerLive | SeqWorkerAbortMsg;

export interface SeqWorkerNeedLive {
  type: 'need-live'; id: number; token: number; layerIdx: number; frame: number; sourceSec: number;
}
export interface SeqWorkerProgress { type: 'progress'; id: number; done: number; total: number }
export interface SeqWorkerLog { type: 'log'; id: number; level: string; msg: string }
export interface SeqWorkerDone { type: 'done'; id: number; buffer: ArrayBuffer; mime: string }
/**
 * A failed run.
 *
 * `offload` is the whole reason this is not just a coded error. The renderer's
 * fallback rule is "a CODED failure is the render's verdict; anything else is the
 * offload itself failing, so retry in-thread" — and `toCodedError` has no uncoded
 * outcome, so a protocol that carried only a code would classify EVERY worker-side
 * infrastructure failure as a verdict and make the in-thread fallback unreachable
 * for anything but a spawn error. Two things set it:
 *
 *   • an uncoded throw (`!(err instanceof SequenceError)`) — the same test the
 *     in-thread caller applies, evaluated where the throw actually happened;
 *   • a coded error explicitly tagged `offload` by code that KNOWS it only failed
 *     because it is in a worker. There is exactly one today: the element-seek
 *     provider, the last rung of the provider ladder, which needs a `<video>` and
 *     therefore cannot run here. A clip mediabunny declines (an exotic container,
 *     a codec with no hardware decoder) is decodable in-thread and must not be
 *     reported as an unsupported-media verdict just because the worker tried first.
 */
export interface SeqWorkerFail { type: 'error'; id: number; code: string; message: string; offload: boolean }
export type SeqWorkerOut = SeqWorkerNeedLive | SeqWorkerProgress | SeqWorkerLog | SeqWorkerDone | SeqWorkerFail;

/** Planar channels → the structural PCM source `StreamingMux.addAudio` consumes. */
export function pcmSourceOf(a: SeqWorkerAudio): PcmSource {
  return {
    length: a.length,
    numberOfChannels: a.numberOfChannels,
    getChannelData: (ch: number): Float32Array => a.channels[Math.min(ch, a.channels.length - 1)] ?? new Float32Array(a.length),
  };
}

/**
 * Run one `start` message to completion. Exported so a test can drive the whole
 * worker body against a stub port without spawning a Worker.
 */
export async function handleStart(
  msg: SeqWorkerStart,
  port: { post(m: SeqWorkerOut, transfer?: Transferable[]): void },
  ctl: { aborted(): boolean; awaitLive(token: number): Promise<ImageBitmap | null> },
  deps: {
    makeCanvas?: (w: number, h: number) => AnyCanvas;
    makeMux?: (pick: EncodePick, o: { width: number; height: number; fps: number; bitrate: number; audio: EncodeAudio | null }) => Promise<StreamingMux>;
  } = {},
): Promise<void> {
  const { id, job, pick } = msg;
  // EVERY exit from here on must close the transferred plates. They are the job's
  // only owner in this thread — the main thread's copies were detached by the
  // transfer — and at 1080p a ten-layer job is ~170 MB of native bitmap memory
  // that nothing else will ever reclaim. The outermost try is what guarantees it
  // covers the canvas, the context and the muxer construction too, all three of
  // which can throw before a frame is ever composed.
  try {
    await runOneJob();
  } finally {
    closeJobBitmaps(job);
  }

  async function runOneJob(): Promise<void> {
  const canvas = (deps.makeCanvas ?? ((w, h) => new OffscreenCanvas(w, h)))(job.outW, job.outH);
  const ctx = (canvas as OffscreenCanvas).getContext('2d', { alpha: true }) as AnyCtx | null;
  if (!ctx) throw sequenceError('SEQ_DECODE_FAILED', 'no 2D context for the sequence canvas');

  const audio = msg.audio;
  const mux = await (deps.makeMux ?? createStreamingMux)(pick, {
    width: job.outW, height: job.outH, fps: job.fps, bitrate: msg.bitrate,
    audio: audio ? { ...audio, channels: [] } : null,
  });

  let token = 0;
  let ok = false;
  try {
    await runSequenceJob(job, canvas, ctx, {
      log: (level, m) => port.post({ type: 'log', id, level, msg: m }),
      aborted: () => ctl.aborted(),
      progress: (done, total) => port.post({ type: 'progress', id, done, total }),
      frame: (c, _ctx2, _i, tsUs) => mux.addFrame(c as CanvasImageSource, tsUs),
      lottieAt: async (layerIdx, frame, sourceSec) => {
        const tk = ++token;
        port.post({ type: 'need-live', id, token: tk, layerIdx, frame, sourceSec });
        return await ctl.awaitLive(tk);
      },
      releaseLottie: (img) => { try { (img as ImageBitmap).close?.(); } catch { /* not a bitmap */ } },
    });
    if (audio) await mux.addAudio(pcmSourceOf(audio));
    const blob = await mux.finalize();
    ok = true;
    const buffer = await blob.arrayBuffer();
    port.post({ type: 'done', id, buffer, mime: blob.type }, [buffer]);
  } finally {
    if (!ok) { try { await mux.abort(); } catch { /* already down */ } }
  }
  }
}

/**
 * Is this throw the offload failing, or the render's verdict?
 *
 * Deliberately the SAME test `sequence-render.ts` applies to an in-thread throw
 * (`err instanceof SequenceError`), evaluated in the worker where the throw
 * happened — plus the explicit tag for a coded error that only exists because
 * this is a worker. See `SeqWorkerFail.offload`.
 */
export function isOffloadFailure(err: unknown): boolean {
  if (err instanceof SequenceError) {
    return (err as { offload?: unknown }).offload === true;
  }
  return true;
}

// ── per-run control state ───────────────────────────────────────────────────

/** The two things `handleStart` needs from its host: am I cancelled, and the raster. */
export interface RunControls { aborted(): boolean; awaitLive(token: number): Promise<ImageBitmap | null> }

/**
 * Run-scoped abort flags and live-raster waiters.
 *
 * EXTRACTED FROM THE WORKER ENTRY SO IT CAN BE TESTED. The client mints a fresh
 * run id per call and keeps its runs in a Map with no single-flight guard, so two
 * exports CAN overlap. A single-slot worker turns that into two silent
 * corruptions, and only one of them is even an error:
 *
 *   • the second `start` clears the first run's pending live-raster resolver, so
 *     run 1's `awaitLive` never settles, its watchdog fires, and a healthy export
 *     dies with SEQ_ABORTED;
 *   • both runs mint tokens 1, 2, 3… into the same waiter map, so run 2's reply
 *     resolves run 1's waiter and run 1 composites RUN 2's lottie frame into its
 *     own picture — a wrong-pixels export with no error anywhere.
 *
 * Keying every piece of state by run id is what makes the runs independent.
 */
export function createRunRegistry() {
  interface Run { aborted: boolean; waiters: Map<number, (b: ImageBitmap | null) => void> }
  const runs = new Map<number, Run>();
  return {
    /** Open a run and hand back the controls `handleStart` consumes. */
    begin(id: number): RunControls {
      const run: Run = { aborted: false, waiters: new Map() };
      runs.set(id, run);
      return {
        aborted: () => run.aborted,
        awaitLive: (token) => new Promise<ImageBitmap | null>((resolve) => {
          if (run.aborted) { resolve(null); return; }
          run.waiters.set(token, resolve);
        }),
      };
    },
    /** Cancel ONE run, unblocking whatever it is waiting for. */
    abort(id: number): void {
      const run = runs.get(id);
      if (!run) return;
      run.aborted = true;
      for (const [, resolve] of run.waiters) resolve(null);
      run.waiters.clear();
    },
    /**
     * Deliver a live raster. Returns false when nobody was waiting for it, in
     * which case the caller owns the transferred bitmap and must close it.
     */
    deliver(id: number, token: number, bitmap: ImageBitmap | null): boolean {
      const waiters = runs.get(id)?.waiters;
      const resolve = waiters?.get(token);
      if (!resolve) return false;
      waiters?.delete(token);
      resolve(bitmap);
      return true;
    },
    /** The run finished (either way). */
    end(id: number): void {
      runs.get(id)?.waiters.clear();
      runs.delete(id);
    },
    /** For tests. */
    size: (): number => runs.size,
  };
}

// ── the Worker entry ────────────────────────────────────────────────────────

/** True only inside a real dedicated/module worker — never on the main thread. */
function inWorkerScope(): boolean {
  const g = globalThis as { WorkerGlobalScope?: unknown; document?: unknown; importScripts?: unknown };
  return typeof g.WorkerGlobalScope !== 'undefined' && typeof g.document === 'undefined';
}

if (inWorkerScope()) {
  // Worker-scope postMessage overload (message, transfer) — narrow it past the
  // DOM lib's Window overload, as video-encode.worker.ts and zzfxm-worker.ts do.
  const raw = postMessage as (message: unknown, transfer: Transferable[]) => void;
  const port = { post: (m: SeqWorkerOut, transfer: Transferable[] = []): void => raw(m, transfer) };

  const registry = createRunRegistry();

  addEventListener('message', (e: MessageEvent<SeqWorkerIn>) => {
    const m = e.data;
    if (m.type === 'abort') { registry.abort(m.id); return; }
    if (m.type === 'live') {
      // No waiter: the run aborted or finished between the request and this
      // reply. The bitmap was transferred to us, so we own it and must close it.
      if (!registry.deliver(m.id, m.token, m.bitmap) && m.bitmap) {
        try { m.bitmap.close(); } catch { /* already closed */ }
      }
      return;
    }
    // 'start'
    void handleStart(m, port, registry.begin(m.id))
      .catch((err) => {
        const coded = toCodedError(err);
        port.post({ type: 'error', id: m.id, code: coded.code, message: coded.message, offload: isOffloadFailure(err) });
      })
      .finally(() => registry.end(m.id));
  });
}
