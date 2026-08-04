// SPDX-License-Identifier: MPL-2.0
/**
 * Upscale — pick or drop a raster image, enlarge it on-device with the optional
 * host.upscale bridge (v1.101), then save the result as an ordinary user raster
 * asset.
 *
 * A host-owned modal like the Script-audio sheet: opened lazily from the asset
 * picker's footer, stacks above the picker panel (nested focus trap), and
 * Escape/backdrop/nav closes. Everything runs locally — the model downloads once
 * (consent line up front, sized from modelBytes()), and the pixels never leave
 * the device. The heavy run is driven from THIS explicit, cancellable affordance,
 * never a tool hook (hooks are time-boxed and their late results discarded).
 *
 * The saved record carries `aiGenerated: 'partial'` so the Gen AI pill surfaces
 * on the tile (bridge/assets.ts), plus `meta.aiUpscale = { model, version }` —
 * the signal the engine runtime reads to stamp the C2PA composite disclosure
 * ("AI-upscaled with <model> <version>", see host-v1's ExportOpts.c2paAiUpscale).
 */

import '../styles/upscale.css';   // async CSS chunk (lazy dialog — not on the landing)
import { trapFocus, type FocusTrap } from '../lib/focus-trap.ts';
import { fmtBytes } from '../lib/format.ts';
import { escapeHtml } from '../lib/html.ts';
import { icon } from '../lib/icons.ts';
import { UPSCALE_DENOISE_STAGED } from '../lib/upscale-models.ts';
import { NAV_EVENTS } from '../utils.ts';
import { t, tRaw } from '../i18n.ts';
import type {
  AssetRef, HostV1, UpscaleFrame, UpscaleModelId, UpscaleProgress,
} from '@lolly-tools/core/host-v1';

/** The user-asset record this dialog writes (mirrors bridge/assets.ts's
 *  non-exported UserAssetRecord for the fields we set — same pattern as the
 *  picker's UserAssetRecordInput and script-audio's TtsAssetRecordInput, plus
 *  the `aiGenerated` disclosure field). */
export interface UpscaleAssetRecordInput {
  id: string;
  type: AssetRef['type'];
  format: string;
  blob?: Blob;
  version?: string;
  width?: number;
  height?: number;
  meta?: Record<string, unknown>;
  aiGenerated?: 'full' | 'partial';
}

/** The web host surface this dialog touches: HostV1 (for `upscale`, `log`) plus
 *  the web-only upload helper. The picker's PickerHost satisfies it structurally,
 *  so the call site passes what it already holds. */
export interface UpscaleHost extends HostV1 {
  assets: HostV1['assets'] & {
    _uploadUserAsset(record: UpscaleAssetRecordInput): Promise<void>;
  };
}

/** What the dialog can start from: a placed/library asset, raw bytes, or a URL.
 *  When absent the dialog shows its own "choose an image" step first. */
export type UpscaleSource = AssetRef | Blob | string;

export interface UpscaleDialogOpts {
  /** A source image to pre-load. Omit to let the dialog pick one. */
  source?: UpscaleSource;
  /** A display name for the source (drives the saved asset's name). */
  sourceName?: string;
}

/** The general (WDN-pair) model is the only one that takes a denoise strength. */
const GENERAL_MODEL: UpscaleModelId = 'realesr-general-x4v3';

/** Resolve any source shape to a blob + a best-effort display name. */
async function sourceToBlob(source: UpscaleSource, fallbackName?: string): Promise<{ blob: Blob; name: string }> {
  if (source instanceof Blob) {
    const name = source instanceof File ? source.name : (fallbackName ?? t('image'));
    return { blob: source, name };
  }
  if (typeof source === 'string') {
    const res = await fetch(source);
    return { blob: await res.blob(), name: fallbackName ?? t('image') };
  }
  // AssetRef — its `url` is a live object/remote URL.
  const res = await fetch(source.url);
  const name = (source.meta?.name as string | undefined) ?? fallbackName ?? source.id;
  return { blob: await res.blob(), name };
}

/** Decode a source to a straight-alpha RGBA frame via a canvas — exactly what the
 *  `host.upscale.run` contract wants (and what `getImageData` yields). */
export async function sourceToFrame(source: UpscaleSource, fallbackName?: string): Promise<{ frame: UpscaleFrame; name: string }> {
  const { blob, name } = await sourceToBlob(source, fallbackName);
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { frame: { width: img.width, height: img.height, data: img.data }, name };
  } finally {
    bitmap.close();
  }
}

