// SPDX-License-Identifier: MPL-2.0
/**
 * On-device TRANSCRIPTION (Whisper) run as a background JOB (plans/124 section 9,
 * WP-F) - the speech-to-text sibling of lib/upscale-job.ts and lib/matte-job.ts.
 *
 * The consent sheet (the timeline panel's "Generate subtitles") states what the
 * run does and what it downloads, then ENQUEUES and CLOSES. Everything after
 * that - the one-time ~77 MB model download and minutes of wasm inference -
 * happens on the WP-F serial heavy queue, so the global toast (lib/job-toast.ts)
 * owns progress and cancel, and the run survives the sheet, the panel, and the
 * view. Before this, an Escape on that sheet aborted the controller: a stray key
 * threw away a model download and every minute of inference behind it.
 *
 * THE WORK IS NEVER DISCARDED, even with nobody left to hand it to. A finished
 * transcript is, in order:
 *   1. STASHED in memory under the source's asset id and its URL, so a user who
 *      navigates away and comes back in the same tab re-places the captions with
 *      no second wait;
 *   2. PERSISTED onto the source's own user-asset record as `meta.transcript`
 *      (the annotation write, bridge/assets.ts `_updateUserAssetMeta`), so it
 *      also survives a reload - and the next "Generate subtitles" on that clip
 *      reads it off the record instead of inferring again. A catalog asset or a
 *      bare URL has no record to annotate, which is exactly what the in-memory
 *      stash covers;
 *   3. handed to the surface, if one is still alive, through `onComplete` - the
 *      timeline panel's caption-box writer. `onComplete` reports whether it
 *      actually consumed the words; when it did not, the completion ANNOUNCES
 *      that the transcript is ready and how to place it. Nothing is ever thrown
 *      away silently.
 *
 * The words themselves stay on-device throughout: bridge/speech.ts decodes and
 * infers locally, and the persisted note is a record in the user's own
 * IndexedDB, sitting beside the audio it describes.
 */

import { startJob, type JobHandle } from './jobs.ts';
import { announce } from '../a11y.ts';
import { t } from '../i18n.ts';
// The transcript note's SHAPE (and the validator every stored word list is read
// through) belongs with the caption ladder that consumes it, which is pure math
// and must not gain an edge to the job machinery. This module owns the WRITE.
import { TRANSCRIPT_META_KEY, wordTimingsOf, type TranscriptNote } from '../views/timeline-captions.ts';
import type { AssetRef, SpeechAPI, SpeechProgress, SpeechWordTiming } from '@lolly-tools/core/host-v1';

// ── The host slice this job touches ──────────────────────────────────────────

/**
 * Just what a transcription job needs: the optional speech bridge, a log, and
 * (for the persistence rung) the user-asset store's read + meta-annotation
 * writes. The timeline panel's `TimelineHost` satisfies it structurally, so a
 * call site passes what it already holds.
 */
export interface SttJobHost {
  speech?: SpeechAPI;
  log?(level: string, msg: string): void;
  assets?: {
    get?(id: string): Promise<AssetRef | null>;
    _updateUserAssetMeta?(id: string, meta: Record<string, unknown>, patch?: { aiGenerated?: 'full' | 'partial' }): Promise<void>;
  };
}

/** One transcription run's inputs, snapshotted when the user pressed Go. */
export interface TranscribeJobRequest {
  /** What `host.speech.transcribe` reads: a live asset ref, or a URL. */
  src: AssetRef | string;
  /** The source's PERMANENT asset id, when it has one - the record the finished
   *  transcript is written back onto. Omitted for a bare URL, which then relies
   *  on the in-memory stash alone. */
  assetId?: string;
  /** BCP 47 hint; the model auto-detects when omitted. */
  lang?: string;
  /** The toast's title. Defaults to "Generating subtitles". */
  title?: string;
}

/** Progress + cancellation, driven by the job handle (or a test). */
export interface TranscribeJobCtx {
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  /** `total <= 0` means indeterminate, exactly as lib/jobs.ts defines it. */
  onProgress?: (done: number, total: number, note?: string) => void;
}

/** What the job carries in its terminal `result` - the transcript plus what
 *  became of it, so a caller (or a test) can see the honest outcome. */
export interface TranscribeJobResult {
  words: SpeechWordTiming[];
  /** A live surface took the words and dealt with them. */
  applied: boolean;
  /** The transcript was written back onto the source asset's record. */
  persisted: boolean;
}

