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
 */
export async function extractAudioBlob(
  bytes: ArrayBuffer, format: ExtractAudioFormat, deps: ExtractAudioDeps = {},
): Promise<ExtractedAudio> {
  const decoded = await (deps.decode ?? decodeWithWebAudio)(bytes);
  const frames = decoded.channels[0]?.length ?? 0;
  const durationSec = decoded.sampleRate > 0 ? frames / decoded.sampleRate : 0;
  const durationRefusal = extractAudioDurationRefusal(durationSec);
  if (durationRefusal) throw new Error(durationRefusal);

  let blob: Blob;
  if (format === 'opus') {
    const pcm: AudioPcm = { channels: decoded.channels, sampleRate: decoded.sampleRate };
    blob = await (deps.encodeOpusPcm ?? ((p) => encodeOpus(p)))(pcm);
  } else {
    const left = decoded.channels[0] ?? new Float32Array(0);
    const right = decoded.channels[1] ?? left; // fold mono to a stereo WAV's two planes
    blob = pcmToWavBlob({ left, right, sampleRate: decoded.sampleRate });
  }
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

async function sourceToBytes(source: ExtractAudioSource): Promise<ArrayBuffer> {
  if (source instanceof Blob) return await source.arrayBuffer();
  const url = typeof source === 'string' ? source : source.url;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return await res.arrayBuffer();
}

/**
 * A cheap size signal read BEFORE the whole source is loaded: a Blob's own `size`,
 * an asset's recorded byte count, or a HEAD `content-length`. Lets the source-size
 * cap refuse a huge file without first allocating its full ArrayBuffer. Null when the
 * size can't be learned cheaply, in which case the post-read cap is the backstop.
 */
async function sourceSizeHint(source: ExtractAudioSource): Promise<number | null> {
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
    const res = await fetch(url, { method: 'HEAD' });
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
 * or decode failure, so the caller can surface it.
 */
export async function extractAudioToAsset(host: ExtractAudioHost, opts: ExtractAudioToAssetOpts): Promise<AssetRef> {
  // Refuse an oversize source from a cheap size signal BEFORE reading it all in - a
  // whole-file arrayBuffer() of a multi-GB video is exactly what the cap exists to
  // prevent. The post-read check still backstops a source whose size wasn't knowable.
  const hint = await sourceSizeHint(opts.source);
  if (hint != null) {
    const preRefusal = extractAudioSizeRefusal(hint);
    if (preRefusal) throw new Error(preRefusal);
  }
  const bytes = await sourceToBytes(opts.source);
  const sizeRefusal = extractAudioSizeRefusal(bytes.byteLength);
  if (sizeRefusal) throw new Error(sizeRefusal);

  const extracted = await extractAudioBlob(bytes, opts.format, opts.deps);

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
 * The catalog "Extract audio" action's dialog: pick a format (WAV always, Opus
 * when the platform can encode it), then extract. Resolves the saved AssetRef, or
 * null on cancel. Esc / backdrop close it (mountModal owns that).
 */
export function openExtractAudioDialog(host: ExtractAudioHost, opts: {
  source: ExtractAudioSource; sourceName: string; aiGenerated?: 'full' | 'partial';
}): Promise<AssetRef | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: AssetRef | null): void => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(val);
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

    const modal = mountModal<AssetRef | null>(content, {
      className: 'modal extract-audio-modal',
      ariaLabel: t('Extract audio'),
      cancelValue: null,
      initialFocus: (el) => el.querySelector<HTMLElement>('[data-act="go"]'),
      onClose: (result) => { if (!settled) { settled = true; resolve(result ?? null); } },
    });

    const formatSel = modal.el.querySelector<HTMLSelectElement>('[data-format]')!;
    const statusEl = modal.el.querySelector<HTMLElement>('[data-status]')!;
    const goBtn = modal.el.querySelector<HTMLButtonElement>('[data-act="go"]')!;
    const cancelBtn = modal.el.querySelector<HTMLButtonElement>('[data-act="cancel"]')!;

    const showStatus = (msg: string, isError = false): void => {
      statusEl.hidden = false;
      statusEl.textContent = msg;
      statusEl.classList.toggle('extract-audio-error', isError);
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

    cancelBtn.addEventListener('click', () => finish(null));
    goBtn.addEventListener('click', async () => {
      const format = (formatSel.value === 'opus' ? 'opus' : 'wav') as ExtractAudioFormat;
      goBtn.disabled = true;
      cancelBtn.disabled = true;
      formatSel.disabled = true;
      showStatus(t('Extracting…'));
      try {
        const ref = await extractAudioToAsset(host, {
          source: opts.source, sourceName: opts.sourceName, format,
          ...(opts.aiGenerated ? { aiGenerated: opts.aiGenerated } : {}),
        });
        finish(ref);
      } catch (e) {
        host.log?.('error', 'Extract audio failed', { error: String(e) });
        const msg = (e as Error | null)?.message?.trim();
        showStatus(msg || t("Couldn't extract the audio."), true);
        goBtn.disabled = false;
        cancelBtn.disabled = false;
        formatSel.disabled = false;
      }
    });
  });
}
