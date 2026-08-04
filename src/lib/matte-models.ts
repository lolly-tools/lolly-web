// SPDX-License-Identifier: MPL-2.0
/**
 * On-device background remover — the PURE catalogue half of `host.matte`
 * (v1.103), the structural twin of lib/upscale-models.ts.
 *
 * Constants only: the model list surfaced to the picker/consent UI, their
 * on-disk file names, the IndexedDB cache coordinates, the per-model TENSOR
 * DESCRIPTOR the runner needs, and a couple of lookup helpers. NO onnxruntime,
 * NO DOM, NO IndexedDB — safe to import from either the main thread
 * (bridge/matte.ts, for the synchronous models()/modelBytes()/isAvailable()
 * answers) or the worker (lib/matte-worker.ts → lib/matter.ts) without dragging
 * the multi-MB runtime into the boot budget.
 *
 * The file NAMES and cache coordinates below are a PINNED CONTRACT shared
 * verbatim with the model fetch script (scripts/fetch-matte-models.ts, Andy-run
 * — this repo never vendors the weights): the runner reads whatever that script
 * writes to `/models/matte/<file>` and caches in the 'matte-models' IndexedDB
 * store. Change a name here and you must change it there too, or a cache miss
 * goes silent.
 *
 * The tensor descriptors (MATTE_MODEL_SPEC) are NOT decoration: normalization
 * genuinely DIFFERS per model (IS-Net uses mean 0.5 / std 1.0; the others use
 * ImageNet), and the output activation differs too (min-max for the saliency
 * nets, sigmoid for BiRefNet's logit head). A wrong mean/std or activation does
 * not crash — it silently degrades the matte. Every value here is provisional
 * (research-sourced) and MUST be confirmed against the real ONNX graph before a
 * model is staged (see the human-verification gates in the fetch script header).
 */

import type { MatteModelId, MatteModelInfo } from '@lolly-tools/core/host-v1';

// ── Cache coordinates (shared with scripts/fetch-matte-models.ts) ────────────

/** IndexedDB object store holding the cached model bytes (see bridge/db.ts). */
export const MATTE_MODEL_STORE = 'matte-models';
/** URL directory under `/models/` the bytes are fetched from. */
export const MATTE_MODEL_DIR = 'matte';
/** Bump to invalidate every cached entry (a reconverted model, or a poisoned
 *  cache — the HTML-response guard in createModelFetcher). */
export const MATTE_MODEL_CACHE_VERSION = 1;

// ── Model files on disk (`/models/matte/<file>`) ─────────────────────────────

/** The weights file for each selectable model. */
export const MATTE_MODEL_FILES: Record<MatteModelId, string> = {
  'u2netp': 'u2netp.onnx',
  'isnet-general': 'isnet-general-use.onnx',
  'birefnet-lite': 'birefnet-lite.onnx',
};

/** The general model is the default when `opts.model` is omitted. */
export const MATTE_DEFAULT_MODEL: MatteModelId = 'isnet-general';

// ── The catalogue ────────────────────────────────────────────────────────────
//
// `approxBytes` is the one-time consent size the picker + offline manager show.
// The licence + attribution lines are a real obligation, not decoration — the
// shell carries them in its credits (a "Larger Work" under Apache-2.0 / MIT), and
// `version` lands verbatim in the C2PA edit step. Every size below is
// RESEARCH-SOURCED and LOW CONFIDENCE — the fetch script records the real byte
// length from the downloaded file and this must be reconciled before staging.

export const MATTE_MODELS: MatteModelInfo[] = [
  {
    id: 'u2netp',
    name: 'U²-Net lite (fast)',
    tier: 'fast',
    approxBytes: 5 * 1024 * 1024,
    license: 'Apache-2.0',
    attribution: 'U²-Net © 2020 Xuebin Qin et al. (Apache-2.0)',
    version: 'u2netp',
    note: 'Tiny and instant — soft edges. Good for a quick preview.',
  },
  {
    id: 'isnet-general',
    name: 'IS-Net general',
    tier: 'default',
    approxBytes: 172 * 1024 * 1024,
    license: 'Apache-2.0',
    attribution: 'DIS / IS-Net © 2022 Xuebin Qin et al. (Apache-2.0)',
    version: 'general-use',
    note: 'Clean general-purpose cutouts at 1024px. The default.',
  },
  {
    id: 'birefnet-lite',
    name: 'BiRefNet lite (pro edges)',
    tier: 'pro',
    approxBytes: 115 * 1024 * 1024,
    license: 'MIT',
    attribution: 'BiRefNet © 2024 Peng Zheng et al. (MIT)',
    version: 'lite',
    note: 'Best hair and fine detail — heavier.',
  },
];

