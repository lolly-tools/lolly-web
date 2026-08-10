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
import { serializeUrlState, UNITS, toCssPx, CMYK_CONDITIONS, DEFAULT_CMYK_CONDITION, C2PA_FORMATS, composeSong, generatedSongSpec, HDR_DEFAULTS, preflight, PRINT_MARK_FORMATS, SEPARATING_FORMATS, computeCost, parseRateCard, isRateCardError, validateRateCard } from '@lolly/engine';
import type {
  Fact, PreflightInput, PreflightJob, PreflightManifest, PreflightSwatch, StageFacts, Count, CostWorking,
} from '@lolly/engine';
import type { MoneyContext } from '@lolly-tools/core';
import { escape } from '../utils.js';
import { t, tRaw } from '../i18n.ts';
import { confirmDialog } from '../components/confirm-dialog.ts';
import { icon } from '../lib/icons.ts';
import { navigateTo } from '../nav.js';
import { announce } from '../a11y.js';
import { livePalette } from '../lib/live-palette.ts';
import { isOwnProfile, ownDigest, listEligible, embedRowLabel } from '../lib/press-profile-embed.ts';
import { marksToCsv } from '../lib/print-marks-csv.ts';
import { placedImageLabel, isVectorImageSrc } from '../lib/placed-image.ts';
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
import { MAX_TIME_S } from './timeline-math.ts';
import { bumpMetric, recordFormat } from '../metrics.js';
import { videoSupport, audioSupport, cmykTiffSupport, tiffSupport, liveCaptureSupport, durableSupport, proFormatSupport } from '../bridge/format-support.js';
import { isAudioFormat as isAudioFmt } from '../lib/audio-encode.js';
import { isProFormat, formatOptionsHtml, depthFact, applyDepthFact } from './export-depth.ts';
import { preflightRowHtml, preflightView, applyPreflight, wirePreflight } from './export-preflight.ts';
import { costPanelHtml, costView, applyCostPanel } from './cost-panel.ts';
import type { CostAuthoringContext } from './cost-panel.ts';
import { listRateCards, listCatalogRateCards, getRateCardBlob } from '../lib/rate-cards.ts';
import { mountSlot, onExtensionsChanged, slotHasResolved } from '../lib/extensions.ts';
import type { Disposer } from '@lolly-tools/core/extension-v1';
import { RASTER_DEFAULT_SCALE, SUPERSAMPLED_EXPORT_FORMATS } from '../bridge/export-scale.ts';
import { CENTRE_LOW } from '../bridge/audio-envelope.ts';
import { getExportPolicy, exportAffordance } from '../lib/export-policy.ts';
import { openApprovalRequest } from '../lib/approval-request.ts';

import type { InputValue } from '../../../../engine/src/inputs.js';
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
import { jellyActive } from '../lib/jelly.ts';

// Human-readable labels and file extensions for format identifiers that differ
// Export-target opt-in (plan: run-web-code render). A tool whose exported output is
// NOT its whole canvas — e.g. a code sandbox whose rendered preview is transplanted
// into a same-origin mirror node — marks that node with `data-export-root`; the
// walker then rasterises the mirror instead of the IDE chrome. Inert by construction
// for every other tool: no marker → querySelector null → the canvas itself is used.
export const exportTargetNode = (c: HTMLElement | null): HTMLElement | null =>
  c?.querySelector<HTMLElement>('[data-export-root]') ?? c;

// from their raw string (e.g. "pdf-cmyk" → "Print PDF" / ".pdf").
const FMT_LABEL: Record<string, string> = { 'pdf-cmyk': 'Print PDF', 'cmyk-tiff': 'Print TIFF', tiff: 'TIFF', 'jpeg': 'JPG', 'webm': 'WebM', 'mp4': 'MP4', apng: 'aPNG', 'webp-anim': 'Animated WebP', 'svg-anim': 'Animated SVG',
  emf: 'EMF (old)', eps: 'EPS', 'eps-cmyk': 'EPS (CMYK)', dxf: 'DXF (cut file)', pptx: 'PowerPoint', docx: 'Word', odt: 'OpenDocument', ics: 'Calendar', vcf: 'vCard', ico: 'Icon', zip: 'ZIP', csv: 'CSV', json: 'JSON',
  // Palette exchange (color-palette): a design-tokens JSON, CSS/SCSS variable
  // blocks, a GIMP palette, and a binary Adobe swatch file. extFor falls back to
  // the format id for each (blob MIME isn't mp4/webm/zip), so no FMT_EXT entry.
  css: 'CSS', scss: 'SCSS', gpl: 'GIMP palette', ase: 'Adobe swatches',
  // Audio only. Opus ships in a WebM container, so the label says so rather than
  // leaving a download named .webm looking like a video.
  wav: 'WAV', mp3: 'MP3', m4a: 'M4A (AAC)', opus: 'Opus (WebM)' };
const FMT_EXT: Record<string, string>   = { 'pdf-cmyk': 'pdf', 'cmyk-tiff': 'tiff', 'jpeg': 'jpg', 'eps-cmyk': 'eps', 'webp-anim': 'webp', 'svg-anim': 'svg' };
// Animated WebP is credentialed via the still-'webp' path (renderFormat maps
// webp-anim→webp before stamping), but the engine's C2PA_FORMATS lists only 'webp' —
// so treat webp-anim as stampable in the UI gating too, else the toggle/card would be
// hidden and opts.c2pa never set, silently dropping the default provenance.
const isC2paFmt = (f: string | undefined): boolean => !!f && (C2PA_FORMATS.includes(f) || f === 'webp-anim');

