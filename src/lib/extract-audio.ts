// SPDX-License-Identifier: MPL-2.0
/**
 * Extract audio from a video - decode the video's sound track on-device and save
 * it as an ordinary audio user asset (WAV, or Opus where the platform encoder is
 * available).
 *
 * Two entry points share one pipeline:
 *
 *   - `openExtractAudioDialog` - the catalog asset viewer's "Extract audio" action
 *     for a VIDEO asset. The saved copy is its own derived asset, WITHOUT the
 *     'renders' tag (that tag means "this file left the app as a download"; a
 *     catalog-side extraction never did).
 *   - the sequence editor's Detach path can reuse `extractAudioToAsset` directly.
 *
 * ── It runs as a background JOB ─────────────────────────────────────────────
 * The dialog picks a format and ENQUEUES (`startExtractAudioJob`), then closes -
 * the matte/upscale hand-off (lib/matte-job.ts, lib/upscale-job.ts). Fetch,
 * decode, encode, stamp and save all happen on the WP-F serial heavy queue
 * (lib/jobs.ts), so the global toast owns progress and cancel and the work
 * survives the modal closing or the user navigating away. A whole-file
 * `decodeAudioData` wants most of the tab's address space, which is exactly what
 * the single heavy slot exists to serialise.
 *
 * ── What CANCEL really does (be honest about it) ────────────────────────────
 * There is no abortable decoder here. `decodeAudioData` and the WebCodecs
 * `AudioEncoder` loop both run to completion once started - neither takes a
 * signal, and nothing in a browser can preempt them. So a cancel:
 *   - ABORTS the source fetch outright when the bytes are still downloading
 *     (`fetch(url, { signal })`), which is the long wait for a big remote video;
 *   - past that, is COOPERATIVE: the pipeline checks between stages (after the
 *     read, after the decode, after the encode, and immediately before the save)
 *     and throws an AbortError at the first check it reaches. The stage already
 *     in flight finishes its work in the background and its memory is only freed
 *     when it does - but NOTHING is written: no provenance stamp, no user asset,
 *     no catalog entry. "Cancel" means "this will not land", not "this stops
 *     computing this instant".
 *
 * ── v1 decode is whole-file ─────────────────────────────────────────────────
 * The browser's only decoder for a compressed track is `decodeAudioData`, which
 * decodes the ENTIRE file into memory (PCM = duration × rate × channels × 4
 * bytes). A long clip is therefore a real OOM risk, so this REFUSES above a
 * source-size cap before the decode and above a duration cap after it, with a
 * plain message, rather than letting the tab die. No demuxer / stream-copy path
 * is built - that is explicitly out of scope for v1.
 *
 * ── Format ──────────────────────────────────────────────────────────────────
 * WAV is always offered: pure JS, lossless w.r.t. the decode, plays everywhere.
 * Opus is offered as a smaller second choice ONLY when the WebCodecs AudioEncoder
 * probes as supported; when the probe fails the select collapses to WAV-only.
 *
 * ── Provenance ──────────────────────────────────────────────────────────────
 * The extracted essence is a NEW derivative, so it is disclosed as a plain edit
 * ("Audio extracted from <name>") with the SOURCE VIDEO carried forward as a
 * C2PA ingredient (its own credential preserved, never laundered away). Stamping
 * is best-effort - a failed sign still saves the file.
 */
import { pcmToWavBlob } from './pcm-wav.ts';
import { encodeOpus, AUDIO_BITRATE, type AudioPcm } from './audio-encode.ts';
import { startJob, type JobHandle } from './jobs.ts';
import { mountModal } from '../components/modal.ts';
import { fmtBytes } from './format.ts';
import { escapeHtml } from './html.ts';
import { t, tRaw } from '../i18n.ts';
import { extractC2paStore, prepareC2paIngredientFromStore } from '@lolly/engine';
import type { AssetRef, HostV1 } from '@lolly-tools/core/host-v1';

