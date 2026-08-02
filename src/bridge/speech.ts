// SPDX-License-Identifier: MPL-2.0
/**
 * Web implementation of `host.speech` (v1.96) — on-device Kokoro text-to-speech
 * with word timings for captions.
 *
 * The division of labour mirrors `host.audio`: this file is only the worker
 * plumbing (id-keyed pending map, progress fan-out, abort). The synthesis
 * itself — transformers.js, the eSpeak phonemizer and the ~92 MB q8 ONNX model
 * — lives entirely inside lib/speech-kokoro-worker.ts so none of it can block
 * the thread a tool is being typed into, and the pure bookkeeping (sentence
 * split, word spans, PCM concat) is lib/speech-kokoro.ts, tested in Node.
 *
 * Everything is same-origin and on-device: the model is served from
 * /models/kokoro/ (staged once by Andy via scripts/fetch-kokoro-models.ts) with
 * remote models disabled, so the text never leaves the machine. `cached()`
 * probes the Cache API bucket transformers.js writes ('transformers-cache',
 * keyed by the local model path) WITHOUT fetching — that is the load-bearing
 * part of the consent story: a tool can tell "instant" from "one-time ~93 MB
 * download" before any bytes move.
 */
import type {
  SpeechAPI, SpeechProgress, SpeechResult, SpeechSynthesizeOpts, SpeechVoiceInfo,
} from '@lolly-tools/core/host-v1';
import { KOKORO_MODEL_BYTES, KOKORO_MODEL_ID, KOKORO_VOICES, MAX_INPUT_CHARS } from '../lib/speech-kokoro.ts';
import type { SpeechWorkerReply, SpeechWorkerRequest } from '../lib/speech-kokoro-worker.ts';

/** The cache key transformers.js stores the model under (utils/hub.js: the
 *  resolved local path, relative to origin). Probed by cached(), never fetched. */
const MODEL_CACHE_URL = `/models/${KOKORO_MODEL_ID}/onnx/model_quantized.onnx`;

interface Pending {
  resolve: (r: SpeechResult) => void;
  reject: (e: unknown) => void;
  onProgress?: (p: SpeechProgress) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../lib/speech-kokoro-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<SpeechWorkerReply>): void => {
    const { id, progress, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return; // late reply for an aborted request — already rejected
    if (progress) { p.onProgress?.(progress); return; }
    pending.delete(id);
    if (error || !result) p.reject(new Error(error ?? 'speech synthesis failed'));
    else p.resolve(result);
  };
  worker.onerror = (): void => {
    for (const p of pending.values()) p.reject(new Error('speech worker error'));
    pending.clear();
    // Terminate, then drop, the dead worker so the next synthesize() spawns a
    // fresh one — detaching alone would leak the broken thread (and whatever
    // slice of the ~92 MB session it managed to load).
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
    worker = null;
  };
  return worker;
}

export function createSpeechAPI(): SpeechAPI {
  return {
    isAvailable(): boolean {
      // Wasm for the model + a worker to run it off-thread. The Worker check is
      // also what answers `false` under jsdom (the CLI omits host.speech for now).
      return typeof WebAssembly !== 'undefined' && typeof Worker === 'function';
    },

    async cached(): Promise<boolean> {
      if (typeof caches === 'undefined') return false;
      try {
        const c = await caches.open('transformers-cache');
        return (await c.match(MODEL_CACHE_URL)) !== undefined;
      } catch {
        return false; // Cache API visible but sealed (incognito iframe) — treat as cold
      }
    },

    modelBytes(): number {
      return KOKORO_MODEL_BYTES;
    },

    async voices(): Promise<SpeechVoiceInfo[]> {
      // Static curation (scripts/fetch-kokoro-models.ts stages exactly these);
      // copies so a caller mutating the list cannot corrupt the source of truth.
      return KOKORO_VOICES.map((v) => ({ ...v }));
    },

    synthesize(text: string, opts: SpeechSynthesizeOpts = {}): Promise<SpeechResult> {
      const { signal } = opts;
      if (signal?.aborted) return Promise.reject(abortError());
      // Hard bound (well above the UI's soft nudge) — reject BEFORE the text
      // crosses to the worker; the worker re-checks as defence in depth.
      if (text.length > MAX_INPUT_CHARS) {
        return Promise.reject(new Error(
          `speech input too long: ${text.length} chars (max ${MAX_INPUT_CHARS}) — split the text and synthesize in parts`,
        ));
      }
      const w = ensureWorker();
      const id = ++seq;
      return new Promise<SpeechResult>((resolve, reject) => {
        const onAbort = (): void => {
          // Reject NOW and tell the worker, which stops at the next sentence
          // boundary (a sentence mid-inference cannot be preempted in-wasm) —
          // its late reply then finds no pending entry and is dropped.
          if (!pending.has(id)) return;
          pending.delete(id);
          w.postMessage({ id, type: 'abort' } satisfies SpeechWorkerRequest);
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, {
          resolve: (r) => { signal?.removeEventListener('abort', onAbort); resolve(r); },
          reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
          onProgress: opts.onProgress,
        });
        w.postMessage({
          id, type: 'synthesize', text, voice: opts.voice, speed: opts.speed,
        } satisfies SpeechWorkerRequest);
      });
    },
  };
}

function abortError(): Error {
  // DOMException where the platform provides it, so `err.name === 'AbortError'`
  // works the same as for an aborted fetch.
  return typeof DOMException !== 'undefined'
    ? new DOMException('speech synthesis aborted', 'AbortError')
    : Object.assign(new Error('speech synthesis aborted'), { name: 'AbortError' });
}
