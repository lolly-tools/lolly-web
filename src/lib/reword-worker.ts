// SPDX-License-Identifier: MPL-2.0
/**
 * Reword worker (plans/127) - runs SmolLM2-360M-Instruct off-thread to propose
 * shorter, plainer rewrites of ONE sentence at a time. Everything heavy
 * (transformers.js, the ~370 MB q4 ONNX model) loads HERE, dynamically, so none
 * of it can reach the boot chunk. Same id-keyed pending-map protocol as the
 * speech workers, with per-request download/generation progress and a
 * cooperative abort checked between samples (a sample mid-inference cannot be
 * preempted in-wasm).
 *
 * SELF-HOSTED ONLY: the model is served same-origin from
 * /models/reword/smollm2-360m-instruct/ (staged by
 * scripts/fetch-reword-models.ts) on the onnxruntime-web build transformers.js
 * pins (/ort-hf/, scripts/copy-transformers-ort.ts). Remote models are disabled
 * outright, so no text or bytes ever leave the device
 * (lib/reword-privacy.test.ts pins these lines, like speech's).
 *
 * The worker returns RAW candidate strings. The engine's deterministic pipeline
 * (normalise → humanizeText → rewordGate) runs on the MAIN thread - the model
 * samples freely before the gate; the gate decides what a person ever sees.
 * The prompt itself is engine data (buildRewordMessages), so shells cannot
 * drift.
 *
 * Device: WebGPU when the worker has it, else wasm - same q4 file either way.
 * A WebGPU init failure falls back to wasm rather than failing the request.
 */

import { buildRewordMessages } from '@lolly/engine';
import {
  REWORD_MODEL_DIR, REWORD_MODEL_BYTES, REWORD_SAMPLES, REWORD_TEMPERATURE,
  REWORD_TOP_P, rewordMaxNewTokens,
} from './reword-models.ts';
import { ORT_HF_BASE } from './ort-hf-base.ts';

export interface RewordWorkerRequest {
  id: number;
  type: 'reword' | 'abort';
  sentence?: string;
  /** Candidates to sample (default REWORD_SAMPLES). */
  count?: number;
}

export interface RewordWorkerProgress {
  phase: 'download' | 'generate';
  fraction: number;
  loaded?: number;
  total?: number;
}

export interface RewordWorkerReply {
  id: number;
  progress?: RewordWorkerProgress;
  /** Raw model replies, in sample order - unfiltered; the engine gate judges. */
  result?: string[];
  error?: string;
}

// Worker scope: `postMessage` here is the DedicatedWorkerGlobalScope overload.
const post = postMessage as (message: unknown, transfer?: Transferable[]) => void;

/** Requests aborted from the main thread; the sample loop checks between samples. */
const aborted = new Set<number>();

// Minimal shapes for the transformers.js pieces we touch - its own typings are
// bundler-hostile generics, and the operations below are the whole surface.
interface TensorLike {
  dims: number[];
  slice(...args: unknown[]): TensorLike;
}
interface TokenizerLike {
  apply_chat_template(
    messages: Array<{ role: string; content: string }>,
    opts: { add_generation_prompt: boolean; return_dict: boolean },
  ): { input_ids: TensorLike; attention_mask: TensorLike };
  batch_decode(ids: TensorLike, opts: { skip_special_tokens: boolean }): string[];
}
interface ModelLike {
  generate(opts: Record<string, unknown>): Promise<TensorLike>;
}
interface RewordRuntime {
  model: ModelLike;
  tokenizer: TokenizerLike;
}

let runtime: Promise<RewordRuntime> | null = null;

/**
 * Load transformers.js + the model + tokenizer, once. Download progress is
 * attributed to the request that triggered the load; later requests find
 * everything resident and skip straight to generation.
 */
function ensureRuntime(id: number): Promise<RewordRuntime> {
  if (runtime) return runtime;
  runtime = (async (): Promise<RewordRuntime> => {
    const { env, AutoModelForCausalLM, AutoTokenizer } = await import('@huggingface/transformers');

    // Same-origin everything (see the module header) - the whole privacy story
    // rides on these three lines, and reword-privacy.test.ts pins them.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = '/models/';
    if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = ORT_HF_BASE;

    // One aggregate download meter across the model + tokenizer files.
    const loadedByFile = new Map<string, number>();
    const progressCallback = (p: { status?: string; file?: string; loaded?: number; total?: number }): void => {
      if (p.status !== 'progress' || !p.file || typeof p.loaded !== 'number') return;
      loadedByFile.set(p.file, p.loaded);
      let loaded = 0;
      for (const v of loadedByFile.values()) loaded += v;
      post({
        id,
        progress: { phase: 'download', loaded, total: REWORD_MODEL_BYTES, fraction: Math.min(1, loaded / REWORD_MODEL_BYTES) },
      } satisfies RewordWorkerReply);
    };

    // Deliberately wasm, NOT webgpu, for THIS model file: the q4 export's
    // MatMulNBits nodes have no WebGPU kernel in the pinned ORT build, so a
    // "webgpu" session runs every matmul on single-thread CPU per-node
    // fallback - measured ~380 s per span, on any machine. Multi-threaded
    // wasm (cross-origin isolation makes it real) measured ~10 s for load +
    // a sample. The WebGPU tier is the ~260 MB q4f16 export, staged
    // separately when taken up (plans/127 section 6).
    const [model, tokenizer] = await Promise.all([
      AutoModelForCausalLM.from_pretrained(REWORD_MODEL_DIR, { dtype: 'q4', device: 'wasm', progress_callback: progressCallback }),
      AutoTokenizer.from_pretrained(REWORD_MODEL_DIR, { progress_callback: progressCallback }),
    ]);
    return { model: model as ModelLike, tokenizer: tokenizer as TokenizerLike };
  })().catch((e) => { runtime = null; throw e; });
  return runtime;
}

async function reword(id: number, sentence: string, count: number): Promise<void> {
  const { model, tokenizer } = await ensureRuntime(id);
  const inputs = tokenizer.apply_chat_template(buildRewordMessages(sentence), {
    add_generation_prompt: true,
    return_dict: true,
  });
  const inputLen = inputs.input_ids.dims[1] ?? 0;
  const maxNew = rewordMaxNewTokens(inputLen);
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    if (aborted.has(id)) break;
    const output = await model.generate({
      ...inputs,
      max_new_tokens: maxNew,
      do_sample: true,
      temperature: REWORD_TEMPERATURE,
      top_p: REWORD_TOP_P,
    });
    const decoded = tokenizer.batch_decode(output.slice(null, [inputLen, null]), { skip_special_tokens: true });
    if (decoded[0]) out.push(decoded[0]);
    post({ id, progress: { phase: 'generate', fraction: (k + 1) / count } } satisfies RewordWorkerReply);
  }
  post({ id, result: out } satisfies RewordWorkerReply);
}

onmessage = (e: MessageEvent<RewordWorkerRequest>): void => {
  const { id, type, sentence, count } = e.data;
  if (type === 'abort') { aborted.add(id); return; }
  if (type !== 'reword' || typeof sentence !== 'string' || !sentence.trim()) {
    post({ id, error: 'nothing to reword' } satisfies RewordWorkerReply);
    return;
  }
  reword(id, sentence, Math.max(1, Math.min(6, count ?? REWORD_SAMPLES)))
    .catch((err) => { post({ id, error: err instanceof Error ? err.message : String(err) } satisfies RewordWorkerReply); })
    .finally(() => { aborted.delete(id); });
};
