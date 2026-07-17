// SPDX-License-Identifier: MPL-2.0
/**
 * Tool view — actions/export subsystem.
 *
 * renderActions builds the export bar (format/size/print/provenance controls) and
 * wires the copy / preview / save / download actions, plus captureThumbnail and the
 * number-scrub behaviour and the format/print helper predicates. Split out of tool.ts
 * (which keeps mountTool + the mount-only helpers).
 *
 * This module never value-imports from ./tool.ts (that would create a runtime
 * cycle) — it only `import type`s the shell-side aliases it needs from there.
 */
import { serializeUrlState, UNITS, toCssPx, CMYK_CONDITIONS, DEFAULT_CMYK_CONDITION, C2PA_FORMATS, composeSong, SCALES, mulberry32 } from '@lolly/engine';
import { escape } from '../utils.js';
import { t } from '../i18n.ts';
import { icon } from '../lib/icons.ts';
import { navigateTo } from '../nav.js';
import { announce } from '../a11y.js';
import { livePalette } from '../lib/live-palette.ts';
import { helpTip, wireHelpTips, linkHelpDescriptions } from '../components/help-tip.js';
import { mountBodyPopover } from '../components/body-popover.ts';
import { showScrubReadout, hideScrubReadout } from '../components/scrub-readout.js';
import { runTemplateScripts } from '../lib/render-lifecycle.ts';
import { playScrubTick } from '../lib/sfx.ts';
import { loopRank } from '../lib/neurospicy.ts';
import { songUrlToWavBlobUrl, renderSong } from '../lib/zzfxm-render.ts';
import { pcmToWavBlob } from '../lib/pcm-wav.ts';
import { modUrlToWavBlobUrl, isModuleFormat } from '../lib/mod-render.ts';
import { aspectWarning } from './export-size.js';
import { bumpMetric, recordFormat } from '../metrics.js';
import { videoSupport, cmykTiffSupport, tiffSupport, liveCaptureSupport } from '../bridge/format-support.js';

import type { InputValue } from '../../../../engine/src/inputs.js';
import type { SongSpec } from '../../../../engine/src/zzfx-compose.ts';
import type { ToolManifest } from '../../../../engine/src/loader.js';
import type { Runtime } from '../../../../engine/src/runtime.js';
import type { Unit } from '../../../../engine/src/units.js';

import type {
  WebToolHost, ToolRuntime, PanelEl, ExportUnscaled, ExportDefaults,
  ActionsApi, IdentityStatus, RunExportOpts, PrintMarks,
} from './tool.ts';

// Content Credentials default: the shared policy in lib/c2pa-policy.ts (also
// applied by the offscreen batch/zip renderer, so zips sign like this button).
// The C2PA card only renders for C2PA-capable formats, so it's a no-op for
// graphic-less tools. Re-exported below for tool.ts.
import { c2paDefaultOn } from '../lib/c2pa-policy.ts';

// Human-readable labels and file extensions for format identifiers that differ
// from their raw string (e.g. "pdf-cmyk" → "Print PDF" / ".pdf").
const FMT_LABEL: Record<string, string> = { 'pdf-cmyk': 'Print PDF', 'cmyk-tiff': 'Print TIFF', tiff: 'TIFF', 'jpeg': 'JPG', 'webm': 'WebM', 'mp4': 'MP4', apng: 'aPNG', 'webp-anim': 'Animated WebP', 'svg-anim': 'Animated SVG',
  emf: 'EMF (old)', eps: 'EPS', 'eps-cmyk': 'EPS (CMYK)', dxf: 'DXF (cut file)', pptx: 'PowerPoint', ics: 'Calendar', vcf: 'vCard', ico: 'Icon', zip: 'ZIP', csv: 'CSV', json: 'JSON' };
const FMT_EXT: Record<string, string>   = { 'pdf-cmyk': 'pdf', 'cmyk-tiff': 'tiff', 'jpeg': 'jpg', 'eps-cmyk': 'eps', 'webp-anim': 'webp', 'svg-anim': 'svg' };
// Animated WebP is credentialed via the still-'webp' path (renderFormat maps
// webp-anim→webp before stamping), but the engine's C2PA_FORMATS lists only 'webp' —
// so treat webp-anim as stampable in the UI gating too, else the toggle/card would be
// hidden and opts.c2pa never set, silently dropping the default provenance.
const isC2paFmt = (f: string | undefined): boolean => !!f && (C2PA_FORMATS.includes(f) || f === 'webp-anim');

// The durable in-pixel watermark only embeds via the canvas raster encoders
// (renderRaster/renderBitmap's opts.imprint branch in bridge/export.ts) — the same
// still-raster list the deep-link auto-export honours (views/tool.ts). Zip carries
// the flag through to its bundled raster members.
const isImprintFmt = (f: string | undefined): boolean => !!f && ['png', 'jpg', 'jpeg', 'webp', 'avif'].includes(f);

// Print marks & bleed apply to the three print formats (pdf / pdf-cmyk / cmyk-tiff).
// Defaults when the user turns the card on; the CSV tokens (crop,reg,bleed,bars)
// match the engine's `marks` URL param (engine/src/url-mode.js parseMarks). Bleed is
// carried as a dimension string. The Color profile (press condition) card applies to
// the two CMYK formats.
const DEFAULT_PRINT_MARKS: PrintMarks = { crop: true, registration: true, bleed: true, colorBars: false, provenance: true };
const isCmykFmt  = (f: string | undefined): boolean => f === 'pdf-cmyk' || f === 'cmyk-tiff';
const isPrintFmt = (f: string | undefined): boolean => f === 'pdf' || f === 'pdf-cmyk' || f === 'cmyk-tiff';
function marksToCsv(m: Partial<PrintMarks> | null | undefined): string {
  return m ? [m.crop && 'crop', m.registration && 'reg', m.bleed && 'bleed', m.colorBars && 'bars', m.provenance && 'prov'].filter(Boolean).join(',') : '';
}

// Read the Print marks card from an export-panel element `el` (empty when off).
const printEnabled  = (el: Element | null | undefined): boolean => Boolean(el?.querySelector<HTMLInputElement>('[data-action="print-enable"]')?.checked);
function readBleed(el: Element | null | undefined): string {
  if (!printEnabled(el)) return '';
  const mm = parseFloat(el?.querySelector<HTMLInputElement>('[data-action="print-bleed"]')?.value ?? '');
  return mm > 0 ? `${mm}mm` : '';
}
function readMarks(el: Element | null | undefined): string {
  if (!printEnabled(el)) return '';
  return marksToCsv({
    crop:         el?.querySelector<HTMLInputElement>('[data-action="mark-crop"]')?.checked,
    registration: el?.querySelector<HTMLInputElement>('[data-action="mark-reg"]')?.checked,
    bleed:        el?.querySelector<HTMLInputElement>('[data-action="mark-bleed"]')?.checked,
    colorBars:    el?.querySelector<HTMLInputElement>('[data-action="mark-bars"]')?.checked,
    provenance:   el?.querySelector<HTMLInputElement>('[data-action="mark-prov"]')?.checked,
  });
}

// Visual formats a ZIP export bundles (data/text and video are excluded). The
// shell passes these as opts.bundleFormats; the export bridge renders each and
// archives them (see renderZip).
const ZIP_BUNDLE = new Set(['png', 'jpg', 'jpeg', 'webp', 'webp-anim', 'avif', 'svg', 'svg-anim', 'emf', 'eps', 'eps-cmyk', 'dxf', 'pdf', 'pdf-cmyk', 'cmyk-tiff', 'tiff', 'gif', 'apng', 'ico']);

// Which video containers this browser's MediaRecorder can actually record.
// Safari/iOS = mp4 only; Firefox = webm only; recent Chrome = both. Used to gate
// the video format options so users only ever see what their browser can produce.
const VIDEO = videoSupport();
// Print TIFF is desktop-only with working canvas readback (see cmykTiffSupport);
// hide it everywhere it can't be produced or cleanly downloaded.
const CMYK_TIFF_OK = cmykTiffSupport();
const TIFF_OK = tiffSupport();
const keepFormat = (f: string): boolean =>
  f === 'webm' ? VIDEO.webm
  : f === 'mp4' ? VIDEO.mp4
  : f === 'cmyk-tiff' ? CMYK_TIFF_OK
  : f === 'tiff' ? TIFF_OK
  : true;

const fmtLabel = (f: string): string => FMT_LABEL[f] ?? f.toUpperCase();

// Download extension follows the produced Blob — a deep-linked video request may
// fall back to the other container, so trust the Blob's MIME over the format id.
function extFor(fmt: string, blob: Blob | null | undefined): string {
  const t = blob?.type || '';
  if (t.includes('mp4'))  return 'mp4';
  if (t.includes('webm')) return 'webm';
  return FMT_EXT[fmt] ?? fmt;
}

