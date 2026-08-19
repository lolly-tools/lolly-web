// SPDX-License-Identifier: MPL-2.0
/**
 * On-device OCR RUNNER (plans/125) - the ORT-heavy half of `host.ocr`, the twin of
 * lib/matter.ts. PP-OCRv5 is a two-graph pipeline: a DBNet detector finds text
 * regions, then a CRNN/SVTR recogniser reads each cropped line (CTC-decoded against
 * a character dictionary). onnxruntime-web, the weights and all pixel work load and
 * run HERE (in a worker, off the boot budget); the bridge only marshals messages.
 *
 * The MATHS is factored into pure, exported, unit-tested functions - the CTC greedy
 * decode, the DBNet connected-component boxing, the box unclip and the reading-order
 * sort - so the tricky parts are verified as data (tests/ocr.test.ts), model-free.
 * The ONLY impure parts are the ORT sessions and the OffscreenCanvas resize/crop.
 *
 * Nothing runs until a model is STAGED (ocr-models.ts): every fetch returns null →
 * a clean "not installed" throw, never a crash.
 */

import type {
  OcrBox, OcrFeasibility, OcrFrame, OcrLine, OcrModelId, OcrOpts, OcrProgress, OcrResult,
} from '@lolly-tools/core/host-v1';
import { createDebugLogger, createModelFetcher, loadOrt, makeCanvas, serializeSessionCreate } from './ort.ts';
import {
  OCR_DEFAULT_MODEL, OCR_MODEL_CACHE_VERSION, OCR_MODEL_DIR, OCR_MODEL_FILES, OCR_MODEL_SPEC,
  OCR_MODEL_STORE, type OcrModelSpec, stagedOcrModels,
} from './ocr-models.ts';

const dbg = createDebugLogger({ tag: 'ocr', storageKey: 'lolly:ocr:debug', globalFlag: '__OCR_DEBUG__' });

const fetchModelBytes = createModelFetcher({
  store: OCR_MODEL_STORE,
  dir: OCR_MODEL_DIR,
  version: OCR_MODEL_CACHE_VERSION,
  dbg,
});

// ─── Backend (OCR is WASM-only by design) ─────────────────────────────────────
//
// The models are small, and ort-web's GPU kernels reject ops the DBNet/CRNN graphs
// use (the same wall matte hit). So the backend is always 'wasm' once probed - the
// bridge's backend() reports it, and it never claims webgpu.

let backend: 'wasm' | null = null;

export function currentBackend(): 'wasm' | null {
  return backend;
}

export async function probeBackend(): Promise<'wasm' | null> {
  if (backend) return backend;
  try {
    await loadOrt();
    backend = 'wasm';
  } catch {
    backend = null;
  }
  return backend;
}

export function abortError(message = 'The text read was aborted.'): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException(message, 'AbortError')
    : Object.assign(new Error(message), { name: 'AbortError' });
}

// ─── Pure maths (unit-tested; no ORT, no DOM) ─────────────────────────────────

export interface DetBox extends OcrBox {
  /** Mean detector probability inside the region - the box's confidence. */
  score: number;
}

/**
 * CTC greedy decode. `probs` is time-major (`probs[t * C + c]` is class c's
 * probability at step t). Collapses runs of the same class, drops the blank
 * (index 0), and maps the rest through `charset` (`charset[0]` is the blank slot).
 * `confidence` is the mean of the kept steps' peak probabilities.
 */
export function ctcGreedyDecode(
  probs: ArrayLike<number>, T: number, C: number, charset: string[],
): { text: string; confidence: number } {
  let out = '';
  let prev = -1;
  let sum = 0;
  let kept = 0;
  for (let t = 0; t < T; t++) {
    let best = 0;
    let bestP = -Infinity;
    const base = t * C;
    for (let c = 0; c < C; c++) {
      const p = probs[base + c] ?? 0;
      if (p > bestP) { bestP = p; best = c; }
    }
    // Collapse repeats first, then drop the blank (CTC's rule, in that order).
    if (best !== prev && best !== 0) {
      out += charset[best] ?? '';
      sum += bestP;
      kept++;
    }
    prev = best;
  }
  return { text: out, confidence: kept ? sum / kept : 0 };
}