/** Approximate one-time download per model, for the consent UI. Derived from
 *  MATTE_MODELS so the two never drift. */
export const MATTE_MODEL_BYTES: Record<MatteModelId, number> = MATTE_MODELS.reduce(
  (acc, m) => { acc[m.id] = m.approxBytes; return acc; },
  {} as Record<MatteModelId, number>,
);

// ── The per-model tensor descriptor (runner contract) ────────────────────────
//
// The runner is per-model parameterized on purpose: normalization + activation
// differ. All models: pixel/255 → (x − mean)/std, RGB, NCHW, single-channel mask
// out. `activation` decides how the mask is turned into 0..1 alpha:
//   'minmax'  — the head is already bounded (rembg saliency nets): (x−min)/(max−min).
//   'sigmoid' — the head is a logit (BiRefNet): 1/(1+e^-x), used directly.
// Getting these backwards (sigmoid on a bounded head, min-max on a logit) washes
// or over-contrasts the matte with NO crash — verify empirically before staging.

export interface MatteModelSpec {
  /** Fixed model input [height, width]; the source is letterbox-padded to it. */
  inputSize: [number, number];
  /** Per-channel mean subtracted after the /255 scale (RGB order). */
  mean: [number, number, number];
  /** Per-channel std divided after the mean subtraction (RGB order). */
  std: [number, number, number];
  /** How the single-channel output becomes 0..1 alpha. */
  activation: 'minmax' | 'sigmoid';
}

const IMAGENET_MEAN: [number, number, number] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [number, number, number] = [0.229, 0.224, 0.225];

export const MATTE_MODEL_SPEC: Record<MatteModelId, MatteModelSpec> = {
  'u2netp': {
    inputSize: [320, 320],
    mean: IMAGENET_MEAN,
    std: IMAGENET_STD,
    activation: 'minmax',
  },
  'isnet-general': {
    // The footgun: IS-Net general normalises to −0.5..+0.5, NOT ImageNet.
    inputSize: [1024, 1024],
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    activation: 'minmax',
  },
  'birefnet-lite': {
    inputSize: [1024, 1024],
    mean: IMAGENET_MEAN,
    std: IMAGENET_STD,
    activation: 'sigmoid',
  },
};

// ── Which weights are actually vendored in THIS build ────────────────────────
//
// A build fact, not a device fact (mirrors UPSCALE_STAGED): a model is offered
// only once scripts/fetch-matte-models.ts carries a REAL, verified pin for its
// weights AND the licence has been re-confirmed from a primary source. Until then
// offering it would promise a one-time download that can never complete. Model
// licensing is high-stakes and ships to every device, so the default is WITHHELD:
// flip a flag here in the SAME change that lands the verified pin.

/** True where the model's weights have a real, licence-verified pin. */
export const MATTE_STAGED: Record<MatteModelId, boolean> = {
  'u2netp': false,          // pending: verify Apache-2.0 provenance of the community ONNX + real pin
  'isnet-general': false,   // pending: verify DIS Apache-2.0 covers weights + real pin (fp16 must be produced)
  'birefnet-lite': false,   // pending: verify MIT + onnx-community tag + WebGPU op support (ort #21968)
};

/** The models actually runnable in this build — what the picker should OFFER.
 *  Unstaged models are withheld rather than shown as a download that can never
 *  complete (an honest-availability gate). CAN be empty today: no matte model is
 *  staged until its licence + pin are verified — the picker then reports the
 *  capability as unavailable, which is honest. */
export function stagedMatteModels(): MatteModelInfo[] {
  return MATTE_MODELS.filter((m) => MATTE_STAGED[m.id]);
}

/** The catalogue entry for an id, or undefined for an unknown one. Looks up the
 *  FULL catalogue (incl. unstaged) so an id round-trips even for a withheld model. */
export function matteModel(id: MatteModelId): MatteModelInfo | undefined {
  return MATTE_MODELS.find((m) => m.id === id);
}