// fitCanvas and exportUnscaled are passed in so refreshCanvasPreview and the
// export actions can coordinate with the responsive-scaling logic in mountTool.
function renderActions(el: PanelEl | null, manifest: ToolManifest, runtime: ToolRuntime, canvasEl: HTMLElement | null, host: WebToolHost, fitCanvas: () => void, exportUnscaled: ExportUnscaled, exportDefaults: ExportDefaults = {}, onUrlSync: ((key?: string) => void) | null = null, playShutter: () => void = () => {}, fileIntoFolder: string | null = null, returnTo = '/', initialSlot: string | null = null): ActionsApi | undefined {
  // The slot this editing session writes to. Seeded from a resumed `?slot=` session,
  // otherwise null until the first save mints one. Every subsequent save (the Save
  // button, the render-pill quick-Save, "Save & leave") reuses it so edits UPDATE the
  // same saved session in place instead of spawning a new one on each save. Without
  // this, re-saving after an edit orphaned a fresh copy in Uncategorised and left the
  // original folder card frozen at its first-save state.
  let activeSlot = initialSlot;
  // Shareable-link button (wired by wireUpCopyUrl). A link glyph + label; the
  // label is swapped to "Copied!" on click, so it's wrapped in its own span to
  // keep the icon. Lives at the foot of the actions bar — after the render
  // (Download) button, so on mobile it stacks behind it.
  const copyUrlBtn = `<button type="button" data-action="copy-url" class="copy-url-btn btn" title="Copy a shareable link" aria-label="Share"><svg class="copy-url-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></svg><span data-copy-url-label>Share</span></button>`;

  // Save glyph — a tray with a down-arrow (matches the Feather "download" mark),
  // line-art to sit consistently beside the Copy and Share icons.
  const SAVE_SVG = `<svg class="save-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

  // The exact payload a save persists — live input values plus the `__` markers
  // (tool identity + export settings). Shared by performSave and the "Make
  // variants" action so a variant is byte-for-byte a normal saved session.
  function sessionSnapshot(): Record<string, unknown> & { __export_format: string } {
    const values: Record<string, InputValue> = Object.fromEntries(runtime.getModel().map(i => [i.id, i.value]));
    // The effective export format (user-selected, or the tool's default). Drives
    // a vector (SVG) thumbnail for vector tools — see captureThumbnail.
    const fmt = el?.querySelector<HTMLSelectElement>('[data-action="format"]')?.value ?? '';
    return {
      ...values,
      __toolId:          manifest.id,
      __toolVersion:     manifest.version,
      __export_filename: el?.querySelector<HTMLInputElement>('[data-action="filename"]')?.value.trim() ?? '',
      __export_format:   fmt,
      __export_width:    el?.querySelector<HTMLInputElement>('[data-action="export-width"]')?.value ?? '',
      __export_height:   el?.querySelector<HTMLInputElement>('[data-action="export-height"]')?.value ?? '',
      __export_unit:     el?.querySelector<HTMLSelectElement>('[data-action="export-unit"]')?.value ?? 'px',
      __export_dpi:      el?.querySelector<HTMLInputElement>('[data-action="export-dpi"]')?.value ?? '',
      __export_profile:  el?.querySelector<HTMLSelectElement>('[data-action="cmyk-profile"]')?.value ?? '',
      __export_bleed:    readBleed(el),
      __export_marks:    readMarks(el),
    };
  }

  // Shared, awaitable save routine — used by the Save button AND the
  // unsaved-changes dialog's "Save & leave". Returns true on success. Always
  // re-enables the button and surfaces failures: a save error used to leave the
  // button stuck on "Saving…" silently, which made "Save & leave" appear to do
  // nothing (and then click a now-disabled button — a no-op). The thumbnail is
  // best-effort (captureThumbnail swallows its own errors), so it never blocks a save.
  async function performSave(saveBtnEl?: HTMLElement | null): Promise<boolean> {
    const btn = (saveBtnEl ?? el?.querySelector('[data-action="save"]')) as HTMLButtonElement | null;
    if (!btn || btn.dataset.saving) return false;
    const label = btn.querySelector<HTMLElement>('[data-save-label]') ?? btn;
    const idle  = label.textContent;
    btn.dataset.saving = '1';
    btn.disabled = true;
    label.textContent = 'Saving…';
    try {
      // Reuse the session's slot after the first save (or when resuming an existing
      // session) so a re-save updates it in place; only mint a new slot the first time.
      const slot  = activeSlot || `${manifest.id}:${Date.now()}`;
      const data  = sessionSnapshot();
      const thumb = await captureThumbnail(manifest, canvasEl, runtime, exportUnscaled, data.__export_format);
      await host.state.save(slot, data, thumb);
      // Remember the slot so the next save updates THIS session rather than creating a
      // duplicate (see activeSlot above). Set before filing so a fresh first-save is
      // both filed into its folder AND pinned as the active slot for later edits.
      activeSlot = slot;
      // File a freshly-created session into the folder the Projects "+ New tool" flow
      // launched from (claimed at mount into fileIntoFolder — empty value = root/uncat
      // = null = no filing). One-shot, best-effort, never blocks the save.
      if (fileIntoFolder) {
        try {
          const { createFolderStore } = await import('../folders.js');
          await createFolderStore(host as unknown as Parameters<typeof createFolderStore>[0]).moveItem(slot, fileIntoFolder, 'session');
        } catch (e) { /* filing is best-effort */ }
        fileIntoFolder = null;
      }
      label.textContent = 'Saved';
      announce('Saved');
      return true;                              // leave the button as-is; the caller navigates away
    } catch (e) {
      console.error('Save failed:', e);
      label.textContent = idle;
      btn.disabled = false;
      delete btn.dataset.saving;
      announce('Save failed');
      return false;
    }
  }

  if (manifest.render.export === false) {
    if (!el) return;
    const hasInputs = (manifest.inputs?.length ?? 0) > 0;
    // An explicit empty actions list opts out of the default Save+Share bar — for
    // on-device file utilities that provide their own download button and must
    // NOT persist the user's file bytes to storage (Save would write them to
    // IndexedDB, contradicting the "nothing is stored/uploaded" promise).
    const optedOut = Array.isArray(manifest.render.actions) && manifest.render.actions.length === 0;
    if (!hasInputs || optedOut) { el.innerHTML = ''; return {}; }
    el.innerHTML = `<div class="export-action-buttons"><button data-action="save" data-sfx="save" class="save-btn">${SAVE_SVG}<span data-save-label>Save</span></button>${copyUrlBtn}</div>`;
    el.querySelector<HTMLButtonElement>('[data-action="save"]')!.addEventListener('click', async function (this: HTMLButtonElement) {
      if (await performSave(this)) setTimeout(() => { navigateTo(returnTo); }, 800);
    });
    return { save: performSave };
  }

  const actions    = manifest.render.actions ?? ['copy', 'download', 'save'];
  const exportOpts = runtime.getModel().filter(i => i.group === 'export' && i.control === 'checkbox');
  const isAnimatedFmt = (f: string | undefined): boolean => f === 'webm' || f === 'mp4' || f === 'gif' || f === 'apng' || f === 'webp-anim' || f === 'svg-anim';
  // True video containers only — gif/apng are animated but can't carry audio.
  const isVideoFmt    = (f: string | undefined): boolean => f === 'webm' || f === 'mp4';
  // Mirrors VECTOR_FORMATS in engine/src/inputs.js — formats where text→path
  // outlining (the 'Convert paths' toggle) applies. Bitmap formats don't.
  const isVectorFmt   = (f: string | undefined): boolean => f === 'svg' || f === 'pdf' || f === 'pdf-cmyk';
  // Show only the video containers this browser can record (Safari→mp4, Firefox→webm,
  // recent Chrome→both); non-video formats always pass. See keepFormat / VIDEO.
  const formats       = manifest.render.formats.filter(keepFormat);
  const hasAnimated   = formats.some(isAnimatedFmt);
  const initialFmt    = (exportDefaults.format && formats.includes(exportDefaults.format)) ? exportDefaults.format : formats[0];
  const videoDefaults = (manifest.render.video ?? {}) as { wait?: number; duration?: number };
  const defaultWait     = videoDefaults.wait     ?? 1;
  const defaultDuration = videoDefaults.duration ?? 5;

  // Directional glyphs that live inside the dimension inputs: ↔ marks width,
  // ↕ marks height, so the two fields read as "wide × tall" without labels.
  const ICON_W = `<svg class="dim-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 8 3 12 7 16"/><polyline points="17 8 21 12 17 16"/><line x1="4" y1="12" x2="20" y2="12"/></svg>`;
  const ICON_H = `<svg class="dim-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`;

  // Tier 1 — filename · format. The format selector is the highest-priority
  // control; the filename rides alongside it as the natural "name.format" pair.
  const filenameRow = `
      <div class="filename-extension">
        <input type="text" class="export-filename" data-action="filename"
              value="${escape(exportDefaults.filename ?? manifest.name)}" placeholder="filename" spellcheck="false">
        ${formats.length > 1 ? `
          <select data-action="format" aria-label="Export format">
            ${formats.map(f => `<option value="${f}" ${f === initialFmt ? 'selected' : ''}>${fmtLabel(f)}</option>`).join('')}
          </select>
        ` : ''}
      </div>`;

  // Tier 2 — dimensions. The primary sizing control: full-width, prominent,
  // with the directional icon inside each field.
  const initUnit = exportDefaults.unit ?? 'px';
  const initDpi  = exportDefaults.dpi ?? 300;
  const dimsRow = manifest.render.dims !== false ? `
      <div class="export-dims">
        <div class="dim-field">
          ${ICON_W}
          <input type="number" data-action="export-width" data-scrub aria-label="Width"
                 value="${exportDefaults.width ?? manifest.render.width}" min="1" max="100000" step="any">
        </div>
        <div class="dim-field">
          ${ICON_H}
          <input type="number" data-action="export-height" data-scrub aria-label="Height"
                 value="${exportDefaults.height ?? manifest.render.height}" min="1" max="100000" step="any">
        </div>
        ${manifest.render.units === false ? '' : `
        <select class="dim-unit" data-action="export-unit" aria-label="Units"
                title="Units for width & height. Physical units (mm/cm/in/pt) export at the right size for print — PDF as a true page, raster at the chosen DPI.">
          ${UNITS.map(u => `<option value="${u}" ${u === initUnit ? 'selected' : ''}>${u}</option>`).join('')}
        </select>
        <label class="dim-dpi" data-dpi-field style="display:${initUnit === 'px' ? 'none' : 'inline-flex'}"
               title="Raster resolution for physical units (ignored for vector formats).">
          <input type="number" data-action="export-dpi" value="${initDpi}" min="36" max="1200" step="1" aria-label="DPI">
          <span>DPI</span>
        </label>`}
      </div>` : '';

  // Editor-only aspect-ratio guard (manifest.render.aspectWarning). A hidden alert
  // beside the dimension controls, shown when the chosen page size falls outside the
  // tool's supported orientation band — see updateAspectWarning(). Never exported.
  const ICON_WARN = `<svg class="aspect-warn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  const aspectWarnRow = (manifest.render.aspectWarning && manifest.render.dims !== false)
    ? `<div class="export-aspect-warning" data-aspect-warning role="alert" hidden>${ICON_WARN}<span data-aspect-warning-text></span></div>`
    : '';

  // Tier 2.5 — colour profile (Print PDF only). The CMYK press condition embedded
  // in the PDF's OutputIntent. A self-contained card so this professional/print
  // setting reads as deliberate; revealed only when "Print PDF" (pdf-cmyk) is the
  // chosen format. Options come from the engine's CMYK_CONDITIONS registry.
  const ICON_DROP = `<svg class="cmyk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.7s6.5 7 6.5 11.8a6.5 6.5 0 0 1-13 0C5.5 9.7 12 2.7 12 2.7z"/></svg>`;
  const hasCmyk     = formats.includes('pdf-cmyk') || formats.includes('cmyk-tiff');
  const initProfile = (exportDefaults.profile && (CMYK_CONDITIONS as Record<string, unknown>)[exportDefaults.profile])
    ? exportDefaults.profile : DEFAULT_CMYK_CONDITION;
  const cmykOptions = Object.entries(CMYK_CONDITIONS)
    .map(([key, c]) => `<option value="${escape(key)}" ${key === initProfile ? 'selected' : ''}>${escape((c as { info?: string }).info)}</option>`)
    .join('');
  const cmykRow = hasCmyk ? `
      <div class="section-card export-cmyk" data-cmyk-only style="display:${isCmykFmt(initialFmt) ? 'flex' : 'none'}">
        <span class="cmyk-head">${ICON_DROP}<span>Color profile</span></span>
        <select data-action="cmyk-profile" aria-label="CMYK press profile"
                title="The CMYK press condition your printer targets — embedded as the Print PDF's output intent, recorded in the Print TIFF's metadata.">
          ${cmykOptions}
        </select>
        <p class="cmyk-hint">Names the CMYK press standard your printer targets — the Print PDF embeds it as its output intent; the Print TIFF records it in metadata (the pixels stay untagged DeviceCMYK).</p>
      </div>` : '';

  // Tier 2.6 — PDF password (standard "PDF" only). A non-empty value locks the
  // exported PDF on open (jsPDF standard security handler, copy/modify restricted).
  // Revealed only when "PDF" is chosen — the print-PDF path (pdf-cmyk) re-saves
  // through pdf-lib, which can't write encrypted PDFs.
  //
  // URL-expressible by design: a `?password=` link can pre-set it for quick,
  // short-lived transactional use (event materials etc). That's clear-text in the
  // URL — an accepted trade-off for a basic lock, not for confidential material.
  // It is NOT persisted to the library at rest (see performSave); URL is the only
  // way it round-trips. The initial value below comes from the URL only.
  // Collapsed by default — a click-to-expand disclosure (mirrors the Print marks
  // card) so the field + caveat only surface when wanted, keeping the panel tight.
  // Pre-opened when a value arrives (e.g. ?password=) so it's visible. Collapse is
  // purely visual: the input remains the source of truth, so a typed value still
  // applies on export and survives collapse/expand.
  const ICON_LOCK = `<svg class="pdfpass-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  // The lock card serves both the PDF password tiers AND the ZIP bundle lock (the
  // engine's two-tier zip-crypto: standard ZipCrypto / strong AES-256). refreshLockTier
  // rewords the tier options + hint per format.
  const hasPdf = formats.includes('pdf');
  const hasZip = formats.includes('zip');
  const pdfPassInitOpen = Boolean(exportDefaults.password);
  const pdfPassRow = (hasPdf || hasZip) ? `
      <div class="section-card export-pdfpass${pdfPassInitOpen ? ' is-open' : ''}" data-pdf-only style="display:${(initialFmt === 'pdf' || initialFmt === 'zip') ? 'flex' : 'none'}">
        <button type="button" class="pdfpass-head" data-action="pdfpass-toggle" aria-expanded="${pdfPassInitOpen}">${ICON_LOCK}<span>Password protect</span></button>
        <div class="pdfpass-body" data-pdfpass-body style="display:${pdfPassInitOpen ? 'flex' : 'none'}">
          <input type="password" data-action="pdf-password" autocomplete="new-password" spellcheck="false"
                 value="${escape(exportDefaults.password ?? '')}"
                 placeholder="Leave blank for no password" aria-label="Open password">
          <select class="pdfpass-tier" data-action="pdf-lock-tier" aria-label="Encryption strength">
            <option value="standard">Standard lock — opens in any PDF app</option>
            <option value="strong">Strong · AES-256 — newer apps only ⓘ</option>
          </select>
          <p class="pdfpass-hint" data-pdfpass-hint>Requires this password to open the PDF. A basic 40-bit lock — it opens in any PDF app and travels in a share link, so treat it as a deterrent, not protection for confidential files.</p>
        </div>
      </div>` : '';

  // Tier 2.65 — Content Credentials, shown for every stampable container
  // (engine C2PA_FORMATS: pdf, png/apng, jpg, gif, svg, tiff, webp, mp4, webm).
  // Checking
  // it embeds a signed C2PA manifest into the finished bytes (the export
  // bridge stamps at the end of renderFormat — see stampC2pa in
  // bridge/export.js). For PDFs it is mutually exclusive with the
  // open-password: an encrypted document can't take the C2PA incremental
  // update (see refreshC2paUi). A tool pre-selects it via manifest render.c2pa.
  const ICON_CRED = `<svg class="c2pa-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 11.5 2 2 4-4"/></svg>`;
  // ?c2pa= (parsed { on, days }) beats the tool's render.c2pa default; the days
  // value pre-selects the ephemeral-lifetime picker below.
  const c2paInitOn = exportDefaults.c2pa ? exportDefaults.c2pa.on : c2paDefaultOn(manifest);
  const c2paInitDays = [7, 30, 90, 365].includes(exportDefaults.c2pa?.days as number) ? exportDefaults.c2pa!.days : 30;
  const c2paFormats = formats.filter(isC2paFmt);
  // The old always-visible explanation moves behind an info (?) tip so the card
  // reads as just "C2PA Credentials" + a toggle. The tip links to OUR on-device
  // /verify page (not the Adobe-run contentcredentials.org checker) so people can
  // confirm their own exports here.
  const c2paTip = c2paFormats.length ? helpTip(
    'Embeds a signed C2PA manifest recording that this file was made with Lolly — plus your name when profile details are on. '
    + 'Signed on-device, so viewers show it as an unverified credential unless you enrol a verified identity (Profile → Content Credentials).',
    { href: '#/verify', text: 'Check a file →' }
  ) : null;
  const c2paRow = c2paFormats.length ? `
      <div class="section-card export-c2pa" data-c2pa-only style="display:${isC2paFmt(initialFmt) || initialFmt === 'zip' ? 'flex' : 'none'}">
        <label class="c2pa-enable help-tip-host">
          <input type="checkbox" data-action="pdf-c2pa" ${c2paInitOn ? 'checked' : ''}>
          <span class="c2pa-head">${ICON_CRED}<span>C2PA Credentials</span></span>
          ${c2paTip!.button}
          ${c2paTip!.pop}
        </label>
        <p class="c2pa-hint" data-c2pa-webm style="display:${initialFmt === 'webm' ? 'block' : 'none'}">WebM credentials are Lolly's own mapping for now — external C2PA viewers can't read WebM.</p>
        <div class="c2pa-life" data-c2pa-life>
          <label class="c2pa-life-pick">Credential expires in
            <select data-action="c2pa-days" aria-label="Credential lifetime">
              ${[7, 30, 90, 365].map(d => `<option value="${d}"${d === c2paInitDays ? ' selected' : ''}>${d} days</option>`).join('')}
            </select>
          </label>
        </div>
      </div>` : '';

  // Tier 2.66 — the Lolly pixel imprint (engine pixel-watermark.ts): a durable,
  // imperceptible mark mixed into the exported pixels. It completes the provenance
  // story next to the C2PA card above — the credential is strippable, the pixel
  // mark survives re-encodes/screenshots, and /verify detects both. Off by
  // default; an ?imprint= link pre-checks it, and the toggle round-trips back
  // into the URL (see views/tool.ts syncUrl).
  const imprintFmts = formats.filter(isImprintFmt);
  const imprintTip = imprintFmts.length ? helpTip(
    t('Hides the Lolly Imprint — a durable, invisible watermark — in the image pixels. It survives re-encoding and screenshots, so any copy of the file can be recognised later.'),
    { href: '#/verify', text: t('Check a file →') }
  ) : null;
  const imprintRow = imprintFmts.length ? `
      <div class="section-card export-c2pa export-imprint" data-imprint-only style="display:${isImprintFmt(initialFmt) || initialFmt === 'zip' ? 'flex' : 'none'}">
        <label class="c2pa-enable help-tip-host">
          <input type="checkbox" data-action="imprint" ${exportDefaults.imprint ? 'checked' : ''}>
          <span class="c2pa-head">${icon('imprint', { className: 'c2pa-icon' })}<span>${t('Lolly Imprint')}</span></span>
          ${imprintTip!.button}
          ${imprintTip!.pop}
        </label>
      </div>` : '';

  // Tier 2.7 — print marks & bleed (pdf / pdf-cmyk / cmyk-tiff). An opt-in card
  // (master checkbox) so ordinary output stays trim-sized; turning it on reveals a
  // bleed field (default 3mm) + the mark toggles at print-standard defaults. Mark
  // size, gap and stroke weight are fixed in the engine (see print-marks.js).
  const ICON_CROP = `<svg class="print-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v16h16"/><path d="M2 6h16v16"/></svg>`;
  // Print finishing applies to a single trim-sized artwork; tools that emit
  // per-page boxes (multi-page PDF) opt out via render.printMarks:false so the
  // card isn't shown promising marks the multi-page export path doesn't apply.
  const hasPrint     = (hasPdf || hasCmyk) && manifest.render.printMarks !== false;
  const printInitOn  = Boolean(exportDefaults.bleed || exportDefaults.marks);
  const printInitMm  = exportDefaults.bleed ? (parseFloat(exportDefaults.bleed) || 3) : 3;
  // Colour bars default ON for the CMYK print formats (the press uses them as a
  // control strip), OFF for the RGB pdf. An explicit marks default (link/save) wins.
  // 'Stamp details' (provenance) is always pre-checked: the credit stamp is on by
  // default whenever the print-marks card is enabled, regardless of any remembered
  // marks state. The other marks still restore from saved/linked defaults.
  const pim          = { ...DEFAULT_PRINT_MARKS, colorBars: isCmykFmt(initialFmt), ...(exportDefaults.marks || {}), provenance: true };
  const printRow = hasPrint ? `
      <div class="section-card export-print" data-printmarks-only style="display:${isPrintFmt(initialFmt) ? 'flex' : 'none'}">
        <label class="print-enable">
          <input type="checkbox" data-action="print-enable" ${printInitOn ? 'checked' : ''}>
          <span class="print-head">${ICON_CROP}<span>Print marks &amp; bleed</span></span>
        </label>
        <div class="print-body" data-print-body style="display:${printInitOn ? 'flex' : 'none'}">
          <label class="print-bleed">
            <span>Bleed</span>
            <input type="number" data-action="print-bleed" value="${printInitMm}" min="0" max="25" step="0.5" aria-label="Bleed in millimetres">
            <span>mm</span>
          </label>
          <div class="print-toggles">
            <label class="export-option"><input type="checkbox" data-action="mark-crop" ${pim.crop ? 'checked' : ''}> Crop</label>
            <label class="export-option"><input type="checkbox" data-action="mark-reg" ${pim.registration ? 'checked' : ''}> Registration</label>
            <label class="export-option"><input type="checkbox" data-action="mark-bleed" ${pim.bleed ? 'checked' : ''}> Bleed</label>
            <label class="export-option"><input type="checkbox" data-action="mark-bars" ${pim.colorBars ? 'checked' : ''}> Color bars</label>
            <label class="export-option"><input type="checkbox" data-action="mark-prov" ${pim.provenance ? 'checked' : ''}> Stamp details</label>
          </div>
          <p class="print-hint">Adds bleed and the chosen marks for a print shop; the artwork is scaled to fill the bleed. Registration marks print on all four plates in the Print PDF and Print TIFF. (An open-password can't be combined with marks.)</p>
        </div>
      </div>` : '';

  // Tier 2.8 — "Content protection": one collapsed disclosure folding the four
  // provenance/protection cards above (password, C2PA, Imprint, print marks &
  // bleed) so the panel shows one header instead of up to four separate boxes.
  // Purely a wrapping shell — none of the four cards' own markup, classes,
  // data-actions, defaults or per-format [data-*-only] gating changes; this
  // only adds one more OUTER layer of visibility on top (see refreshPrintUi,
  // which also owns hiding the whole wrapper when NONE of the four apply to
  // the selected format — e.g. a text/data format like csv/json/ics).
  const hasProtection = hasPdf || hasZip || c2paFormats.length > 0 || imprintFmts.length > 0 || hasPrint;
  // Pre-opened whenever any inner card would itself arrive pre-opened/pre-set —
  // a URL-sourced password, an on-by-default C2PA credential, a linked imprint
  // flag, or a linked bleed/marks value — so a deep link still surfaces its
  // setting without an extra click.
  const protectionOpen = pdfPassInitOpen || c2paInitOn || Boolean(exportDefaults.imprint) || printInitOn;
  // Matches the canonical per-format predicates the four cards already use
  // (isC2paFmt/isImprintFmt/isPrintFmt, plus the password card's pdf/pdf-cmyk/zip
  // set) — never loosened, just OR'd together to decide the outer wrapper.
  const protectionVisibleInitial = (initialFmt === 'pdf' || initialFmt === 'pdf-cmyk' || initialFmt === 'zip')
    || isC2paFmt(initialFmt) || isImprintFmt(initialFmt) || isPrintFmt(initialFmt);
  const protectionRow = hasProtection ? `
      <div class="section-card export-protection${protectionOpen ? ' is-open' : ''}" data-protection-section style="display:${protectionVisibleInitial ? 'flex' : 'none'}">
        <button type="button" class="protection-head" data-action="protection-toggle" aria-expanded="${protectionOpen}">${icon('shield', { className: 'protection-icon' })}<span>Content protection</span></button>
        <div class="protection-body" data-protection-body style="display:${protectionOpen ? 'flex' : 'none'}">
          ${pdfPassRow}${c2paRow}${imprintRow}${printRow}
        </div>
      </div>` : '';

  // Tier 3 — ancillary settings. Everything optional (transparent bg, timing,
  // dithering) lives in one wrapping chip cluster so the panel reads consistently
  // no matter which controls a given tool/format enables.
  const optionChips = exportOpts.map(i => {
    // 'Convert paths' only affects vector output, so its chip is gated to the
    // selected format (hidden for png/jpg/etc). Other export options are global.
    const vectorOnly = i.id === 'convertPaths';
    const hide = vectorOnly && !isVectorFmt(initialFmt);
    return `
        <label class="export-option"${vectorOnly ? ' data-vector-only' : ''}${hide ? ' style="display:none"' : ''}>
          <input type="checkbox" data-input-id="${escape(i.id)}" ${i.value ? 'checked' : ''}>
          ${escape(i.label ?? i.id)}
        </label>`;
  }).join('');
  const videoChip = hasAnimated ? `
        <div class="video-params" data-anim-params style="display:${isAnimatedFmt(initialFmt) ? 'flex' : 'none'}">
          <span class="vp-field"><span>Wait</span>
            <input type="number" data-action="video-wait" value="${defaultWait}" min="0" max="30" step="0.5"><span>s</span></span>
          <span class="vp-field"><span>Duration</span>
            <input type="number" data-action="video-duration" value="${defaultDuration}" min="1" max="60" step="0.5"><span>s</span></span>
          <label class="gif-dither-toggle" data-gif-only
                 style="display:${initialFmt === 'gif' ? 'flex' : 'none'}">
            <input type="checkbox" data-action="gif-dither">
            Dither
          </label>
          <label class="gif-dither-toggle" data-webm-only
                 style="display:${initialFmt === 'webm' ? 'flex' : 'none'}">
            <input type="checkbox" data-action="webm-60fps">
            60fps
          </label>
          ${liveCaptureSupport() ? `<label class="gif-dither-toggle" data-video-only
                 style="display:${isVideoFmt(initialFmt) ? 'flex' : 'none'}"
                 title="Record the on-screen preview in real time through a screen share — motion matches exactly what you see. Pick this tab in the share dialog and keep it visible for the whole take.">
            <input type="checkbox" data-action="video-live">
            Record live
          </label>` : ''}
          ${runtime.hasFrameHook ? `<span class="vp-live-hint" style="flex-basis:100%;font-size:11px;opacity:.7;margin-top:2px">Records the live feed — start <strong>Go&nbsp;live</strong> on the canvas first.</span>` : ''}
        </div>` : '';
  // Audio track card — webm/mp4 only. An optional catalog music bed (type:
  // 'audio', suse/music/*) muxed into the recording; it plays for the clip
  // duration, looping when the clip outlasts the track. Options are filled
  // async from host.assets.query once per mount (see below) — the selection is
  // popup-local like wait/duration, never serialized into URLs or share links.
  const ICON_NOTE = `<svg class="audio-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  const ICON_PLAY  = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.79-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z"/></svg>`;
  const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>`;
  const hasVideo = formats.some(isVideoFmt);
  // The "plays for the clip duration, loops as needed, WebM/MP4 only" note moves
  // behind the same inline (i) tip the sidebar's input helpers use, so the card
  // stays compact — heading + track picker, with the explanation on demand.
  const audioTip = hasVideo ? helpTip(
    'Plays under the clip for its full duration, looping as needed. WebM and MP4 only.'
  ) : null;
  // A tool with its own audio slot (assetType 'audio', e.g. the audiogram) offers
  // that slot's CURRENT pick as a bed source — resolved live at export, so changing
  // the sidebar pick needs no popup round-trip. "Generate music" composes a seeded
  // ZzFXM tune on-device (engine composeSong → the render worker → transient WAV).
  const hasToolAudioInput = runtime.getModel().some(i => i.type === 'asset' && i.assetType === 'audio');
  const audioRow = hasVideo ? `
      <div class="export-audio" data-video-only style="display:${isVideoFmt(initialFmt) ? 'flex' : 'none'}">
        <span class="audio-head help-tip-host">${ICON_NOTE}<span>Audio track</span>${audioTip!.button}${audioTip!.pop}</span>
        <div class="audio-pick">
          <select data-action="video-audio" aria-label="Audio track"
                  title="Optional music bed muxed into the recording — plays for the clip duration, looping if the clip is longer than the track.">
            <option value="">None</option>
            ${hasToolAudioInput ? `<option value="__tool__">${escape(t('This tool’s audio'))}</option>` : ''}
            <option value="__generate__">${escape(t('Generate music'))}</option>
          </select>
          <button type="button" class="audio-preview" data-action="audio-preview" title="Preview track" aria-label="Preview track" disabled>${ICON_PLAY}</button>
          <button type="button" class="audio-preview" data-action="audio-regen" hidden title="${escape(t('Regenerate music'))}" aria-label="${escape(t('Regenerate music'))}">${icon('refresh')}</button>
        </div>
        <div class="audio-fade">
          <label>Fade in <input type="number" data-action="audio-fadein" min="0" max="5" step="0.5" value="1"><span>s</span></label>
          <label>Fade out <input type="number" data-action="audio-fadeout" min="0" max="5" step="0.5" value="1.5"><span>s</span></label>
        </div>
        <div class="audio-fade">
          <label>Music level <input type="number" data-action="audio-volume" min="0" max="100" step="5" value="100"><span>%</span></label>
          <label title="When your clip has its own sound, the music dips to this level under it (100% = no ducking).">Duck to <input type="number" data-action="audio-duck" min="0" max="100" step="5" value="35"><span>%</span></label>
        </div>
      </div>` : '';

  // Full-page chip — HTML export only. Drops the fixed-size tool-canvas frame so
  // the saved page fills the whole browser window instead of a centred card.
  const hasHtml  = formats.includes('html');
  const htmlChip = hasHtml ? `
        <label class="export-option" data-html-only style="display:${initialFmt === 'html' ? 'flex' : 'none'}"
               title="Drop the fixed-size canvas frame so the saved page fills the whole window.">
          <input type="checkbox" data-action="full-page" ${exportDefaults.nostage ? 'checked' : ''}>
          Full page
        </label>` : '';
  const settingsRow = (optionChips || videoChip || htmlChip)
    ? `<div class="export-settings">${optionChips}${htmlChip}${videoChip}</div>`
    : '';

  // Tier 4 — actions. Copy · Save · Share share one equal-width row; Download is
  // the primary CTA, alone on its own full-width line at the very bottom.
  const CLIPBOARD_SVG = `<svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`;
  const copyBtn = actions.includes('copy')
    ? `<button data-action="copy" class="copy-btn" title="Copy to clipboard">${CLIPBOARD_SVG}<span>Copy</span></button>` : '';
  const saveBtn = actions.includes('save')
    ? `<button data-action="save" data-sfx="save" class="save-btn" title="Save to your library">${SAVE_SVG}<span data-save-label>Save</span></button>` : '';
  const downloadBtn = actions.includes('download')
    ? `<button data-action="download">Download${formats.length === 1 ? ' ' + fmtLabel(formats[0]!) : ''}</button>`
    : '';
  const secondaryRow = `<div class="export-action-buttons">${copyBtn}${saveBtn}${copyUrlBtn}</div>`;
  const downloadRow = downloadBtn ? `<div class="export-action-buttons">${downloadBtn}</div>` : '';

  // The panel host (#tool-actions) is present for every export-capable tool that
  // reaches here; guard the type for strict null-safety (never null in practice).
  if (!el) return;
  el.innerHTML = `
    ${actions.includes('download') ? `${filenameRow}${dimsRow}${aspectWarnRow}${cmykRow}${protectionRow}${audioRow}${settingsRow}` : ''}
    ${secondaryRow}
    ${downloadRow}
  `;

  exportOpts.forEach(i => {
    el.querySelector<HTMLInputElement>(`[data-input-id="${escape(i.id)}"]`)
      ?.addEventListener('change', ({ target }) => runtime.setInput(i.id, (target as HTMLInputElement).checked));
  });

  const animParamsEl  = el.querySelector<HTMLElement>('[data-anim-params]');
  const ditherEl      = el.querySelector<HTMLElement>('[data-gif-only]');
  const webm60El      = el.querySelector<HTMLElement>('[data-webm-only]');
  const formatEl      = el.querySelector<HTMLSelectElement>('[data-action="format"]');
  const aspectWarnEl  = el.querySelector<HTMLElement>('[data-aspect-warning]');

  // Fill the audio-track select from the catalog (music beds, type: 'audio').
  // Once per mount — the popup DOM persists across open/close. Tolerates an
  // empty store (first visit before catalog sync finishes) and offline: the
  // select simply keeps its "None" option.
  const audioSel = el.querySelector<HTMLSelectElement>('[data-action="video-audio"]');
  if (audioSel) {
    host.assets.query({ type: 'audio' }).then(tracks => {
      const tagsOf = (t: typeof tracks[number]): string[] => (t.meta?.tags as string[] | undefined) ?? [];
      const isLoop = (t: typeof tracks[number]): boolean => tagsOf(t).includes('neurospicy') || tagsOf(t).includes('loop');
      const byName = (a: typeof tracks[number], b: typeof tracks[number]): number => String(a.meta?.name ?? a.id).localeCompare(String(b.meta?.name ?? b.id));
      const opt = (t: typeof tracks[number]): HTMLOptionElement => {
        const o = document.createElement('option');
        o.value = t.id;
        o.textContent = String(t.meta?.name ?? t.id.split('/').pop() ?? '');
        return o;
      };
      // Focus loops FIRST — any FEATURED_LOOPS up top via loopRank, the rest alphabetical
      // — then the licensed music beds below.
      const loops = tracks.filter(isLoop).sort((a, b) => loopRank(a.id) - loopRank(b.id) || byName(a, b));
      if (loops.length) {
        const grp = document.createElement('optgroup');
        grp.label = 'Focus loops (Neurospicy)';
        loops.forEach(t => grp.appendChild(opt(t)));
        audioSel.appendChild(grp);
      }
      const music = tracks.filter(t => !isLoop(t)).sort(byName);
      if (music.length) {
        const grp2 = document.createElement('optgroup');
        grp2.label = 'Music beds';
        music.forEach(t => grp2.appendChild(opt(t)));
        audioSel.appendChild(grp2);
      }
    }).catch(() => { /* pre-sync/offline — leave "None" only */ });
  }

  // The tool's own audio slot (assetType 'audio'), read LIVE from the model so the
  // popup always reflects the current sidebar pick. Returns the narrow ref shape
  // the bed paths need; null when the slot is empty or the tool has none.
  const toolAudioRef = (): { id?: string; url?: string; format?: string } | null => {
    const v = runtime.getModel().find(i => i.type === 'asset' && i.assetType === 'audio')?.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const r = v as { id?: unknown; url?: unknown; format?: unknown };
    const ref = {
      id:     typeof r.id === 'string' ? r.id : undefined,
      url:    typeof r.url === 'string' ? r.url : undefined,
      format: typeof r.format === 'string' ? r.format : undefined,
    };
    return ref.id || ref.url ? ref : null;
  };
  // Resolve that slot to a fetchable { url, format }: the asset store when the ref
  // has an id (same on-demand fetch+cache the catalog beds use), else the ref's own
  // url (a transient upload). Null when nothing is resolvable — export stays silent.
  async function resolveToolAudio(): Promise<{ url: string; format?: string } | null> {
    const ref = toolAudioRef();
    if (!ref) return null;
    if (ref.id) {
      try {
        const r = await host.assets.get(ref.id);
        if (r?.url) return { url: r.url, format: r.format };
      } catch { /* not in the store (transient ref) — fall back to its own url */ }
    }
    return ref.url ? { url: ref.url, format: ref.format } : null;
  }
  // A tool that arrives with a chosen track defaults the bed to it — the user can
  // still pick a catalog track or None. Static markup already carries the option.
  if (audioSel && audioSel.querySelector('option[value="__tool__"]') && toolAudioRef()) audioSel.value = '__tool__';

  // "Generate music": a transient ZzFXM bed, seeded so the SAME tune deterministically
  // re-renders at any length (export re-renders at the clip's duration). Regenerate
  // rolls a new seed. The spec is derived entirely from the seed via the engine's
  // seeded PRNG — archetype, tempo, scale and progression all replayable.
  let genSeed = (Math.random() * 0x7fffffff) >>> 0;
  let genWavUrl: string | null = null;   // cached preview WAV blob URL
  let genWavKey = '';                    // "seed:targetSec" the cache was rendered for
  const genDur = (): number => Math.max(8, Math.min(90, videoParams().duration));
  function generatedSongSpec(seed: number, targetSec: number): SongSpec {
    const rng = mulberry32(seed);
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rng() * a.length)]!;
    const archetype = pick(['melodic', 'ambient', 'lofi', 'bossaNova', 'rhythmic', 'whimsical', 'chiptune', 'cuban'] as const);
    const bpm: Record<typeof archetype, [number, number]> = {
      melodic: [60, 84], ambient: [48, 60], lofi: [66, 84], bossaNova: [108, 126],
      rhythmic: [96, 120], whimsical: [84, 108], chiptune: [132, 160], cuban: [96, 116],
    };
    const scale = pick(['majorPent', 'minorPent', 'suspended'] as const);
    const pool = SCALES[scale].slice(0, 6);   // low register — melodies walk upward from the roots
    return {
      archetype, seed, scale, targetSec,
      bpm: Math.round(bpm[archetype][0] + rng() * (bpm[archetype][1] - bpm[archetype][0])),
      roots: [12, pick(pool), pick(pool), pick(pool)],
      pan: Math.round((rng() - 0.5) * 30) / 100,
    };
  }
  async function generatedWavUrl(targetSec: number): Promise<string> {
    const key = `${genSeed}:${targetSec}`;
    if (genWavUrl && genWavKey === key) return genWavUrl;
    const pcm = await renderSong(composeSong(generatedSongSpec(genSeed, targetSec)));
    if (genWavUrl) URL.revokeObjectURL(genWavUrl);
    genWavUrl = URL.createObjectURL(pcmToWavBlob(pcm));
    genWavKey = key;
    return genWavUrl;
  }

  // Audio preview — a play/pause toggle that auditions the selected track before
  // export. A single detached <audio> element (never in the DOM, so it must be
  // paused explicitly on every teardown path — a removed media element keeps
  // playing). The track bytes are resolved lazily on first play via host.assets.get
  // (same on-demand fetch+cache the export uses), and reset whenever the choice
  // changes. Preview plays once at natural length; export still loops to the clip.
  const audioPreviewBtn = el.querySelector<HTMLButtonElement>('[data-action="audio-preview"]');
  let previewAudio: HTMLAudioElement | null = null;   // lazily-created HTMLAudioElement
  let previewSrcId: string | null = null;   // asset id currently loaded into previewAudio
  const setAudioPreviewPlaying = (playing: boolean): void => {
    if (!audioPreviewBtn) return;
    audioPreviewBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    audioPreviewBtn.classList.toggle('is-playing', playing);
    const label = playing ? 'Pause preview' : 'Preview track';
    audioPreviewBtn.title = label;
    audioPreviewBtn.setAttribute('aria-label', label);
  };
  const stopAudioPreview = (): void => { try { previewAudio?.pause(); } catch { /* not started */ } };
  const syncAudioPreviewEnabled = (): void => {
    if (audioPreviewBtn) audioPreviewBtn.disabled = !(audioSel && audioSel.value);
  };
  // Regenerate ("new tune") shows only while Generate music is the chosen bed.
  const audioRegenBtn = el.querySelector<HTMLButtonElement>('[data-action="audio-regen"]');
  const syncAudioRegenVisible = (): void => {
    if (audioRegenBtn) audioRegenBtn.hidden = audioSel?.value !== '__generate__';
  };
  audioSel?.addEventListener('change', () => { stopAudioPreview(); previewSrcId = null; syncAudioPreviewEnabled(); syncAudioRegenVisible(); });
  if (audioPreviewBtn) {
    audioPreviewBtn.addEventListener('click', async () => {
      const id = audioSel?.value;
      if (!id) return;
      // Key the loaded source so a regenerated tune or a changed sidebar audio pick
      // reloads instead of replaying the stale bytes; catalog ids key as themselves.
      const toolRef = id === '__tool__' ? toolAudioRef() : null;
      const srcKey = id === '__generate__' ? `__generate__:${genSeed}:${genDur()}`
        : id === '__tool__' ? `__tool__:${toolRef?.id ?? toolRef?.url ?? ''}`
        : id;
      if (previewAudio && previewSrcId === srcKey && !previewAudio.paused) { stopAudioPreview(); return; }
      try {
        if (!previewAudio) {
          previewAudio = new Audio();
          previewAudio.preload = 'auto';
          previewAudio.addEventListener('play',  () => setAudioPreviewPlaying(true));
          previewAudio.addEventListener('pause', () => setAudioPreviewPlaying(false));
          previewAudio.addEventListener('ended', () => setAudioPreviewPlaying(false));
        }
        if (previewSrcId !== srcKey) {
          audioPreviewBtn.classList.add('is-loading');
          const url = id === '__generate__' ? await generatedWavUrl(genDur())
            : id === '__tool__' ? (await resolveToolAudio())?.url
            : (await host.assets.get(id)).url;
          if (!url) throw new Error('no track to preview');
          previewAudio.src = url;
          previewSrcId = srcKey;
          audioPreviewBtn.classList.remove('is-loading');
        }
        await previewAudio.play();
      } catch {
        audioPreviewBtn.classList.remove('is-loading');
        setAudioPreviewPlaying(false);
      }
    });
    syncAudioPreviewEnabled();
  }
  if (audioRegenBtn) {
    audioRegenBtn.addEventListener('click', () => {
      genSeed = (Math.random() * 0x7fffffff) >>> 0;
      const wasPlaying = Boolean(previewAudio && !previewAudio.paused);
      stopAudioPreview();
      previewSrcId = null;
      // Mid-audition regenerate rolls straight into the new tune (still within the
      // user's click gesture, so autoplay policy allows it).
      if (wasPlaying) audioPreviewBtn?.click();
    });
    syncAudioRegenVisible();
  }

  // Colour bars track the format: ON for the CMYK print formats (pdf-cmyk /
  // cmyk-tiff), OFF for the RGB pdf, re-applied on every format switch — until the
  // user toggles them, or a shared link set marks explicitly, after which their
  // choice is left alone.
  let barsUserSet = Boolean(exportDefaults.marks);
  const syncBarsDefault = (fmt: string): void => {
    if (barsUserSet) return;
    const bars = el.querySelector<HTMLInputElement>('[data-action="mark-bars"]');
    if (bars) bars.checked = isCmykFmt(fmt);
  };

  // Show/hide timing params and format-specific controls when the format selector changes.
  if (formatEl) {
    formatEl.addEventListener('change', () => {
      const fmt = formatEl.value;
      if (animParamsEl) animParamsEl.style.display = isAnimatedFmt(fmt) ? 'flex' : 'none';
      if (ditherEl)     ditherEl.style.display     = fmt === 'gif'  ? 'flex' : 'none';
      if (webm60El)     webm60El.style.display      = fmt === 'webm' ? 'flex' : 'none';
      el.querySelectorAll<HTMLElement>('[data-vector-only]').forEach(c => { c.style.display = isVectorFmt(fmt) ? 'flex' : 'none'; });
      el.querySelectorAll<HTMLElement>('[data-video-only]').forEach(c => { c.style.display = isVideoFmt(fmt) ? 'flex' : 'none'; });
      if (!isVideoFmt(fmt)) stopAudioPreview();   // the audio card is hidden — don't keep a preview playing under it
      el.querySelectorAll<HTMLElement>('[data-html-only]').forEach(c => { c.style.display = fmt === 'html' ? 'flex' : 'none'; });
      el.querySelectorAll<HTMLElement>('[data-cmyk-only]').forEach(c => { c.style.display = isCmykFmt(fmt) ? 'flex' : 'none'; });
      el.querySelectorAll<HTMLElement>('[data-printmarks-only]').forEach(c => { c.style.display = isPrintFmt(fmt) ? 'flex' : 'none'; });
      syncBarsDefault(fmt);
      refreshPrintUi(); // owns [data-pdf-only] (password) visibility — see below
      onUrlSync?.('format');
      onUrlSync?.('marks');  // bars may have flipped with the format
    });
  }

  // Print marks card: reveal its body when enabled, and hide the open-password
  // card while it's on (marks/bleed route through pdf-lib, which can't encrypt).
  function refreshPrintUi(): void {
    const on  = el!.querySelector<HTMLInputElement>('[data-action="print-enable"]')?.checked;
    const fmt = formatEl?.value ?? initialFmt;
    const body = el!.querySelector<HTMLElement>('[data-print-body]');
    if (body) body.style.display = on ? 'flex' : 'none';
    // The lock card serves the RGB `pdf` AND the print `pdf-cmyk` (the strong AES tier
    // composes with CMYK/marks) AND the `zip` bundle (whole-zip encryption);
    // refreshLockTier() constrains/rewords which tiers apply in the current context.
    el!.querySelectorAll<HTMLElement>('[data-pdf-only]').forEach(c => { c.style.display = (fmt === 'pdf' || fmt === 'pdf-cmyk' || fmt === 'zip') ? 'flex' : 'none'; });
    refreshLockTier();
    // Content Credentials follow the stampable-container set, independent of
    // the print card (marks + credential compose fine — the stamp runs last).
    // Shown for zip too: bundled members are stamped individually. The webm
    // caveat sentence only shows for webm (no external viewer reads it there).
    el!.querySelectorAll<HTMLElement>('[data-c2pa-only]').forEach(c => { c.style.display = (isC2paFmt(fmt) || fmt === 'zip') ? 'flex' : 'none'; });
    el!.querySelectorAll<HTMLElement>('[data-imprint-only]').forEach(c => { c.style.display = (isImprintFmt(fmt) || fmt === 'zip') ? 'flex' : 'none'; });
    el!.querySelectorAll<HTMLElement>('[data-c2pa-webm]').forEach(c => { c.style.display = fmt === 'webm' ? 'block' : 'none'; });
    // The "Content protection" wrapper itself: hidden when none of its four inner
    // cards apply to the selected format (e.g. a text/data format like csv/json/ics),
    // so an always-collapsed, permanently-empty header never shows. Each inner card
    // keeps its own [data-*-only] gate above — this is one more OUTER layer only, it
    // never loosens them. Mirrors the exact per-card predicates this function already
    // applies (password: pdf/pdf-cmyk/zip; C2PA/imprint: their own fmt set; print: isPrintFmt).
    const protectionEl = el!.querySelector<HTMLElement>('[data-protection-section]');
    if (protectionEl) {
      const anyValid = (fmt === 'pdf' || fmt === 'pdf-cmyk' || fmt === 'zip')
        || isC2paFmt(fmt) || isImprintFmt(fmt) || isPrintFmt(fmt);
      protectionEl.style.display = anyValid ? 'flex' : 'none';
    }
  }
  // Whether the password field currently holds a value that came from ?password=
  // (a Standard-tier link lock). The Strong tier must NEVER reuse a URL-sourced
  // password — that would key "strong" encryption with a secret that already
  // travelled in a link — so we clear the field if the tier flips to strong while
  // this is set. Cleared as soon as the user types (they then own the value).
  let pwFromUrl = Boolean(exportDefaults.password);

  // Encryption-tier control for the password card. Standard = jsPDF's 40-bit RC4,
  // built into an unfinished document — so it works only on a plain RGB `pdf` with
  // no print finishing. Strong = AES-256 encrypt-last, which composes with CMYK /
  // marks / pdf-cmyk. When Standard can't apply we disable it and fall to Strong.
  const STD_LOCK_HINT = 'Requires this password to open the PDF. A basic 40-bit lock — it opens in any PDF app and travels in a share link, so treat it as a deterrent, not protection for confidential files.';
  const STRONG_LOCK_HINT = 'AES-256 encryption (PDF 2.0). The recipient must type this exact password to open — it is never included in a link and can’t be recovered if lost. It opens only in newer PDF apps (Acrobat / Preview from ~2018 on); older apps may report the file as damaged.';
  // ZIP variants — same two tiers, different reach: standard = PKWARE ZipCrypto
  // (opens anywhere incl. Windows Explorer, weak); strong = WinZip AES-256.
  const STD_ZIP_HINT = 'Locks the ZIP with a password. Traditional Zip encryption — it opens in any unzip tool including Windows Explorer, and travels in a share link, so treat it as a deterrent, not protection for confidential files.';
  const STRONG_ZIP_HINT = 'AES-256 ZIP encryption. The recipient must type this exact password — it is never included in a link and can’t be recovered if lost. It opens in 7-Zip, Keka, WinZip or macOS Archive Utility, but NOT Windows Explorer’s built-in extract.';
  function refreshLockTier(): void {
    const tierEl = el!.querySelector<HTMLSelectElement>('[data-action="pdf-lock-tier"]');
    if (!tierEl) return;
    const fmt = formatEl?.value ?? initialFmt;
    const isZip = fmt === 'zip';
    const marksOn = el!.querySelector<HTMLInputElement>('[data-action="print-enable"]')?.checked ?? false;
    // ZIP: both tiers always apply. PDF: RC4 "standard" needs a plain RGB pdf with no
    // finishing pass; print / CMYK / crop-marks force the strong (encrypt-last) tier.
    const standardOk = isZip || (fmt === 'pdf' && !marksOn);
    const stdOpt = tierEl.querySelector<HTMLOptionElement>('option[value="standard"]');
    const strongOpt = tierEl.querySelector<HTMLOptionElement>('option[value="strong"]');
    if (stdOpt) {
      stdOpt.disabled = !standardOk;
      stdOpt.textContent = isZip ? 'Standard lock — opens in any unzip tool' : 'Standard lock — opens in any PDF app';
    }
    if (strongOpt) strongOpt.textContent = isZip ? 'Strong · AES-256 — 7-Zip / Keka / macOS' : 'Strong · AES-256 — newer apps only ⓘ';
    if (!standardOk) tierEl.value = 'strong';
    // Never let a URL-prefilled password become a STRONG key: clear it the moment
    // the tier is strong (whether force-flipped here or picked by the user).
    if (tierEl.value === 'strong' && pwFromUrl) {
      const pwEl = el!.querySelector<HTMLInputElement>('[data-action="pdf-password"]');
      if (pwEl?.value) { pwEl.value = ''; onUrlSync?.('password'); }
      pwFromUrl = false;
    }
    const hintEl = el!.querySelector<HTMLElement>('[data-pdfpass-hint]');
    if (hintEl) {
      const strong = tierEl.value === 'strong';
      hintEl.textContent = isZip
        ? (strong ? STRONG_ZIP_HINT : STD_ZIP_HINT)
        : strong
          ? (standardOk ? '' : 'Print, CMYK and crop-marked PDFs use the strong lock. ') + STRONG_LOCK_HINT
          : STD_LOCK_HINT;
    }
  }
  el.querySelector<HTMLInputElement>('[data-action="print-enable"]')?.addEventListener('change', () => {
    refreshPrintUi(); onUrlSync?.('bleed'); onUrlSync?.('marks');
  });
  el.querySelector<HTMLInputElement>('[data-action="print-bleed"]')?.addEventListener('input', () => onUrlSync?.('bleed'));
  ['mark-crop', 'mark-reg', 'mark-bleed', 'mark-bars', 'mark-prov'].forEach(a =>
    el.querySelector<HTMLInputElement>(`[data-action="${a}"]`)?.addEventListener('change', () => {
      if (a === 'mark-bars') barsUserSet = true;  // stop auto-tracking once chosen
      onUrlSync?.('marks');
    }));
  refreshPrintUi(); // initial state (e.g. card pre-opened from a shared link)

  // Colour profile (CMYK press condition) — print-PDF only; persists via URL/save.
  el.querySelector<HTMLSelectElement>('[data-action="cmyk-profile"]')?.addEventListener('change', () => onUrlSync?.('profile'));

  el.querySelector<HTMLInputElement>('[data-action="filename"]')?.addEventListener('input', () => onUrlSync?.('filename'));

  // Full-page HTML export toggle ("no stage") — round-trips through the URL as ?nostage.
  el.querySelector<HTMLInputElement>('[data-action="full-page"]')?.addEventListener('change', () => onUrlSync?.('nostage'));

  // Pixel-watermark toggle — round-trips through the URL as ?imprint=1 (see syncUrl).
  el.querySelector<HTMLInputElement>('[data-action="imprint"]')?.addEventListener('change', () => onUrlSync?.('imprint'));

  // PDF open-password — clear-text in the URL by design (see pdfPassRow). Syncs on
  // input so a crafted/edited link round-trips; syncUrl gates it to the pdf format.
  el.querySelector<HTMLInputElement>('[data-action="pdf-password"]')?.addEventListener('input', () => { pwFromUrl = false; onUrlSync?.('password'); });

  // Password protect disclosure — the header toggles the body open/closed (purely
  // visual; the input value still drives export). Focus the field on expand.
  el.querySelector<HTMLButtonElement>('[data-action="pdfpass-toggle"]')?.addEventListener('click', () => {
    const card = el!.querySelector('.export-pdfpass');
    const open = card?.classList.toggle('is-open') ?? false;
    const body = el!.querySelector<HTMLElement>('[data-pdfpass-body]');
    if (body) body.style.display = open ? 'flex' : 'none';
    el!.querySelector('[data-action="pdfpass-toggle"]')?.setAttribute('aria-expanded', String(open));
    if (open) el!.querySelector<HTMLInputElement>('[data-action="pdf-password"]')?.focus();
  });

  // "Content protection" disclosure — the outer header toggles the whole group of
  // four provenance/protection cards open/closed. Purely visual, same idiom as the
  // password card's own toggle above: nothing inside changes state or export
  // behaviour, and each inner card's own disclosure (password, print marks) keeps
  // working independently once the group is open.
  el.querySelector<HTMLButtonElement>('[data-action="protection-toggle"]')?.addEventListener('click', () => {
    const card = el!.querySelector('.export-protection');
    const open = card?.classList.toggle('is-open') ?? false;
    const body = el!.querySelector<HTMLElement>('[data-protection-body]');
    if (body) body.style.display = open ? 'flex' : 'none';
    el!.querySelector('[data-action="protection-toggle"]')?.setAttribute('aria-expanded', String(open));
  });

  // Encryption-tier switch: refresh the hint/constraints, re-evaluate the C2PA
  // exclusion, and re-sync the URL — the strong tier is deliberately never written
  // to a link, so switching to it drops any ?password= that was there.
  el.querySelector<HTMLSelectElement>('[data-action="pdf-lock-tier"]')?.addEventListener('change', () => {
    refreshLockTier();
    refreshC2paUi('tier');
    onUrlSync?.('password');
  });

  // Content Credentials ↔ open-password exclusion: an encrypted PDF can't take
  // the C2PA incremental update, so whichever is active disables the other
  // (mirrors the marks-vs-password exclusion in refreshPrintUi). Checking the
  // box clears a typed password; a typed password (or a ?password= link — the
  // initial call below) unchecks the box and wins over a tool's render.c2pa.
  const c2paEl    = el.querySelector<HTMLInputElement>('[data-action="pdf-c2pa"]');
  const pdfPassEl = el.querySelector<HTMLInputElement>('[data-action="pdf-password"]');
  function refreshC2paUi(changed?: string): void {
    if (!c2paEl) return;
    // The exclusion is a PDF-only fact (only an encrypted PDF can't take the
    // credential); on any other format a lingering password in the hidden
    // card must not disable — let alone silently uncheck — the credential.
    const fmt = formatEl?.value ?? initialFmt;
    if (!pdfPassEl || (fmt !== 'pdf' && fmt !== 'pdf-cmyk')) {
      c2paEl.disabled = false;
      if (pdfPassEl) pdfPassEl.disabled = false;
      return;
    }
    if (changed === 'c2pa' && c2paEl.checked && pdfPassEl.value) {
      pdfPassEl.value = '';
      onUrlSync?.('password');
    }
    if (pdfPassEl.value) c2paEl.checked = false;
    c2paEl.disabled    = Boolean(pdfPassEl.value);
    pdfPassEl.disabled = c2paEl.checked;
  }
  c2paEl?.addEventListener('change', () => refreshC2paUi('c2pa'));
  pdfPassEl?.addEventListener('input', () => refreshC2paUi('password'));
  formatEl?.addEventListener('change', () => refreshC2paUi('format'));
  refreshC2paUi(); // initial state (?password= link vs a c2pa-default tool)

  // The C2PA card's explanation lives behind an info (?) tip — wire the same
  // delegated tap/Escape/outside-click behaviour the sidebar uses (attach-once;
  // the document dismiss listener is dropped in mountTool's cleanup). Hover
  // reveal is pure CSS.
  wireHelpTips(el);
  linkHelpDescriptions(el);

  // Credential lifetime: the 7/30/90/365 select only makes sense for the
  // ephemeral per-export cert. With an enrolled identity (host.identity) the
  // window was fixed at enrolment, so the picker is swapped for the identity
  // line — you can't sign with validity your certificate doesn't have.
  (async () => {
    const lifeEl = el!.querySelector<HTMLElement>('[data-c2pa-life]');
    if (!lifeEl) return;
    let s: IdentityStatus | null | undefined = null;
    try { s = await host.identity?.status(); } catch { /* CA/bridge absent — keep the picker */ }
    if (!s?.enrolled || s.expired) return;
    const until = s.notAfter ? new Date(s.notAfter).toLocaleDateString() : '';
    const renew = (s.daysLeft ?? Infinity) < 7 ? ' <a href="#/profile">Renew soon</a>' : '';
    lifeEl.innerHTML = `<p class="c2pa-life-signed">Signed as <strong>${escape(s.identity?.email ?? '')}</strong>${until ? ` · verified until ${escape(until)}` : ''}${renew}</p>`;
  })();

  // A px-only tool (render.units:false) has no unit selector, so an on-screen pixel
  // is an exported pixel — the token-cost readout can't drift from the real raster
  // resolution the way a physical unit + DPI would. Force px explicitly, not just by
  // the selector's absence, so the invariant holds regardless of DOM state.
  const dimUnit = (): string => manifest.render.units === false
    ? 'px'
    : (el!.querySelector<HTMLSelectElement>('[data-action="export-unit"]')?.value || 'px');
  const dimDpi  = (): number => { const n = parseInt(el!.querySelector<HTMLInputElement>('[data-action="export-dpi"]')?.value ?? '', 10); return n > 0 ? n : 300; };
  // Ephemeral-credential lifetime pick; null when an enrolled identity replaced
  // the select (the cert window rules then) — export.js defaults absent to 30.
  const c2paDaysVal = (): number | null => { const n = Number(el!.querySelector<HTMLSelectElement>('[data-action="c2pa-days"]')?.value); return [7, 30, 90, 365].includes(n) ? n : null; };
  // Raw numeric values the user typed, in the active unit.
  function rawDims(): { w: number | undefined; h: number | undefined } {
    const w = parseFloat(el!.querySelector<HTMLInputElement>('[data-action="export-width"]')?.value ?? '');
    const h = parseFloat(el!.querySelector<HTMLInputElement>('[data-action="export-height"]')?.value ?? '');
    return { w: w > 0 ? w : undefined, h: h > 0 ? h : undefined };
  }

  // Export dimensions: values qualified with the active unit (+ DPI for physical
  // units) so the engine converts per format. Vector ignores DPI; raster uses it.
  function exportDims(): { width?: number | string; height?: number | string; dpi?: number } {
    if (manifest.render.dims === false) {
      return { width: manifest.render.width, height: manifest.render.height };
    }
    const { w, h } = rawDims();
    const u = dimUnit();
    const q = (v: number | undefined): string | number | undefined => ((v ?? 0) > 0 ? (u !== 'px' ? `${v}${u}` : v) : undefined);
    const out: { width?: number | string; height?: number | string; dpi?: number } = { width: q(w), height: q(h) };
    if (u !== 'px') out.dpi = dimDpi();
    return out;
  }

  // On-screen preview is CSS px: physical units shown at their 96-DPI px size.
  function previewPx(): { width: number | undefined; height: number | undefined } {
    const { w, h } = rawDims();
    const u = dimUnit();
    const toPx = (v: number | undefined): number | undefined => ((v ?? 0) > 0 ? (u === 'px' ? v : toCssPx({ value: v!, unit: u as Unit })) : undefined);
    return { width: toPx(w), height: toPx(h) };
  }

  // Editor-only aspect-ratio guard. Evaluate the current page size (in px, so the
  // unit drops out of the ratio) against the tool's declared band and show/hide the
  // warning beside the dimension fields. Driven from refreshCanvasPreview, so it
  // tracks both typed dimensions and a size-select change. Never touches the canvas.
  function updateAspectWarning(): void {
    if (!aspectWarnEl) return;
    const { width, height } = previewPx();
    const msg = aspectWarning(manifest, width as number, height as number);
    aspectWarnEl.querySelector<HTMLElement>('[data-aspect-warning-text]')!.textContent = msg ?? '';
    aspectWarnEl.hidden = !msg;
  }

  // Print marks & bleed export opts (pdf / pdf-cmyk / cmyk-tiff). Empty when the card is off,
  // so an ordinary PDF stays trim-sized with no marks.
  function printOpts(): RunExportOpts {
    if (!printEnabled(el)) return {};
    const mm = parseFloat(el!.querySelector<HTMLInputElement>('[data-action="print-bleed"]')?.value ?? '');
    return {
      bleed: mm > 0 ? `${mm}mm` : undefined,
      cropMarks:         el!.querySelector<HTMLInputElement>('[data-action="mark-crop"]')?.checked ?? false,
      registrationMarks: el!.querySelector<HTMLInputElement>('[data-action="mark-reg"]')?.checked ?? false,
      bleedMarks:        el!.querySelector<HTMLInputElement>('[data-action="mark-bleed"]')?.checked ?? false,
      colorBars:         el!.querySelector<HTMLInputElement>('[data-action="mark-bars"]')?.checked ?? false,
      provenance:        el!.querySelector<HTMLInputElement>('[data-action="mark-prov"]')?.checked ?? false,
    };
  }

  function videoParams(): { wait: number; duration: number; fps: number | undefined; live: boolean } {
    const wait     = parseFloat(el!.querySelector<HTMLInputElement>('[data-action="video-wait"]')?.value ?? '')     ?? 1;
    const duration = parseFloat(el!.querySelector<HTMLInputElement>('[data-action="video-duration"]')?.value ?? '') ?? 5;
    const hiFps    = el!.querySelector<HTMLInputElement>('[data-action="webm-60fps"]')?.checked ?? false;
    return {
      wait:     isFinite(wait)     ? Math.max(0,  wait)     : 1,
      duration: isFinite(duration) ? Math.max(0.5, duration) : 5,
      fps:      hiFps ? 60 : undefined,
      // "Record live" (webm/mp4): capture the on-screen preview via a screen share
      // instead of the offline render — see bridge/live-capture.ts. Popup-local.
      live:     el!.querySelector<HTMLInputElement>('[data-action="video-live"]')?.checked ?? false,
    };
  }

  // Preview the export aspect ratio on the canvas, then re-fit to the stage.
  function refreshCanvasPreview(): void {
    updateAspectWarning(); // first, so it reflects current fields even when dims are incomplete
    const { width: w, height: h } = previewPx();
    if (!((w ?? 0) > 0 && (h ?? 0) > 0)) return;
    const previewScale = Math.min(1, manifest.render.width / w!, manifest.render.height / h!);
    canvasEl!.style.width  = Math.round(w! * previewScale) + 'px';
    canvasEl!.style.height = Math.round(h! * previewScale) + 'px';
    fitCanvas();
    // If the tool declares width/height inputs, sync dims so hooks can recompute layout.
    const model = runtime.getModel();
    const hasW = model.some(i => i.id === 'width');
    const hasH = model.some(i => i.id === 'height');
    if (hasW || hasH) {
      // Chain to avoid concurrent hook executions on the shared model. Use the UNWRAPPED
      // setter (runtime.setInputNoHistory, installed by mountTool) — NOT the history-
      // wrapped runtime.setInput — so this PROGRAMMATIC px sync, fired at mount and on
      // every unit/dimension change, never lands in the undo history or wipes the redo
      // chain. The user's own edits to a width/height field still go through the wrapped
      // setInput and stay undoable. baseSetInput is local to mountTool and out of scope
      // here; fall back to the wrapped setter if no wrapper was installed (e.g. a child
      // runtime) so this can never throw at boot.
      const setDims = runtime.setInputNoHistory || runtime.setInput;
      const p = hasW ? setDims('width', w!) : Promise.resolve();
      p.then(() => { if (hasH) setDims('height', h!); });
      // subscriber fires runTemplateScripts + syncUrl after each setInput
    } else {
      runTemplateScripts(canvasEl!);
      onUrlSync?.();
    }
  }
  // Deferred-preview tools (manifest.render.preview): a painted preview is only
  // valid for the geometry it was captured at, so any change to the export size,
  // unit or DPI must drop back to the placeholder + its "click to preview"
  // button — exactly as changing a sidebar input does. Re-emitting
  // rebuilds the canvas from the model through the one render path (which clears
  // the painted [data-capture] image). No-op for ordinary tools, whose live
  // canvas is the preview. Format/filename don't change captured pixels, so they
  // leave the preview intact.
  const invalidatePreview = manifest.render.preview ? () => runtime.refresh() : () => {};

  // Brief, editor-only outline pulse on the canvas while the export size is being
  // changed (scrub / scroll / type), so a resize reads as deliberate. Applied to
  // the OUTER wrapper — never the exported #tool-canvas — so it can't bleed into
  // output, and removed shortly after the last change; the CSS handles the fade.
  // Re-armed on every change, so a continuous drag holds it on, then it lapses.
  const canvasOuterEl = canvasEl?.closest('.tool-canvas-outer') ?? canvasEl?.parentElement ?? null;
  let dimPulseTimer = 0;
  function pulseCanvasResize(): void {
    if (!canvasOuterEl) return;
    canvasOuterEl.classList.add('is-resizing');
    clearTimeout(dimPulseTimer);
    dimPulseTimer = setTimeout(() => canvasOuterEl.classList.remove('is-resizing'), 450);
  }

  // Label the floating scrub readout with the value + current unit (e.g. "1024 px",
  // "210 mm") so a drag reads clearly even with the cursor/finger over the field.
  // (dimUnit() is defined above with the other dimension helpers.)
  ([
    [el.querySelector<HTMLInputElement>('[data-action="export-width"]'),  'w'],
    [el.querySelector<HTMLInputElement>('[data-action="export-height"]'), 'h'],
  ] as [HTMLInputElement | null, string][]).forEach(([inp, key]) => {
    if (!inp) return;
    const onDimChange = () => { onUrlSync?.(key); refreshCanvasPreview(); invalidatePreview(); pulseCanvasResize(); };
    inp.addEventListener('input', onDimChange);
    addScrubBehavior(inp, onDimChange, { format: v => `${v} ${dimUnit()}` });
  });

  // Apply a {width,height,unit} from a size-select option to the export-bar fields,
  // so choosing a size sets the actual exported page size. Refreshes the preview +
  // URL just like a manual edit. The user can still override the fields afterwards.
  function setDims({ width, height, unit }: { width?: number; height?: number; unit?: string } = {}): void {
    if (manifest.render.dims === false) return;
    const uEl = el!.querySelector<HTMLSelectElement>('[data-action="export-unit"]');
    if (uEl && unit) {
      uEl.value = unit;
      const dpiField = el!.querySelector<HTMLElement>('[data-dpi-field]');
      if (dpiField) dpiField.style.display = unit === 'px' ? 'none' : 'inline-flex';
    }
    const wEl = el!.querySelector<HTMLInputElement>('[data-action="export-width"]');
    const hEl = el!.querySelector<HTMLInputElement>('[data-action="export-height"]');
    if (wEl && (width ?? 0) > 0) wEl.value = String(width);
    if (hEl && (height ?? 0) > 0) hEl.value = String(height);
    refreshCanvasPreview();
    invalidatePreview();
    pulseCanvasResize();
    onUrlSync?.('unit'); onUrlSync?.('w'); onUrlSync?.('h');
  }

  // Unit switch keeps the physical size: convert the typed values to the new
  // unit, toggle the DPI field, refresh the preview, and sync the URL.
  const unitSel = el.querySelector<HTMLSelectElement>('[data-action="export-unit"]');
  const dpiFieldEl = el.querySelector<HTMLElement>('[data-dpi-field]');
  let curUnit = initUnit;
  unitSel?.addEventListener('change', () => {
    const to = unitSel.value;
    const wEl = el!.querySelector<HTMLInputElement>('[data-action="export-width"]');
    const hEl = el!.querySelector<HTMLInputElement>('[data-action="export-height"]');
    const conv = (v: string): string => { const n = parseFloat(v); return n > 0 ? String(Math.round(toCssPx({ value: n, unit: curUnit as Unit }) / (toCssPx({ value: 1, unit: to as Unit })) * 100) / 100) : v; };
    if (wEl) wEl.value = conv(wEl.value);
    if (hEl) hEl.value = conv(hEl.value);
    curUnit = to;
    if (dpiFieldEl) dpiFieldEl.style.display = (to === 'px') ? 'none' : 'inline-flex';
    onUrlSync?.('unit'); onUrlSync?.('w'); onUrlSync?.('h');
    refreshCanvasPreview();
    invalidatePreview();
    pulseCanvasResize();
  });
  el.querySelector<HTMLInputElement>('[data-action="export-dpi"]')?.addEventListener('input', () => { onUrlSync?.('dpi'); invalidatePreview(); });

  el.querySelector<HTMLButtonElement>('[data-action="copy"]')?.addEventListener('click', () => {
    // performCopy drives the camera-shutter itself (fullscreen on mobile), per
    // path: the image path GATES the off-screen resize ("shake") behind the closed
    // shutter — like exports do — while keeping the clipboard write in the user
    // gesture by handing the shutter-delayed blob promise to ClipboardItem; the
    // text/html paths play it as parallel feedback (they have no such resize).
    performCopy().then((res) => {
      bumpMetric('imagesCopied');
      // Honest feedback: on browsers without image-clipboard support the bridge
      // downloads the file instead, so don't claim it was copied.
      announce(res?.method === 'download'
        ? 'Clipboard image not supported here — downloaded instead'
        : 'Copied to clipboard');
    }).catch(err => console.error('Copy failed:', err));
  });

  // Copies the current render to the clipboard. Shared by the Copy button and
  // the `?copy` URL action. `fmtOverride` honours `?format=<format>&copy`.
  async function performCopy(fmtOverride?: string): Promise<{ method: string } | void> {
    const fmt = fmtOverride
      || formatEl?.value
      || (formats.includes('png') ? 'png' : formats[0]!);

    // Universal copy, by format:
    //   • txt / md   → plain text
    //   • html       → rich HTML (so an email signature pastes formatted into Gmail)
    //   • everything else (raster, SVG, PDF, …) → a PNG bitmap
    // so a paste always yields something useful whatever format is selected.
    const TEXT_FORMATS = new Set(['txt', 'md', 'markdown']);
    if (TEXT_FORMATS.has(fmt)) {
      playShutter();   // parallel capture feedback — writeText must stay in-gesture
      const blob = await exportUnscaled(() => runtime.export(canvasEl, fmt, exportDims()));
      await host.clipboard.writeText(await blob.text());
      return;
    }

    if (fmt === 'html') {
      playShutter();   // parallel capture feedback — no off-screen resize to hide here
      // Clone the canvas, then scrub everything email clients strip or ignore.
      const clone = canvasEl!.cloneNode(true) as HTMLElement;
      clone.querySelectorAll<HTMLElement>('[data-canvas-input]').forEach(el => el.removeAttribute('data-canvas-input'));
      clone.querySelectorAll('script').forEach(el => el.remove());
      // <style> blocks — email clients (Gmail etc.) strip them; the template
      // already carries full inline styles so these are pure character waste.
      clone.querySelectorAll('style').forEach(el => el.remove());
      // Annotation comment markers (<!-- ci:id -->) — invisible, ~30 chars each.
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
      const comments: Comment[] = [];
      let commentNode: Node | null;
      while ((commentNode = walker.nextNode())) comments.push(commentNode as Comment);
      comments.forEach(n => n.parentNode?.removeChild(n));

      // Wrap the async blob-URL → data-URL conversion in a Promise so ClipboardItem
      // receives it while navigator.clipboard.write() is still in gesture context.
      const htmlBlobPromise = (async () => {
        // Email signatures display at ≤200px, so cap encoding there; html tools
        // needing larger images can raise this in their own beforeExport hook.
        await Promise.all([...clone.querySelectorAll('img')].map(async img => {
          const src = img.getAttribute('src');
          if (!src?.startsWith('blob:')) return;
          try {
            const dataUrl = await new Promise<string>((res, rej) => {
              const bmp = new Image();
              bmp.onload = () => {
                const MAX = 200;
                const scale = Math.min(1, MAX / Math.max(bmp.naturalWidth, bmp.naturalHeight));
                const w = Math.round(bmp.naturalWidth * scale);
                const h = Math.round(bmp.naturalHeight * scale);
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                const ctx = c.getContext('2d')!;
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(bmp, 0, 0, w, h);
                res(c.toDataURL('image/jpeg', 0.75));
              };
              bmp.onerror = rej;
              bmp.src = src;
            });
            img.src = dataUrl;
          } catch { /* leave as-is if conversion fails */ }
        }));
        return new Blob([clone.innerHTML], { type: 'text/html' });
      })();

      if (navigator.clipboard?.write && window.ClipboardItem) {
        try {
          const textBlob = htmlBlobPromise.then(b => b.text().then(
            t => { const d = document.createElement('div'); d.innerHTML = t; return new Blob([d.textContent ?? ''], { type: 'text/plain' }); }
          ));
          await navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlobPromise, 'text/plain': textBlob })]);
          return;
        } catch { /* fall through to the bridge path */ }
      }
      await host.clipboard.writeHtml(await htmlBlobPromise.then(b => b.text()));
      return;
    }

    // Image copy. { shutter: true } closes the camera-iris BEFORE the off-screen
    // resize so its brief "shake" is hidden — exactly like exports — then opens it.
    // The clipboard write still stays in the user gesture because we hand the
    // shutter-delayed blob *promise* straight to ClipboardItem rather than awaiting
    // it first (awaiting before write() loses the gesture and the browser silently
    // denies the write; deferring the blob inside the promise is the cross-browser
    // pattern that survives the ~shutter delay). One export feeds both paths.
    const blobPromise = exportUnscaled(() => runtime.export(canvasEl, 'png', exportDims()), { shutter: true });
    if (navigator.clipboard?.write && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
        return { method: 'clipboard' };
      } catch { /* fall through to the bridge path — blobPromise has already resolved */ }
    }
    // Bridge path: image clipboard write unavailable (e.g. older Firefox) — this
    // returns { method: 'download' } when it falls back to saving the file instead.
    return host.clipboard.writeImage(await blobPromise);
  }

  el.querySelector<HTMLButtonElement>('[data-action="download"]')?.addEventListener('click', async (e) => {
    const btn  = e.currentTarget as HTMLButtonElement;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');

    const fmt        = formatEl?.value ?? formats[0]!;
    const isAnimated = isAnimatedFmt(fmt);
    const isGif      = fmt === 'gif';

    let liveTake = false;
    if (isAnimated) {
      const { wait, duration, fps, live } = videoParams();
      const totalS = wait + duration;
      liveTake = live && isVideoFmt(fmt);
      btn.textContent = isGif
        ? `Encoding GIF… ${totalS}s`
        : liveTake
          ? `Recording live… ${duration}s`   // no wait phase — capture starts once the stage is located
          : fps === 60
            ? `Rendering 60fps… ${totalS}s+`
            : `Recording… ${totalS}s`;
    } else {
      // Slow non-animated exports (CMYK TIFF, high-DPI raster, PDF) previously froze
      // on a disabled button with no signal. Show progress and tell assistive tech.
      btn.textContent = 'Exporting…';
    }
    announce('Exporting…');

    // A zzfxm music bed is rendered to a transient WAV blob URL below; revoke it once
    // the export has consumed it (declared out here so the catch can free it too).
    let wavBlobUrl: string | null = null;
    try {
      // Resolve the chosen catalog audio track (if any) to a plain fetchable
      // URL before the recording starts — the export bridge stays catalog-
      // agnostic, and a missing/undownloadable track fails here in the UI
      // instead of mid-record. On-demand tier fetches + caches the bytes.
      let audioOpt: RunExportOpts = {};
      if (isVideoFmt(fmt)) {
        const audioId = el!.querySelector<HTMLSelectElement>('[data-action="video-audio"]')?.value;
        if (audioId) {
          // ZzFXM songs and tracker modules have no playable audio file — render them
          // to a transient WAV blob URL so the URL-driven muxer paths consume them
          // exactly like an encoded loop. (mod → libopenmpt, zzfxm → the synth.)
          const toWavIfNeeded = async (r: { url: string; format?: string }): Promise<string> =>
            r.format === 'zzfxm' ? (wavBlobUrl = await songUrlToWavBlobUrl(r.url))
            : isModuleFormat(r.format) ? (wavBlobUrl = await modUrlToWavBlobUrl(r.url))
            : r.url;
          let audioUrl: string | null = null;
          let audioTrackId: string | undefined = audioId;
          if (audioId === '__generate__') {
            // A fresh worker render at THIS clip's length — the seed keeps it the
            // same tune the user auditioned, just arranged to fit.
            const pcm = await renderSong(composeSong(generatedSongSpec(genSeed, genDur())));
            audioUrl = wavBlobUrl = URL.createObjectURL(pcmToWavBlob(pcm));
            audioTrackId = `zzfxm-generated-${genSeed}`;
          } else if (audioId === '__tool__') {
            // The tool's own audio slot, read live — an emptied slot exports silent.
            const ref = await resolveToolAudio();
            if (ref) { audioUrl = await toWavIfNeeded(ref); audioTrackId = toolAudioRef()?.id ?? audioId; }
          } else {
            audioUrl = await toWavIfNeeded(await host.assets.get(audioId));
          }
          const numCtl = (a: string, dflt: number): number => {
            const v = el!.querySelector<HTMLInputElement>(`[data-action="${a}"]`)?.value;
            return v != null && v !== '' ? (Number(v) || 0) : dflt;
          };
          const fadeIn  = numCtl('audio-fadein', 0);
          const fadeOut = numCtl('audio-fadeout', 0);
          const volume  = Math.max(0, Math.min(100, numCtl('audio-volume', 100))) / 100;
          const duck    = Math.max(0, Math.min(100, numCtl('audio-duck', 100))) / 100;
          if (audioUrl) audioOpt = { audio: { id: audioTrackId, url: audioUrl, fadeIn, fadeOut, volume, duck } };
        }
      }
      // Surface progress on the button for slow non-animated exports — the CMYK
      // TIFF pass and the SVG/PDF vector walk emit onProgress, which was being
      // discarded (the label sat on a static "Exporting…"). Throttle to integer
      // percent so a per-row callback can't thrash the DOM. Animated formats keep
      // their own time-based label (guarded by isAnimated).
      let lastExportPct = -1;
      // The live brand palette (host.tokens, cached) — not the tokenless PALETTE
      // fallback — so CMYK ink substitution always matches the active profile's
      // real brand (SUSE's measured inks, or whichever catalog is mounted).
      const brandPalette = await livePalette(host);
      const opts: RunExportOpts = {
        ...exportDims(),
        onProgress: (done, total) => {
          // Live take: (done, total) is a seconds countdown from the recorder. The
          // button is the one status surface guaranteed OUTSIDE the capture — the
          // in-page pill is skipped when the stage leaves it no capture-safe spot.
          if (liveTake) {
            if (total > 0) btn.textContent = `Recording live… ${done}s`;
            return;
          }
          if (isAnimated || total <= 0) return;
          const pct = Math.floor((done / total) * 100);
          if (pct === lastExportPct) return;
          lastExportPct = pct;
          btn.textContent = `Exporting… ${pct}%`;
        },
        ...(isAnimated ? videoParams() : {}),
        ...audioOpt,
        ...(isGif ? { dither: el!.querySelector<HTMLInputElement>('[data-action="gif-dither"]')?.checked ?? false } : {}),
        ...(fmt === 'html' ? { fullPage: el!.querySelector<HTMLInputElement>('[data-action="full-page"]')?.checked ?? false } : {}),
        ...(isPrintFmt(fmt) ? printOpts() : {}),
        // Every CMYK export path (PDF, TIFF, EPS) does exact brand-swatch matching
        // against this same live palette — see buildCmykPaletteMap in bridge/export.ts.
        ...(isCmykFmt(fmt) || fmt === 'eps-cmyk' ? { palette: brandPalette } : {}),
        ...(isCmykFmt(fmt) ? {
          colorProfile: el!.querySelector<HTMLSelectElement>('[data-action="cmyk-profile"]')?.value || DEFAULT_CMYK_CONDITION,
        } : {}),
        ...(() => {
          const pw = el!.querySelector<HTMLInputElement>('[data-action="pdf-password"]')?.value;
          if (!pw) return {};
          const strong = el!.querySelector<HTMLSelectElement>('[data-action="pdf-lock-tier"]')?.value === 'strong';
          // Strong (AES-256, encrypt-last) composes with RGB pdf AND print pdf-cmyk;
          // the 40-bit standard lock is jsPDF-native and RGB-pdf only.
          if (strong && (fmt === 'pdf' || fmt === 'pdf-cmyk')) return { strongPassword: pw };
          if (fmt === 'pdf') return { password: pw };
          return {};
        })(),
        ...(isC2paFmt(fmt) && el!.querySelector<HTMLInputElement>('[data-action="pdf-c2pa"]')?.checked
          ? { c2pa: true, ...(c2paDaysVal() ? { c2paDays: c2paDaysVal()! } : {}) }
          : {}),
        // Pixel watermark — the popup toggle (seeded by ?imprint=); the bridge
        // applies it only to raster formats, so it's harmless to pass through for
        // others / zip members. A tool with no raster format renders no toggle —
        // fall back to the link default.
        ...((el!.querySelector<HTMLInputElement>('[data-action="imprint"]')?.checked ?? exportDefaults.imprint) ? { imprint: true } : {}),
        ...(fmt === 'zip' ? {
          ...printOpts(),   // bundled pdf / pdf-cmyk get marks & bleed; rasters ignore them
          palette: brandPalette,
          colorProfile: el!.querySelector<HTMLSelectElement>('[data-action="cmyk-profile"]')?.value || DEFAULT_CMYK_CONDITION,
          filename: el!.querySelector<HTMLInputElement>('[data-action="filename"]')?.value.trim() || manifest.name,
          bundleFormats: formats.filter(f => ZIP_BUNDLE.has(f)),
          // Members re-enter renderFormat with these opts, so each stampable
          // bundled file gets its own credential; the zip container never does.
          ...(el!.querySelector<HTMLInputElement>('[data-action="pdf-c2pa"]')?.checked
            ? { c2pa: true, ...(c2paDaysVal() ? { c2paDays: c2paDaysVal()! } : {}) }
            : {}),
          // Whole-zip lock: standard = ZipCrypto, strong = AES-256 (renderZip strips
          // these off the per-member opts so members aren't double-locked).
          ...(() => {
            const pw = el!.querySelector<HTMLInputElement>('[data-action="pdf-password"]')?.value;
            if (!pw) return {};
            return el!.querySelector<HTMLSelectElement>('[data-action="pdf-lock-tier"]')?.value === 'strong'
              ? { strongPassword: pw } : { password: pw };
          })(),
        } : {}),
      };
      const filename = el!.querySelector<HTMLInputElement>('[data-action="filename"]')?.value.trim() || manifest.name;
      // The exact bytes handed to host.export.download — hashed into the export-
      // history record below so /verify can later match a file back to this device.
      let downloadedBlob: Blob | null = null;
      // Carousel / paged tool: a STILL-image download becomes one image PER PAGE, zipped.
      // (PDF already fans out to a multi-page document via renderMultiPagePdf; animated /
      // html / zip formats keep their own paths.) Each [data-pdf-page] frame is exported
      // at its own measured size — width/height dims are stripped so a re-sized page still
      // exports at its true pixel size rather than the static render dimensions.
      // Gate on the carousel-specific render.pages — NOT render.paged, which also marks
      // multi-page-pdf / doc-studio, whose SVG export must stay a single whole-canvas file.
      const pageEls = manifest.render.pages && canvasEl
        ? [...canvasEl.querySelectorAll<HTMLElement>('[data-pdf-page]')] : [];
      if (pageEls.length >= 1 && !isAnimated && fmt !== 'pdf' && fmt !== 'zip' && fmt !== 'html' && fmt !== 'pptx') {
        // Export EACH page frame as its own still image, at that frame's own layout size
        // (offsetWidth/Height — transform-independent, and the true possibly-resized page
        // size, not the tool's static render dims). One page → a single file; several → a zip.
        if (pageEls.length > 1) btn.textContent = `Exporting ${pageEls.length} pages…`;
        const pageOpts: RunExportOpts = { ...opts };
        delete pageOpts.bundleFormats;
        const files = await exportUnscaled(async () => {
          const out: Array<{ name: string; blob: Blob }> = [];
          for (let i = 0; i < pageEls.length; i++) {
            const el = pageEls[i]!;
            const pb = await runtime.export(el, fmt, { ...pageOpts, width: el.offsetWidth, height: el.offsetHeight });
            out.push({ name: `${filename}-${i + 1}.${extFor(fmt, pb)}`, blob: pb });
          }
          return out;
        }, { shutter: true });
        if (files.length === 1) {
          downloadedBlob = files[0]!.blob;
          await host.export.download(files[0]!.blob, `${filename}.${extFor(fmt, files[0]!.blob)}`);
        } else {
          const { buildZip } = await import('../pro/zip.ts');
          const zipBlob = await buildZip(files, { zipName: filename });
          downloadedBlob = zipBlob;
          await host.export.download(zipBlob, `${filename}.zip`);
        }
      } else {
        // Mask the resize with the shutter for instant (raster/vector) exports;
        // skip it for animated formats, which record the live canvas over seconds.
        // A LIVE take must keep the fit-to-stage scale: exportUnscaled blows the
        // canvas up to native size for the entire recording, so the user watches a
        // clipped canvas and the capture crops to a viewport slice. Record the
        // preview exactly as displayed instead — the recorder's sizing/bitrate math
        // already reads the on-screen rect × dpr.
        const blob = liveTake
          ? await runtime.export(canvasEl, fmt, opts)
          : await exportUnscaled(() => runtime.export(canvasEl, fmt, opts), { shutter: !isAnimated });
        downloadedBlob = blob;
        await host.export.download(blob, `${filename}.${extFor(fmt, blob)}`);
      }
      if (wavBlobUrl) { URL.revokeObjectURL(wavBlobUrl); wavBlobUrl = null; }
      bumpMetric('filesRendered'); recordFormat(fmt); // local usage metric
      // Log the download to the export history (Dashboard "Latest exports"). Best-effort,
      // non-blocking: a thumbnail of what was exported + enough state to reopen it.
      void (async () => {
        try {
          const { recordExport, hashBlob } = await import('../lib/export-history.ts');
          const thumb = await captureThumbnail(manifest, canvasEl, runtime, exportUnscaled, fmt, false);
          // Hash the exact downloaded bytes so /verify can match a file back here.
          const contentHash = downloadedBlob ? await hashBlob(downloadedBlob) : undefined;
          await recordExport({ toolId: manifest.id, label: manifest.name, filename, format: fmt, thumb, query: serializeUrlState(runtime.getModel()), at: Date.now(), ...(contentHash ? { contentHash } : {}) });
        } catch { /* history is best-effort */ }
      })();
    } catch (err) {
      if (wavBlobUrl) { URL.revokeObjectURL(wavBlobUrl); wavBlobUrl = null; }
      console.error('Export failed:', err);
      btn.removeAttribute('aria-busy');
      // Surface WHY so users don't just retry the same doomed export.
      const raw = String((err as { message?: string })?.message || '');
      const why = /too large|maximum|exceeds|canvas size|dimensions/i.test(raw) ? 'Too large — reduce size or DPI'
        : /not supported|unsupported|no encoder|mime|codec/i.test(raw) ? `Can’t export ${fmt} in this browser`
        : (raw && raw.length <= 48) ? raw
        : 'Export failed — try again';
      btn.textContent = why;
      announce(why, { assertive: true });
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 3500);
      return;
    }

    btn.removeAttribute('aria-busy');
    btn.textContent = prev;
    btn.disabled = false;
    announce('Export complete');
  });

  el.querySelector<HTMLButtonElement>('[data-action="save"]')?.addEventListener('click', async function (this: HTMLButtonElement) {
    if (await performSave(this)) setTimeout(() => { navigateTo(returnTo); }, 800);
  });

  // "Make variants" / multi-edit — the icon button NEXT TO THE TOOL NAME (markup
  // in tool.ts's sidebar header; it lives outside `el`, hence the document lookup).
  // Deliberately not an export option: it's a step BEFORE export. The click opens
  // a how-many dropdown (2–8, multi-edit's MIN_SEL–MAX_SEL); picking a count
  // persists the CURRENT live state into that many fresh sessions (labelled A…H —
  // the same payload + slot shape performSave writes, so they're ordinary saved
  // sessions everywhere) and jumps straight into multi-edit with them side by
  // side. The active session's own slot is untouched: variants are copies, so
  // the experiments never overwrite the original.
  const multiBtn = document.getElementById('multi-edit-btn') as HTMLButtonElement | null;
  if (multiBtn) {
    const makeVariants = async (count: number): Promise<void> => {
      if (multiBtn.dataset.saving) return;
      multiBtn.dataset.saving = '1';
      multiBtn.disabled = true;
      multiBtn.setAttribute('aria-busy', 'true');
      try {
        const data  = sessionSnapshot();
        // One thumbnail serves every copy — they start identical.
        const thumb = await captureThumbnail(manifest, canvasEl, runtime, exportUnscaled, data.__export_format);
        const stamp = Date.now();
        const slots: string[] = [];
        for (let i = 0; i < count; i++) {
          const slot = `${manifest.id}:${stamp + i}`;   // ms offset keeps the minted slots unique
          await host.state.save(slot, { ...data, __label: String.fromCharCode(65 + i) }, thumb);
          slots.push(slot);
        }
        announce('Saved');
        // The shape mountMultiEdit parses (main.ts route 'multi': ?s=slot,slot…).
        navigateTo(`#/multi?s=${slots.map(encodeURIComponent).join(',')}`);
      } catch (err) {
        console.error('Make variants failed:', err);
        announce('Save failed');
      } finally {
        multiBtn.disabled = false;
        multiBtn.removeAttribute('aria-busy');
        delete multiBtn.dataset.saving;
      }
    };
    const menu = mountBodyPopover(multiBtn, (pop) => {
      pop.innerHTML = `
        <div class="multi-edit-menu-head">${t('How many copies?')}</div>
        <div class="multi-edit-menu-counts">${[2, 3, 4, 5, 6, 7, 8].map(n =>
          `<button type="button" class="multi-edit-count" role="menuitem" data-count="${n}">${n}</button>`).join('')}</div>`;
      pop.querySelectorAll<HTMLButtonElement>('[data-count]').forEach(b => b.addEventListener('click', () => {
        menu.close();
        void makeVariants(Number(b.dataset.count));
      }));
      return pop.querySelector<HTMLElement>('[data-count]');
    }, {
      className: 'multi-edit-menu',
      ariaLabel: t('Make variants'),
      // Left-aligned under the trigger (the default is right-aligned — built for
      // the top-right chrome; this trigger sits in the LEFT sidebar).
      position(pop, anchor) {
        const r = anchor.getBoundingClientRect();
        pop.style.top  = `${Math.round(r.bottom + 8)}px`;
        pop.style.left = `${Math.max(8, Math.round(r.left))}px`;
      },
    });
    multiBtn.addEventListener('click', () => { menu.isOpen() ? menu.close(true) : menu.open(); });
  }

  // Apply the initial (or restored) dimensions to the canvas preview immediately.
  refreshCanvasPreview();

  // Render to the live frame for PREVIEW only (deferred-preview tools — see
  // manifest.render.preview). We run the normal export pipeline purely for its
  // side effect: an expensive beforeExport hook (e.g. url-shot's page capture)
  // paints its result into the canvas DOM. We then discard the blob — no
  // download, no clipboard. The painted frame stays until the next input change
  // rebuilds the template (which correctly invalidates the stale preview).
  let previewing = false;
  async function preview(): Promise<void> {
    if (previewing) return;
    previewing = true;
    try {
      const fmt = (manifest.render.preview as { format?: string } | undefined)?.format || manifest.render.formats[0]!;
      await exportUnscaled(() => runtime.export(canvasEl, fmt, exportDims()));
    } finally {
      previewing = false;
    }
  }

  // Expose actions the mount scope can trigger programmatically (e.g. `?copy`,
  // and the unsaved-changes dialog's "Save & leave"). stopAudioPreview lets the
  // popup-close + tool-teardown paths silence an in-progress audio audition.
  return { copy: performCopy, preview, save: performSave, setDims, stopAudioPreview };
}

