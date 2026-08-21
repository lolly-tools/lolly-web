// SPDX-License-Identifier: MPL-2.0
/**
 * Main-thread facade over the AI-text detector worker (plans/126 WP-A) - the
 * views' one entry point to the local-model tier. Owns the worker lifecycle
 * (spawn on first use, terminate-then-drop on error, the reworder.ts idiom),
 * the status probe the consent UI needs, and the PURE eligibility gate.
 *
 * The gate mirrors the engine analyser's own bias guard, deliberately: the
 * detector is trained on English, and detector models are documented to score
 * high on non-native-English human prose - so short or non-Latin text is never
 * sent to the model at all. `null` from any path means "the check did not
 * run", which the views render as nothing: absence of the check must never
 * read as a verdict either way.
 */

import type { AiModelEstimate } from '@lolly/engine';
import {
  AI_DETECT_MODELS, AI_DETECT_STAGED, aiDetectModel, aiDetectCacheUrl, type AiDetectModel,
} from './ai-detect-models.ts';
import type { AiDetectWorkerReply, AiDetectWorkerRequest } from './ai-detect-worker.ts';

export type AiDetectStatus = 'unstaged' | 'need-download' | 'ready';

/** Minimum words before the model runs - the engine's stylometry floor is 25;
 *  the classifier needs more text than that to say anything defensible. */
const MIN_WORDS = 50;
/** Latin-letter share below which the text is not the model's language. */
const MIN_LATIN = 0.6;
/** The worker never sees more than this (the model truncates to its own token
 *  budget anyway; this just bounds the postMessage payload). */
const TEXT_CAP = 65536;

/** Pure: is this text one the detector may honestly be asked about? */
export function aiDetectEligible(text: string): boolean {
  const t = text.slice(0, TEXT_CAP);
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words < MIN_WORDS) return false;
  const letters = t.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return false;
  const latin = t.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return latin / letters >= MIN_LATIN;
}

/** Can this environment even try? (A staged model + Worker + wasm.) */
export function aiDetectAvailable(): boolean {
  return aiDetectModel() !== null && typeof WebAssembly !== 'undefined' && typeof Worker === 'function';
}

/** One-time download size of the active model, for the consent line. */
export function aiDetectModelBytes(): number {
  return aiDetectModel()?.bytes ?? 0;
}

/** Where the model tier stands for this session - drives the consent UI. */
export async function aiDetectStatus(): Promise<AiDetectStatus> {
  const m = aiDetectModel();
  if (!m || !aiDetectAvailable()) return 'unstaged';
  if (typeof caches === 'undefined') return 'need-download';
  try {
    const c = await caches.open('transformers-cache');
    return (await c.match(aiDetectCacheUrl(m))) !== undefined ? 'ready' : 'need-download';
  } catch {
    return 'need-download'; // Cache API visible but sealed - treat as cold
  }
}

interface Pending {
  resolve: (r: AiModelEstimate | null) => void;
  onProgress?: (fraction: number) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./ai-detect-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<AiDetectWorkerReply>): void => {
    const { id, progress, prob, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    if (progress) { p.onProgress?.(progress.fraction); return; }
    pending.delete(id);
    const m = aiDetectModel();
    if (error || typeof prob !== 'number' || !m) { p.resolve(null); return; }
    p.resolve({ probAi: prob, threshold: m.threshold, modelId: m.id, modelName: m.name });
  };
  worker.onerror = (): void => {
    for (const p of pending.values()) p.resolve(null);
    pending.clear();
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
    worker = null;
  };
  return worker;
}

/**
 * Score one text with the staged detector. Resolves the engine-shaped estimate
 * (`applyModelEstimate` folds it into a report), or null wherever the check
 * cannot or should not run. The FIRST call may download the model - callers
 * gate that behind explicit consent via `aiDetectStatus()`.
 */
export function scoreAiText(
  text: string,
  opts: { onProgress?: (fraction: number) => void } = {},
): Promise<AiModelEstimate | null> {
  const m = aiDetectModel();
  if (!m || !aiDetectAvailable() || !aiDetectEligible(text)) return Promise.resolve(null);
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<AiModelEstimate | null>((resolve) => {
    pending.set(id, { resolve, onProgress: opts.onProgress });
    w.postMessage({ id, type: 'score', text: text.slice(0, TEXT_CAP), model: m } satisfies AiDetectWorkerRequest);
  });
}

/** Tear the worker down - pending checks resolve null. */
export function disposeAiDetect(): void {
  for (const p of pending.values()) p.resolve(null);
  pending.clear();
  if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
  worker = null;
}

export { AI_DETECT_MODELS, AI_DETECT_STAGED };
