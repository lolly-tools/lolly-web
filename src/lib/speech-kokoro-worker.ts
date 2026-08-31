// SPDX-License-Identifier: MPL-2.0
/**
 * Kokoro speech-synthesis worker. An 82M-parameter model spending seconds per
 * sentence is real work - it would otherwise freeze the tool being typed into
 * - and everything it needs (transformers.js, the eSpeak phonemizer wasm, the
 * ~92 MB q8 ONNX model) loads HERE, dynamically, so none of it can reach the
 * boot chunk. Same id-keyed pending-map protocol as lib/audio-analyse-worker.ts,
 * plus per-request progress messages and a cooperative abort (checked between
 * sentences - a sentence mid-inference cannot be preempted in-wasm).
 *
 * SELF-HOSTED ONLY: the model is served same-origin from /models/kokoro/
 * (staged by scripts/fetch-kokoro-models.ts) and runs on the onnxruntime-web
 * build transformers.js pins, served from /ort-hf/ (scripts/
 * copy-transformers-ort.ts) - never the /ort/ 1.27 runtime, which is a
 * different, incompatible build. Remote models are disabled outright, so no
 * text or bytes can ever leave the device. transformers.js caches the model
 * fetches in the Cache API bucket 'transformers-cache' (verified in its
 * utils/hub.js - local-path fetches are cached under their path key), which is
 * what makes synthesis offline after first use and what bridge/speech.ts's
 * cached() probes; the voice matrices we fetch ourselves get the same
 * treatment in a 'lolly-speech' bucket.
 *
 * Synthesis is per SENTENCE, sequentially (a sentence whose PHONEMES overrun
 * the model's 510-token budget synthesizes as several word-aligned chunks - 
 * chunkByPhonemeLength): it bounds model input length, gives honest progress,
 * and lets abort land between sentences. Word
 * timings come from the TIMESTAMPED model export's extra `durations` output
 * (one frame count per input token) - see lib/speech-kokoro.ts for the span
 * bookkeeping and why each word is phonemized separately.
 */

import type { SpeechProgress, SpeechResult, SpeechWordTiming } from '@lolly-tools/core/host-v1';
import {
  KOKORO_MODEL_ID, KOKORO_SAMPLE_RATE, KOKORO_STYLE_DIM, KOKORO_MODEL_BYTES,
  KOKORO_VOICES, KOKORO_VOICE_BYTES, KOKORO_DEFAULT_VOICE, SENTENCE_GAP_S,
  MAX_INPUT_CHARS, splitSentences, splitWords, phonemeTokenSpans,
  wordTimingsFromDurations, concatClips, normalizeText, phonemizeChunk,
  chunkByPhonemeLength,
} from './speech-kokoro.ts';
import type { EspeakFn, SentenceClip } from './speech-kokoro.ts';
import { ORT_HF_BASE } from './ort-hf-base.ts';
import { MODELS_BASE } from './models-base.ts';

export interface SpeechWorkerRequest {
  id: number;
  type: 'synthesize' | 'abort';
  text?: string;
  voice?: string;
  speed?: number;
}

export interface SpeechWorkerReply {
  id: number;
  progress?: SpeechProgress;
  result?: SpeechResult;
  error?: string;
}

// Worker scope: `postMessage` here is the DedicatedWorkerGlobalScope overload
// (message, transfer), not Window's (message, targetOrigin, transfer).
const post = postMessage as (message: unknown, transfer?: Transferable[]) => void;

/** Requests aborted from the main thread; the synthesis loop checks between sentences. */
const aborted = new Set<number>();

// Minimal shapes for the transformers.js pieces we touch - its own typings are
// bundler-hostile generics, and the four operations below are the whole surface.
interface TensorLike { data: ArrayLike<number | bigint>; dims: number[] }
type TensorCtor = new (type: string, data: Float32Array | number[], dims: number[]) => unknown;
interface KokoroRuntime {
  model: (inputs: Record<string, unknown>) => Promise<{ waveform: TensorLike; durations?: TensorLike }>;
  tokenizer: (text: string, opts: { truncation: boolean }) => { input_ids: TensorLike };
  Tensor: TensorCtor;
  espeak: EspeakFn;
}

let runtime: Promise<KokoroRuntime> | null = null;

/**
 * Load transformers.js + the model + tokenizer + phonemizer, once. Download
 * progress is attributed to the request that triggered the load (`id`) - later
 * requests find everything resident and skip straight to synthesis.
 */
