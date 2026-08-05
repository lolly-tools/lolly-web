// SPDX-License-Identifier: MPL-2.0
/**
 * Remove Background — pick or drop a raster image, cut the subject out on-device
 * with the optional host.matte bridge (v1.103), then save the cutout as an
 * ordinary user raster asset. A host-owned modal like the Upscale sheet: opened
 * lazily from an embedding (free-canvas context menu, picker, Bitmap Studio),
 * nested focus trap, Escape/backdrop/nav closes. Everything runs locally — the
 * model downloads once (consent line up front), and the pixels never leave the
 * device.
 *
 * TWO things distinguish this from Upscale, and they are the whole point of
 * hosting it:
 *  1. PROVENANCE, not destruction. Every other remover strips the file's
 *     metadata, ICC and Content Credential. Here the result carries a C2PA
 *     credential that NAMES the operation ("Background removed with <model>
 *     <version>") and keeps the ORIGINAL as an ingredient — so an AI image's
 *     credential survives the cut-out instead of being erased. And because a
 *     matte INVENTS nothing (every RGB pixel is the original; only the alpha is
 *     computed), the asset is NOT flagged AI-generated — it is an edit, disclosed
 *     honestly, not a generated composite.
 *  2. FORMAT. A cutout needs alpha, so the output keeps an alpha-capable format:
 *     a PNG/WebP/AVIF source stays its format; a JPEG (no alpha) switches to PNG
 *     by default (or WebP/AVIF if chosen). Never a silent JPEG-with-a-white-box.
 */

import '../styles/matte.css';
import { trapFocus, type FocusTrap } from '../lib/focus-trap.ts';
import { fmtBytes } from '../lib/format.ts';
import { escapeHtml } from '../lib/html.ts';
import { NAV_EVENTS } from '../utils.ts';
import { t, tRaw } from '../i18n.ts';
import { extractC2paStore, prepareC2paIngredientFromStore } from '@lolly/engine';
import { MATTE_DEFAULT_MODEL } from '../lib/matte-models.ts';
import type {
  AssetRef, HostV1, MatteFrame, MatteModelId, MatteProgress,
} from '@lolly-tools/core/host-v1';

/** The user-asset record this dialog writes (mirrors UpscaleAssetRecordInput). */
export interface MatteAssetRecordInput {
  id: string;
  type: AssetRef['type'];
  format: string;
  blob?: Blob;
  version?: string;
  width?: number;
  height?: number;
  meta?: Record<string, unknown>;
}

export interface MatteHost extends HostV1 {
  assets: HostV1['assets'] & {
    _uploadUserAsset(record: MatteAssetRecordInput): Promise<void>;
  };
}

export type MatteSource = AssetRef | Blob | string;

export interface MatteDialogOpts {
  source?: MatteSource;
  sourceName?: string;
}

// The alpha-capable output formats we can reliably encode from a canvas. A source
// in one of these keeps its format; anything else (JPEG, unknown) → PNG, the
// lossless safe default. AVIF encode is browser-dependent, so it falls back to
// PNG when canvas.toBlob can't produce it (handled in frameToBlob).
const ALPHA_FORMATS = ['png', 'webp', 'avif'] as const;
type OutFormat = (typeof ALPHA_FORMATS)[number];
const MIME: Record<OutFormat, string> = { png: 'image/png', webp: 'image/webp', avif: 'image/avif' };

/** The format the cutout should be saved as, from the source's format. */
function outputFormatFor(sourceFormat: string | undefined): OutFormat {
  const f = (sourceFormat ?? '').toLowerCase().replace('jpeg', 'jpg');
  return (ALPHA_FORMATS as readonly string[]).includes(f) ? (f as OutFormat) : 'png';
}

async function sourceToBlob(source: MatteSource, fallbackName?: string): Promise<{ blob: Blob; name: string; format?: string }> {
  if (source instanceof Blob) {
    const name = source instanceof File ? source.name : (fallbackName ?? t('image'));
    return { blob: source, name };
  }
  if (typeof source === 'string') {
    const res = await fetch(source);
    return { blob: await res.blob(), name: fallbackName ?? t('image') };
  }
  const res = await fetch(source.url);
  const name = (source.meta?.name as string | undefined) ?? fallbackName ?? source.id;
  return { blob: await res.blob(), name, format: source.format };
}