/**
 * DBNet post-process: turn a probability map into axis-aligned text boxes. The
 * map is thresholded to a binary mask, 4-connected components are labelled, and
 * each component becomes a box whose `score` is its mean probability. Boxes below
 * `minArea` or `boxThresh` are dropped. Boxes are in MAP pixel coordinates.
 */
export function connectedComponentBoxes(
  prob: ArrayLike<number>, w: number, h: number,
  { binThresh, minArea, boxThresh }: { binThresh: number; minArea: number; boxThresh: number },
): DetBox[] {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const boxes: DetBox[] = [];
  const at = (i: number): number => prob[i] ?? 0;
  for (let start = 0; start < n; start++) {
    if (seen[start] || at(start) < binThresh) continue;
    // Flood-fill this component (iterative, 4-connectivity).
    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0, probSum = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop() ?? 0;
      const x = idx % w;
      const y = (idx - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
      probSum += at(idx);
      if (x > 0 && !seen[idx - 1] && at(idx - 1) >= binThresh) { seen[idx - 1] = 1; stack.push(idx - 1); }
      if (x < w - 1 && !seen[idx + 1] && at(idx + 1) >= binThresh) { seen[idx + 1] = 1; stack.push(idx + 1); }
      if (y > 0 && !seen[idx - w] && at(idx - w) >= binThresh) { seen[idx - w] = 1; stack.push(idx - w); }
      if (y < h - 1 && !seen[idx + w] && at(idx + w) >= binThresh) { seen[idx + w] = 1; stack.push(idx + w); }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const score = probSum / count;
    if (bw * bh >= minArea && score >= boxThresh) {
      boxes.push({ x: minX, y: minY, w: bw, h: bh, score });
    }
  }
  return boxes;
}

/**
 * DBNet "unclip": the net emits a SHRUNK region, so a box is expanded outward
 * before cropping. For an axis-aligned box the offset is `area * ratio /
 * perimeter` (the rectangle case of the polygon offset PP-OCR uses), clamped to
 * the map bounds.
 */
export function unclipBox(box: OcrBox, ratio: number, bounds: { w: number; h: number }): OcrBox {
  const area = box.w * box.h;
  const perim = 2 * (box.w + box.h);
  const d = perim > 0 ? Math.round((area * ratio) / perim) : 0;
  const x = Math.max(0, box.x - d);
  const y = Math.max(0, box.y - d);
  const x2 = Math.min(bounds.w, box.x + box.w + d);
  const y2 = Math.min(bounds.h, box.y + box.h + d);
  return { x, y, w: x2 - x, h: y2 - y };
}

/**
 * Reading order: group boxes into lines (vertical overlap > half the shorter box),
 * order lines top→bottom, and each line's boxes left→right. Stable for a column of
 * text and for a paragraph; a multi-column layout reads column-naively (a later
 * refinement), which is honest for the flat documents this targets.
 */
export function orderBoxesReadingOrder<T extends OcrBox>(boxes: T[]): T[] {
  const byTop = [...boxes].sort((a, b) => a.y - b.y);
  const lines: T[][] = [];
  for (const b of byTop) {
    const line = lines.find((ln) => {
      const ref = ln[0];
      if (!ref) return false;
      const overlap = Math.min(b.y + b.h, ref.y + ref.h) - Math.max(b.y, ref.y);
      return overlap > Math.min(b.h, ref.h) / 2;
    });
    if (line) line.push(b);
    else lines.push([b]);
  }
  for (const ln of lines) ln.sort((a, b) => a.x - b.x);
  lines.sort((a, b) => (a[0]?.y ?? 0) - (b[0]?.y ?? 0));
  return lines.flat();
}

// ─── ORT sessions + pixel work (impure) ───────────────────────────────────────

type Ort = Awaited<ReturnType<typeof loadOrt>>;
type InferenceSession = Awaited<ReturnType<Ort['InferenceSession']['create']>>;

interface Loaded {
  det: InferenceSession;
  rec: InferenceSession;
  /** charset[0] is the CTC blank; [1..N] the dictionary; a space is appended. */
  charset: string[];
  spec: OcrModelSpec;
}

/** First tensor output of a session run (PP-OCR graphs have one). */
function firstOutput(out: Record<string, unknown>): { data: ArrayLike<number>; dims: readonly number[] } {
  const v = Object.values(out)[0] as { data: ArrayLike<number>; dims: readonly number[] } | undefined;
  if (!v) throw new Error('The OCR model returned no output.');
  return v;
}

const loadedByModel = new Map<OcrModelId, Promise<Loaded>>();

/** Whether a model's three files are already on-device. Never downloads. */
export async function modelCached(id: OcrModelId): Promise<boolean> {
  const files = OCR_MODEL_FILES[id];
  if (!files) return false;
  for (const f of [files.det, files.rec, files.dict]) {
    if (!(await fetchModelBytes(f, true))) return false;
  }
  return true;
}

async function createSession(bytes: ArrayBuffer): Promise<InferenceSession> {
  const ort = await loadOrt();
  return serializeSessionCreate(() =>
    ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
  );
}

async function load(id: OcrModelId, onProgress?: (p: OcrProgress) => void): Promise<Loaded> {
  const existing = loadedByModel.get(id);
  if (existing) return existing;
  const files = OCR_MODEL_FILES[id];
  const spec = OCR_MODEL_SPEC[id];
  if (!files || !spec) throw new Error(`Unknown OCR model: ${id}`);
  const p = (async (): Promise<Loaded> => {
    const report = (loaded: number, total: number): void => onProgress?.({ phase: 'download', loaded, total, fraction: total ? loaded / total : undefined });
    const detBytes = await fetchModelBytes(files.det, false, (fp) => report(fp.loaded, fp.total ?? 0));
    const recBytes = await fetchModelBytes(files.rec, false, (fp) => report(fp.loaded, fp.total ?? 0));
    const dictBytes = await fetchModelBytes(files.dict, false);
    if (!detBytes || !recBytes || !dictBytes) {
      const e: Error & { code?: string } = new Error('The OCR model is not installed.');
      e.code = 'not-installed';
      throw e;
    }
    const lines = new TextDecoder('utf-8').decode(dictBytes).split(/\r?\n/).filter((l) => l.length > 0);
    // PP-OCR CTCLabelDecode: [blank] + dictionary + [space].
    const charset = ['', ...lines, ' '];
    const [det, rec] = await Promise.all([createSession(detBytes), createSession(recBytes)]);
    return { det, rec, charset, spec };
  })();
  loadedByModel.set(id, p);
  try { return await p; } catch (err) { loadedByModel.delete(id); throw err; }
}

/** The whole source frame on its own canvas - drawn once, cropped/scaled from repeatedly. */
function sourceCanvas(frame: OcrFrame): OffscreenCanvas | HTMLCanvasElement {
  const c = makeCanvas(frame.width, frame.height);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  return c;
}

/** Scale a source-canvas region into a w×h RGBA buffer. */
function regionRgba(src: OffscreenCanvas | HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number, w: number, h: number): Uint8ClampedArray {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src as unknown as CanvasImageSource, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** RGBA → CHW float32, per-channel (v/255 - mean)/std. */
function packNchw(rgba: Uint8ClampedArray, w: number, h: number, mean: [number, number, number], std: [number, number, number]): Float32Array {
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0, px = 0; i < rgba.length; i += 4, px++) {
    out[px] = ((rgba[i] ?? 0) / 255 - mean[0]) / std[0];
    out[plane + px] = ((rgba[i + 1] ?? 0) / 255 - mean[1]) / std[1];
    out[2 * plane + px] = ((rgba[i + 2] ?? 0) / 255 - mean[2]) / std[2];
  }
  return out;
}

/** Detector input size: fit the long side to limitSide, round both to a /32 multiple. */
function detSize(w: number, h: number, limitSide: number): { dw: number; dh: number } {
  const scale = Math.min(1, limitSide / Math.max(w, h));
  const round32 = (v: number): number => Math.max(32, Math.round((v * scale) / 32) * 32);
  return { dw: round32(w), dh: round32(h) };
}

export interface OcrRunCtx {
  onProgress?: (p: OcrProgress) => void;
  checkAbort?: () => void;
}

/** Honest feasibility - the models are small, so this only refuses a zero-size frame. */
export function canRunOcr(src: { width: number; height: number }): OcrFeasibility {
  if (!stagedOcrModels().length) return { ok: false, reason: 'no-backend', message: 'No OCR model is installed yet.' };
  if (src.width < 1 || src.height < 1) return { ok: false, reason: 'too-large', message: 'That image has no pixels to read.' };
  return { ok: true };
}

/**
 * Read the text in a frame. Detection → per-line crop → recognition → assembled
 * `OcrResult` in reading order. `singleLine` skips detection and reads the whole
 * frame as one line. Cooperatively abortable between stages.
 */
export async function runOcr(frame: OcrFrame, opts: OcrOpts = {}, ctx: OcrRunCtx = {}): Promise<OcrResult> {
  const id = opts.model ?? OCR_DEFAULT_MODEL;
  const { det, rec, charset, spec } = await load(id, ctx.onProgress);
  ctx.checkAbort?.();

  const ort = await loadOrt();
  const source = sourceCanvas(frame);
  const bounds = { w: frame.width, h: frame.height };
  let boxes: OcrBox[];
  if (opts.singleLine) {
    boxes = [{ x: 0, y: 0, w: frame.width, h: frame.height }];
  } else {
    ctx.onProgress?.({ phase: 'detect' });
    const { dw, dh } = detSize(frame.width, frame.height, spec.det.limitSide);
    const nchw = packNchw(regionRgba(source, 0, 0, frame.width, frame.height, dw, dh), dw, dh, spec.det.mean, spec.det.std);
    const detOut = await det.run({ [spec.det.inputName]: new ort.Tensor('float32', nchw, [1, 3, dh, dw]) });
    ctx.checkAbort?.();
    const first = firstOutput(detOut);
    const ph = first.dims[2] ?? dh;
    const pw = first.dims[3] ?? dw;
    const mapBoxes = connectedComponentBoxes(first.data, pw, ph, {
      binThresh: spec.det.binThresh, minArea: spec.det.minBoxArea, boxThresh: spec.det.boxThresh,
    });
    // Map boxes from the (scaled) det map back to source pixels, then unclip.
    const sx = frame.width / pw;
    const sy = frame.height / ph;
    boxes = orderBoxesReadingOrder(
      mapBoxes.map((b) => unclipBox(
        { x: Math.round(b.x * sx), y: Math.round(b.y * sy), w: Math.round(b.w * sx), h: Math.round(b.h * sy) },
        spec.det.unclipRatio, bounds,
      )),
    );
  }

  ctx.onProgress?.({ phase: 'recognize' });
  const lines: OcrLine[] = [];
  const min = opts.minConfidence ?? 0;
  for (let i = 0; i < boxes.length; i++) {
    ctx.checkAbort?.();
    const box = boxes[i];
    if (!box || box.w < 2 || box.h < 2) continue;
    // Crop the box, resize to the recogniser's fixed height keeping aspect (capped).
    const rw = Math.min(spec.rec.maxWidth, Math.max(spec.rec.height, Math.round((box.w / box.h) * spec.rec.height)));
    const recRgba = regionRgba(source, box.x, box.y, box.w, box.h, rw, spec.rec.height);
    const recNchw = packNchw(recRgba, rw, spec.rec.height, spec.rec.mean, spec.rec.std);
    const recOut = await rec.run({ [spec.rec.inputName]: new ort.Tensor('float32', recNchw, [1, 3, spec.rec.height, rw]) });
    const ro = firstOutput(recOut);
    const T = ro.dims[1] ?? 0;
    const C = ro.dims[2] ?? 0;
    const { text, confidence } = ctcGreedyDecode(ro.data, T, C, charset);
    if (text.trim() && confidence >= min) lines.push({ text: text.trim(), confidence, box });
    ctx.onProgress?.({ phase: 'recognize', fraction: (i + 1) / boxes.length });
  }

  return { text: lines.map((l) => l.text).join('\n'), lines, lang: stagedOcrModels().find((m) => m.id === id)?.languages[0] ?? 'en' };
}
