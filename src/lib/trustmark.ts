// SPDX-License-Identifier: MPL-2.0
/**
 * TrustMark deep scan — the neural half of Adobe TrustMark watermark
 * detection (see engine/src/trustmark.ts for the pure BCH/ECC half, which
 * this module hands its raw output to). LAZY BY DESIGN: this file must only
 * ever be reached via a dynamic `import('./trustmark.ts')` from the /verify
 * "Deep scan for watermarks" click handler (shells/web/src/views/valid.ts) —
 * never a static import anywhere else. That's what keeps onnxruntime-web
 * (a multi-MB dependency before it's even fetched a model) and the tens-of-
 * MB ONNX decoder models entirely out of the boot/preload budget; importing
 * this module eagerly would defeat the whole point of "deep scan" being an
 * opt-in, user-invoked action (see plans/watermark-detectors.md).
 *
 * Model bytes are fetched from same-origin `/models/trustmark/<file>.onnx`
 * (see the download instructions in scripts/fetch-trustmark-models.ts — this
 * repo never vendors them; Andy runs that script locally) and cached in
 * IndexedDB — the exact "touch the network exactly once, then serve from
 * on-device storage forever" pattern lib/google-fonts.ts + user-fonts.ts use
 * for font files, applied to a much larger binary. The service worker
 * explicitly bypasses `/models/` (see public/sw.js) so there is only ONE
 * on-device copy of the bytes, not a duplicate in the SW's Cache Storage.
 *
 * ── Honesty ledger — READ BEFORE TRUSTING A DETECTION ────────────────────
 * What IS verified (see tests/trustmark.test.ts): the BCH/ECC math this
 * module hands raw model output to (engine/src/trustmark.ts) is cross-checked
 * bit-for-bit against Adobe's own unmodified reference implementation — a
 * decoded, ECC-valid payload really is a real detection, not a guess.
 *
 * What is UNVERIFIED (nothing in this file has ever been run): the ONNX
 * model fetch, onnxruntime-web session creation, the WebGPU/wasm execution
 * providers, and — the highest-risk piece — `resizeToModelInput`'s
 * canvas-based crop/resize. Adobe's own reference (js/tm_watermark.js) does
 * this resize via a DEDICATED antialiased resizer ONNX model
 * (`resizer.onnx`, run through onnxruntime); this module uses a plain
 * <canvas> `drawImage` instead (documented deviation — porting a SECOND
 * neural model felt like the wrong tradeoff for a first cut). Canvas 2D
 * downscaling quality is browser-dependent and not guaranteed pixel-
 * equivalent to Adobe's resizer, and TrustMark's decoder was trained against
 * ITS OWN resize path — a quality mismatch here could suppress real
 * detections (false negatives) even though it cannot fabricate a false
 * positive (the BCH check downstream still has to pass). This needs
 * real-image, real-browser testing against Adobe's own `images/` sample set
 * before this pip should be trusted operationally. See the PR/commit
 * description for the full pending list.
 *
 * Every failure mode here — missing models, a WASM/WebGPU init failure, an
 * insecure context, a malformed image — resolves to `{ present: false }` and
 * NEVER throws: a failed deep scan must look identical to "nothing found",
 * never surface as an error the user has to parse, and (per the hard
 * project rule) absence is NEVER shown as a verdict either way.
 */

import { decodeTrustmarkPayload, TRUSTMARK_PAYLOAD_BITS } from '@lolly/engine';
import { openDB } from '../bridge/db.ts';

/** One of TrustMark's two published decoder variants (js/tm_watermark.js's
 *  `modelConfigs`) — Q first (matches upstream's own ordering; the search
 *  stops at the first schema-valid decode). */
interface TrustmarkModelConfig {
  variantCode: 'Q' | 'P';
  fileName: string;
  resolution: number;
  squareCrop: boolean;
}
const MODEL_CONFIGS: TrustmarkModelConfig[] = [
  { variantCode: 'Q', fileName: 'decoder_Q.onnx', resolution: 256, squareCrop: false },
  { variantCode: 'P', fileName: 'decoder_P.onnx', resolution: 224, squareCrop: true },
];

/** Bump when the vendored .onnx files are replaced with a different release
 *  (e.g. Adobe ships a retrained decoder) — invalidates the IndexedDB cache
 *  so stale model bytes are never reused. */