/** The two extract targets, in the order the select lists them. */
export const EXTRACT_AUDIO_FORMATS = ['wav', 'opus'] as const;
export type ExtractAudioFormat = (typeof EXTRACT_AUDIO_FORMATS)[number];

const FORMAT_LABEL: Record<ExtractAudioFormat, string> = {
  wav: 'WAV',
  opus: 'Opus',
};
const FORMAT_MIME: Record<ExtractAudioFormat, string> = {
  wav: 'audio/wav',
  opus: 'audio/webm',
};

/**
 * Source-byte ceiling: a whole-file `decodeAudioData` must first hold the encoded
 * file AND allocate its decoded PCM, so a large source is refused before either
 * allocation. 250 MB is generous for a sound track while still well short of the
 * point a tab reliably falls over.
 */
export const EXTRACT_AUDIO_MAX_BYTES = 250 * 1024 * 1024;

/** Decoded-duration ceiling: caught after decode, before encode, since the source
 *  size alone cannot bound a highly-compressed long clip's PCM. 30 minutes. */
export const EXTRACT_AUDIO_MAX_SECONDS = 30 * 60;

/** A refusal message for a source too large to load, or null when it is fine. */
export function extractAudioSizeRefusal(bytes: number): string | null {
  if (bytes > EXTRACT_AUDIO_MAX_BYTES) {
    return t('This video is too large to extract audio from in the browser ({limit} max).', { limit: fmtBytes(EXTRACT_AUDIO_MAX_BYTES) });
  }
  return null;
}

/** A refusal message for a decoded track that is too long, or null when it is fine. */
export function extractAudioDurationRefusal(seconds: number): string | null {
  if (seconds > EXTRACT_AUDIO_MAX_SECONDS) {
    const mins = Math.round(EXTRACT_AUDIO_MAX_SECONDS / 60);
    return t('This track is too long to extract in the browser ({mins} minutes max).', { mins });
  }
  return null;
}

/** Decoded planar PCM - the shape both encoders take. */
export interface DecodedPcm {
  channels: Float32Array[];
  sampleRate: number;
}

/** Inject the decode + Opus encode for tests (node has neither Web Audio nor a
 *  WebCodecs AudioEncoder). Production supplies the real Web Audio decode. */
export interface ExtractAudioDeps {
  decode?: (bytes: ArrayBuffer) => Promise<DecodedPcm>;
  encodeOpusPcm?: (pcm: AudioPcm) => Promise<Blob>;
}

/**
 * What the job driver reports back while the pipeline works, and how the pipeline
 * learns it should stop. The MatteJobCtx / UpscaleJobCtx shape, so the three heavy
 * still-media pipelines read the same.
 *
 * `signal` is genuinely honoured for the source FETCH; every other stage is
 * cooperative (see the module header - neither `decodeAudioData` nor the
 * WebCodecs encoder can be interrupted mid-flight), so cancellation is observed
 * BETWEEN stages and always before anything is written.
 */
export interface ExtractAudioCtx {
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  /** `total <= 0` means indeterminate, exactly as lib/jobs.ts defines it. */
  onProgress?: (done: number, total: number, note?: string) => void;
}

/** Has a cancel been requested? Checked between stages - the only place this
 *  pipeline can observe one. */
function extractCancelled(ctx: ExtractAudioCtx): boolean {
  return ctx.isCancelled?.() === true || ctx.signal?.aborted === true;
}

/** The rejection a cancelled run throws. An AbortError, so the job wrapper (and
 *  every other caller) can tell a user cancel apart from a real failure. */
function extractAbortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('The audio extraction was cancelled.', 'AbortError')
    : Object.assign(new Error('The audio extraction was cancelled.'), { name: 'AbortError' });
}

/** Probe whether the platform can encode Opus through WebCodecs. Used to decide
 *  whether the format select offers Opus at all - a failed probe means WAV-only. */
