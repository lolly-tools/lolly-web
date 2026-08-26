// SPDX-License-Identifier: MPL-2.0
/**
 * On-device MONOCULAR DEPTH worker (plans/160 WP-A) - the twin of
 * lib/matte-worker.ts + lib/matter.ts folded into one file, because depth has no
 * native-backend override to share its geometry with (matte splits matter.ts out
 * only so shells/tauri-desktop/bridge-overrides/matte.ts can reuse it verbatim).
 *
 * A depth run is a multi-second ONNX forward pass, so it never touches the thread
 * a tool is being used on: onnxruntime-web, the weights and the resampling all
 * load and run HERE, dynamically, off the boot chunk. Same id-keyed
 * request/reply protocol as the matte worker, same per-run progress, same
 * cooperative abort checked at phase boundaries (a single session.run() cannot be
 * preempted mid-flight).
 *
 * PRIVACY: the weights come from `${MODELS_BASE}/models/depth/<file>` and nowhere
 * else - createModelFetcher owns that URL and there is no other fetch in this
 * module. Asserted by depth-worker.test.ts's source scan, the ai-detect-privacy
 * idiom.
 *
 * NO CANVAS, unlike matter.ts. Every resample below is a plain typed-array loop:
 * it keeps the whole pipeline except `session.run()` pure, so the fixture test
 * drives image-in → normalised-map-out through the real module in node, and the
 * worker stops depending on OffscreenCanvas being present.
 *
 * KNOWN GAPS (matter.ts's, inherited): the ORT path has never been run. The
 * weights are not published yet (plans/160 section 7 - a human step), so
 * DEPTH_STAGED is false and a run surfaces ModelNotInstalledError rather than
 * hanging. The PURE math below IS unit-tested; the orchestration around it is
 * verified by hand once a model is staged.
 */

import { createDebugLogger, createModelFetcher, loadOrt, serializeSessionCreate, type FetchProgress } from './ort.ts';
import {
  DEPTH_DEFAULT_MODEL, DEPTH_MODEL_CACHE_VERSION, DEPTH_MODEL_DIR, DEPTH_MODEL_FILES,
  DEPTH_MODEL_SPEC, DEPTH_MODEL_STORE, DEPTH_MAX_WORK_EDGE, planWorkSize,
  type DepthFrame, type DepthMap, type DepthModelId, type DepthModelSpec, type DepthOpts, type DepthProgress,
} from './depth-models.ts';

type OrtModule = typeof import('onnxruntime-web');
type InferenceSession = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;

const dbg = createDebugLogger({ tag: 'depth', storageKey: 'lolly:depth:debug', globalFlag: '__DEPTH_DEBUG__' });
const fetchModelBytes = createModelFetcher({
  store: DEPTH_MODEL_STORE, dir: DEPTH_MODEL_DIR, version: DEPTH_MODEL_CACHE_VERSION, dbg,
});

// ─── backend ─────────────────────────────────────────────────────────────────
//
// WASM only, like matte and for the same unverified-graph reason: ort-web's
// WebGPU (JSEP) kernels throw at run() - AFTER a clean create, so a create-time
// EP fallback cannot catch it - on op shapes this family may well use. Claiming
// webgpu before anyone has run the real graph would promise a path that fails at
// inference. Re-probe per-model once the weights exist (plans/160 WP-F).

let backendProbed: 'webgpu' | 'wasm' | null | undefined;

export async function probeBackend(): Promise<'webgpu' | 'wasm' | null> {
  if (backendProbed !== undefined) return backendProbed;
  backendProbed = typeof WebAssembly !== 'undefined' ? 'wasm' : null;
  return backendProbed;
}
/** The resolved backend without re-probing (null until probeBackend ran). */
export function currentBackend(): 'webgpu' | 'wasm' | null {
  return backendProbed ?? null;
}

/** A DOMException-shaped AbortError (with a plain-Error fallback for old runtimes). */
export function abortError(msg = 'The depth run was aborted.'): Error {
  try { return new DOMException(msg, 'AbortError'); }
  catch { return Object.assign(new Error(msg), { name: 'AbortError' }); }
}