function ensureRuntime(id: number): Promise<KokoroRuntime> {
  if (runtime) return runtime;
  runtime = (async (): Promise<KokoroRuntime> => {
    const { env, AutoTokenizer, StyleTextToSpeech2Model, Tensor } = await import('@huggingface/transformers');

    // Model weights load from `${MODELS_BASE}/models/`. On the web build MODELS_BASE
    // is '' → '/models/' (same-origin, byte-identical to before); the desktop shell
    // bakes VITE_MODELS_BASE=https://lolli.li so it pulls the weights from there
    // once, caches them (transformers.js Cache API), then runs offline. The privacy
    // story is unchanged: allowRemoteModels stays false, so nothing hits the HF hub
    // and no audio ever leaves the device - the only fetch is the static model file,
    // exactly as in the same-origin case.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = `${MODELS_BASE}/models/`;
    if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = ORT_HF_BASE;

    // One aggregate download meter across the model + tokenizer files. The
    // voice matrix is fetched separately by getVoiceData and never reports
    // here, so its bytes come OFF the denominator - counting them would leave
    // the bar stuck short of 100% forever. modelBytes() keeps the full sum:
    // the consent size stays honest, only the meter's total shrinks.
    const meterTotal = KOKORO_MODEL_BYTES - KOKORO_VOICE_BYTES;
    const loadedByFile = new Map<string, number>();
    const progressCallback = (p: { status?: string; file?: string; loaded?: number; total?: number }): void => {
      if (p.status !== 'progress' || !p.file || typeof p.loaded !== 'number') return;
      loadedByFile.set(p.file, p.loaded);
      let loaded = 0;
      for (const v of loadedByFile.values()) loaded += v;
      post({ id, progress: { phase: 'download', loaded, total: meterTotal, fraction: Math.min(1, loaded / meterTotal) } } satisfies SpeechWorkerReply);
    };

    const [model, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback: progressCallback }),
      AutoTokenizer.from_pretrained(KOKORO_MODEL_ID, { progress_callback: progressCallback }),
    ]);
    const { phonemize } = await import('phonemizer');
    return {
      model: model as unknown as KokoroRuntime['model'],
      tokenizer: tokenizer as unknown as KokoroRuntime['tokenizer'],
      Tensor: Tensor as unknown as TensorCtor,
      espeak: phonemize as EspeakFn,
    };
  })().catch((e) => { runtime = null; throw e; });
  return runtime;
}

/** Voice style matrices (510x256 f32), fetched once and kept - in memory and in the Cache API. */
const voiceCache = new Map<string, Float32Array>();

async function getVoiceData(voice: string): Promise<Float32Array> {
  const hit = voiceCache.get(voice);
  if (hit) return hit;
  const url = `${MODELS_BASE}/models/kokoro/voices/${voice}.bin`;
  let resp: Response | undefined;
  try {
    const c = await caches.open('lolly-speech');
    resp = await c.match(url);
    if (!resp) {
      resp = await fetch(url);
      if (resp.ok) await c.put(url, resp.clone());
    }
  } catch {
    // Cache API unavailable (e.g. some incognito iframes) - plain fetch below.
  }
  if (!resp) resp = await fetch(url);
  if (!resp.ok) throw new Error(`voice fetch failed: ${resp.status} for ${url} - run scripts/fetch-kokoro-models.ts`);
  const data = new Float32Array(await resp.arrayBuffer());
  if (data.byteLength !== KOKORO_VOICE_BYTES) {
    console.warn(`[speech] voice ${voice} is ${data.byteLength} bytes, expected ${KOKORO_VOICE_BYTES}`);
  }
  voiceCache.set(voice, data);
  return data;
}

