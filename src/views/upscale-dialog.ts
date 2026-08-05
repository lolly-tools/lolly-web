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
import { extractC2paStore, prepareC2paIngredientFromStore, COMPOSITE_SOURCE_TYPE } from '@lolly/engine';
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
const XPLUS_MODEL: UpscaleModelId = 'realesrgan-x4plus';
const FACE_MODEL: UpscaleModelId = 'gfpgan-v1.4';

/** An intent the picker offers ("what are you upscaling?"), which routes to the best
 *  engine so the user never picks a model by name. `model` is the ONNX engine (absent
 *  for an algorithmic intent); `hqModel` is an optional "higher quality" swap;
 *  `algorithm: 'nearest'` is a local, no-download path (pixel art). */
interface UpscaleIntent {
  value: string;
  label: string;
  model?: UpscaleModelId;
  hqModel?: UpscaleModelId;
  algorithm?: 'nearest';
  note?: string;
}

/** Nearest-neighbour integer scale via canvas — the crisp, no-download, no-blur path
 *  for pixel art (a neural upscaler would smooth away the hard edges). Pure: source
 *  frame → a scale×-larger frame, imageSmoothingEnabled off so pixels stay square. */
function pixelNearest(frame: UpscaleFrame, scale: number): UpscaleFrame {
  const src = document.createElement('canvas');
  src.width = frame.width; src.height = frame.height;
  const sctx = src.getContext('2d');
  if (!sctx) throw new Error('no 2d context');
  sctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  const outW = frame.width * scale, outH = frame.height * scale;
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('no 2d context');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(src, 0, 0, outW, outH);
  return { width: outW, height: outH, data: octx.getImageData(0, 0, outW, outH).data };
}

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
 *  `host.upscale.run` contract wants (and what `getImageData` yields). Also returns
 *  the source's original bytes, kept so the save step can carry the source's own
 *  Content Credential forward as an ingredient (an AI image upscaled stays declared
 *  as one) rather than erasing it. */