/** Raised when a run is requested but the model's weights aren't on device -
 *  which is EVERY run until the weights are published. A clean, classifiable
 *  failure, never a hang. */
export class ModelNotInstalledError extends Error {
  readonly model: DepthModelId;
  constructor(model: DepthModelId) {
    super(`The ${model} depth model isn't downloaded on this device yet.`);
    this.name = 'ModelNotInstalledError';
    this.model = model;
  }
}

// ─── PURE math (unit-tested; no DOM, no ORT) ─────────────────────────────────

/**
 * Resample RGBA `src` (sw×sh) to dw×dh. Box-averages the source rectangle each
 * destination pixel covers, so the big downscales this path actually performs
 * (a 4000px photo → 2048 work → 518 model input) are properly filtered rather
 * than aliased; when a scale is >= 1 the box collapses to one sample, i.e.
 * nearest-neighbour, which only happens for fixtures smaller than the input.
 */
export function resampleRgba(
  src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yr);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * yr)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xr);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * xr)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * 4;
          r += src[i] as number; g += src[i + 1] as number; b += src[i + 2] as number; a += src[i + 3] as number;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

/** Bilinear resample of a single-channel float field. Used the other way round
 *  from resampleRgba - the model's 518² map back UP to the work size - where a
 *  box filter would leave visible blocks in the displacement. */
export function resampleFloat(
  src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number,
): Float32Array {
  const out = new Float32Array(dw * dh);
  if (sw < 1 || sh < 1) return out;
  const xr = sw > 1 && dw > 1 ? (sw - 1) / (dw - 1) : 0;
  const yr = sh > 1 && dh > 1 ? (sh - 1) / (dh - 1) : 0;
  for (let y = 0; y < dh; y++) {
    const fy = y * yr, y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = x * xr, x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      const a = src[y0 * sw + x0] as number, b = src[y0 * sw + x1] as number;
      const c = src[y1 * sw + x0] as number, d = src[y1 * sw + x1] as number;
      out[y * dw + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
    }
  }
  return out;
}

/** RGBA (0..255) at w×h → NCHW [1,3,h,w] float32, normalized per the spec:
 *  (pixel/255 − mean)/std, RGB planes, alpha dropped. */
export function packNchwNormalized(
  rgba: ArrayLike<number>, w: number, h: number, spec: DepthModelSpec,
): Float32Array {
  const total = w * h;
  const out = new Float32Array(total * 3);
  const [mr, mg, mb] = spec.mean;
  const [sr, sg, sb] = spec.std;
  const page = total, twoPage = 2 * total;
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    out[i] = ((rgba[idx] as number) / 255 - mr) / sr;
    out[i + page] = ((rgba[idx + 1] as number) / 255 - mg) / sg;
    out[i + twoPage] = ((rgba[idx + 2] as number) / 255 - mb) / sb;
  }
  return out;
}

/**
 * Raw single-channel model output → a 0..1 map where 1 is NEAREST.
 *
 * Depth Anything's head is relative INVERSE depth (disparity) on an arbitrary
 * scale that shifts per image, so min-max is the only normalisation available -
 * there is no absolute reference to anchor to. A flat field (max === min, e.g.
 * a solid colour) yields all-zeros rather than a divide-by-zero NaN, and NaN /
 * Infinity in the raw are skipped so one bad value cannot collapse the whole map.
 */
export function normaliseDepth(raw: ArrayLike<number>, count: number): Float32Array {
  const out = new Float32Array(count);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = raw[i] as number;
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (!(span > 1e-9)) return out;
  for (let i = 0; i < count; i++) {
    const v = raw[i] as number;
    out[i] = Number.isFinite(v) ? (v - min) / span : 0;
  }
  return out;
}

/** Everything preprocessDepth produces that postprocessDepth needs. */
export interface DepthPre {
  /** Work-size dimensions (source capped to opts.maxEdge). */
  workW: number;
  workH: number;
  /** NCHW [1,3,edge,edge] float32, normalized per the spec - the model input. */
  input: Float32Array;
  /** Model square edge (spec.inputSize[0]). */
  edge: number;
}