export interface TranscribeJobHooks {
  /**
   * Fired with the finished words while the job is still terminating. Return
   * `true` when the surface CONSUMED them (the caption boxes landed, or it told
   * the user there was no speech) - anything else means nobody was there, and
   * the completion announces where the transcript went instead.
   */
  onComplete?: (words: SpeechWordTiming[]) => boolean | void;
  onError?: (err: unknown) => void;
  /** Fired exactly once when the job reaches ANY terminal state, cancel
   *  included - where a caller drops its own "a run is in flight" guard. */
  onSettled?: () => void;
}

// ── The in-memory stash (this tab, this session) ──────────────────────────────

/** Transcripts kept in memory. Small (words, not audio), but bounded anyway. */
const STASH_MAX = 24;
const STASH = new Map<string, SpeechWordTiming[]>();

/** The stash key for a transcription source: an asset's permanent id where it
 *  has one, else its URL (an object URL is per-session, which is exactly this
 *  stash's lifetime). */
export function transcriptKey(src: AssetRef | string | null | undefined): string {
  if (!src) return '';
  if (typeof src === 'string') return src;
  return typeof src.id === 'string' && src.id ? src.id : String(src.url ?? '');
}

/** File one transcript under every key it can be looked up by. Copies in, so a
 *  later mutation of the caller's array cannot corrupt the stash. */
export function stashTranscript(words: readonly SpeechWordTiming[], ...keys: readonly string[]): void {
  if (!words.length) return;
  const copy = words.map((w) => ({ ...w }));
  for (const k of keys) {
    if (!k) continue;
    STASH.delete(k);        // re-insert, so Map order is recency for the evict below
    STASH.set(k, copy);
  }
  while (STASH.size > STASH_MAX) {
    const oldest = STASH.keys().next();
    if (oldest.done) break;
    STASH.delete(oldest.value);
  }
}

/** The first stashed transcript any of these keys names, or null. Copies out. */
export function stashedTranscript(...keys: readonly string[]): SpeechWordTiming[] | null {
  for (const k of keys) {
    const hit = k ? STASH.get(k) : undefined;
    if (hit) return hit.map((w) => ({ ...w }));
  }
  return null;
}

/** Test-only: empty the session stash. */
export function __resetTranscriptStashForTest(): void {
  STASH.clear();
}

// ── Persistence (the rung that survives a reload) ─────────────────────────────

/**
 * Write a finished transcript onto the source's own user-asset record, merged
 * into its existing meta. Best-effort and silent on failure: the stash and the
 * completion announcement already keep the work from being lost, and a storage
 * hiccup must not fail a job whose inference succeeded. Returns whether the note
 * actually landed. A library/catalog asset (or a bare URL) has no record here,
 * so it simply reports false.
 */
export async function persistTranscript(
  host: SttJobHost, assetId: string, words: readonly SpeechWordTiming[],
): Promise<boolean> {
  const assets = host.assets;
  if (!assetId || !words.length || !assets?.get || !assets._updateUserAssetMeta) return false;
  try {
    const ref = await assets.get(assetId);
    if (!ref || ref.source !== 'user') return false;
    const note: TranscriptNote = { words: words.map((w) => ({ ...w })), at: Date.now(), engine: 'whisper' };
    // Wholesale replacement, so the caller merges - _updateUserAssetMeta's own
    // contract. It is the annotation write on purpose: no quota check, no
    // pin-preserving duplicate, the blob and the credential untouched.
    await assets._updateUserAssetMeta(assetId, { ...(ref.meta ?? {}), [TRANSCRIPT_META_KEY]: note });
    return true;
  } catch (e) {
    host.log?.('warn', `transcript persistence failed - ${String(e)}`);
    return false;
  }
}

// ── The driver ───────────────────────────────────────────────────────────────

/**
 * The one fraction reading of a `SpeechProgress`, clamped to 0..1, or null when
 * the transport won't say how far along it is - the same reading the consent
 * sheet used to paint, so the toast can never show a second percentage.
 */
export function transcribeProgressFraction(p: SpeechProgress): number | null {
  const f = p.fraction ?? (p.total ? (p.loaded ?? 0) / p.total : undefined);
  if (f == null || !Number.isFinite(f)) return null;
  return Math.min(1, Math.max(0, f));
}

/** Both phases feed the one bar: the one-time model download and the inference.
 *  An unknowable fraction reports total 0, which the toast pulses instead of
 *  lying about a percentage. */