// The durable in-pixel watermark embeds two ways: the standalone raster encoders
// (renderRaster/renderBitmap/renderTiff's opts.imprint branch), and — for the
// CONTAINER formats — imprintEmbedCanvas baking the mark into each Lolly-rendered
// raster as it's composited into a PDF page / PPTX slide (bridge/export.ts +
// export-pptx.ts). So the list covers both: still rasters AND pdf/pdf-cmyk/pptx.
// A pure-vector container marks nothing (no raster to carry it) — the C2PA claim
// is gated on whether a mark was actually applied, never on this list, so no
// over-claim (see export.ts stampC2pa). Mirrors the deep-link gate in views/tool.ts.
// Zip carries the flag through to its bundled raster + container members.
const isImprintFmt = (f: string | undefined): boolean => !!f && ['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'pdf', 'pdf-cmyk', 'pptx'].includes(f);
// Durable (neural TrustMark) embed is RASTER-ONLY — no pdf/pptx container path yet
// (export.ts durableEmbedCanvas; see plans/28-durable-content-credentials.md).
const isDurableFmt = (f: string | undefined): boolean => !!f && ['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff'].includes(f);
// HDR (Rec.2100 PQ) raster export. PNG (cICP) + JPEG (PQ ICC) + AVIF (native nclx
// colr) + TIFF (PQ ICC tag, archival). WebP is excluded on purpose — it has no
// working HDR decode path, so a PQ WebP would just look dark.
const isHdrFmt = (f: string | undefined): boolean => !!f && ['png', 'jpg', 'jpeg', 'avif', 'tiff'].includes(f);

// Print marks & bleed apply to the three print formats (pdf / pdf-cmyk / cmyk-tiff).
// Defaults when the user turns the card on; the CSV tokens (crop,reg,bleed,bars)
// match the engine's `marks` URL param (engine/src/url-mode.js parseMarks). Bleed is
// carried as a dimension string. The Color profile (press condition) card applies to
// the two CMYK formats.
const DEFAULT_PRINT_MARKS: PrintMarks = { crop: true, registration: true, bleed: true, colorBars: false, provenance: true };
// Both read the ENGINE's tables (engine/src/preflight.ts) rather than restating
// the literals. The card that OFFERS bleed and the check that reports it missing
// have to agree by construction: two copies is how "the panel hides the bleed card
// but the URL still carries bleed" happens. `isCmykFmt` is the two formats that
// build a process separation AND emit through the panel's Color profile card, i.e.
// the separating set minus eps-cmyk, which this panel does not offer settings for.
const isCmykFmt  = (f: string | undefined): boolean => SEPARATING_FORMATS.has(f ?? '') && f !== 'eps-cmyk';
const isPrintFmt = (f: string | undefined): boolean => PRINT_MARK_FORMATS.has(f ?? '');
// Print INTENT is narrower than print CAPABILITY. Every PRINT_MARK_FORMATS member
// can CARRY bleed and marks (that is what keeps the card on offer for pdf/svg/eps),
// but only the separating press formats (pdf-cmyk / cmyk-tiff / eps-cmyk) MEAN
// print by being picked — an everyday RGB PDF or SVG is a share/screen format
// first, so marks and bleed stay OFF for it until the user (or an explicit
// bleed/marks link/save, or a manifest declaring render.printMarks: true) asks.
// Physical units (mm/cm/in + dpi) are a size statement, not print intent, and
// never enable marks on their own.
const isPressFmt = (f: string | undefined): boolean => SEPARATING_FORMATS.has(f ?? '');
// The `marks` CSV codec lives in lib/print-marks-csv.ts — one encoder, one
// decoder, shared with the batch/folder render path (which previously had no way
// to read a stored CSV back and so dropped print marks entirely).

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

// Which video containers this browser can actually produce (MediaRecorder OR the
// WebCodecs probe — see videoSupport). Read per call, NOT snapshotted at module
// load: the WebCodecs half resolves asynchronously just after boot, and a module-
// scope const would freeze the pre-probe answer forever.
// Print TIFF is desktop-only with working canvas readback (see cmykTiffSupport);
// hide it everywhere it can't be produced or cleanly downloaded.
const CMYK_TIFF_OK = cmykTiffSupport();
const TIFF_OK = tiffSupport();
const keepFormat = (f: string, deepExportOk = false): boolean =>
  f === 'webm' ? videoSupport().webm
  : f === 'mp4' ? videoSupport().mp4
  // wav/mp3 are pure JS and always pass; m4a/opus need the platform's WebCodecs
  // AudioEncoder, so they are hidden where it cannot produce them.
  : isAudioFmt(f) ? audioSupport()[f]
  : f === 'cmyk-tiff' ? CMYK_TIFF_OK
  : f === 'tiff' ? TIFF_OK
  // The pro float formats (exr/hdr) reach the picker two ways: the generic Node
  // float rasteriser (proFormatSupport — false on the web), OR a tool that owns
  // them through an exportStill hook computed in float via host.codec (bitmap
  // studio). `deepExportOk` is that second, tool-specific producer — the runtime
  // routes exr/hdr to exportStill before the 8-bit DOM path (runtime.ts:752), so
  // where a tool can genuinely originate the float master the option is honest.
  : isProFormat(f) ? (proFormatSupport() || deepExportOk)
  : true;

const fmtLabel = (f: string): string => FMT_LABEL[f] ?? f.toUpperCase();

// Download extension follows the produced Blob — a deep-linked video request may
// fall back to the other container, so trust the Blob's MIME over the format id.
function extFor(fmt: string, blob: Blob | null | undefined): string {
  const t = blob?.type || '';
  // Audio first: an .m4a IS an MP4 container and Opus audio IS a WebM one, so the
  // MIME sniff below would rename both to their video extension.
  if (isAudioFmt(fmt)) return fmt === 'opus' ? 'webm' : fmt;
  if (t.includes('mp4'))  return 'mp4';
  if (t.includes('webm')) return 'webm';
  // A contact sheet (cuts > 1) of a still format comes back as a ZIP of N members,
  // so the requested format id says 'png' while the bytes are an archive. Same rule
  // as the video fallback above: the Blob wins, or the user downloads a sheet.png
  // that no image viewer can open.
  if (t.includes('zip'))  return 'zip';
  return FMT_EXT[fmt] ?? fmt;
}

// fitCanvas and exportUnscaled are passed in so refreshCanvasPreview and the
// export actions can coordinate with the responsive-scaling logic in mountTool.
function renderActions(el: PanelEl | null, manifest: ToolManifest, runtime: ToolRuntime, canvasEl: HTMLElement | null, host: WebToolHost, fitCanvas: () => void, exportUnscaled: ExportUnscaled, exportDefaults: ExportDefaults = {}, onUrlSync: ((key?: string) => void) | null = null, playShutter: () => void = () => {}, fileIntoFolder: string | null = null, returnTo = '/', initialSlot: string | null = null, reachedViaLink = false): ActionsApi | undefined {
  // The slot this editing session writes to. Seeded from a resumed `?slot=` session,
  // otherwise null until the first save mints one. Every subsequent save (the Save
  // button, the render-pill quick-Save, "Save & leave") reuses it so edits UPDATE the
  // same saved session in place instead of spawning a new one on each save. Without
  // this, re-saving after an edit orphaned a fresh copy in Uncategorised and left the
  // original folder card frozen at its first-save state.
  let activeSlot = initialSlot;
  // Does the on-screen canvas ARTBOARD follow the export width/height (so a dimension
  // change resizes it 1:1), or is it a scaled preview thumbnail that must be clamped to
  // the native render size? This mirrors EXACTLY the condition under which tool.ts hands
  // the free-canvas overlay a `setCanvasSize` (a resizable editor): render.layout:'editor',
  // NOT a carousel (render.pages — the page strip owns the size), and NOT a fixed canvas
  // (canvas.fixedCanvas — connector geometry stays native-locked). Keeping the two in lock-
  // step is what makes the export-bar and rail size paths agree. See refreshCanvasPreview.
  const canvasBlocksInput = manifest.inputs?.find(
    (i) => i.type === 'blocks' && (i as { canvas?: unknown }).canvas,
  ) as { canvas?: { fixedCanvas?: boolean } } | undefined;
  const artboardFollowsDims =
    manifest.render.layout === 'editor' &&
    !manifest.render.pages &&
    !canvasBlocksInput?.canvas?.fixedCanvas;
  // Shareable-link button (wired by wireUpCopyUrl). A link glyph + label; the
  // label is swapped to "Copied!" on click, so it's wrapped in its own span to
  // keep the icon. Lives at the foot of the actions bar — after the render
  // (Download) button, so on mobile it stacks behind it.
  // Share glyph + label, shared by both control kinds so the row stays uniform.
  const SHARE_SVG = `<svg class="copy-url-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></svg>`;
  const copyUrlBtn = jellyActive()
    ? `<jelly-button variant="platinum" data-action="copy-url" class="copy-url-btn" title="Copy a shareable link" label="Share">${SHARE_SVG}<span data-copy-url-label>Share</span></jelly-button>`
    : `<button type="button" data-action="copy-url" class="copy-url-btn btn" title="Copy a shareable link" aria-label="Share">${SHARE_SVG}<span data-copy-url-label>Share</span></button>`;

  // Save glyph — a tray with a down-arrow (matches the Feather "download" mark),
  // line-art to sit consistently beside the Copy and Share icons.
  const SAVE_SVG = `<svg class="save-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

  // The Save action — one builder for both render sites (the default actions row
  // and the save-only bar for input-less tools). Jelly mode swaps in a neutral
  // <jelly-button>; the `save-btn` class stays for the icon-collapse @container
  // rules, which are class-keyed, and carries no box paint of its own.
  const saveBtnHtml = () => jellyActive()
    ? `<jelly-button variant="platinum" data-action="save" data-sfx="save" class="save-btn" title="Save to your library">${SAVE_SVG}<span data-save-label>Save</span></jelly-button>`
    : `<button data-action="save" data-sfx="save" class="save-btn" title="Save to your library">${SAVE_SVG}<span data-save-label>Save</span></button>`;

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
    // Either the native <button> or its jelly-mode <jelly-button> stand-in —
    // disabling goes through the ATTRIBUTE, which both honour (jelly-button
    // observes it and syncs its shadow button).
    const btn = (saveBtnEl ?? el?.querySelector('[data-action="save"]')) as HTMLButtonElement | null;
    if (!btn || btn.dataset.saving) return false;
    const label = btn.querySelector<HTMLElement>('[data-save-label]') ?? btn;
    const idle  = label.textContent;
    btn.dataset.saving = '1';
    btn.toggleAttribute('disabled', true);
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
      btn.toggleAttribute('disabled', false);
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
    el.innerHTML = `<div class="export-action-buttons">${saveBtnHtml()}${copyUrlBtn}</div>`;
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
  // Show only the video containers this browser can produce (Safari→mp4, Firefox→webm,
  // recent Chrome→both); non-video formats always pass. See keepFormat / videoSupport.
  // A tool with a float-compose exportStill hook + host.codec can originate the pro
  // float formats (exr/hdr) on-device even without the Node float rasteriser — so the
  // Pro <optgroup> opens for it here (e.g. Bitmap Studio's EXR/Radiance masters).
  const toolDeepExport = !!manifest.hooks?.exportStill && !!host.codec;
  const formats       = manifest.render.formats.filter(f => keepFormat(f, toolDeepExport));
  const hasAnimated   = formats.some(isAnimatedFmt);
  // matchExportFormat: default the export to a dropped file's OWN format (a JPEG →
  // jpg) until the user picks one. Reads AssetRef.format off the flagged input.
  const matchFmtInput = (manifest.inputs || []).find((i) => (i as { matchExportFormat?: boolean }).matchExportFormat);
  const assetExportFormat = (): string | null => {
    if (!matchFmtInput) return null;
    const v = runtime.getModel().find((m) => m.id === matchFmtInput.id)?.value as { format?: string } | null | undefined;
    let f = (v && typeof v === 'object' && v.format) ? String(v.format).toLowerCase() : '';
    if (f === 'jpeg') f = 'jpg';
    return f && formats.includes(f) ? f : null;
  };
  // A ?format= link or a saved session (exportDefaults.format) is an explicit choice
  // and wins; otherwise follow the upload's format, falling back to the first format.
  const initialFmt    = (exportDefaults.format && formats.includes(exportDefaults.format))
    ? exportDefaults.format
    : (assetExportFormat() || formats[0]);
  const videoDefaults = (manifest.render.video ?? {}) as { wait?: number; duration?: number };
  const defaultWait     = videoDefaults.wait     ?? 1;

  // ── Timed compositions (Sequence Studio) ───────────────────────────────────
  // A timed artboard carries [data-sequence] plus data-seq-ms="<derived length>",
  // restamped by the tool's hook on every paint (the same attribute the exporter's
  // sequence planner and the on-canvas clock read). For those tools the manifest's
  // render.video.duration is a constant that says nothing about the user's actual
  // timeline — so the export bar takes its duration FROM the timeline instead, and
  // keeps following it as clips are trimmed/added, until the user types their own
  // value (see durationUserSet below).
  const seqStageEl = (): HTMLElement | null => !canvasEl ? null
    : (canvasEl.matches?.('[data-sequence]') ? canvasEl : canvasEl.querySelector<HTMLElement>('[data-sequence]'));
  /** The live timeline length in seconds, or null when this isn't a timed composition. */
  const seqDurationS = (): number | null => {
    const stage = seqStageEl();
    if (!stage) return null;
    const msEl = stage.matches?.('[data-seq-ms]') ? stage
      : (stage.querySelector<HTMLElement>('[data-seq-ms]') ?? canvasEl?.querySelector<HTMLElement>('[data-seq-ms]') ?? null);
    const ms = parseFloat(msEl?.getAttribute('data-seq-ms') ?? '');
    if (!Number.isFinite(ms) || ms <= 0) return null;
    // Centisecond precision: exact for whole-second timelines, and never rounds a
    // clip away. Clamped to the timeline's own ceiling (timeline-math MAX_TIME_S).
    return Math.min(MAX_TIME_S, Math.max(0.1, Math.round(ms / 10) / 100));
  };
  /** The bed in-point in seconds a tool stamps on its stage as data-audio-start
   *  (0 when it doesn't, or the value is unusable) — see the export handler. */
  const stageAudioStart = (): number => {
    const elS = canvasEl?.matches?.('[data-audio-start]') ? canvasEl : canvasEl?.querySelector<HTMLElement>('[data-audio-start]');
    const s = parseFloat(elS?.getAttribute('data-audio-start') ?? '');
    return Number.isFinite(s) && s > 0 ? s : 0;
  };
  const seqInitialDuration = seqDurationS();
  const defaultDuration = seqInitialDuration ?? videoDefaults.duration ?? 5;
  // A sequence can legitimately run far past the 60s the recording field allows for
  // ordinary "record the animation for a while" tools, so it takes the timeline's own
  // ceiling (1 hour). Non-sequence tools keep the existing 60s cap.
  const durationMax = seqInitialDuration != null ? MAX_TIME_S : 60;

  // Directional glyphs that live inside the dimension inputs: ↔ marks width,
  // ↕ marks height, so the two fields read as "wide × tall" without labels.
  const ICON_W = `<svg class="dim-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 8 3 12 7 16"/><polyline points="17 8 21 12 17 16"/><line x1="4" y1="12" x2="20" y2="12"/></svg>`;
  const ICON_H = `<svg class="dim-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`;

  // Tier 1 — filename · format. The format selector is the highest-priority
  // control; the filename rides alongside it as the natural "name.format" pair.
  //
  // The float interchange formats (exr/hdr) are compositing containers, not peers
  // of png/jpg, so they sit in their own native <optgroup> — no custom CSS, no
  // extra space, native a11y. The group is built from what SURVIVED keepFormat, so
  // it exists only where those formats can actually be produced: on the web that is
  // a tool with a float-compose exportStill hook (see toolDeepExport above — Bitmap
  // Studio), and otherwise nowhere (a plain tool has no float master). The markup
  // then has no optgroup in it at all. See views/export-depth.ts.
  const formatOptions = formatOptionsHtml(formats, initialFmt, fmtLabel);
  const filenameRow = `
      <div class="filename-extension">
        <input type="text" class="export-filename" data-action="filename"
              value="${escape(exportDefaults.filename ?? manifest.name)}" placeholder="filename" spellcheck="false">
        ${formats.length > 1 ? `
          <select data-action="format" aria-label="Export format">
            ${formatOptions}
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

  // Export-fidelity guard. Some CSS the canvas can paint has no equivalent in the
  // chosen output format, and until now it simply vanished from the file with nothing
  // said. `backdrop-filter` (frosted glass) is the first case wired up: only SVG can
  // reconstruct it, so every other format exports the panel unfrosted. Same hidden
  // alert shape as the aspect guard, driven by updateFidelityWarning(). Never exported.
  const fidelityWarnRow = `<div class="export-aspect-warning" data-fidelity-warning role="alert" hidden>${ICON_WARN}<span data-fidelity-warning-text></span></div>`;

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
  // The full explanation lives under the info icon (helpTip), not as a wall of body
  // text — same affordance as the C2PA / Imprint rows.
  const cmykTip = hasCmyk ? helpTip(
    "Names the CMYK press standard your printer targets: the Print PDF's output intent, the Print TIFF's metadata (the pixels stay untagged DeviceCMYK). An Embed row carries a profile from this device inside the PDF, which is what PDF/X-4 conformance needs; the file then claims it unless something else in the export can't (RGB artwork, the credit-text stamp, a strong password)."
  ) : null;
  const cmykRow = hasCmyk ? `
      <div class="section-card export-cmyk" data-cmyk-only style="display:${isCmykFmt(initialFmt) ? 'flex' : 'none'}">
        <span class="cmyk-head help-tip-host">${ICON_DROP}<span>Color profile</span>${cmykTip!.button}${cmykTip!.pop}</span>
        <select class="field-select" data-action="cmyk-profile" aria-label="CMYK press profile">
          ${cmykOptions}
        </select>
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
          <select class="pdfpass-tier field-select field-select--sm" data-action="pdf-lock-tier" aria-label="Encryption strength">
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
        <label class="c2pa-enable field-toggle help-tip-host">
          <input type="checkbox" class="field-check" data-action="pdf-c2pa" ${c2paInitOn ? 'checked' : ''}>
          <span class="c2pa-head">${ICON_CRED}<span>C2PA Credentials</span></span>
          ${c2paTip!.button}
          ${c2paTip!.pop}
        </label>
        <p class="c2pa-hint" data-c2pa-webm style="display:${initialFmt === 'webm' ? 'block' : 'none'}">WebM credentials are Lolly's own mapping for now — external C2PA viewers can't read WebM.</p>
        <div class="c2pa-life" data-c2pa-life>
          <label class="c2pa-life-pick"><span class="c2pa-life-label">Expires:</span>
            <select class="field-select field-select--sm field-select--auto" data-action="c2pa-days" aria-label="Credential lifetime">
              ${[7, 30, 90, 365].map(d => `<option value="${d}"${d === c2paInitDays ? ' selected' : ''}>${d} days</option>`).join('')}
            </select>
          </label>
        </div>
      </div>` : '';

  // Tier 2.66 — the Lolly pixel imprint (engine pixel-watermark.ts): a durable,
  // imperceptible mark mixed into the exported pixels. It completes the provenance
  // story next to the C2PA card above — the credential is strippable, the pixel
  // mark survives re-encodes/screenshots, and /verify detects both. On by default,
  // like C2PA; `?imprint=0` unchecks it, and the toggle round-trips back into the
  // URL (see views/tool.ts syncUrl) — unchecking sets imprint=0, checking (the
  // default) drops the param entirely so a plain link stays clean.
  const imprintFmts = formats.filter(isImprintFmt);
  // A .pptx / .pdf is a CONTAINER: the Imprint can only ride raster images it
  // embeds, never the native vector slides/shapes or byte-faithful user uploads.
  // A deck of headings, boxes and a vector logo (or one whose only pictures are
  // your own photos) therefore carries no detectable Imprint even with it on — so
  // say so rather than let the toggle over-promise. It lands on baked content:
  // rotated or CSS-filtered elements, effect layers, inline SVG art, rendered charts.
  const containerImprintFmt = imprintFmts.some((f) => f === 'pptx' || f === 'pdf' || f === 'pdf-cmyk');
  const imprintTip = imprintFmts.length ? helpTip(
    t('Hides the Lolly Imprint — a durable, invisible watermark — in the image pixels. It survives re-encoding and screenshots, so any copy of the file can be recognised later.')
    + (containerImprintFmt ? ' ' + t('It rides embedded raster images, not the vector shapes and text — a slide or page built only of headings, boxes and a vector logo has no pixels to carry it.') : ''),
    { href: '#/verify', text: t('Check a file →') }
  ) : null;
  const imprintRow = imprintFmts.length ? `
      <div class="section-card export-c2pa export-imprint" data-imprint-only style="display:${isImprintFmt(initialFmt) || initialFmt === 'zip' ? 'flex' : 'none'}">
        <label class="c2pa-enable field-toggle help-tip-host">
          <input type="checkbox" class="field-check" data-action="imprint" ${exportDefaults.imprint !== false ? 'checked' : ''}>
          <span class="c2pa-head">${icon('imprint', { className: 'c2pa-icon' })}<span>${t('Lolly Imprint')}</span></span>
          ${imprintTip!.button}
          ${imprintTip!.pop}
        </label>
      </div>` : '';

  // Tier 2.67 — the DURABLE credential (opt-in): a neural TrustMark-format mark
  // carrying Lolly's id, so the "made with Lolly" link survives a metadata strip
  // and TrustMark-aware tools can recover it. OFF by default — unlike the pure-JS
  // Imprint, this is a per-export neural encode PLUS a one-time model download
  // (expensive performance-wise), so it's a deliberate opt-in. Raster only. The
  // toggle round-trips into the URL as ?durable=1 (see views/tool.ts syncUrl).
  // Hidden entirely where the neural embed can't work offline (Tauri desktop/mobile —
  // no origin to fetch the ~33 MB model from), so the toggle never shows as a no-op.
  const durableFmts = durableSupport() ? formats.filter(isDurableFmt) : [];
  const durableTip = durableFmts.length ? helpTip(
    t('Embeds a durable, invisible credential in the pixels with an on-device AI model, so a copy survives metadata stripping and re-encoding — and TrustMark-aware tools can read it too. Heavier than the Imprint (a neural pass plus a one-time model download), so it is off by default.'),
    { href: '#/verify', text: t('Check a file →') }
  ) : null;
  const durableRow = durableFmts.length ? `
      <div class="section-card export-c2pa export-durable" data-durable-only style="display:${isDurableFmt(initialFmt) ? 'flex' : 'none'}">
        <label class="c2pa-enable field-toggle help-tip-host">
          <input type="checkbox" class="field-check" data-action="durable" ${exportDefaults.durable ? 'checked' : ''}>
          <span class="c2pa-head">${icon('imprint', { className: 'c2pa-icon' })}<span>${t('Durable credential')}</span></span>
          ${durableTip!.button}
          ${durableTip!.pop}
        </label>
      </div>` : '';

  // HDR (Rec.2100 PQ) raster export — OPT-IN, off by default. Boosts the brand's
  // primary colours (the live palette) toward peak luminance so white text and
  // brand colours glow on HDR displays while darks stay dark; SDR viewers see a
  // normal image. Raster only (png/jpeg today). Round-trips into the URL as
  // ?hdr=1 (see views/tool.ts syncUrl + engine/src/hdr.ts).
  const hdrFmts = formats.filter(isHdrFmt);
  const hdrTip = hdrFmts.length ? helpTip(
    t('HDR (Rec.2100 PQ) boosts your brand colours and white text toward peak brightness so they glow on HDR-capable screens — Safari/Preview on Apple devices, Chrome on an HDR display — while dark areas stay dark. IMPORTANT: only use it where the destination supports HDR. Many platforms (social media, messaging apps, some websites) re-encode uploads and strip the HDR signal, which can leave the image looking dark or washed out. On an ordinary SDR screen it still shows as a normal image.'),
  ) : null;
  // Author dials — seeded from a tuned ?hdr= value, else the engine defaults. The
  // body reveals when the toggle is on (like the print card). All four map onto
  // hdrBoostToPQ knobs in the bridge (see export.ts hdrTune): White = peak nits,
  // Reach = how far down the tones the glow spreads, Dark lift = how much darks
  // brighten (0 keeps them dark), Focus = colour richness of the boost.
  const hdrTune = exportDefaults.hdrTune ?? HDR_DEFAULTS;
  const hdrSlider = (action: string, label: string, min: number, max: number, step: number, val: number): string =>
    `<label class="hdr-slider"><span>${t(label)}</span><input type="range" class="field-range" data-action="${action}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
  const hdrRow = hdrFmts.length ? `
      <div class="section-card export-hdr" data-hdr-only style="display:${isHdrFmt(initialFmt) ? 'flex' : 'none'}">
        <label class="hdr-enable field-toggle help-tip-host">
          <input type="checkbox" class="field-check" data-action="hdr" ${exportDefaults.hdr ? 'checked' : ''}>
          <span class="hdr-head">${icon('sunburst', { className: 'hdr-icon' })}<span>${t('HDR (bright colours)')}</span></span>
          ${hdrTip!.button}
          ${hdrTip!.pop}
        </label>
        <div class="hdr-body" data-hdr-body style="display:${exportDefaults.hdr ? 'grid' : 'none'}">
          ${hdrSlider('hdr-peak', 'White', 400, 2000, 50, hdrTune.peakNits)}
          ${hdrSlider('hdr-reach', 'Reach', 0, 100, 5, hdrTune.reach)}
          ${hdrSlider('hdr-lift', 'Dark lift', 0, 100, 5, hdrTune.lift)}
          ${hdrSlider('hdr-focus', 'Focus', 0, 100, 5, hdrTune.richness)}
        </div>
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
  // Marks & bleed default ON only where there is PRINT INTENT: picking a separating
  // press format (Print PDF / Print TIFF / CMYK EPS), a manifest that declares
  // render.printMarks: true, or an explicit bleed/marks preference from a link/save.
  // The RGB vector formats (pdf / svg / eps) still SHOW the card — they can carry
  // marks — but its master toggle starts OFF, so an everyday PDF or SVG export is
  // trim-sized and unmarked until the user asks. Physical units alone never count
  // as print intent (see isPressFmt above).
  const declaresPrintIntent = manifest.render.printMarks === true;
  const printIntentFmt = (f: string | undefined): boolean => isPressFmt(f) || (declaresPrintIntent && isPrintFmt(f));
  const printInitOn  = Boolean(exportDefaults.bleed || exportDefaults.marks) || printIntentFmt(initialFmt);
  const printInitMm  = exportDefaults.bleed ? (parseFloat(exportDefaults.bleed) || 3) : 3;
  // Colour bars default ON for the CMYK print formats (the press uses them as a
  // control strip), OFF for the RGB pdf. An explicit marks default (link/save) wins.
  // 'Stamp details' (provenance) is always pre-checked: the credit stamp is on by
  // default whenever the print-marks card is enabled, regardless of any remembered
  // marks state. The other marks still restore from saved/linked defaults.
  const pim          = { ...DEFAULT_PRINT_MARKS, colorBars: isCmykFmt(initialFmt), ...(exportDefaults.marks || {}), provenance: true };
  const printRow = hasPrint ? `
      <div class="section-card export-print" data-printmarks-only style="display:${isPrintFmt(initialFmt) ? 'flex' : 'none'}">
        <label class="print-enable field-toggle">
          <input type="checkbox" class="field-check" data-action="print-enable" ${printInitOn ? 'checked' : ''}>
          <span class="print-head">${ICON_CROP}<span>Print marks &amp; bleed</span></span>
        </label>
        <div class="print-body" data-print-body style="display:${printInitOn ? 'flex' : 'none'}">
          <label class="print-bleed">
            <span>Bleed</span>
            <input type="number" data-action="print-bleed" value="${printInitMm}" min="0" max="25" step="0.5" aria-label="Bleed in millimetres">
            <span>mm</span>
          </label>
          <div class="print-toggles">
            <label class="export-option"><input type="checkbox" class="field-check" data-action="mark-crop" ${pim.crop ? 'checked' : ''}> Crop</label>
            <label class="export-option"><input type="checkbox" class="field-check" data-action="mark-reg" ${pim.registration ? 'checked' : ''}> Registration</label>
            <label class="export-option"><input type="checkbox" class="field-check" data-action="mark-bleed" ${pim.bleed ? 'checked' : ''}> Bleed</label>
            <label class="export-option"><input type="checkbox" class="field-check" data-action="mark-bars" ${pim.colorBars ? 'checked' : ''}> Color bars</label>
            <label class="export-option"><input type="checkbox" class="field-check" data-action="mark-prov" ${pim.provenance ? 'checked' : ''}> Stamp details</label>
          </div>
          <p class="print-hint">Adds bleed and the chosen marks for a print shop; the artwork is scaled to fill the bleed. Registration marks print on all four plates in the Print PDF and Print TIFF. (An open-password can't be combined with marks.)</p>
        </div>
      </div>` : '';

  // Tier 2.8 — "Content protection": one collapsed disclosure folding the
  // provenance/protection cards (password, C2PA, Imprint) so the panel shows one
  // header instead of up to three separate boxes. Print marks & bleed are NOT in
  // here — they're print PRODUCTION geometry, not content protection, so printRow
  // stays its own top-level section (see the assembly below). Purely a wrapping
  // shell — none of the inner cards' own markup, classes, data-actions, defaults
  // or per-format [data-*-only] gating changes; this only adds one more OUTER
  // layer of visibility on top (see refreshPrintUi, which also owns hiding the
  // whole wrapper when NONE of the three apply to the selected format).
  const hasProtection = hasPdf || hasZip || c2paFormats.length > 0 || imprintFmts.length > 0;
  // Collapsed by default. Pre-opened only when an inner card carries an EXPLICIT
  // deep-linked setting — a URL-sourced password, a URL-sourced C2PA choice, or a
  // linked imprint/durable flag — so a share link still surfaces its setting without
  // an extra click. The mere default-on C2PA state (c2paInitOn) does NOT open it, so
  // the common case shows a single tidy collapsed header.
  const protectionOpen = pdfPassInitOpen || Boolean(exportDefaults.c2pa) || Boolean(exportDefaults.imprint) || Boolean(exportDefaults.durable);
  // Matches the canonical per-format predicates the inner cards already use
  // (isC2paFmt/isImprintFmt, plus the password card's pdf/pdf-cmyk/zip set) —
  // never loosened, just OR'd together to decide the outer wrapper.
  const protectionVisibleInitial = (initialFmt === 'pdf' || initialFmt === 'pdf-cmyk' || initialFmt === 'zip')
    || isC2paFmt(initialFmt) || isImprintFmt(initialFmt);
  const protectionRow = hasProtection ? `
      <div class="section-card export-protection${protectionOpen ? ' is-open' : ''}" data-protection-section style="display:${protectionVisibleInitial ? 'flex' : 'none'}">
        <button type="button" class="protection-head" data-action="protection-toggle" aria-expanded="${protectionOpen}">${icon('shield', { className: 'protection-icon' })}<span>${t('Content protection')}</span></button>
        <div class="protection-body" data-protection-body style="display:${protectionOpen ? 'flex' : 'none'}">
          ${pdfPassRow}${c2paRow}${imprintRow}${durableRow}
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
          <input type="checkbox" class="field-check" data-input-id="${escape(i.id)}" ${i.value ? 'checked' : ''}>
          ${escape(i.label ?? i.id)}
        </label>`;
  }).join('');
  const videoChip = hasAnimated ? `
        <div class="video-params" data-anim-params style="display:${isAnimatedFmt(initialFmt) ? 'flex' : 'none'}">
          <span class="vp-field"><span>Wait</span>
            <input type="number" data-action="video-wait" value="${defaultWait}" min="0" max="30" step="0.5"
                   aria-label="${escape(t('Wait before recording (seconds)'))}"><span>s</span></span>
          <span class="vp-field"><span>Duration</span>
            <input type="number" data-action="video-duration" value="${defaultDuration}" min="1" max="${durationMax}" step="0.5"
                   aria-label="${escape(t('Recording duration (seconds)'))}"><span>s</span></span>
          <label class="gif-dither-toggle" data-gif-only
                 style="display:${initialFmt === 'gif' ? 'flex' : 'none'}">
            <input type="checkbox" class="field-check" data-action="gif-dither">
            Dither
          </label>
          <label class="gif-dither-toggle" data-webm-only
                 style="display:${initialFmt === 'webm' ? 'flex' : 'none'}">
            <input type="checkbox" class="field-check" data-action="webm-60fps">
            60fps
          </label>
          ${liveCaptureSupport() ? `<label class="gif-dither-toggle" data-video-only data-live-capture
                 style="display:${isVideoFmt(initialFmt) ? 'flex' : 'none'}"
                 title="Record the on-screen preview in real time through a screen share — motion matches exactly what you see. Pick this tab in the share dialog and keep it visible for the whole take.">
            <input type="checkbox" class="field-check" data-action="video-live">
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
  // A tool with its own audio slot (assetType 'audio', e.g. the audiogram) always
  // contributes that audio to the export (resolved live from the sidebar pick), and
  // the card becomes two rows: the tool's audio with a level slider, plus an
  // optional mix-in track whose CENTRE level (off/low/full) sets the bed's gain
  // while the tool audio plays — full at the top and tail (§6.1). "Generate music"
  // composes a seeded ZzFXM tune on-device (engine composeSong → render worker →
  // transient WAV). Tools without an audio slot keep the single-bed card.
  const hasToolAudioInput = runtime.getModel().some(i => i.type === 'asset' && i.assetType === 'audio');
  const toolAudioTip = hasToolAudioInput && hasVideo ? helpTip(
    t('Always included when the tool has audio picked. WebM and MP4 only.')
  ) : null;
  const mixTip = hasToolAudioInput && hasVideo ? helpTip(
    t('Plays at full volume before and after this tool’s audio and eases to the centre volume underneath it.')
  ) : null;
  const bedPickHtml = `
        <div class="audio-pick">
          <select class="field-select" data-action="video-audio" aria-label="${hasToolAudioInput ? escape(t('Mix-in track')) : 'Audio track'}"
                  title="${hasToolAudioInput ? escape(t('Optional track mixed around this tool’s audio, looping if the clip is longer than the track.')) : 'Optional music bed muxed into the recording — plays for the clip duration, looping if the clip is longer than the track.'}">
            <option value="">None</option>
            <option value="__generate__">${escape(t('Generate music'))}</option>
          </select>
          <button type="button" class="audio-preview" data-action="audio-preview" title="Preview track" aria-label="Preview track" disabled>${ICON_PLAY}</button>
          <button type="button" class="audio-preview" data-action="audio-regen" hidden title="${escape(t('Regenerate music'))}" aria-label="${escape(t('Regenerate music'))}">${icon('refresh')}</button>
        </div>
        <div class="audio-fade">
          <label>Fade in <input type="number" data-action="audio-fadein" min="0" max="5" step="0.5" value="1"><span>s</span></label>
          <label>Fade out <input type="number" data-action="audio-fadeout" min="0" max="5" step="0.5" value="1.5"><span>s</span></label>
        </div>`;
  const audioRow = !hasVideo ? '' : hasToolAudioInput ? `
      <div class="export-audio" data-video-only style="display:${isVideoFmt(initialFmt) ? 'flex' : 'none'}">
        <span class="audio-head help-tip-host">${ICON_NOTE}<span>${escape(t('This tool’s audio'))}</span>${toolAudioTip!.button}${toolAudioTip!.pop}</span>
        <div class="audio-fade">
          <label>${escape(t('Level'))} <input type="number" data-action="audio-tool-level" min="0" max="100" step="5" value="100" aria-label="${escape(t('Tool audio level'))}"><span>%</span></label>
        </div>
        <span class="audio-head help-tip-host">${ICON_NOTE}<span>${escape(t('Mix in'))}</span>${mixTip!.button}${mixTip!.pop}</span>
        ${bedPickHtml}
        <div class="audio-fade">
          <label>${escape(t('Centre volume'))}
            <select class="field-select" data-action="audio-centre" aria-label="${escape(t('Centre volume'))}"
                    title="${escape(t('The mix-in track’s volume while this tool’s audio is playing. It always plays at full volume before and after.'))}">
              <option value="off">${escape(t('Off'))}</option>
              <option value="low" selected>${escape(t('Low'))}</option>
              <option value="full">${escape(t('Full'))}</option>
            </select>
          </label>
        </div>
      </div>` : `
      <div class="export-audio" data-video-only style="display:${isVideoFmt(initialFmt) ? 'flex' : 'none'}">
        <span class="audio-head help-tip-host">${ICON_NOTE}<span>Audio track</span>${audioTip!.button}${audioTip!.pop}</span>
        ${bedPickHtml}
        <div class="audio-fade">
          <label>Music level <input type="number" data-action="audio-volume" min="0" max="100" step="5" value="100"><span>%</span></label>
          <label title="When your clip has its own sound, the music dips to this level under it (100% = no ducking).">Duck to <input type="number" data-action="audio-duck" min="0" max="100" step="5" value="35"><span>%</span></label>
        </div>
      </div>`;

  // Full-page chip — HTML export only. Drops the fixed-size tool-canvas frame so
  // the saved page fills the whole browser window instead of a centred card.
  const hasHtml  = formats.includes('html');
  const htmlChip = hasHtml ? `
        <label class="export-option" data-html-only style="display:${initialFmt === 'html' ? 'flex' : 'none'}"
               title="Drop the fixed-size canvas frame so the saved page fills the whole window.">
          <input type="checkbox" class="field-check" data-action="full-page" ${exportDefaults.nostage ? 'checked' : ''}>
          Full page
        </label>` : '';
  const settingsRow = (optionChips || videoChip || htmlChip)
    ? `<div class="export-settings">${optionChips}${htmlChip}${videoChip}</div>`
    : '';

  // Tier 4 — actions. Copy · Save · Share share one equal-width row; Download is
  // the primary CTA, alone on its own full-width line at the very bottom.
  const CLIPBOARD_SVG = `<svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`;
  const copyBtn = actions.includes('copy')
    ? (jellyActive()
      ? `<jelly-button variant="platinum" data-action="copy" class="copy-btn" title="Copy to clipboard" label="Copy">${CLIPBOARD_SVG}<span>Copy</span></jelly-button>`
      : `<button data-action="copy" class="copy-btn" title="Copy to clipboard">${CLIPBOARD_SVG}<span>Copy</span></button>`) : '';
  const saveBtn = actions.includes('save') ? saveBtnHtml() : '';
  // Download is the primary CTA — jelly mode gives it the accent-fill squish.
  const downloadLabel = `Download${formats.length === 1 ? ' ' + fmtLabel(formats[0]!) : ''}`;
  // Consult the generic export-policy seam (src/lib/export-policy.ts): dormant — or a
  // deployment that withholds nothing — resolves to 'download' and the CTA below is
  // byte-identical to today. When a control plane withholds download but permits an
  // approval request, the primary CTA becomes "Request approval" (Save still saves the
  // session locally); when it withholds both, the CTA is dropped for a small note — no
  // dead button. Gated on actions.includes('download') so a tool with no download
  // action is unaffected. The view holds no control-plane knowledge: it asks the seam
  // what it may offer, and routes "Request approval" through the generic opener.
  const affordance = actions.includes('download') ? exportAffordance(getExportPolicy()) : 'download';
  // Same primary-CTA slot as Download, so it takes the same prominent jelly
  // recipe under the flag (the .download-btn-jelly class is a size/weight hook,
  // not download-specific); the delegated [data-action] handler is unchanged.
  const requestApprovalBtn = jellyActive()
    ? `<jelly-button data-action="request-approval" class="download-btn-jelly">${escape(t('Request approval'))}</jelly-button>`
    : `<button type="button" data-action="request-approval">${escape(t('Request approval'))}</button>`;
  const downloadBtn = !actions.includes('download')
    ? ''
    : affordance === 'request-approval'
      ? requestApprovalBtn
      : affordance === 'blocked'
        ? ''
        // The native button's ↓ affordance is a ::before glyph; the bridge strips
        // pseudo-content off jelly hosts (it painted at the host corner, outside
        // the capsule), so the jelly label carries the arrow as plain text.
        : (jellyActive()
          ? `<jelly-button data-action="download" class="download-btn-jelly">↓ ${downloadLabel}</jelly-button>`
          : `<button data-action="download">${downloadLabel}</button>`);
  const blockedNote = (actions.includes('download') && affordance === 'blocked')
    ? `<p class="export-blocked-note" role="status" style="margin:.2rem 0 0;color:hsl(var(--muted-foreground));font-size:12px;text-align:center">${escape(t('Downloading is turned off for this tool on this instance.'))}</p>`
    : '';
  // Tier 3.5 — "Before you export". LAST of the cards, below every setting and
  // immediately above the buttons: it is not a setting, it is a statement ABOUT
  // the settings, so it must sit under all of them or it would contradict a
  // control the user has not reached yet. Hidden until the engine's rules have
  // something true to say; see views/export-preflight.ts + refreshPreflight().
  const preflightRow = preflightRowHtml();
  // Tier 3.6 — "Cost, worked out from your rate card". After preflight (it consumes
  // preflight's counts) and above the buttons. Chrome only: data-export-hide, never a
  // pixel of the export. Rendered only for a costable job with a card and canShowMoney.
  const costRow = costPanelHtml();
  const secondaryRow = `<div class="export-action-buttons">${copyBtn}${saveBtn}${copyUrlBtn}</div>`;
  const downloadRow = downloadBtn ? `<div class="export-action-buttons">${downloadBtn}</div>` : blockedNote;

  // The panel host (#tool-actions) is present for every export-capable tool that
  // reaches here; guard the type for strict null-safety (never null in practice).
  if (!el) return;
  el.innerHTML = `
    ${actions.includes('download') ? `${filenameRow}${dimsRow}${aspectWarnRow}${fidelityWarnRow}${hdrRow}${cmykRow}${printRow}${protectionRow}${audioRow}${settingsRow}${preflightRow}${costRow}` : ''}
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
  const fidelityWarnEl = el.querySelector<HTMLElement>('[data-fidelity-warning]');
  const durationEl    = el.querySelector<HTMLInputElement>('[data-action="video-duration"]');
  const liveLabelEl   = el.querySelector<HTMLElement>('[data-live-capture]');

  // ── Contact sheets: the "Frames" control (plans/fable-timeline-editing §4.6) ─
  // A still export of a timed composition renders the frame at the playhead
  // (Andy's WYSIWYG rule). `cuts=N` instead samples N stills at equal MIDPOINT
  // intervals across the sequence — raster/SVG come back as a zip of N files, PDF
  // as N pages. Storyboards, thumbnail sheets, social carousels.
  //
  // The control exists ONLY while the artboard is a timed composition, and is
  // visible only for a still format — so no other tool, and no motion format, can
  // ever put `cuts` on the export opts. It's created/removed by syncFramesUi
  // (below) rather than baked into the panel HTML, because a canvas can BECOME a
  // sequence after mount (the MutationObserver path the Duration field already
  // uses) and a control that is merely hidden would still answer querySelector.
  const CUTS_MAX = 64;   // a contact sheet is for human review; the engine clamps too
  const isStillFmt = (f: string | undefined): boolean =>
    !!f && ['png', 'jpg', 'jpeg', 'webp', 'svg', 'pdf'].includes(f);
  const hasStillFmt = formats.some(isStillFmt);
  const framesRowHtml = `
      <div class="export-dims export-frames" data-seq-still-only style="display:none">
        <label class="dim-dpi" title="${escape(t('Evenly spaced stills across the sequence. 1 exports the current playhead frame.'))}">
          <span>${escape(t('Frames'))}</span>
          <input type="number" data-action="export-cuts" value="1" min="1" max="${CUTS_MAX}" step="1"
                 aria-label="${escape(t('Frames to export'))}">
        </label>
      </div>`;
  /** Mount/unmount the Frames row for `isSeq`, then show it for still formats only. */
  function syncFramesUi(isSeq: boolean): void {
    if (!hasStillFmt || !actions.includes('download')) return;
    let row = el!.querySelector<HTMLElement>('[data-seq-still-only]');
    if (!isSeq) { row?.remove(); return; }
    if (!row) {
      // Sits with the sizing controls: it is a "how much comes out" dial, like dims.
      const anchor = el!.querySelector<HTMLElement>('[data-aspect-warning]')
        ?? el!.querySelector<HTMLElement>('.export-dims')
        ?? el!.querySelector<HTMLElement>('.filename-extension');
      const frag = document.createElement('div');
      frag.innerHTML = framesRowHtml.trim();
      row = frag.firstElementChild as HTMLElement;
      if (anchor) anchor.after(row); else el!.prepend(row);
    }
    row.style.display = isStillFmt(formatEl?.value ?? initialFmt) ? 'flex' : 'none';
  }
  /** The Frames value as an integer in [1, CUTS_MAX]; nonsense (blank, 0, NaN) → 1. */
  function cutsValue(): number {
    const inp = el!.querySelector<HTMLInputElement>('[data-action="export-cuts"]');
    const n = Math.floor(Number(inp?.value));
    return Number.isFinite(n) && n >= 1 ? Math.min(CUTS_MAX, n) : 1;
  }

  // ── Sequence duration: follow the timeline, yield to the user ──────────────
  // ANDY'S RULE: the exported clip's duration matches the timeline's duration
  // always, UNLESS the user changes it here on export. This flag is the "unless":
  // it flips only on a real edit of the Duration field (a programmatic re-sync sets
  // .value directly and dispatches nothing, so it can never set it), and it rides
  // out to the export opts as `durationUserSet` — the tool hook keeps a deliberate
  // user value and overwrites everything else with the derived length.
  let durationUserSet = false;
  durationEl?.addEventListener('input',  () => { durationUserSet = true; });
  durationEl?.addEventListener('change', () => { durationUserSet = true; });

  // Re-seed the Duration field (and its ceiling) from the live timeline. Called at
  // mount and from the MutationObserver below, i.e. every time the artboard's
  // derived length changes. Adds nothing else to the panel: no control is hidden,
  // disabled or re-ordered for a sequence.
  function syncSequenceUi(): void {
    const isSeq = !!seqStageEl();
    const secs  = seqDurationS();
    if (durationEl) {
      // A timeline may legitimately outrun the 60s recording cap — take the
      // timeline's own ceiling while this is a sequence, restore 60s if it stops
      // being one (every clip deleted).
      const max = isSeq ? String(MAX_TIME_S) : '60';
      if (durationEl.max !== max) durationEl.max = max;
      if (secs != null && !durationUserSet) {
        const next = String(secs);
        if (durationEl.value !== next) durationEl.value = next;
      }
    }
    // "Record live" is HIDDEN for a timed composition (Andy, 2026-07-27, after
    // testing it: "live record mode doesn't play or work but this method is fast").
    // Live capture screen-records the preview in real time, which for a sequence has
    // no advantage — the compositor renders the same thing deterministically at ~30x
    // realtime — and in practice the take did not animate. Rather than ship a control
    // that is slower AND wrong, it is suppressed here; the compositor is the only
    // motion path for a sequence. Suppression is a data flag, not a style write,
    // because the format-change handler re-shows every [data-video-only] control and
    // would otherwise undo it. Un-tick on the way out so a box ticked before the tool
    // became a sequence cannot leave opts.live set on a hidden control.
    if (liveLabelEl) {
      if (isSeq) liveLabelEl.dataset.suppressed = '1';
      else delete liveLabelEl.dataset.suppressed;
      if (isSeq) {
        liveLabelEl.style.display = 'none';
        const box = liveLabelEl.querySelector<HTMLInputElement>('[data-action="video-live"]');
        if (box?.checked) box.checked = false;
      }
    }
    syncFramesUi(isSeq);
  }
  // Observation mechanism: the export bar has no existing hook that fires AFTER the
  // canvas DOM is repainted — runtime.subscribe fires on model change, which is
  // before the template rehydrates and restamps data-seq-ms, so it would read the
  // previous length. A MutationObserver on the canvas is the event-driven read of
  // the thing that actually changed: `attributes` catches an in-place restamp,
  // `childList` catches the artboard being replaced wholesale by a re-render. It
  // lives as long as canvasEl does (same lifetime as the runtime.subscribe above);
  // there is no teardown seam here and none is needed — the node goes with the mount.
  if (canvasEl && (durationEl || liveLabelEl || hasStillFmt)) {
    new MutationObserver(() => syncSequenceUi())
      .observe(canvasEl, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-seq-ms', 'data-sequence'] });
  }
  syncSequenceUi();

  // Fill the colour-profile select with the profiles loaded on THIS device — the
  // only route to an embedded /DestOutputProfile, and therefore to a genuinely
  // PDF/X-4-conformant Print PDF (see lib/press-profile-embed.ts). The four
  // registry rows above keep their exact meaning: the condition's NAME, no bytes.
  // The size in each label is arithmetic off the stored asset, so it cannot rot
  // into a lie the way a written figure would.
  const cmykSel = el.querySelector<HTMLSelectElement>('[data-action="cmyk-profile"]');
  if (cmykSel) {
    const askedOwn = isOwnProfile(exportDefaults.profile);
    listEligible(host as never, 'CMYK').then(rows => {
      for (const e of rows) {
        const o = document.createElement('option');
        o.value = `own:${e.digest}`;
        o.textContent = embedRowLabel(e);
        cmykSel.append(o);
      }
      if (!askedOwn) return;
      // A link carries bare `own` (a digest is device-local): one eligible profile
      // resolves it, several or none does not — and guessing would let storage
      // order decide what a file DECLARES. Unresolved, the export embeds nothing
      // and declares nothing rather than falling back to a condition nobody chose,
      // so the row must SAY that instead of promising an embed: it stays selected
      // (the link still round-trips, and nothing is refused) but it is named after
      // the outcome, not the intention.
      const asked = ownDigest(exportDefaults.profile ?? '') ?? (rows.length === 1 ? rows[0]!.digest : null);
      if (asked && rows.some(r => r.digest === asked)) { cmykSel.value = `own:${asked}`; return; }
      const o = document.createElement('option');
      o.value = 'own';
      o.textContent = rows.length
        ? 'Choose which profile to embed'
        : 'No profile on this device to embed';
      cmykSel.append(o);
      cmykSel.value = 'own';
    }).catch(() => { /* no profile store on this host — the registry rows stand alone */ });
  }

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
      // The user's own audio uploads (incl. Script-audio TTS clips) — the catalog
      // query lists library assets only, so the user store is appended explicitly.
      // Sequenced after the catalog groups so the order is stable.
      const listUser = (host.assets as unknown as { _listUserAssets?: () => Promise<{ id: string; type: string; meta?: Record<string, unknown> }[]> })._listUserAssets;
      return listUser?.call(host.assets).then(all => {
        const ups = all.filter(a => a.type === 'audio');
        if (!ups.length) return;
        const grp3 = document.createElement('optgroup');
        grp3.label = t('Your uploads');
        for (const a of ups) {
          const o = document.createElement('option');
          o.value = a.id;
          o.textContent = String(a.meta?.name ?? a.id.split('/').pop() ?? '');
          grp3.appendChild(o);
        }
        audioSel.appendChild(grp3);
      });
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
  // (The old `__tool__` pseudo-entry is gone: a tool with its own audio slot now
  // always contributes that audio as the primary track of the two-row card, so
  // the select only ever names the optional mix-in bed.)

  // "Generate music": a transient ZzFXM bed, seeded so the SAME tune deterministically
  // re-renders at any length (export re-renders at the clip's duration). Regenerate
  // rolls a new seed. The draw is the engine's `generatedSongSpec` — the same one a
  // `zzfxm:<seed>` asset id resolves through — so a seed rolled here names the same
  // tune in a share link and in the CLI.
  let genSeed = (Math.random() * 0x7fffffff) >>> 0;
  let genWavUrl: string | null = null;   // cached preview WAV blob URL
  let genWavKey = '';                    // "seed:targetSec" the cache was rendered for
  const genDur = (): number => Math.max(8, Math.min(90, videoParams().duration));
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
      // Key the loaded source so a regenerated tune reloads instead of replaying
      // the stale bytes; catalog/user ids key as themselves.
      const srcKey = id === '__generate__' ? `__generate__:${genSeed}:${genDur()}` : id;
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

  // The Print marks card auto-opens only for a PRINT-INTENT format (a separating
  // press format, or any print-capable format when the manifest declares
  // render.printMarks: true) and closes for the rest — including the RGB vector
  // formats pdf/svg/eps, which keep the card VISIBLE but off — re-applied on every
  // switch, until the user toggles the master or a link/save set marks explicitly,
  // after which their choice is left alone.
  let marksUserSet = Boolean(exportDefaults.bleed || exportDefaults.marks);
  const syncPrintDefault = (fmt: string): void => {
    if (marksUserSet) return;
    const en = el.querySelector<HTMLInputElement>('[data-action="print-enable"]');
    if (en) en.checked = printIntentFmt(fmt);   // refreshPrintUi (called next) reveals/hides the body
  };

  // Show/hide timing params and format-specific controls when the format selector changes.
  if (formatEl) {
    formatEl.addEventListener('change', () => {
      const fmt = formatEl.value;
      if (animParamsEl) animParamsEl.style.display = isAnimatedFmt(fmt) ? 'flex' : 'none';
      if (ditherEl)     ditherEl.style.display     = fmt === 'gif'  ? 'flex' : 'none';
      if (webm60El)     webm60El.style.display      = fmt === 'webm' ? 'flex' : 'none';
      el.querySelectorAll<HTMLElement>('[data-vector-only]').forEach(c => { c.style.display = isVectorFmt(fmt) ? 'flex' : 'none'; });
      // `data-suppressed` wins over the video-format test: syncSequenceUi sets it on
      // "Record live" for a timed composition, and without this check switching format
      // would hand the control straight back.
      el.querySelectorAll<HTMLElement>('[data-video-only]').forEach(c => {
        c.style.display = (isVideoFmt(fmt) && c.dataset.suppressed !== '1') ? 'flex' : 'none';
      });
      // Contact sheets are a STILL-format affordance; the same handler owns them, so
      // the Frames row can't survive a switch to a motion format. It only exists at
      // all while the artboard is a sequence (syncFramesUi), so this is a no-op
      // everywhere else — no data-suppressed flag needed, nothing to fight over.
      el.querySelectorAll<HTMLElement>('[data-seq-still-only]').forEach(c => { c.style.display = isStillFmt(fmt) ? 'flex' : 'none'; });
      if (!isVideoFmt(fmt)) stopAudioPreview();   // the audio card is hidden — don't keep a preview playing under it
      el.querySelectorAll<HTMLElement>('[data-html-only]').forEach(c => { c.style.display = fmt === 'html' ? 'flex' : 'none'; });
      el.querySelectorAll<HTMLElement>('[data-cmyk-only]').forEach(c => { c.style.display = isCmykFmt(fmt) ? 'flex' : 'none'; });
      el.querySelectorAll<HTMLElement>('[data-printmarks-only]').forEach(c => { c.style.display = isPrintFmt(fmt) ? 'flex' : 'none'; });
      syncBarsDefault(fmt);
      syncPrintDefault(fmt);   // open the marks card for a CMYK press format, close it otherwise
      updateFidelityWarning();  // only SVG/HTML keep a frosted panel
      refreshPrintUi(); // owns [data-pdf-only] (password) visibility — see below
      refreshDepthFact();
      refreshPreflight();   // the format is the single biggest input to every check
      onUrlSync?.('format');
      onUrlSync?.('marks');  // bars may have flipped with the format
    });
  }

  // matchExportFormat: keep the export format tracking the dropped file's own format
  // until the user picks one. A ?format= link / saved session locks it up-front; any
  // manual pick locks it too. Idempotent — the subscribe fires on every input change,
  // but only acts when a NEW upload's format differs from the current selection. The
  // subscription's lifetime is this mount's runtime.
  if (formatEl && matchFmtInput) {
    let formatLocked = !!exportDefaults.format;
    let autoSetting = false;
    formatEl.addEventListener('change', () => { if (!autoSetting) formatLocked = true; });
    runtime.subscribe(() => {
      if (formatLocked) return;
      const f = assetExportFormat();
      if (f && f !== formatEl.value) {
        autoSetting = true;
        formatEl.value = f;
        formatEl.dispatchEvent(new Event('change', { bubbles: true }));  // runs the per-format UI refresh above
        autoSetting = false;
      }
    });
  }

  // The depth fact — what the chosen format WILL carry beyond an ordinary 8-bit
  // image, stated and not offered (plans/61-deeprichpixels.md §10 item 3). Nothing is
  // rendered unless there is something true to say, so this runs wherever either
  // input to that truth changes: the format, and the HDR toggle. `?depth=` has no
  // panel control by design — it rides the link, so exportDefaults is its only
  // source. See views/export-depth.ts for the derivation.
  function refreshDepthFact(): void {
    const fmt = formatEl?.value ?? initialFmt;
    const hdr = el!.querySelector<HTMLInputElement>('[data-action="hdr"]')?.checked ?? exportDefaults.hdr;
    applyDepthFact(el, depthFact(fmt, { hdr: !!hdr, depth: exportDefaults.depth }));
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
    el!.querySelectorAll<HTMLElement>('[data-durable-only]').forEach(c => { c.style.display = isDurableFmt(fmt) ? 'flex' : 'none'; });
    el!.querySelectorAll<HTMLElement>('[data-hdr-only]').forEach(c => { c.style.display = isHdrFmt(fmt) ? 'flex' : 'none'; });
    el!.querySelectorAll<HTMLElement>('[data-c2pa-webm]').forEach(c => { c.style.display = fmt === 'webm' ? 'block' : 'none'; });
    // The "Content protection" wrapper itself: hidden when none of its four inner
    // cards apply to the selected format (e.g. a text/data format like csv/json/ics),
    // so an always-collapsed, permanently-empty header never shows. Each inner card
    // keeps its own [data-*-only] gate above — this is one more OUTER layer only, it
    // never loosens them. Mirrors the exact per-card predicates this function already
    // applies (password: pdf/pdf-cmyk/zip; C2PA/imprint: their own fmt set; print: isPrintFmt).
    const protectionEl = el!.querySelector<HTMLElement>('[data-protection-section]');
    if (protectionEl) {
      // Print marks live in their own section now (data-printmarks-only), so the
      // protection wrapper's visibility does NOT include isPrintFmt.
      const anyValid = (fmt === 'pdf' || fmt === 'pdf-cmyk' || fmt === 'zip')
        || isC2paFmt(fmt) || isImprintFmt(fmt);
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
  // Each of these changes a setting preflight reports on (bleed, the mark set),
  // and none of them had a fidelity-warning equivalent to ride — so they take the
  // refresh explicitly, or the card would keep stating the previous bleed.
  el.querySelector<HTMLInputElement>('[data-action="print-enable"]')?.addEventListener('change', () => {
    marksUserSet = true;   // a manual toggle stops the per-format auto open/close
    refreshPrintUi(); refreshPreflight(); onUrlSync?.('bleed'); onUrlSync?.('marks');
  });
  el.querySelector<HTMLInputElement>('[data-action="print-bleed"]')?.addEventListener('input', () => { refreshPreflight(); onUrlSync?.('bleed'); });
  ['mark-crop', 'mark-reg', 'mark-bleed', 'mark-bars', 'mark-prov'].forEach(a =>
    el.querySelector<HTMLInputElement>(`[data-action="${a}"]`)?.addEventListener('change', () => {
      if (a === 'mark-bars') barsUserSet = true;  // stop auto-tracking once chosen
      refreshPreflight();   // the mark set changes the bleed/media boxes
      onUrlSync?.('marks');
    }));
  refreshPrintUi(); // initial state (e.g. card pre-opened from a shared link)
  refreshDepthFact(); // renders nothing unless a deep/gain-map path is already selected

  // Colour profile (CMYK press condition) — print-PDF only; persists via URL/save.
  el.querySelector<HTMLSelectElement>('[data-action="cmyk-profile"]')?.addEventListener('change', () => { refreshPreflight(); onUrlSync?.('profile'); });

  el.querySelector<HTMLInputElement>('[data-action="filename"]')?.addEventListener('input', () => onUrlSync?.('filename'));

  // Full-page HTML export toggle ("no stage") — round-trips through the URL as ?nostage.
  el.querySelector<HTMLInputElement>('[data-action="full-page"]')?.addEventListener('change', () => onUrlSync?.('nostage'));

  // Pixel-watermark toggle — round-trips through the URL as ?imprint=1 (see syncUrl).
  el.querySelector<HTMLInputElement>('[data-action="imprint"]')?.addEventListener('change', () => onUrlSync?.('imprint'));
  el.querySelector<HTMLInputElement>('[data-action="durable"]')?.addEventListener('change', () => { refreshPreflight(); onUrlSync?.('durable'); });
  el.querySelector<HTMLInputElement>('[data-action="hdr"]')?.addEventListener('change', (e) => {
    // Reveal the dials when HDR is on, hide them when off (like the print card).
    const on = (e.target as HTMLInputElement).checked;
    const body = el.querySelector<HTMLElement>('[data-hdr-body]');
    if (body) body.style.display = on ? 'grid' : 'none';
    refreshDepthFact();   // HDR is what makes the PNG deep / the JPEG a gain map
    refreshPreflight();   // HDR on a format that cannot carry it is a warning
    onUrlSync?.('hdr');
  });
  for (const a of ['hdr-peak', 'hdr-reach', 'hdr-lift', 'hdr-focus']) {
    el.querySelector<HTMLInputElement>(`[data-action="${a}"]`)?.addEventListener('input', () => onUrlSync?.('hdr'));
  }

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
  wirePreflight(el);   // the "Before you export" control opens its details modal
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
  // Whether the dimension fields still hold their manifest-derived defaults.
  // Seeded true only when a URL param or a restored session supplied the size;
  // flipped by an edit, a scrub, a size-select pick or a unit change. Preflight
  // reads it to tell "the user set this page size" from "this is the tool's own
  // canvas, pre-filled" — the CLI makes exactly the same distinction through
  // `declaredBy`, and without it the two surfaces disagreed on every ordinary tool.
  // `unit` counts as setting the size even on its own: `?unit=mm` with the fields
  // still at the manifest numbers is a REAL 1200 x 900 mm export (exportDims below
  // qualifies the field value with the active unit), so reading it as the tool's
  // pixel canvas would under-report by a factor of twelve.
  let sizeUserSet = exportDefaults.width != null || exportDefaults.height != null ||
    (exportDefaults.unit != null && exportDefaults.unit !== 'px');
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

  // Export-fidelity guard: does the canvas paint anything the chosen format cannot
  // carry? Today that is `backdrop-filter` (frosted glass). Only SVG can express it —
  // the walker rebuilds the backdrop by cloning, clipping and blurring what is behind
  // the panel. Every raster format goes through a DOM serialiser that puts the node in
  // a <foreignObject>, where the backdrop is by definition outside the subtree and the
  // blur is dropped; PDF rasterises the panel through that same path; EMF, EPS and DXF
  // discard every filter that is not a drop shadow. HTML is the live DOM, so it keeps it.
  //
  // Read from the LIVE canvas (computed styles), so a tool that never uses the effect
  // never sees the row, and a box that turns Backdrop blur on gets it immediately.
  const FROST_OK_FORMATS = new Set(['svg', 'html']);
  function canvasUsesBackdropFilter(): boolean {
    const root = canvasEl;
    if (!root) return false;
    const els: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
    for (const node of els) {
      // Editor-only chrome tagged [data-export-hide] is detached before any raster
      // render (detachExportHidden, bridge/export.ts), so a backdrop-filter on it is
      // never in the export and warning about it is a false alarm. Skip exactly the
      // subtree the exporter strips. Bitmap Studio's frosted HUD chips (the preset
      // badge, the Before/After pills, the hover histogram) are the reference case.
      if (node.closest('[data-export-hide]')) continue;
      const s = getComputedStyle(node) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
      const bf = s.backdropFilter || s.webkitBackdropFilter || '';
      if (bf && bf !== 'none') return true;
    }
    return false;
  }
  function updateFidelityWarning(): void {
    if (!fidelityWarnEl) return;
    const fmt = formatEl?.value || initialFmt || formats[0] || '';
    const msg = (fmt && !FROST_OK_FORMATS.has(fmt) && canvasUsesBackdropFilter())
      ? `This design uses a frosted glass effect. ${fmt.toUpperCase()} exports can’t keep the blur, so the panel exports without it.`
      : '';
    fidelityWarnEl.querySelector<HTMLElement>('[data-fidelity-warning-text]')!.textContent = msg;
    fidelityWarnEl.hidden = !msg;
  }
  // A sidebar edit can turn the effect on or off (Layout Studio's Backdrop blur field),
  // so re-check after every input change as well as on every format change. Cheap: one
  // computed-style pass over the canvas, and only while the export panel is mounted.
  // Registered HERE, below the definition — the format-change handler above is wired
  // earlier in the function and would hit the TDZ if it ran the check eagerly.
  runtime.subscribe(() => updateFidelityWarning());
  updateFidelityWarning();

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
      barRadiusPt:       brandBarRadiusPt(),
    };
  }

  // The brand/theme corner radius as PDF points, for rounding colour-bar cells to
  // match the brand `--radius`. Reads the live token (px or rem) off the tool canvas
  // — where the runtime brand block applies it — falling back to the document root,
  // and converts px→pt (72/96). 0 (or an unparseable/none value) keeps sharp cells.
  function brandBarRadiusPt(): number {
    const src = el?.closest('.tool-layout')?.querySelector('#tool-canvas') ?? document.documentElement;
    const raw = getComputedStyle(src).getPropertyValue('--radius').trim();
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const px = /rem\s*$/.test(raw) ? n * 16 : n;   // rem→px (root 16px) or already px
    return px * 0.75;                               // px→pt
  }

  // ── Preflight: "Before you export" ────────────────────────────────────────
  //
  // The shell collects the FACTS from its own platform and the engine applies the
  // RULES — the same split print-marks.ts uses. Everything below reads the LIVE
  // panel (the same readers the export path uses: rawDims/dimUnit/dimDpi, the
  // print card, the CMYK select, cutsValue) so a finding can never be about
  // settings a render would not use. The engine receives a plain object and never
  // touches the DOM.
  //
  // STATIC ONLY. Nothing here renders, rasterises or exports: `preflight()` is
  // pure and synchronous, and it runs on every input change through
  // runtime.subscribe, so an async or rendering check must NOT land on this path.
  //
  // The palette is the one genuinely async fact. It is resolved ONCE, off
  // host.tokens.colors() DIRECTLY — never livePalette, which silently substitutes
  // the neutral starter PALETTE when tokens throw OR answer with nothing, and
  // carries no provenance to tell the two apart. A throw and an empty list both
  // become `{ known:false, why:'not-resolved' }`, so the engine withholds the
  // plate ceiling instead of counting starter swatches as if they were the brand's.
  let palette: Fact<readonly PreflightSwatch[]> = { known: false, why: 'not-resolved' };
  void (async () => {
    try {
      const colors = await host.tokens?.colors?.();
      if (!Array.isArray(colors) || colors.length === 0) return;   // stays 'not-resolved'
      palette = { known: true, value: colors.map(s => ({ path: s.path, name: s.name, spot: s.spot ?? null, cmyk: s.cmyk ?? undefined, hex: s.value })) };
      refreshPreflight();
    } catch { /* stays 'not-resolved' — never a fabricated empty palette */ }
  })();

  /** DOM truths, the only channel through which the stage reaches the engine. */
  function stageFacts(): Fact<StageFacts> {
    if (!canvasEl) return { known: false, why: 'needs-mount' };
    const durationS = seqDurationS();
    const boxes = canvasEl.querySelectorAll('[data-pdf-page]').length;
    // Measure placed raster images for the per-image effective-DPI check. Pure/sync
    // (getBoundingClientRect + naturalWidth) — stays on the refreshPreflight path,
    // never a render. Only images with real intrinsic pixels + a rendered box.
    const rect = canvasEl.getBoundingClientRect();
    const rasterImages = [...canvasEl.querySelectorAll('img')].flatMap((el) => {
      const nW = el.naturalWidth, nH = el.naturalHeight, b = el.getBoundingClientRect();
      if (!(nW > 0) || !(nH > 0) || !(b.width > 0) || !(b.height > 0)) return [];
      const src = el.currentSrc || el.src || '';
      // A placed SVG is VECTOR: it carries through PDF/SVG export as vector (or a
      // crisp render rasterised from the vector at output DPI — export.ts
      // drawHtmlVectors), so measuring its intrinsic naturalWidth as an
      // effective-DPI limit is meaningless and only ever a false "will look soft".
      // The field is rasterImages; a vector does not belong in it.
      if (isVectorImageSrc(src)) return [];
      const label = placedImageLabel(el.getAttribute('alt'), el.getAttribute('aria-label'), src);
      return [{ label, naturalW: nW, naturalH: nH, boxCssW: b.width, boxCssH: b.height }];
    });
    return {
      known: true,
      value: {
        isSequence: Boolean(seqStageEl()),
        durationMs: durationS === null ? null : Math.round(durationS * 1000),
        pageBoxes: boxes > 0 ? boxes : null,
        canvasCssW: rect.width > 0 ? rect.width : null,
        rasterImages,
      },
    };
  }

  // The manifest slice preflight reads, narrowed explicitly rather than passed
  // through: RenderSpec's `video` is a Record<string, unknown> bag, and the two
  // numbers preflight wants have to be proved to be numbers here.
  const vidNum = (k: string): number | undefined => {
    const v = (manifest.render.video as Record<string, unknown> | undefined)?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const preflightManifest: PreflightManifest = {
    id: manifest.id,
    status: manifest.status,
    render: {
      width: manifest.render.width,
      height: manifest.render.height,
      formats: manifest.render.formats,
      export: manifest.render.export,
      paginate: manifest.render.paginate,
      pages: manifest.render.pages,
      video: { wait: vidNum('wait'), duration: vidNum('duration') },
      aspectWarning: manifest.render.aspectWarning,
    },
    inputs: manifest.inputs,
  };

  /** Assemble the job from the live panel, run the engine's rules, render the card. */
  function refreshPreflight(): void {
    if (!actions.includes('download')) return;
    const fmt = formatEl?.value || initialFmt || formats[0] || '';
    const unit = dimUnit() as Unit;
    const dpi = dimDpi();
    const { w, h } = rawDims();
    // A dims-less tool exports at the manifest's pixel canvas: that size came from
    // the manifest, so it is BARE PIXELS by construction and no unit was declared.
    const fixed = manifest.render.dims === false;
    // Both fields must hold a positive value before the ACTIVE UNIT may be applied
    // to them. `rawDims()` returns undefined for a blank or non-positive field, and
    // substituting `manifest.render.width` under a live `unit: 'mm'` manufactured a
    // PHYSICAL trim out of a bare pixel number nobody declared — a 1200 x 900 px
    // canvas reported as "Trim 1.08 m²", with `bound: 'exact'`, in the state a user
    // passes through every time they clear the width field to retype it. That is the
    // derivation plan §4 forbids by name, and the real export path does not do it
    // either: it falls back to the MEASURED DOM box.
    //
    // So an incomplete pair reads as what it actually is — the manifest's pixel
    // canvas, `declaredBy: 'manifest'`, no unit declared. The engine then emits
    // `print.trim-not-physical` / `refuse.trim-when-unset` instead of an area.
    const typed = (w ?? 0) > 0 && (h ?? 0) > 0;
    // `declaredBy: 'url'` only when the size is genuinely the user's: a URL param,
    // a restored session, a size-select pick or an edit. Hard-coding it meant the
    // web could NEVER emit `refuse.trim-when-unset` while the CLI emitted it
    // routinely for the identical job, so the two surfaces disagreed on a pre-filled
    // tool where the user had set nothing at all.
    const fromUser = typed && sizeUserSet;
    const manifestSize = fixed || !fromUser;
    // …and when the manifest canvas is what renders, it is not always what COMES OUT.
    // With both size fields blank the export path passes no dimension at all, so
    // `rasterStyle` takes its not-requested branch and supersamples the node box by
    // RASTER_DEFAULT_SCALE: a 1200 x 900 tool exported to PNG is a 2400 x 1800 file.
    // Reporting the manifest numbers there stamped `bound: 'exact'` on a pixel count
    // four times too small. A fixed-dims tool (`dims === false`) is exempt: it passes
    // the manifest size explicitly, which IS a request, so no scale applies — and so
    // is every vector/PDF format, which never reaches `rasterStyle`.
    const supersampled = manifest.render.dims !== false && !typed && SUPERSAMPLED_EXPORT_FORMATS.has(fmt.toLowerCase());
    const canvasScale = supersampled ? RASTER_DEFAULT_SCALE : 1;
    const width  = manifestSize ? { value: manifest.render.width * canvasScale,  unit: 'px' as Unit } : { value: w!, unit };
    const height = manifestSize ? { value: manifest.render.height * canvasScale, unit: 'px' as Unit } : { value: h!, unit };
    // `unitDeclared` is true only when the SOURCE spelled a unit out — here, when
    // the panel offers the unit selector AND the value in the field is the one the
    // user put there. False makes the engine refuse to derive an area rather than
    // trust a fabricated unit.
    const unitDeclared = !manifestSize && manifest.render.units !== false;

    const on = printEnabled(el);
    const bleedMm = parseFloat(el!.querySelector<HTMLInputElement>('[data-action="print-bleed"]')?.value ?? '');
    const marks = printOpts();
    const job: PreflightJob = {
      source: 'web',
      manifest: preflightManifest,
      // Post-onInit: this panel only exists after the tool has mounted, so a
      // paginate source table is the hydrated one and its row count is exact.
      model: runtime.getModel() as readonly PreflightInput[],
      modelPhase: 'post-init',
      settings: {
        format: fmt,
        size: { width, height, dpi, declaredBy: manifestSize ? 'manifest' : 'url', unitDeclared },
        // The panel is the whole truth about bleed/marks/press profile here — an
        // absent card means the export applies none, which is a KNOWN null, not an
        // unknown. (A batch-snapshot row, which carries none of them, is the case
        // that must report `{ known:false, why:'not-carried' }`.)
        bleed: { known: true, value: on && bleedMm > 0 ? { value: bleedMm, unit: 'mm' } : null },
        marks: { known: true, value: on ? { crop: marks.cropMarks, registration: marks.registrationMarks, bleed: marks.bleedMarks, colorBars: marks.colorBars, provenance: marks.provenance } : null },
        // The reserved `profile` param is the PRESS CONDITION, not a user profile.
        //
        // Reported ONLY when the setting is actually in force. The Color profile
        // card is rendered (and its select populated with DEFAULT_CMYK_CONDITION)
        // for any tool that OFFERS a CMYK format, and merely display:none'd for the
        // others — so reading `.value` unconditionally asserted "the user chose
        // fogra39" on the default SVG/PNG export of every such tool, and the card
        // read "1 to fix" out of the box. The engine rule is right; the collector
        // was inventing the setting.
        pressProfile: {
          known: true,
          value: isCmykFmt(fmt) ? (el!.querySelector<HTMLSelectElement>('[data-action="cmyk-profile"]')?.value || null) : null,
        },
        cuts: cutsValue(),
        password: Boolean(el!.querySelector<HTMLInputElement>('[data-action="pdf-password"]')?.value),
        durable: el!.querySelector<HTMLInputElement>('[data-action="durable"]')?.checked ?? false,
        hdr: el!.querySelector<HTMLInputElement>('[data-action="hdr"]')?.checked ?? false,
      },
      palette,
      stage: stageFacts(),
    };

    // The fact row states the size the JOB carries, so it agrees with the findings
    // by construction: a manifest-sourced size shows as the pixel canvas it is.
    const sizeText = manifestSize
      ? `${manifest.render.width * canvasScale} × ${manifest.render.height * canvasScale} px`
      : (unit === 'px' ? `${w} × ${h} px` : tRaw('{w} × {h} {unit} at {dpi} DPI', { w: String(w), h: String(h), unit, dpi }));
    const report = preflight(job);
    applyPreflight(el, preflightView(report, {
      formatLabel: fmt ? fmtLabel(fmt) : '',
      sizeText,
      bleedText: on && bleedMm > 0 ? `${bleedMm} mm` : null,
    }));
    // The cost pass consumes the SAME counts. Async (it reads stored cards), so it is
    // fired and forgotten off the latest counts; a stale in-flight pass is harmless
    // because each call re-reads the current selection and rewrites the card.
    lastCounts = report.counts;
    void refreshCost();
  }

  // ── Cost panel state. All device-local memory, never written to a URL by syncUrl.
  let lastCounts: readonly Count[] = [];
  // The explicit per-device reveal (§5): a link opens on counts, and money is shown
  // only after the user asks for it here. Never persisted for a confidential card.
  let costRevealed = false;
  // Opt-in to expired rates this session (§5). Never persisted.
  let costUseExpired = false;
  // The `cost-authoring` slot is mounted at most once, the first time an authoring
  // extension actually RESOLVES into it (not merely when the container exists).
  // DORMANT by default: with no authoring extension registered, mountSlot leaves
  // the slot container untouched (see lib/extensions.ts), so the panel stays
  // counts-only. Authoring is furniture a channel hydrates; the door is here
  // regardless.
  let costSlotMounted = false;
  // The aggregate disposer mountSlot returns — captured so the hydrated extension's
  // teardown (listeners/timers/subscriptions it installed in mount()) actually runs
  // when this panel is destroyed, via the `dispose` on the returned ActionsApi.
  let costSlotDispose: Disposer | undefined;

  // Hydrate the cost-authoring slot when — and only when — an extension actually
  // RESOLVES into it. Gating on slotHasResolved rather than mere element existence
  // is what makes ASYNC delivery work: a control-plane/community bundle evaluated
  // after first paint calls registerExtension, which fires onExtensionsChanged,
  // which re-runs this and hydrates the door. Latches once mounted.
  function tryMountCostSlot(): void {
    if (costSlotMounted) return;
    const slotEl = el?.querySelector<HTMLElement>('[data-cost-authoring]');
    if (!slotEl || !slotHasResolved('cost-authoring')) return;
    costSlotMounted = true;
    // `WebToolHost.assets` carries the `_*UserAsset` methods at runtime.
    const rcHost = host as unknown as Parameters<typeof listRateCards>[0];
    void mountSlot<CostAuthoringContext>('cost-authoring', slotEl, {
      host: rcHost,
      onChange: () => { void refreshCost(); },
    }).then(d => { costSlotDispose = d; });
  }
  // Re-attempt the mount whenever the registry changes (async bundle delivery).
  // Unsubscribed, and the hydrated extension torn down, in `disposeCostSlot`.
  const costSlotUnsub = onExtensionsChanged(() => tryMountCostSlot());
  function disposeCostSlot(): void {
    costSlotUnsub();
    try { costSlotDispose?.(); } catch (e) { console.error(e); }
    costSlotDispose = undefined;
  }

  // The QuantityKinds a rate card can actually price — used to decide whether the job
  // is "costable" at all, so the panel never appears on a plain logo PNG.
  const PRICEABLE_KINDS = new Set<Count['kind']>([
    'processPlates', 'spotPlates', 'finishPlates', 'sheets', 'area', 'pages',
    'variantRows', 'outputFiles',
  ]);

  async function refreshCost(): Promise<void> {
    const costable = lastCounts.some(c => PRICEABLE_KINDS.has(c.kind));
    // The stored cards on THIS device. A link carries none — a card is never a URL
    // param — so possession is always a local fact. `WebToolHost.assets` carries the
    // `_*UserAsset` methods at runtime (same cast the rate-cards manager uses).
    // A user-dropped card wins; with none, a CATALOG-shipped card (the org's
    // distribution rail — brand pack, channel, control-plane provider) is
    // offered. Possession still means "synced to this device", and the
    // confidential/reveal semantics in money-policy hold unchanged.
    const rcHost = host as unknown as Parameters<typeof listRateCards>[0];
    // Give the extracted authoring furniture its door: hydrate the `cost-authoring`
    // slot the moment an extension resolves into it (empty registry → no-op, the
    // container is left untouched and the panel is byte-identical to counts-only).
    // A hydrated extension gets the store + an onChange that reprices. Also re-runs
    // on async bundle delivery via the onExtensionsChanged subscription above. (The
    // context type lives beside this consumer in cost-panel.ts; the furniture is
    // src/ext/cost-authoring.ts, off the default path.)
    tryMountCostSlot();
    const cards = await listRateCards(rcHost).catch(() => []);
    const selected = cards[0]
      ?? (await listCatalogRateCards(host as unknown as Parameters<typeof listCatalogRateCards>[0]).catch(() => []))[0];
    // most-recently-added / first catalog card; a full picker is future work

    // Resolve + cost the selected card. The figure is still gated by `costView` →
    // `canShowMoney`, so a link-reached mount never RENDERS one until the reveal flips
    // (proven in cost-panel.test.ts).
    let working: CostWorking | null = null;
    if (selected) {
      const parsed = await resolveCard(selected);
      if (parsed) working = computeCost(parsed, lastCounts, {});
    }
    const money: MoneyContext = {
      hasCard: !!selected,
      selectionFromUrl: reachedViaLink,
      revealedThisSession: costRevealed,
      cardConfidential: selected?.confidential ?? false,
      expired: working?.expired ?? false,
      useExpiredAnyway: costUseExpired,
    };

    applyCostPanel(el, costView(working, {
      costable,
      money,
      issuerName: selected?.issuerName,
      issued: selected?.issued,
      validUntil: selected?.validUntil,
    }));
    wireCostActions();
  }

  /** Fetch + parse a card's bytes into a `RateCard` — the user-asset store for
   *  a dropped card, the catalog rail for a shipped one. Null on any failure. */
  async function resolveCard(entry: { digest: string; catalogUrl?: string }) {
    let blob: Blob | null = null;
    if (entry.catalogUrl) {
      blob = await fetch(entry.catalogUrl).then(r => (r.ok ? r.blob() : null)).catch(() => null);
    } else {
      const rcHost = host as unknown as Parameters<typeof getRateCardBlob>[0];
      blob = await getRateCardBlob(rcHost, entry.digest).catch(() => null);
    }
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const card = parseRateCard(bytes, entry.digest, validateRateCard);
    return isRateCardError(card) ? null : card;
  }

  /** Attach the reveal / use-expired actions after each cost-body rewrite. The
   *  reveal is device-local memory only — it is never written to the URL, so a shared
   *  link can never carry the revealed state. */
  function wireCostActions(): void {
    el!.querySelector<HTMLButtonElement>('[data-cost-reveal]')?.addEventListener('click', () => {
      costRevealed = true;
      void refreshCost();
    });
    el!.querySelector<HTMLButtonElement>('[data-cost-use-expired]')?.addEventListener('click', () => {
      costUseExpired = true;
      void refreshCost();
    });
  }

  // Same wiring as updateFidelityWarning, for the same reason: a sidebar edit can
  // change what preflight sees (a paginate source table gaining a row), so re-run
  // on every input change as well as on every format/size/print-setting change.
  // Cheap: one pure synchronous pass over a plain object.
  runtime.subscribe(() => refreshPreflight());
  refreshPreflight();

  function videoParams(): { wait: number; duration: number; fps: number | undefined; live: boolean; durationUserSet: boolean } {
    const wait     = parseFloat(el!.querySelector<HTMLInputElement>('[data-action="video-wait"]')?.value ?? '')     ?? 1;
    const duration = parseFloat(el!.querySelector<HTMLInputElement>('[data-action="video-duration"]')?.value ?? '') ?? 5;
    const hiFps    = el!.querySelector<HTMLInputElement>('[data-action="webm-60fps"]')?.checked ?? false;
    return {
      wait:     isFinite(wait)     ? Math.max(0,  wait)     : 1,
      duration: isFinite(duration) ? Math.max(0.5, duration) : 5,
      fps:      hiFps ? 60 : undefined,
      // "Record live" (webm/mp4): capture the on-screen preview via a screen share
      // instead of the offline render — see bridge/live-capture.ts. Popup-local.
      // Offered for timed compositions too — the compositor is the default, live
      // capture the low-power alternative the user may deliberately pick.
      live:     el!.querySelector<HTMLInputElement>('[data-action="video-live"]')?.checked ?? false,
      // The cross-agent contract: true only when the user typed their own duration,
      // so a tool hook can safely overwrite an auto-derived one with the timeline's
      // length (`if (!ctx.opts.durationUserSet) ctx.opts.duration = derived`).
      durationUserSet,
    };
  }

  // Preview the export aspect ratio on the canvas, then re-fit to the stage.
  function refreshCanvasPreview(): void {
    updateAspectWarning(); // first, so it reflects current fields even when dims are incomplete
    updateFidelityWarning();
    refreshPreflight();    // width / height / unit / DPI all flow through here
    const { width: w, height: h } = previewPx();
    if (!((w ?? 0) > 0 && (h ?? 0) > 0)) return;
    // When the artboard FOLLOWS the export size (see artboardFollowsDims) the canvas IS the
    // artboard, not a scaled thumbnail: box coordinates are absolute pixels in the artboard's
    // own space, so the layout box must equal the true (CSS-px) export size and fitCanvas's
    // transform does the on-screen fit. Clamping it to the native render size — right for a
    // preview thumbnail — would shrink the artboard under fixed box coords, so a bigger export
    // size pushed boxes off the frame and distorted the aspect ratio (thread B). The transform
    // fit already caps the on-screen size, so the clamp bought those editors nothing but
    // breakage. A fixed-canvas / carousel editor is NOT in this set: its canvas is owned
    // elsewhere (native-locked connector geometry, or the page strip) and keeps the clamp.
    const previewScale = artboardFollowsDims
      ? 1
      : Math.min(1, manifest.render.width / w!, manifest.render.height / h!);
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
  let dimPulseTimer: ReturnType<typeof setTimeout> | undefined;
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
    const onDimChange = () => { sizeUserSet = true; onUrlSync?.(key); refreshCanvasPreview(); invalidatePreview(); pulseCanvasResize(); };
    inp.addEventListener('input', onDimChange);
    addScrubBehavior(inp, onDimChange, { format: v => `${v} ${dimUnit()}` });
  });

  // ── Artboards are the size truth (plans/93 frame primitive) ──────────────────
  // In a framed editor (Layout Studio with a `frame` field), the export dimensions are
  // NOT an independent output size — editing them RESIZES ALL ARTBOARDS. On a committed
  // change we WARN, then set every frame box to the new size and re-flow the artboards in a
  // row (members move with their frame). A no-frames doc keeps the existing behaviour (the
  // single artboard follows the dims). Cancel restores the fields to the artboards' size.
  const canvasCfg = (canvasBlocksInput as { canvas?: Record<string, unknown> } | undefined)?.canvas;
  const canvasInputId = (canvasBlocksInput as { id?: string } | undefined)?.id;
  const artFrameField = typeof canvasCfg?.frameField === 'string' ? canvasCfg.frameField : '';
  const artNum = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  let artResizing = false;
  async function resizeArtboardsFromDims(): Promise<void> {
    if (artResizing || !artFrameField || !canvasInputId || manifest.render.layout !== 'editor') return;
    const kindField = typeof canvasCfg?.kindField === 'string' ? canvasCfg.kindField : 'kind';
    const frameKind = typeof canvasCfg?.frameKind === 'string' ? canvasCfg.frameKind : 'frame';
    const idField = typeof canvasCfg?.idField === 'string' ? canvasCfg.idField : 'id';
    const orderField = typeof canvasCfg?.orderField === 'string' ? canvasCfg.orderField : '';
    const boxes = (runtime.getModel().find(i => i.id === canvasInputId)?.value as Array<Record<string, InputValue>> | undefined) ?? [];
    const frames = boxes.filter(b => b && String(b[kindField]) === frameKind);
    if (!frames.length) return; // no artboards → the single-artboard path applies
    const unit = dimUnit();
    const w = parseFloat(el!.querySelector<HTMLInputElement>('[data-action="export-width"]')?.value ?? '');
    const h = parseFloat(el!.querySelector<HTMLInputElement>('[data-action="export-height"]')?.value ?? '');
    if (!(w > 0 && h > 0)) return;
    const pxW = Math.round(unit === 'px' ? w : toCssPx({ value: w, unit: unit as Unit }));
    const pxH = Math.round(unit === 'px' ? h : toCssPx({ value: h, unit: unit as Unit }));
    if (pxW < 1 || pxH < 1) return;
    if (frames.every(f => Math.round(artNum(f.w)) === pxW && Math.round(artNum(f.h)) === pxH)) return; // already this size

    artResizing = true;
    try {
      const ok = await confirmDialog({
        title: t('Resize all artboards?'),
        message: tRaw('This changes all {n} artboards to {w}×{h} px and lays them out in a row.', { n: String(frames.length), w: String(pxW), h: String(pxH) }),
        confirmLabel: t('Resize all'),
      });
      if (!ok) { // artboards stay the truth — restore the fields to the current artboard size
        setDims({ width: Math.round(artNum(frames[0]!.w)), height: Math.round(artNum(frames[0]!.h)), unit: 'px' });
        return;
      }
      const GAP = 40;
      const ordered = [...frames].sort((a, b) => (artNum(a[orderField]) - artNum(b[orderField])) || (artNum(a.x) - artNum(b.x)));
      const patch = new Map<string, { x: number; y: number; w: number; h: number }>();
      const delta = new Map<string, { dx: number; dy: number }>();
      let runX = 0;
      for (const f of ordered) {
        patch.set(String(f[idField]), { x: runX, y: 0, w: pxW, h: pxH });
        delta.set(String(f[idField]), { dx: runX - artNum(f.x), dy: 0 - artNum(f.y) });
        runX += pxW + GAP;
      }
      const next = boxes.map(b => {
        if (!b) return b;
        const p = patch.get(String(b[idField]));
        if (p) return { ...b, ...p };                                   // a frame → new size + row position
        const d = delta.get(String(b[artFrameField] ?? ''));           // a member → move with its frame
        return d ? { ...b, x: artNum(b.x) + d.dx, y: artNum(b.y) + d.dy } : b;
      });
      runtime.setInput(canvasInputId, next as unknown as InputValue);
    } finally { artResizing = false; }
  }
  ([
    el.querySelector<HTMLInputElement>('[data-action="export-width"]'),
    el.querySelector<HTMLInputElement>('[data-action="export-height"]'),
  ]).forEach(inp => inp?.addEventListener('change', () => { void resizeArtboardsFromDims(); }));

  // Apply a {width,height,unit} from a size-select option to the export-bar fields,
  // so choosing a size sets the actual exported page size. Refreshes the preview +
  // URL just like a manual edit. The user can still override the fields afterwards.
  // Narrow the export format bar to the formats `allowed` (an effect/mode select's
  // per-option list), intersected with the tool's capability-filtered union. Keeps
  // the current pick when it survives, else falls to the first surviving format and
  // fires the format `change` refresh so every per-format control follows. Never
  // empties the bar (an empty intersection falls back to the full set). Driven by
  // exportFormatDriver in tool.js; a no-op for a single-format tool (no <select>).
  function setFormats(allowed: string[]): void {
    if (!formatEl) return;
    const allow = new Set(allowed.map(f => (f === 'jpeg' ? 'jpg' : f)));
    let narrowed = formats.filter(f => allow.has(f));
    if (!narrowed.length) narrowed = formats;         // never render an empty selector
    const cur = formatEl.value;
    const next = narrowed.includes(cur) ? cur : narrowed[0]!;
    formatEl.innerHTML = formatOptionsHtml(narrowed, next, fmtLabel);
    if (next !== cur) formatEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setDims({ width, height, unit }: { width?: number; height?: number; unit?: string } = {}): void {
    if (manifest.render.dims === false) return;
    sizeUserSet = true;   // a size-select pick is the user setting the page size
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
    sizeUserSet = true;   // choosing mm/in over px IS declaring a physical size
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
      const blob = await exportUnscaled(() => runtime.export(exportTargetNode(canvasEl), fmt, exportDims()));
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
    const blobPromise = exportUnscaled(() => runtime.export(exportTargetNode(canvasEl), 'png', exportDims()), { shutter: true });
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

  // The "Request approval" CTA (present in place of Download only when the export
  // policy withheld download but permits a request — see `affordance` above). Routes
  // through the generic opener seam (src/lib/approval-request.ts), which a control
  // plane registers to open the approval dialog; the view stays control-plane-unaware.
  el.querySelector<HTMLButtonElement>('[data-action="request-approval"]')?.addEventListener('click', () => {
    openApprovalRequest({ toolId: manifest.id, title: manifest.name });
  });

  el.querySelector<HTMLButtonElement>('[data-action="download"]')?.addEventListener('click', async (e) => {
    // Native <button> or jelly-mode <jelly-button> — disable via the attribute,
    // which both honour (jelly syncs it onto its shadow button).
    const btn  = e.currentTarget as HTMLButtonElement;
    const prev = btn.textContent;
    btn.toggleAttribute('disabled', true);
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

    // Any zzfxm/tracker track is rendered to a transient WAV blob URL below (the
    // tool audio and a mix-in bed can each mint one); revoke them once the export
    // has consumed them (declared out here so the catch can free them too).
    const wavBlobUrls: string[] = [];
    const trackBlobUrl = (url: string): string => { wavBlobUrls.push(url); return url; };
    const revokeTrackUrls = (): void => { for (const u of wavBlobUrls.splice(0)) URL.revokeObjectURL(u); };
    try {
      // Resolve the chosen catalog audio track (if any) to a plain fetchable
      // URL before the recording starts — the export bridge stays catalog-
      // agnostic, and a missing/undownloadable track fails here in the UI
      // instead of mid-record. On-demand tier fetches + caches the bytes.
      let audioOpt: { audio?: NonNullable<RunExportOpts['audio']> } = {};
      // ZzFXM songs and tracker modules have no playable audio file — render them
      // to a transient WAV blob URL so the URL-driven muxer paths consume them
      // exactly like an encoded loop. (mod → libopenmpt, zzfxm → the synth.)
      const toWavIfNeeded = async (r: { url: string; format?: string }): Promise<string> =>
        r.format === 'zzfxm' ? trackBlobUrl(await songUrlToWavBlobUrl(r.url))
        : isModuleFormat(r.format) ? trackBlobUrl(await modUrlToWavBlobUrl(r.url))
        : r.url;
      if (isAudioFmt(fmt) && hasToolAudioInput) {
        // Audio-only export: the deliverable is the tool's OWN clip from the
        // in-point it draws from, and nothing else. No bed, no gain, no fade —
        // the tool applies no processing to the samples, and any envelope here
        // would defeat the untouched-source pass-through in lib/audio-encode.ts.
        const ref = await resolveToolAudio();
        if (ref) audioOpt = { audio: { id: toolAudioRef()?.id, url: await toWavIfNeeded(ref), volume: 1, start: stageAudioStart() } };
      } else if (isVideoFmt(fmt)) {
        const audioId = el!.querySelector<HTMLSelectElement>('[data-action="video-audio"]')?.value;
        const numCtl = (a: string, dflt: number): number => {
          const v = el!.querySelector<HTMLInputElement>(`[data-action="${a}"]`)?.value;
          return v != null && v !== '' ? (Number(v) || 0) : dflt;
        };
        // The popup's track choice ('' | __generate__ | asset id) → a fetchable URL.
        const resolveTrack = async (): Promise<{ url: string; id: string } | null> => {
          if (!audioId) return null;
          if (audioId === '__generate__') {
            // A fresh worker render at THIS clip's length — the seed keeps it the
            // same tune the user auditioned, just arranged to fit.
            const pcm = await renderSong(composeSong(generatedSongSpec(genSeed, genDur())));
            return { url: trackBlobUrl(URL.createObjectURL(pcmToWavBlob(pcm))), id: `zzfxm-generated-${genSeed}` };
          }
          return { url: await toWavIfNeeded(await host.assets.get(audioId)), id: audioId };
        };
        const fadeIn  = numCtl('audio-fadein', 0);
        const fadeOut = numCtl('audio-fadeout', 0);
        if (hasToolAudioInput) {
          // Two-row card (§6.1): the tool's own audio is ALWAYS the primary track
          // (read live — an emptied slot exports silent), the popup's pick is the
          // optional mix-in bed whose centre level sets its gain under the voice.
          const ref = await resolveToolAudio();
          const toolUrl = ref ? await toWavIfNeeded(ref) : null;
          const bed = await resolveTrack();
          const level = Math.max(0, Math.min(100, numCtl('audio-tool-level', 100))) / 100;
          const centreSel = el!.querySelector<HTMLSelectElement>('[data-action="audio-centre"]')?.value ?? 'low';
          const centre = centreSel === 'off' ? 0 : centreSel === 'full' ? 1 : CENTRE_LOW;
          if (toolUrl) {
            // In-point: a tool whose visuals begin partway into its own clip (the
            // audiogram's "Start at") stamps that offset on its stage as
            // data-audio-start, the same read-the-stage contract as data-seq-ms —
            // so the soundtrack starts where the picture does instead of at 0:00.
            // A property of the tool's OWN clip, so it applies only here, never to
            // a mix-in or standalone bed that knows nothing about the in-point.
            audioOpt = { audio: {
              id: toolAudioRef()?.id, url: toolUrl, volume: level, start: stageAudioStart(),
              ...(bed ? { mix: { id: bed.id, url: bed.url, centre, fadeIn, fadeOut } } : {}),
            } };
          } else if (bed) {
            // Empty tool slot: the mix-in track stands alone, today's single-bed shape.
            audioOpt = { audio: { id: bed.id, url: bed.url, fadeIn, fadeOut, volume: 1, duck: 1, start: 0 } };
          }
        } else if (audioId) {
          // Single-bed card — unchanged behaviour for tools without their own audio.
          const bed = await resolveTrack();
          const volume  = Math.max(0, Math.min(100, numCtl('audio-volume', 100))) / 100;
          const duck    = Math.max(0, Math.min(100, numCtl('audio-duck', 100))) / 100;
          if (bed) audioOpt = { audio: { id: bed.id, url: bed.url, fadeIn, fadeOut, volume, duck, start: 0 } };
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
      // Read one HDR slider's value (falls back to its default if the slider isn't
      // rendered for this format/tool).
      const hdrDial = (action: string, def: number): number => {
        const v = Number(el!.querySelector<HTMLInputElement>(`[data-action="${action}"]`)?.value);
        return Number.isFinite(v) ? v : def;
      };
      // RunExportOpts plus the durationUserSet contract flag: it belongs to the
      // sequence path (the tool hook reads ctx.opts.durationUserSet), not to the
      // generic shell-wide export options, so it's carried as a local widening
      // rather than pushed into the shared interface.
      const opts: RunExportOpts & { durationUserSet?: boolean; cuts?: number } & typeof audioOpt = {
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
        // Contact sheet — `opts.cuts` is the pinned cross-agent name the export
        // bridge reads. Passed only when the Frames control is actually mounted
        // (a timed composition) AND the format is a still: every other export omits
        // it entirely, so the single-playhead-frame default path is untouched.
        ...(isStillFmt(fmt) && el!.querySelector('[data-seq-still-only]') ? { cuts: cutsValue() } : {}),
        ...audioOpt,
        ...(isGif ? { dither: el!.querySelector<HTMLInputElement>('[data-action="gif-dither"]')?.checked ?? false } : {}),
        ...(fmt === 'html' ? { fullPage: el!.querySelector<HTMLInputElement>('[data-action="full-page"]')?.checked ?? false } : {}),
        ...(isPrintFmt(fmt) ? { ...printOpts(), barStyle: SEPARATING_FORMATS.has(fmt) ? 'cmyk-verify' as const : 'rgb-swatches' as const } : {}),
        // The brand palette drives the colour bar for EVERY print format now, not just
        // CMYK: the CMYK paths ALSO do exact brand-swatch matching against it (see
        // buildCmykPaletteMap in bridge/export.ts), while the RGB paths (PDF/SVG/EPS)
        // use it only to paint the brand colours as RGB swatches (barStyle above).
        ...(isPrintFmt(fmt) ? { palette: brandPalette } : {}),
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
        ...((el!.querySelector<HTMLInputElement>('[data-action="durable"]')?.checked ?? exportDefaults.durable) ? { durable: true } : {}),
        // HDR (Rec.2100 PQ) — opt-in; passes the live brand palette as the colours
        // to boost + the author's slider dials. The bridge applies it only to raster
        // (png/jpeg/avif/tiff), so it's a harmless pass-through elsewhere.
        ...((el!.querySelector<HTMLInputElement>('[data-action="hdr"]')?.checked ?? exportDefaults.hdr)
          ? {
              hdr: true, palette: brandPalette,
              hdrPeakNits: hdrDial('hdr-peak', HDR_DEFAULTS.peakNits),
              hdrReach:    hdrDial('hdr-reach', HDR_DEFAULTS.reach),
              hdrLift:     hdrDial('hdr-lift', HDR_DEFAULTS.lift),
              hdrRichness: hdrDial('hdr-focus', HDR_DEFAULTS.richness),
            }
          : {}),
        // Requested bit depth from the link (?depth=8/16/float). There is no panel
        // control for it — a depth request rides the URL and passes straight
        // through; the export bridge is where depth-follows-provenance is applied.
        ...(exportDefaults.depth ? { depth: exportDefaults.depth } : {}),
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
      // Also admit the Design/Layout-Studio frame primitive: an editor-layout tool whose
      // boxes input declares canvas.frameField emits one [data-pdf-page] per ARTBOARD (frame
      // box). A no-frames Design doc renders a single .artboard with zero [data-pdf-page], so
      // pageEls stays empty and it correctly falls through to a single flat export. Mirrors
      // tool.ts's frameCfg derivation (render.layout==='editor' && canvas.frameField).
      const framesCanvas = manifest.render.layout === 'editor'
        ? (manifest.inputs?.find(
            (i) => i.type === 'blocks' && (i as { canvas?: unknown }).canvas,
          ) as { canvas?: { frameField?: string } } | undefined)?.canvas
        : undefined;
      const hasFrames = !!framesCanvas?.frameField;
      const pageEls = (manifest.render.pages || hasFrames) && canvasEl
        ? [...canvasEl.querySelectorAll<HTMLElement>('[data-pdf-page]')] : [];
      if (pageEls.length >= 1 && !isAnimated && fmt !== 'pdf' && fmt !== 'zip' && fmt !== 'html' && fmt !== 'pptx') {
        // Export EACH page frame as its own still image, at that frame's own layout size
        // (offsetWidth/Height — transform-independent, and the true possibly-resized page
        // size, not the tool's static render dims). One page → a single file; several → a zip.
        if (pageEls.length > 1) btn.textContent = `Exporting ${pageEls.length} pages…`;
        const pageOpts: RunExportOpts & { durationUserSet?: boolean; cuts?: number } = { ...opts };
        delete pageOpts.bundleFormats;
        // Per-artboard stills fan out one image per frame; a cuts=N contact sheet only
        // applies to a whole [data-sequence] stage (the .lolly-frames wrapper), so it is
        // inert on an individual [data-pdf-page]. Drop it so a framed timed doc's per-slide
        // export can never carry a stray cuts opt into the page-level render.
        delete pageOpts.cuts;
        // A timed slideshow (frames-as-scenes) gates off-playhead artboards with
        // `.seq-off` (display:none, timeline.css) so only the current slide shows live.
        // A per-artboard still export must lift that first, or every non-current frame
        // photographs BLANK. Strip it across the whole canvas for the export window and
        // restore in `finally` (mirrors sequence-render.ts's photograph-time strip; the
        // class name is the CSS contract — OFF_CLASS in bridge/sequence-dom.ts).
        const seqOff = canvasEl ? [...canvasEl.querySelectorAll<HTMLElement>('.seq-off')] : [];
        seqOff.forEach((o) => o.classList.remove('seq-off'));
        let files: Array<{ name: string; blob: Blob }>;
        try {
          files = await exportUnscaled(async () => {
            const out: Array<{ name: string; blob: Blob }> = [];
            for (let i = 0; i < pageEls.length; i++) {
              const el = pageEls[i]!;
              const pb = await runtime.export(el, fmt, { ...pageOpts, width: el.offsetWidth, height: el.offsetHeight });
              out.push({ name: `${filename}-${i + 1}.${extFor(fmt, pb)}`, blob: pb });
            }
            return out;
          }, { shutter: true });
        } finally {
          seqOff.forEach((o) => o.classList.add('seq-off'));
        }
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
        // A LIVE take must keep the fit-to-stage scale: exportUnscaled blows the
        // canvas up to native size for the entire recording, so the user watches a
        // clipped canvas and the capture crops to a viewport slice. Record the
        // preview exactly as displayed instead — the recorder's sizing/bitrate math
        // already reads the on-screen rect × dpr. It also films the SCREEN, so the
        // shutter would appear in the take; both reasons point the same way, and the
        // ternary below keeps live out of exportUnscaled entirely.
        //
        // EVERY OTHER export gets the shutter, animated included (Andy, 2026-07-27).
        // This used to be `shutter: !isAnimated`, on the reasoning that an animated
        // format "records the live canvas over seconds" — true only of a live take,
        // which never reaches this branch. Every other motion path composites
        // OFF-SCREEN: the sequence compositor rasterises static layers once and draws
        // into its own canvas, renderRecord/renderTopTail draw to theirs, renderVideo
        // replays onto an offscreen canvas, and a [data-capture-stream] tool captures
        // its own canvas's backing store, which an overlay cannot touch. `.export-shutter`
        // is also a SIBLING of #tool-canvas-outer while every capture targets
        // #tool-canvas or below, so it is outside the captured subtree either way.
        // Meanwhile the shake is real for video too — exportUnscaled strips the
        // transform and resizes to full export dimensions, and a lottie layer visibly
        // steps frame-by-frame during a sequence render. The iris is built to hold
        // (see the CSS): it stays closed for the variable export time, and the export
        // popup keeps showing progress underneath it.
        const blob = liveTake
          ? await runtime.export(exportTargetNode(canvasEl), fmt, opts)
          : await exportUnscaled(() => runtime.export(exportTargetNode(canvasEl), fmt, opts), { shutter: true });
        downloadedBlob = blob;
        await host.export.download(blob, `${filename}.${extFor(fmt, blob)}`);
      }
      revokeTrackUrls();
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
      revokeTrackUrls();
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
      setTimeout(() => { btn.textContent = prev; btn.toggleAttribute('disabled', false); }, 3500);
      return;
    }

    btn.removeAttribute('aria-busy');
    btn.textContent = prev;
    btn.toggleAttribute('disabled', false);
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
      await exportUnscaled(() => runtime.export(exportTargetNode(canvasEl), fmt, exportDims()));
    } finally {
      previewing = false;
    }
  }

  // Expose actions the mount scope can trigger programmatically (e.g. `?copy`,
  // and the unsaved-changes dialog's "Save & leave"). stopAudioPreview lets the
  // popup-close + tool-teardown paths silence an in-progress audio audition.
  // `sessionState` is the SAME snapshot a save writes, read (never written) by the beam
  // for its `__export_*` markers — the one place they exist outside this panel's DOM.
  return { copy: performCopy, preview, save: performSave, setDims, setFormats, stopAudioPreview, sessionState: sessionSnapshot, dispose: disposeCostSlot };
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
  // A paged tool's canvas is EVERY page stacked (battlecards' four cards make a
  // 1:3 strip) — as a tile that squashes into an unrecognisable ribbon. The
  // thumbnail should be what one card/page looks like, so capture the FIRST
  // [data-pdf-page] box at its own laid-out size instead of the whole document.
  const firstPage = manifest.render.paged === true
    ? canvasEl?.querySelector<HTMLElement>('[data-pdf-page]') ?? null : null;
  if (firstPage) canvasEl = firstPage;

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
        () => runtime.export(exportTargetNode(canvasEl), 'svg', { width: nw, height: nh, embedMeta: false, thumbnail: true }),
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
      () => runtime.export(exportTargetNode(canvasEl), 'png', { width: tw, height: th, embedMeta: false, thumbnail: true }),
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