/** Source frame → the model's normalized NCHW input, keeping the work size the
 *  map is handed back at. Two resamples on purpose: source → work (the iOS memory
 *  cap, and the size the render and the export actually use), then work → the
 *  model square. */
export function preprocessDepth(frame: DepthFrame, spec: DepthModelSpec, opts: DepthOpts = {}): DepthPre {
  const edge = spec.inputSize[0];
  const { width: workW, height: workH } = planWorkSize(frame.width, frame.height, opts.maxEdge ?? DEPTH_MAX_WORK_EDGE);
  const work = workW === frame.width && workH === frame.height
    ? frame.data
    : resampleRgba(frame.data, frame.width, frame.height, workW, workH);
  // 'stretch': the square is filled ignoring aspect. Letterboxing would put a
  // black border into the field, and that border becomes fake far-depth that
  // drags the min-max normalisation with it.
  const square = resampleRgba(work, workW, workH, edge, edge);
  return { workW, workH, input: packNchwNormalized(square, edge, edge, spec), edge };
}

/** The model's raw output → the finished work-size 0..1 depth map. */
export function postprocessDepth(raw: ArrayLike<number>, pre: DepthPre): DepthMap {
  const { edge, workW, workH } = pre;
  const normalised = normaliseDepth(raw, edge * edge);
  const data = edge === workW && edge === workH
    ? normalised
    : resampleFloat(normalised, edge, edge, workW, workH);
  return { width: workW, height: workH, data };
}

// ─── session ─────────────────────────────────────────────────────────────────

const sessionCache = new Map<string, Promise<InferenceSession | null>>();

/** Load (once) the ONNX session for a model file, or null when its bytes aren't
 *  on device. Never throws - a missing/failed model is 'not-installed'. Note the
 *  bytes are fetched BEFORE onnxruntime is imported, so the (currently universal)
 *  no-weights case never pays for the runtime and never hangs on it. */
function loadSession(fileName: string, onDownload?: (p: FetchProgress) => void): Promise<InferenceSession | null> {
  let entry = sessionCache.get(fileName);
  if (entry) return entry;
  entry = (async (): Promise<InferenceSession | null> => {
    const bytes = await fetchModelBytes(fileName, false, onDownload);
    if (!bytes) return null;
    const ort: OrtModule = await loadOrt();
    await probeBackend();
    try {
      return await serializeSessionCreate(() =>
        ort.InferenceSession.create(new Uint8Array(bytes), {
          executionProviders: ['wasm'] as never,
          // GPU-resident output tensors read back empty; force CPU (the upscaler's lesson).
          preferredOutputLocation: 'cpu' as never,
        }));
    } catch (e) {
      dbg('session', { file: fileName, error: String(e) });
      return null;
    }
  })();
  sessionCache.set(fileName, entry);
  entry.then((s) => { if (!s) sessionCache.delete(fileName); }, () => sessionCache.delete(fileName));
  return entry;
}

/** Are a model's bytes already on device? Never downloads. */
export async function modelCached(id: DepthModelId): Promise<boolean> {
  const bytes = await fetchModelBytes(DEPTH_MODEL_FILES[id], true);
  return !!bytes;
}

// ─── the run ─────────────────────────────────────────────────────────────────

export interface DepthRunCtx {
  checkAbort(): void;
  onProgress?: (p: DepthProgress) => void;
}

/** Run depth estimation on the WASM (ort-web) path. Rejects on abort; throws
 *  ModelNotInstalledError when the weights aren't on device (the caller shows the
 *  download path). Abort is COOPERATIVE and polled at phase boundaries only - a
 *  single session.run() cannot be interrupted. */