/** A larger RGBA frame back to a PNG blob (putImageData → toBlob). */
export function frameToPngBlob(frame: UpscaleFrame): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('no 2d context'));
  // Build the ImageData from the canvas (its buffer is a plain ArrayBuffer) and
  // copy the frame's pixels in — the frame's Uint8ClampedArray may be backed by a
  // SharedArrayBuffer (Worker transfer), which the ImageData constructor rejects.
  const img = ctx.createImageData(frame.width, frame.height);
  img.data.set(frame.data);
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

/** A file-safe id + a display name from the source name. */
function upscaleAssetIds(sourceName: string, now: number): { id: string; name: string } {
  const base = sourceName.replace(/\.[a-z0-9]+$/i, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return { id: `user/upscaled/${now}-${slug || 'image'}`, name: tRaw('Upscaled {name}', { name: base || t('image') }) };
}

/**
 * Open the Upscale dialog. Resolves the saved asset's AssetRef, or null on cancel.
 * Callers gate on `host.upscale?.isAvailable()` before offering the affordance;
 * this also bails (resolving null) when the bridge is absent, so a stale button
 * can never strand the user in a dead dialog.
 */
export function openUpscaleDialog(host: UpscaleHost, opts: UpscaleDialogOpts = {}): Promise<AssetRef | null> {
  const upscale = host.upscale;
  if (!upscale?.isAvailable()) return Promise.resolve(null);
  const models = upscale.models();
  if (models.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    let trap: FocusTrap | undefined;
    let abort: AbortController | null = null;
    // The decoded source frame + its name, once a source is loaded.
    let srcFrame: UpscaleFrame | null = null;
    let srcName = '';
    // The active feasibility answer, so Run only fires when the device can cope.
    let feasible = false;

    const modelOptions = models.map(m =>
      `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    const defaultModel = models.some(m => m.id === GENERAL_MODEL) ? GENERAL_MODEL : models[0]!.id;

    const overlay = document.createElement('div');
    overlay.className = 'upscale-overlay';
    overlay.innerHTML = `
      <div class="upscale-backdrop" aria-hidden="true"></div>
      <div class="upscale-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('Upscale image'))}">
        <header class="upscale-head">
          <span>${t('Upscale image')}</span>
          <button type="button" class="upscale-close" aria-label="${escapeHtml(t('Close'))}">&times;</button>
        </header>
        <div class="upscale-body">
          <label class="upscale-choose" data-choose hidden>
            <input type="file" class="visually-hidden" accept="image/*" data-file />
            <span class="upscale-choose-label">${t('Choose a photo, or drop or paste one here')}</span>
          </label>
          <div class="upscale-source" data-source aria-live="polite" hidden></div>
          <div class="upscale-controls" data-controls hidden>
            <label class="upscale-field">
              <span class="upscale-field-label">
                ${t('Model')}
                <span class="upscale-info" data-info hidden tabindex="0" role="img"></span>
              </span>
              <select class="field-select" data-model>${modelOptions}</select>
            </label>
            <label class="upscale-field">
              <span class="upscale-field-label">${t('Target longest edge (px)')}</span>
              <input type="number" class="field-input" data-edge min="16" step="16" inputmode="numeric" />
            </label>
            <label class="upscale-field" data-denoise-field>
              <span class="upscale-field-label">${t('Denoise')} <span data-denoise-out>0.30</span></span>
              <input type="range" class="upscale-range" data-denoise min="0" max="1" step="0.05" value="0.3" />
            </label>
          </div>
          <p class="upscale-consent" data-consent hidden></p>
          <div class="upscale-feasibility" data-feasibility role="alert" hidden></div>
          <div class="upscale-progress" data-progress role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="${escapeHtml(t('Upscaling'))}" hidden>
            <div class="upscale-progress-fill" data-progress-fill></div>
          </div>
          <div class="upscale-status" data-status aria-live="polite" hidden></div>
        </div>
        <footer class="upscale-actions">
          <button type="button" class="upscale-cancel">${t('Cancel')}</button>
          <button type="button" class="upscale-run" data-run disabled>${t('Upscale')}</button>
        </footer>
      </div>`;
    document.body.appendChild(overlay);

    const chooseEl   = overlay.querySelector<HTMLElement>('[data-choose]')!;
    const fileInput  = overlay.querySelector<HTMLInputElement>('[data-file]')!;
    const sourceEl   = overlay.querySelector<HTMLElement>('[data-source]')!;
    const controlsEl = overlay.querySelector<HTMLElement>('[data-controls]')!;
    const modelSel   = overlay.querySelector<HTMLSelectElement>('[data-model]')!;
    const infoEl     = overlay.querySelector<HTMLElement>('[data-info]')!;
    const edgeInput  = overlay.querySelector<HTMLInputElement>('[data-edge]')!;
    const denoiseField = overlay.querySelector<HTMLElement>('[data-denoise-field]')!;
    const denoiseInput = overlay.querySelector<HTMLInputElement>('[data-denoise]')!;
    const denoiseOut   = overlay.querySelector<HTMLElement>('[data-denoise-out]')!;
    const consentEl  = overlay.querySelector<HTMLElement>('[data-consent]')!;
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
      document.removeEventListener('paste', onPaste);
      NAV_EVENTS.forEach(ev => window.removeEventListener(ev, onNav));
      overlay.remove();
      if (opener instanceof HTMLElement) opener.focus();
    };
    const done = (val: AssetRef | null): void => { cleanup(); resolve(val); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    document.addEventListener('keydown', onKey);
    // A route change cancels the sheet like Escape/backdrop — any in-flight run aborts.
    const onNav = (): void => done(null);
    NAV_EVENTS.forEach(ev => window.addEventListener(ev, onNav));
    overlay.querySelector('.upscale-backdrop')?.addEventListener('click', () => done(null));
    overlay.querySelector('.upscale-close')?.addEventListener('click', () => done(null));
    overlay.querySelector('.upscale-cancel')?.addEventListener('click', () => done(null));
    // Contain focus over whatever opened this (the picker is itself modal; nested
    // traps stack — this inerts the surface beneath while the sheet is open).
    trap = trapFocus(overlay);

    const showStatus = (msg: string, isError = false): void => {
      statusEl.hidden = false;
      statusEl.textContent = msg;
      statusEl.classList.toggle('upscale-error', isError);
    };
    const hideStatus = (): void => { statusEl.hidden = true; statusEl.classList.remove('upscale-error'); };

    const modelOf = (id: UpscaleModelId) => models.find(m => m.id === id) ?? models[0]!;
    const currentModel = (): UpscaleModelId => (modelSel.value || defaultModel) as UpscaleModelId;

    // The info-icon carries the selected model's warning VERBATIM (GFPGAN's
    // "warning can invent face details") — a face restorer can synthesise detail
    // that was never in the source, so the shell must say so.
    const paintWarning = (): void => {
      const warn = modelOf(currentModel()).warning;
      if (warn) {
        infoEl.hidden = false;
        infoEl.innerHTML = icon('info', { size: 14 });
        infoEl.setAttribute('data-tip', warn);
        infoEl.setAttribute('aria-label', warn);
      } else {
        infoEl.hidden = true;
        infoEl.removeAttribute('data-tip');
        infoEl.removeAttribute('aria-label');
      }
    };

    // Denoise is the general model's lever only, AND only when its WDN partner is
    // actually vendored — a placeholder-pinned WDN would make the slider a dead
    // control that silently changes nothing, so hide it until the weights are real.
    const paintDenoise = (): void => {
      const on = currentModel() === GENERAL_MODEL && UPSCALE_DENOISE_STAGED;
      denoiseField.hidden = !on;
      denoiseInput.disabled = !on;
    };
    denoiseInput.addEventListener('input', () => { denoiseOut.textContent = Number(denoiseInput.value).toFixed(2); });

    // First use of a model: say what is about to happen BEFORE any bytes move —
    // the weights download once, then everything runs on-device. cached() never
    // downloads; an unknown cache state skips the line rather than blocking.
    const paintConsent = async (): Promise<void> => {
      const id = currentModel();
      try {
        if (await upscale.cached(id)) {
          consentEl.hidden = false;
          consentEl.textContent = t('This model is already downloaded — it runs on-device and your image is never uploaded.');
        } else {
          consentEl.hidden = false;
          consentEl.textContent = t('The first run downloads a {size} model once. It runs on-device and your image is never uploaded.', { size: fmtBytes(upscale.modelBytes(id)) });
        }
      } catch { consentEl.hidden = true; }
    };

    // Build the opts the current controls describe.
    const readOpts = () => {
      const model = currentModel();
      const info = modelOf(model);
      const edge = Math.max(1, Math.round(Number(edgeInput.value) || 0));
      return {
        model,
        scale: info.scale,
        denoise: (model === GENERAL_MODEL && UPSCALE_DENOISE_STAGED) ? Number(denoiseInput.value) : undefined,
        targetMaxEdge: edge,
      };
    };

    // The honest feasibility check — runs on open and on every control change,
    // before any bytes move. When the device can't cope we show the plain message
    // and the concrete lever, and Run stays disabled.
    let checkSeq = 0;
    const recheck = async (): Promise<void> => {
      if (!srcFrame) { feasible = false; runBtn.disabled = true; return; }
      const seq = ++checkSeq;
      runBtn.disabled = true;
      const o = readOpts();
      let res;
      try {
        res = await upscale.canRun({ width: srcFrame.width, height: srcFrame.height }, o);
      } catch (e) {
        if (seq !== checkSeq || !overlay.isConnected) return;
        host.log('warn', 'Upscale feasibility check failed', { error: String(e) });
        feasEl.hidden = true;
        feasible = true; runBtn.disabled = false;  // let Run try; it degrades honestly on reject
        return;
      }
      if (seq !== checkSeq || !overlay.isConnected) return;
      if (res.ok) {
        feasible = true;
        feasEl.hidden = true;
        feasEl.innerHTML = '';
        runBtn.disabled = false;
      } else {
        feasible = false;
        runBtn.disabled = true;
        feasEl.hidden = false;
        feasEl.textContent = res.message ?? t("This image is too large to upscale on this device.");
        // Offer the concrete lever the bridge suggested, applied on click.
        if (res.suggestedMaxEdge) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'upscale-suggest';
          btn.textContent = t('Use {n}px', { n: res.suggestedMaxEdge });
          btn.addEventListener('click', () => { edgeInput.value = String(res.suggestedMaxEdge); void recheck(); });
          feasEl.appendChild(document.createTextNode(' '));
          feasEl.appendChild(btn);
        }
        if (res.suggestedModel && res.suggestedModel !== o.model) {
          const info = modelOf(res.suggestedModel);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'upscale-suggest';
          btn.textContent = tRaw('Try {name}', { name: info.name });
          btn.addEventListener('click', () => { modelSel.value = res.suggestedModel!; onModelChange(); });
          feasEl.appendChild(document.createTextNode(' '));
          feasEl.appendChild(btn);
        }
      }
    };

    const onModelChange = (): void => {
      const info = modelOf(currentModel());
      // Re-seed the target edge to the model's native ceiling for the new scale.
      if (srcFrame) {
        const native = Math.max(srcFrame.width, srcFrame.height) * info.scale;
        edgeInput.max = String(native);
        if (Number(edgeInput.value) > native) edgeInput.value = String(native);
      }
      paintWarning();
      paintDenoise();
      void paintConsent();
      void recheck();
    };
    modelSel.addEventListener('change', onModelChange);
    edgeInput.addEventListener('change', () => void recheck());
    denoiseInput.addEventListener('change', () => void recheck());

    // Adopt a decoded source: fill the summary, seed the target edge, reveal the
    // controls, and run the first feasibility check.
    const adoptFrame = (frame: UpscaleFrame, name: string): void => {
      srcFrame = frame;
      srcName = name;
      chooseEl.hidden = true;
      sourceEl.hidden = false;
      const info = modelOf(currentModel());
      const native = Math.max(frame.width, frame.height) * info.scale;
      sourceEl.textContent = tRaw('{name} — {w}×{h}px', { name, w: frame.width, h: frame.height });
      edgeInput.max = String(native);
      edgeInput.value = String(native);
      controlsEl.hidden = false;
      paintWarning();
      paintDenoise();
      void paintConsent();
      void recheck();
    };

    const loadSource = async (source: UpscaleSource, fallbackName?: string): Promise<void> => {
      hideStatus();
      try {
        const { frame, name } = await sourceToFrame(source, fallbackName);
        if (!overlay.isConnected) return;
        adoptFrame(frame, name);
      } catch (e) {
        if (!overlay.isConnected) return;
        host.log('error', 'Upscale source decode failed', { error: String(e) });
        showStatus(t("Couldn't read that image. Try another one."), true);
        chooseEl.hidden = false;
      }
    };

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) void loadSource(file);
    });

    // Drag-and-drop + paste onto the choose zone — so a desktop user drops or pastes
    // an image straight in instead of round-tripping through a file dialog. (Mobile
    // has no drag/paste; there the native file input already offers camera + gallery.)
    // Only active while the choose step is showing, and only for image payloads.
    const firstImageFile = (dt: DataTransfer | null): File | null => {
      for (const item of Array.from(dt?.items ?? [])) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) return f;
        }
      }
      const f = dt?.files?.[0];
      return f && f.type.startsWith('image/') ? f : null;
    };
    chooseEl.addEventListener('dragover', (e) => {
      if (chooseEl.hidden) return;
      e.preventDefault();
      chooseEl.classList.add('is-dragover');
    });
    chooseEl.addEventListener('dragleave', () => chooseEl.classList.remove('is-dragover'));
    chooseEl.addEventListener('drop', (e) => {
      if (chooseEl.hidden) return;
      e.preventDefault();
      chooseEl.classList.remove('is-dragover');
      const file = firstImageFile(e.dataTransfer);
      if (file) void loadSource(file);
      else showStatus(t("That doesn't look like an image. Try a PNG or JPG."), true);
    });
    // Paste while the choose step is up (no source adopted yet) — a screenshot or a
    // copied image lands straight in. Bound to the document; removed in cleanup.
    const onPaste = (e: ClipboardEvent): void => {
      if (srcFrame || chooseEl.hidden) return;
      const file = firstImageFile(e.clipboardData);
      if (file) { e.preventDefault(); void loadSource(file); }
    };
    document.addEventListener('paste', onPaste);

    runBtn.addEventListener('click', async () => {
      if (!srcFrame || !feasible) return;
      hideStatus();
      runBtn.disabled = true;
      progressEl.hidden = false;
      const o = readOpts();
      abort = new AbortController();
      const paint = (p: UpscaleProgress): void => {
        // Both phases feed the one bar: download (loaded/total) and inference
        // (tile/tiles); an unknowable fraction pulses the track.
        const frac = p.fraction ?? (
          p.phase === 'download'
            ? (p.total ? (p.loaded ?? 0) / p.total : null)
            : (p.tiles ? (p.tile ?? 0) / p.tiles : null));
        progressEl.classList.toggle('upscale-progress-indeterminate', frac == null);
        const pct = frac == null ? 0 : Math.round(Math.min(1, Math.max(0, frac)) * 100);
        fillEl.style.width = frac == null ? '100%' : `${pct}%`;
        progressEl.setAttribute('aria-valuenow', String(pct));
        showStatus(p.phase === 'download'
          ? t('Downloading the model…')
          : p.tiles ? t('Upscaling… tile {n} of {total}', { n: (p.tile ?? 0) + 1, total: p.tiles })
                    : t('Upscaling…'));
      };
      try {
        // run() TRANSFERS (neuters) the frame's buffer to the worker, so hand it a
        // FRESH COPY each time and keep srcFrame intact — otherwise a second Run
        // after a failed first attempt would post a detached, empty buffer and fail.
        const runFrame = { width: srcFrame.width, height: srcFrame.height, data: new Uint8ClampedArray(srcFrame.data) };
        const out = await upscale.run(runFrame, { ...o, signal: abort.signal, onProgress: paint });
        if (!overlay.isConnected) return;
        showStatus(t('Saving…'));
        const blob = await frameToPngBlob(out);
        const now = Date.now();
        const { id, name } = upscaleAssetIds(opts.sourceName ?? srcName, now);
        const info = modelOf(o.model);
        const record: UpscaleAssetRecordInput = {
          id,
          type: 'raster',
          format: 'png',
          blob,
          width: out.width,
          height: out.height,
          version: '1.0.0',
          // Surfaces the Gen AI pill (bridge/assets.ts).
          aiGenerated: 'partial',
          meta: {
            name,
            bytes: blob.size,
            // The C2PA composite-disclosure signal the engine runtime reads
            // (ExportOpts.c2paAiUpscale): "AI-upscaled with <model> <version>".
            aiUpscale: { model: o.model, version: info.version },
          },
        };
        await host.assets._uploadUserAsset(record);
        done(await host.assets.get(id));
      } catch (e) {
        if (!overlay.isConnected) return;
        // Cancel is not a failure. Anything else degrades to an honest message,
        // never a stuck spinner.
        if ((e as Error | null)?.name !== 'AbortError') {
          host.log('error', 'Upscale run failed', { error: String(e) });
          // Surface the runtime's OWN cause-specific message (e.g. "the model isn't
          // available yet"): "try a smaller target size" is wrong advice for a
          // download/decode fault, and only right for a genuine memory failure.
          const msg = (e as Error | null)?.message?.trim();
          showStatus(msg || t("Couldn't upscale the image. Try a smaller target size."), true);
        } else {
          hideStatus();
        }
      } finally {
        abort = null;
        if (overlay.isConnected) { runBtn.disabled = !feasible; progressEl.hidden = true; }
      }
    });

    // Kick off: pre-loaded source, or the choose step.
    if (opts.source !== undefined) {
      void loadSource(opts.source, opts.sourceName);
    } else {
      chooseEl.hidden = false;
    }
  });
}