// Adds scroll-to-change and click-drag-to-scrub to a number input.
// Dragging uses Pointer Lock once the threshold is crossed so the cursor
// wraps across screen edges and movement is truly unbounded.
// onChange fires after every value change from either interaction.
// opts.format(value) returns the label shown in the floating readout that
// appears while dragging (defaults to the bare value) — see scrub-readout.js.
function addScrubBehavior(inputEl: HTMLInputElement, onChange: () => void, opts: { format?: (value: string) => string } = {}): void {
  const format = opts.format ?? ((v: string) => String(v));
  const getMin = () => parseInt(inputEl.min, 10) || 1;
  const getMax = () => parseInt(inputEl.max, 10) || 99999;
  const clamp  = (v: number): number => Math.min(getMax(), Math.max(getMin(), v));

  inputEl.addEventListener('wheel', e => {
    // Only hijack the wheel to scrub the value when the field is focused; otherwise
    // let the event bubble so the surrounding panel scrolls past it normally.
    if (document.activeElement !== inputEl) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    inputEl.value = String(clamp((parseInt(inputEl.value, 10) || 0) + (e.deltaY < 0 ? step : -step)));
    onChange();
  }, { passive: false });

  let dragging    = false;
  let wasDragging = false;
  let activeId: number | null = null;   // the one pointer currently driving a drag

  inputEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    // One scrub at a time: a second finger landing on the field mustn't reset the
    // baseline of the drag already in progress (it drove jumpy values on touch).
    if (activeId !== null) return;
    activeId = e.pointerId;
    const startX   = e.clientX;
    const startVal = parseInt(inputEl.value, 10) || 0;
    // Touch can't lock the pointer, so the value stays hidden under the finger —
    // track the readout above the touch point; otherwise anchor it to the field.
    const isTouch  = e.pointerType === 'touch';
    let   accumulated = 0; // total delta once pointer lock is active
    let   lastScrubVal = String(startVal); // last value we ticked on, so we tick per step
    dragging = false;
    inputEl.setPointerCapture(e.pointerId);

    // Float the live value clear of the cursor/finger while dragging.
    function showReadout(ev: PointerEvent): void {
      const text = format(inputEl.value);
      if (isTouch) showScrubReadout({ text, finger: { x: ev.clientX, y: ev.clientY } });
      else showScrubReadout({ text, anchorEl: inputEl });
    }

    function onMove(e: PointerEvent): void {
      if (e.pointerId !== activeId) return;   // ignore any other pointer
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < 4) return;
        dragging = true;
        document.body.style.cursor = 'ew-resize';
        // Request pointer lock so the cursor wraps at screen edges.
        // unadjustedMovement removes OS pointer acceleration for 1:1 scrubbing.
        // Skipped for touch (unsupported) — the clientX fallback drives it there.
        if (!isTouch) {
          const req = inputEl.requestPointerLock?.({ unadjustedMovement: true });
          if (req instanceof Promise) {
            req.catch(() => inputEl.requestPointerLock?.());
          }
        }
      }

      const step = e.shiftKey ? 10 : 1;
      if (document.pointerLockElement === inputEl) {
        // Locked: accumulate raw movementX — no screen-edge limit.
        accumulated += e.movementX * step;
        inputEl.value = String(clamp(startVal + Math.round(accumulated)));
      } else {
        // Lock not yet active (or unavailable): fall back to clientX delta.
        const dx = e.clientX - startX;
        inputEl.value = String(clamp(startVal + Math.round(dx * step)));
        // Keep accumulated in sync so the switch to locked mode is seamless.
        accumulated = parseInt(inputEl.value, 10) - startVal;
      }
      if (inputEl.value !== lastScrubVal) { lastScrubVal = inputEl.value; playScrubTick(); } // detent per step
      onChange();
      showReadout(e);
    }

    function onUp(e?: PointerEvent): void {
      // pointerup/cancel carry an event (ignore other pointers); onLockChange
      // calls onUp() with no argument to force a release.
      if (e && e.pointerId !== activeId) return;
      inputEl.removeEventListener('pointermove',   onMove);
      inputEl.removeEventListener('pointerup',     onUp);
      inputEl.removeEventListener('pointercancel', onUp);
      document.removeEventListener('pointerlockchange', onLockChange);
      if (document.pointerLockElement === inputEl) document.exitPointerLock();
      document.body.style.cursor = '';
      hideScrubReadout();
      if (dragging) {
        wasDragging = true;
        setTimeout(() => { wasDragging = false; }, 50);
      }
      dragging = false;
      activeId = null;
    }

    function onLockChange(): void {
      // Escape key or other external release — stop dragging cleanly.
      if (document.pointerLockElement !== inputEl) onUp();
    }

    inputEl.addEventListener('pointermove',   onMove);
    inputEl.addEventListener('pointerup',     onUp);
    inputEl.addEventListener('pointercancel', onUp);
    document.addEventListener('pointerlockchange', onLockChange);
  });

  // Suppress the click-to-focus that follows a drag so the cursor doesn't jump into text mode.
  inputEl.addEventListener('click', e => {
    if (wasDragging) { e.preventDefault(); inputEl.blur(); }
  });
}