export async function runDepth(frame: DepthFrame, opts: DepthOpts, ctx: DepthRunCtx): Promise<DepthMap> {
  ctx.checkAbort();
  const id = opts.model ?? DEPTH_DEFAULT_MODEL;
  const spec = DEPTH_MODEL_SPEC[id];
  const edge = spec.inputSize[0];

  const session = await loadSession(DEPTH_MODEL_FILES[id], (p) =>
    ctx.onProgress?.({ phase: 'download', loaded: p.loaded, total: p.total }));
  if (!session) throw new ModelNotInstalledError(id);
  ctx.checkAbort();
  ctx.onProgress?.({ phase: 'inference', fraction: 0 });

  const pre = preprocessDepth(frame, spec, opts);
  ctx.checkAbort();

  const ort = await loadOrt();
  const tensor = new ort.Tensor('float32', pre.input, [1, 3, edge, edge]);
  const result = await session.run({ [session.inputNames[0]!]: tensor });
  ctx.checkAbort();
  const out = result[session.outputNames[0]!]!;
  // getData() defends against a GPU-resident buffer (runModel's lesson in upscaler.ts).
  const raw = (typeof out.getData === 'function' ? await out.getData(false) : out.data) as unknown as Float32Array;
  ctx.onProgress?.({ phase: 'inference', fraction: 0.85 });

  const map = postprocessDepth(raw, pre);
  ctx.onProgress?.({ phase: 'inference', fraction: 1 });
  return map;
}

// ─── worker message protocol ─────────────────────────────────────────────────

/** Options that survive structured clone - no `signal`/`onProgress`. */
export type SerializableDepthOpts = Omit<DepthOpts, 'signal' | 'onProgress'>;

export type DepthWorkerRequest =
  | { id: number; type: 'run'; frame: DepthFrame; opts?: SerializableDepthOpts }
  | { id: number; type: 'cached'; model: DepthModelId }
  | { id: number; type: 'abort' };

export interface DepthWorkerReply {
  id: number;
  backend?: 'webgpu' | 'wasm';
  progress?: DepthProgress;
  /** Terminal - a run result (its buffer is transferred). */
  map?: DepthMap;
  /** Terminal - a cached() result. */
  cached?: boolean;
  /** Terminal - a real failure. */
  error?: string;
  /** Terminal - the run was aborted (the client rejects with AbortError). */
  aborted?: boolean;
}

const aborted = new Set<number>();
const inFlight = new Set<number>();

function checkAbort(id: number): void {
  if (aborted.has(id)) throw abortError();
}

/** Wire the protocol to a worker scope's postMessage/addEventListener. Called
 *  unconditionally below IN A WORKER; exported and guarded so importing this
 *  module in a test runner (no addEventListener) does not throw. */
export function installDepthWorker(scope: {
  postMessage: (msg: DepthWorkerReply, transfer?: Transferable[]) => void;
  addEventListener: (type: 'message', fn: (e: MessageEvent<DepthWorkerRequest>) => void) => void;
}): void {
  const post = scope.postMessage.bind(scope);
  scope.addEventListener('message', (e: MessageEvent<DepthWorkerRequest>) => {
    const msg = e.data;
    if (msg.type === 'abort') {
      if (inFlight.has(msg.id)) aborted.add(msg.id);
      return;
    }
    const { id } = msg;
    inFlight.add(id);
    void (async (): Promise<void> => {
      try {
        if (msg.type === 'cached') {
          post({ id, cached: await modelCached(msg.model), backend: currentBackend() ?? undefined });
        } else {
          const ctx: DepthRunCtx = {
            onProgress: (p) => post({ id, progress: p }),
            checkAbort: () => checkAbort(id),
          };
          const map = await runDepth(msg.frame, msg.opts ?? {}, ctx);
          post({ id, map, backend: currentBackend() ?? undefined }, [map.data.buffer]);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') post({ id, aborted: true });
        else post({ id, error: err instanceof Error ? err.message : String(err) });
      } finally {
        inFlight.delete(id);
        aborted.delete(id);
      }
    })();
  });
  // Warm the backend probe on spawn so the client can answer backend() early.
  void probeBackend().then((b) => post({ id: 0, backend: b ?? undefined }));
}

// Worker scope only. `window` has both methods too, so a bare typeof check would
// install a message listener on the page if anything ever imported this module on
// the main thread; a test runner has neither.
const scope = globalThis as unknown as Record<string, unknown>;
if (typeof scope.WorkerGlobalScope !== 'undefined' && typeof scope.document === 'undefined') {
  installDepthWorker(globalThis as unknown as Parameters<typeof installDepthWorker>[0]);
}