/** Decode a source to a straight-alpha RGBA frame + its bytes (kept for the
 *  credential scan) + name + inferred format. */
async function sourceToFrame(source: MatteSource, fallbackName?: string): Promise<{
  frame: MatteFrame; bytes: Uint8Array; name: string; format: string;
}> {
  const { blob, name, format } = await sourceToBlob(source, fallbackName);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const fmt = format ?? (blob.type.split('/')[1] ?? 'png');
    return { frame: { width: img.width, height: img.height, data: img.data }, bytes, name, format: fmt };
  } finally {
    bitmap.close();
  }
}

/** RGBA cutout → a blob in `fmt`, falling back to PNG when the browser can't
 *  encode the requested format (AVIF on older browsers). */
function frameToBlob(frame: MatteFrame, fmt: OutFormat): Promise<{ blob: Blob; format: OutFormat }> {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('no 2d context'));
  const img = ctx.createImageData(frame.width, frame.height);
  img.data.set(frame.data);
  ctx.putImageData(img, 0, 0);
  const encode = (mime: string): Promise<Blob | null> =>
    new Promise((res) => canvas.toBlob((b) => res(b), mime));
  return encode(MIME[fmt]).then((blob) => {
    // toBlob returns the PNG fallback with the WRONG type when a format is
    // unsupported, so verify the produced type actually matches before trusting it.
    if (blob && blob.type === MIME[fmt]) return { blob, format: fmt };
    return encode('image/png').then((png) => {
      if (!png) throw new Error('toBlob failed');
      return { blob: png, format: 'png' as OutFormat };
    });
  });
}