const MODEL_CACHE_VERSION = 1;

export interface TrustmarkDetection {
  /** True ONLY on a real, ECC-validated decode. Never a verdict of absence —
   *  callers must not render `present: false` as "no watermark found". */
  present: boolean;
  /** Lowercase hex of the recovered, error-corrected payload bits. */
  payloadHex?: string;
  /** The BCH schema that validated (e.g. 'BCH_5') — informational. */
  schema?: string;
  /** Which decoder model produced the hit ('Q' or 'P' — see MODEL_CONFIGS). */
  variant?: 'Q' | 'P';
}

// ── Model bytes: fetch-once, IndexedDB-forever (mirrors lib/google-fonts.ts) ──

interface CachedModel { bytes: ArrayBuffer; version: number; cachedAt: number }

async function fetchModelBytes(fileName: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    const cached = await db.get('trustmark-models', fileName) as CachedModel | undefined;
    if (cached && cached.version === MODEL_CACHE_VERSION && cached.bytes?.byteLength) {
      return cached.bytes;
    }
  } catch {
    // IDB unavailable — fall through to a network-only (uncached) fetch below.
  }

  let resp: Response;
  try {
    resp = await fetch(`/models/trustmark/${fileName}`);
  } catch {
    return null; // offline, or the dev server has nothing mounted at /models/
  }
  // Not vendored yet (Andy hasn't run scripts/fetch-trustmark-models.ts) —
  // a plain 404, never an error surfaced to the user.
  if (!resp.ok) return null;
  const bytes = await resp.arrayBuffer();

  try {
    const db = await openDB();
    await db.put('trustmark-models', { bytes, version: MODEL_CACHE_VERSION, cachedAt: Date.now() }, fileName);
  } catch {
    // Best-effort cache write — a failed put just means re-fetching next time.
  }
  return bytes;
}

// ── onnxruntime-web: lazy import, one session per model, memoised ───────────

type OrtModule = typeof import('onnxruntime-web');
type InferenceSession = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;

let ortPromise: Promise<OrtModule> | null = null;
async function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web').then((ort) => {
      // Same-origin WASM runtime binaries — see shells/web/public/ort/ (Andy
      // must populate this once from node_modules/onnxruntime-web/dist/*.{wasm,mjs}
      // after `npm install`; documented in scripts/fetch-trustmark-models.ts).
      // NEVER point this at a CDN: offline-first is a hard project rule, and a
      // page-context fetch to a third-party origin is exactly what this app's
      // CSP and the service worker's same-origin posture are built to refuse.
      ort.env.wasm.wasmPaths = '/ort/';
      return ort;
    });
  }
  return ortPromise;
}

const sessionCache = new Map<string, Promise<InferenceSession | null>>();
function getSession(ort: OrtModule, config: TrustmarkModelConfig): Promise<InferenceSession | null> {
  let pending = sessionCache.get(config.fileName);
  if (!pending) {
    pending = (async () => {
      try {
        const bytes = await fetchModelBytes(config.fileName);
        if (!bytes) return null;
        // Prefer WebGPU (matches Adobe's own reference); onnxruntime-web tries
        // providers in order and falls back automatically if webgpu can't
        // initialize (no adapter, insecure context, unsupported browser).
        return await ort.InferenceSession.create(new Uint8Array(bytes), {
          executionProviders: ['webgpu', 'wasm'],
        });
      } catch (err) {
        console.warn(`[trustmark] could not load ${config.fileName}`, err);
        return null;
      }
    })();
    sessionCache.set(config.fileName, pending);
  }
  return pending;
}

// ── Pixel preprocessing: crop-to-square (when needed) + resize to the model's
// input, mirroring js/tm_watermark.js's runResizeModelSquare — via a plain
// <canvas> instead of Adobe's dedicated resizer.onnx model (see the module
// header's honesty ledger for why this is the biggest unverified risk here).

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** RGBA pixels (already decoded — the caller owns getting there, e.g. via
 *  createImageBitmap + canvas getImageData, same as valid.ts's existing
 *  Lolly-Imprint pixel decode) → a [1,3,size,size] CHW float32 tensor. */