async function synthesize(id: number, text: string, voiceId: string, speed: number): Promise<SpeechResult> {
  if (!KOKORO_VOICES.some((v) => v.id === voiceId)) {
    throw new Error(`unknown voice "${voiceId}" - one of: ${KOKORO_VOICES.map((v) => v.id).join(', ')}`);
  }
  // Defence in depth - bridge/speech.ts already rejects before posting.
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(`speech input too long: ${text.length} chars (max ${MAX_INPUT_CHARS}) - split the text and synthesize in parts`);
  }
  const { model, tokenizer, Tensor, espeak } = await ensureRuntime(id);
  const voiceData = await getVoiceData(voiceId);
  // Voice id prefix encodes the accent: a* = en-US, b* = en-GB (kokoro.js does the same).
  const language: 'a' | 'b' = voiceId.startsWith('b') ? 'b' : 'a';

  // Normalize the WHOLE input first, THEN split - kokoro.js's order, and it
  // matters both ways: 'Dr.(?= [A-Z])' needs the following word to expand, and
  // '3.5' must become '3 point 5' before the splitter can mistake its dot for
  // a sentence terminator.
  const sentences = splitSentences(normalizeText(text));
  interface Piece { pcm: Float32Array; sentence: string; wordEntries: SpeechWordTiming[] | null }
  const pieces: Piece[] = [];

  for (let i = 0; i < sentences.length; i++) {
    if (aborted.has(id)) throw new Error('speech synthesis aborted');
    const sentence = sentences[i] as string;

    // Phonemize per WORD (already normalized above), then join with single
    // spaces - that joined string IS the model input, so each word's token
    // span is known by construction. Sequential on purpose: one eSpeak wasm
    // instance, and reentrancy buys nothing against a model that dwarfs it.
    const words = splitWords(sentence);
    const wordPhonemes: string[] = [];
    for (const w of words) wordPhonemes.push(await phonemizeChunk(espeak, w, language));

    // The raw 400-char wrap in splitSentences is only a cheap pre-pass;
    // normalization can expand text severalfold, so the binding budget check
    // is HERE, on the phonemes the model consumes. Each chunk synthesizes as
    // its own piece - spans/timings hold per chunk by construction - instead
    // of letting the tokenizer truncate silently and drop trailing words.
    for (const chunk of chunkByPhonemeLength(words, wordPhonemes)) {
      if (aborted.has(id)) throw new Error('speech synthesis aborted');
      const phonemes = chunk.phonemes.join(' ');

      const { input_ids } = tokenizer(phonemes, { truncation: true });
      const seqLen = input_ids.dims[input_ids.dims.length - 1] ?? 0;
      // Style row is indexed by token count - the model was trained with a
      // per-length style lookup (rows 0..509).
      const numTokens = Math.min(Math.max(seqLen - 2, 0), 509);
      const style = voiceData.slice(numTokens * KOKORO_STYLE_DIM, (numTokens + 1) * KOKORO_STYLE_DIM);

      const outputs = await model({
        input_ids,
        style: new Tensor('float32', style, [1, KOKORO_STYLE_DIM]),
        speed: new Tensor('float32', [speed], [1]),
      });
      const wave = outputs.waveform.data as Float32Array;

      // Word alignment holds only when the char-level tokenizer invariant does
      // (one token per phoneme char + BOS/EOS, nothing truncated) AND the
      // timestamped export's durations output is present and one-per-token.
      let wordEntries: SpeechWordTiming[] | null = null;
      if (outputs.durations && seqLen === phonemes.length + 2) {
        const spans = phonemeTokenSpans(chunk.phonemes);
        const times = wordTimingsFromDurations(outputs.durations.data, spans, wave.length, KOKORO_SAMPLE_RATE);
        // times is span-parallel by construction, so times[j] always exists here.
        if (times) wordEntries = chunk.words.map((t, j) => ({ text: t, start: times[j]!.start, end: times[j]!.end }));
      }
      pieces.push({ pcm: wave, sentence: chunk.words.join(' '), wordEntries });
    }
    post({ id, progress: { phase: 'synthesis', fraction: (i + 1) / sentences.length } } satisfies SpeechWorkerReply);
  }

  // Uniform granularity, per the contract: word-level only when EVERY sentence
  // aligned; one misaligned sentence degrades the whole clip to sentence spans
  // rather than shipping a mixed array a caption grouper would misread.
  const allAligned = pieces.length > 0 && pieces.every((p) => p.wordEntries !== null);
  const clips: SentenceClip[] = pieces.map((p) => ({
    pcm: p.pcm,
    words: allAligned
      ? (p.wordEntries as SpeechWordTiming[])
      : [{ text: p.sentence, start: 0, end: p.pcm.length / KOKORO_SAMPLE_RATE }],
  }));
  const { pcm, duration, words } = concatClips(clips, SENTENCE_GAP_S, KOKORO_SAMPLE_RATE);
  return {
    pcm, sampleRate: KOKORO_SAMPLE_RATE, duration, words,
    granularity: words.length === 0 ? 'none' : allAligned ? 'word' : 'sentence',
  };
}

/** Requests currently synthesizing - an abort for an id not in here is stale
 *  (the request already finished) and must not park in `aborted` forever. */
const inFlight = new Set<number>();

addEventListener('message', (e: MessageEvent<SpeechWorkerRequest>) => {
  const { id, type } = e.data;
  if (type === 'abort') { if (inFlight.has(id)) aborted.add(id); return; }
  const text = e.data.text ?? '';
  const voice = e.data.voice ?? KOKORO_DEFAULT_VOICE;
  // Clamp like a UI would: below half pace the model slurs, above double it chirps.
  const speed = Math.min(2, Math.max(0.5, e.data.speed ?? 1));
  inFlight.add(id);
  synthesize(id, text, voice, speed)
    .then((result) => post({ id, result } satisfies SpeechWorkerReply, [result.pcm.buffer]))
    .catch((err) => post({ id, error: err instanceof Error ? err.message : String(err) } satisfies SpeechWorkerReply))
    .finally(() => { inFlight.delete(id); aborted.delete(id); });
});