export async function opusEncodeSupported(): Promise<boolean> {
  const AEnc = (globalThis as { AudioEncoder?: { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> } }).AudioEncoder;
  if (!AEnc?.isConfigSupported) return false;
  try {
    const s = await AEnc.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: AUDIO_BITRATE });
    return s?.supported === true;
  } catch {
    return false;
  }
}

/** Decode compressed bytes through Web Audio (the browser's only decoder for a
 *  video's AAC/Opus track). Throws with the decoder's own reason. */
async function decodeWithWebAudio(bytes: ArrayBuffer): Promise<DecodedPcm> {
  const AC = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) throw new Error(t('This browser cannot decode audio.'));
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(bytes);
    const channels: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
    if (!channels.length || !(channels[0]?.length ?? 0)) throw new Error(t('This video has no audio to extract.'));
    return { channels, sampleRate: buf.sampleRate };
  } finally {
    ctx.close().catch(() => {});
  }
}

/** The result of a decode + encode, before any save. */
export interface ExtractedAudio {
  blob: Blob;
  format: ExtractAudioFormat;
  durationSec: number;
  mime: string;
}

/**
 * Decode `bytes` and encode the sound track to `format`. Enforces the duration
 * cap after decode (throws its refusal message). Pure w.r.t. the DOM through the
 * injected deps, so the maths is testable under node.
 *
 * Neither stage reports progress: `decodeAudioData` resolves once, with nothing in
 * between, and the WebCodecs `AudioEncoder` exposes no completion count either. So
 * both report the INDETERMINATE `(0, 0, note)` form and the toast pulses, rather
 * than inventing a percentage that would only be a lie about where the work is.
 */
export async function extractAudioBlob(
  bytes: ArrayBuffer, format: ExtractAudioFormat, deps: ExtractAudioDeps = {}, ctx: ExtractAudioCtx = {},
): Promise<ExtractedAudio> {
  ctx.onProgress?.(0, 0, t('Decoding the sound track…'));
  const decoded = await (deps.decode ?? decodeWithWebAudio)(bytes);
  // First place a cancel can land after the decode was handed off - the decode
  // itself cannot be interrupted, so this is where an aborted run stops.
  if (extractCancelled(ctx)) throw extractAbortError();
  const frames = decoded.channels[0]?.length ?? 0;
  const durationSec = decoded.sampleRate > 0 ? frames / decoded.sampleRate : 0;
  const durationRefusal = extractAudioDurationRefusal(durationSec);
  if (durationRefusal) throw new Error(durationRefusal);

  ctx.onProgress?.(0, 0, t('Encoding the audio…'));
  let blob: Blob;
  if (format === 'opus') {
    const pcm: AudioPcm = { channels: decoded.channels, sampleRate: decoded.sampleRate };
    blob = await (deps.encodeOpusPcm ?? ((p) => encodeOpus(p)))(pcm);
  } else {
    const left = decoded.channels[0] ?? new Float32Array(0);
    const right = decoded.channels[1] ?? left; // fold mono to a stereo WAV's two planes
    blob = pcmToWavBlob({ left, right, sampleRate: decoded.sampleRate });
  }
  if (extractCancelled(ctx)) throw extractAbortError();
  return { blob, format, durationSec, mime: FORMAT_MIME[format] };
}

/** The user-asset record this module writes (mirrors bridge/assets.ts's
 *  UserAssetRecord for the fields we set - same pattern as upscale-dialog's
 *  UpscaleAssetRecordInput). */
export interface ExtractAudioAssetRecordInput {
  id: string;
  type: AssetRef['type'];
  format: string;
  blob?: Blob;
  version?: string;
  aiGenerated?: 'full' | 'partial';
  meta?: Record<string, unknown>;
}