function matteAssetIds(sourceName: string, now: number): { id: string; name: string } {
  const base = sourceName.replace(/\.[a-z0-9]+$/i, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return { id: `user/matte/${now}-${slug || 'cutout'}`, name: tRaw('{name} — cutout', { name: base || t('image') }) };
}

/**
 * Open the Remove-Background dialog. Resolves the saved cutout's AssetRef, or null
 * on cancel. Callers gate on `host.matte?.isAvailable() && host.matte.models().length`
 * before offering the affordance; this also bails (null) when no model is staged,
 * so a stale button can never strand the user in a dead dialog.
 */
// The last matte model the user picked, remembered per device so the dialog reopens
// on their choice (models differ in size, quality and download — a silent reset to
// the default is exactly the accidental-wrong-model case this avoids).
const MATTE_MODEL_KEY = 'lolly:matteModel';
const readMatteModel = (): string => { try { return localStorage.getItem(MATTE_MODEL_KEY) || ''; } catch { return ''; } };
const saveMatteModel = (id: string): void => { try { localStorage.setItem(MATTE_MODEL_KEY, id); } catch { /* private mode — no persistence, harmless */ } };

export function openMatteDialog(host: MatteHost, opts: MatteDialogOpts = {}): Promise<AssetRef | null> {
  const matte = host.matte;
  if (!matte?.isAvailable()) return Promise.resolve(null);
  const models = matte.models();
  if (models.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    let trap: FocusTrap | undefined;
    let abort: AbortController | null = null;
    let srcFrame: MatteFrame | null = null;
    let srcBytes: Uint8Array | null = null;
    let srcName = '';
    let srcFormat = 'png';
    let feasible = false;

    const modelOptions = models.map(m =>
      `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    // Open on the model the user LAST chose (persisted per device), so nobody
    // accidentally re-downloads a different model or falls back to the fast one when
    // they had picked a better one. Falls back to the canonical default (birefnet-lite)
    // then the first staged entry when there is no prior choice (or it is no longer
    // available). Only ever preselects a model that is actually in the offered list.
    const defaultModel = models.find(m => m.id === readMatteModel())?.id
      ?? models.find(m => m.id === MATTE_DEFAULT_MODEL)?.id
      ?? models[0]!.id;

    const overlay = document.createElement('div');
    overlay.className = 'matte-overlay';
    overlay.innerHTML = `
      <div class="matte-backdrop" aria-hidden="true"></div>
      <div class="matte-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('Remove background'))}">
        <header class="matte-head">
          <span>${t('Remove background')}</span>
          <button type="button" class="matte-close" aria-label="${escapeHtml(t('Close'))}">&times;</button>
        </header>
        <div class="matte-body">
          <label class="matte-choose" data-choose hidden>
            <input type="file" class="visually-hidden" accept="image/*" data-file />
            <span class="matte-choose-label">${t('Choose a photo, or drop or paste one here')}</span>
          </label>
          <div class="matte-source" data-source aria-live="polite" hidden></div>
          <div class="matte-controls" data-controls hidden>
            <label class="matte-field">
              <span class="matte-field-label">${t('Model')}</span>
              <select class="field-select" data-model>${modelOptions}</select>
            </label>
            <label class="matte-field">
              <span class="matte-field-label">${t('Save as')}</span>
              <select class="field-select" data-format>
                <option value="png">PNG</option>
                <option value="webp">WebP</option>
                <option value="avif">AVIF</option>
              </select>
            </label>
          </div>
          <p class="matte-consent" data-consent hidden></p>
          <p class="matte-note" data-note hidden></p>
          <div class="matte-feasibility" data-feasibility role="alert" hidden></div>
          <div class="matte-progress" data-progress role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="${escapeHtml(t('Removing background'))}" hidden>
            <div class="matte-progress-fill" data-progress-fill></div>
          </div>
          <div class="matte-status" data-status aria-live="polite" hidden></div>
        </div>
        <footer class="matte-actions">
          <button type="button" class="matte-cancel">${t('Cancel')}</button>
          <button type="button" class="matte-run" data-run disabled>${t('Remove background')}</button>
        </footer>
      </div>`;
    document.body.appendChild(overlay);

    const chooseEl   = overlay.querySelector<HTMLElement>('[data-choose]')!;
    const fileInput  = overlay.querySelector<HTMLInputElement>('[data-file]')!;
    const sourceEl   = overlay.querySelector<HTMLElement>('[data-source]')!;
    const controlsEl = overlay.querySelector<HTMLElement>('[data-controls]')!;
    const modelSel   = overlay.querySelector<HTMLSelectElement>('[data-model]')!;
    const formatSel  = overlay.querySelector<HTMLSelectElement>('[data-format]')!;
    const consentEl  = overlay.querySelector<HTMLElement>('[data-consent]')!;
    const noteEl     = overlay.querySelector<HTMLElement>('[data-note]')!;
    const feasEl     = overlay.querySelector<HTMLElement>('[data-feasibility]')!;
    const progressEl = overlay.querySelector<HTMLElement>('[data-progress]')!;
    const fillEl     = overlay.querySelector<HTMLElement>('[data-progress-fill]')!;
    const statusEl   = overlay.querySelector<HTMLElement>('[data-status]')!;
    const runBtn     = overlay.querySelector<HTMLButtonElement>('[data-run]')!;
    const opener     = document.activeElement;

    modelSel.value = defaultModel;

    const cleanup = (): void => {
      abort?.abort();
      abort = null;
      trap?.release();
      document.removeEventListener('keydown', onKey);
      NAV_EVENTS.forEach(ev => window.removeEventListener(ev, onNav));
      overlay.remove();
      if (opener instanceof HTMLElement) opener.focus();
    };
    const done = (val: AssetRef | null): void => { cleanup(); resolve(val); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    document.addEventListener('keydown', onKey);
    const onNav = (): void => done(null);
    NAV_EVENTS.forEach(ev => window.addEventListener(ev, onNav));
    overlay.querySelector('.matte-backdrop')?.addEventListener('click', () => done(null));
    overlay.querySelector('.matte-close')?.addEventListener('click', () => done(null));
    overlay.querySelector('.matte-cancel')?.addEventListener('click', () => done(null));
    trap = trapFocus(overlay);

    const showStatus = (msg: string, isError = false): void => {
      statusEl.hidden = false;
      statusEl.textContent = msg;
      statusEl.classList.toggle('matte-error', isError);
    };
    const hideStatus = (): void => { statusEl.hidden = true; statusEl.classList.remove('matte-error'); };

    const currentModel = (): MatteModelId => (modelSel.value || defaultModel) as MatteModelId;
    const modelOf = (id: MatteModelId) => models.find(m => m.id === id) ?? models[0]!;

    const paintConsent = async (): Promise<void> => {
      const id = currentModel();
      try {
        if (await matte.cached(id)) {
          consentEl.hidden = false;
          consentEl.textContent = t('This model is already downloaded — it runs on-device and your image is never uploaded.');
        } else {
          consentEl.hidden = false;
          consentEl.textContent = t('The first run downloads a {size} model once. It runs on-device and your image is never uploaded.', { size: fmtBytes(matte.modelBytes(id)) });
        }
      } catch { consentEl.hidden = true; }
    };

    // If the source was a JPEG (or other alpha-less format), we CANNOT keep it —
    // a cutout needs alpha — so say the format is changing, honestly.
    const paintFormatNote = (): void => {
      const chosen = formatSel.value as OutFormat;
      if (outputFormatFor(srcFormat) !== chosen && srcFormat.replace('jpeg', 'jpg') === 'jpg') {
        noteEl.hidden = false;
        noteEl.textContent = t('A cut-out needs transparency, so a JPEG is saved as {fmt}.', { fmt: chosen.toUpperCase() });
      } else if (srcFormat.replace('jpeg', 'jpg') === 'jpg') {
        noteEl.hidden = false;
        noteEl.textContent = t('A cut-out needs transparency, so this JPEG is saved as {fmt}.', { fmt: chosen.toUpperCase() });
      } else {
        noteEl.hidden = true;
      }
    };

    let checkSeq = 0;
    const recheck = async (): Promise<void> => {
      if (!srcFrame) { feasible = false; runBtn.disabled = true; return; }
      const seq = ++checkSeq;
      runBtn.disabled = true;
      let res;
      try {
        res = await matte.canRun({ width: srcFrame.width, height: srcFrame.height }, { model: currentModel() });
      } catch (e) {
        if (seq !== checkSeq || !overlay.isConnected) return;
        host.log('warn', 'Matte feasibility check failed', { error: String(e) });
        feasible = true; runBtn.disabled = false;
        return;
      }
      if (seq !== checkSeq || !overlay.isConnected) return;
      if (res.ok) {
        feasible = true; feasEl.hidden = true; runBtn.disabled = false;
      } else {
        feasible = false; runBtn.disabled = true;
        feasEl.hidden = false;
        feasEl.textContent = res.message ?? t('This image is too large to process on this device.');
      }
    };

    modelSel.addEventListener('change', () => { saveMatteModel(modelSel.value); void paintConsent(); void recheck(); });
    formatSel.addEventListener('change', paintFormatNote);

    const adoptFrame = (frame: MatteFrame, bytes: Uint8Array, name: string, format: string): void => {
      srcFrame = frame; srcBytes = bytes; srcName = name; srcFormat = format;
      chooseEl.hidden = true;
      sourceEl.hidden = false;
      sourceEl.textContent = tRaw('{name} — {w}×{h}px', { name, w: frame.width, h: frame.height });
      formatSel.value = outputFormatFor(format);
      controlsEl.hidden = false;
      paintFormatNote();
      void paintConsent();
      void recheck();
    };

    const loadSource = async (source: MatteSource, fallbackName?: string): Promise<void> => {
      hideStatus();
      try {
        const { frame, bytes, name, format } = await sourceToFrame(source, fallbackName);
        if (!overlay.isConnected) return;
        adoptFrame(frame, bytes, name, format);
      } catch (e) {
        if (!overlay.isConnected) return;
        host.log('error', 'Matte source decode failed', { error: String(e) });
        showStatus(t("Couldn't read that image. Try another one."), true);
        chooseEl.hidden = false;
      }
    };

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) void loadSource(file);
    });

    runBtn.addEventListener('click', async () => {
      if (!srcFrame || !feasible) return;
      hideStatus();
      runBtn.disabled = true;
      progressEl.hidden = false;
      const model = currentModel();
      abort = new AbortController();
      const paint = (p: MatteProgress): void => {
        const frac = p.fraction ?? (p.phase === 'download' ? (p.total ? (p.loaded ?? 0) / p.total : null) : null);
        progressEl.classList.toggle('matte-progress-indeterminate', frac == null);
        const pct = frac == null ? 0 : Math.round(Math.min(1, Math.max(0, frac)) * 100);
        fillEl.style.width = frac == null ? '100%' : `${pct}%`;
        progressEl.setAttribute('aria-valuenow', String(pct));
        showStatus(p.phase === 'download' ? t('Downloading the model…') : t('Removing background…'));
      };
      try {
        // run() TRANSFERS the frame buffer to the worker; hand it a fresh copy and
        // keep srcFrame intact so a retry after a failed run doesn't post an empty buffer.
        const runFrame = { width: srcFrame.width, height: srcFrame.height, data: new Uint8ClampedArray(srcFrame.data) };
        const out = await matte.run(runFrame, { model, signal: abort.signal, onProgress: paint });
        if (!overlay.isConnected) return;
        showStatus(t('Saving…'));
        const { blob: rawBlob, format } = await frameToBlob(out, formatSel.value as OutFormat);
        const info = modelOf(model);

        // Provenance: stamp the operation and keep the original as an ingredient.
        // A matte invents nothing, so this is a c2pa.edited step, NOT an
        // AI-generated claim — and a source credential (e.g. an AI image's) is
        // preserved rather than erased. Never throws (stampDerivedC2pa is
        // try/catch internally); a failed re-sign still ships the cut-out.
        let blob = rawBlob;
        try {
          const { stampDerivedC2pa } = await import('../bridge/export.ts');
          const ex = srcBytes ? extractC2paStore(srcBytes) : null;
          const ingredient = ex ? prepareC2paIngredientFromStore(ex.store, ex.format) : null;
          blob = await stampDerivedC2pa(host, rawBlob, format, {
            title: srcName,
            tool: 'Remove background',
            actions: [{ action: 'c2pa.edited', description: `Background removed with ${info.name} ${info.version} (on-device)` }],
            ...(ingredient ? { ingredients: [ingredient] } : {}),
            dimensions: `${out.width}×${out.height}`,
          });
        } catch (e) {
          host.log('warn', 'Matte provenance stamp failed', { error: String(e) });
        }

        const now = Date.now();
        const { id, name } = matteAssetIds(opts.sourceName ?? srcName, now);
        await host.assets._uploadUserAsset({
          id, type: 'raster', format, blob, width: out.width, height: out.height, version: '1.0.0',
          meta: {
            name,
            bytes: blob.size,
            // NOT aiGenerated: the RGB is 100% the original; only alpha is model-
            // computed. The operation is disclosed in the credential as an edit.
            matte: { model, version: info.version },
          },
        });
        done(await host.assets.get(id));
      } catch (e) {
        if (!overlay.isConnected) return;
        if ((e as Error | null)?.name !== 'AbortError') {
          host.log('error', 'Matte run failed', { error: String(e) });
          const msg = (e as Error | null)?.message?.trim();
          showStatus(msg || t("Couldn't remove the background. Try a smaller image."), true);
        } else {
          hideStatus();
        }
      } finally {
        abort = null;
        if (overlay.isConnected) { runBtn.disabled = !feasible; progressEl.hidden = true; }
      }
    });

    if (opts.source !== undefined) {
      void loadSource(opts.source, opts.sourceName);
    } else {
      chooseEl.hidden = false;
    }
  });
}
