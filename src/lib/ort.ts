// SPDX-License-Identifier: MPL-2.0
// ─── Shared onnxruntime-web loader (deep-scan watermark detectors) ────────────
//
// ONE onnxruntime-web module + ONE wasm init, shared by every deep-scan detector
// (lib/trustmark.ts, lib/contentseal.ts). This exists because those detectors
// used to each `import('onnxruntime-web')` and configure it independently, and
// when /verify ran them together the two first `InferenceSession.create()` calls
// raced ORT's one-time `initWasm()` → "multiple calls to 'initWasm()' detected"
// and every session failed. A single memoised module + a single init mutex makes
// that race impossible no matter how many detectors run concurrently.
//
// Config choices, all deliberate:
//  - `wasmPaths = '/ort/'` — the WASM runtime is served SAME-ORIGIN from
//    shells/web/public/ort/ (populated once at setup from
//    node_modules/onnxruntime-web/dist/*.{wasm,mjs}). NEVER a CDN: offline-first
//    is a hard project rule and the CSP + service worker refuse cross-origin.
//  - `numThreads = 1`, `proxy = false` — single-threaded, no worker proxy.
//    Threaded ORT needs cross-origin isolation (COOP/COEP) we don't set, and the
//    worker proxy pulls in yet another dynamically-imported .mjs; a deep scan is
//    a one-shot user action where simplicity beats the marginal speed.
//
// The detectors pass `executionProviders: ['wasm']` (not webgpu): the WebGPU
// (jsep) build needs a GPU adapter AND its own `*.jsep.mjs` glue, more surface
// for no benefit on a one-off scan. Re-add 'webgpu' once the wasm path is proven.

type OrtModule = typeof import('onnxruntime-web');

let ortPromise: Promise<OrtModule> | null = null;

// ─── Streamed fetch progress (deep-scan model downloads) ──────────────────────
//
// Both detectors fetch same-origin .onnx files tens of MB in size. This reads a
// Response's body via its stream reader instead of the one-shot
// `resp.arrayBuffer()`, reporting {loaded,total} as chunks arrive so the /verify
// banner (views/valid.ts's enableDeepScan) can show a real download bar instead
// of a static "downloading…" string. `total` is the Content-Length header when
// present and parseable, else null — an INDETERMINATE download (chunked
// transfer, or a proxy that strips the header), never a guessed number.
//
// Caveat: if these files were ever served content-encoded (gzip/br), the header
// reflects the on-wire (compressed) size while the reader yields decoded bytes,
// so `loaded` could transiently exceed `total`. Callers must clamp any
// percentage they render — `total` is a best-effort denominator, not a hard cap.
export interface FetchProgress { loaded: number; total: number | null }

/** Reads `resp`'s body to a single ArrayBuffer, calling `onProgress` after each
 *  chunk. Falls back to a plain `resp.arrayBuffer()` (no progress) when the body
 *  isn't a readable stream — e.g. an older browser, or a response already
 *  consumed — so callers always get the same bytes either way. */
export async function readResponseWithProgress(
  resp: Response, onProgress?: (p: FetchProgress) => void,
): Promise<ArrayBuffer> {
  const reader = resp.body?.getReader();
  if (!reader) return resp.arrayBuffer();
  const totalHeader = Number(resp.headers.get('content-length'));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.byteLength) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

/** Lazily import + configure onnxruntime-web exactly once. Every caller shares
 *  the same module instance and the same one-time wasm setup. */
export function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web').then((ort) => {
      ort.env.wasm.wasmPaths = '/ort/';
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      return ort;
    });
  }
  return ortPromise;
}

// Serialises the FIRST session creation across all detectors. ORT's initWasm
// runs on the first `InferenceSession.create()`; two concurrent first-creates
// trip the "multiple calls" error. Every detector wraps its create() in this so
// only one create is ever in flight at a time (cheap — deep scan is one-shot).
let sessionGate: Promise<unknown> = Promise.resolve();
export function serializeSessionCreate<T>(create: () => Promise<T>): Promise<T> {
  const run = sessionGate.then(create, create);
  // Keep the chain alive regardless of this create's outcome.
  sessionGate = run.then(() => undefined, () => undefined);
  return run;
}