export async function sourceToFrame(source: UpscaleSource, fallbackName?: string): Promise<{ frame: UpscaleFrame; name: string; bytes: Uint8Array }> {
  const { blob, name } = await sourceToBlob(source, fallbackName);
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
    return { frame: { width: img.width, height: img.height, data: img.data }, name, bytes };
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
    // The decoded source frame + its name, once a source is loaded. srcBytes is the
    // source's original file bytes, kept for the Content Credential scan at save.
    let srcFrame: UpscaleFrame | null = null;
    let srcName = '';
    let srcBytes: Uint8Array | null = null;
    // The active feasibility answer, so Run only fires when the device can cope.
    let feasible = false;

    // The intent roster — built from the STAGED models, so an intent whose engine
    // isn't vendored simply doesn't appear. Pixel art is always offered (it's a local
    // algorithm, no model). Illustration rides the general model until a dedicated
    // line-art model is staged, with a note that says so.
    const has = (id: UpscaleModelId): boolean => models.some(m => m.id === id);
    const intents: UpscaleIntent[] = [];
    if (has(GENERAL_MODEL)) intents.push({ value: 'photo', label: t('Photo'), model: GENERAL_MODEL, ...(has(XPLUS_MODEL) ? { hqModel: XPLUS_MODEL } : {}) });
    if (has(GENERAL_MODEL)) intents.push({ value: 'illustration', label: t('Illustration'), model: GENERAL_MODEL, note: t('Using the general model for now — a line-art model is on the way.') });
    intents.push({ value: 'pixel', label: t('Pixel art'), algorithm: 'nearest' });
    if (has(GENERAL_MODEL)) intents.push({ value: 'text', label: t('Text'), model: GENERAL_MODEL });
    if (has(FACE_MODEL)) intents.push({ value: 'face', label: t('Face'), model: FACE_MODEL });
    const intentOptions = intents.map(i =>
      `<option value="${escapeHtml(i.value)}">${escapeHtml(i.label)}</option>`).join('');
    const defaultIntent = intents[0]!.value;

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
              <span class="upscale-field-label">${t('What are you upscaling?')}</span>
              <select class="field-select" data-intent>${intentOptions}</select>
            </label>
            <label class="upscale-field" data-edge-field>
              <span class="upscale-field-label">${t('Target longest edge (px)')}</span>
              <input type="number" class="field-input" data-edge min="16" step="16" inputmode="numeric" />
            </label>
            <label class="upscale-field" data-pixel-field hidden>
              <span class="upscale-field-label">${t('Scale')}</span>
              <select class="field-select" data-pixel-scale>
                <option value="2">2×</option>
                <option value="3">3×</option>
                <option value="4" selected>4×</option>
              </select>
            </label>
            <label class="upscale-field upscale-check" data-hq-field hidden>
              <input type="checkbox" class="upscale-checkbox" data-hq />
              <span class="upscale-field-label">${t('Higher quality (slower, larger download)')}</span>
            </label>
            <label class="upscale-field" data-denoise-field>
              <span class="upscale-field-label">${t('Denoise')} <span data-denoise-out>0.30</span></span>
              <input type="range" class="upscale-range" data-denoise min="0" max="1" step="0.05" value="0.3" />
            </label>
          </div>
          <p class="upscale-note" data-note role="note" hidden></p>
          <p class="upscale-warning" data-warning role="note" hidden></p>
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
    const intentSel  = overlay.querySelector<HTMLSelectElement>('[data-intent]')!;
    const edgeField  = overlay.querySelector<HTMLElement>('[data-edge-field]')!;
    const pixelField = overlay.querySelector<HTMLElement>('[data-pixel-field]')!;
    const pixelScaleSel = overlay.querySelector<HTMLSelectElement>('[data-pixel-scale]')!;
    const hqField    = overlay.querySelector<HTMLElement>('[data-hq-field]')!;
    const hqCheck    = overlay.querySelector<HTMLInputElement>('[data-hq]')!;
    const noteEl     = overlay.querySelector<HTMLElement>('[data-note]')!;
    const warningEl  = overlay.querySelector<HTMLElement>('[data-warning]')!;
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

    intentSel.value = defaultIntent;

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
    const currentIntent = (): UpscaleIntent => intents.find(i => i.value === intentSel.value) ?? intents[0]!;
    // The engine an intent resolves to: its `hqModel` when the "higher quality" box is
    // ticked, else its `model`. Algorithmic intents (pixel art) have no model — they
    // never reach the ONNX path — so this falls back to the general model only to keep
    // the type total; the run handler branches on `currentIntent().algorithm` first.
    const currentModel = (): UpscaleModelId => {
      const it = currentIntent();
      if (it.hqModel && hqCheck.checked) return it.hqModel;
      return it.model ?? GENERAL_MODEL;
    };

    // Show only the controls the active intent uses: the target-edge input for model
    // intents, the integer-scale select for pixel art, the "higher quality" box only
    // where an intent offers one, and the note where it has one.
    const paintControls = (): void => {
      const it = currentIntent();
      const isPixel = it.algorithm === 'nearest';
      edgeField.hidden = isPixel;
      pixelField.hidden = !isPixel;
      hqField.hidden = !it.hqModel;
      if (!it.hqModel) hqCheck.checked = false;
      noteEl.hidden = !it.note;
      if (it.note) noteEl.textContent = it.note;
    };

    // A face restorer (GFPGAN) can synthesise detail that was never in the source,
    // so the shell must SAY SO — visibly, not behind a hover tooltip (invisible on
    // touch and clipped by the dialog's rounded overflow). When a warned model is
    // selected, its warning shows as an inline banner with a ⚠ glyph; the (i) icon
    // sits inside it for recognisability.
    const paintWarning = (): void => {
      const warn = modelOf(currentModel()).warning;
      if (warn) {
        warningEl.hidden = false;
        warningEl.innerHTML = `${icon('info', { size: 14 })}<span>${escapeHtml(warn)}</span>`;
      } else {
        warningEl.hidden = true;
        warningEl.innerHTML = '';
      }
    };

    // Denoise is the general model's lever only, AND only when its WDN partner is
    // actually vendored — a placeholder-pinned WDN would make the slider a dead
    // control that silently changes nothing, so hide it until the weights are real.
    const paintDenoise = (): void => {
      const on = !currentIntent().algorithm && currentModel() === GENERAL_MODEL && UPSCALE_DENOISE_STAGED;
      denoiseField.hidden = !on;
      denoiseInput.disabled = !on;
    };
    denoiseInput.addEventListener('input', () => { denoiseOut.textContent = Number(denoiseInput.value).toFixed(2); });

    // First use of a model: say what is about to happen BEFORE any bytes move —
    // the weights download once, then everything runs on-device. cached() never
    // downloads; an unknown cache state skips the line rather than blocking.
    const paintConsent = async (): Promise<void> => {
      if (currentIntent().algorithm) {
        consentEl.hidden = false;
        consentEl.textContent = t('No download — this runs instantly on-device.');
        return;
      }
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
      // Pixel art is a local canvas scale — no model to fit in memory, always runnable.
      if (currentIntent().algorithm) { feasible = true; feasEl.hidden = true; feasEl.innerHTML = ''; runBtn.disabled = false; return; }
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
        // The only model-swap the intent UI exposes is the "higher quality" lever, so
        // if THAT is what's too heavy, offer to drop back to standard rather than name
        // a model. Other suggestedModel hints are folded into the edge lever above.
        if (res.suggestedModel && res.suggestedModel !== o.model && hqCheck.checked && currentIntent().model === res.suggestedModel) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'upscale-suggest';
          btn.textContent = t('Use standard quality');
          btn.addEventListener('click', () => { hqCheck.checked = false; onIntentChange(); });
          feasEl.appendChild(document.createTextNode(' '));
          feasEl.appendChild(btn);
        }
      }
    };

    const onIntentChange = (): void => {
      paintControls();
      const it = currentIntent();
      // Re-seed the target edge to the engine's native ceiling for the new scale
      // (model intents only — pixel art uses the integer-scale select instead).
      if (!it.algorithm && srcFrame) {
        const native = Math.max(srcFrame.width, srcFrame.height) * modelOf(currentModel()).scale;
        edgeInput.max = String(native);
        if (Number(edgeInput.value) > native) edgeInput.value = String(native);
      }
      paintWarning();
      paintDenoise();
      void paintConsent();
      void recheck();
    };
    intentSel.addEventListener('change', onIntentChange);
    hqCheck.addEventListener('change', onIntentChange);
    pixelScaleSel.addEventListener('change', () => void recheck());
    edgeInput.addEventListener('change', () => void recheck());
    denoiseInput.addEventListener('change', () => void recheck());

    // Adopt a decoded source: fill the summary, seed the target edge, reveal the
    // controls, and run the first feasibility check.
    const adoptFrame = (frame: UpscaleFrame, name: string, bytes: Uint8Array): void => {
      srcFrame = frame;
      srcName = name;
      srcBytes = bytes;
      chooseEl.hidden = true;
      sourceEl.hidden = false;
      const info = modelOf(currentModel());
      const native = Math.max(frame.width, frame.height) * info.scale;
      sourceEl.textContent = tRaw('{name} — {w}×{h}px', { name, w: frame.width, h: frame.height });
      edgeInput.max = String(native);
      edgeInput.value = String(native);
      controlsEl.hidden = false;
      paintControls();
      paintWarning();
      paintDenoise();
      void paintConsent();
      void recheck();
    };

    const loadSource = async (source: UpscaleSource, fallbackName?: string): Promise<void> => {
      hideStatus();
      try {
        const { frame, name, bytes } = await sourceToFrame(source, fallbackName);
        if (!overlay.isConnected) return;
        adoptFrame(frame, name, bytes);
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
        const it = currentIntent();
        let out: UpscaleFrame;
        // How to disclose THIS transform in the saved copy's credential, and whether
        // it counts as a Gen-AI edit. The two paths differ in kind, so their provenance
        // does too — this is the whole reason pixel art is a separate branch.
        let editAction: { action: string; digitalSourceType?: string; description: string };
        let ai = false;
        let aiUpscaleMeta: { model: UpscaleModelId; version: string } | undefined;

        if (it.algorithm === 'nearest') {
          // Pixel art: a LOCAL, deterministic nearest-neighbour integer scale. No model
          // invents anything, so it is disclosed as a plain edit — NEVER a genAI
          // credential or the Gen-AI pill (that would over-claim on a lossless resize).
          const scale = Math.max(2, Math.round(Number(pixelScaleSel.value) || 4));
          progressEl.classList.add('upscale-progress-indeterminate');
          fillEl.style.width = '100%';
          progressEl.setAttribute('aria-valuenow', '0');
          showStatus(t('Scaling…'));
          out = pixelNearest(srcFrame, scale);
          editAction = { action: 'c2pa.edited', description: `Scaled ${scale}× (nearest-neighbour, pixel art)` };
        } else {
          // Model path: run() TRANSFERS (neuters) the frame's buffer to the worker, so
          // hand it a FRESH COPY and keep srcFrame intact — otherwise a retry after a
          // failed run would post a detached, empty buffer and fail.
          const o = readOpts();
          const runFrame = { width: srcFrame.width, height: srcFrame.height, data: new Uint8ClampedArray(srcFrame.data) };
          out = await upscale.run(runFrame, { ...o, signal: abort.signal, onProgress: paint });
          const info = modelOf(o.model);
          // A super-resolver INVENTS high-frequency detail from a trained model, so the
          // honest IPTC digitalSourceType is compositeWithTrainedAlgorithmicMedia (a
          // real image with model-inferred pixels), which aiKind reads back as 'partial'.
          editAction = {
            action: 'c2pa.edited',
            digitalSourceType: COMPOSITE_SOURCE_TYPE,
            description: `Upscaled ${info.scale}× with ${info.name} ${info.version} (on-device)`,
          };
          ai = true;
          aiUpscaleMeta = { model: o.model, version: info.version };
        }
        if (!overlay.isConnected) return;
        showStatus(t('Saving…'));
        const rawBlob = await frameToPngBlob(out);
        const now = Date.now();
        const { id, name } = upscaleAssetIds(opts.sourceName ?? srcName, now);

        // Stamp the copy's own bytes so its embedded Content Credential discloses the
        // transform (not only the catalog listing). The source's own credential (e.g.
        // an AI image's) is preserved as an ingredient rather than erased. Never throws
        // (stampDerivedC2pa is try/catch internally); a failed re-sign still ships.
        let blob = rawBlob;
        try {
          const { stampDerivedC2pa } = await import('../bridge/export.ts');
          const ex = srcBytes ? extractC2paStore(srcBytes) : null;
          const ingredient = ex ? prepareC2paIngredientFromStore(ex.store, ex.format) : null;
          blob = await stampDerivedC2pa(host, rawBlob, 'png', {
            title: srcName,
            tool: 'Upscale',
            actions: [editAction],
            ...(ingredient ? { ingredients: [ingredient] } : {}),
            dimensions: `${out.width}×${out.height}`,
          });
        } catch (e) {
          host.log('warn', 'Upscale provenance stamp failed', { error: String(e) });
        }

        const record: UpscaleAssetRecordInput = {
          id,
          type: 'raster',
          format: 'png',
          blob,
          width: out.width,
          height: out.height,
          version: '1.0.0',
          // Gen-AI pill (bridge/assets.ts) only for the model path; the embedded
          // credential above carries the same disclosure into the file's own bytes.
          ...(ai ? { aiGenerated: 'partial' as const } : {}),
          meta: {
            name,
            bytes: blob.size,
            // The C2PA composite-disclosure signal the engine runtime reads
            // (ExportOpts.c2paAiUpscale): "AI-upscaled with <model> <version>".
            ...(aiUpscaleMeta ? { aiUpscale: aiUpscaleMeta } : {}),
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
        if (overlay.isConnected) { runBtn.disabled = !feasible; progressEl.hidden = true; progressEl.classList.remove('upscale-progress-indeterminate'); }
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