/** The web host surface this module touches. The catalog/picker hosts satisfy it. */
export interface ExtractAudioHost extends HostV1 {
  assets: HostV1['assets'] & {
    _uploadUserAsset(record: ExtractAudioAssetRecordInput): Promise<void>;
  };
}

/** A source to extract from: a placed/library asset, raw bytes, or a URL. */
export type ExtractAudioSource = AssetRef | Blob | string;

export interface ExtractAudioToAssetOpts {
  source: ExtractAudioSource;
  sourceName: string;
  format: ExtractAudioFormat;
  /** Set only when the extraction is the tail of a DOWNLOAD (the sequence export
   *  path). A catalog-side extraction leaves it false, so its asset is untagged. */
  fromDownloadPath?: boolean;
  /** Carried forward from the source when it discloses AI content. */
  aiGenerated?: 'full' | 'partial';
  deps?: ExtractAudioDeps;
}

/** A file-safe id + a display name from the source name. */
export function extractAudioIds(sourceName: string, format: ExtractAudioFormat, now: number): { id: string; name: string } {
  const base = sourceName.replace(/\.[a-z0-9]+$/i, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return {
    id: `user/audio/${now}-${slug || 'audio'}.${format}`,
    name: tRaw('Audio from {name}', { name: base || t('video') }),
  };
}

async function sourceToBytes(source: ExtractAudioSource, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (source instanceof Blob) return await source.arrayBuffer();
  const url = typeof source === 'string' ? source : source.url;
  // The ONE genuinely abortable stage: a big remote video is the long wait, and
  // `fetch` drops it the instant the signal fires.
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return await res.arrayBuffer();
}

/**
 * A cheap size signal read BEFORE the whole source is loaded: a Blob's own `size`,
 * an asset's recorded byte count, or a HEAD `content-length`. Lets the source-size
 * cap refuse a huge file without first allocating its full ArrayBuffer. Null when the
 * size can't be learned cheaply, in which case the post-read cap is the backstop.
 */
async function sourceSizeHint(source: ExtractAudioSource, signal?: AbortSignal): Promise<number | null> {
  if (source instanceof Blob) {
    // Real Blobs always expose a numeric `size`; guard anyway so a Blob-like whose
    // getter throws just falls through to the post-read backstop instead of erroring.
    try {
      const s = source.size;
      return typeof s === 'number' && Number.isFinite(s) ? s : null;
    } catch {
      return null;
    }
  }
  if (typeof source !== 'string') {
    const b = source.meta?.bytes;
    if (typeof b === 'number' && b > 0) return b;
  }
  const url = typeof source === 'string' ? source : source.url;
  try {
    const res = await fetch(url, { method: 'HEAD', ...(signal ? { signal } : {}) });
    const len = res.headers.get('content-length');
    const n = len ? Number(len) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Full pipeline: fetch → size gate → decode → encode → stamp provenance → save.
 * Resolves the saved asset's AssetRef. Throws (with a plain message) on refusal
 * or decode failure, so the caller can surface it; throws an AbortError when
 * `ctx` reports a cancel, at the first between-stage check it reaches.
 */
export async function extractAudioToAsset(
  host: ExtractAudioHost, opts: ExtractAudioToAssetOpts, ctx: ExtractAudioCtx = {},
): Promise<AssetRef> {
  // Refuse an oversize source from a cheap size signal BEFORE reading it all in - a
  // whole-file arrayBuffer() of a multi-GB video is exactly what the cap exists to
  // prevent. The post-read check still backstops a source whose size wasn't knowable.
  ctx.onProgress?.(0, 0, t('Reading the video…'));
  const hint = await sourceSizeHint(opts.source, ctx.signal);
  if (extractCancelled(ctx)) throw extractAbortError();
  if (hint != null) {
    const preRefusal = extractAudioSizeRefusal(hint);
    if (preRefusal) throw new Error(preRefusal);
  }
  const bytes = await sourceToBytes(opts.source, ctx.signal);
  if (extractCancelled(ctx)) throw extractAbortError();
  const sizeRefusal = extractAudioSizeRefusal(bytes.byteLength);
  if (sizeRefusal) throw new Error(sizeRefusal);

  const extracted = await extractAudioBlob(bytes, opts.format, opts.deps, ctx);

  // Last check before anything is WRITTEN. A cancel past this point would leave a
  // half-declared asset in the catalog, so it stops here instead.
  if (extractCancelled(ctx)) throw extractAbortError();
  ctx.onProgress?.(0, 0, t('Saving…'));

  // Stamp the derived copy's own bytes with a plain-edit credential, carrying the
  // source video's own credential forward as an ingredient. Best-effort: a failed
  // sign still ships the file.
  let blob = extracted.blob;
  try {
    const { stampDerivedC2pa } = await import('../bridge/export.ts');
    const ex = extractC2paStore(new Uint8Array(bytes));
    const ingredient = ex ? prepareC2paIngredientFromStore(ex.store, ex.format) : null;
    blob = await stampDerivedC2pa(host, extracted.blob, opts.format === 'opus' ? 'webm' : 'wav', {
      title: opts.sourceName,
      tool: 'Extract audio',
      actions: [{ action: 'c2pa.edited', description: `Audio extracted from ${opts.sourceName}` }],
      ...(ingredient ? { ingredients: [ingredient] } : {}),
    });
  } catch (e) {
    host.log?.('warn', 'Extract audio: provenance stamp failed', { error: String(e) });
  }

  const now = Date.now();
  const { id, name } = extractAudioIds(opts.sourceName, opts.format, now);
  const record: ExtractAudioAssetRecordInput = {
    id,
    type: 'audio',
    format: opts.format,
    blob,
    version: '1.0.0',
    ...(opts.aiGenerated ? { aiGenerated: opts.aiGenerated } : {}),
    meta: {
      name,
      bytes: blob.size,
      durationMs: Math.round(extracted.durationSec * 1000),
      // 'renders' ONLY for the download path (WP-B's contract); a catalog-side
      // extraction is its own derived asset and stays untagged.
      ...(opts.fromDownloadPath ? { tags: ['renders'] } : {}),
    },
  };
  await host.assets._uploadUserAsset(record);
  return await host.assets.get(id);
}

/**
 * Drive one extraction through a WP-F job (serial heavy queue + global toast +
 * desktop notification). Returns the JobHandle immediately; the work runs in the
 * background and survives the dialog closing and the user navigating away.
 * `onComplete` fires with the saved AssetRef so a still-open view can refresh.
 *
 * Heavy (the default): a whole-file decode allocates the entire track as PCM, so
 * it queues behind any other heavy job rather than fighting it for the address
 * space. The exact sibling of `startMatteJob` / `startUpscaleJob`.
 */
export function startExtractAudioJob(
  host: ExtractAudioHost, opts: ExtractAudioToAssetOpts,
  hooks: { onComplete?: (ref: AssetRef) => void; onError?: (err: unknown) => void } = {},
): JobHandle {
  const controller = new AbortController();
  const job = startJob({ title: t('Extracting audio'), cancel: () => controller.abort() });
  void (async (): Promise<void> => {
    await job.started;
    if (job.cancelled) return;
    try {
      const ref = await extractAudioToAsset(host, opts, {
        signal: controller.signal,
        isCancelled: () => job.cancelled,
        onProgress: (done, total, note) => job.progress(done, total, note),
      });
      if (job.cancelled) return;
      job.finish(ref);
      hooks.onComplete?.(ref);
    } catch (err) {
      // A cancel is not a failure: cancelJob() has already put the job in its
      // terminal state, and both the aborted fetch and the between-stage checks
      // surface here as an AbortError.
      if (job.cancelled || (err as Error | null)?.name === 'AbortError') return;
      host.log?.('error', 'Extract audio failed', { error: String(err) });
      job.fail(err);
      hooks.onError?.(err);
    }
  })();
  return job;
}

/**
 * The catalog "Extract audio" action's dialog: pick a format (WAV always, Opus
 * when the platform can encode it), then ENQUEUE and close. Resolves when the
 * dialog is gone - never with the asset, which arrives through `onComplete` once
 * the background job has saved it. Esc / backdrop close it (mountModal owns that).
 */
export function openExtractAudioDialog(host: ExtractAudioHost, opts: {
  source: ExtractAudioSource; sourceName: string; aiGenerated?: 'full' | 'partial';
  /** Fires with the saved audio asset once the background job lands. */
  onComplete?: (ref: AssetRef) => void;
}): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve();
    };

    const content = `
      <h2 class="modal-title">${escapeHtml(t('Extract audio'))}</h2>
      <p class="modal-msg">${escapeHtml(opts.sourceName)}</p>
      <label class="field-label extract-audio-field">
        <span>${escapeHtml(t('Format'))}</span>
        <select class="field-select" data-format>
          <option value="wav">${escapeHtml(FORMAT_LABEL.wav)}</option>
        </select>
      </label>
      <p class="modal-msg extract-audio-status" data-status role="status" aria-live="polite" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-act="cancel">${escapeHtml(t('Cancel'))}</button>
        <button type="button" class="btn btn--primary" data-act="go">${escapeHtml(t('Extract audio'))}</button>
      </div>`;

    const modal = mountModal<void>(content, {
      className: 'modal extract-audio-modal',
      ariaLabel: t('Extract audio'),
      initialFocus: (el) => el.querySelector<HTMLElement>('[data-act="go"]'),
      onClose: () => { if (!settled) { settled = true; resolve(); } },
    });

    const formatSel = modal.el.querySelector<HTMLSelectElement>('[data-format]')!;
    const statusEl = modal.el.querySelector<HTMLElement>('[data-status]')!;
    const goBtn = modal.el.querySelector<HTMLButtonElement>('[data-act="go"]')!;
    const cancelBtn = modal.el.querySelector<HTMLButtonElement>('[data-act="cancel"]')!;

    // One status line, and it only ever says one thing now: where the work went.
    // A failure is the toast's to report, since the dialog is gone by then.
    const showStatus = (msg: string): void => {
      statusEl.hidden = false;
      statusEl.textContent = msg;
    };

    // Offer Opus only when the platform's WebCodecs encoder probes supported.
    void opusEncodeSupported().then((ok) => {
      if (ok && modal.el.isConnected) {
        const opt = document.createElement('option');
        opt.value = 'opus';
        opt.textContent = FORMAT_LABEL.opus;
        formatSel.appendChild(opt);
      }
    });

    cancelBtn.addEventListener('click', () => finish());
    // Go ENQUEUES and closes. Nothing here waits on the decode: the fetch, the
    // decode, the encode, the credential and the save are one background job
    // (startExtractAudioJob) and cancellation lives on the toast from here, which
    // is why this handler starts no AbortController of its own. The saved asset
    // reaches the caller through opts.onComplete. The matte-dialog hand-off.
    goBtn.addEventListener('click', () => {
      const format = (formatSel.value === 'opus' ? 'opus' : 'wav') as ExtractAudioFormat;
      goBtn.disabled = true;
      cancelBtn.disabled = true;
      formatSel.disabled = true;
      startExtractAudioJob(host, {
        source: opts.source, sourceName: opts.sourceName, format,
        ...(opts.aiGenerated ? { aiGenerated: opts.aiGenerated } : {}),
      }, {
        onComplete: (ref) => opts.onComplete?.(ref),
        onError: (err) => host.log?.('error', 'Extract audio failed', { error: String(err) }),
      });
      showStatus(t('Working in the background. It will appear in your catalog when it’s done.'));
      // Let the message land, then close: the toast takes it from here.
      setTimeout(finish, 900);
    });
  });
}