function reportProgress(ctx: TranscribeJobCtx, p: SpeechProgress): void {
  if (!ctx.onProgress) return;
  const note = p.phase === 'download' ? t('Downloading the speech model…') : t('Listening to the clip…');
  const f = transcribeProgressFraction(p);
  if (f == null) ctx.onProgress(0, 0, note);
  else ctx.onProgress(Math.round(f * 100), 100, note);
}

/**
 * Run one transcription. Resolves the heard words (an EMPTY array when the clip
 * held no speech - a real answer, not a failure), or null when the run was
 * cancelled. Throws whatever the speech bridge threw, for the caller to fail the
 * job with.
 */
export async function runTranscribeJob(
  host: SttJobHost, req: TranscribeJobRequest, ctx: TranscribeJobCtx = {},
): Promise<SpeechWordTiming[] | null> {
  const speech = host.speech;
  if (!speech?.transcribe) throw new Error(t('Transcription isn’t available on this device.'));
  const transcript = await speech.transcribe(req.src, {
    ...(req.lang ? { lang: req.lang } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    onProgress: (p: SpeechProgress) => reportProgress(ctx, p),
  });
  if (ctx.isCancelled?.()) return null;
  return wordTimingsOf(transcript?.words) ?? [];
}

/**
 * Drive an on-device transcription through a WP-F job (serial heavy queue +
 * global toast + desktop notification). Returns the JobHandle immediately; the
 * work runs in the background and survives the consent sheet closing, the panel
 * unmounting and the user navigating away.
 *
 * Heavy (the default): Whisper is wasm inference over the whole clip, so it
 * queues behind other heavy work rather than fighting it for the address space.
 *
 * Cancel is real, not a button that only looks like one: `transcribe` takes an
 * AbortSignal, rejects promptly, and tells the worker to stop at the next chunk
 * boundary (bridge/speech.ts). The one caveat the host contract already
 * documents is a first-use model download, which finishes into the cache rather
 * than leaving half a model behind - so a cancelled run costs the inference, not
 * the download. A cancelled run persists nothing.
 */
export function startTranscribeJob(
  host: SttJobHost, req: TranscribeJobRequest, hooks: TranscribeJobHooks = {},
): JobHandle {
  const controller = new AbortController();
  const job = startJob({ title: req.title || t('Generating subtitles'), cancel: () => controller.abort() });
  void (async (): Promise<void> => {
    try {
      await job.started;
      if (job.cancelled) return;
      const words = await runTranscribeJob(host, req, {
        signal: controller.signal,
        isCancelled: () => job.cancelled,
        onProgress: (done, total, note) => job.progress(done, total, note),
      });
      // Cancelled: cancelJob() has already put the job in its terminal state, and
      // a half-finished transcript is not something to file anywhere.
      if (job.cancelled || !words) return;
      if (!words.length) {
        // A real answer, told honestly: there was nothing to caption. Nothing to
        // stash, nothing to persist.
        const handled = hooks.onComplete?.([]) === true;
        job.finish({ words: [], applied: handled, persisted: false } satisfies TranscribeJobResult);
        if (!handled) announce(t('No speech was found to caption.'));
        return;
      }
      // Keep the work BEFORE handing it anywhere: the point of the job is that
      // minutes of inference outlive whatever asked for them.
      stashTranscript(words, req.assetId ?? '', transcriptKey(req.src));
      const persisted = await persistTranscript(host, req.assetId ?? '', words);
      const applied = hooks.onComplete?.(words) === true;
      job.finish({ words, applied, persisted } satisfies TranscribeJobResult);
      if (applied) return;
      // Nobody was left to place the captions. Say where the transcript went and
      // what to do with it - the toast's "Done" alone would read as work lost.
      announce(persisted
        ? t('The transcript is ready and saved with the clip. Choose Generate subtitles again to place the captions.')
        : t('The transcript is ready. Choose Generate subtitles again to place the captions, while this tab stays open.'));
    } catch (err) {
      // A cancel is not a failure: the abort surfaces here as an AbortError and
      // cancelJob() already owns the terminal state.
      if (job.cancelled || (err as Error | null)?.name === 'AbortError') return;
      host.log?.('warn', `transcription job failed - ${String(err)}`);
      job.fail(err);
      hooks.onError?.(err);
    } finally {
      hooks.onSettled?.();
    }
  })();
  return job;
}