// Cap on a vector thumbnail's raw SVG size. Dense vector output (e.g. a halftone
// with thousands of dots) can serialise to megabytes; above this we fall back to
// the raster path so a single thumbnail never bloats storage unbounded.
const SVG_THUMB_MAX_BYTES = 1_500_000;

async function captureThumbnail(manifest: ToolManifest, canvasEl: HTMLElement | null, runtime: Runtime, exportUnscaled: ExportUnscaled, format = '', shutter = true): Promise<string | null> {
  // Capture at the canvas's ACTUAL laid-out aspect, not the manifest default. A reflow tool
  // (e.g. color-block) sizes its canvas to the ?width/height it was loaded with, so a wide /
  // tall / banner look must be captured at THAT aspect — exporting it into the default square
  // scales it non-uniformly and it comes out stretched. offsetWidth/Height are transform-
  // independent (unaffected by the editor's zoom), the same basis the paged-page capture and
  // the offscreen renderVariantAt dims use; the manifest is the fallback when the node has no
  // box yet. For a default-size session this equals the manifest, so nothing else changes.
  const nw = canvasEl?.offsetWidth  || manifest.render.width  || 600;
  const nh = canvasEl?.offsetHeight || manifest.render.height || 600;

  // Vector thumbnail: when the effective export format is SVG (the user picked it,
  // or it's the tool's default), capture an SVG data-URL instead of a PNG. SVG is
  // resolution-independent — it renders in the gallery's <img> and stays crisp at
  // any card size. renderSvg() inlines blob-URLs and vector tools outline their
  // text, so the SVG is self-contained and safe in an <img> sandbox. Falls through
  // to the raster path on failure or if the SVG is pathologically large.
  //
  // A gallery tile is just a screenshot, and a *vector* screenshot stays crisp at any
  // size — so preview generation (scripts/build-previews.ts) sets __lollyForceVectorThumb
  // to take this branch for ANY tool, even one that doesn't offer SVG *export*. The
  // walker (renderSvgFromHtml) vectorises any HTML/CSS canvas; a hiccup or an oversized
  // (dense) result falls through to the pixel-faithful raster path below. Real user
  // saves never set the flag, so their thumbnail still tracks the chosen export format.
  const forceVector = !!(globalThis as { __lollyForceVectorThumb?: boolean }).__lollyForceVectorThumb;
  if (format === 'svg' || forceVector) {
    try {
      const blob = await exportUnscaled(
        () => runtime.export(canvasEl, 'svg', { width: nw, height: nh, embedMeta: false, thumbnail: true }),
        { shutter },
      );
      const svg = await blob.text();
      if (svg && svg.length <= SVG_THUMB_MAX_BYTES) {
        return `data:image/svg+xml,${encodeURIComponent(svg)}`;
      }
    } catch { /* fall through to the raster path */ }
  }

  // Raster thumbnail (default): a PNG sized for the gallery's preview-forward hero
  // (shown up to a full card column wide, at 2× for retina). Storage isn't a
  // concern for the single most-recent session per tool.
  try {
    const maxW = 720;
    const maxH = 560;
    const scale = Math.min(maxW / nw, maxH / nh);
    const tw = Math.max(1, Math.round(nw * scale));
    const th = Math.max(1, Math.round(nh * scale));
    // Mask the brief full-res resize with the shutter — the thumbnail is a fast
    // single PNG frame, so the shutter fully covers it for every tool.
    const blob = await exportUnscaled(
      // thumbnail:true lets expensive hooks (e.g. url-shot's capture) reuse the
      // last render on the canvas instead of re-running a slow capture.
      () => runtime.export(canvasEl, 'png', { width: tw, height: th, embedMeta: false, thumbnail: true }),
      { shutter },
    );
    return await new Promise<string | null>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export { renderActions, captureThumbnail, extFor, isCmykFmt, isPrintFmt, printEnabled, marksToCsv, c2paDefaultOn, readBleed, readMarks };