function rgbaToModelTensor(
  rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, config: TrustmarkModelConfig,
): Float32Array {
  const src = makeCanvas(width, height);
  const sctx = src.getContext('2d') as CanvasRenderingContext2D;
  // Always copy into a fresh, plain-ArrayBuffer-backed Uint8ClampedArray: the
  // ImageData constructor rejects a view over a SharedArrayBuffer, which
  // `rgba`'s declared type doesn't rule out.
  const clamped = new Uint8ClampedArray(rgba.length);
  clamped.set(rgba);
  sctx.putImageData(new ImageData(clamped, width, height), 0, 0);

  // Mirrors runResizeModelSquare's crop rule: only crop when the aspect ratio
  // is extreme (>2 or <0.5) or the variant demands a square input (P); a
  // moderate aspect ratio is left uncropped and gets anisotropically resized
  // straight to size×size by the drawImage call below (matches upstream).
  const aspectRatio = width / height;
  const landscape = aspectRatio >= 1;
  let cropX = 0, cropY = 0, cropW = width, cropH = height;
  if (landscape && (aspectRatio > 2 || config.squareCrop)) {
    cropW = height;
    cropX = Math.floor((width - cropW) / 2);
  } else if (!landscape && (aspectRatio < 0.5 || config.squareCrop)) {
    cropH = width;
    cropY = Math.floor((height - cropH) / 2);
  }

  const size = config.resolution;
  const dst = makeCanvas(size, size);
  const dctx = dst.getContext('2d') as CanvasRenderingContext2D;
  dctx.drawImage(src as CanvasImageSource, cropX, cropY, cropW, cropH, 0, 0, size, size);
  const { data } = dctx.getImageData(0, 0, size, size);

  // NCHW [1,3,size,size], channels normalized to [0,1] — matches
  // loadImageAsTensor in js/tm_watermark.js exactly (R plane, G plane, B
  // plane; alpha dropped).
  const total = size * size;
  const tensor = new Float32Array(total * 3);
  const page = total, twopage = 2 * total;
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    tensor[i] = data[idx]! / 255;
    tensor[i + page] = data[idx + 1]! / 255;
    tensor[i + twopage] = data[idx + 2]! / 255;
  }
  return tensor;
}

/** Runs one decoder session and returns its 100-bit boolean output as 0/1s,
 *  or null if the run didn't produce a usable output. `results.output` is
 *  the tensor name in Adobe's published ONNX graphs; the first tensor in the
 *  result map is a defensive fallback in case a vendored model names it
 *  differently (unverified — see module header). */
async function runInference(
  ort: OrtModule, session: InferenceSession, tensorData: Float32Array, size: number,
): Promise<number[] | null> {
  const tensor = new ort.Tensor('float32', tensorData, [1, 3, size, size]);
  const results = await session.run({ image: tensor });
  const out = results.output ?? results[Object.keys(results)[0] ?? ''];
  const raw = out?.data as ArrayLike<number> | undefined;
  if (!raw || raw.length !== TRUSTMARK_PAYLOAD_BITS) return null;
  return Array.from(raw, (v) => (v >= 0 ? 1 : 0));
}

/**
 * Runs a TrustMark deep scan on already-decoded RGBA pixels. Tries each
 * model variant (Q, then P) and returns the first ECC-valid decode; `{
 * present: false }` when no model is available, inference fails, or neither
 * variant's output passes the BCH check — see this module's header for
 * exactly what that guarantees and what remains unverified. NEVER throws.
 */
export async function detectTrustmark(
  rgba: Uint8ClampedArray | Uint8Array, width: number, height: number,
): Promise<TrustmarkDetection> {
  try {
    if (width < 8 || height < 8) return { present: false };
    const ort = await loadOrt();
    for (const config of MODEL_CONFIGS) {
      const session = await getSession(ort, config);
      if (!session) continue; // this variant's model isn't vendored/loadable — try the next
      const tensorData = rgbaToModelTensor(rgba, width, height, config);
      const bits = await runInference(ort, session, tensorData, config.resolution);
      if (!bits) continue;
      const decoded = decodeTrustmarkPayload(bits);
      if (decoded.valid) {
        return { present: true, payloadHex: decoded.payloadHex, schema: decoded.schema, variant: config.variantCode };
      }
    }
    return { present: false };
  } catch (err) {
    console.warn('[trustmark] deep scan failed', err);
    return { present: false };
  }
}
