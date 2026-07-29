// SPDX-License-Identifier: MPL-2.0
/**
 * ExportAPI — converts a rendered DOM node to a file format.
 *
 * The host owns the renderer choice. Tools call host.export.render(node, fmt)
 * and get back a Blob. This file is where format support is added/swapped —
 * one place, not 50.
 *
 * Watermarking: applied when the tool is 'experimental' OR opts.watermark is true.
 * The watermark is a corner overlay clone-injected into the node before rasterisation.
 * For SVG we inject an <text> element instead.
 */

import {
  parseDimension, isPhysical, toPixels, toPoints, toCssPx, toCssLength, CSS_DPI,
  iccProfileBytes, rgbToCmyk, cmykCondition, computePrintGeometry, emitEmf, emitEps, emitDxf, packApng, packWebpAnim,
  parseCssLength, cornerRadii, uniformRadius, insetCorners, roundedRectPath, parseBoxShadow, parseTextShadow, gaussianShadowBands, gaussianShadowRings,
  parseCssMatrix, matAboutPivot, isAxisAlignedMat, matToSvg, type Mat2D,
  parseClipShape, parseRadialGradient, parseConicGradient, parseDropShadowFilter, type ConicGradient,
  splitCssArgs, parseGradientAngle, parseGradientStop,
  parseColor, interpolateColor, colorToSrgb8,
  embedC2pa, exportActionSteps, C2PA_FORMATS, CAPTURE_SOURCE_TYPE, SCREEN_SOURCE_TYPE, extractC2paStore, packTiff, ENGINE_VERSION,
  buildExportMeta,
  embedWatermark, canCarryWatermark, LOSSLESS_STRENGTH,
  videoProvenanceTags, embedMp4Meta, embedWebmMeta,
  buildEncryptDictValues, encryptObjectBytes, preparePassword,
  buildEncryptedZip, crc32,
  buildPptxParts, EMU_PER_PX,
  hdrBoostToPQ, pqBt2020IccProfile, HDR_PQ_CICP,
} from '@lolly/engine';
import type { HdrBoostOptions } from '@lolly/engine';
import {
  suseFontFile, SUSE_FONT_DIR,
  canVectoriseText, textBaselineY,
  featureSettingsToHb, letterSpacingPx,
} from './text-svg.ts';
import { resolveVectorFont } from './font-registry.ts';
import type { VectorFont } from './font-registry.ts';
import { svgDomToIr } from './svg-ir.ts';
import { placeBackground } from './bg-layout.ts';
import { parseCssFilter, isDropShadowOnly, type FilterPrimitive } from './css-filter.ts';
import { describeControl, controlText, isWidgetControl, rangeFraction, type ControlDesc } from './form-controls.ts';
import { stackingRole, sortUnits, orderModifiedChildren, isFlexOrGridContainer } from './stacking-order.ts';
import type { StackingRole } from './stacking-order.ts';
import { unscopeStyleEls } from '../lib/scope-css.ts';
import { assembleAnimatedSvg } from '../lib/svg-anim-core.ts';
import { recTransition } from '../lib/transitions.ts';
import { suspendNodeRasters, drainNodeRasters } from '../lib/clip-thumbs.ts';
import { videoMimeCandidates, videoBitrate, LIVE_BITS_PER_PIXEL } from './video-mime.ts';
import { encodeMuxWebCodecs, type EncodeAudio } from './video-encode-core.ts';
import { supportsWorkerVideoEncode, encodeVideoInWorker } from './video-encode.ts';
// Capability probes live in format-support.ts so the tool view can import them
// without pulling this rasteriser onto the tool-open path. Re-exported here for
// dynamic callers (e.g. bridge/compose.ts does `await import('./export.ts')`).
import { canRecord } from './format-support.ts';
import { chromePaintsOverLive, countToolMutations, createStaticChromeGuard, staticChromeFrameAction, staticChromeVerdict, type Box, type ChromeEl } from './frame-static.ts';
export { videoSupport, cmykTiffSupport, tiffSupport } from './format-support.ts';
import type { ClipShape } from '../../../../engine/src/css-paint.ts';
import type { PptxSlide, PptxShape, PptxFill, PptxMedia } from '../../../../engine/src/pptx.ts';
import type { HostV1, ExportMeta, IngredientCredential } from '@lolly-tools/core/host-v1';
import type { C2paActionInput } from '../../../../engine/src/c2pa.ts';
import type { PrintGeometry, LabelSlot } from '../../../../engine/src/print-marks.ts';
import type { Dimension } from '../../../../engine/src/units.ts';
import type { CornerRadii, CornerPair } from '../../../../engine/src/css-box.ts';
import { n2, parseCssColor, parseCssColorFull, rgbaCss, parseCssLen, resolveRadii, objectPositionFractions } from "./export-css.ts";
import { renderPptx } from "./export-pptx.ts";
// Stage-1 split: DOM-free byte-stampers and vector-PDF helpers extracted
// verbatim to sibling modules, imported back so no call site changes.
import {
  patchJpegDpi, insertPngPhys, insertPngMeta, insertJpegExif, iccWanted,
  insertPngIcc, insertJpegIcc, insertPngCicp, setAvifCicp, injectSvgMeta, withGifComment,
  inflateBytes, deflateBytes,
} from './export-image-meta.ts';
import {
  pureRotationDeg, sampleGradientMidpoint, brandSwatchPalette, blendSvgWithWhite,
  pdfGradientSpec, fillPdfShading,
  pdfRoundedRect, withPdfAlpha, withPdfClipRect, withPdfRoundedClip, pdfApplyClip,
  withPdfRotation, withPdfMatrix, drawSvgPathToPdf, applyTextTransform, borderDashArray,
  buildCmykPaletteMap, assignSpotResourceNames, cmykKey, paletteHitKey, substitutePdfRgb,
  svgLen, preserveAspectRatioAlign, parseSvgColor,
} from './export-pdf-vector.ts';
import type { BrandPaletteEntry, PaletteHit } from './export-pdf-vector.ts';
// The PDF/X-4 metadata pass + its claim gate (moved out of this file verbatim).
import { applyPdfX } from './export-pdfx.ts';
// The user's own CMYK profile → the bytes a PDF/X-4 DestOutputProfile embeds.
import { isOwnProfile, resolveEmbeddedProfile } from '../lib/press-profile-embed.ts';
import type { EmbedResolution } from '../lib/press-profile-embed.ts';
// Moved to export-pdf-vector.ts; re-exported because export-pptx.ts imports it from here.
export { pureRotationDeg };

// ── Local types ─────────────────────────────────────────────────────────────
type Rgb = [number, number, number];
type Rgba = [number, number, number, number];
type LabelsRecord = Partial<Record<LabelSlot, string>>;

// The web shell's host is a superset of the engine's HostV1 — it also carries an
// `identity` bridge (bridge/identity.js) used for Content Credentials signing.
interface WebIdentityAPI { signer(): Promise<unknown>; }
type WebHost = HostV1 & { identity?: WebIdentityAPI };


// The union of options this host's export path understands. A superset of the
// Per-export imprint state threaded through the vector/container export path in
// place of a bare `imprint` boolean. A single instance is created per format
// render (renderFormat) and reaches imprintEmbedCanvas at every raster chokepoint
// by reference, across the export.ts / export-pptx.ts boundary. `want` mirrors
// opts.imprint on a Lolly-rendered raster; `applied` is set true — ONLY inside
// imprintEmbedCanvas — the first time a mark is genuinely embedded (want && the
// raster clears the size floor). stampC2pa reads `applied` so a container export
// (pdf) claims an imprint only when one was really written — a pure-vector page
// (a QR PDF) marks no raster, so it must not claim. `undefined` / want:false at a
// call site = never mark (user assets, opted-out exports).
export interface ImprintState { want: boolean; applied: boolean }

// engine's ExportOpts — the extra fields (print marks, video timing, c2pa, …)
// are web-shell extensions the engine passes through untouched.
export interface ExportOpts {
  scale?: number;
  quality?: number;
  background?: string;
  watermark?: boolean;
  filename?: string;
  width?: number | string;
  height?: number | string;
  dpi?: number;
  unit?: string;
  meta?: ExportMeta;
  ingredients?: IngredientCredential[];  // preserved source-asset credentials → C2PA
  c2paInputs?: Record<string, string>;   // scalar-input digest → tools.lolly.export assertion (runtime-supplied)
  c2paCapture?: { camera?: boolean; microphone?: boolean; screen?: boolean }; // sensor/screen origin → created step = digitalCapture/screenCapture (runtime-supplied)
  c2paTextAdded?: { sample?: string };   // text over an opened asset → a c2pa.edited "Added text" step (runtime-supplied)
  colorProfile?: string;
  thumbnail?: boolean;
  audio?: { id?: string; url: string; fadeIn?: number; fadeOut?: number; volume?: number; duck?: number; start?: number };
  c2pa?: boolean;
  c2paDays?: number | string;
  /** Embed the Lolly pixel watermark into raster exports (png/jpg/webp/avif/tiff).
   *  On by default, like C2PA; explicit opt-out via `imprint=0` in the URL. A
   *  durable, imperceptible mark that survives what strips the C2PA credential —
   *  see engine/pixel-watermark. */
  imprint?: boolean;
  /** Embed a DURABLE Content Credential — a TrustMark-format neural watermark
   *  carrying Lolly's identifier — into raster exports, so a metadata strip can't
   *  erase the "made with Lolly" link and a TrustMark-aware tool can recover it.
   *  Opt-in (heavy neural encode + a fetched ~tens-of-MB model), unlike the
   *  default-on pure-JS `imprint`. A no-op when the encoder model isn't on-device
   *  (scripts/convert-trustmark-encoder-onnx.py). Raster-only (png/jpg/webp/avif/
   *  tiff) — see lib/trustmark-embed.ts and plans/durable-content-credentials.md. */
  durable?: boolean;
  /** Reserved id carried by the durable mark (0 until the CAI id scheme lands). */
  durableId?: number;
  /** OPT-IN HDR raster export (the `hdr` URL param). When set, an HDR-capable
   *  raster (png/jpeg/avif/tiff) is encoded in Rec.2100 PQ with the brand's primary
   *  colours (opts.palette) boosted toward peak luminance — white text and brand
   *  colours glow on HDR displays, darks stay dark. Off by default; SDR otherwise.
   *  See engine/src/hdr.ts + pqBt2020IccProfile. */
  hdr?: boolean;
  /** HDR author dials (from the export-panel sliders / tuned `hdr=` value). All
   *  optional — omitted ⇒ engine defaults. `hdrPeakNits`: white ceiling (nits).
   *  `hdrReach`/`hdrLift`/`hdrRichness`: 0–100 (glow reach / dark lift / colour focus). */
  hdrPeakNits?: number;
  hdrReach?: number;
  hdrLift?: number;
  hdrRichness?: number;
  /** INTERNAL, per-format-render mutable sink (created in renderFormat, never
   *  URL-serialized). Carries the imprint request down to imprintEmbedCanvas and
   *  records whether a container raster was actually marked, so stampC2pa can
   *  claim an imprint truthfully for pdf. See ImprintState. */
  _imprintSink?: ImprintState;
  palette?: BrandPaletteEntry[];
  bleed?: number | string;
  cropMarks?: boolean;
  registrationMarks?: boolean;
  bleedMarks?: boolean;
  colorBars?: boolean;
  provenance?: boolean;
  dataText?: string;
  dataMime?: string;
  icoSizes?: number[];
  bundleFormats?: string[];
  /** CONTACT SHEET frame count for a STILL export of a timed composition (the
   *  `cuts` URL param; engine url-mode parses and clamps it). 1 or absent — the
   *  overwhelmingly common case — is the frame at the playhead, byte-identical to
   *  no param at all. N > 1 renders N stills at midpoint times across the
   *  sequence: png/jpg/webp/svg come back as one ZIP of `<filename>-01.<ext>`
   *  members, pdf as ONE document of N pages. Ignored by every non-still format
   *  and by any node that is not a [data-sequence] stage. See bridge/
   *  sequence-cuts.ts and plans/fable-timeline-editing.md §4.6. */
  cuts?: number;
  onProgress?: (done: number, total: number) => void;
  fps?: number;
  repeat?: number;
  dither?: boolean;
  convertPaths?: boolean;
  /** Vector export escape-hatch: when a node uses CSS the SVG/PDF walker can't express,
   *  embed it as a raster instead of dropping it. On by default; set false to A/B the
   *  pure-vector output (used by the byte-identical regression test). */
  rasterFallback?: boolean;
  /** Page-snapshot mode for the raster escape hatch: capture only the offending
   *  element's OWN paint layer as an <image> and keep walking its children as
   *  vector, instead of baking the whole subtree into one PNG.
   *
   *  Default (absent/false) is the historical subtree behaviour, which every tool
   *  export relies on — see the note at the hatch for why splitting paint from
   *  children is not automatically safe when the two composite together. Turned on
   *  by main.ts's `__lollyWalkerShot` loopback hook, where the input is a whole
   *  page and one unsupported property on a container would otherwise reduce the
   *  entire capture to a screenshot. */
  elementScopedRaster?: boolean;
  /** Reconstruct `backdrop-filter: blur()` by duplicating, clipping and blurring the
   *  content behind the element, instead of sending it to the raster hatch (which
   *  cannot see a backdrop at all). Snapshot mode only — it duplicates geometry, and
   *  the cost is only worth paying when the goal is fidelity to a live page. */
  backdropBlur?: boolean;
  /** Page snapshots: paint in CSS stacking-context order (CSS 2.1 Appendix E
   *  §E.2) instead of DOM order — negative-z children behind their parent's
   *  in-flow content, positioned descendants above non-positioned ones, each
   *  layer z-sorted, hoists terminating at every stacking-context creator (the
   *  table in bridge/stacking-order.ts).
   *
   *  Default (absent/false) is DOM order, which every tool export has always
   *  had. OFF is not "the new code happens to agree": `PaintCtx.frame === null`
   *  makes every deferral branch unreachable, so each of the three placement
   *  sites reduces to the single `parentG.appendChild(unit)` it was before and
   *  the emitted bytes CANNOT differ. That short-circuit plus the byte-identity
   *  golden in export-paint-order.test.ts is the entire protection for the
   *  shipping SVG/PDF/EMF/EPS export path of every tool in every profile.
   *
   *  Turned on by main.ts's `__lollyWalkerShot` loopback hook, where the input
   *  is a whole page: on Lolly's own gallery 99 elements carry a non-auto
   *  z-index, 22 of them negative, and DOM order paints them all wrong. */
  stackingOrder?: boolean;
  noBoxShadow?: boolean;
  password?: string;
  /** Strong tier: AES-256 (R6) applied as a final encrypt-last pass over the
   *  finished PDF bytes. Composes with PDF/X + CMYK + marks (unlike `password`,
   *  the jsPDF-native 40-bit RC4 lock). Never serialized to a URL. */
  strongPassword?: string;
  fullPage?: boolean;
  wait?: number;
  duration?: number;
  /** True when the user actually EDITED the export bar's duration field for this
   *  export — set by the shell, never inferred. It is what lets a derived length
   *  (a sequence's timeline) stay the default while a direct intervention still
   *  wins: the sequence tool's beforeExport only overwrites `duration` when this is
   *  unset, and the compositor re-lengths the stage when it is (sequence-plan
   *  applyDurationOverride). Popup-local, like wait/duration. */
  durationUserSet?: boolean;
  /** Record the ON-SCREEN preview through a screen share instead of the offline
   *  frame-by-frame render, so frame pacing matches what the user watched. Opt-in
   *  via the export panel's "Record live" toggle; webm/mp4 only. Popup-local like
   *  wait/duration — never serialized into URLs or share links. */
  live?: boolean;
}

interface ExportDims {
  node: { w: number; h: number };
  w: Dimension;
  h: Dimension;
  dpi: number;
  physical: boolean;
}

interface DtoRenderOpts {
  width: number;
  height: number;
  style: {
    transform: string;
    transformOrigin: string;
    width: string;
    height: string;
    background?: string;
    // Neutralised when rasterising a positioned child in isolation (renderRecord):
    // an object's own left/top/margin would otherwise offset it out of its bitmap.
    left?: string;
    top?: string;
    margin?: string;
  };
  bgcolor?: string;
}

// dom-to-image-more ships no types. This is the slice of its surface the export path
// uses; typing it catches option-key typos at the inline-literal call sites and locks
// the three method names. toJpeg additionally takes a `quality`.
type DtoOpts = DtoRenderOpts & { quality?: number };
interface DomToImage {
  toPng(node: Node, opts?: DtoOpts): Promise<string>;
  toJpeg(node: Node, opts?: DtoOpts): Promise<string>;
  toCanvas(node: Node, opts?: DtoOpts): Promise<HTMLCanvasElement>;
}

let domToImageMore: DomToImage | null = null;

// The host is captured once at bridge construction so the SVG text vectoriser can
// reach host.text.toPath without threading it through every render function. The
// reference is stable; host.text is attached just after createExportAPI runs (see
// bridge/index.js ordering), so read it lazily at render time, not here.
export let _host: WebHost | null = null;

/**
 * Resolve the requested output size for an export.
 *
 * opts.width / opts.height may be numbers (CSS px) or unit strings ("210mm",
 * "8.5in", "595pt", "800px"); absent falls back to the node's on-screen size.
 * Physical units need a resolution for raster output — opts.dpi wins, else 300
 * (print) when any physical unit is in play, else 96 (CSS). Vector formats
 * (PDF/SVG) ignore the DPI; they convert exactly.
 */
function exportDims(node: Element, opts: ExportOpts): ExportDims {
  const r = node.getBoundingClientRect();
  const node_ = { w: r.width || 1, h: r.height || 1 };
  const w = parseDimension(opts.width) ?? { value: node_.w, unit: 'px' as const };
  const h = parseDimension(opts.height) ?? { value: node_.h, unit: 'px' as const };
  const physical = isPhysical(w) || isPhysical(h);
  const dpi = ((opts.dpi as number) > 0) ? (opts.dpi as number) : (physical ? 300 : CSS_DPI);
  return { node: node_, w, h, dpi, physical };
}

async function getDomToImage(): Promise<DomToImage> {
  if (!domToImageMore) {
    const mod: any = await import('dom-to-image-more');
    domToImageMore = mod.default ?? mod;
  }
  return domToImageMore!;
}

export function createExportAPI(host: WebHost) {
  _host = host;
  return {
    async render(node: Element, format: string, opts: ExportOpts = {}): Promise<Blob> {
      const watermark = Boolean(opts.watermark);

      // Watermark via a live overlay on the original node, not a detached clone.
      // Detached clones lose getComputedStyle context: CSS variables don't resolve,
      // animations don't run, getBoundingClientRect returns zero — everything breaks.
      const removeWatermark = watermark ? addWatermarkOverlay(node as HTMLElement) : null;
      // Pull any editor-only chrome out of the tree for the duration of the capture.
      const restoreHidden = detachExportHidden(node);
      // The timeline panel photographs its own clip boxes with the SAME dom-to-image
      // instance, whose options / url cache / sandbox iframe are module-global and are
      // cleared by whichever call finishes first. detachExportHidden removes the panel
      // from the tree, which stops it *scheduling* more, but a shot already in flight
      // would still corrupt this one — and the panel is not the only thing rastering.
      // Freeze every <video> to a current-frame still — the DOM serialiser can't
      // paint live video, so a video box would otherwise export blank. One swap on
      // the live node here covers every format, including each ZIP sub-format (they
      // re-dispatch the same, already-swapped node).
      //
      // ONE exception: a [data-sequence] stage exported to a MOTION format. There
      // the sequence compositor decodes every clip itself, frame by frame, off the
      // timeline — a frozen still would export a stuck picture instead of moving
      // footage. Stills KEEP the freeze, deliberately: a still export of a sequence
      // is the frame at the playhead, with each video exactly where the preview
      // had it (the phase-2 WYSIWYG contract).
      const restoreMotion = (SEQUENCE_MOTION_FORMATS.has(format) && isSequenceStage(node))
        ? (): void => {}
        : snapshotMotion(node);

      // The timeline panel photographs its own clip boxes with the SAME dom-to-image
      // instance, whose options / url cache / sandbox iframe are module-global and are
      // cleared by whichever call finishes first. detachExportHidden removes the panel
      // from the tree, which stops it *scheduling* more, but a shot already in flight
      // would still corrupt this one — and the panel is not the only thing rastering.
      // Say it explicitly instead of relying on that side effect.
      //
      // Acquired HERE, immediately before the try, and not a line earlier: the counter
      // is only decremented by the `finally` below, so anything that can throw between
      // the two (snapshotMotion walks the tree) would suspend frame thumbnails for the
      // rest of the session with nothing to log and nothing to reset it.
      const resumeThumbRasters = suspendNodeRasters();
      try {
        // Suspending stops the NEXT shot; it cannot cancel the uncancellable one that
        // is already inside the library. Wait that one out — bounded — or its teardown
        // clears the sandbox iframe and url cache out from under THIS render.
        await drainNodeRasters();
        return await renderFormat(node, format, opts);
      } finally {
        restoreMotion();
        resumeThumbRasters();
        restoreHidden();
        removeWatermark?.();
      }
    },

    async download(blob: Blob, filename: string): Promise<void> {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    // Transform-path delivery: a blob the tool produced itself (a transformed
    // user file from the exportFile hook). On the web this is just a download —
    // but it's deliberately a distinct verb from render(): no watermark and no
    // provenance metadata are ever applied, because the bytes are the user's own
    // content. (Tauri/CLI route this to a real save target.)
    async file(blob: Blob, opts: ExportOpts = {}): Promise<void> {
      await this.download(blob, opts.filename || 'file');
    },
  };
}

// Dispatch one format → Blob. Split out from the watermark wrapper above so the
// ZIP bundler can reuse it per sub-format without re-applying the overlay (the
// outer render() already watermarked the live node once).
//
// Content Credentials are stamped HERE, after the per-format renderer returns —
// the last byte operation on every supported container (the credential hashes
// the finished bytes; for video that means after the provenance-tags embed in
// withVideoMeta). Keying on the format STRING (not blob.type) keeps apng
// distinct from png, and running inside renderFormat means zip members get
// stamped individually while the zip container itself never is (not in the
// set). Preview/thumbnail/compose renders never set opts.c2pa, so they skip.
// Video is the one exception to string keying: MediaRecorder may legitimately
// fall back to the other container (a requested mp4 can come out as webm bytes
// on Firefox), so the stamp keys on the container the recorder actually chose.
const C2PA_STAMPABLE = new Set<string>(C2PA_FORMATS);

async function renderFormat(node: Element, format: string, opts: ExportOpts = {}): Promise<Blob> {
  // Fresh imprint sink per format render (so each zip member — which re-enters
  // here — starts with applied=false; a marked earlier member can't make a later
  // pure-vector one over-claim). Created BEFORE dispatch so the container render
  // path can flip `applied`, and read by stampC2pa AFTER. `want` gates whether any
  // Lolly-rendered raster gets marked at all.
  opts._imprintSink = { want: !!opts.imprint, applied: false };
  const blob = await renderFormatDispatch(node, format, opts);
  const key = format === 'webm' || format === 'mp4'
    ? (blob.type.includes('mp4') ? 'mp4' : 'webm')
    : format === 'webp-anim' ? 'webp'          // animated WebP stamps like a still WebP (placeWebp appends a C2PA RIFF chunk)
    : format;
  if (opts.c2pa && C2PA_STAMPABLE.has(key)) {
    // The output size is only knowable here (node + opts); pass it to the stamp so
    // the credential can record "where/how big" alongside the input digest.
    let dimensions: string | undefined;
    try { dimensions = describeDimensions(exportDims(node, opts)); } catch { /* size is a nicety */ }
    return stampC2pa(blob, key, opts, dimensions);
  }
  return blob;
}

// A top-&-tail recorder's render target carries [data-toptail] (on the node or a
// descendant), routing webm/mp4 export through the real-time card+footage compositor.
function isTopTailStage(node: Element): boolean {
  return Boolean((node as HTMLElement).matches?.('[data-toptail]') || node.querySelector?.('[data-toptail]'));
}

// The Record tool's editor strip carries [data-record-stage] (on the node or a
// descendant): an intro card + live-camera clip + outro card, each object animated
// in with its own transition. Routes webm/mp4 through renderRecord.
function isRecordStage(node: Element): boolean {
  return Boolean((node as HTMLElement).matches?.('[data-record-stage]') || node.querySelector?.('[data-record-stage]'));
}

// A timed composition's artboard carries [data-sequence] (on the node or a
// descendant) — the all-or-nothing marker a tool stamps when anything on it has a
// start/duration. Motion export then goes through the deterministic sequence
// compositor (bridge/sequence-render.ts), which reads the timeline off the DOM and
// decodes each clip frame-accurately instead of filming the preview in real time.
function isSequenceStage(node: Element): boolean {
  return Boolean((node as HTMLElement).matches?.('[data-sequence]') || node.querySelector?.('[data-sequence]'));
}

// The formats a sequence stage renders through the compositor. Everything else is
// a STILL: the frame at the playhead, exactly as the preview shows it.
const SEQUENCE_MOTION_FORMATS = new Set(['webm', 'mp4', 'gif', 'apng']);

// Lazy so mediabunny + the compositor stay out of the initial bundle (the muxer
// precedent) — they load the first time a timed composition is exported.
async function renderSequenceStage(node: Element, format: 'mp4' | 'webm' | 'gif' | 'apng', opts: ExportOpts): Promise<Blob> {
  const { renderSequence } = await import('./sequence-render.ts');
  return renderSequence(node, format, opts, _host ?? null);
}

// The STILL sibling of the compositor: `cuts=N` (N > 1) on a still format over a
// [data-sequence] stage → N stills at midpoint times, zipped (raster/svg) or paged
// (pdf). Lazy for the same reason as above, and because the overwhelmingly common
// still export never comes near it. Every renderer stays here; sequence-cuts.ts
// owns only the loop, the sampling and the naming.
async function renderSequenceCutSheet(node: Element, format: string, opts: ExportOpts): Promise<Blob> {
  const { renderSequenceCuts } = await import('./sequence-cuts.ts');
  return renderSequenceCuts(node, format, opts, {
    renderStill: (n, f, o) => renderFormat(n, f, o),
    async renderPdfPages(pages, o, prepare) {
      let blob = await renderMultiPagePdf(pages, o, prepare);
      // The tail of renderPdf: the strong tier is an encrypt-last pass over the
      // finished bytes, and a paged contact sheet is finished bytes.
      if (o.strongPassword) blob = await encryptPdfStrong(blob, o.strongPassword);
      return blob;
    },
    packZip: (members, o) => packZip(members, o),
    log: (l, m) => { _host?.log?.(l as 'debug' | 'info' | 'warn' | 'error', m); },
  });
}

async function renderFormatDispatch(node: Element, format: string, opts: ExportOpts = {}): Promise<Blob> {
  // Contact sheet FIRST, ahead of every still renderer: `cuts=N` changes what the
  // output IS (an archive, or a paged document), not how one still is drawn. The
  // guard is exact — N > 1, a still format, a timed stage — so `cuts=1` and every
  // non-sequence export fall straight through to the switch untouched.
  if (opts.cuts != null && opts.cuts !== 1 && isSequenceStage(node)) {
    const { wantsCuts } = await import('./sequence-cuts.ts');
    if (wantsCuts(format, opts.cuts, true)) return await renderSequenceCutSheet(node, format, opts);
  }
  switch (format) {
    case 'png':
      return await renderRaster(node, 'png', opts);
    case 'jpg':
    case 'jpeg':
      return await renderRaster(node, 'jpeg', opts);
    case 'webp':
      return await renderBitmap(node, 'image/webp', opts);
    case 'avif':
      // Same imprint-then-encode path as webp (renderBitmap perturbs the canvas
      // pixels before the browser's AV1 encode). Survival is UNVERIFIED here —
      // the watermark was calibrated against 8×8-block JPEG DCT quantization
      // (see engine/pixel-watermark.ts); AV1's block-transform + loop-filter
      // pipeline is different enough that it needs its own round-trip
      // calibration (like the sharp JPEG suite) before this can be trusted.
      return await renderBitmap(node, 'image/avif', opts);
    case 'cmyk-tiff':
      return await renderCmykTiff(node, opts);
    case 'tiff':
      return await renderTiff(node, opts);
    case 'svg':
      return await renderSvg(node, opts);
    case 'svg-anim':
      return await renderSvgAnim(node, opts);
    case 'emf':
      return await renderEmf(node, opts);
    case 'dxf':
      return await renderDxf(node, opts);
    case 'eps':
      return await renderEps(node, opts, false);
    case 'eps-cmyk':
      return await renderEps(node, opts, true);
    case 'pdf':
      return await renderPdf(node, opts);
    case 'pdf-cmyk':
      return await renderCmykPdf(node, opts);
    case 'html':
      return renderStaticHtml(node, opts);
    case 'md':
      // A tool with a template.md gives model-derived markdown (opts.dataText, set by
      // the engine); otherwise serialise the rendered DOM (renderMarkdown) as before.
      return opts.dataText != null
        ? new Blob([opts.dataText], { type: opts.dataMime ?? 'text/markdown' })
        : renderMarkdown(node);
    case 'txt':
      return renderPlainText(node);
    case 'json':
    case 'csv':
    case 'ics':
    case 'vcf':
      // Engine already hydrated the payload (runtime.export → buildDataPayload);
      // the host just wraps it with the right MIME.
      return new Blob([opts.dataText ?? ''], { type: opts.dataMime ?? 'text/plain' });
    case 'ico':
      return await renderIco(node, opts);
    case 'zip':
      return await renderZip(node, opts);
    case 'pptx':
      return await renderPptx(node, opts);
    // A [data-sequence] stage is checked FIRST for every motion format — a timed
    // composition is the most specific thing a render target can be. `opts.live`
    // still wins for webm/mp4, exactly as it does over the record/top-tail sniffs:
    // "Record live" means film the screen, not re-render the timeline. The compositor
    // is the better output (deterministic, faster than realtime, full quality) and
    // stays the DEFAULT, but a real-time take is the cheap route on a low-power
    // device, so it remains a deliberate opt-in — and renderLive drives the playhead
    // itself for a sequence stage (see driveSequenceTime there), because nothing
    // else moves it and the take would otherwise be one held frame.
    case 'webm':
      if (!opts.live && isSequenceStage(node)) return await renderSequenceStage(node, 'webm', opts);
      return await (opts.live ? renderLive(node, opts, 'webm')
        : isRecordStage(node) ? renderRecord(node, opts, 'webm')
        : isTopTailStage(node) ? renderTopTail(node, opts, 'webm') : renderVideo(node, opts, 'webm'));
    case 'mp4':
      if (!opts.live && isSequenceStage(node)) return await renderSequenceStage(node, 'mp4', opts);
      return await (opts.live ? renderLive(node, opts, 'mp4')
        : isRecordStage(node) ? renderRecord(node, opts, 'mp4')
        : isTopTailStage(node) ? renderTopTail(node, opts, 'mp4') : renderVideo(node, opts, 'mp4'));
    case 'gif':
      if (isSequenceStage(node)) return await renderSequenceStage(node, 'gif', opts);
      return await renderGif(node, opts);
    case 'apng':
      if (isSequenceStage(node)) return await renderSequenceStage(node, 'apng', opts);
      return await renderApng(node, opts);
    case 'webp-anim':
      return await renderWebpAnim(node, opts);
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}

// Embed the Lolly pixel watermark into a canvas in place (straight sRGB RGBA;
// canvas 2D getImageData is un-premultiplied). No-op contract lives in the
// engine — flat/tiny buffers return unchanged. See engine/src/pixel-watermark.ts.
// `strength` lets a LOSSLESS format (png/tiff) embed the gentler LOSSLESS_STRENGTH
// — it faces no quantization, so a subtler mark still reads back with wide margin;
// lossy formats omit it and keep the JPEG-calibrated DEFAULT_STRENGTH.
function imprintCanvas(canvas: HTMLCanvasElement, strength?: number): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || canvas.width < 8 || canvas.height < 8) return;
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const marked = embedWatermark(id.data, { width: canvas.width, height: canvas.height, ...(strength !== undefined ? { strength } : {}) });
  id.data.set(marked);
  ctx.putImageData(id, 0, 0);
}

// Brand primary hexes to boost, pulled from the live palette threaded in opts.
// Engine stays brand-agnostic — it never derives these. (White is added by
// hdrBoostToPQ itself so white text glows even when the palette omits it.)
function hdrTargets(opts: ExportOpts): string[] {
  const out: string[] = [];
  for (const p of (opts.palette ?? []) as Array<{ hex?: string }>) {
    if (p.hex && /^#?[0-9a-fA-F]{3,8}$/.test(p.hex)) out.push(p.hex);
  }
  return out;
}

// HDR-transform a canvas in place: engine hdrBoostToPQ rewrites the pixels to
// Rec.2100-PQ code values, boosting brand-colour matches toward peak luminance.
// Pairs with the pqBt2020IccProfile ICC (jpeg) / cICP chunk (png) stamped after.
function hdrCanvas(canvas: HTMLCanvasElement, opts: ExportOpts): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || canvas.width < 1 || canvas.height < 1) return;
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  hdrBoostToPQ(id.data, { targets: hdrTargets(opts), ...hdrTune(opts) });
  ctx.putImageData(id, 0, 0);
}

// Map the author's 0–100 dials (export-panel sliders / tuned `hdr=` value) onto
// the engine's hdrBoostToPQ knobs. `reach` slides the OKLab-lightness knee (higher
// = the glow reaches further down into mid/dark tones); `lift` is the dark-colour
// boost floor; `richness` is the re-saturation. Any dial left undefined falls
// through to the engine default (so a plain `hdr=1` looks exactly as before).
function hdrTune(opts: ExportOpts): Partial<HdrBoostOptions> {
  const t: Partial<HdrBoostOptions> = {};
  if (opts.hdrPeakNits != null) t.peakNits = opts.hdrPeakNits;
  if (opts.hdrReach != null) {
    const r = Math.min(1, Math.max(0, opts.hdrReach / 100));
    const center = 0.65 - 0.45 * r;               // r=0 → 0.65 (brights only); r=1 → 0.20 (almost all)
    t.kneeLo = Math.max(0, center - 0.12);
    t.kneeHi = Math.min(1, center + 0.12);
  }
  if (opts.hdrLift != null) t.boostFloor = Math.min(1, Math.max(0, opts.hdrLift / 100));
  if (opts.hdrRichness != null) t.richness = Math.min(1, Math.max(0, opts.hdrRichness / 100));
  return t;
}

// Imprint a LOLLY-RENDERED raster that's about to be baked into a container (a
// PDF page, a PPTX slide, an SVG <image>). Two extra gates over the standalone
// raster encoders: (1) `imprint.want` — the caller only threads a want-set sink
// for opts.imprint AND a Lolly-own render, never a passed-through user image
// (those call sites omit the sink → undefined); and (2) canCarryWatermark — an
// embed chokepoint sees many small decorative rasters (gradient chips, icons), so
// anything below the ~240px detection floor is skipped as wasted work. NEVER call
// this on a user's own embedded photo/logo bytes.
//
// SINGLE writer of ImprintState.applied: the flag flips true here, and only here,
// the moment a mark is genuinely embedded — so stampC2pa can never claim an
// imprint a render didn't actually apply (a pure-vector page keeps applied=false).
export function imprintEmbedCanvas(canvas: HTMLCanvasElement, imprint: ImprintState | undefined): void {
  if (imprint?.want && canCarryWatermark(canvas.width, canvas.height)) {
    imprintCanvas(canvas);
    imprint.applied = true;
  }
}

// Neural DURABLE embed for a standalone raster canvas — the async, opt-in
// counterpart to the sync imprintCanvas. Lazy-imports the encoder runner so ORT
// + the ~tens-of-MB model stay out of the boot budget. Best-effort: a no-op
// (pixels untouched) when opts.durable is off, or the encoder model isn't
// installed / the encode faults. Container chokepoints (PDF/PPTX raster) stay
// imprint-only for now — folding an async neural pass into the SYNC
// imprintEmbedCanvas is future work (see plans/durable-content-credentials.md).
async function durableEmbedCanvas(canvas: HTMLCanvasElement, opts: ExportOpts): Promise<void> {
  if (!opts.durable) return;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const { embedLollyDurable } = await import('../lib/trustmark-embed.ts');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const marked = await embedLollyDurable(id.data, canvas.width, canvas.height, { reservedId: opts.durableId });
    if (marked) { id.data.set(marked); ctx.putImageData(id, 0, 0); }
  } catch { /* best-effort; never break an export over the durable pass */ }
}

// Default JPEG encode quality. The browser default (0.92) leaves visible ringing
// around text and hard edges; 0.97 clears it for a modest size increase.
const JPEG_QUALITY = 0.97;

async function renderRaster(node: Element, format: string, opts: ExportOpts): Promise<Blob> {
  const lib = await getDomToImage();
  const d = exportDims(node, opts);
  const dtoOpts = rasterStyle(d, opts);
  // Mutate blob: URLs to data URLs on the live node so dom-to-image-more can
  // serialise them inside the SVG foreignObject. Restore immediately after so
  // the canvas stays clean. The live node MUST be passed (not a clone) so that
  // dom-to-image reads computed styles from elements that are in the document.
  const restore = await swapBlobUrls(node);
  // Deterministic base frame (t=0) for a frame-clock tool, so a still of an
  // animating canvas captures the configured pose, not a random rAF moment.
  const fc = beginFrameClock(node); renderFrameAt(fc, 0);
  try {
    // HDR (opt-in, ?hdr=): PQ-encode the pixels + tag the container Rec.2100-PQ.
    // Needs canvas pixels, so it forces the canvas path (like imprint/durable).
    const hdrOn = !!opts.hdr && (format === 'png' || format === 'jpeg');
    let blob: Blob;
    if (opts.imprint || opts.durable || hdrOn) {
      // Pixel-watermark path: rasterise to a canvas so we can perturb the pixels
      // before encoding, then encode with the same quality the dataURL path uses.
      // Also the durable-embed path, which likewise needs canvas pixels.
      const raw = await lib.toCanvas(node, dtoOpts);
      const canvas = normalizeCanvas(raw, dtoOpts.width, dtoOpts.height);
      // HDR first: the PQ transform is the base encoding, so any provenance mark
      // below lands in the final (PQ) pixel space and embed/detect stay consistent.
      if (hdrOn) hdrCanvas(canvas, opts);
      // png is lossless → the gentler LOSSLESS_STRENGTH; jpeg keeps the
      // quantization-calibrated DEFAULT_STRENGTH (undefined ⇒ engine default).
      if (opts.imprint) imprintCanvas(canvas, format === 'png' ? LOSSLESS_STRENGTH : undefined);
      await durableEmbedCanvas(canvas, opts);
      blob = await canvasToBlob(canvas, format === 'jpeg' ? 'image/jpeg' : 'image/png', format === 'jpeg' ? (opts.quality ?? JPEG_QUALITY) : undefined);
    } else {
      const dataUrl = await (format === 'jpeg'
        ? lib.toJpeg(node, { quality: opts.quality ?? JPEG_QUALITY, ...dtoOpts })
        : lib.toPng(node, dtoOpts));
      const res = await fetch(dataUrl);
      blob = await res.blob();
    }
    // Stamp the DPI (physical size) + provenance metadata + colour profile in a
    // SINGLE parse/serialise cycle: read the encoded bytes once, splice every
    // chunk/segment in order, rebuild the Blob once. (Each stamp was previously
    // its own arrayBuffer()→Blob round-trip — three full multi-MB copies for a
    // high-DPI PNG.) Insertion order is preserved, so the output is byte-identical.
    // HDR overrides the colour profile with Rec.2100 PQ (its cicp tag is the HDR
    // signal); PNG also gets a cICP chunk.
    const icc = hdrOn ? pqBt2020IccProfile() : (iccWanted(opts) ? iccProfileBytes(opts.colorProfile) : null);
    if (format === 'png' && (d.dpi > 0 || opts.meta || icc || hdrOn)) {
      let bytes = new Uint8Array(await blob.arrayBuffer());
      if (d.dpi > 0) bytes = (insertPngPhys(bytes, d.dpi) || bytes) as Uint8Array<ArrayBuffer>;
      bytes = insertPngMeta(bytes, opts.meta) as Uint8Array<ArrayBuffer>;
      if (hdrOn) bytes = insertPngCicp(bytes, HDR_PQ_CICP) as Uint8Array<ArrayBuffer>;
      if (icc) bytes = await insertPngIcc(bytes, icc, hdrOn ? 'Rec2100 PQ' : 'sRGB') as Uint8Array<ArrayBuffer>;
      blob = new Blob([bytes], { type: 'image/png' });
    } else if (format === 'jpeg' && (d.dpi > 0 || opts.meta || icc)) {
      let bytes = new Uint8Array(await blob.arrayBuffer());
      bytes = patchJpegDpi(bytes, d.dpi) as Uint8Array<ArrayBuffer>;
      bytes = insertJpegExif(bytes, opts.meta) as Uint8Array<ArrayBuffer>;
      if (icc) bytes = insertJpegIcc(bytes, icc) as Uint8Array<ArrayBuffer>;
      blob = new Blob([bytes], { type: 'image/jpeg' });
    }
    return blob;
  } finally {
    restore();
    endFrameClock(fc);
  }
}

// Promisified canvas.toBlob — quality is passed through only for lossy encoders.
function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error(`Encoding failed for ${mimeType}`)),
      mimeType,
      quality,
    );
  });
}

async function renderBitmap(node: Element, mimeType: string, opts: ExportOpts): Promise<Blob> {
  const lib = await getDomToImage();
  const d = exportDims(node, opts);
  const dtoOpts = rasterStyle(d, opts);
  const restore = await swapBlobUrls(node);
  const fc = beginFrameClock(node); renderFrameAt(fc, 0);
  let raw: HTMLCanvasElement;
  try {
    raw = await lib.toCanvas(node, dtoOpts);
  } finally {
    restore();
    endFrameClock(fc);
  }
  const canvas = normalizeCanvas(raw, dtoOpts.width, dtoOpts.height);
  // HDR (AVIF only here — AVIF signals HDR natively via its nclx colr box; WebP
  // has no working HDR decode path, so it's not offered). PQ-transform first, then
  // rewrite the encoded AVIF's colr box to Rec.2100 PQ.
  const hdrOn = !!opts.hdr && mimeType === 'image/avif';
  if (hdrOn) hdrCanvas(canvas, opts);
  if (opts.imprint) imprintCanvas(canvas);
  await durableEmbedCanvas(canvas, opts);
  const blob = await canvasToBlob(canvas, mimeType, opts.quality ?? 0.9);
  if (hdrOn) {
    // canvasToBlob may fall back to PNG where the browser can't encode AVIF;
    // setAvifCicp no-ops on non-AVIF bytes, so this is safe either way.
    const bytes = setAvifCicp(new Uint8Array(await blob.arrayBuffer()), HDR_PQ_CICP);
    return new Blob([bytes as BlobPart], { type: blob.type || mimeType });
  }
  return blob;
}

// ── RGB TIFF export (archival / lossless raster) ────────────────────────────
//
// A plain, uncompressed RGB TIFF at the requested DPI — the RGB sibling of the
// print DeviceCMYK TIFF, for archival and editor round-trips where a lossless,
// broadly-readable raster is wanted (browsers can't encode TIFF, so like the CMYK
// path the bytes are assembled by hand — here via the engine's packTiff). No print
// geometry / marks: this is a straight raster, not a press-ready separation. Any
// transparency is flattened onto white, since baseline TIFF carries no alpha here.
async function renderTiff(node: Element, opts: ExportOpts): Promise<Blob> {
  const lib = await getDomToImage();
  const d = exportDims(node, opts);
  const dtoOpts = rasterStyle(d, opts);
  const restore = await swapBlobUrls(node);
  let canvas: HTMLCanvasElement;
  try {
    const raw = await lib.toCanvas(node, dtoOpts);
    canvas = normalizeCanvas(raw, dtoOpts.width, dtoOpts.height);
  } finally {
    restore();
  }
  // Imprint before reading pixels back out, so the mark is in the bytes packTiff
  // serialises. Uncompressed TIFF is lossless — unlike JPEG/AVIF this is a
  // straight round-trip of exactly what embedWatermark wrote, no re-encode to
  // survive.
  const hdrOn = !!opts.hdr;
  // HDR first (like renderRaster) so any mark lands in the final PQ pixel space.
  if (hdrOn) hdrCanvas(canvas, opts);
  if (opts.imprint) imprintCanvas(canvas, LOSSLESS_STRENGTH); // uncompressed TIFF is lossless
  await durableEmbedCanvas(canvas, opts);
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = ctx.getImageData(0, 0, W, H).data;       // sRGB, straight (un-premultiplied)
  // Flatten transparency onto white normally; onto BLACK for HDR — in PQ, white is
  // 10 000 nits, so a transparent edge flattened to white would blaze; black is 0 nits.
  const rgb = flattenRgb(rgba, hdrOn ? 0 : 255);
  const tiff = packTiff(rgb, {
    width: W, height: H, samplesPerPixel: 3, photometric: 2,
    dpi: d.dpi || CSS_DPI, meta: opts.meta, description: opts.meta?.description,
    // Rec.2100-PQ profile → HDR TIFF (its cicp tag signals the encoding).
    ...(hdrOn ? { icc: pqBt2020IccProfile() } : {}),
  });
  return new Blob([tiff as BlobPart], { type: 'image/tiff' });
}

// Straight (un-premultiplied) RGBA → packed RGB, compositing any transparency onto
// a solid sheet of `bg` (baseline TIFF has no alpha channel in this profile).
function flattenRgb(rgba: Uint8ClampedArray, bg = 255): Uint8Array {
  const px = rgba.length / 4;
  const out = new Uint8Array(px * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3]!;
    if (a === 255) {
      out[j] = rgba[i]!; out[j + 1] = rgba[i + 1]!; out[j + 2] = rgba[i + 2]!;
    } else {
      const t = a / 255, u = bg * (1 - t);
      out[j]     = (rgba[i]!     * t + u + 0.5) | 0;
      out[j + 1] = (rgba[i + 1]! * t + u + 0.5) | 0;
      out[j + 2] = (rgba[i + 2]! * t + u + 0.5) | 0;
    }
  }
  return out;
}

// ── DeviceCMYK TIFF export (print-ready) ────────────────────────────────────
//
// A print-grade CMYK TIFF, written by hand (no browser TIFF encoder exists; this
// is the same hand-rolled-binary approach used for PNG chunks / EXIF / ICC). The
// canvas is rasterised like the other raster formats, its sRGB pixels converted
// per-pixel to *device* CMYK via the engine's rgbToCmyk, except where a pixel's
// exact colour matches a brand-palette entry (buildCmykPaletteMap, shared with the
// CMYK PDF path) — then the swatch's locked CMYK (or, for a spot-locked swatch,
// its CMYK equivalent) is used instead of the naive conversion. A single flat
// raster has no per-plate channel for a named ink, so a spot lock only ever
// contributes its CMYK equivalent here — true Separation output is a PDF-only
// capability (see renderCmykPdf); this is a deliberate scope limit, not a bug.
// Stored uncompressed in a single strip.
//
// Print finishing mirrors the Print PDF, on the same engine geometry
// (computePrintGeometry): when bleed/marks are requested the design is stretched to
// COVER the bleed box on an enlarged white sheet, and the crop / bleed / registration
// marks + colour bar are rasterised straight into the CMYK buffer AFTER the
// conversion — so the line marks land on every plate (C=M=Y=K=255, the raster
// analogue of the PDF's 1 1 1 1 registration ink) instead of being remapped by the
// naive per-pixel pass. The bar itself stays the generic process/overprint/tint
// control strip (unlike the PDF path, the verification pairing isn't rebuilt here).
//
// Deliberately untagged DeviceCMYK: there is NO embedded output profile (a real
// profile over the naive conversion would mislabel the file). The chosen press
// condition is recorded only as provenance in ImageDescription — naming the intended
// viewing condition without claiming colour management. A colour-managed variant
// (real ICC separation + embedded press profile) is a separate, heavier project —
// see cmykTiffSupport, which keeps the format off environments where it can't be
// produced or delivered.
async function renderCmykTiff(node: Element, opts: ExportOpts): Promise<Blob> {
  const lib = await getDomToImage();
  const d = exportDims(node, opts);
  const paletteMap = buildCmykPaletteMap(opts.palette ?? []);
  // Print finishing geometry — same engine source of truth as the PDF path. Still
  // pass no palette here: the verification bar's brand pairing is rebuilt from the
  // PDF path's `usedKeys` (an exact-substitution audit trail this per-pixel pass
  // doesn't produce), so it stays the generic process/overprint/tint control strip.
  const geo = printGeometry(node, opts, []);
  const ptPx  = (v: number) => Math.round(v * d.dpi / 72);        // points → device px (offset)
  const ptDim = (v: number) => Math.max(1, ptPx(v));              // points → device px (size)

  const restore = await swapBlobUrls(node);
  let artCanvas: HTMLCanvasElement;
  try {
    // With geometry the design is stretched to COVER the bleed box (mirrors the
    // PDF's scale-to-bleed); without it, the plain trim-size raster as before.
    const dtoOpts = geo
      ? coverRasterStyle(d, opts, ptDim(geo.artwork.w), ptDim(geo.artwork.h))
      : rasterStyle(d, opts);
    const raw = await lib.toCanvas(node, dtoOpts);
    artCanvas = normalizeCanvas(raw, dtoOpts.width, dtoOpts.height);
  } finally {
    restore();
  }

  // Compose the artwork onto the full white sheet (print stock) when there's a margin.
  let canvas = artCanvas;
  if (geo) {
    const sheet = document.createElement('canvas');
    sheet.width  = ptDim(geo.page.w);
    sheet.height = ptDim(geo.page.h);
    const sctx = sheet.getContext('2d', { willReadFrequently: true })!;
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, sheet.width, sheet.height);
    sctx.drawImage(artCanvas, ptPx(geo.artwork.x), ptPx(geo.artwork.y), ptDim(geo.artwork.w), ptDim(geo.artwork.h));
    canvas = sheet;
  }

  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = ctx.getImageData(0, 0, W, H).data;   // sRGB, straight (un-premultiplied)
  const cmyk = await rgbaToDeviceCmyk(rgba, W, H, paletteMap, opts.onProgress);

  // Marks drawn AFTER conversion → registration/crop/bleed land on every plate;
  // provenance credit text is composited as K-only ink (see drawPrintMarksCmyk).
  if (geo) drawPrintMarksCmyk(cmyk, W, H, geo, d.dpi, provenanceLabels(opts.meta));

  const tiff = encodeCmykTiff(cmyk, W, H, d.dpi, opts.meta, await pressConditionLabel(opts.colorProfile));
  return new Blob([tiff as BlobPart], { type: 'image/tiff' });
}

// RGBA (0–255, sRGB) → packed CMYK bytes (0=no ink … 255=full ink), one tight
// numeric pass over the typed array. Transparency is flattened onto white (CMYK
// has no alpha channel and print stock is white). ~tens of ms for 1080², but a
// large print-DPI sheet runs long on the main thread, so the pass yields to the
// event loop every YIELD_ROWS scanlines (keeping the tab responsive) and reports
// row progress through opts.onProgress. paletteMap (built once by the caller from
// opts.palette, same as the CMYK PDF path) is consulted per pixel for an exact
// brand-swatch match before falling back to the naive conversion — an empty map
// (the common case, no locks configured) skips the lookup entirely so the hot
// loop's arithmetic is otherwise unchanged.
const YIELD_ROWS = 256;
async function rgbaToDeviceCmyk(
  rgba: Uint8ClampedArray, W: number, H: number,
  paletteMap: Map<string, PaletteHit>,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const out = new Uint8Array(W * H * 4);
  const hasPalette = paletteMap.size > 0;
  for (let row = 0; row < H; row++) {
    const base = row * W * 4;
    for (let i = base, end = base + W * 4; i < end; i += 4) {
      const a = rgba[i + 3]!;
      let r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
      if (a < 255) {                                 // composite over white
        const t = a / 255, u = 255 * (1 - t);
        r = r * t + u; g = g * t + u; b = b * t + u;
      }
      const rf = r / 255, gf = g / 255, bf = b / 255;
      const hit = hasPalette ? paletteMap.get(cmykKey(rf, gf, bf)) : undefined;
      const [c, m, y, k] = hit ? hit.cmyk : rgbToCmyk(rf, gf, bf);
      out[i]     = (c * 255 + 0.5) | 0;
      out[i + 1] = (m * 255 + 0.5) | 0;
      out[i + 2] = (y * 255 + 0.5) | 0;
      out[i + 3] = (k * 255 + 0.5) | 0;
    }
    if ((row + 1) % YIELD_ROWS === 0 && row + 1 < H) {
      onProgress?.(row + 1, H);
      await new Promise<void>((r) => setTimeout(r));         // unblock the UI thread
    }
  }
  onProgress?.(H, H);
  return out;
}

interface TiffEntry { tag: number; type: number; count: number; n?: number; data?: Uint8Array; offset?: number; }

// Assemble a baseline little-endian CMYK TIFF: 8-byte header → IFD → out-of-line
// values → one uncompressed strip. Entries are gathered, then sorted by tag (a
// TIFF requirement) with ≤4-byte values inlined and larger ones placed after the
// IFD. Mirrors buildExifTiff, scaled up to a full image + provenance + DPI.
function encodeCmykTiff(
  cmyk: Uint8Array, W: number, H: number, dpi: number,
  meta: ExportMeta | null | undefined, condition: string | null,
): Uint8Array {
  const enc = new TextEncoder();
  const SHORT = 3, LONG = 4, RATIONAL = 5, ASCII = 2;
  const TYPE_SIZE: Record<number, number> = { 2: 1, 3: 2, 4: 4, 5: 8 };
  const entries: TiffEntry[] = [];
  const num   = (tag: number, type: number, n: number) => entries.push({ tag, type, count: 1, n });
  const asciiTag = (tag: number, s: unknown) => { if (s) { const a = enc.encode(String(s)); const d = new Uint8Array(a.length + 1); d.set(a, 0); entries.push({ tag, type: ASCII, count: d.length, data: d }); } };

  const bps = new Uint8Array(8); { const dv = new DataView(bps.buffer); for (let i = 0; i < 4; i++) dv.setUint16(i * 2, 8, true); }
  const rational = (n2: number, den: number) => { const d = new Uint8Array(8); const dv = new DataView(d.buffer); dv.setUint32(0, n2, true); dv.setUint32(4, den, true); return d; };
  const res = Math.max(1, Math.round(dpi || 72));

  num(256, LONG, W);                                  // ImageWidth
  num(257, LONG, H);                                  // ImageLength
  entries.push({ tag: 258, type: SHORT, count: 4, data: bps }); // BitsPerSample [8,8,8,8]
  num(259, SHORT, 1);                                 // Compression: none
  num(262, SHORT, 5);                                 // PhotometricInterpretation: Separated (CMYK)
  asciiTag(270, [meta?.description, condition].filter(Boolean).join(' · ')); // ImageDescription (+ press condition)
  num(273, LONG, 0);                                  // StripOffsets — patched after layout
  num(277, SHORT, 4);                                 // SamplesPerPixel
  num(278, LONG, H);                                  // RowsPerStrip (single strip)
  num(279, LONG, W * H * 4);                          // StripByteCounts
  entries.push({ tag: 282, type: RATIONAL, count: 1, data: rational(res, 1) }); // XResolution
  entries.push({ tag: 283, type: RATIONAL, count: 1, data: rational(res, 1) }); // YResolution
  num(296, SHORT, 2);                                 // ResolutionUnit: inch
  asciiTag(305, meta?.software);                      // Software
  asciiTag(315, meta?.author);                        // Artist
  num(332, SHORT, 1);                                 // InkSet: CMYK

  entries.sort((a, b) => a.tag - b.tag);

  const N = entries.length;
  const ifdStart = 8;
  let ext = ifdStart + 2 + N * 12 + 4;                // out-of-line region start
  for (const e of entries) {
    const bytes = e.data ? e.data.length : e.count * TYPE_SIZE[e.type]!;
    if (bytes > 4) { e.offset = ext; ext += bytes + (bytes & 1); } // keep word alignment
  }
  const stripOffset = ext + (ext & 1);
  entries.find(e => e.tag === 273)!.n = stripOffset;   // patch StripOffsets

  const out = new Uint8Array(stripOffset + W * H * 4);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49;                       // "II" little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdStart, true);
  dv.setUint16(ifdStart, N, true);
  let o = ifdStart + 2;
  for (const e of entries) {
    dv.setUint16(o, e.tag, true);
    dv.setUint16(o + 2, e.type, true);
    dv.setUint32(o + 4, e.count, true);
    const bytes = e.data ? e.data.length : e.count * TYPE_SIZE[e.type]!;
    if (bytes > 4) { dv.setUint32(o + 8, e.offset!, true); out.set(e.data!, e.offset!); }
    else if (e.data) out.set(e.data, o + 8);          // small inline value (e.g. short ASCII)
    else if (e.type === SHORT) dv.setUint16(o + 8, e.n!, true);
    else dv.setUint32(o + 8, e.n!, true);
    o += 12;
  }
  dv.setUint32(o, 0, true);                           // next IFD: none
  out.set(cmyk, stripOffset);
  return out;
}

// Rasterise the print marks (crop / bleed / registration / colour bar) straight
// into the DeviceCMYK byte buffer, AFTER the RGB→CMYK conversion — so the line
// marks land on all four plates (C=M=Y=K=255, the raster analogue of the PDF's
// 1 1 1 1 registration ink) instead of being remapped by the naive per-pixel pass.
// Engine geometry is points, top-left origin; convert to device pixels at dpi. All
// crop/bleed/registration lines are axis-aligned (each a filled hairline bar); the
// registration target is a stroked ring; colour-bar cells are filled rectangles in
// their own DeviceCMYK value. `labels` (optional) maps each engine label slot → its
// provenance string; those are shaped by the browser and composited as K-only ink.
function drawPrintMarksCmyk(
  cmyk: Uint8Array, W: number, H: number, geo: PrintGeometry, dpi: number,
  labels: LabelsRecord | null,
): void {
  const pt = (v: number) => v * dpi / 72;
  const REG: [number, number, number, number] = [255, 255, 255, 255]; // all plates (registration black)
  const stroke = Math.max(1, Math.round(pt(geo.strokeWeight)));

  const put = (x: number, y: number, ink: number[]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    cmyk[o] = ink[0]!; cmyk[o + 1] = ink[1]!; cmyk[o + 2] = ink[2]!; cmyk[o + 3] = ink[3]!;
  };
  const fill = (x0: number, y0: number, w: number, h: number, ink: number[]) => {
    const xs = Math.round(x0), ys = Math.round(y0);
    const xe = Math.round(x0 + w), ye = Math.round(y0 + h);
    for (let y = ys; y < ye; y++) for (let x = xs; x < xe; x++) put(x, y, ink);
  };

  for (const ln of geo.primitives.lines) {
    const x1 = pt(ln.x1), y1 = pt(ln.y1), x2 = pt(ln.x2), y2 = pt(ln.y2);
    if (Math.abs(x1 - x2) < 0.5) fill(x1 - stroke / 2, Math.min(y1, y2), stroke, Math.abs(y2 - y1), REG); // vertical
    else fill(Math.min(x1, x2), y1 - stroke / 2, Math.abs(x2 - x1), stroke, REG);                          // horizontal
  }

  for (const c of geo.primitives.circles) {
    const cx = pt(c.cx), cy = pt(c.cy), r = pt(c.r), half = stroke / 2;
    const x0 = Math.floor(cx - r - half), x1 = Math.ceil(cx + r + half);
    const y0 = Math.floor(cy - r - half), y1 = Math.ceil(cy + r + half);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r) <= half) put(x, y, REG);
    }
  }

  for (const b of geo.primitives.bars) {
    const ink = b.cmyk.map(v => Math.round(v * 255));
    fill(pt(b.x), pt(b.y), pt(b.w), pt(b.h), ink);
  }

  // Provenance credit text — only the anchors the caller supplied a string for.
  // The browser shapes the glyphs on an offscreen canvas (Helvetica, mirroring the
  // PDF path), then each covered pixel is composited as 70% K ink — the raster
  // analogue of the PDF's cmyk(0,0,0,0.7) — so the credits sit on the black plate
  // only, not as registration. Engine coords are points, top-left origin (same as
  // the canvas) so there's no y-flip; rotation is CCW-positive, hence the negation.
  const slots = (geo.primitives.labels ?? []).filter(l => labels?.[l.slot]);
  if (slots.length) {
    // Stamp the credits onto a canvas no bigger than the labels' union bounding
    // box, not the full W×H sheet — the old path allocated an image-sized canvas
    // and ran a second whole-image getImageData + per-pixel loop just to composite
    // a few glyphs. The bbox is padded generously (ascent/descent + side overhang,
    // rotation-aware) so no covered pixel is ever clipped → byte-identical output.
    const measure = document.createElement('canvas').getContext('2d')!;
    measure.textBaseline = 'alphabetic';
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of slots) {
      const size = pt(l.size);
      measure.font = `${size}px Helvetica, Arial, sans-serif`;
      const tw = measure.measureText(labels![l.slot]!).width;
      const baseX = (l.align === 'right') ? -tw : 0;     // fillText anchor offset
      const lx0 = baseX - size * 0.3, lx1 = baseX + tw + size * 0.3;
      const ly0 = -size * 1.3,        ly1 = size * 0.5;  // generous ascent/descent
      const theta = l.rotation ? -l.rotation * Math.PI / 180 : 0;
      const cos = Math.cos(theta), sin = Math.sin(theta);
      const ax = pt(l.x), ay = pt(l.y);
      for (const [lx, ly] of [[lx0, ly0], [lx1, ly0], [lx1, ly1], [lx0, ly1]] as [number, number][]) {
        const gx = ax + lx * cos - ly * sin;
        const gy = ay + lx * sin + ly * cos;
        if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
        if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
      }
    }
    const bx0 = Math.max(0, Math.floor(minX)), by0 = Math.max(0, Math.floor(minY));
    const bx1 = Math.min(W, Math.ceil(maxX)),  by1 = Math.min(H, Math.ceil(maxY));
    const bw = bx1 - bx0, bh = by1 - by0;
    if (bw > 0 && bh > 0) {
      const tcanvas = document.createElement('canvas');
      tcanvas.width = bw; tcanvas.height = bh;
      const tctx = tcanvas.getContext('2d', { willReadFrequently: true })!;
      tctx.fillStyle = '#000';
      tctx.textBaseline = 'alphabetic';
      tctx.translate(-bx0, -by0);                        // draw in absolute device px
      for (const l of slots) {
        tctx.save();
        tctx.translate(pt(l.x), pt(l.y));
        if (l.rotation) tctx.rotate(-l.rotation * Math.PI / 180);
        tctx.textAlign = l.align === 'right' ? 'right' : 'left';
        tctx.font = `${pt(l.size)}px Helvetica, Arial, sans-serif`;
        tctx.fillText(labels![l.slot]!, 0, 0);
        tctx.restore();
      }
      const tpx = tctx.getImageData(0, 0, bw, bh).data;
      for (let ry = 0; ry < bh; ry++) {
        let p = ry * bw * 4 + 3;                         // alpha byte, region row ry
        let o = ((by0 + ry) * W + bx0) * 4;              // matching sheet pixel
        for (let rx = 0; rx < bw; rx++, p += 4, o += 4) {
          const t = (tpx[p]! / 255) * 0.7;                // glyph coverage → 70% K ink
          if (!t) continue;
          cmyk[o]     = (cmyk[o]!     * (1 - t) + 0.5) | 0;
          cmyk[o + 1] = (cmyk[o + 1]! * (1 - t) + 0.5) | 0;
          cmyk[o + 2] = (cmyk[o + 2]! * (1 - t) + 0.5) | 0;
          cmyk[o + 3] = (cmyk[o + 3]! * (1 - t) + 255 * t + 0.5) | 0;
        }
      }
    }
  }
}

// The human-readable press condition recorded as TIFF provenance (ImageDescription).
// Mirrors the PDF OutputIntent's purpose — naming the condition the DeviceCMYK values
// target — but as metadata only: the pixels stay untagged (no embedded profile), so
// the file is never mislabelled. 'none' opts out; anything else resolves via the
// engine registry (unknown / 'srgb' fall back to the default condition).
//
// 'own' (the user's own profile, the PDF's embed route) must NOT reach
// cmykCondition: it would silently fall back to the DEFAULT condition and write
// "Coated FOGRA39" into a TIFF made for a different press. A TIFF cannot embed a
// profile, so the label is the profile's own description — and when that profile
// cannot be resolved, no label at all rather than a wrong one.
async function pressConditionLabel(profile: string | undefined): Promise<string | null> {
  if (profile === 'none') return null;
  if (isOwnProfile(profile)) {
    const embed = await embeddedProfile(profile);
    return embed ? (embed.pairedCondition ? embed.info : embed.desc) : null;
  }
  return cmykCondition(profile).info;
}

// Can this environment both PRODUCE and DELIVER a DeviceCMYK TIFF? Memoised.
// dom-to-image options: render the node at its native CSS size then scale it up
// (via CSS transform) to the target output resolution. The target is the
// requested dimension converted to pixels at the chosen DPI; if none was
// requested we fall back to the canvas at its default 2× scale.
function rasterStyle(d: ExportDims, opts: ExportOpts): DtoRenderOpts {
  const requested = (opts.width != null && opts.width !== '') || (opts.height != null && opts.height !== '');
  const scale = opts.scale ?? 2;
  const targetW = requested ? toPixels(d.w, d.dpi) : Math.round(d.node.w * scale);
  const targetH = requested ? toPixels(d.h, d.dpi) : Math.round(d.node.h * scale);
  const renderScale = targetW / d.node.w;
  const result: DtoRenderOpts = {
    width: targetW,
    height: targetH,
    style: {
      transform: `scale(${renderScale})`,
      transformOrigin: 'top left',
      width: `${d.node.w}px`,
      height: `${d.node.h}px`,
    },
  };
  if (opts.background === 'transparent') {
    result.style.background = 'transparent';
  } else if (opts.background != null) {
    result.bgcolor = opts.background;
  }
  return result;
}

// dom-to-image options that stretch the node to exactly cover a target pixel box
// (the bleed box) — non-uniform scale, matching the PDF's scale-to-bleed. Used by
// the print-finished CMYK TIFF; any transparency is flattened onto the white sheet
// by the CMYK pass, so the background is immaterial here.
function coverRasterStyle(d: ExportDims, opts: ExportOpts, targetW: number, targetH: number): DtoRenderOpts {
  const result: DtoRenderOpts = {
    width: targetW,
    height: targetH,
    style: {
      transform: `scale(${targetW / d.node.w}, ${targetH / d.node.h})`,
      transformOrigin: 'top left',
      width: `${d.node.w}px`,
      height: `${d.node.h}px`,
    },
  };
  if (opts.background === 'transparent') result.style.background = 'transparent';
  else if (opts.background != null) result.bgcolor = opts.background;
  return result;
}


// Remove comment nodes from a subtree. A tool's template.html comments serialise
// verbatim into its SVG export as pure dead weight — e.g. filter-duotone's ~674 KB
// commented-out declarative fallback <image>. Comments never render, so strip them
// from every clone we serialise to SVG. Works on detached nodes (the export clones).
export function stripCommentNodes(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) c.parentNode?.removeChild(c);
}

async function renderSvg(node: Element, opts: ExportOpts = {}): Promise<Blob> {
  if (!isSvgRooted(node)) return renderSvgFromHtml(node, opts);
  const svg = node.tagName?.toLowerCase() === 'svg' ? node : node.querySelector('svg');
  const clone = svg!.cloneNode(true) as Element;
  stripCommentNodes(clone);
  // The clone leaves the canvas, so any rule scopeTemplateStyles pinned under the
  // canvas selector has to be released or it matches nothing in the standalone file.
  unscopeStyleEls(clone);
  // The clone is otherwise a VERBATIM copy of the tool's live <svg>, keeping its
  // <text> runs as live text — a violation of the "vector output always outlines
  // text" rule, and a real bug on guest brands: community SVG tools (chart-creator,
  // d3) style text via an internal `font-family: var(--font-brand, 'SUSE', …)` rule,
  // so a standalone file (where --font-brand is undefined) renders in the SUSE
  // fallback, selectable, in the wrong font. Outline the runs into <path> shaped in
  // the run's computed (brand-resolved) font before serialising.
  await outlineSvgTextRuns(svg!, clone, opts.convertPaths !== false);
  // Apply the requested size in its native unit (e.g. "210mm") — SVG is
  // resolution-independent. Ensure a viewBox so the original coordinates scale
  // into the new physical size.
  const d = exportDims(node, opts);
  if (parseDimension(opts.width) || parseDimension(opts.height)) {
    if (!clone.getAttribute('viewBox')) {
      const ow = svg!.getBoundingClientRect();
      clone.setAttribute('viewBox', `0 0 ${ow.width || d.node.w} ${ow.height || d.node.h}`);
    }
    clone.setAttribute('width', toCssLength(d.w));
    clone.setAttribute('height', toCssLength(d.h));
  }
  await inlineBlobUrlsInEl(clone);
  const xml = injectSvgMeta(new XMLSerializer().serializeToString(clone), opts.meta);
  return new Blob(['<?xml version="1.0" standalone="no"?>\n' + xml], { type: 'image/svg+xml' });
}

// Convert the <text> runs of a tool's own <svg> (the renderSvg fast-path clone) into
// outlined <path>s, so an exported SVG renders identically without the authoring
// machine's fonts — the same guarantee the HTML path (emitInlineTextSvg) already gives.
//
// Styles are read from the LIVE element (`liveSvg`, still connected during render): its
// computed `font-family` resolves the brand var — `var(--font-brand, 'SUSE', …)` becomes
// the actual brand stack (Outfit, or a user's Google font) — which resolveVectorFont then
// maps to a fetchable sfnt. The clone is a deep copy, so its <text> list is 1:1 with the
// live one in document order; we shape each run and swap the clone's node for a <path>.
//
// Runs we can't faithfully outline — a run with <tspan> children, an unresolvable/icon
// font, or one with a .notdef glyph — keep their <text>, but get the resolved family
// baked as an INLINE style (which beats the tool's internal <style> rule; a presentation
// attribute would not) so they never fall through to the 'SUSE' var fallback. When
// `outline` is false (the "Convert paths" toggle off) every run is left as editable text
// with only the family baked, honouring the user's request.
async function outlineSvgTextRuns(liveSvg: Element, clone: Element, outline: boolean): Promise<void> {
  const liveTexts = liveSvg.querySelectorAll('text');
  const cloneTexts = clone.querySelectorAll('text');
  // A deep clone keeps a 1:1, same-order <text> list; a mismatch means something
  // rewrote the tree between clone and now — leave it rather than mis-map runs.
  if (!liveTexts.length || liveTexts.length !== cloneTexts.length) return;
  const textApi = _host?.text;
  const NS = 'http://www.w3.org/2000/svg';
  const num = (v: string | null): number => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : 0; };
  const rel = (v: string | null, em: number): number => {
    const s = (v ?? '').trim(); if (!s) return 0;
    return s.endsWith('em') ? (parseFloat(s) || 0) * em : (parseFloat(s) || 0);
  };

  for (let i = 0; i < liveTexts.length; i++) {
    const live = liveTexts[i] as SVGTextElement;
    const cl = cloneTexts[i] as SVGElement;
    const cs = window.getComputedStyle(live);
    if (cs.display === 'none') continue;                         // hidden — leave as-is
    const raw = applyTextTransform((live.textContent ?? '').replace(/\s+/g, ' ').trim(), cs.textTransform);
    if (!raw) continue;

    // Bake the brand-resolved family inline so a KEPT <text> can't inherit the SUSE
    // var fallback. No-op cost on a run we go on to replace with a <path>.
    const bakeFamily = () => { cl.style.fontFamily = cs.fontFamily; };

    const simple = [...live.childNodes].every(n => n.nodeType === 3);   // no <tspan>
    if (!outline || !simple || !textApi) { bakeFamily(); continue; }

    const fontSizePx = parseFloat(cs.fontSize) || 16;
    const styleSlice = { fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle };
    let vf: VectorFont | null = null;
    try { vf = await resolveVectorFont(styleSlice, raw); } catch { vf = null; }
    if (!vf?.url) { bakeFamily(); continue; }

    const letterSpacing = letterSpacingPx(cs.letterSpacing);
    const features = featureSettingsToHb(cs.fontFeatureSettings);
    let d = '', adv = 0, notdef = 0;
    try {
      const r = await textApi.toPath({ text: raw, fontUrl: vf.url, fontSize: fontSizePx, features: features as string[], letterSpacing, variations: vf.variations, fallbackFonts: vf.fallbacks });
      d = r.d; adv = r.advanceWidth || 0; notdef = r.notdef ?? 0;
    } catch (e) {
      _host?.log?.('warn', `svg: SVG-text outline failed, keeping <text> — ${(e as Error).message}`);
    }
    if (!d || notdef) { bakeFamily(); continue; }

    // toPath places the baseline at y=0 with the pen starting at x=0. SVG's own `y`
    // IS the baseline for the default (auto/alphabetic) dominant-baseline; the other
    // values shift it by font metrics. `x` (+ dx) with text-anchor and the shaped
    // advance width give the left edge.
    const x = num(live.getAttribute('x')) + rel(live.getAttribute('dx'), fontSizePx);
    let y = num(live.getAttribute('y')) + rel(live.getAttribute('dy'), fontSizePx);
    const db = live.getAttribute('dominant-baseline') || cs.dominantBaseline || 'auto';
    if (db === 'middle' || db === 'central') {
      const { ascent, descent } = fontMetricsPx(cs, fontSizePx); y += (ascent - descent) / 2;
    } else if (db === 'hanging' || db === 'text-before-edge') {
      y += fontMetricsPx(cs, fontSizePx).ascent;
    } else if (db === 'text-after-edge' || db === 'ideographic') {
      y -= fontMetricsPx(cs, fontSizePx).descent;
    }
    if (adv <= 0) { try { adv = live.getComputedTextLength(); } catch { adv = 0; } }
    const anchor = live.getAttribute('text-anchor') || cs.textAnchor || 'start';
    const xAdj = anchor === 'middle' ? x - adv / 2 : anchor === 'end' ? x - adv : x;

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    const own = live.getAttribute('transform');
    path.setAttribute('transform', `${own ? own + ' ' : ''}translate(${n2(xAdj)},${n2(y)})`);
    path.setAttribute('fill', cs.fill || live.getAttribute('fill') || '#000');
    if (cs.fillOpacity && parseFloat(cs.fillOpacity) < 1) path.setAttribute('fill-opacity', cs.fillOpacity);
    if (cs.opacity && parseFloat(cs.opacity) < 1) path.setAttribute('opacity', cs.opacity);
    // Preserve text stroke/outline in vector export
    const stroke = cs.stroke || live.getAttribute('stroke');
    if (stroke) {
      path.setAttribute('stroke', stroke);
      const strokeWidth = cs.strokeWidth || live.getAttribute('stroke-width');
      if (strokeWidth) path.setAttribute('stroke-width', strokeWidth);
      const strokeOpacity = cs.strokeOpacity || live.getAttribute('stroke-opacity');
      if (strokeOpacity) path.setAttribute('stroke-opacity', strokeOpacity);
    }
    cl.replaceWith(path);
  }
}

// ── EMF (Enhanced Metafile) — vector, always text-as-paths ──────────────────
//
// EMF is a third sink on the SVG vector pipeline (alongside SVG and PDF): obtain
// an SVG whose text is already outlined — the tool's own <svg>, or an outlined
// SVG synthesised from an HTML layout via renderSvgFromHtml — walk it into the
// engine IR (svgDomToIr), and serialize to bytes (emitEmf). Device RGB only;
// gradients/images/alpha are flattened to solids upstream. See
// plans/emf-support.md. The text-as-paths guarantee is enforced in svgDomToIr,
// which throws on any run it can't vectorise rather than dropping it.
async function renderEmf(node: Element, opts: ExportOpts = {}): Promise<Blob> {
  let svgEl: Element | null = node.tagName?.toLowerCase() === 'svg' ? node : (node.querySelector?.('svg') ?? null);
  if (!svgEl) {
    // HTML-layout tool with no inline <svg>: synthesise an outlined SVG first.
    const svgBlob = await renderSvgFromHtml(node, { ...opts, convertPaths: true, noBoxShadow: true });
    const xml = await svgBlob.text();
    svgEl = new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement;
  }
  const ir = await svgDomToIr(svgEl, {
    host: _host,
    getComputedStyle: (el: Element) => window.getComputedStyle(el),
    background: opts.background,
  });
  const bytes = emitEmf(ir, { width: opts.width, height: opts.height, unit: opts.unit, dpi: opts.dpi });
  return new Blob([bytes as BlobPart], { type: 'image/emf' });
}

// EPS is a fourth sink on the SVG vector pipeline (alongside SVG, PDF, and EMF):
// same outlined-SVG → engine IR (svgDomToIr) walk, then serialised to PostScript
// text by emitEps. Device RGB (cmyk=false) or DeviceCMYK (cmyk=true): an exact
// brand-palette match (buildCmykPaletteMap, shared with the CMYK PDF/TIFF paths)
// substitutes its locked CMYK — a spot lock's CMYK equivalent, same as the CMYK
// TIFF path, since a true PostScript /Separation colourspace is out of scope for
// this pass (see renderCmykPdf for the PDF path, which does emit one) — else the
// naive conversion. No embedded output intent; gradients/images/alpha are
// flattened to solids upstream and text is outlined upstream, so the emitter
// ships no fonts.
async function renderEps(node: Element, opts: ExportOpts = {}, cmyk = false): Promise<Blob> {
  let svgEl: Element | null = node.tagName?.toLowerCase() === 'svg' ? node : (node.querySelector?.('svg') ?? null);
  if (!svgEl) {
    const svgBlob = await renderSvgFromHtml(node, { ...opts, convertPaths: true, noBoxShadow: true });
    const xml = await svgBlob.text();
    svgEl = new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement;
  }
  const ir = await svgDomToIr(svgEl, {
    host: _host,
    getComputedStyle: (el: Element) => window.getComputedStyle(el),
    background: opts.background,
    label: 'EPS',
  });
  const text = emitEps(ir, {
    width: opts.width, height: opts.height, unit: opts.unit, dpi: opts.dpi, cmyk,
    meta: opts.meta as { title?: string } | undefined,
    ...(cmyk ? { cmykPalette: buildCmykPaletteMap(opts.palette ?? []) } : {}),
  });
  return new Blob([text], { type: 'application/postscript' });
}

// DXF is a fifth sink on the SVG vector pipeline (alongside SVG, PDF, EMF, EPS):
// the same outlined-SVG → engine IR (svgDomToIr) walk, then serialised to an ASCII
// DXF R12 document by emitDxf — POLYLINE entities (béziers flattened) in millimetres
// for CAD / laser-cut / vinyl / CNC. Text is outlined upstream; gradients/alpha are
// flattened to solids upstream (colour lands as a nearest AutoCAD Color Index). DXF
// has no raster form, so any escape-hatch image prim is dropped — we surface that as
// a log warning rather than silently losing the effect.
async function renderDxf(node: Element, opts: ExportOpts = {}): Promise<Blob> {
  let svgEl: Element | null = node.tagName?.toLowerCase() === 'svg' ? node : (node.querySelector?.('svg') ?? null);
  if (!svgEl) {
    const svgBlob = await renderSvgFromHtml(node, { ...opts, convertPaths: true, noBoxShadow: true });
    const xml = await svgBlob.text();
    svgEl = new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement;
  }
  const ir = await svgDomToIr(svgEl, {
    host: _host,
    getComputedStyle: (el: Element) => window.getComputedStyle(el),
    background: opts.background,
    label: 'DXF',
  });
  const { text, droppedImages } = emitDxf(ir, { width: opts.width, height: opts.height, unit: opts.unit, dpi: opts.dpi });
  if (droppedImages > 0) {
    _host?.log?.('warn', `dxf: dropped ${droppedImages} rasterised region${droppedImages > 1 ? 's' : ''} (DXF is line-art only — use SVG/PDF to keep photographic or filtered content).`);
  }
  return new Blob([text], { type: 'image/vnd.dxf' });
}

// ── SVG from HTML DOM ─────────────────────────────────────────────────────
//
// Decomposes the live DOM into SVG primitives. Mirrors drawHtmlVectors (the
// PDF DOM walker) in structure; changes to one should be reflected in the other.
//
// Tools whose canvas IS an SVG element (lockup, qr-code) use the fast-path
// clone in renderSvg above. This path handles all HTML-DOM tools.

function isSvgRooted(node: Element): boolean {
  if (node.tagName?.toLowerCase() === 'svg') return true;
  for (const child of node.children) {
    const t = child.tagName.toLowerCase();
    if (t === 'style' || t === 'script') continue;
    return t === 'svg';
  }
  return false;
}


// Returns a short reason string when `el` uses CSS the vector walkers can't faithfully
// reproduce (they'd SILENTLY DROP it), so the caller rasterises the node's subtree and
// embeds it as an image instead. Returns null for everything the walkers DO handle —
// that null-by-default is what keeps normal vector output byte-identical to before.
// `vectorCaps` lets a caller declare features IT can emit natively: the SVG walker
// carries mix-blend-mode as a style and emits circle/ellipse/inset clips as <clipPath>
// shapes, so it keeps those vector rather than rasterising (PDF/EMF/EPS still raster).
/** `backdrop-filter: blur(6px)` → 6. Null for anything that is not a single blur():
 *  a chain like `blur(4px) saturate(1.3)` genuinely has no SVG equivalent, because
 *  the extra functions operate on the backdrop we can only approximate. */
export function parseBackdropBlurPx(bf: string): number | null {
  const m = /^\s*blur\(\s*([\d.]+)px\s*\)\s*$/i.exec(bf || '');
  const v = m ? parseFloat(m[1]!) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export function detectUnsupportedCss(el: Element, s: CSSStyleDeclaration, vectorCaps?: { blend?: boolean; clipBasicShapes?: boolean; dropShadow?: boolean; backdropBlur?: boolean; conic?: boolean }): string | null {
  const tag = el.tagName.toLowerCase();
  // <img> filters are already baked (bakeImageFilter); <svg> subtrees have their own
  // faithful/raster paths. Never rasterise those here.
  if (tag === 'img' || tag === 'svg') return null;

  // filter: a drop-shadow-only filter is kept vector by the SVG walker (feDropShadow),
  // so the caller declares that via vectorCaps.dropShadow; any other filter function has
  // no vector equivalent → rasterise.
  // Two vector routes for `filter`: drop-shadow(s) become real geometry, and every
  // other CSS filter function is spec-defined AS an SVG filter, so the chain is
  // emitted. Only a chain containing something with no SVG equivalent — a url()
  // reference, an unknown function — still rasterises.
  if (s.filter && s.filter !== 'none'
      && !(vectorCaps?.dropShadow && parseDropShadowFilter(s.filter))
      && !parseCssFilter(s.filter)) return `filter:${s.filter}`;
  const bf = s.backdropFilter || (s as { webkitBackdropFilter?: string }).webkitBackdropFilter;
  // A blur-only backdrop-filter IS expressible: duplicate the content already painted
  // behind the element, clip that duplicate to the element's own shape, and blur it.
  // The caller declares support via vectorCaps.backdropBlur — anything richer than a
  // single blur() (saturate, brightness, a filter chain) still has no vector form.
  if (bf && bf !== 'none' && !(vectorCaps?.backdropBlur && parseBackdropBlurPx(bf) !== null)) return `backdrop-filter:${bf}`;
  // mix-blend-mode: SVG can carry it natively; only raster where the walker can't.
  if (s.mixBlendMode && s.mixBlendMode !== 'normal' && !vectorCaps?.blend) return `mix-blend-mode:${s.mixBlendMode}`;

  const mask = s.maskImage || (s as { webkitMaskImage?: string }).webkitMaskImage
    || (s.mask && s.mask !== 'none' && s.mask !== 'match-source' ? s.mask : '');
  if (mask && mask !== 'none') return `mask:${mask}`;

  // clip-path: polygon() is always kept vector; circle()/ellipse()/inset() are kept only
  // where the caller emits them as a <clipPath> (vectorCaps.clipBasicShapes); url()/path()
  // are never vectorisable → rasterise. (border-radius circles on <img> handled elsewhere.)
  const cp = s.clipPath || (s as { webkitClipPath?: string }).webkitClipPath;
  if (cp && cp !== 'none') {
    const isPolygon = cp.indexOf('polygon(') === 0;
    const isBasicShape = isPolygon || /^(circle|ellipse|inset)\(/i.test(cp);
    if (!isPolygon && !(isBasicShape && vectorCaps?.clipBasicShapes)) return `clip-path:${cp}`;
  }

  // background-image: linear/radial gradients emit true SVG/PDF gradients; a SINGLE
  // non-tiling url() emits a real <image> (vector-first — keeps the box's text vector).
  // Only cases with no single-<image> equivalent rasterise: conic-gradient, a TILING
  // background (repeat at intrinsic/auto size), or MULTIPLE layered url() images.
  const bi = s.backgroundImage;
  if (bi && bi !== 'none') {
    // A conic gradient is drawn as a wedge fan when we can parse it — but ONLY by the
    // SVG walker. The PDF walker has no conic branch (its gradient path handles linear
    // and radial), and sampleGradientMidpoint returns null for a conic, so exempting it
    // there dropped the sweep entirely: a box with a transparent flat fill lost its
    // paint. So the exemption is scoped to the caller that can honour it.
    if (bi.includes('conic-gradient') && !(vectorCaps?.conic && parseConicGradient(bi, 100, 100))) return 'conic-gradient';
    if (bi.includes('url(')) {
      const multiple = (bi.match(/url\(/g) || []).length > 1;
      const rep = (s.backgroundRepeat || 'repeat').toLowerCase();
      const size = (s.backgroundSize || 'auto').toLowerCase();
      void size; void rep;
      // A tiling background is emitted as an SVG <pattern> now, so only MULTIPLE
      // layered url() images still have no single-element equivalent.
      if (multiple) return 'background-image:url()';
    }
  }

  // NB: skew / 3-D transforms are deliberately NOT rasterised here. dom-to-image
  // captures the node with a plain scale (its own transform is overwritten), so the
  // skew/3-D wouldn't be reproduced anyway — rasterising would only turn crisp vector
  // text into a bitmap for no gain. Leave those to the (axis-aligned) vector walk;
  // pure rotation is already reproduced upstream (SVG rotate / withPdfRotation).
  return null;
}

// CSS basic-shape / gradient / drop-shadow value parsing lives DOM-free in the engine
// (parseClipShape / parseRadialGradient / parseDropShadowFilter — engine/src/css-paint.ts),
// so the SVG and PDF walkers share one parser. This file keeps only the DOM assembly:
// turning that geometry into SVG elements (svgClipShapeEl / build*El) or jsPDF ops.

// Build the SVG shape element for a ClipShape, offset into root coords by (ox, oy).
function svgClipShapeEl(NS: string, shape: ClipShape, ox: number, oy: number): Element {
  if (shape.kind === 'circle') {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(n2(ox + shape.cx))); c.setAttribute('cy', String(n2(oy + shape.cy)));
    c.setAttribute('r', String(n2(shape.r)));
    return c;
  }
  if (shape.kind === 'ellipse') {
    const e = document.createElementNS(NS, 'ellipse');
    e.setAttribute('cx', String(n2(ox + shape.cx))); e.setAttribute('cy', String(n2(oy + shape.cy)));
    e.setAttribute('rx', String(n2(shape.rx))); e.setAttribute('ry', String(n2(shape.ry)));
    return e;
  }
  if (shape.kind === 'inset') {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(n2(ox + shape.x))); rect.setAttribute('y', String(n2(oy + shape.y)));
    rect.setAttribute('width', String(n2(shape.w))); rect.setAttribute('height', String(n2(shape.h)));
    if (shape.r > 0) { rect.setAttribute('rx', String(n2(shape.r))); rect.setAttribute('ry', String(n2(shape.r))); }
    return rect;
  }
  // `empty` never reaches here — callers return before drawing (a zero-area clip
  // paints nothing). Emitting a degenerate rect would be a silent 1px artefact,
  // so be explicit rather than letting it fall through to the polygon branch.
  if (shape.kind === 'empty') {
    const none = document.createElementNS(NS, 'rect');
    none.setAttribute('width', '0'); none.setAttribute('height', '0');
    return none;
  }
  const poly = document.createElementNS(NS, 'polygon');
  poly.setAttribute('points', shape.points.map((p: [number, number]) => `${n2(ox + p[0])},${n2(oy + p[1])}`).join(' '));
  return poly;
}

// The rotation pivot (transform-origin) of `el` in the walker's root-relative
// coordinate space, measured from the element's UNROTATED border box. Call while
// the element's rotation is neutralised so `unrotRect` is the axis-aligned box.
function rotationPivot(
  style: CSSStyleDeclaration,
  unrotRect: { left: number; top: number },
  rootRect: { left: number; top: number },
): { x: number; y: number } {
  const o = (style.transformOrigin || '50% 50%').split(' ').map(parseFloat);
  return {
    x: (unrotRect.left - rootRect.left) + (o[0] || 0),
    y: (unrotRect.top - rootRect.top) + (o[1] || 0),
  };
}

// The first url(...) in a CSS value (e.g. background-image), unquoted; null if none.
function firstCssUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = String(value).match(/url\(\s*(["']?)([^)"']+)\1\s*\)/);
  return m ? m[2]!.trim() : null;
}

// A CSS url() → a self-contained href: a data: URI stays as-is; blob:/http/relative are
// fetched and inlined as a data: URI (so the SVG renders in secure static mode). Null on fail.
async function cssUrlToHref(url: string): Promise<string | null> {
  try { return url.startsWith('data:') ? url : await blobToDataUrl(url); }
  catch { return null; }
}

// preserveAspectRatio for a background-image sized via `background-size` + positioned via
// `background-position`: cover→slice, contain→meet, two explicit lengths (e.g. 100% 100%)→
// none (stretch), else cover-like (the common decorative default). Alignment from position.
/** One parsed CSS filter function as its SVG element. The maths is all in
 *  css-filter.ts; this is assembly only. */
function filterPrimitiveEl(NS: string, p: FilterPrimitive): Element {
  if (p.kind === 'blur') {
    const e = document.createElementNS(NS, 'feGaussianBlur');
    e.setAttribute('stdDeviation', String(Math.round(p.stdDeviation * 1000) / 1000));
    return e;
  }
  if (p.kind === 'colorMatrix') {
    const e = document.createElementNS(NS, 'feColorMatrix');
    e.setAttribute('type', 'matrix');
    e.setAttribute('values', p.values.map((n) => Math.round(n * 10000) / 10000).join(' '));
    return e;
  }
  if (p.kind === 'hueRotate') {
    const e = document.createElementNS(NS, 'feColorMatrix');
    e.setAttribute('type', 'hueRotate');
    e.setAttribute('values', String(Math.round(p.deg * 1000) / 1000));
    return e;
  }
  const e = document.createElementNS(NS, 'feComponentTransfer');
  const chan = (name: string) => {
    const f = document.createElementNS(NS, name);
    if (p.mode === 'linear') {
      f.setAttribute('type', 'linear');
      f.setAttribute('slope', String(Math.round((p.slope ?? 1) * 10000) / 10000));
      f.setAttribute('intercept', String(Math.round((p.intercept ?? 0) * 10000) / 10000));
    } else if (p.mode === 'invert') {
      // invert(a) is the spec's table [a, 1-a] per channel.
      f.setAttribute('type', 'table');
      f.setAttribute('tableValues', `${p.amount ?? 1} ${1 - (p.amount ?? 1)}`);
    } else {
      f.setAttribute('type', 'linear');
      f.setAttribute('slope', String(p.amount ?? 1));
      f.setAttribute('intercept', '0');
    }
    return f;
  };
  if (p.mode === 'alpha') { e.appendChild(chan('feFuncA')); return e; }
  for (const c of ['feFuncR', 'feFuncG', 'feFuncB']) e.appendChild(chan(c));
  return e;
}

/**
 * How far past its own box an element's `filter` paints, in CSS px.
 *
 * Only the filter: box-shadow is drawn separately by both walkers, and a transform is
 * neutralised before capture. A blur reaches ~3σ, and drop-shadow's σ IS its blur
 * value (unlike box-shadow's, which is half it — see buildDropShadowFilterEl).
 */
function effectSpillCss(style: CSSStyleDeclaration): number {
  const f = style.filter;
  if (!f || f === 'none') return 0;
  let reach = 0;
  for (const sh of parseDropShadowFilter(f) ?? []) {
    reach = Math.max(reach, sh.blur * 3 + Math.max(Math.abs(sh.dx), Math.abs(sh.dy)));
  }
  for (const p of parseCssFilter(f) ?? []) {
    if (p.kind === 'blur') reach = Math.max(reach, p.stdDeviation * 3);
  }
  return Math.min(200, reach);   // bounded: a pathological blur must not explode the capture
}

/** A computed length off a style, as a number. Missing/`auto` reads as 0. */
function num2(style: CSSStyleDeclaration, key: string): number {
  return Number.parseFloat((style as unknown as Record<string, string>)[key] || '') || 0;
}

/**
 * An image's natural size, for resolving `background-size: auto`.
 *
 * Memoised by href because the same chevron data-URI is the background of every
 * select on the page, and each miss is a decode. A failure resolves to null rather
 * than rejecting: CSS then treats the image as area-sized, which is exactly the
 * behaviour this replaced, so an undiscoverable image degrades to the old output
 * instead of vanishing.
 */
const intrinsicCache = new Map<string, Promise<{ w: number; h: number } | null>>();
function intrinsicSize(href: string): Promise<{ w: number; h: number } | null> {
  let p = intrinsicCache.get(href);
  if (!p) {
    p = new Promise<{ w: number; h: number } | null>((resolve) => {
      const im = new Image();
      const done = (v: { w: number; h: number } | null) => resolve(v);
      im.onload = () => done(im.naturalWidth > 0 ? { w: im.naturalWidth, h: im.naturalHeight } : null);
      im.onerror = () => done(null);
      im.src = href;
      // A never-settling decode must not hang an export.
      setTimeout(() => done(null), 3000);
    });
    intrinsicCache.set(href, p);
  }
  return p;
}

// Exported for bridge/export-paint-order.test.ts, which drives the REAL walker in
// a REAL Chromium: jsdom cannot be the oracle for paint order, because the whole
// thing hinges on getComputedStyle resolving z-index, isolation and display
// blockification. Not part of the bridge's public surface otherwise.
export async function renderSvgFromHtml(node: Element, opts: ExportOpts): Promise<Blob> {
  const NS = 'http://www.w3.org/2000/svg';
  // Text → vector <path> by default (self-contained, font-independent SVG). The
  // 'Convert paths' export toggle (opts.convertPaths) turns this off, falling back
  // to <text> elements everywhere for selectable, editable output.
  const vectorText = opts.convertPaths !== false;
  const { width: nodeW, height: nodeH } = node.getBoundingClientRect();
  const d = exportDims(node, opts);
  // viewBox lives in CSS px (physical units at 96dpi); the width/height carry
  // the real unit so the SVG renders at the correct physical size.
  const vbW = toCssPx(d.w);
  const vbH = toCssPx(d.h);
  const scaleX  = vbW / nodeW;
  const scaleY  = vbH / nodeH;

  const svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('xmlns',   NS);
  svgEl.setAttribute('width',   toCssLength(d.w));
  svgEl.setAttribute('height',  toCssLength(d.h));
  svgEl.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);

  const defs     = document.createElementNS(NS, 'defs');
  svgEl.appendChild(defs);

  const rootRect = node.getBoundingClientRect();
  let uid = 0;

  // Cooperative yielding: the SVG-IR walk + host.text.toPath (HarfBuzz) shaping
  // runs fully synchronously and janks the UI for the whole export on a complex
  // document. Mirror the CMYK pixel pass — every YIELD_NODES elements, report
  // progress and hand the event loop a turn. Purely additive: emitted geometry
  // and node order are untouched, so the serialised SVG bytes are identical.
  const totalNodes = ((node as any).querySelectorAll?.('*').length ?? 0) + 1;
  let nodesWalked = 0;
  const YIELD_NODES = 200;

  const rootG = document.createElementNS(NS, 'g');
  if (Math.abs(scaleX - 1) > 1e-4 || Math.abs(scaleY - 1) > 1e-4) {
    rootG.setAttribute('transform', `scale(${scaleX.toFixed(6)},${scaleY.toFixed(6)})`);
  }
  svgEl.appendChild(rootG);

  // Emit a vector <clipPath> for a circle()/ellipse()/inset()/polygon() clip-path onto
  // `g` (shape parsed box-local, then offset to root coords). Returns true if emitted;
  // false for url()/path()/unparseable → the caller rasterises. Geometry parsing is the
  // shared parseClipShape so the SVG and PDF walkers agree on the shape.
  const emitClip = (cp: string, x: number, y: number, w: number, h: number, g: Element): 'ok' | 'empty' | 'unsupported' => {
    const shape = parseClipShape(cp, w, h);
    if (!shape) return 'unsupported';
    // A zero-area clip is fully understood and renders nothing. Report it so the
    // caller can SKIP the element instead of handing it to the raster hatch.
    if (shape.kind === 'empty') return 'empty';
    const cid = `fcclip-${++uid}`;
    const clip = document.createElementNS(NS, 'clipPath');
    clip.setAttribute('id', cid);
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    clip.appendChild(svgClipShapeEl(NS, shape, x, y));
    defs.appendChild(clip);
    g.setAttribute('clip-path', `url(#${cid})`);
    return 'ok';
  };

  // ── Stacking-context paint order (opts.stackingOrder) ────────────────────────
  //
  // The walk stays a single DOM-order pass; correctness comes from DEFERRED
  // APPEND. A child whose Appendix E §E.2 layer is 2, 6 or 7 is built exactly as
  // before but left DETACHED, parked in its stacking context's frame, and
  // appended when that context finishes. Layers 3 and 4 append immediately, as
  // they always have.
  //
  // Two facts about this walker are what make that free, and both were verified
  // against the code before the design was chosen:
  //
  //  1. EVERYTHING IS EMITTED IN ROOT COORDINATES (`x = rect.left - rootRect.left`
  //     throughout, `clipPathUnits="userSpaceOnUse"` on every clip). A <g> can be
  //     re-parented anywhere with NO geometry fix-up. There is no need to rebuild
  //     the tree into per-layer bucket groups.
  //  2. EVERY APPEARANCE-CHANGING WRAPPER THE WALKER EMITS IS ITSELF A STACKING-
  //     CONTEXT CREATOR — opacity, clip-path, mix-blend-mode, filter, rotate,
  //     matrix. So a hoist terminates at each of them by construction, and the
  //     ONLY wrapper a deferred unit can be lifted out of is the overflow-clip
  //     group, which is a single re-appliable `clip-path` attribute (ctx.clips).
  //
  // `appendChild` on an already-parented node MOVES it, so no bucket groups are
  // created and the emitted node count is unchanged apart from hoist clip
  // wrappers. Cost: one pointer per deferred element (~300 on the gallery
  // fixture, against a 2.2 MB output) and no second pass or second tree, so the
  // 200-node cooperative yield is untouched.
  //
  // Given away deliberately: the emitted tree is no longer monotonic during the
  // walk, so streaming serialisation is impossible and a mid-walk throw leaves
  // orphaned detached subtrees. Neither matters today (one serialise at the end;
  // the walk already throws on failure), but both are now foreclosed.

  /** One deferred paint unit: the <g> (possibly wrapped in re-applied clips) and
   *  the used z-index it sorts by. */
  interface PaintUnit { z: number; g: Element }
  /** One stacking context, alive while its element's subtree is being walked. */
  interface ScFrame {
    /** Where deferred units land — the context element's contentG. */
    content: Element;
    /** Last own-paint node when contentG === g, else null. See the finalisation
     *  block for why layer 2 cannot just insert at firstChild. */
    anchor: ChildNode | null;
    neg: PaintUnit[];   // §E.2 step 3 — negative z, most negative first
    z0: PaintUnit[];    // §E.2 step 8 — positioned, z-index auto|0, TREE order
    pos: PaintUnit[];   // §E.2 step 9 — positive z, least positive first
  }
  /** What a child inherits. `frame === null` ⇒ the flag is off ⇒ every append is
   *  the append this walker has always done. */
  interface PaintCtx {
    frame: ScFrame | null;
    /** Ids of overflow clipPaths emitted between `frame`'s element and here — a
     *  hoisted unit must carry them or it escapes a clip it has today. */
    clips: string[];
    /** Intersection of every ancestor overflow box, in root coordinates. A node
     *  that misses it entirely paints nothing on screen, so it is not emitted —
     *  the cheapest form of clip reduction, since it removes the node AND the
     *  clip work that would have hidden it. Null means unbounded. */
    clipBox?: Rect | null;
    /** Union of the boxes actually painted beneath the nearest clip candidate.
     *  Filled during the walk so the decision "is this clip doing any work?" can
     *  be made from measurements rather than guessed up front. */
    bounds?: Bounds | null;
  }

  /** A box in root coordinates. */
  interface Rect { x: number; y: number; w: number; h: number }
  /** A mutable union accumulator. Empty until something expands it. */
  interface Bounds { minX: number; minY: number; maxX: number; maxY: number; any: boolean }
  const newBounds = (): Bounds => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, any: false });
  const expand = (b: Bounds | null | undefined, x: number, y: number, w: number, h: number): void => {
    if (!b) return;
    b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x + w); b.maxY = Math.max(b.maxY, y + h);
    b.any = true;
  };
  const intersectRect = (a: Rect | null | undefined, b: Rect): Rect => {
    if (!a) return b;
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
  };

  const stackingOrder = opts.stackingOrder === true;
  /** What every element classifies as when the flag is off: in-flow, no context.
   *  Shared constant so the OFF path allocates nothing per node. */
  const DOM_ORDER_ROLE: StackingRole = { createsContext: false, reason: '', layer: 3, z: 0, order: 0 };
  /** Top layer (`<dialog open>` shown modally, an open popover). Guarded because
   *  `:popover-open` throws in engines that don't know the selector.
   *
   *  KNOWN LIMITATION: this only makes a top-layer box a stacking CONTEXT so its
   *  internals order correctly. It does NOT lift it above the rest of the
   *  document (HTML §top layer) and `::backdrop` is not modelled at all
   *  (pseudoDescriptor sees only ::before/::after). On the measured fixtures
   *  that is the single largest remaining paint-order defect — ~36 points of
   *  local-gallery's loss, against ~2 points for everything this flag fixes —
   *  and it is a separate milestone. */
  const topLayer = (el: Element): boolean => {
    try { return typeof el.matches === 'function' && el.matches(':modal, :popover-open'); }
    catch { return false; }
  };

  /** Append `unit` where CSS says it paints. Returns a handle so a caller that
   *  later abandons the element (the zero-area clip-path early return) can undo
   *  the deferral; null when the unit went straight into `parentG`. */
  const place = (
    unit: Element, role: StackingRole, ctx: PaintCtx, parentG: Element, direct?: boolean,
  ): { list: PaintUnit[]; entry: PaintUnit } | null => {
    // `direct` is the transform re-entry (see its call sites); `!ctx.frame` is
    // the flag being off; layers 3/4 are in-flow content, which paints exactly
    // where DOM order puts it. All three are byte-for-byte the old behaviour.
    if (direct || !ctx.frame || role.layer === 3 || role.layer === 4) { parentG.appendChild(unit); return null; }
    // Re-apply every overflow clip crossed by the hoist, outermost first. The
    // <clipPath> already lives in <defs> with a stable id in ROOT coordinates,
    // so this costs one attribute and no geometry.
    //
    // KNOWN LIMITATION (CSS 2.1 §11.1.1): an absolutely-positioned box is NOT
    // clipped by a non-positioned ancestor's `overflow`, and `fixed` escapes
    // almost all clips. We re-apply every crossed clip anyway. Deliberate: that
    // is exactly what the walker does today, and getting the containing-block
    // chain wrong UNCLIPS content, which is a far worse failure than
    // mis-ordering. Revisit only with a fixture that demonstrates the escape.
    let top: Element = unit;
    for (let i = ctx.clips.length - 1; i >= 0; i--) {
      const wrap = document.createElementNS(NS, 'g');
      wrap.setAttribute('clip-path', `url(#${ctx.clips[i]})`);
      wrap.appendChild(top);
      top = wrap;
    }
    const list = role.layer === 2 ? ctx.frame.neg : role.layer === 6 ? ctx.frame.z0 : ctx.frame.pos;
    const entry: PaintUnit = { z: role.z, g: top };
    list.push(entry);
    return { list, entry };
  };

  /**
   * Paint a form control's contents: the text it displays, or the geometry of a
   * widget the UA draws.
   *
   * Text is NOT laid out here. A throwaway mirror is positioned over the control's
   * content box, given its font and alignment, and walked with the same
   * emitInlineTextSvg every other block goes through — so wrapping, direction,
   * vertical centring and line boxes come from the browser. Reimplementing them
   * would be a second, worse CSS. The mirror lives for one await and is removed in a
   * finally, including when the text pass throws.
   */
  async function emitControlPaint(el: Element, tag: string, style: CSSStyleDeclaration, contentG: Element): Promise<void> {
    const d = describeControl(el);
    if (!d) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    const num = (k: string) => Number.parseFloat((style as unknown as Record<string, string>)[k] || '') || 0;
    const insetL = num('borderLeftWidth') + num('paddingLeft');
    const insetT = num('borderTopWidth') + num('paddingTop');
    const insetR = num('borderRightWidth') + num('paddingRight');
    const insetB = num('borderBottomWidth') + num('paddingBottom');
    const cw = Math.max(0, r.width - insetL - insetR);
    const ch = Math.max(0, r.height - insetT - insetB);
    if (cw <= 0 || ch <= 0) return;
    const cx = r.left + insetL, cy = r.top + insetT;

    if (isWidgetControl(d)) { emitWidgetControl(el, d, style, contentG, r); return; }

    const ct = controlText(d);
    if (!ct) return;

    // Clip to the content box. This is the §7 "only when necessary" case: an
    // over-long option label or an unscrolled textarea genuinely does not paint
    // past the field on screen, and there is no geometry trick that crops text.
    const clipId = `fcctl-${++uid}`;
    const clip = document.createElementNS(NS, 'clipPath');
    clip.setAttribute('id', clipId);
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const cr = document.createElementNS(NS, 'rect');
    cr.setAttribute('x', String(n2(cx - rootRect.left))); cr.setAttribute('y', String(n2(cy - rootRect.top)));
    cr.setAttribute('width', String(n2(cw))); cr.setAttribute('height', String(n2(ch)));
    clip.appendChild(cr);
    defs.appendChild(clip);
    const cg = document.createElementNS(NS, 'g');
    cg.setAttribute('clip-path', `url(#${clipId})`);
    contentG.appendChild(cg);

    const mirror = document.createElement('div');
    const ms = mirror.style;
    ms.position = 'fixed';
    ms.left = `${cx}px`; ms.top = `${cy}px`;
    ms.width = `${cw}px`; ms.height = `${ch}px`;
    ms.margin = '0'; ms.padding = '0'; ms.border = '0';
    ms.pointerEvents = 'none';
    // Behind everything and non-interactive: the mirror exists for one layout pass,
    // but an export can be triggered from a visible page and must not flash.
    ms.zIndex = '-2147483648'; ms.opacity = '0';
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
                     'fontFeatureSettings', 'letterSpacing', 'wordSpacing', 'textTransform',
                     'textAlign', 'direction', 'lineHeight', 'fontStretch'] as const) {
      (ms as unknown as Record<string, string>)[k] = (style as unknown as Record<string, string>)[k] || '';
    }
    // The ::placeholder colour is a real computed style in Chromium; falling back to
    // the control's own colour is wrong-but-visible rather than invisible.
    const phColor = ct.placeholder ? (window.getComputedStyle(el, '::placeholder').color || '') : '';
    ms.color = phColor || style.color;
    ms.overflow = 'hidden';
    const inner = document.createElement('span');
    inner.style.display = 'block';
    if (ct.multiline) {
      inner.style.whiteSpace = 'pre-wrap';
      inner.style.wordBreak = (style as unknown as Record<string, string>).wordBreak || 'normal';
      // Reproduce the scrolled position: a textarea scrolled halfway shows its
      // middle, and drawing from the top would show text that isn't on screen.
      inner.style.marginTop = `${-(el as HTMLElement).scrollTop}px`;
    } else {
      // Single-line inputs and selects centre their text in the content box.
      ms.display = 'flex'; ms.alignItems = 'center';
      inner.style.whiteSpace = 'pre';
      inner.style.marginLeft = `${-(el as HTMLElement).scrollLeft}px`;
      inner.style.flex = '1 1 auto';
    }
    inner.textContent = ct.text;
    mirror.appendChild(inner);
    document.body.appendChild(mirror);
    try {
      await emitInlineTextSvg(NS, inner, window.getComputedStyle(inner), rootRect, cg, vectorText);
    } finally { mirror.remove(); }
    if (!cg.childNodes.length) cg.remove();
  }

  /**
   * Checkbox, radio and range.
   *
   * Only for UA-drawn widgets (`appearance` still native). When a stylesheet has set
   * `appearance: none` — which every control in this app does — the tick, dot and
   * track are ordinary CSS the walker already paints, and drawing a second widget on
   * top would be the wrong answer twice.
   */
  function emitWidgetControl(el: Element, d: ControlDesc, style: CSSStyleDeclaration, contentG: Element, r: DOMRect): void {
    const appearance = (style as unknown as Record<string, string>).appearance
      || (style as unknown as Record<string, string>).webkitAppearance || 'auto';
    if (appearance === 'none') return;
    const type = (d.type || '').toLowerCase();
    const x = r.left - rootRect.left, y = r.top - rootRect.top, w = r.width, h = r.height;
    const accent = parseCssColorFull(style.accentColor === 'auto' ? '' : style.accentColor) ?? [26, 115, 232, 1] as Rgba;
    const acc = `rgb(${accent[0]},${accent[1]},${accent[2]})`;
    const add = (e: Element) => contentG.appendChild(e);
    const rect = (rx: number, ry: number, rw: number, rh: number, fill: string, rad: number, stroke?: string) => {
      const q = document.createElementNS(NS, 'rect');
      q.setAttribute('x', String(n2(rx))); q.setAttribute('y', String(n2(ry)));
      q.setAttribute('width', String(n2(rw))); q.setAttribute('height', String(n2(rh)));
      if (rad) { q.setAttribute('rx', String(n2(rad))); q.setAttribute('ry', String(n2(rad))); }
      q.setAttribute('fill', fill);
      if (stroke) { q.setAttribute('stroke', stroke); q.setAttribute('stroke-width', '1'); }
      return q;
    };

    if (type === 'checkbox' || type === 'radio') {
      // An approximation of the platform widget, not a copy of it: the real one is
      // drawn by the compositor with no CSS to read. Blank was the alternative, and a
      // recognisable checkbox is closer to what the reader saw than an empty square.
      const round = type === 'radio' ? Math.min(w, h) / 2 : Math.min(2, Math.min(w, h) / 4);
      add(rect(x, y, w, h, d.checked ? acc : '#fff', round, d.checked ? undefined : '#767676'));
      if (d.checked && type === 'checkbox') {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', `M${n2(x + w * 0.22)} ${n2(y + h * 0.52)}L${n2(x + w * 0.42)} ${n2(y + h * 0.72)}L${n2(x + w * 0.78)} ${n2(y + h * 0.3)}`);
        p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#fff');
        p.setAttribute('stroke-width', String(n2(Math.max(1.5, Math.min(w, h) * 0.14))));
        p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
        add(p);
      } else if (d.checked) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', String(n2(x + w / 2))); c.setAttribute('cy', String(n2(y + h / 2)));
        c.setAttribute('r', String(n2(Math.min(w, h) * 0.22)));
        c.setAttribute('fill', '#fff');
        add(c);
      }
      return;
    }

    if (type === 'range') {
      const frac = rangeFraction(d);
      const th = Math.max(3, Math.min(4, h * 0.25));
      const ty = y + (h - th) / 2;
      add(rect(x, ty, w, th, '#c4c4c4', th / 2));
      if (frac > 0) add(rect(x, ty, w * frac, th, acc, th / 2));
      const rr = Math.min(h, 14) / 2;
      const c = document.createElementNS(NS, 'circle');
      // The thumb's centre travels between its own radii, not the full track.
      c.setAttribute('cx', String(n2(x + rr + (w - 2 * rr) * frac)));
      c.setAttribute('cy', String(n2(y + h / 2)));
      c.setAttribute('r', String(n2(rr)));
      c.setAttribute('fill', acc);
      add(c);
    }
  }

  async function visitSvgNode(
    el: any, parentG: Element, ctx: PaintCtx,
    o?: { forceContext?: boolean; placeDirect?: boolean },
  ): Promise<void> {
    if (el.nodeType !== 1) return;
    if (++nodesWalked % YIELD_NODES === 0) {
      opts.onProgress?.(Math.min(nodesWalked, totalNodes), totalNodes);
      await new Promise<void>((r) => setTimeout(r));         // unblock the UI thread
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script') return;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const opacity = parseFloat(style.opacity ?? '1');
    if (opacity === 0) return;

    // Where does CSS say this element's paint unit goes? One pure table lookup
    // off the style we already fetched (bridge/stacking-order.ts). The parent's
    // display is only needed for the flex/grid-item rule, so it is fetched ONLY
    // when a non-auto z-index makes that rule reachable — 70 of 992 elements on
    // the gallery fixture, rather than a second getComputedStyle per node.
    const role: StackingRole = stackingOrder
      ? stackingRole(
          style as unknown as Parameters<typeof stackingRole>[0],
          (style.zIndex && style.zIndex !== 'auto' && el.parentElement)
            ? window.getComputedStyle(el.parentElement).display : '',
          topLayer(el),
        )
      : DOM_ORDER_ROLE;
    // The root of the walk is always a stacking context (Appendix E: the root
    // element establishes one), and so is a transform re-entry — see below.
    const createsCtx = stackingOrder && (role.createsContext || el === node || o?.forceContext === true);

    // CSS rotate(): neutralise it, walk the axis-aligned subtree, then wrap the
    // whole thing in an SVG rotation about the transform-origin (faithful in SVG,
    // unlike the AABB fallback). Additive — no-op for every unrotated element.
    const rotDeg = pureRotationDeg(style.transform);
    if (rotDeg) {
      const prevInline = el.style.transform;
      el.style.transform = 'none';
      const unrot = el.getBoundingClientRect();   // reading forces the reflow
      const pivot = rotationPivot(style, unrot, rootRect);
      const gRot = document.createElementNS(NS, 'g');
      gRot.setAttribute('transform', `rotate(${rotDeg.toFixed(4)} ${pivot.x.toFixed(3)} ${pivot.y.toFixed(3)})`);
      // gRot is the paint unit for this element (the rotation wraps everything
      // it emits), so IT is what gets deferred.
      place(gRot, role, ctx, parentG);
      // forceContext + placeDirect exist ONLY for this re-entry, and they are
      // both about the same piece of hidden state: `el.style.transform` has just
      // been set to 'none', so the recursive call's getComputedStyle reports
      // `transform: none`.
      //   • forceContext — without it the element stops looking like a stacking
      //     context (CSS Transforms 1 §3) on the way in, and its descendants
      //     would hoist straight out of a rotation that is about to be applied.
      //   • placeDirect  — without it `g` would be deferred a SECOND time into
      //     the same frame, leaving gRot empty and painting the element twice
      //     over at the wrong depth.
      // Delete either one and the failure is silent. They are load-bearing.
      try { await visitSvgNode(el, gRot, { frame: ctx.frame, clips: ctx.clips }, { forceContext: true, placeDirect: true }); }
      finally { el.style.transform = prevInline; }
      return;
    }

    // General 2-D transform (rotate+scale, skew, arbitrary matrix) that isn't a pure
    // rotation: neutralise it, walk the untransformed subtree, then wrap in an SVG
    // matrix() about the transform-origin. Pure translate/scale is left to the AABB
    // path below (getBoundingClientRect already captures it); 3-D/perspective returns
    // null from parseCssMatrix and falls through to the same AABB path.
    const mtx = pureRotationDeg(style.transform) === 0 ? parseCssMatrix(style.transform) : null;
    if (mtx && !isAxisAlignedMat(mtx)) {
      const prevInline = el.style.transform;
      el.style.transform = 'none';
      const unrot = el.getBoundingClientRect();
      const pivot = rotationPivot(style, unrot, rootRect);
      const gM = document.createElementNS(NS, 'g');
      gM.setAttribute('transform', matToSvg(matAboutPivot(mtx, pivot.x, pivot.y)));
      place(gM, role, ctx, parentG);
      // Same forceContext/placeDirect contract as the rotation branch above —
      // see the comment there before touching either flag.
      try { await visitSvgNode(el, gM, { frame: ctx.frame, clips: ctx.clips }, { forceContext: true, placeDirect: true }); }
      finally { el.style.transform = prevInline; }
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 0.5 || rect.height < 0.5) return;

    const x = rect.left - rootRect.left;
    const y = rect.top  - rootRect.top;
    const w = rect.width;
    const h = rect.height;

    // Entirely outside every ancestor's overflow box: it paints nothing on screen, so
    // it is not emitted. Cheapest possible clip reduction — it removes the node and
    // its whole subtree rather than emitting them and then hiding them. The rows
    // scrolled out of a long list are the case that pays.
    // ...except when its containing block escapes that box. CSS 2.1 §11.1.1: an
    // absolutely-positioned element is NOT clipped by a non-positioned ancestor's
    // overflow, and `fixed` escapes almost every clip — such a node is genuinely
    // visible outside the box, and dropping it would delete content the reader saw.
    // Erring toward keeping is the same call the hoist path makes a few lines up:
    // an over-clipped node is a bug, an un-clipped node is a smaller one.
    const escapesClip = style.position === 'absolute' || style.position === 'fixed';
    const cb = escapesClip ? null : ctx.clipBox;
    if (cb && (cb.w <= 0 || cb.h <= 0 || x + w <= cb.x || y + h <= cb.y || x >= cb.x + cb.w || y >= cb.y + cb.h)) return;
    // Report the box up so the nearest clip candidate can tell whether its clip does
    // any work. Done before any early return below, so a node that ends up rastered
    // or skipped still counts toward its ancestor's decision.
    expand(ctx.bounds, x, y, w, h);

    const g = document.createElementNS(NS, 'g');
    if (opacity < 0.999) g.setAttribute('opacity', opacity.toFixed(4));
    const placement = place(g, role, ctx, parentG, o?.placeDirect);

    // clip-path → vector <clipPath> so the node stays vector instead of rasterising.
    // circle()/ellipse()/inset()/polygon() all route through the shared parseClipShape
    // (element-local px → offset to root coords). clipHandled is false only for a shape
    // we couldn't vectorise (url()/path(), or a failed basic shape) — the escape-hatch
    // below then rasterises it. A polygon with <3 points still counts as handled (never
    // rasters — matches prior behaviour). The PDF walker mirrors this exactly.
    let clipHandled = true;
    const cp = style.clipPath || (style as any).webkitClipPath;
    if (cp && cp !== 'none') {
      const clipRes = emitClip(cp, x, y, w, h, g);
      // Zero area: the browser paints nothing here, so neither do we. Drop the
      // group we just appended and stop — no clip, no children, no raster.
      // UNPLACE: in stacking mode `g` was never attached to the DOM, it was
      // parked in a frame array, so `.remove()` alone would leave an empty (or
      // clip-wrapped) group to be appended at finalisation. Splice by IDENTITY
      // rather than popping the tail — no child has been walked yet so it IS the
      // last entry, but relying on that would rot the moment anything is added
      // between the two points. The arrays are tiny.
      if (clipRes === 'empty') {
        if (placement) {
          const i = placement.list.indexOf(placement.entry);
          if (i >= 0) placement.list.splice(i, 1);
        } else { g.remove(); }
        return;
      }
      clipHandled = clipRes === 'ok' || cp.trim().indexOf('polygon(') === 0;
    }

    // mix-blend-mode: SVG carries it natively, so blend the vector content on `g`
    // rather than rasterising it (SVG output only; PDF/EMF/EPS still raster it).
    if (style.mixBlendMode && style.mixBlendMode !== 'normal') {
      g.setAttribute('style', `mix-blend-mode:${style.mixBlendMode}`);
    }

    // filter: drop-shadow(…) → keep vector via a chain of <feDropShadow> on `g`
    // (SVG only; other filter functions can't be reproduced and fall to the raster
    // escape-hatch below, which is why the dropShadow cap is gated on this parse).
    // <img>/<svg> filters are baked into the bitmap / handled by their own paths.
    const dropShadows = (tag !== 'img' && tag !== 'svg') ? parseDropShadowFilter(style.filter) : null;
    if (dropShadows) {
      const fId = `fcds-${++uid}`;
      defs.appendChild(buildDropShadowFilterEl(NS, dropShadows, fId, { x, y, w, h }));
      g.setAttribute('filter', `url(#${fId})`);
    }

    // ── Border radius (CSS corner-overlap clamped → pill, not ellipse) ───────
    const { radii, uniform } = resolveRadii(style, w, h);
    const hasRadius = uniform ? (uniform[0] > 0 || uniform[1] > 0) : true;

    // ── Box shadow ────────────────────────────────────────────────────────────
    // Each outer shadow is the box's own shape, offset + grown by spread, filled
    // with the shadow colour and Gaussian-blurred, painted BEHIND the background.
    // EMF/EPS/DXF (opts.noBoxShadow) have no blur primitive, and used to get no shadow
    // at all rather than an ugly hard-edged offset shape. They can have one: a blur is
    // reproducible as concentric bands (§13), and for a format with no alpha the bands
    // have to be non-overlapping RINGS at absolute coverage — svg-ir flattens every
    // shape against the page background independently, so overlapping increments never
    // accumulate and come out far too light.
    if (opts.noBoxShadow && tag !== 'img' && tag !== 'svg') {
      for (const sh of parseBoxShadow(style.boxShadow).reverse()) {
        if (sh.inset) continue;
        const col = parseCssColorFull(sh.color);
        if (!col) continue;
        const fillCol = `rgb(${col[0]},${col[1]},${col[2]})`;
        const shapeAt = (t: number) => {
          const sw = Math.max(0, w + 2 * (sh.spread + t)), shh = Math.max(0, h + 2 * (sh.spread + t));
          if (sw <= 0 || shh <= 0) return '';
          return roundedRectPath(x + sh.x - sh.spread - t, y + sh.y - sh.spread - t, sw, shh,
            insetCorners(radii, -(sh.spread + t)));
        };
        const rings = gaussianShadowRings(sh.blur, col[3]);
        if (!rings.length) {
          // Hard shadow: one shape, exact, no approximation involved.
          const d = shapeAt(0);
          if (!d) continue;
          const p = document.createElementNS(NS, 'path');
          p.setAttribute('d', d);
          p.setAttribute('fill', fillCol);
          if (col[3] < 1) p.setAttribute('fill-opacity', String(col[3]));
          g.appendChild(p);
          continue;
        }
        // NOT clipped out of the border box, unlike the compositing path. A clipPath
        // is no use here (svg-ir skips those, so EMF/EPS would ignore it), and cutting
        // the box out of the innermost ring by hand measured WORSE — the shadow is
        // offset, so an un-offset hole leaves a gap along its own top edge. It costs
        // nothing in the target formats: svg-ir flattens the element's background to
        // an opaque shape painted after these, which covers the area completely. Only
        // a fully transparent background would reveal it, and then there is no box to
        // cast the shadow in the first place.
        for (const ring of rings) {
          const outer = shapeAt(ring.outer);
          if (!outer) continue;
          const inner = ring.inner === null ? '' : shapeAt(ring.inner);
          const p = document.createElementNS(NS, 'path');
          p.setAttribute('d', outer + inner);
          if (inner) p.setAttribute('fill-rule', 'evenodd');
          p.setAttribute('fill', fillCol);
          p.setAttribute('fill-opacity', String(Math.round(ring.alpha * 1000) / 1000));
          g.appendChild(p);
        }
      }
    }

    // Painted back-to-front so the first-listed shadow ends up on top, matching CSS.
    if (!opts.noBoxShadow && tag !== 'img' && tag !== 'svg') {
      for (const sh of parseBoxShadow(style.boxShadow).reverse()) {
        if (sh.inset) continue;   // drawn after the background, below — CSS paints it inside
        const col = parseCssColorFull(sh.color);
        if (!col) continue;
        const sw = Math.max(0, w + 2 * sh.spread);
        const sh2 = Math.max(0, h + 2 * sh.spread);
        if (sw <= 0 || sh2 <= 0) continue;
        const sRadii = insetCorners(radii, -sh.spread);   // negative inset = outset
        const fill = col[3] < 1
          ? `rgba(${col[0]},${col[1]},${col[2]},${col[3]})`
          : `rgb(${col[0]},${col[1]},${col[2]})`;
        // CSS paints an outer shadow "as if the border box were opaque" and clips it
        // away INSIDE that box (Backgrounds §7.1.1). Painting the whole shape and
        // covering it with the background only works when the background is opaque —
        // over a translucent panel the shadow shows straight through, which measured
        // 6.2% mean / 36% worst-pixel error against the bitmap on this app's frosted
        // surfaces.
        //
        // With no blur the hole is pure geometry: one evenodd path, shadow shape minus
        // border box, and no clip at all (so it survives EMF/EPS too). With a blur the
        // order matters — CSS blurs and THEN clips — and no amount of geometry
        // reproduces that, so this is the §7 case where a clip is genuinely the
        // mechanism rather than a shortcut.
        // The hole is a HAIR smaller than the border box. Two antialiased edges meeting
        // exactly leaves a seam of background showing between the shadow and the box —
        // it measured up to 13% on a single pixel line, on the very fixtures that were
        // previously exact. Half a pixel of overlap tucks the shadow under the box's
        // own edge and costs nothing anywhere else.
        //
        // …but only when it MATTERS. An opaque background hides the shadow beneath it
        // by simply painting over it, exactly as before, and that path measured exact.
        // Cutting a hole there instead leaves two independently antialiased edges
        // meeting along the border — a seam worth up to 13% on a single pixel line.
        // So the hole is cut only when the background cannot do the hiding.
        const bgAlpha = parseCssColorFull(style.backgroundColor)?.[3] ?? 0;
        const needsHole = bgAlpha < 0.999;
        let shape: Element;
        if (!needsHole) {
          shape = makeRoundedFill(NS, x + sh.x - sh.spread, y + sh.y - sh.spread,
            sw, sh2, sRadii, uniformRadius(sRadii), fill);
        } else if (sh.blur <= 0) {
          const ring = document.createElementNS(NS, 'path');
          ring.setAttribute('d',
            roundedRectPath(x + sh.x - sh.spread, y + sh.y - sh.spread, sw, sh2, sRadii) +
            roundedRectPath(x, y, w, h, radii));
          ring.setAttribute('fill-rule', 'evenodd');
          ring.setAttribute('fill', fill);
          shape = ring;
        } else {
          shape = makeRoundedFill(NS, x + sh.x - sh.spread, y + sh.y - sh.spread,
            sw, sh2, sRadii, uniformRadius(sRadii), fill);
          const holeId = `fcshclip-${++uid}`;
          const hole = document.createElementNS(NS, 'clipPath');
          hole.setAttribute('id', holeId);
          hole.setAttribute('clipPathUnits', 'userSpaceOnUse');
          const cut = document.createElementNS(NS, 'path');
          const cpad = sh.blur * 3 + Math.abs(sh.x) + Math.abs(sh.y) + Math.abs(sh.spread) + 8;
          cut.setAttribute('d',
            `M${n2(x - cpad)} ${n2(y - cpad)}H${n2(x + w + cpad)}V${n2(y + h + cpad)}H${n2(x - cpad)}Z` +
            roundedRectPath(x, y, w, h, radii));
          cut.setAttribute('clip-rule', 'evenodd');
          hole.appendChild(cut);
          defs.appendChild(hole);
          shape.setAttribute('clip-path', `url(#${holeId})`);
        }
        if (sh.blur > 0) {
          const fId = `shadow-${++uid}`;
          const filt = document.createElementNS(NS, 'filter');
          filt.setAttribute('id', fId);
          // userSpaceOnUse region padded for the blur so it isn't clipped.
          const pad = sh.blur * 1.5 + Math.abs(sh.spread) + 8;
          filt.setAttribute('filterUnits', 'userSpaceOnUse');
          filt.setAttribute('x',      String(x + sh.x - sh.spread - pad));
          filt.setAttribute('y',      String(y + sh.y - sh.spread - pad));
          filt.setAttribute('width',  String(sw + 2 * pad));
          filt.setAttribute('height', String(sh2 + 2 * pad));
          const fe = document.createElementNS(NS, 'feGaussianBlur');
          fe.setAttribute('in', 'SourceGraphic');
          fe.setAttribute('stdDeviation', String(sh.blur / 2));
          filt.appendChild(fe);
          defs.appendChild(filt);
          shape.setAttribute('filter', `url(#${fId})`);
        }
        g.appendChild(shape);
      }
    }

    // ── Rasterise escape-hatch: node uses CSS the walker can't express ──────────
    // Embed the node as an <image> instead of silently dropping the effect. Placed
    // AFTER the box-shadow block so an outset shadow still paints behind the raster,
    // and BEFORE background/children so the raster replaces them (dom-to-image already
    // captured the whole subtree). Returns on success. The element's own opacity is
    // neutralised for the capture (like the rotation branch neutralises transform) so
    // it isn't applied twice — once baked into the PNG and again via g's opacity.
    // Falls through to the vector walk if raster fails.
    // Set when the escape hatch below captured this element's own paint as an
    // <image>; the vector background/border emission then stands down so the two
    // don't double-paint.
    let ownPaintRastered = false;
    // ── CSS filter ───────────────────────────────────────────────────────────
    // Every CSS shorthand filter is spec-defined as an equivalent SVG filter, so the
    // chain is emitted rather than dropped (49 filtered elements on the gallery
    // fixture used to lose theirs silently). drop-shadow is excluded — the walker
    // draws those as geometry, which survives EMF/EPS where a filter would not.
    if (!opts.noBoxShadow) {
      const fv = style.filter || '';
      if (fv && fv !== 'none' && !isDropShadowOnly(fv)) {
        const prims = parseCssFilter(fv);
        if (prims && prims.length) {
          const fId = `fcflt-${++uid}`;
          const filt = document.createElementNS(NS, 'filter');
          filt.setAttribute('id', fId);
          // Room for a blur to spread past the box, and sRGB to match CSS, which
          // applies these in sRGB rather than SVG's linearRGB default.
          const spread = prims.reduce((n, p) => p.kind === 'blur' ? Math.max(n, p.stdDeviation) : n, 0);
          const pad = spread * 3 + 8;
          filt.setAttribute('filterUnits', 'userSpaceOnUse');
          filt.setAttribute('x', String(n2(x - pad))); filt.setAttribute('y', String(n2(y - pad)));
          filt.setAttribute('width', String(n2(w + 2 * pad))); filt.setAttribute('height', String(n2(h + 2 * pad)));
          filt.setAttribute('color-interpolation-filters', 'sRGB');
          for (const pr of prims) filt.appendChild(filterPrimitiveEl(NS, pr));
          defs.appendChild(filt);
          g.setAttribute('filter', `url(#${fId})`);
        }
      }
    }

    // ── backdrop-filter: blur() ─────────────────────────────────────────────
    // SVG has no primitive that reads what is painted behind an element, so the
    // backdrop has to be reconstructed: take the content already emitted (at this
    // point in the walk, `rootG` IS everything behind this element), clip that copy
    // to this element's own shape, and blur it. The copy goes in first, so the
    // element's background, border and children then paint over it exactly as they
    // do on screen.
    //
    // Snapshot mode only. It duplicates geometry, which is the wrong trade for a
    // tool export, and `rasterizeNodeToDataUrl` cannot do it at all — dom-to-image
    // serialises the node into a <foreignObject>, and the backdrop is by definition
    // outside that subtree, which is why the raster hatch always got this wrong.
    const bfRaw = opts.backdropBlur === true
      ? (style.backdropFilter || (style as { webkitBackdropFilter?: string }).webkitBackdropFilter || '')
      : '';
    const bfPx = bfRaw ? parseBackdropBlurPx(bfRaw) : null;
    // The clone is expressed in root user space, so it can only be dropped into `g`
    // when nothing between `g` and the root carries a transform — otherwise the
    // rotation wrapper above would apply that transform a second time. Rotated
    // frosted panels fall through to the raster hatch, as before.
    let bfTransformed = false;
    for (let a: Element | null = g; a && a !== rootG; a = a.parentElement) {
      if (a.hasAttribute('transform')) { bfTransformed = true; break; }
    }
    if (bfPx !== null && bfPx > 0 && !bfTransformed && rootG.childNodes.length) {
      // Bound the duplication: a page-sized backdrop under many blurred pills would
      // copy the whole document once per pill. Past the cap, fall through and let the
      // raster hatch have it rather than emit tens of megabytes.
      const backdropNodes = rootG.childNodes.length;
      if (backdropNodes <= BACKDROP_MAX_NODES) {
        const bId = `fcbd-${++uid}`;
        const filt = document.createElementNS(NS, 'filter');
        filt.setAttribute('id', bId);
        // Room for the blur to spread, and clamp to sRGB so the result matches CSS,
        // which composites backdrop filters in sRGB rather than linearRGB.
        // userSpaceOnUse over the element box padded by the blur radius. The default
        // objectBoundingBox region would be relative to the whole duplicated
        // backdrop's bbox — near page-sized — making the filter far more expensive
        // than the area that actually shows through the clip.
        const bpad = bfPx * 2 + 4;
        filt.setAttribute('filterUnits', 'userSpaceOnUse');
        filt.setAttribute('x',      String(n2(x - bpad)));
        filt.setAttribute('y',      String(n2(y - bpad)));
        filt.setAttribute('width',  String(n2(w + 2 * bpad)));
        filt.setAttribute('height', String(n2(h + 2 * bpad)));
        filt.setAttribute('color-interpolation-filters', 'sRGB');
        const fe = document.createElementNS(NS, 'feGaussianBlur');
        // CSS blur(Npx) is a Gaussian with stdDeviation N/2 (Filter Effects §.
        fe.setAttribute('stdDeviation', String(n2(bfPx / 2)));
        filt.appendChild(fe);
        defs.appendChild(filt);

        const cId = `fcbdclip-${++uid}`;
        const cp = document.createElementNS(NS, 'clipPath');
        cp.setAttribute('id', cId);
        cp.setAttribute('clipPathUnits', 'userSpaceOnUse');
        cp.appendChild(makeRoundedFill(NS, x, y, w, h, radii, uniform, '#fff'));
        defs.appendChild(cp);

        const bd = document.createElementNS(NS, 'g');
        bd.setAttribute('clip-path', `url(#${cId})`);
        bd.setAttribute('filter', `url(#${bId})`);
        // Deep clones, not <use>: svg-ir (EMF/EPS/DXF) skips <use> outright, so a
        // referenced backdrop would silently vanish from those formats.
        for (const child of Array.from(rootG.childNodes)) bd.appendChild(child.cloneNode(true));
        g.appendChild(bd);
      } else {
        _host?.log?.('info', `svg: backdrop-filter blur skipped on <${tag}> — ${backdropNodes} nodes behind it`);
      }
    }

    const rasterReason = opts.rasterFallback !== false ? detectUnsupportedCss(el, style, { blend: true, clipBasicShapes: clipHandled, dropShadow: Boolean(dropShadows), backdropBlur: opts.backdropBlur === true, conic: true }) : null;
    if (rasterReason) {
      const pxScale = scaleX * Math.max(1, d.dpi / CSS_DPI);
      const pxW = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(w * pxScale)));
      const pxH = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(h * pxScale)));
      const prevOpacity = el.style.opacity;
      el.style.opacity = '1';   // g already carries the element opacity; don't bake it in twice
      let dataUrl: string | null = null;
      // Lolly-composited subtree baked into an SVG <image> — same chokepoint as the
      // PDF escape hatch, so it honours opts.imprint too (inert until SVG is imprint-
      // enabled upstream, since the mark is size-floored and opt-in either way).
      // Element-scoped mode (page snapshots): capture only this element's own paint
      // and carry on walking its children as vector. Subtree mode (the default, and
      // what every tool export has always done) bakes the whole subtree into the PNG.
      //
      // Why it matters: the hatch fires on the ELEMENT, so one `conic-gradient` or
      // `backdrop-filter` on a top-level container used to convert an entire page to
      // a screenshot — measured 100% raster coverage on two fixtures. Scoping it turns
      // that cliff into local degradation: the offending box's paint becomes an
      // <image>, everything inside it stays text and geometry.
      //
      // Left OFF for tool exports on purpose. Splitting an element's paint from its
      // children changes compositing where the two interact (a child with
      // `mix-blend-mode` blending against its parent's background is the case), and
      // renderSvgFromHtml is the shipping SVG/PDF/EMF/EPS path for every tool in
      // every profile. Snapshot-specific behaviour stays behind the flag.
      const scoped = opts.elementScopedRaster === true;
      try { dataUrl = await rasterizeNodeToDataUrl(el as HTMLElement, pxW, pxH, undefined, opts._imprintSink, scoped); }
      finally { el.style.opacity = prevOpacity; }
      if (dataUrl) {
        _host?.log?.('info', `svg: rasterised <${tag}> ${scoped ? 'own paint' : 'subtree'} (unsupported ${rasterReason})`);
        const img = document.createElementNS(NS, 'image');
        img.setAttribute('href', dataUrl);
        img.setAttribute('x', String(n2(x)));  img.setAttribute('y', String(n2(y)));
        img.setAttribute('width', String(n2(w))); img.setAttribute('height', String(n2(h)));
        img.setAttribute('preserveAspectRatio', 'none');   // sized exactly to the box
        g.appendChild(img);
        if (!scoped) return;
        // Scoped: the raster IS this element's background/border/effect layer, so skip
        // re-emitting those in vector below (they would double-paint over the image)
        // and fall through to the children walk.
        ownPaintRastered = true;
      }
      // dataUrl == null → fall through to the normal (lossy) vector emission.
    }

    // ── Background ──────────────────────────────────────────────────────────
    // CSS paint order (bottom→top): background-color, then the background-image layer.
    // A gradient emits a true SVG gradient (alpha stops preserved); a url() image emits a
    // real <image> (vector-first — the box's text/children stay crisp, instead of
    // rasterising the whole node), sized/positioned per background-size/position and clipped
    // to the rounded box. Only when we CAN'T vectorise (conic, repeat, unresolvable) does the
    // escape-hatch above rasterise.
    const bgImg = ownPaintRastered ? 'none' : style.backgroundImage;
    const bgRgb = ownPaintRastered ? null : parseCssColorFull(style.backgroundColor);
    if (bgRgb) g.appendChild(makeRoundedFill(NS, x, y, w, h, radii, uniform, rgbaCss(bgRgb)));
    if (bgImg && bgImg !== 'none') {
      const gid = ++uid;
      const gradEl = buildLinearGradientEl(NS, bgImg, x, y, w, h, gid)
        || buildRadialGradientEl(NS, bgImg, x, y, w, h, gid);
      const conic = gradEl ? null : parseConicGradient(bgImg, w, h);
      if (gradEl) {
        defs.appendChild(gradEl);
        g.appendChild(makeRoundedFill(NS, x, y, w, h, radii, uniform, `url(#svggrad-${gid})`));
      } else if (conic) {
        // SVG has no conic primitive, so the sweep is drawn as a fan of wedges. It is
        // the last thing on these pages that forced a raster: on the qr fixture a
        // single conic page background became a 1168×900 PNG that swamped every
        // vector node behind it.
        const fan = conicFanEl(NS, conic, x, y, w, h, gid);
        if (fan) {
          const cid = `fcconic-${++uid}`;
          const clip = document.createElementNS(NS, 'clipPath');
          clip.setAttribute('id', cid);
          clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
          clip.appendChild(makeRoundedFill(NS, x, y, w, h, radii, uniform, '#fff'));
          defs.appendChild(clip);
          fan.setAttribute('clip-path', `url(#${cid})`);
          g.appendChild(fan);
        }
      } else {
        const bgUrl = firstCssUrl(bgImg);
        const href = bgUrl ? await cssUrlToHref(bgUrl) : null;
        if (href) {
          // Place the image per background-size/position/repeat instead of stretching
          // it across the border box. The old behaviour was right only for a `cover`
          // hero: a 14px right-centred select chevron came out smeared across the
          // whole field, and this app's field primitive puts one on every select and
          // every checkbox.
          const area = {
            w: Math.max(0, w - num2(style, 'borderLeftWidth') - num2(style, 'borderRightWidth')),
            h: Math.max(0, h - num2(style, 'borderTopWidth') - num2(style, 'borderBottomWidth')),
          };
          const ax = x + num2(style, 'borderLeftWidth'), ay = y + num2(style, 'borderTopWidth');
          const pl = placeBackground(style.backgroundSize, style.backgroundPosition,
            style.backgroundRepeat, area, await intrinsicSize(href));

          const cid = `fcbgclip-${++uid}`;
          const clip = document.createElementNS(NS, 'clipPath');
          clip.setAttribute('id', cid);
          clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
          clip.appendChild(makeRoundedFill(NS, x, y, w, h, radii, uniform, '#fff'));
          defs.appendChild(clip);

          if (pl.w > 0 && pl.h > 0 && (pl.repeatX || pl.repeatY)) {
            // A tiling background becomes a real <pattern> rather than a screenshot.
            // The tile step is the painted size on the repeating axis and the whole
            // area on the axis that doesn't repeat, so repeat-x doesn't become a grid.
            const pid = `fcbgpat-${++uid}`;
            const pat = document.createElementNS(NS, 'pattern');
            pat.setAttribute('id', pid);
            pat.setAttribute('patternUnits', 'userSpaceOnUse');
            pat.setAttribute('x', String(n2(ax + (pl.repeatX ? pl.x % pl.w : pl.x))));
            pat.setAttribute('y', String(n2(ay + (pl.repeatY ? pl.y % pl.h : pl.y))));
            pat.setAttribute('width', String(n2(pl.repeatX ? pl.w : Math.max(pl.w, area.w))));
            pat.setAttribute('height', String(n2(pl.repeatY ? pl.h : Math.max(pl.h, area.h))));
            const pim = document.createElementNS(NS, 'image');
            pim.setAttribute('href', href);
            pim.setAttribute('x', '0'); pim.setAttribute('y', '0');
            pim.setAttribute('width', String(n2(pl.w))); pim.setAttribute('height', String(n2(pl.h)));
            pim.setAttribute('preserveAspectRatio', 'none');
            pat.appendChild(pim);
            defs.appendChild(pat);
            const fillRect = makeRoundedFill(NS, x, y, w, h, radii, uniform, `url(#${pid})`);
            g.appendChild(fillRect);
          } else if (pl.w > 0 && pl.h > 0) {
            const im = document.createElementNS(NS, 'image');
            im.setAttribute('href', href);
            im.setAttribute('x', String(n2(ax + pl.x))); im.setAttribute('y', String(n2(ay + pl.y)));
            im.setAttribute('width', String(n2(pl.w))); im.setAttribute('height', String(n2(pl.h)));
            // The size is already resolved, so the image must fill it exactly —
            // letting preserveAspectRatio re-fit it would undo the arithmetic.
            im.setAttribute('preserveAspectRatio', 'none');
            im.setAttribute('clip-path', `url(#${cid})`);
            g.appendChild(im);
          }
        }
      }
    }

    // ── Inset box-shadow ──────────────────────────────────────────────────────
    // CSS paints an inset shadow over the background and under the border/content,
    // so it goes here rather than with the outer shadows. The geometry is exactly the
    // region between the border box and an offset, spread-shrunken copy of it: one
    // path with two subpaths and `fill-rule: evenodd`, blurred, and clipped to the
    // box so the blur cannot bleed outside. No stroke-width guessing, and the same
    // element count a stroked approximation would need.
    // Blur-less formats: the same ring treatment, mirrored. An inset shadow is the
    // blur of the region OUTSIDE the offset, shrunken inner shape, so each ring is the
    // annulus between two shrunken copies of it, and the innermost reaches the box.
    if (opts.noBoxShadow && !ownPaintRastered && tag !== 'img' && tag !== 'svg') {
      for (const sh of parseBoxShadow(style.boxShadow).reverse()) {
        if (!sh.inset) continue;
        const col = parseCssColorFull(sh.color);
        if (!col) continue;
        const shrunk = (t: number) => {
          const iw = w - 2 * (sh.spread + t), ih = h - 2 * (sh.spread + t);
          if (iw <= 0 || ih <= 0) return '';
          return roundedRectPath(x + sh.x + sh.spread + t, y + sh.y + sh.spread + t, iw, ih,
            insetCorners(radii, sh.spread + t));
        };
        const boxPath = roundedRectPath(x, y, w, h, radii);
        const rings = gaussianShadowRings(sh.blur, col[3]);
        const steps: { outerD: string; innerD: string; alpha: number }[] = rings.length
          ? rings.map((r) => ({
              outerD: r.inner === null ? boxPath : shrunk(r.inner),
              innerD: shrunk(r.outer),
              alpha: r.alpha,
            }))
          : [{ outerD: boxPath, innerD: shrunk(0), alpha: col[3] }];
        // Clip to the box: the offset copies reach past it, and an inset shadow that
        // escapes its own element is the one failure worse than not drawing it.
        const cid = `fcinsetring-${++uid}`;
        const clip = document.createElementNS(NS, 'clipPath');
        clip.setAttribute('id', cid);
        clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
        clip.appendChild(makeRoundedFill(NS, x, y, w, h, radii, uniform, '#fff'));
        defs.appendChild(clip);
        const ringG = document.createElementNS(NS, 'g');
        ringG.setAttribute('clip-path', `url(#${cid})`);
        for (const st of steps) {
          if (!st.outerD) continue;
          const p = document.createElementNS(NS, 'path');
          p.setAttribute('d', st.outerD + st.innerD);
          if (st.innerD) p.setAttribute('fill-rule', 'evenodd');
          p.setAttribute('fill', `rgb(${col[0]},${col[1]},${col[2]})`);
          p.setAttribute('fill-opacity', String(Math.round(st.alpha * 1000) / 1000));
          ringG.appendChild(p);
        }
        if (ringG.childNodes.length) g.appendChild(ringG);
      }
    }

    if (!opts.noBoxShadow && !ownPaintRastered && tag !== 'img' && tag !== 'svg') {
      for (const sh of parseBoxShadow(style.boxShadow).reverse()) {
        if (!sh.inset) continue;
        const col = parseCssColorFull(sh.color);
        if (!col) continue;
        const iw = Math.max(0, w - 2 * sh.spread), ih = Math.max(0, h - 2 * sh.spread);
        const iRadii = insetCorners(radii, sh.spread);
        // The outer subpath has to reach past the blur on every side, or the ring's
        // own outer edge blurs into view inside the box.
        const pad = sh.blur * 3 + Math.abs(sh.x) + Math.abs(sh.y) + Math.abs(sh.spread) + 8;
        const ring = document.createElementNS(NS, 'path');
        ring.setAttribute('d',
          `M${n2(x - pad)} ${n2(y - pad)}H${n2(x + w + pad)}V${n2(y + h + pad)}H${n2(x - pad)}Z` +
          roundedRectPath(x + sh.x + sh.spread, y + sh.y + sh.spread, iw, ih, iRadii));
        ring.setAttribute('fill-rule', 'evenodd');
        ring.setAttribute('fill', `rgb(${col[0]},${col[1]},${col[2]})`);
        if (col[3] < 1) ring.setAttribute('fill-opacity', String(col[3]));
        if (sh.blur > 0) {
          const fId = `fcinset-${++uid}`;
          const filt = document.createElementNS(NS, 'filter');
          filt.setAttribute('id', fId);
          filt.setAttribute('filterUnits', 'userSpaceOnUse');
          filt.setAttribute('x', String(n2(x - pad))); filt.setAttribute('y', String(n2(y - pad)));
          filt.setAttribute('width', String(n2(w + 2 * pad))); filt.setAttribute('height', String(n2(h + 2 * pad)));
          filt.setAttribute('color-interpolation-filters', 'sRGB');
          const fe = document.createElementNS(NS, 'feGaussianBlur');
          fe.setAttribute('stdDeviation', String(n2(sh.blur / 2)));   // CSS blur radius → σ
          filt.appendChild(fe);
          defs.appendChild(filt);
          ring.setAttribute('filter', `url(#${fId})`);
        }
        const cid = `fcinsetclip-${++uid}`;
        const clip = document.createElementNS(NS, 'clipPath');
        clip.setAttribute('id', cid);
        clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
        clip.appendChild(makeRoundedFill(NS, x, y, w, h, radii, uniform, '#fff'));
        defs.appendChild(clip);
        ring.setAttribute('clip-path', `url(#${cid})`);
        g.appendChild(ring);
      }
    }

    // ── Borders ─────────────────────────────────────────────────────────────
    // Mirror the PDF walker: a uniform border becomes one stroked rect/path (radius
    // honoured); a divider (border-top only) or mixed border fills per edge.
    // Colours keep their alpha (stroke-opacity / fill-opacity) — svg-ir flattens
    // it over the background for EMF/EPS — so hairline rgba() borders don't go opaque.
    const bSide = (wKey: string, cKey: string): { bw: number; rgb: Rgba | null } => {
      if (ownPaintRastered) return { bw: 0, rgb: null };   // already in the raster
      const bw = parseFloat((style as any)[wKey]) || 0;
      return { bw, rgb: bw > 0 ? parseCssColorFull((style as any)[cKey]) : null };
    };
    const bT = bSide('borderTopWidth',    'borderTopColor');
    const bR = bSide('borderRightWidth',  'borderRightColor');
    const bB = bSide('borderBottomWidth', 'borderBottomColor');
    const bL = bSide('borderLeftWidth',   'borderLeftColor');
    const eqRgb = (a: Rgba | null, b: Rgba | null) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
    const rgbStr = (c: Rgba) => `rgb(${c[0]},${c[1]},${c[2]})`;
    const uniformBorder = bT.rgb && bT.bw === bR.bw && bT.bw === bB.bw && bT.bw === bL.bw
      && eqRgb(bT.rgb, bR.rgb) && eqRgb(bT.rgb, bB.rgb) && eqRgb(bT.rgb, bL.rgb);
    if (uniformBorder) {
      const lw = bT.bw;
      // Centred stroke: inset the box by lw/2 and the radius by lw/2 (border-box
      // radius minus half the border). Uniform corners → <rect>; else a <path>.
      const r = uniform
        ? makeSvgRect(NS, x + lw / 2, y + lw / 2, Math.max(0, w - lw), Math.max(0, h - lw),
            Math.max(0, uniform[0] - lw / 2), 'none', Math.max(0, uniform[1] - lw / 2))
        : (() => {
            const p = document.createElementNS(NS, 'path');
            p.setAttribute('d', roundedRectPath(x + lw / 2, y + lw / 2,
              Math.max(0, w - lw), Math.max(0, h - lw), insetCorners(radii, lw / 2)));
            p.setAttribute('fill', 'none');
            return p;
          })();
      r.setAttribute('stroke', rgbStr(bT.rgb!));
      r.setAttribute('stroke-width', String(lw));
      if (bT.rgb![3] < 1) r.setAttribute('stroke-opacity', String(bT.rgb![3]));
      const dash = borderDashArray(style.borderTopStyle, lw);
      if (dash) {
        r.setAttribute('stroke-dasharray', dash.dash.join(' '));
        if (dash.round) r.setAttribute('stroke-linecap', 'round');
      }
      g.appendChild(r);
    } else {
      const edge = (rect: { rgb: Rgba; el: Element }) => { if (rect.rgb[3] < 1) rect.el.setAttribute('fill-opacity', String(rect.rgb[3])); g.appendChild(rect.el); };
      if (bT.rgb) edge({ rgb: bT.rgb, el: makeSvgRect(NS, x, y, w, bT.bw, 0, rgbStr(bT.rgb)) });
      if (bB.rgb) edge({ rgb: bB.rgb, el: makeSvgRect(NS, x, y + h - bB.bw, w, bB.bw, 0, rgbStr(bB.rgb)) });
      if (bL.rgb) edge({ rgb: bL.rgb, el: makeSvgRect(NS, x, y, bL.bw, h, 0, rgbStr(bL.rgb)) });
      if (bR.rgb) edge({ rgb: bR.rgb, el: makeSvgRect(NS, x + w - bR.bw, y, bR.bw, h, 0, rgbStr(bR.rgb)) });
    }

    // ── Inline SVG passthrough ──────────────────────────────────────────────
    if (tag === 'svg') {
      const clone = el.cloneNode(true) as Element;
      stripCommentNodes(clone);
      unscopeStyleEls(clone);
      clone.setAttribute('x',      String(x));
      clone.setAttribute('y',      String(y));
      clone.setAttribute('width',  String(w));
      clone.setAttribute('height', String(h));
      await inlineBlobUrlsInEl(clone);
      g.appendChild(clone);
      return;
    }

    // ── Image (SVG source → inline vector; bitmap → raster <image>) ───────────
    if (tag === 'img') {
      const src = el.src || el.getAttribute('src') || '';
      if (src && w > 0 && h > 0) {
        // SVG sources stay VECTOR — inline them as a nested <svg>, fitted "meet"
        // (object-fit: contain), instead of a raster <image>. SVG-ness is sniffed
        // from the bytes (asset URLs are blob: with no extension/MIME hint). Mirrors
        // the PDF walker; real bitmaps fall through to the <image> path below.
        let inlineSvg: any = null;
        try { inlineSvg = await inlineSvgFromImg(src); } catch { inlineSvg = null; }
        if (inlineSvg) {
          await inlineBlobUrlsInEl(inlineSvg);
          // Nested-<svg> scaling needs a viewBox; synthesise one from width/height
          // if the source omitted it, so the mark still fits its box.
          if (!inlineSvg.getAttribute('viewBox')) {
            const iw = parseFloat(inlineSvg.getAttribute('width'));
            const ih = parseFloat(inlineSvg.getAttribute('height'));
            if (iw > 0 && ih > 0) inlineSvg.setAttribute('viewBox', `0 0 ${iw} ${ih}`);
          }
          inlineSvg.setAttribute('x',      String(x));
          inlineSvg.setAttribute('y',      String(y));
          inlineSvg.setAttribute('width',  String(w));
          inlineSvg.setAttribute('height', String(h));
          if (!inlineSvg.getAttribute('preserveAspectRatio')) {
            // object-fit → meet (contain) / slice (cover); object-position → alignment.
            // Default (contain, centred) resolves to the prior 'xMidYMid meet'.
            const meetSlice = style.objectFit === 'cover' ? 'slice' : 'meet';
            inlineSvg.setAttribute('preserveAspectRatio', `${preserveAspectRatioAlign(style.objectPosition)} ${meetSlice}`);
          }
          g.appendChild(inlineSvg);
          return;
        }
        try {
          const dataUrl0 = src.startsWith('data:') ? src
            : src.startsWith('blob:') ? await blobToDataUrl(src) : src;
          // CSS filter() (e.g. grayscale/contrast presets) is baked into the bitmap
          // via the browser so the vector image matches screen/PNG instead of
          // exporting full-colour. No-op + graceful fallback when filter is none.
          const dataUrl = await bakeImageFilter(el, dataUrl0, style.filter);
          const rMin = Math.min(
            parseCssLen(style.borderTopLeftRadius,     w),
            parseCssLen(style.borderTopRightRadius,    w),
            parseCssLen(style.borderBottomLeftRadius,  w),
            parseCssLen(style.borderBottomRightRadius, w),
          );
          const isCircle = rMin >= Math.min(w, h) * 0.45;
          const img = document.createElementNS(NS, 'image');
          img.setAttribute('href',   dataUrl);
          img.setAttribute('x',      String(x));
          img.setAttribute('y',      String(y));
          img.setAttribute('width',  String(w));
          img.setAttribute('height', String(h));
          if (isCircle) {
            const clipId = `imgclip-${++uid}`;
            const cp = document.createElementNS(NS, 'clipPath');
            cp.setAttribute('id', clipId);
            const circle = document.createElementNS(NS, 'circle');
            circle.setAttribute('cx', String(x + w / 2));
            circle.setAttribute('cy', String(y + h / 2));
            circle.setAttribute('r',  String(Math.min(w, h) / 2));
            cp.appendChild(circle);
            defs.appendChild(cp);
            img.setAttribute('clip-path',           `url(#${clipId})`);
            img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
          } else if (style.objectFit === 'cover') {
            // Fill the box, cropping the overflow — `slice` clips to the image's own
            // x/y/width/height viewport, so no extra clipPath is needed (matches the
            // on-screen hero/masthead). object-position picks WHICH edge is cropped.
            img.setAttribute('preserveAspectRatio', `${preserveAspectRatioAlign(style.objectPosition)} slice`);
          } else if (style.objectFit === 'contain') {
            // meet-fit the whole image; object-position anchors it within the box.
            // Centre resolves to 'xMidYMid meet' = the SVG default (unchanged).
            img.setAttribute('preserveAspectRatio', `${preserveAspectRatioAlign(style.objectPosition)} meet`);
          }
          g.appendChild(img);
        } catch { /* skip unloadable images */ }
      }
      return;
    }

    // ── overflow:hidden → clip the CONTENT to the box (rounded or square) ──────
    // CSS crops an overflow:hidden box's descendants to the box (its corner curve when
    // rounded); the walker draws each box's own bg but doesn't clip descendants, so a
    // child that spills — a differently-filled titlebar past a rounded edge, or an
    // over-sized image/child past a square edge — would show outside the box. Route
    // children/text/pseudo through a <clipPath> sub-group (rounded fill, or a plain rect
    // when there's no radius); the box-shadow/background/border stay in `g` (unclipped) so
    // an outset shadow still extends past the box. A ROUNDED overflow box always clips (its
    // children must follow the corner curve); a SQUARE one clips only when a descendant
    // ACTUALLY spills (scroll > client) — most overflow:hidden boxes (flex/grid layout) clip
    // nothing visible, and a clip group on every one would bloat the SVG for no change.
    const clipsOverflow = (style.overflowX && style.overflowX !== 'visible') || (style.overflowY && style.overflowY !== 'visible');
    const spillsBox = (el.scrollWidth || 0) > (el.clientWidth || 0) + 1 || (el.scrollHeight || 0) > (el.clientHeight || 0) + 1;
    // ── Overflow clip (decided AFTER the walk — see finaliseOverflowClip) ─────
    // A clip is friction for whoever opens the file next: a designer has to release
    // it before they can edit anything inside. So the group is created optimistically
    // and the clip attribute is only attached at the end, once the descendants have
    // been measured and we know it is doing work. Across the five local fixtures the
    // walker emitted 325 clip defs and 4373 references to them, every one a single
    // shape — most of them around content that never came near the edge.
    let contentG: Element = g;
    let ovClipId: string | null = null;
    let ovBounds: Bounds | null = null;
    const clipCandidate = Boolean(clipsOverflow) && (hasRadius || spillsBox);
    if (clipCandidate) {
      ovClipId = `fcovclip-${++uid}`;
      contentG = document.createElementNS(NS, 'g');
      g.appendChild(contentG);
      ovBounds = newBounds();
    }

    /**
     * Attach the overflow clip, or prove it unnecessary and leave it off.
     *
     * Kept when content genuinely leaves the box (`spillsBox` — the browser's own
     * scrollWidth/scrollHeight verdict, which also catches a text line running past
     * the edge), or when the box is rounded and something painted inside comes close
     * enough to an edge to touch a corner arc.
     *
     * Dropped otherwise, which also means dropping the `clip-path` references that
     * hoisted descendants took with them — a dangling url(#…) would clip them to
     * nothing.
     */
    const finaliseOverflowClip = (): void => {
      if (!ovClipId) return;
      const maxR = hasRadius
        ? Math.max(radii.topLeft[0], radii.topLeft[1], radii.topRight[0], radii.topRight[1],
                   radii.bottomRight[0], radii.bottomRight[1], radii.bottomLeft[0], radii.bottomLeft[1])
        : 0;
      const b = ovBounds;
      const touchesEdge = !b || !b.any ? false
        : b.minX < x + maxR || b.minY < y + maxR || b.maxX > x + w - maxR || b.maxY > y + h - maxR;
      if (spillsBox || (hasRadius && touchesEdge)) {
        const clip = document.createElementNS(NS, 'clipPath');
        clip.setAttribute('id', ovClipId);
        clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
        clip.appendChild(makeRoundedFill(NS, x, y, w, h, radii, uniform, '#fff'));   // 0 radii → a plain rect
        defs.appendChild(clip);
        contentG.setAttribute('clip-path', `url(#${ovClipId})`);
        return;
      }
      // Not needed. Strip the references a hoisted descendant carried, then fold the
      // wrapper away so the output has neither the clip nor an extra empty group.
      for (const ref of Array.from(rootG.querySelectorAll(`[clip-path="url(#${ovClipId})"]`))) {
        ref.removeAttribute('clip-path');
      }
      if (contentG !== g && contentG.parentNode === g) {
        while (contentG.firstChild) g.insertBefore(contentG.firstChild, contentG);
        contentG.remove();
      }
    };

    // ── The stacking context this element's descendants live in ───────────────
    // `parentG` is the in-flow pointer and `ctx.frame` is the stacking pointer.
    // Splitting them is what makes Appendix E §E.2 step 8's parenthetical fall
    // out for free: an element that is POSITIONED but does NOT create a context
    // (`position: relative; z-index: auto`) is deferred into layer 6, its
    // in-flow children append into its own contentG and travel with it, and a
    // `z-index: 5` grandchild defers past it to the ANCESTOR frame's layer 7 —
    // which is exactly what CSS paints, and exactly what a naive
    // "positioned ⇒ treat as a context" implementation gets wrong.
    let ownFrame: ScFrame | null = null;
    // The box descendants are confined to. Rounded corners are ignored here on
    // purpose: this is only ever used to REJECT a node that misses the box entirely,
    // and the outer rectangle is the conservative bound for that.
    const childClipBox = clipCandidate ? intersectRect(cb, { x, y, w, h }) : cb;
    let childCtx: PaintCtx = { frame: ctx.frame, clips: ctx.clips, clipBox: childClipBox, bounds: ovBounds ?? ctx.bounds };
    if (stackingOrder) {
      if (createsCtx) {
        ownFrame = {
          content: contentG,
          // When there is no overflow clip, contentG IS g — so a layer-2 unit
          // inserted at firstChild would land BEHIND this element's own
          // box-shadow/background/border, which §E.2 step 3 puts first. Anchor
          // on the last own-paint node instead. With a clip group, contentG is
          // empty and firstChild is already the right place (anchor null).
          anchor: contentG === g ? g.lastChild : null,
          neg: [], z0: [], pos: [],
        };
        childCtx = { frame: ownFrame, clips: [], clipBox: childClipBox, bounds: ovBounds ?? ctx.bounds };
      } else {
        // Not a context: descendants belong to the SAME frame, but a hoist out
        // of here now crosses this element's overflow clip and must carry it.
        childCtx = { frame: ctx.frame, clips: ovClipId ? ctx.clips.concat(ovClipId) : ctx.clips,
                     clipBox: childClipBox, bounds: ovBounds ?? ctx.bounds };
      }
    }

    // ── Recurse block-level children ────────────────────────────────────────
    // Inline children are left to emitInlineTextSvg below, which walks the inline
    // flow and emits TEXT. That is right for a <span>, and silently wrong for an
    // inline <svg>: the inline walk has no passthrough branch, so the SVG is
    // dropped entirely and nothing warns. An <svg> is replaced content, not text —
    // it has a box of its own at any display value — so route it here regardless.
    // (App icons survived only because the CSS sets them display:block. A bare
    // <svg> defaults to display:inline, which is exactly what a TOOL's own canvas
    // is: the QR code was missing from every page snapshot for this reason. Tool
    // EXPORTS were unaffected — an SVG-rooted canvas takes the renderSvg fast path
    // and never enters this walker.)
    //
    // A flex/grid container paints its items in ORDER-MODIFIED document order
    // (CSS Flexbox §5.4, CSS Grid §6), not raw document order. Pure reorder: the
    // visit PREDICATE is untouched, and it doesn't need to change, because
    // `position: absolute|fixed` blockifies computed display (CSS Display 3
    // §2.7) — so every layer-2/6/7 child already fails the inlineFlow test and
    // is already visited today.
    const kids: Element[] = stackingOrder && isFlexOrGridContainer(style.display)
      ? orderModifiedChildren(renderedChildren(el),
          (c) => Number.parseInt(window.getComputedStyle(c).order || '0', 10) || 0)
      : renderedChildren(el);
    for (const child of kids) {
      if (hasOwnBox(child)) await visitSvgNode(child, contentG, childCtx);
    }
    // Shadow text: a host's own text pass below reads el.childNodes, which for a
    // shadow host is the LIGHT tree — the part that only renders where a <slot> puts
    // it. Text authored inside the shadow root has to be walked from the root itself.
    const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (sr) await emitInlineTextSvg(NS, sr, style, rootRect, contentG, vectorText);

    // ── Inline text ─────────────────────────────────────────────────────────
    await emitInlineTextSvg(NS, el, style, rootRect, contentG, vectorText);

    // ── <canvas> ─────────────────────────────────────────────────────────────
    // The pixels are the content; there is no vector form to recover. Snapshot the
    // backing store the same way snapshotMotion does, so chart/filter/D3 tools and
    // any real page draw something instead of an empty box. A cross-origin-tainted
    // canvas throws on toDataURL — that is unrecoverable, so it degrades to blank
    // with a warning rather than failing the export.
    if (tag === 'canvas') {
      try {
        const url = (el as HTMLCanvasElement).toDataURL('image/png');
        if (url && url.length > 'data:image/png;base64,'.length + 8) {
          const im = document.createElementNS(NS, 'image');
          im.setAttribute('href', url);
          im.setAttribute('x', String(n2(x))); im.setAttribute('y', String(n2(y)));
          im.setAttribute('width', String(n2(w))); im.setAttribute('height', String(n2(h)));
          im.setAttribute('preserveAspectRatio', 'none');
          contentG.appendChild(im);
        }
      } catch (e) {
        _host?.log?.('warn', `svg: <canvas> could not be read (tainted?) — ${(e as Error).message}`);
      }
    }

    // ── Form controls ────────────────────────────────────────────────────────
    // A control's value is not a text node, so the pass above sees nothing and the
    // box comes out empty — the blank URL field and blank Error-correction select on
    // every tool-page snapshot. What it shows is decided in form-controls.ts; the
    // LAYOUT is deliberately not reimplemented here. Instead the text is mirrored
    // into a throwaway element positioned over the control's content box and walked
    // with the same emitInlineTextSvg, so alignment, wrapping, direction, ellipsis
    // and vertical centring come from the browser rather than from a second, worse
    // implementation of CSS. The mirror is removed in a finally.
    await emitControlPaint(el, tag, style, contentG);

    // ── CSS generated content (::before/::after markers) ──────────────────────
    // pseudoDescriptor only models the ABSOLUTELY POSITIONED marker idiom, so
    // every pseudo it emits is by construction a positioned descendant — i.e.
    // §E.2 layer 6/7 (or 2 for a negative-z scrim), never in-flow content. In
    // stacking mode each one therefore gets its own <g> and is placed like any
    // other positioned child, which stops a marker from hiding under a later
    // sibling's background.
    await svgPseudoContent(NS, contentG, rootRect, el, vectorText,
      stackingOrder && childCtx.frame
        ? (z: number) => {
            const pg = document.createElementNS(NS, 'g');
            place(pg, { createsContext: false, reason: '', layer: z < 0 ? 2 : z > 0 ? 7 : 6, z, order: 0 },
              childCtx, contentG);
            return pg;
          }
        : undefined);

    // ── Finalise this stacking context (CSS 2.1 Appendix E §E.2) ──────────────
    // Everything deferred by descendants is appended here, in spec order. This
    // runs AFTER emitInlineTextSvg and svgPseudoContent, so layers 6 and 7 land
    // after layer-5 inline content automatically — a positioned child declared
    // before its parent's text still paints on top of it, which is what CSS does
    // and what DOM order got backwards.
    if (ownFrame) {
      const f = ownFrame;
      // Step 3: negative-z contexts paint AFTER this element's own
      // background/border and BEFORE all in-flow content. `first` is re-read
      // here (not captured earlier) so it reflects the children/text/pseudo that
      // have since been appended. insertBefore against a FIXED anchor preserves
      // insertion sequence — [a], [a,b], [a,b,c] — so the sorted array goes in
      // ascending, most-negative first, with no reverse.
      const first = f.anchor ? f.anchor.nextSibling : f.content.firstChild;
      for (const u of sortUnits(f.neg)) f.content.insertBefore(u.g, first);
      for (const u of f.z0)             f.content.appendChild(u.g);   // step 8 — tree order, NOT z-sorted
      for (const u of sortUnits(f.pos)) f.content.appendChild(u.g);   // step 9
    }

    // Last, because it needs both the measured descendant bounds and the hoisted
    // units to be in place before it can decide — and, if it decides against, strip
    // the references those hoists carried.
    finaliseOverflowClip();
  }

  // KNOWN LIMITATION: the PDF walker (`drawHtmlVectors`) has the identical
  // DOM-order defect and is deliberately untouched, so SVG/EMF/EPS/DXF get
  // stacking order under the flag and PDF does not. That is a new divergence in
  // two walkers whose own comments ask that they stay mirrored; it is recorded
  // at both sites rather than silently accepted.
  // The root call passes NO frame on purpose: `node` itself is the root stacking
  // context (`el === node` forces it), and its own <g> must land in rootG
  // directly. Handing it a frame nobody finalises would silently drop the whole
  // page if the export root ever happened to be positioned.
  await visitSvgNode(node, rootG, { frame: null, clips: [] });
  const xml = injectSvgMeta(new XMLSerializer().serializeToString(svgEl), opts.meta);

  // Parse-check before returning. This walker can emit XML that does not parse,
  // and it does it SILENTLY: the inline-<svg> passthrough clones live DOM and
  // re-serialises it, so one malformed attribute in authored markup (a `<path d="…`
  // that never closes — lib/icons.ts shipped exactly that) becomes an attribute
  // whose value contains `</svg><span class=`, and XMLSerializer faithfully writes
  // it out. The result was a 1.1 MB file, no thrown error, no warning, and it would
  // have been committed as a screenshot baseline.
  //
  // Print-derived output cannot fail this way — it consumes painted output, never
  // authored markup — so this gate is what buys the direct walker the same "fails
  // loudly or not at all" property. DOMParser puts <parsererror> in the result
  // rather than throwing, hence the explicit check.
  try {
    const probe = new DOMParser().parseFromString(xml, 'image/svg+xml');
    const err = probe.getElementsByTagName('parsererror')[0];
    if (err) {
      const detail = (err.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new Error(`renderSvgFromHtml produced XML that does not parse: ${detail}`);
    }
  } catch (e) {
    // Rethrow as a plain, actionable error. Never return the bad bytes: a caller
    // that writes them to disk (the docs screenshot pipeline) has no other way to
    // notice, and a half-valid SVG renders as a blank box in every viewer.
    throw e instanceof Error ? e : new Error(String(e));
  }

  return new Blob(['<?xml version="1.0" standalone="no"?>\n' + xml], { type: 'image/svg+xml' });
}

// Underline / line-through carried by a computed style. text-decoration-line is NOT
// inherited, so a nested <strong>/<span> under a decorated ancestor computes 'none' —
// the walkers therefore OR these flags down the tree rather than reading them only off
// the text node's immediate parent. (Neither vector walker reads text-decoration
// otherwise, so without this underline/strike render on screen but vanish in export.)
interface Deco { u: boolean; s: boolean }
function decoFlags(style: CSSStyleDeclaration): Deco {
  const td = String(style.textDecorationLine || style.textDecoration || '');
  return { u: /underline/.test(td), s: /line-through/.test(td) };
}
function mergeDeco(a: Deco, b: Deco): Deco { return { u: a.u || b.u, s: a.s || b.s }; }

// Walks text nodes and inline elements, emitting one node per text line.
//
// By default each line becomes a true vector <path> (host.text.toPath, HarfBuzz
// shaped) so the SVG is self-contained and renders identically without the font
// installed — no bitmap, no <foreignObject>. Runs we can't vectorise faithfully
// (non-SUSE font, no host.text, letter-spacing) fall back to a positioned <text>
// element. Line positions come from Range.getBoundingClientRect, same strategy as
// renderInlineContent for PDF.
let shadowUid = 0;

async function emitInlineTextSvg(
  NS: string, blockEl: any, blockStyle: CSSStyleDeclaration,
  rootRect: { left: number; top: number }, parentG: Element, vectorText: boolean,
): Promise<void> {
  const textApi = vectorText ? _host?.text : null;
  // Filters need a <defs>. This function is called from both walkers and does not
  // own the document, so the sink is found from the tree it is writing into — the
  // root <svg>'s existing <defs>, or one created on demand.
  const ownerSvg = parentG.ownerDocument?.documentElement?.tagName === 'svg'
    ? parentG.ownerDocument.documentElement : parentG.closest?.('svg');
  const shadowDefs: Element = (ownerSvg?.querySelector?.('defs') as Element | null)
    ?? (() => {
      const d = document.createElementNS(NS, 'defs');
      (ownerSvg ?? parentG).insertBefore(d, (ownerSvg ?? parentG).firstChild);
      return d;
    })();

  async function walk(node: any, nodeStyle: CSSStyleDeclaration, deco: Deco): Promise<void> {
    if (node.nodeType === 3) {
      const text = node.textContent;
      if (!text || !text.trim()) return;
      const col = parseCssColorFull(nodeStyle.color);
      const fillAttr  = col ? `rgb(${col[0]},${col[1]},${col[2]})` : null;
      const alphaAttr = col && col[3] < 1 ? String(col[3]) : null;
      const strokeCol = parseCssColorFull(nodeStyle.stroke);
      const strokeAttr = strokeCol ? `rgb(${strokeCol[0]},${strokeCol[1]},${strokeCol[2]})` : null;
      const strokeOpacityAttr = strokeCol && strokeCol[3] < 1 ? String(strokeCol[3]) : null;
      const strokeWidthAttr = nodeStyle.strokeWidth ? nodeStyle.strokeWidth : null;
      const fontSizePx = parseFloat(nodeStyle.fontSize) || 16;
      // SUSE statics, a user's Google font (decompressed on demand) or the
      // platform face — whichever the family stack resolves to first.
      const vf = textApi ? await resolveVectorFont(nodeStyle, text) : null;
      const fontUrl = vf?.url ?? null;
      const vectorise = canVectoriseText(nodeStyle, fontUrl, Boolean(textApi));
      // Tracking + OpenType feature toggles are baked into the shaped path so the
      // outline matches the on-screen (and raster) run exactly.
      const letterSpacing = letterSpacingPx(nodeStyle.letterSpacing);
      const features = featureSettingsToHb(nodeStyle.fontFeatureSettings);

      // text-shadow, back-to-front (CSS paints the FIRST-listed shadow on top, so the
      // list is drawn in reverse). Each shadow is a DUPLICATE of the run's own
      // geometry — the outlined <path>, or the <text> fallback — recoloured, shifted
      // and blurred, rather than a filter on the original.
      //
      // Duplicates rather than a filter because a filter is all-or-nothing outside
      // SVG: svg-ir skips <filter> entirely, so an EMF/EPS/DXF export would lose the
      // shadow completely. A duplicated path survives those formats, and when the
      // blur is zero — the hard offset idiom — it is exact everywhere with no filter
      // at all.
      const textShadows = parseTextShadow(nodeStyle.textShadow).reverse();
      const appendWithShadows = (el: Element): void => {
        for (const sh of textShadows) {
          const col = parseCssColorFull(sh.color);
          if (!col) continue;
          const copy = el.cloneNode(true) as Element;
          copy.setAttribute('fill', `rgb(${col[0]},${col[1]},${col[2]})`);
          copy.setAttribute('fill-opacity', String(col[3]));
          // A stroke belongs to the text, not to its shadow: CSS shadows the rendered
          // glyph shape, and carrying the original's stroke colour through would draw
          // an outline in the wrong colour on top of the blur.
          copy.removeAttribute('stroke');
          copy.removeAttribute('stroke-width');
          copy.removeAttribute('stroke-opacity');
          // The offset goes on a wrapper so it composes with whatever transform the
          // original already carries (the outlined path is placed by translate()).
          const wrap = document.createElementNS(NS, 'g');
          wrap.setAttribute('transform', `translate(${n2(sh.x)},${n2(sh.y)})`);
          if (sh.blur > 0) {
            const fId = `fctxsh-${++shadowUid}`;
            const filt = document.createElementNS(NS, 'filter');
            filt.setAttribute('id', fId);
            filt.setAttribute('x', '-50%'); filt.setAttribute('y', '-50%');
            filt.setAttribute('width', '200%'); filt.setAttribute('height', '200%');
            // sRGB, because CSS composites shadows in sRGB and SVG's filter default
            // is linearRGB — the same blur looks materially lighter without this.
            filt.setAttribute('color-interpolation-filters', 'sRGB');
            const fe = document.createElementNS(NS, 'feGaussianBlur');
            fe.setAttribute('stdDeviation', String(n2(sh.blur / 2)));   // CSS blur radius → σ
            filt.appendChild(fe);
            shadowDefs.appendChild(filt);
            wrap.setAttribute('filter', `url(#${fId})`);
          }
          wrap.appendChild(copy);
          parentG.appendChild(wrap);
        }
        parentG.appendChild(el);
      };

      // Emit one run, positioned at its own line box `r`. Used per visual line.
      const placeLine = async (lineText: string, r: DOMRect) => {
        lineText = applyTextTransform(lineText, nodeStyle.textTransform);
        const x = r.left - rootRect.left;
        const top = r.top - rootRect.top;
        if (vectorise) {
          try {
            // `notdef` > 0 means this face has no glyph for something in the run —
            // outlining would draw tofu, so keep the <text> fallback instead.
            const { d, notdef } = await textApi!.toPath({ text: lineText, fontUrl: fontUrl!, fontSize: fontSizePx, features: features as string[], letterSpacing, variations: vf!.variations, fallbackFonts: vf!.fallbacks });
            if (d && !notdef) {
              const { ascent, descent } = fontMetricsPx(nodeStyle, fontSizePx);
              const by = textBaselineY(top, r.height, ascent, descent);
              const p = document.createElementNS(NS, 'path');
              p.setAttribute('d', d);
              p.setAttribute('transform', `translate(${n2(x)},${n2(by)})`);
              if (fillAttr)  p.setAttribute('fill', fillAttr);
              if (alphaAttr) p.setAttribute('fill-opacity', alphaAttr);
              // Preserve text stroke in vector export
              if (strokeAttr) p.setAttribute('stroke', strokeAttr);
              if (strokeWidthAttr) p.setAttribute('stroke-width', strokeWidthAttr);
              if (strokeOpacityAttr) p.setAttribute('stroke-opacity', strokeOpacityAttr);
              appendWithShadows(p);
              return;
            }
          } catch (e) {
            _host?.log?.('warn', `svg: text-to-path failed, using <text> — ${(e as Error).message}`);
          }
        }
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x',                 String(n2(x)));
        t.setAttribute('y',                 String(n2(top)));
        t.setAttribute('dominant-baseline', 'text-before-edge');
        t.setAttribute('font-size',         nodeStyle.fontSize);
        t.setAttribute('font-weight',       nodeStyle.fontWeight);
        t.setAttribute('font-style',        nodeStyle.fontStyle);
        t.setAttribute('font-family',       nodeStyle.fontFamily);
        if (nodeStyle.letterSpacing && nodeStyle.letterSpacing !== 'normal') {
          t.setAttribute('letter-spacing', nodeStyle.letterSpacing);
        }
        if (fillAttr)  t.setAttribute('fill',         fillAttr);
        if (alphaAttr) t.setAttribute('fill-opacity', alphaAttr);
        // Preserve text stroke in fallback <text> element
        if (strokeAttr) t.setAttribute('stroke', strokeAttr);
        if (strokeWidthAttr) t.setAttribute('stroke-width', strokeWidthAttr);
        if (strokeOpacityAttr) t.setAttribute('stroke-opacity', strokeOpacityAttr);
        t.textContent = lineText;
        appendWithShadows(t);
      };

      // Draw underline / strikethrough as filled rects spanning the line box, in the
      // run's own colour — text-decoration is otherwise dropped by the vector walk.
      const drawDeco = (r: DOMRect) => {
        if (!fillAttr || (!deco.u && !deco.s)) return;
        const x = r.left - rootRect.left;
        const top = r.top - rootRect.top;
        const { ascent, descent } = fontMetricsPx(nodeStyle, fontSizePx);
        const by = textBaselineY(top, r.height, ascent, descent);
        const thick = Math.max(0.75, fontSizePx * 0.06);
        const bar = (yc: number) => {
          const rect = document.createElementNS(NS, 'rect');
          rect.setAttribute('x', String(n2(x)));
          rect.setAttribute('y', String(n2(yc - thick / 2)));
          rect.setAttribute('width', String(n2(r.width)));
          rect.setAttribute('height', String(n2(thick)));
          rect.setAttribute('fill', fillAttr);
          if (alphaAttr) rect.setAttribute('fill-opacity', alphaAttr);
          parentG.appendChild(rect);
        };
        if (deco.u) bar(by + fontSizePx * 0.11);   // just below the baseline
        if (deco.s) bar(by - fontSizePx * 0.28);   // through the x-height
      };

      // Split on explicit newlines first, then on soft wraps within each segment
      // (CSS-wrapped text has no '\n'). Each visual line is shaped and placed on
      // its own baseline; without this a wrapped run collapses onto one line.
      const segs = text.split('\n');
      let offset = 0;
      for (const seg of segs) {
        if (seg.trim().length > 0) {
          for (const line of visualLines(node, offset, offset + seg.length)) {
            if (line.rect.width > 0.5 && line.rect.height > 0.5) {
              await placeLine(line.text, line.rect);
              drawDeco(line.rect);
            }
          }
        }
        offset += seg.length + 1; // +1 for the '\n'
      }

    } else if (node.nodeType === 1) {
      if (node.tagName.toLowerCase() === 'br') return;
      const s = window.getComputedStyle(node);
      if (s.display === 'none') return;
      // Non-replaced `display: inline` only. Anything with a box of its own —
      // inline-block, inline-flex, an <input>, an inline <svg> — is visited by
      // visitSvgNode, which paints its background, border and text as a unit.
      // Descending into it here as well would draw its text a second time.
      if (s.display !== 'inline' || isReplaced(node)) return;
      const cd = mergeDeco(deco, decoFlags(s));
      for (const child of node.childNodes) await walk(child, s, cd);
    }
  }
  for (const child of blockEl.childNodes) await walk(child, blockStyle, decoFlags(blockStyle));
}

/** Elements whose box is drawn by the UA rather than by their children: replaced
 *  content and form controls. They default to `display: inline` but are atomic —
 *  the inline text walk has nothing to find inside them. */
const REPLACED = new Set(['img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed',
                          'input', 'select', 'textarea', 'progress', 'meter']);
export function isReplaced(el: Element): boolean {
  return REPLACED.has(el.tagName.toLowerCase());
}

/**
 * Does this child have a box the block walk must paint?
 *
 * Everything except a non-replaced `display: inline`, whose background and text are
 * the inline walk's job. This predicate is the whole reason an inline-block's
 * background used to vanish: the loop tested for "inline flow" and skipped
 * inline-block and inline-flex along with inline, leaving them to a text pass that
 * paints no boxes at all — and leaving a replaced control, which has no text nodes,
 * emitting nothing whatsoever.
 *
 * `display: contents` has no box of its own but its CHILDREN do, and visitSvgNode
 * recurses, so it is included rather than dropped.
 */
/**
 * The children this element actually RENDERS — the flat tree, not the DOM tree.
 *
 * A shadow host renders its shadow root's children, not its own; its light children
 * appear only where a <slot> places them. Walking `el.children` therefore missed the
 * entire shadow tree (39–51 rendered elements per page in this app, which is
 * jelly-ui) while walking both would paint slotted content twice.
 */
export function renderedChildren(el: Element): Element[] {
  const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  if (sr) return Array.from(sr.children) as Element[];
  if (el.tagName.toLowerCase() === 'slot') {
    // flatten:true resolves a slot forwarded into another slot.
    return (el as HTMLSlotElement).assignedElements?.({ flatten: true }) ?? [];
  }
  return Array.from(el.children) as Element[];
}

export function hasOwnBox(child: Element): boolean {
  const cd = window.getComputedStyle(child).display;
  return cd !== 'inline' || isReplaced(child);
}


// Split a text node's [start,end) offset range into visual lines, so CSS soft
// wrapping (which inserts no '\n') is honoured. We walk characters and start a
// new line whenever a glyph's top jumps; each line's edge whitespace is trimmed
// so its rect.left aligns with the first rendered glyph (collapsed leading spaces
// would otherwise shift the shaped run). Returns [{ text, rect }] per line.
function visualLines(node: Node, start: number, end: number): { text: string; rect: DOMRect }[] {
  const probe = document.createRange();
  const breaks = [start];
  let prevTop: number | null = null;
  for (let i = start; i < end; i++) {
    probe.setStart(node, i);
    probe.setEnd(node, i + 1);
    const rects = probe.getClientRects();
    if (!rects.length) continue; // collapsed whitespace contributes no box
    const top = rects[rects.length - 1]!.top;
    if (prevTop === null) prevTop = top;
    else if (Math.abs(top - prevTop) > 0.5) { breaks.push(i); prevTop = top; }
  }
  breaks.push(end);

  const full = node.textContent as string;
  const out: { text: string; rect: DOMRect }[] = [];
  for (let k = 0; k + 1 < breaks.length; k++) {
    let s = breaks[k]!, e = breaks[k + 1]!;
    const slice = full.slice(s, e);
    s += slice.length - slice.replace(/^\s+/, '').length; // drop leading ws
    e -= slice.length - slice.replace(/\s+$/, '').length; // drop trailing ws
    if (e <= s) continue;
    probe.setStart(node, s);
    probe.setEnd(node, e);
    out.push({ text: full.slice(s, e), rect: probe.getBoundingClientRect() });
  }
  return out;
}

// Font ascent/descent in px for a computed style, via a reused canvas 2D context.
// fontBoundingBox* are font-level (sample text doesn't matter); the actualBounding
// and ratio fallbacks cover the rare engine without the fontBoundingBox metrics.
let _measureCtx: CanvasRenderingContext2D | null = null;
function fontMetricsPx(style: CSSStyleDeclaration, fontSizePx: number): { ascent: number; descent: number } {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  _measureCtx!.font =
    `${style.fontStyle || 'normal'} ${style.fontWeight || 400} ${fontSizePx}px ${style.fontFamily || 'sans-serif'}`;
  const m = _measureCtx!.measureText('Mg');
  const ascent  = m.fontBoundingBoxAscent  ?? m.actualBoundingBoxAscent  ?? fontSizePx * 0.8;
  const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? fontSizePx * 0.2;
  return { ascent, descent };
}

interface PseudoDescriptor {
  text: string; bg: Rgba | null; radii: CornerRadii; uniform: CornerPair | null;
  w: number; h: number; ps: CSSStyleDeclaration; x: number; y: number;
}

// Resolve a CSS generated-content pseudo-element (::before/::after) into a drawable
// descriptor, or null if it has nothing visible. The DOM walkers only see real
// nodes, so list markers / arrows authored as ::before content (e.g. dynamic-layout's
// bullet dots and → arrows) are otherwise dropped from SVG/PDF. Scoped to the
// absolutely-positioned marker idiom — a pseudo has no getBoundingClientRect, so its
// box is computed from its containing block (nearest positioned ancestor) padding box
// + the pseudo's own left/top/size. The padding box's origin is the padding EDGE —
// just inside the border, NOT inside the padding (CSS 2.1 §10.1) — so the offset adds
// border widths only. Inline/static generated content isn't modelled.
function pseudoDescriptor(el: Element, name: string): PseudoDescriptor | null {
  const ps = window.getComputedStyle(el, name);
  const content = ps.content;
  if (!content || content === 'none' || content === 'normal') return null;
  if (ps.position !== 'absolute') return null;
  const w = parseFloat(ps.width)  || 0;
  const h = parseFloat(ps.height) || 0;
  const bg = parseCssColorFull(ps.backgroundColor);
  // getComputedStyle returns the resolved string with real chars (e.g. '"→"'),
  // already quoted; unwrap it. counter()/attr() values won't match and are skipped.
  const m = content.match(/^["'](.*)["']$/s);
  const text = applyTextTransform(m ? m[1]! : '', ps.textTransform);
  if (!text.trim() && !(bg && w > 0.5 && h > 0.5)) return null;

  let cb: Element | null = el;
  while (cb && window.getComputedStyle(cb).position === 'static') cb = cb.parentElement;
  cb = cb || el;
  const cbRect = cb.getBoundingClientRect();
  const cbStyle = window.getComputedStyle(cb);
  const ox = cbRect.left + (parseFloat(cbStyle.borderLeftWidth) || 0);
  const oy = cbRect.top  + (parseFloat(cbStyle.borderTopWidth)  || 0);
  const left = parseFloat(ps.left);
  const top  = parseFloat(ps.top);
  const { radii, uniform } = resolveRadii(ps, w, h);
  return {
    text, bg, radii, uniform, w, h, ps,
    x: ox + (isFinite(left) ? left : 0),
    y: oy + (isFinite(top)  ? top  : 0),
  };
}

// Emit any ::before/::after markers of `el` into the SVG group `parentG`.
//
// `defer` (page-snapshot stacking-order mode only) supplies a <g> for one pseudo
// given its used z-index, having already placed that <g> in the right Appendix E
// layer of the enclosing stacking context. Absent ⇒ everything appends to
// parentG exactly as before, which is what every tool export does.
async function svgPseudoContent(
  NS: string, parentG: Element, rootRect: { left: number; top: number }, el: Element, vectorText: boolean,
  defer?: (z: number) => Element,
): Promise<void> {
  for (const name of ['::before', '::after']) {
    const ds = pseudoDescriptor(el, name);
    if (!ds) continue;
    const x = ds.x - rootRect.left;
    const y = ds.y - rootRect.top;
    // pseudoDescriptor already guarantees `position: absolute`, so the pseudo is
    // a positioned descendant; only its z-index decides which layer.
    const zRaw = (ds.ps.zIndex || 'auto').trim();
    const parentG_ = defer ? defer(zRaw === 'auto' ? 0 : (Number.parseInt(zRaw, 10) || 0)) : parentG;
    if (ds.bg && ds.w > 0.5 && ds.h > 0.5) {
      const f = ds.bg[3] < 1
        ? `rgba(${ds.bg[0]},${ds.bg[1]},${ds.bg[2]},${ds.bg[3]})`
        : `rgb(${ds.bg[0]},${ds.bg[1]},${ds.bg[2]})`;
      parentG_.appendChild(makeRoundedFill(NS, x, y, ds.w, ds.h, ds.radii, ds.uniform, f));
    }
    if (!ds.text.trim()) continue;
    const fontSizePx = parseFloat(ds.ps.fontSize) || 16;
    const vf = vectorText && _host?.text ? await resolveVectorFont(ds.ps, ds.text) : null;
    const fontUrl = vf?.url ?? null;
    const col = parseCssColorFull(ds.ps.color);
    const fillAttr  = col ? `rgb(${col[0]},${col[1]},${col[2]})` : null;
    const alphaAttr = col && col[3] < 1 ? String(col[3]) : null;
    const lineH = parseFloat(ds.ps.lineHeight) || fontSizePx * 1.2;
    let placed = false;
    if (vectorText && canVectoriseText(ds.ps, fontUrl, Boolean(_host?.text))) {
      try {
        const { d, notdef } = await _host!.text!.toPath({ text: ds.text, fontUrl: fontUrl!, fontSize: fontSizePx, variations: vf!.variations, fallbackFonts: vf!.fallbacks });
        if (d && !notdef) {
          const { ascent, descent } = fontMetricsPx(ds.ps, fontSizePx);
          const by = textBaselineY(y, lineH, ascent, descent);
          const p = document.createElementNS(NS, 'path');
          p.setAttribute('d', d);
          p.setAttribute('transform', `translate(${n2(x)},${n2(by)})`);
          if (fillAttr)  p.setAttribute('fill', fillAttr);
          if (alphaAttr) p.setAttribute('fill-opacity', alphaAttr);
          parentG_.appendChild(p);
          placed = true;
        }
      } catch (e) { _host?.log?.('warn', `svg: pseudo text-to-path failed — ${(e as Error).message}`); }
    }
    if (!placed) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x',                 String(n2(x)));
      t.setAttribute('y',                 String(n2(y)));
      t.setAttribute('dominant-baseline', 'text-before-edge');
      t.setAttribute('font-size',         ds.ps.fontSize);
      t.setAttribute('font-weight',       ds.ps.fontWeight);
      t.setAttribute('font-style',        ds.ps.fontStyle);
      t.setAttribute('font-family',       ds.ps.fontFamily);
      if (fillAttr)  t.setAttribute('fill',         fillAttr);
      if (alphaAttr) t.setAttribute('fill-opacity', alphaAttr);
      t.textContent = ds.text;
      parentG_.appendChild(t);
    }
  }
}

function makeSvgRect(NS: string, x: number, y: number, w: number, h: number, rx: number, fill: string, ry: number = rx): Element {
  const r = document.createElementNS(NS, 'rect');
  r.setAttribute('x',      String(x));
  r.setAttribute('y',      String(y));
  r.setAttribute('width',  String(w));
  r.setAttribute('height', String(h));
  // rx/ry are already CSS-clamped by resolveRadii/css-box (rx≤w/2, ry≤h/2), so the SVG
  // renderer won't re-clamp them per-axis into an ellipse. Emit both axes.
  if (rx > 0 || ry > 0) { r.setAttribute('rx', String(rx)); r.setAttribute('ry', String(ry)); }
  r.setAttribute('fill', fill);
  return r;
}

// Builds a <linearGradient> SVG element from a CSS linear-gradient() value.
// Uses gradientUnits="userSpaceOnUse" so coordinates match the canvas space.
// Returns null if the value is not a parseable linear gradient.
function buildLinearGradientEl(NS: string, bgImage: string, elX: number, elY: number, elW: number, elH: number, uid: number): Element | null {
  const m = bgImage.match(/^linear-gradient\((.+)\)$/s);
  if (!m) return null;
  const parts = splitCssArgs(m[1]!);
  if (parts.length < 2) return null;

  let angleRad = Math.PI; // default: to bottom
  let stopsStart = 0;
  const first = parts[0]!.trim();
  if (/^to\s|deg$|turn$|rad$|grad$/.test(first)) {
    angleRad  = parseGradientAngle(first);
    stopsStart = 1;
  }

  const stops = parts.slice(stopsStart);
  if (stops.length < 2) return null;

  // Gradient line through the element centre; length guarantees full coverage
  // at any angle via: |w·sin(A)| + |h·cos(A)| / 2.
  const sinA = Math.sin(angleRad);
  const cosA = Math.cos(angleRad);
  const cx   = elX + elW / 2;
  const cy   = elY + elH / 2;
  const len  = (Math.abs(elW * sinA) + Math.abs(elH * cosA)) / 2;

  const grad = document.createElementNS(NS, 'linearGradient');
  grad.setAttribute('id',            `svggrad-${uid}`);
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  grad.setAttribute('x1', String(cx - sinA * len));
  grad.setAttribute('y1', String(cy + cosA * len));
  grad.setAttribute('x2', String(cx + sinA * len));
  grad.setAttribute('y2', String(cy - cosA * len));

  const n = stops.length;
  stops.forEach((raw: string, i: number) => {
    const { colorStr, opacity, offset } = parseGradientStop(raw.trim(), i, n);
    if (!colorStr) return;
    const s = document.createElementNS(NS, 'stop');
    s.setAttribute('offset',     offset);
    s.setAttribute('stop-color', colorStr);
    if (opacity < 1) s.setAttribute('stop-opacity', String(opacity));
    grad.appendChild(s);
  });

  return grad.childNodes.length >= 2 ? grad : null;
}

// Builds a <radialGradient> SVG element from a CSS radial-gradient() value. Geometry
// (centre + rx/ry in box px) + stops come from the engine's parseRadialGradient; here we
// only assemble the SVG. An ellipse (rx≠ry) is emitted as a circle of radius rx with a
// y-scale gradientTransform about the centre. gradientUnits="userSpaceOnUse" so coords
// match the canvas. Returns null if the value isn't a parseable radial gradient.
/**
 * A conic gradient as a fan of wedges.
 *
 * Each wedge is a solid-filled pie slice between two angles, its colour sampled from
 * the stop list at the wedge's midpoint. Enough wedges and the banding is below the
 * threshold anyone can see; the count scales with the box so a small dial doesn't pay
 * for a page background's smoothness.
 *
 * The radius reaches the FARTHEST corner from the centre — a conic gradient covers
 * the whole box even when its centre is off to one side, and using half the diagonal
 * would leave an unpainted crescent.
 *
 * CSS measures the angle clockwise from 12 o'clock; SVG's coordinate zero is at 3
 * o'clock. The −90° here is that difference, and dropping it rotates every gradient
 * on the page by a quarter turn.
 */
function conicFanEl(NS: string, cg: ConicGradient, x: number, y: number, w: number, h: number, gid: number): Element | null {
  const cx = x + cg.cx, cy = y + cg.cy;
  const R = Math.max(
    Math.hypot(cg.cx, cg.cy), Math.hypot(w - cg.cx, cg.cy),
    Math.hypot(cg.cx, h - cg.cy), Math.hypot(w - cg.cx, h - cg.cy),
  );
  if (!(R > 0) || !Number.isFinite(R)) return null;

  // Stops as fractions of the sweep, in order, with any unpositioned ones already
  // spread evenly by parseGradientStop.
  const raw = cg.stops
    .map((st) => ({
      col: st.colorStr!, op: st.opacity,
      at: parseFloat(st.offset) / (st.offset.endsWith('%') ? 100 : 360),
      // Parsed once per stop, not once per sampled wedge (this fan is up to 360 of them).
      cc: parseColor(st.colorStr!),
    }))
    .filter((st) => Number.isFinite(st.at));
  if (raw.length < 2) return null;
  // CSS gradient stop fixup: an offset smaller than the one before it is CLAMPED up
  // to it, which is how a hard-edged stop is written (`red 0 25%, blue 0 50%`).
  // Sorting instead would silently reorder those into a smooth ramp — and the
  // checkerboard behind every tool canvas is exactly that idiom.
  const stops = raw.map((st, i, all) => ({ ...st, at: i ? Math.max(st.at, all[i - 1]!.at) : st.at }));
  for (let i = 1; i < stops.length; i++) stops[i]!.at = Math.max(stops[i]!.at, stops[i - 1]!.at);

  // A repeating gradient's stop list is ONE period that tiles around the circle.
  const first = stops[0]!.at, last = stops[stops.length - 1]!.at;
  const period = cg.repeating && last > first ? last - first : 0;

  const sample = (tRaw: number): { col: string; op: number } => {
    const t = period ? first + (((tRaw - first) % period) + period) % period : tRaw;
    if (t <= stops[0]!.at) return stops[0]!;
    const last = stops[stops.length - 1]!;
    if (t >= last.at) return last;
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]!, b = stops[i]!;
      if (t <= b.at) {
        const span = b.at - a.at;
        const f = span > 0 ? (t - a.at) / span : 0;
        if (!a.cc || !b.cc) return f < 0.5 ? a : b;
        // sRGB interpolation, PREMULTIPLIED — matching what the browser paints for
        // the same conic (CSS Color 4 §12.3). Lerping the channels raw instead drags
        // a `red → transparent` sweep through dark red at 50% instead of holding red
        // and fading it, so the exported fan disagreed with the screen. The engine
        // owns the maths (one interpolator for every format).
        const mixed = interpolateColor(a.cc, b.cc, f, { space: 'srgb' });
        const [r, g, bl, al] = colorToSrgb8(mixed);
        // Alpha rides on fill-opacity below, so the fill itself is the opaque colour.
        return { col: `rgb(${r},${g},${bl})`, op: al };
      }
    }
    return last;
  };

  // One wedge per ~1.5° at page scale, fewer for a small dial. Capped so a huge
  // element cannot emit thousands of paths.
  const n = Math.max(48, Math.min(360, Math.round(R / 2)));
  const g = document.createElementNS(NS, 'g');
  const base = cg.fromRad - Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const a0 = base + t0 * 2 * Math.PI;
    // Overlap each wedge into the next by a hair: exact shared edges leave a visible
    // seam of background colour where two antialiased edges meet.
    const a1 = base + t1 * 2 * Math.PI + 0.004;
    const { col, op } = sample((t0 + t1) / 2);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d',
      `M${n2(cx)} ${n2(cy)}L${n2(cx + R * Math.cos(a0))} ${n2(cy + R * Math.sin(a0))}` +
      `A${n2(R)} ${n2(R)} 0 0 1 ${n2(cx + R * Math.cos(a1))} ${n2(cy + R * Math.sin(a1))}Z`);
    p.setAttribute('fill', col);
    if (op < 1) p.setAttribute('fill-opacity', String(Math.round(op * 1000) / 1000));
    p.setAttribute('shape-rendering', 'crispEdges');
    g.appendChild(p);
  }
  void gid;
  return g;
}

function buildRadialGradientEl(NS: string, bgImage: string, elX: number, elY: number, elW: number, elH: number, uid: number): Element | null {
  const g = parseRadialGradient(bgImage, elW, elH);
  if (!g) return null;
  const { rx, ry } = g;
  const CX = elX + g.cx, CY = elY + g.cy;
  const grad = document.createElementNS(NS, 'radialGradient');
  grad.setAttribute('id',            `svggrad-${uid}`);
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  grad.setAttribute('cx', String(n2(CX)));
  grad.setAttribute('cy', String(n2(CY)));
  grad.setAttribute('r',  String(n2(rx)));
  if (Math.abs(rx - ry) > 0.01) {
    const sy = ry / rx;                            // scale y about CY: leaves cx/cy fixed
    grad.setAttribute('gradientTransform', `matrix(1,0,0,${n2(sy)},0,${n2(CY * (1 - sy))})`);
  }
  for (const { colorStr, opacity, offset } of g.stops) {
    const s = document.createElementNS(NS, 'stop');
    // A px stop offset is a distance along the radius → fraction of rx (SVG stops take
    // 0–1 / %); percentages pass through unchanged.
    s.setAttribute('offset', offset.endsWith('px') ? `${n2(parseFloat(offset) / rx * 100)}%` : offset);
    s.setAttribute('stop-color', colorStr!);
    if (opacity < 1) s.setAttribute('stop-opacity', String(opacity));
    grad.appendChild(s);
  }
  return grad.childNodes.length >= 2 ? grad : null;
}




// Build an SVG <filter> of chained <feDropShadow> primitives for the given shadows
// (parsed DOM-free by the engine's parseDropShadowFilter). A generous filter region
// (-50%…200%) keeps large offsets/blurs from being clipped.
/**
 * `filter: drop-shadow(…)` as an SVG filter.
 *
 * The blur value is used as the standard deviation DIRECTLY, which is the one thing
 * here that looks like a bug and is not. `box-shadow: … 12px` and
 * `drop-shadow(… 12px)` do NOT produce the same blur: box-shadow's value is a radius
 * of 2σ, drop-shadow's IS σ. Measured against Chromium at blur 4, 6, 12, 24 and 40,
 * σ = blur is exact (0.000% pixel error) and σ = blur/2 — which this used to emit,
 * on the reasonable-sounding grounds that it "matches box-shadow" — is off by up to
 * 2.3% mean and 12.5% on a single pixel.
 */
function buildDropShadowFilterEl(NS: string, shadows: { dx: number; dy: number; blur: number; color: string }[], id: string,
                                 box?: { x: number; y: number; w: number; h: number }): Element {
  const filt = document.createElementNS(NS, 'filter');
  filt.setAttribute('id', id);
  // A region sized from the actual blur and offsets. The old -50%/200% bounding-box
  // form is a fraction of the ELEMENT, so a big blur on a small element was clipped
  // by its own filter region.
  const reach = shadows.reduce((n, sh) => Math.max(n, sh.blur * 3 + Math.abs(sh.dx) + Math.abs(sh.dy)), 0) + 8;
  if (box) {
    filt.setAttribute('filterUnits', 'userSpaceOnUse');
    filt.setAttribute('x', String(n2(box.x - reach))); filt.setAttribute('y', String(n2(box.y - reach)));
    filt.setAttribute('width', String(n2(box.w + 2 * reach))); filt.setAttribute('height', String(n2(box.h + 2 * reach)));
  } else {
    filt.setAttribute('x', '-50%'); filt.setAttribute('y', '-50%');
    filt.setAttribute('width', '200%'); filt.setAttribute('height', '200%');
  }
  // CSS composites filters in sRGB; SVG's default is linearRGB.
  filt.setAttribute('color-interpolation-filters', 'sRGB');
  for (const sh of shadows) {
    const fe = document.createElementNS(NS, 'feDropShadow');
    fe.setAttribute('dx', String(n2(sh.dx)));
    fe.setAttribute('dy', String(n2(sh.dy)));
    fe.setAttribute('stdDeviation', String(n2(sh.blur)));   // NOT blur/2 — see above
    const col = parseCssColorFull(sh.color);
    if (col) { fe.setAttribute('flood-color', `rgb(${col[0]},${col[1]},${col[2]})`); fe.setAttribute('flood-opacity', String(col[3])); }
    else fe.setAttribute('flood-color', sh.color);
    filt.appendChild(fe);
  }
  return filt;
}

// Resolve the print-marks geometry for a PDF export, or null when no bleed and
// no marks are requested (the legacy "page == trim, art fills it" path). The
// geometry (page boxes + mark primitives, in points, top-left origin) is the
// engine's single source of truth — see engine/src/print-marks.js.
function printGeometry(node: Element, opts: ExportOpts, paletteSource: BrandPaletteEntry[] | undefined = opts.palette): PrintGeometry | null {
  const bleedDim = parseDimension(opts.bleed);
  const bleedPt = bleedDim ? toPoints(bleedDim) : 0;
  const marks = {
    crop:         Boolean(opts.cropMarks),
    registration: Boolean(opts.registrationMarks),
    bleed:        Boolean(opts.bleedMarks),
    colorBars:    Boolean(opts.colorBars),
    provenance:   Boolean(opts.provenance),
  };
  const anyMark = marks.crop || marks.registration || marks.bleed || marks.colorBars || marks.provenance;
  if (bleedPt <= 0 && !anyMark) return null;
  const d = exportDims(node, opts);
  // Brand swatches drive the verification half of the colour bar (RGB reference
  // beside CMYK substitution). The CMYK PDF passes only the inks that actually
  // substituted (see renderCmykPdf); the plain RGB PDF has no palette and gets
  // the generic process/overprint/tint bar.
  const palette = marks.colorBars ? brandSwatchPalette(paletteSource) : [];
  return computePrintGeometry({ trimWpt: toPoints(d.w), trimHpt: toPoints(d.h), bleedPt, marks, palette });
}


// Render the artwork to a jsPDF blob. Without geometry the page is the trim size
// and the design fills it (unchanged legacy behaviour, incl. optional jsPDF
// encryption). With geometry the page is the full sheet and the design is drawn
// (scaled) into the bleed box; page boxes + marks are added later in pdf-lib.
async function renderArtworkPdf(node: Element, opts: ExportOpts, geo: PrintGeometry | null): Promise<Blob> {
  const mod: any = await import('jspdf');
  const jsPDF = mod.jsPDF ?? mod.default?.jsPDF ?? mod.default;

  // Page size in points (1/72"). Physical units convert exactly; px maps via
  // the CSS 96-DPI convention, preserving existing pixel-based tools.
  const d = exportDims(node, opts);
  const trimW = toPoints(d.w);
  const trimH = toPoints(d.h);
  const pageW = geo ? geo.page.w : trimW;
  const pageH = geo ? geo.page.h : trimH;
  const art   = geo ? geo.artwork : { x: 0, y: 0, w: trimW, h: trimH };

  // orientation must be derived from the actual dimensions — jsPDF's default
  // 'portrait' mode swaps format[0] and format[1] when width > height, which
  // would produce an inverted page with all drawHtmlVectors coordinates wrong.
  const orientation = pageW >= pageH ? 'landscape' : 'portrait';

  // A non-empty opts.password locks the PDF on open via jsPDF's standard security
  // handler (user = owner password; printing-only permissions). Only the plain
  // RGB path with NO print finishing encrypts — print marks/boxes are applied in
  // pdf-lib, which can't write encrypted PDFs, so the two are mutually exclusive
  // (the UI hides the password field when marks/bleed are on). `undefined` is a
  // no-op (jsPDF treats it as unencrypted).
  const encryption = (opts.password && !geo)
    ? { userPassword: opts.password, ownerPassword: opts.password, userPermissions: ['print'] }
    : undefined;
  const pdf = new jsPDF({ unit: 'pt', format: [pageW, pageH], orientation, encryption });
  applyPdfMeta(pdf, opts.meta);

  // SVG-rooted canvas (the node IS an <svg>, or its only meaningful child is) →
  // walk the SVG element directly as vectors. This avoids drawHtmlVectors, which
  // skips SVG elements that have `display:inline` (the HTML default), resulting
  // in a blank page for tools like the QR code generator whose template is just
  // a bare <svg> with no explicit display:block.
  const svgRoot = node.tagName?.toLowerCase() === 'svg' ? node
    : isSvgRooted(node) ? node.querySelector('svg') : null;
  if (svgRoot) {
    await drawSvgVectorsInRegion(pdf, svgRoot, art.x, art.y, art.w, art.h, new Set(), opts._imprintSink);
  } else {
    await drawHtmlVectors(pdf, node, art.x, art.y, art.w, art.h, opts.convertPaths !== false, opts.onProgress, opts.rasterFallback !== false, opts._imprintSink);
  }

  return pdf.output('blob');
}

// Stamp the document-info dictionary (creator/author/title/…) onto a jsPDF
// instance. Shared by the single-page and multi-page paths.
function applyPdfMeta(pdf: any, m: ExportMeta | null | undefined): void {
  const creator = m?.software || 'Lolly';
  pdf.setProperties({
    creator,                               // the producing app always
    author: m?.author || creator,          // the user if known, else the app
    title: m?.tool || undefined,
    subject: m?.description || undefined,
    keywords: m ? [m.software, m.source, m.contact].filter(Boolean).join(', ') : undefined,
  });
}

// Strong tier — AES-256 (R6 / ISO 32000-2) applied as a FINAL encrypt-last pass
// over already-finished PDF bytes. Unlike the jsPDF-native 40-bit RC4 `password`
// (which must be built into an unfinished document), this reopens the finished
// bytes with pdf-lib and encrypts every string/stream, so it composes with the
// PDF/X-4 / CMYK / print-marks finishing passes. The engine owns the crypto
// (buildEncryptDictValues / encryptObjectBytes — DOM-free, byte-vector-tested);
// this function owns the pdf-lib object walk + /Encrypt dict assembly. R6 uses one
// file key for every object (no per-object derivation) and a fresh IV per object.
async function encryptPdfStrong(blob: Blob, password: string): Promise<Blob> {
  const { PDFDocument, PDFString, PDFHexString, PDFRawStream, PDFStream, PDFDict, PDFArray } =
    await import('pdf-lib') as any;
  // updateMetadata:false — the finished bytes already carry Lolly's /Producer +
  // dates (from applyPdfX / renderCmykPdf); pdf-lib would otherwise overwrite them
  // with "pdf-lib …" + the load time, which we'd then encrypt into the file (and it
  // would disagree with the still-Lolly XMP). Same guard finishPdfX uses.
  const doc = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { updateMetadata: false });
  const ctx = doc.context;

  const rnd = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const hexU = (b: Uint8Array): string => {
    let s = '';
    for (const x of b) s += x.toString(16).padStart(2, '0');
    return s.toUpperCase();
  };

  // Permissions: grant everything (P = -4). The open-password IS the protection;
  // per-permission restrictions are unenforceable anyway once the opener holds the
  // (owner) password, and Lolly uses the same value for user and owner.
  const P = -4;
  const fileKey = rnd(32);
  const vals = await buildEncryptDictValues({
    userPw: preparePassword(password),
    ownerPw: preparePassword(password),
    fileKey,
    salts: { uvs: rnd(8), uks: rnd(8), ovs: rnd(8), oks: rnd(8) },
    permsRandom: rnd(4),
    P,
    encryptMetadata: true,
  });

  // Public /ID (never encrypted).
  const idArr = PDFArray.withContext(ctx);
  idArr.push(PDFHexString.of(hexU(rnd(16))));
  idArr.push(PDFHexString.of(hexU(rnd(16))));

  // The /Encrypt dict — its own strings (U/O/UE/OE/Perms) are stored raw, so it is
  // registered AFTER the encryption walk (below), never encrypted. /Length is 256
  // (BITS) at top level but 32 (BYTES) inside the crypt filter — the classic trap.
  const encDict = ctx.obj({
    Filter: 'Standard', V: 5, R: 6, Length: 256, P,
    U: PDFHexString.of(hexU(vals.U)),
    O: PDFHexString.of(hexU(vals.O)),
    UE: PDFHexString.of(hexU(vals.UE)),
    OE: PDFHexString.of(hexU(vals.OE)),
    Perms: PDFHexString.of(hexU(vals.Perms)),
    CF: { StdCF: { CFM: 'AESV3', AuthEvent: 'DocOpen', Length: 32 } },
    StmF: 'StdCF', StrF: 'StdCF', EncryptMetadata: true,
  });

  // Encrypt every string (→ PDFHexString, which serialises verbatim — PDFString
  // does not escape binary) and every stream body. Same file key, fresh IV each.
  const encStr = async (o: any): Promise<any> =>
    PDFHexString.of(hexU(await encryptObjectBytes(fileKey, rnd(16), o.asBytes())));
  const walk = async (c: any): Promise<void> => {
    if (c instanceof PDFDict) {
      for (const [k, v] of c.entries()) {
        if (v instanceof PDFString || v instanceof PDFHexString) c.set(k, await encStr(v));
        else if (v instanceof PDFDict || v instanceof PDFArray) await walk(v);
      }
    } else if (c instanceof PDFArray) {
      for (let i = 0; i < c.size(); i++) {
        const v = c.get(i);
        if (v instanceof PDFString || v instanceof PDFHexString) c.set(i, await encStr(v));
        else if (v instanceof PDFDict || v instanceof PDFArray) await walk(v);
      }
    }
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      const ct = await encryptObjectBytes(fileKey, rnd(16), new Uint8Array(obj.getContents()));
      await walk(obj.dict);
      ctx.assign(ref, PDFRawStream.of(obj.dict, ct));
    } else if (obj instanceof PDFDict || obj instanceof PDFArray) {
      await walk(obj);
    } else if (obj instanceof PDFString || obj instanceof PDFHexString) {
      ctx.assign(ref, await encStr(obj));
    }
  }

  const encRef = ctx.register(encDict); // after the walk → the dict itself stays clear
  ctx.trailerInfo.Encrypt = encRef;
  ctx.trailerInfo.ID = idArr;
  // Classic xref table (no object/xref streams): the encryption rule stays uniform
  // (every indirect object encrypted, nothing stream-shaped to exempt).
  const out = await doc.save({ useObjectStreams: false });
  return new Blob([out], { type: 'application/pdf' });
}

// Exported for the shadow-fidelity harness (export-pdf-shadow-fidelity.test.ts),
// which needs real PDF bytes to rasterise and diff — a recording mock cannot answer
// "does this LOOK like the browser". Not part of the bridge surface; callers go
// through createExportAPI.
export async function renderPdf(node: Element, opts: ExportOpts): Promise<Blob> {
  // Multi-page: a tool can flag page boxes with [data-pdf-page]; each becomes its
  // own PDF page sized to that element's own CSS box. This is independent of the
  // print-geometry (marks/bleed) path, which stays single-page. Falls through to
  // the legacy single-page renderer when no page boxes are present.
  const pageEls = node.querySelectorAll ? [...node.querySelectorAll('[data-pdf-page]')] : [];
  let blob: Blob;
  if (pageEls.length > 0) {
    blob = await renderMultiPagePdf(pageEls, opts);
  } else {
    const geo = printGeometry(node, opts);
    const artBlob = await renderArtworkPdf(node, opts, geo);
    if (opts.password && !geo) {
      // jsPDF encryption and pdf-lib post-processing are mutually exclusive:
      // the locked blob (only produced when there's no print geometry) ships
      // as-is, without the PDF/X-4 finishing pass.
      _host?.log?.('info', 'pdf: password-locked export — skipping PDF/X finishing (pdf-lib cannot rewrite an encrypted document)');
      blob = artBlob;
    } else {
      // RGB PDF: marks are black; page boxes declare trim/bleed for the RIP;
      // one pdf-lib pass adds the marks (when geo) and the PDF/X-4 metadata.
      blob = await finishPdfX(artBlob, opts, {
        intentKind: 'srgb', geo, space: 'rgb',
        labels: geo ? provenanceLabels(opts.meta) : null,
      });
    }
  }
  // Strong tier: AES-256 encrypt-last over the finished bytes (composes with the
  // PDF/X finishing above and the multi-page path). Mutually exclusive with the RC4
  // `password` tier and with C2PA (enforced in the UI + stampC2pa). Encryption is
  // the last byte op EXCEPT C2PA, which is skipped whenever a password is set.
  if (opts.strongPassword) blob = await encryptPdfStrong(blob, opts.strongPassword);
  // Content Credentials are applied by renderFormat AFTER this returns — the
  // stamp must remain the LAST byte operation on the finished blob.
  return blob;
}

// A human-readable size line for the export environment: physical exports read
// "210 × 297 mm @ 300 DPI"; pixel exports read "1080 × 1080 px". Values are the
// resolved output size (parseDimension → node fallback), rounded for legibility.
function describeDimensions(d: ExportDims): string {
  const n = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ''));
  if (d.physical && d.w.unit === d.h.unit) return `${n(d.w.value)} × ${n(d.h.value)} ${d.w.unit} @ ${d.dpi} DPI`;
  const w = d.physical ? toPixels(d.w, d.dpi) : Math.round(d.w.value);
  const h = d.physical ? toPixels(d.h, d.dpi) : Math.round(d.h.value);
  return `${w} × ${h} px`;
}

// Export environment for the `tools.lolly.export` assertion: the "where / when /
// how big / from what" record. Browser ENGINE family + major version and OS
// family (deliberately far short of a fingerprint), the export date, the output
// size, and the runtime-supplied scalar-input digest — enough that an inspected
// asset tells its own story without leaking a device fingerprint.
function c2paEnvironment(format: string, opts: ExportOpts, dimensions?: string): Record<string, unknown> {
  const ua = navigator.userAgent || '';
  let engine = 'unknown';
  let m: RegExpExecArray | null;
  if ((m = /Firefox\/(\d+)/.exec(ua))) engine = `Gecko ${m[1]}`;
  else if ((m = /Chrome\/(\d+)/.exec(ua))) engine = `Chromium ${m[1]}`;
  else if ((m = /Version\/(\d+).*Safari/.exec(ua))) engine = `WebKit ${m[1]}`;
  const os = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux|CrOS/.test(ua) ? 'Linux' : 'unknown';
  const inputs = opts.c2paInputs && Object.keys(opts.c2paInputs).length ? opts.c2paInputs : undefined;
  return {
    ...(opts.meta?.tool ? { tool: opts.meta.tool } : {}),
    format: String(format),
    surface: 'web',
    engine,
    os,
    date: new Date().toISOString(),
    ...(dimensions ? { dimensions } : {}),
    ...(inputs ? { inputs } : {}),
  };
}

// Profile authorship for the CreativeWork assertion. opts.meta.author/contact
// are already opt-in gated by buildExportMeta (Profile → "Use my details");
// the email is fished out of the joined contact string.
function c2paAuthor(meta: ExportMeta | null | undefined): { name: string; email?: string } | undefined {
  const name = meta?.author;
  if (!name) return undefined;
  const email = String(meta?.contact || '').split('·').map((s) => s.trim()).find((s) => s.includes('@'));
  return { name, ...(email ? { email } : {}) };
}

// User-asserted IP → the signed manifest's dc:rights (engine c2pa.ts). Combines the
// © notice + any licence into one line. Empty on ordinary exports — only tools that
// declare bindToMeta copyright/license (embed-track-image) populate meta.copyright/
// meta.license, so a normal render never asserts rights it can't stand behind.
function c2paRights(meta: ExportMeta | null | undefined): string | undefined {
  const r = [meta?.copyright, meta?.license].filter(Boolean).join(' · ');
  return r || undefined;
}

// Content Credentials (opts.c2pa) — a signed C2PA manifest embedded into the
// finished bytes of any supported container (pdf, png/apng, jpg, gif, svg,
// tiff, webp). Signed with the enrolled identity's device key + Lolly-CA cert
// when one is valid (host.identity — see docs/content-credentials-identity.md),
// else an ephemeral on-device key whose validity window is the user's
// opts.c2paDays pick (7/30/90/365, default 30) — viewers report that path as
// unverified. An encrypted PDF can't take the update, so a password wins; any
// other cannot-attach case ('C2PA embed: …') logs and ships the un-stamped
// file — a credential failure must never fail the export.
async function stampC2pa(blob: Blob, format: string, opts: ExportOpts, dimensions?: string): Promise<Blob> {
  if ((opts.password || opts.strongPassword) && (format === 'pdf' || format === 'pdf-cmyk')) {
    _host?.log?.('info', 'pdf: password-locked export — skipping Content Credentials (an encrypted document cannot take the C2PA update)');
    return blob;
  }
  try {
    // Ephemeral cert window = the user's lifetime pick (clamped; default 30
    // days). Ignored when an enrolled signer is present — its CA-issued cert
    // carries its own window, fixed at enrolment.
    const days = [7, 30, 90, 365].includes(Number(opts.c2paDays)) ? Number(opts.c2paDays) : 30;
    // Honest action history from what THIS export actually did — the pipeline
    // signals are all on opts/format, so nothing extra needs threading out of
    // the per-format renderers. Each genuine transformation gets its own,
    // individually-described step (task: "as granular as possible") rather than
    // a handful of lumped-together flags.
    const marks: string[] = [];
    if (opts.bleed) marks.push(`${opts.bleed}${typeof opts.bleed === 'number' ? 'px' : ''} bleed`);
    if (opts.cropMarks) marks.push('crop marks');
    if (opts.registrationMarks) marks.push('registration marks');
    if (opts.bleedMarks) marks.push('bleed marks');
    if (opts.colorBars) marks.push('a colour bar');
    // The durable in-pixel watermark runs two ways: unconditionally for the
    // canvas-based raster encoders (renderRaster/renderBitmap/renderTiff's
    // opts.imprint branch — imprintCapable formats always carry it), and — for
    // a CONTAINER format (pdf) — only when a Lolly-rendered raster was actually
    // composited in and marked (imprintEmbedCanvas flipped _imprintSink.applied).
    // A pure-vector page (e.g. a QR PDF) marks nothing, so it must NOT claim: gate
    // the container case on the applied flag, never on the format alone.
    const imprintCapable = format === 'png' || format === 'jpg' || format === 'jpeg' || format === 'webp' || format === 'avif' || format === 'tiff';
    const actions = exportActionSteps(format, {
      cmyk: /cmyk/i.test(format),
      paletteColors: opts.palette?.length,
      marks,
      watermarked: !!opts.watermark,
      imprint: !!opts.imprint && (imprintCapable || !!opts._imprintSink?.applied),
      audio: !!opts.audio?.url,
      // Honest origin: the runtime flags a sensor capture (live camera / mic take).
      ...(opts.c2paCapture ? { capture: opts.c2paCapture } : {}),
      // The runtime only sets c2paTextAdded when text sits over an opened asset,
      // so passing it through here keeps the "text is a real edit" gate intact.
      ...(opts.c2paTextAdded ? { textAdded: true, textSample: opts.c2paTextAdded.sample } : {}),
    });
    return await signAndEmbedC2pa(blob, format, {
      title: opts.meta?.tool,
      software: opts.meta?.software,
      environment: c2paEnvironment(format, opts, dimensions),
      author: c2paAuthor(opts.meta),
      rights: c2paRights(opts.meta),
      actions,
      ingredients: opts.ingredients,
      days,
    });
  } catch (err) {
    _host?.log?.('warn', `${format}: Content Credentials not attached — ${(err as any)?.message || err}`);
    return blob;
  }
}

// The shared signing core behind stampC2pa and stampDerivedC2pa: enrolled
// signer when available (else the engine's ephemeral self-signed default with
// a bounded validity window), one embedC2pa call, Blob back out. Throws on
// failure — callers decide whether a missing credential may fail the export
// (they don't: both wrap in try/catch and ship the un-stamped bytes).
// `host` defaults to the module-level _host, which is only wired once
// createExportAPI has run — callers that can reach this module before any
// export (the catalog's download path) pass their host explicitly.
async function signAndEmbedC2pa(blob: Blob, format: string, o: {
  title?: string;
  software?: string;
  environment: Record<string, unknown>;
  author?: { name: string; email?: string };
  rights?: string;
  actions: C2paActionInput[];
  ingredients?: IngredientCredential[];
  days?: number;
}, host: WebHost | null = _host): Promise<Blob> {
  // Enrolled-identity signer (device key + CA cert, see bridge/identity.js) —
  // null when not enrolled or the cert is out of validity, in which case the
  // engine's ephemeral self-signed default applies unchanged.
  let signer: any = null;
  try { signer = await host?.identity?.signer(); } catch { /* fall back to ephemeral */ }
  const days = o.days ?? 30;
  const stamped = await embedC2pa(new Uint8Array(await blob.arrayBuffer()), format, {
    title: o.title,
    claimGenerator: `${o.software || 'Lolly'} lolly.tools`,
    generatorInfo: { name: o.software || 'Lolly', version: ENGINE_VERSION },
    environment: o.environment,
    author: o.author,
    ...(o.rights ? { rights: o.rights } : {}),
    actions: o.actions,
    ...(o.ingredients?.length ? { ingredients: o.ingredients } : {}),
    dates: signer ? {} : { notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + days * 86_400_000) },
    ...(signer ? { signer } : {}),
  });
  return new Blob([stamped as BlobPart], { type: blob.type || 'application/octet-stream' });
}

/**
 * Content Credentials for a DERIVED asset — a catalog/library file the user
 * modified on the way out (icon recolour, photo colour treatment, crop,
 * re-encode) rather than a tool render. The caller supplies the honest action
 * history (engine C2paActionInput steps; when `ingredients` carry the source's
 * own credential the engine prepends a c2pa.opened step per ingredient, so the
 * list should NOT claim c2pa.created) and a transform-detail map recorded
 * under the tools.lolly.export assertion's `inputs`. Authorship follows the
 * profile's "Use my details" opt-in, exactly like tool exports. Never throws —
 * an un-stampable format or a signing failure logs and returns the original
 * bytes, because a credential failure must never fail a download.
 *
 * Takes the host explicitly: this module is dynamically imported by the
 * catalog's download path, which runs before any export has wired the
 * module-level _host via createExportAPI.
 */
export async function stampDerivedC2pa(host: HostV1, blob: Blob, format: string, o: {
  /** dc:title for the manifest — usually the asset's display name. */
  title?: string;
  /** Where this happened, for the export assertion's `tool` (default 'Catalog'). */
  tool?: string;
  /** Honest transform steps (c2pa.color_adjustments / c2pa.cropped / c2pa.converted / …). */
  actions: C2paActionInput[];
  /** The source asset's own preserved credential(s), carried as ingredient manifests. */
  ingredients?: IngredientCredential[];
  /** Transform detail (source id, treatment, crop box, …) → tools.lolly.export `inputs`. */
  inputs?: Record<string, string>;
  /** Output size, e.g. '1024×768'. */
  dimensions?: string;
}): Promise<Blob> {
  try {
    // Platform + opted-in personal attribution, same gate as tool exports
    // (Profile → "Use my details"); buildExportMeta fetches the profile itself.
    const meta = await buildExportMeta(host, { name: o.tool ?? 'Catalog' });
    return await signAndEmbedC2pa(blob, format, {
      title: o.title || meta.tool,
      software: meta.software,
      environment: c2paEnvironment(format, { meta, c2paInputs: o.inputs } as ExportOpts, o.dimensions),
      author: c2paAuthor(meta),
      rights: c2paRights(meta),
      actions: o.actions,
      ingredients: o.ingredients,
    }, host as WebHost);
  } catch (err) {
    host.log?.('warn', `${format}: Content Credentials not attached — ${(err as any)?.message || err}`);
    return blob;
  }
}

/**
 * Content Credentials for a freshly CAPTURED clip — a recorder tool's live camera
 * or microphone take (added engine v1.35), or a screenshot / screen recording
 * (v1.54). Signs the raw bytes so the file self-asserts (the created step is IPTC
 * `digitalCapture` for a sensor, `screenCapture` for a display — never the wrong one
 * of the two; on-device Lolly either way) and, placed into a composition, chains as a
 * credentialed ingredient. Returns the stamped blob PLUS the extracted manifest
 * store, because a `user/` asset's credential lookup reads the STORED store, not the
 * file's bytes — the caller persists it on the asset record (mirroring the
 * upload-ingest path). Only png / mp4 / webm are C2PA-stampable here (so webm/m4a
 * audio works, mp3/wav/ogg don't). Never throws — a stamping failure returns the
 * original blob + a null credential, so a take is never lost to a provenance hiccup.
 */
export async function stampCaptureClip(host: HostV1, blob: Blob, format: 'mp4' | 'webm' | 'png', o: {
  camera?: boolean;
  microphone?: boolean;
  /** A display was captured, not a sensor — swaps the created step to IPTC screenCapture. */
  screen?: boolean;
  dimensions?: string;
}): Promise<{ blob: Blob; credential: { store: Uint8Array; format: string } | null }> {
  // Screen first: a narrated screen recording is a screen capture WITH a mic track, not
  // a microphone recording — claiming the latter would say the file is a record of the
  // room. The mic is still named, since it did capture the room's sound.
  const description = o.screen ? (o.microphone ? 'Captured from the screen with microphone narration' : 'Captured from the screen')
    : o.camera && o.microphone ? 'Recorded live from the camera and microphone'
    : o.camera ? 'Captured live from the camera'
    : 'Recorded live from the microphone';
  try {
    // A fresh recording has no ingredients → it honestly claims c2pa.created.
    const stamped = await stampDerivedC2pa(host, blob, format, {
      tool: o.screen ? 'Screen capture' : 'Recording',
      actions: [{
        action: 'c2pa.created',
        digitalSourceType: o.screen ? SCREEN_SOURCE_TYPE : CAPTURE_SOURCE_TYPE,
        description,
      }],
      dimensions: o.dimensions,
    });
    const ex = extractC2paStore(new Uint8Array(await stamped.arrayBuffer()));
    return { blob: stamped, credential: ex ? { store: ex.store, format: ex.format } : null };
  } catch (err) {
    host.log?.('warn', `capture clip: Content Credentials not attached — ${(err as any)?.message || err}`);
    return { blob, credential: null };
  }
}

// Render a sequence of [data-pdf-page] DOM nodes into one multi-page PDF. Each
// page is sized to its own CSS box (layout px → PDF points at the CSS 96-DPI
// convention), so a tool that lays out fixed-size page boxes — the height
// matching the export page height — gets one true PDF page per box. Each box is
// drawn at (0,0) in its own page via drawHtmlVectors, whose coordinate origin is
// the node it's handed, so a page is rendered correctly regardless of where it
// sits in the scrolled/stacked document. A password locks the document on open —
// this path can always encrypt (no print geometry), at the cost of the pdf-lib
// PDF/X finishing pass. Print marks/bleed are not applied here; a tool that
// emits page boxes opts out of the print-finishing card (render.printMarks:false).
// `prepare(i)` is called immediately before page `i` is measured and drawn, which
// is the seam a contact sheet needs: there the SAME node is the page every time and
// what changes between pages is the sequence playhead (bridge/sequence-cuts.ts).
// Absent for the [data-pdf-page] case, where the pages are already distinct nodes.
async function renderMultiPagePdf(pageEls: Element[], opts: ExportOpts, prepare?: (i: number) => void): Promise<Blob> {
  const mod: any = await import('jspdf');
  const jsPDF = mod.jsPDF ?? mod.default?.jsPDF ?? mod.default;
  const convert = opts.convertPaths !== false;

  // Page size in points from the element's own box. getBoundingClientRect matches
  // the reference drawHtmlVectors uses internally (so the px→pt scale is uniform);
  // the live CSS transform is removed by the shell before export (exportUnscaled).
  const sizeOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { w: toPoints({ value: r.width || 1, unit: 'px' as const }), h: toPoints({ value: r.height || 1, unit: 'px' as const }) };
  };
  const orientOf = (w: number, h: number) => (w >= h ? 'landscape' : 'portrait');

  // Lock on open via jsPDF's standard security handler (user = owner password;
  // printing-only permissions). undefined is a no-op (unencrypted).
  const encryption = opts.password
    ? { userPassword: opts.password, ownerPassword: opts.password, userPermissions: ['print'] }
    : undefined;
  prepare?.(0);
  const first = sizeOf(pageEls[0]!);
  const pdf = new jsPDF({ unit: 'pt', format: [first.w, first.h], orientation: orientOf(first.w, first.h), encryption });
  applyPdfMeta(pdf, opts.meta);

  for (let i = 0; i < pageEls.length; i++) {
    const el = pageEls[i]!;
    if (i > 0) prepare?.(i);
    const { w, h } = i === 0 ? first : sizeOf(el);
    if (i > 0) pdf.addPage([w, h], orientOf(w, h));
    // An SVG-rooted page walks as vectors (mirrors renderArtworkPdf); otherwise the
    // HTML page walks via drawHtmlVectors. Common case here is HTML page boxes.
    const svgRoot = el.tagName?.toLowerCase() === 'svg' ? el
      : isSvgRooted(el) ? el.querySelector('svg') : null;
    if (svgRoot) await drawSvgVectorsInRegion(pdf, svgRoot, 0, 0, w, h, new Set(), opts._imprintSink);
    else await drawHtmlVectors(pdf, el, 0, 0, w, h, convert, opts.onProgress, opts.rasterFallback !== false, opts._imprintSink);
  }
  const blob = pdf.output('blob');
  if (opts.password) {
    // jsPDF encryption and pdf-lib post-processing are mutually exclusive — a
    // locked multi-page document ships without the PDF/X-4 finishing pass.
    _host?.log?.('info', 'pdf: password-locked export — skipping PDF/X finishing (pdf-lib cannot rewrite an encrypted document)');
    return blob;
  }
  return await finishPdfX(blob, opts, { intentKind: 'srgb' });
}

// The PDF/X pass logs a withheld conformance claim through the live host, and
// takes the logger as an argument so export-pdfx.ts stays free of this module.
const pdfxLog = (level: 'debug' | 'info' | 'warn' | 'error', msg: string): void => {
  _host?.log?.(level, msg);
};

// The user's own profile for this export, or null. Only ever consulted for an
// `own` / `own:<digest>` selection — every registry-name condition resolves to
// null and produces exactly the file it produced before. A miss (profile deleted,
// unreadable, or not an eligible output profile) is also null, and the pass then
// writes no intent rather than declaring a condition nobody chose.
async function embeddedProfile(colorProfile: string | undefined): Promise<EmbedResolution | null> {
  if (!isOwnProfile(colorProfile) || !_host) return null;
  return resolveEmbeddedProfile(_host as never, colorProfile, 'CMYK').catch(() => null);
}

// Re-save a jsPDF blob through one pdf-lib pass: print page boxes + marks (when
// print geometry is supplied) and the PDF/X-4 metadata set. Subsumes the old
// finishPrintPdf so the plain RGB path loads pdf-lib exactly once; the CMYK path
// has its own pdf-lib pass and calls applyPdfX inside it (see renderCmykPdf).
// Never fed an encrypted blob — pdf-lib can't reopen jsPDF's RC4 output.
async function finishPdfX(
  blobOrBytes: Blob | Uint8Array, opts: ExportOpts,
  { intentKind = 'srgb', geo = null, space = 'rgb', labels = null }:
    { intentKind?: string | null; geo?: PrintGeometry | null; space?: string; labels?: LabelsRecord | null } = {},
): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib') as any;
  const bytes = blobOrBytes instanceof Uint8Array
    ? blobOrBytes
    : new Uint8Array(await blobOrBytes.arrayBuffer());
  // updateMetadata:false — pdf-lib would otherwise stamp itself as Producer on
  // load; applyPdfX writes the document's real dates/producer below.
  const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (geo) {
    const page = pdfDoc.getPage(0);
    setPageBoxes(page, geo);
    await drawPrintMarks(page, geo, { space, labels });
  }
  await applyPdfX(pdfDoc, opts, intentKind, { log: pdfxLog });
  // The C2PA embedder only parses a classic xref table; pdf-lib's default save
  // (object streams) writes a cross-reference stream it refuses. Only flipped
  // when credentials are requested, so ordinary PDFs keep the compact form.
  const out = await pdfDoc.save(opts.c2pa ? { useObjectStreams: false } : undefined);
  return new Blob([out], { type: 'application/pdf' });
}

// Compose the proof-margin credit strings from the export's provenance metadata.
// topLeft: export timestamp; topRight: platform attribution; bottomLeftUp: tool
// + author. Anything missing is dropped, so the line stays clean when the user
// isn't opted into personal details. Keyed by the engine's label slots (see
// print-marks.js).
function provenanceLabels(meta: ExportMeta | null | undefined): LabelsRecord | null {
  if (!meta) return null;
  const topLeft  = formatStamp(new Date());
  const topRight = meta.source ? `Made with ${meta.source}` : '';
  const credit = [meta.tool, meta.author && `by ${meta.author}`].filter(Boolean).join(' ');
  return { topLeft, topRight, bottomLeftUp: meta.tool ? credit : '' };
}

// Local export timestamp as "YYYY-MM-DD HH:MM".
function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Declare the print page boxes so a RIP / print shop knows the cut (trim) and
// bleed extents: Media ⊇ Bleed ⊇ Trim (= Art); CropBox = Media. The engine's
// geometry is top-left origin; PDF boxes are bottom-left, so flip y.
function setPageBoxes(page: any, geo: PrintGeometry): void {
  const H = geo.page.h;
  const box = (b: { x: number; y: number; w: number; h: number }): [number, number, number, number] => [b.x, H - (b.y + b.h), b.w, b.h]; // → [x, y(bottom-left), w, h]
  page.setMediaBox(...box(geo.boxes.media));
  page.setCropBox(...box(geo.boxes.media));
  page.setBleedBox(...box(geo.boxes.bleed));
  page.setTrimBox(...box(geo.boxes.trim));
  page.setArtBox(...box(geo.boxes.trim));
}

// Draw the crop / bleed / registration marks, colour bar and provenance labels
// in the page margin. Line marks use registration colour (DeviceCMYK 1,1,1,1 on
// the CMYK path so they print on every plate; black on the RGB path). Colour-bar
// cells follow their own `ink`: brand pairs force 'rgb' (the unconverted
// reference swatch) and 'cmyk' (the substitution) regardless of page space, so
// the two sit side by side for comparison; the generic bar's 'page' cells follow
// the page space. `labels` (optional) maps each engine label slot → its string.
// Engine coords are top-left; flip y.
async function drawPrintMarks(page: any, geo: PrintGeometry, { space = 'rgb', labels }: { space?: string; labels?: LabelsRecord | null } = {}): Promise<void> {
  const { rgb, cmyk, degrees, StandardFonts } = await import('pdf-lib') as any;
  const H = geo.page.h;
  const fy = (y: number) => H - y;
  const markColor = space === 'cmyk' ? cmyk(1, 1, 1, 1) : rgb(0, 0, 0);
  const w = geo.strokeWeight;
  for (const ln of geo.primitives.lines) {
    page.drawLine({ start: { x: ln.x1, y: fy(ln.y1) }, end: { x: ln.x2, y: fy(ln.y2) }, thickness: w, color: markColor });
  }
  for (const c of geo.primitives.circles) {
    // borderColor without `color` strokes a ring (no fill) — see pdf-lib drawEllipse.
    page.drawCircle({ x: c.cx, y: fy(c.cy), size: c.r, borderWidth: w, borderColor: markColor });
  }
  for (const b of geo.primitives.bars) {
    const ink = b.ink === 'page' || !b.ink ? space : b.ink;
    const fill = ink === 'cmyk' ? cmyk(...b.cmyk) : rgb(...b.rgb);
    page.drawRectangle({ x: b.x, y: fy(b.y + b.h), width: b.w, height: b.h, color: fill });
  }
  // Provenance text — only the engine's anchors that the caller supplied a string
  // for. Helvetica (a standard-14 font: referenced, not embedded) keeps it light.
  const slots = (geo.primitives.labels ?? []).filter(l => labels?.[l.slot]);
  if (slots.length) {
    const font = await page.doc.embedFont(StandardFonts.Helvetica);
    const textColor = space === 'cmyk' ? cmyk(0, 0, 0, 0.7) : rgb(0.35, 0.35, 0.35);
    for (const l of slots) {
      const text = labels![l.slot]!;
      // Right-aligned horizontal text shifts left by its measured width; rotated
      // text (read-up) starts at its anchor and climbs, so no shift needed.
      const shift = (l.rotation === 0 && l.align === 'right') ? font.widthOfTextAtSize(text, l.size) : 0;
      page.drawText(text, {
        x: l.x - shift, y: fy(l.y), size: l.size, font, color: textColor, rotate: degrees(l.rotation),
      });
    }
  }
}

// Renders an SVG element into a rectangular region of the PDF page.
// ox/oy are the PDF-space top-left offsets (pt); regionW/regionH are the
// target dimensions (pt). Used both by the full-page SVG canvas path and by
// drawHtmlVectors when it encounters an inline <svg> element.
async function drawSvgVectorsInRegion(pdf: any, svgEl: Element, ox: number, oy: number, regionW: number, regionH: number, registeredFonts: Set<unknown> | null = null, imprint?: ImprintState): Promise<void> {
  const vb = (svgEl as SVGSVGElement).viewBox?.baseVal;
  const vbW = (vb && vb.width  > 0) ? vb.width  : svgEl.getBoundingClientRect().width;
  const vbH = (vb && vb.height > 0) ? vb.height : svgEl.getBoundingClientRect().height;
  const vbX = (vb && vb.width  > 0) ? vb.x : 0;
  const vbY = (vb && vb.height > 0) ? vb.y : 0;
  let sx = regionW / vbW;
  let sy = regionH / vbH;
  // Honour the SVG's preserveAspectRatio when its viewBox aspect differs from the
  // target region. Tools like Diagram Builder size the viewBox to the diagram's own
  // bounds (not the fixed export page), so the browser — and the SVG export — letterbox
  // the artwork via the default "xMidYMid meet". Without this the walker filled the page
  // with a NON-uniform scale (sx≠sy), stretching the diagram vs. the on-screen preview.
  // 'none' keeps the legacy stretch-to-fill; meet/slice + x/y alignment follow the SVG
  // spec, matching the <image> branch's own meet handling below. The centering offset is
  // folded into ox/oy so every mapper (PX/PY/LW/LH, the rotation pivot, rAvg) tracks it.
  const par = ((svgEl.getAttribute('preserveAspectRatio') || '').trim() || 'xMidYMid meet');
  if (!/^none/i.test(par)) {
    const align = par.split(/\s+/)[0] || 'xMidYMid';
    const s = /\bslice\b/i.test(par) ? Math.max(sx, sy) : Math.min(sx, sy);
    ox += (regionW - vbW * s) * (align.includes('xMax') ? 1 : align.includes('xMid') ? 0.5 : 0);
    oy += (regionH - vbH * s) * (align.includes('YMax') ? 1 : align.includes('YMid') ? 0.5 : 0);
    sx = sy = s;
  }

  // Gradient / filter / pattern SVGs can't be reproduced by the vector walk below:
  // jsPDF compat mode has no axial/radial shading, and a url(#…) fill resolves to null
  // → the shape simply VANISHES. Rasterise the whole subtree to an alpha-preserved PNG
  // and drop it into the SAME PAR-fitted box the vectors would occupy. drawHtmlVectors
  // already does this for an inline <svg>; centralising it here means EVERY entry point —
  // a Lolly tool embedded as an <img>, artwork / multi-page PDFs, a nested <image> —
  // keeps its shading instead of only the inline case. Solid-fill SVGs (qr, brand-lockup)
  // match nothing here and stay crisp vector. (bag-video's gradient Geeko is the canon case.)
  if (svgEl.querySelector?.('linearGradient, radialGradient, filter, pattern')) {
    try {
      const fitW = vbW * sx, fitH = vbH * sy;
      const dpr = 150 / 72;                                    // output-region px at ~150dpi, bounded
      const pxW = Math.max(2, Math.min(2000, Math.round(fitW * dpr)));
      const pxH = Math.max(2, Math.min(2000, Math.round(fitH * dpr)));
      const png = await rasterizeSvgElement(svgEl, pxW, pxH, false, imprint);
      pdf.addImage(png, 'PNG', ox, oy, fitW, fitH);
      return;
    } catch { /* fall through to the vector walk (better a solid silhouette than nothing) */ }
  }

  let nodesWalked = 0;
  const YIELD_NODES = 200;
  // <use> expansion depth — bounds a <use> chain (or a self/mutually referential one)
  // so a malformed SVG can't recurse without end. 8 is far beyond any real nesting.
  let useDepth = 0;
  const MAX_USE_DEPTH = 8;
  async function visit(el: any, tx: number, ty: number, sX: number, sY: number): Promise<void> {
    if (!el.tagName) return;
    // Cooperative yield, matching the sibling HTML walker: a big SVG (Diagram Builder,
    // imported artwork) otherwise runs getComputedStyle + drawSvgPathToPdf per path
    // synchronously and freezes the tab. Draws stay in document order (painter's algo
    // preserved), so output is byte-identical.
    if (++nodesWalked % YIELD_NODES === 0) await new Promise<void>((r) => setTimeout(r));
    const tag = el.tagName.toLowerCase().replace(/^svg:/, '');

    if (tag === 'defs' || tag === 'clippath' || tag === 'lineargradient' ||
        tag === 'radialgradient' || tag === 'symbol') return;

    // Compose this element's OWN transform (translate/scale/rotate) onto the inherited
    // CTM — applied to CONTAINERS and LEAF drawables alike. brand-lockup lays its whole
    // lockup out as sibling <path transform="translate()/scale()"> with no wrapping <g>,
    // so unless a leaf's own transform is honoured here every glyph run and the chameleon
    // collapse onto the origin at native scale when the lockup is embedded as an image and
    // the parent (e.g. Layout Studio) exports PDF. Mirrors the EMF/EPS/DXF walker's
    // applyElementTransform (svg-ir.ts), which already maps per-leaf transforms.
    const tx0 = tx, ty0 = ty, sX0 = sX, sY0 = sY;
    let rotDeg = 0, rotCx = 0, rotCy = 0;
    {
      const t = el.getAttribute('transform') ?? '';
      if (t) {
        const tm = t.match(/translate\(\s*([+-]?\d*\.?\d+)[,\s]\s*([+-]?\d*\.?\d+)\s*\)/) ??
                   t.match(/translate\(\s*([+-]?\d*\.?\d+)\s*\)/);
        const sm = t.match(/scale\(\s*([+-]?\d*\.?\d+)(?:[,\s]\s*([+-]?\d*\.?\d+))?\s*\)/);
        const rm = t.match(/rotate\(\s*([+-]?\d*\.?\d+)(?:[,\s]+([+-]?\d*\.?\d+)[,\s]+([+-]?\d*\.?\d+))?\s*\)/);
        // SVG order is translate-then-scale, so the local translate is taken in the
        // PARENT's scale (sX0/sY0) and the scales multiply; rotation is applied last.
        if (tm) { tx = tx0 + sX0 * parseFloat(tm[1]); ty = ty0 + sY0 * parseFloat(tm[2] ?? '0'); }
        if (sm) { sX = sX0 * parseFloat(sm[1]); sY = sY0 * parseFloat(sm[2] ?? sm[1]); }
        if (rm) { rotDeg = parseFloat(rm[1]); rotCx = rm[2] != null ? parseFloat(rm[2]) : 0; rotCy = rm[3] != null ? parseFloat(rm[3]) : 0; }
      }
    }

    // Map an SVG user-space coord (inside this element's own + inherited transform)
    // into PDF points: apply the accumulated translate+scale, shift by the viewBox
    // origin, then scale into the target region. LW/LH scale a length.
    const gAvg = (sX + sY) / 2, rAvg = (sx + sy) / 2;
    const PX = (v: number) => ox + ((tx + sX * v) - vbX) * sx;
    const PY = (v: number) => oy + ((ty + sY * v) - vbY) * sy;
    const LW = (v: number) => v * sX * sx;
    const LH = (v: number) => v * sY * sy;
    // Stroke width / font scaling: group scale × region scale — EXCEPT for
    // vector-effect:non-scaling-stroke (e.g. street-map roads), whose stroke keeps
    // its user-unit width through the group transform, so region scale only.
    const strokeMul = (e: any) =>
      ((e.getAttribute('vector-effect') || resolveStyleProp(e, 'vector-effect')) === 'non-scaling-stroke' ? 1 : gAvg) * rAvg;

    // Resolve fill + stroke (with opacity) for a basic shape, mirroring the
    // <path> branch — so a stroked <rect>/<circle> keeps its border in PDF.
    // (Previously rect/circle were fill-only: a card whose fill matches the page,
    // distinguished only by its border, exported as an invisible box. The EMF/EPS
    // walker in svg-ir.js already routes rect/circle through its path logic, so
    // this brings the PDF sink to parity.) Returns null when nothing is paintable.
    const shapePaint = (e: any): { fillRgb: Rgb | null; strokeRgb: Rgb | null; lw: number } | null => {
      let fillRgb = resolveColor(e);                 // own-attr → inline style → computed
      const strokeStr = strokeOf(e);                 // same three-way resolution
      let strokeRgb = (strokeStr && strokeStr !== 'none') ? parseSvgColor(strokeStr) : null;
      const elemOp = parseFloat(e.getAttribute('opacity') ?? '1');
      const fillOp = elemOp * parseFloat(e.getAttribute('fill-opacity') ?? '1');
      const strkOp = elemOp * parseFloat(e.getAttribute('stroke-opacity') ?? '1');
      if (fillOp < 0.01) fillRgb = null;
      if (strkOp < 0.01) strokeRgb = null;
      if (!fillRgb && !strokeRgb) return null;
      if (fillRgb   && fillOp < 0.999) fillRgb   = blendSvgWithWhite(fillRgb,   fillOp);
      if (strokeRgb && strkOp < 0.999) strokeRgb = blendSvgWithWhite(strokeRgb, strkOp);
      const lw = Math.max(0.1, strokeWidthOf(e) * strokeMul(e));
      return { fillRgb, strokeRgb, lw };
    };

    // Paint + draw any shape expressed as an SVG `d` — shared by <path> and the shapes
    // that reduce to a path (<polygon>/<polyline>/<ellipse>). Resolves fill/stroke with
    // currentColor + computed-style fallback, per-element + fill/stroke opacity, and
    // fill-rule exactly as the <path> branch always has, so the added shapes match it.
    const drawShapeD = (e: any, d: string): void => {
      if (!d.trim()) return;
      let fillStr = e.getAttribute('fill') ?? resolveStyleProp(e, 'fill');
      if (!fillStr || fillStr === 'currentColor') fillStr = computedPaint(e, 'fill') || 'black';
      const strokeStr = strokeOf(e);
      const elemOp  = parseFloat(e.getAttribute('opacity') ?? '1');
      const fillOp  = elemOp * parseFloat(e.getAttribute('fill-opacity')   ?? '1');
      const strkOp  = elemOp * parseFloat(e.getAttribute('stroke-opacity') ?? '1');
      let fillRgb   = (fillStr   && fillStr   !== 'none') ? parseSvgColor(fillStr)   : null;
      let strokeRgb = (strokeStr && strokeStr !== 'none') ? parseSvgColor(strokeStr) : null;
      if (fillOp   < 0.01) fillRgb   = null;
      if (strkOp   < 0.01) strokeRgb = null;
      if (!fillRgb && !strokeRgb) return;
      if (fillRgb   && fillOp   < 0.999) fillRgb   = blendSvgWithWhite(fillRgb,   fillOp);
      if (strokeRgb && strkOp   < 0.999) strokeRgb = blendSvgWithWhite(strokeRgb, strkOp);
      if (fillRgb)   pdf.setFillColor(fillRgb[0], fillRgb[1], fillRgb[2]);
      let restoreStroke: (() => void) | null = null;
      if (strokeRgb) {
        pdf.setDrawColor(strokeRgb[0], strokeRgb[1], strokeRgb[2]);
        const lw = strokeWidthOf(e) * strokeMul(e);
        pdf.setLineWidth(Math.max(0.1, lw));
        restoreStroke = applySvgStrokeDecoration(pdf, e, strokeMul(e));
      }
      drawSvgPathToPdf(pdf, d, PX, PY);
      const fillRule = e.getAttribute('fill-rule') ?? 'nonzero';
      if (fillRgb && strokeRgb) pdf.fillStroke();
      else if (fillRgb) { fillRule === 'evenodd' ? pdf.fillEvenOdd() : pdf.fill(); }
      else pdf.stroke();
      restoreStroke?.();
    };

    // Render this element — leaf geometry, or a container's children — under any own
    // rotation. Translate/scale are already folded into tx/ty/sX/sY above; a rotate()
    // (d3.zoom groups, pose-geeko's articulated limbs) is applied about its pivot via
    // the PDF matrix, wrapping the whole subtree. Skew/matrix() are not handled.
    const drawSelf = async (): Promise<void> => {
    if (tag === 'g') {
      for (const child of el.children) await visit(child, tx, ty, sX, sY);
      return;
    }

    if (tag === 'rect') {
      const x = PX(svgLen(el.getAttribute('x'), vbW));
      const y = PY(svgLen(el.getAttribute('y'), vbH));
      const w = LW(svgLen(el.getAttribute('width'), vbW));
      const h = LH(svgLen(el.getAttribute('height'), vbH));
      if (w <= 0 || h <= 0) return;
      const paint = shapePaint(el);
      if (!paint) return;
      const rx = LW(parseFloat(el.getAttribute('rx') || el.getAttribute('ry') || '0'));
      const ry = LH(parseFloat(el.getAttribute('ry') || el.getAttribute('rx') || '0'));
      if (paint.fillRgb)   pdf.setFillColor(paint.fillRgb[0], paint.fillRgb[1], paint.fillRgb[2]);
      if (paint.strokeRgb) { pdf.setDrawColor(paint.strokeRgb[0], paint.strokeRgb[1], paint.strokeRgb[2]); pdf.setLineWidth(paint.lw); }
      const style = (paint.fillRgb && paint.strokeRgb) ? 'FD' : (paint.fillRgb ? 'F' : 'S');
      (rx > 0 || ry > 0)
        ? pdf.roundedRect(x, y, w, h, rx, ry, style)
        : pdf.rect(x, y, w, h, style);
      return;
    }

    if (tag === 'circle') {
      const cx = PX(svgLen(el.getAttribute('cx'), vbW));
      const cy = PY(svgLen(el.getAttribute('cy'), vbH));
      const r  = LW(svgLen(el.getAttribute('r'), vbW));
      if (r <= 0) return;
      const paint = shapePaint(el);
      if (!paint) return;
      if (paint.fillRgb)   pdf.setFillColor(paint.fillRgb[0], paint.fillRgb[1], paint.fillRgb[2]);
      if (paint.strokeRgb) { pdf.setDrawColor(paint.strokeRgb[0], paint.strokeRgb[1], paint.strokeRgb[2]); pdf.setLineWidth(paint.lw); }
      const style = (paint.fillRgb && paint.strokeRgb) ? 'FD' : (paint.fillRgb ? 'F' : 'S');
      pdf.circle(cx, cy, r, style);
      return;
    }

    if (tag === 'line') {
      const strokeStr = el.getAttribute('stroke') ?? '';
      if (strokeStr === 'none') return;
      let rgb = strokeStr ? parseSvgColor(strokeStr) : null;
      // Fall back to the COMPUTED stroke when set via CSS (or a named colour that
      // slipped through) so <line stroke="red">/CSS-styled lines aren't dropped.
      if (!rgb) rgb = parseSvgColor(computedPaint(el, 'stroke'));
      if (!rgb) return;
      const opacity = parseFloat(el.getAttribute('opacity') ?? el.getAttribute('stroke-opacity') ?? '1');
      if (opacity < 0.01) return;
      if (opacity < 0.999) rgb = blendSvgWithWhite(rgb, opacity);
      const lx1 = PX(svgLen(el.getAttribute('x1'), vbW));
      const ly1 = PY(svgLen(el.getAttribute('y1'), vbH));
      const lx2 = PX(svgLen(el.getAttribute('x2'), vbW));
      const ly2 = PY(svgLen(el.getAttribute('y2'), vbH));
      const lw  = strokeWidthOf(el) * strokeMul(el);
      pdf.setDrawColor(rgb[0], rgb[1], rgb[2]);
      pdf.setLineWidth(Math.max(0.1, lw));
      pdf.line(lx1, ly1, lx2, ly2, 'S');
      return;
    }

    if (tag === 'text') {
      // Draw ONE run (the <text> itself, or one <tspan>) at (userX,userY) in the element's
      // own style, then return its advance in USER units. Font props: attribute first, else
      // the COMPUTED style — tools that set the typeface/size/weight via CSS (chart-creator/d3
      // → SUSE) otherwise fell back to Helvetica at the default size. Advance uses the
      // browser's measured getComputedTextLength (a length → maps like the x attrs); jsPDF's
      // width is the fallback. Baseline y matches jsPDF's default (SVG y IS the baseline).
      const drawRun = async (styleEl: any, runText: string, userX: number, userY: number, anchor: string): Promise<number> => {
        const t = (runText ?? '').trim();
        if (!t) return 0;
        const cs = (typeof window !== 'undefined' && styleEl.isConnected) ? window.getComputedStyle(styleEl) : null;
        let fillStr = styleEl.getAttribute('fill');
        if (!fillStr || fillStr === 'currentColor') fillStr = computedPaint(styleEl, 'fill') || '#000000';
        let rgb = parseSvgColor(fillStr) ?? parseSvgColor(computedPaint(styleEl, 'fill'));
        const op = parseFloat(styleEl.getAttribute('opacity') ?? styleEl.getAttribute('fill-opacity') ?? '1');
        const fs = parseFloat(styleEl.getAttribute('font-size') ?? cs?.fontSize ?? '16') * gAvg * rAvg;
        const fw = parseInt(styleEl.getAttribute('font-weight') ?? cs?.fontWeight ?? '400') || 400;
        const fst = styleEl.getAttribute('font-style') ?? cs?.fontStyle ?? '';
        const italic = fst === 'italic' || fst === 'oblique';
        const family = (styleEl.getAttribute('font-family') ?? cs?.fontFamily ?? '').toLowerCase();
        pdf.setFontSize(Math.max(1, fs));
        let fontSet = false;
        if (family.includes('suse') && registeredFonts) {
          const mono = family.includes('mono');
          const suseStyle = await embedSuseFont(pdf, registeredFonts, fw, italic, mono);
          if (suseStyle) { pdf.setFont(suseFontName(mono), suseStyle); fontSet = true; }
        }
        if (!fontSet) pdf.setFont('helvetica', fw >= 600 ? (italic ? 'bolditalic' : 'bold') : (italic ? 'italic' : 'normal'));
        // Draw only when visible + paintable, but ALWAYS measure so following inline runs flow.
        if (rgb && op >= 0.01) {
          if (op < 0.999) rgb = blendSvgWithWhite(rgb, op);
          pdf.setTextColor(rgb[0], rgb[1], rgb[2]);
          const align = anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left';
          pdf.text(t, PX(userX), PY(userY), { align });
        }
        let wUser = 0;
        try { wUser = typeof styleEl.getComputedTextLength === 'function' ? styleEl.getComputedTextLength() : 0; } catch { wUser = 0; }
        if (!wUser) { const wpt = pdf.getTextWidth(t); wUser = (gAvg * rAvg) ? wpt / (gAvg * rAvg) : 0; }
        return wUser;
      };

      const nodes = el.childNodes ? [...el.childNodes] : [];
      const hasTspan = nodes.some((n: any) => n.nodeType === 1 && n.tagName?.toLowerCase() === 'tspan');
      // Plain <text> (no tspans): one run at the text's own x/y — unchanged behaviour.
      if (!hasTspan) {
        await drawRun(el, el.textContent ?? '', svgLen(el.getAttribute('x'), vbW), svgLen(el.getAttribute('y'), vbH), el.getAttribute('text-anchor') ?? 'start');
        return;
      }
      // Multi-run: a <tspan> may RESET the pen (x/y) or OFFSET it (dx/dy) and carry its own
      // fill/font; a bare text node flows at the pen in the <text>'s style. Positions resolve
      // from attributes (same user space as PX/PY) so multi-line / positioned tspan text lays
      // out like the browser instead of collapsing every line onto the parent's baseline.
      let penX = svgLen(el.getAttribute('x'), vbW);
      let penY = svgLen(el.getAttribute('y'), vbH);
      const textAnchor = el.getAttribute('text-anchor') ?? 'start';
      for (const n of nodes) {
        if (n.nodeType === 3) {                                   // bare text node — flows inline
          if ((n.textContent ?? '').trim()) penX += await drawRun(el, n.textContent, penX, penY, 'start');
        } else if (n.nodeType === 1 && (n as any).tagName?.toLowerCase() === 'tspan') {
          const ts: any = n;
          const emPx = parseFloat((ts.isConnected ? window.getComputedStyle(ts).fontSize : '') || ts.getAttribute('font-size') || '16') || 16;
          const relLen = (v: string | null): number => { if (!v) return 0; const s = v.trim(); return s.endsWith('em') ? parseFloat(s) * emPx : (parseFloat(s) || 0); };
          if (ts.hasAttribute('x')) penX = svgLen(ts.getAttribute('x'), vbW);
          if (ts.hasAttribute('y')) penY = svgLen(ts.getAttribute('y'), vbH);
          penX += relLen(ts.getAttribute('dx'));
          penY += relLen(ts.getAttribute('dy'));
          penX += await drawRun(ts, ts.textContent, penX, penY, ts.getAttribute('text-anchor') ?? textAnchor);
        }
      }
      return;
    }

    // Fill/stroke fall back to the COMPUTED paint (not a literal black), so a path that
    // inherits its colour from an ancestor group (e.g. logo-wall's one-ink <g fill="ink">)
    // or uses currentColor resolves correctly in PDF instead of rendering black —
    // getComputedStyle resolves SVG inheritance on the live DOM. (See drawShapeD.)
    if (tag === 'path') { drawShapeD(el, el.getAttribute('d') ?? ''); return; }

    // <ellipse> / <polygon> / <polyline> reduce to a `d` and paint through the same path
    // pipeline. Previously they fell through to the generic child-recurse and were
    // silently DROPPED from PDF output — real geometry loss for filter-voronoi (all
    // polygons), org-chart / diagram-builder connectors, multi-page-pdf, etc. The
    // EMF/EPS/DXF walker (svg-ir.ts) has always drawn them via the same reduction.
    if (tag === 'ellipse') {
      const ecx = svgLen(el.getAttribute('cx'), vbW), ecy = svgLen(el.getAttribute('cy'), vbH);
      const erx = svgLen(el.getAttribute('rx'), vbW), ery = svgLen(el.getAttribute('ry'), vbH);
      if (erx <= 0 || ery <= 0) return;
      drawShapeD(el, `M${ecx - erx},${ecy} A${erx},${ery} 0 1 0 ${ecx + erx},${ecy} A${erx},${ery} 0 1 0 ${ecx - erx},${ecy} Z`);
      return;
    }

    if (tag === 'polygon' || tag === 'polyline') {
      const pts = (el.getAttribute('points') || '').match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g);
      if (!pts || pts.length < 4) return;
      let d = `M${pts[0]},${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += ` L${pts[i]},${pts[i + 1]}`;
      drawShapeD(el, d + (tag === 'polygon' ? ' Z' : ''));
      return;
    }

    if (tag === 'image') {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      if (!href) return;
      const x = PX(svgLen(el.getAttribute('x'), vbW));
      const y = PY(svgLen(el.getAttribute('y'), vbH));
      const w = LW(svgLen(el.getAttribute('width'), vbW));
      const h = LH(svgLen(el.getAttribute('height'), vbH));
      if (w <= 0 || h <= 0) return;

      // An <image> pointing at an SVG (e.g. the brand logo) must stay VECTOR —
      // jsPDF.addImage can't embed SVG. Inline it and recurse, honouring the
      // <image>'s preserveAspectRatio (meet → fit the whole mark, centred).
      // SVG-ness is detected from the bytes (asset URLs are blob: with no hint).
      {
        let inner: any = null;
        try {
          inner = await inlineSvgFromImg(href);
          if (inner) {
            inner.setAttribute('style', `position:absolute;left:-99999px;top:0;width:${Math.max(1, Math.round(w))}px;height:${Math.max(1, Math.round(h))}px`);
            document.body.appendChild(inner);
            const ivb  = inner.viewBox?.baseVal;
            const ivbW = (ivb && ivb.width  > 0) ? ivb.width  : w;
            const ivbH = (ivb && ivb.height > 0) ? ivb.height : h;
            const par  = (el.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim();
            let fx = x, fy = y, fw = w, fh = h;
            if (!/^none/i.test(par)) {                 // meet: preserve aspect, centre
              const s = Math.min(w / ivbW, h / ivbH);
              fw = ivbW * s; fh = ivbH * s;
              fx = x + (w - fw) / 2; fy = y + (h - fh) / 2;
            }
            // A nested <image href> is a REFERENCED asset (a user logo/photo), not
            // Lolly-rendered content — never imprint it (KEY PRINCIPLE). Its own
            // gradient/filter rasterisation fallback stays unmarked (imprint omitted).
            await drawSvgVectorsInRegion(pdf, inner, fx, fy, fw, fh, registeredFonts);
          }
        } catch { /* fall through to raster */ }
        finally { inner?.remove(); }
        if (inner) return;
      }

      try {
        const dataUrl = href.startsWith('data:') ? href : await blobToDataUrl(href);
        const { src: imgSrc, fmt } = await imageForPdf(dataUrl);
        pdf.addImage(imgSrc, fmt, x, y, w, h);
      } catch { /* skip unresolvable images */ }
      return;
    }

    // <use href="#id"> renders a deep clone of the referenced element at the use's
    // position. Equivalent to a <g transform="[use transform] translate(x,y)"> wrapping
    // the target: the use's own transform is already folded into tx/ty/sX/sY above, so
    // here we add the x/y translate and walk the target. Previously <use> fell through to
    // the child-recurse and, having no light-DOM children, drew NOTHING. The referenced
    // subtree renders WITHOUT its definition-site ancestors (SVG spec), so visiting the
    // target directly (bypassing the skipped <defs>/<symbol>) is correct.
    if (tag === 'use') {
      const href = (el.getAttribute('href') || el.getAttribute('xlink:href') || '').trim();
      if (!href.startsWith('#') || useDepth >= MAX_USE_DEPTH) return;
      let target: Element | null = null;
      try { target = svgEl.querySelector('#' + CSS.escape(href.slice(1))); } catch { target = null; }
      if (!target || target === el) return;
      const utx = tx + sX * svgLen(el.getAttribute('x'), vbW);
      const uty = ty + sY * svgLen(el.getAttribute('y'), vbH);
      const ttag = target.tagName?.toLowerCase().replace(/^svg:/, '');
      useDepth++;
      try {
        // A <symbol>/<svg> target contributes its CHILDREN (the element itself is a skipped
        // container); any other element (path/g/shape) is walked directly.
        if (ttag === 'symbol' || ttag === 'svg') { for (const c of target.children) await visit(c, utx, uty, sX, sY); }
        else await visit(target, utx, uty, sX, sY);
      } finally { useDepth--; }
      return;
    }

    for (const child of el.children) await visit(child, tx, ty, sX, sY);
    };

    if (rotDeg) {
      // Rotate pivot mapped to PDF pt through this element's composed diagonal
      // transform. A reflection (negative determinant, e.g. a scale(-1) mirror
      // ancestor) reverses rotation handedness, so negate to match the SVG.
      const rotPx = ox + ((tx + sX * rotCx) - vbX) * sx;
      const rotPy = oy + ((ty + sY * rotCy) - vbY) * sy;
      const deg = (sX * sY * sx * sy) < 0 ? -rotDeg : rotDeg;
      await withPdfRotation(pdf, deg, rotPx, rotPy, drawSelf);
    } else {
      await drawSelf();
    }
  }

  await visit(svgEl, 0, 0, 1, 1);
}

// Reads a CSS property from an element's style attribute (not computed style).
// Used to extract fill/stroke when they are set via style="" rather than as attributes.
function resolveStyleProp(el: any, prop: string): string | null {
  const styleAttr = el.getAttribute('style') ?? '';
  const m = styleAttr.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)'));
  return m ? m[1]!.trim() : null;
}


// Rasterise a CSS linear- or radial-gradient fill to a PNG data URL at pxW×pxH. jsPDF's
// compat-mode API has no vector shading (patterns need advancedAPI, which flips the
// coordinate system), so the PDF walker embeds this bounded bitmap as the box background —
// faithful multi-stop + angle and alpha-correct (unlike the old flat-midpoint solid),
// reusing the SAME build{Linear,Radial}GradientEl the SVG walker emits so both paths agree.
// `w`/`h` are the box size in CSS px. Returns null when the value isn't a parseable
// linear/radial gradient (the caller falls back to the midpoint solid).
async function gradientPng(bgImg: string, w: number, h: number, pxW: number, pxH: number, imprint?: ImprintState): Promise<string | null> {
  const NS = 'http://www.w3.org/2000/svg';
  const grad = buildLinearGradientEl(NS, bgImg, 0, 0, w, h, 1)
    || buildRadialGradientEl(NS, bgImg, 0, 0, w, h, 1);
  if (!grad) return null;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const defs = document.createElementNS(NS, 'defs');
  defs.appendChild(grad);
  svg.appendChild(defs);
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', '0'); rect.setAttribute('y', '0');
  rect.setAttribute('width', String(w)); rect.setAttribute('height', String(h));
  rect.setAttribute('fill', 'url(#svggrad-1)');
  svg.appendChild(rect);
  return rasterizeSvgElement(svg, pxW, pxH, false, imprint);
}

// Rasterise ONE outer box-shadow (shape only — never the element's content/text) to a
// PNG for the PDF walker: jsPDF has no blur primitive, so a soft shadow is embedded as a
// bounded shadow-only bitmap behind the box, mirroring the SVG walker's feGaussianBlur
// shape (makeRoundedFill + the identical stdDeviation = blur/2). Returns the PNG plus the
// shadow's region in element-local CSS px (the caller scales to pt + places it behind the
// box). `wCss`/`hCss` are the box size in CSS px; `radiiCss` the CSS-px corner radii.
/**
 * An INSET shadow as a shadow-only bitmap covering exactly the element's box.
 *
 * Same geometry the SVG walker emits (which measures 0.02% against the browser): the
 * region between the border box and an offset, spread-shrunken copy of it, as one
 * evenodd path, blurred and clipped to the box. PDF has no blur operator, so unlike
 * SVG this has to be baked — but baking a shadow is a far smaller compromise than
 * baking the element, and it is the mechanism the soft OUTER shadow already uses here.
 */
/**
 * A blurred text shadow as a shadow-only bitmap covering the line box plus `pad`.
 *
 * `d` is the shaped glyph outline in CSS px with its origin on the text baseline, so
 * the SVG places it at (pad + offset, pad + baseline-within-line + offset).
 */
async function rasterizeTextShadow(
  glyphs: { d: string } | { text: string; style: CSSStyleDeclaration },
  sh: { x: number; y: number; blur: number }, col: Rgba,
  lineW: number, lineH: number, baselineInLine: number, pad: number,
  dprX: number, dprY: number, imprint?: ImprintState,
): Promise<string | null> {
  const rw = lineW + 2 * pad, rh = lineH + 2 * pad;
  if (rw <= 0 || rh <= 0) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('viewBox', `0 0 ${n2(rw)} ${n2(rh)}`);
  const defs = document.createElementNS(NS, 'defs');
  const filt = document.createElementNS(NS, 'filter');
  filt.setAttribute('id', 'ts');
  filt.setAttribute('x', '-50%'); filt.setAttribute('y', '-50%');
  filt.setAttribute('width', '200%'); filt.setAttribute('height', '200%');
  filt.setAttribute('color-interpolation-filters', 'sRGB');
  const fe = document.createElementNS(NS, 'feGaussianBlur');
  fe.setAttribute('stdDeviation', String(sh.blur / 2));   // CSS blur radius → σ
  filt.appendChild(fe);
  defs.appendChild(filt);
  svg.appendChild(defs);
  // Outlined glyphs when the caller has them; otherwise an SVG <text> in the run's
  // own font. The raster happens in the browser, so the page's fonts resolve — this
  // is the same shape the run itself takes when text-to-path is unavailable.
  let p: Element;
  if ('d' in glyphs) {
    p = document.createElementNS(NS, 'path');
    p.setAttribute('d', glyphs.d);
    p.setAttribute('transform', `translate(${n2(pad + sh.x)},${n2(pad + baselineInLine + sh.y)})`);
  } else {
    p = document.createElementNS(NS, 'text');
    p.setAttribute('x', String(n2(pad + sh.x)));
    p.setAttribute('y', String(n2(pad + baselineInLine + sh.y)));
    p.setAttribute('dominant-baseline', 'alphabetic');
    p.setAttribute('font-family', glyphs.style.fontFamily);
    p.setAttribute('font-size', glyphs.style.fontSize);
    p.setAttribute('font-weight', glyphs.style.fontWeight);
    p.setAttribute('font-style', glyphs.style.fontStyle);
    if (glyphs.style.letterSpacing && glyphs.style.letterSpacing !== 'normal') {
      p.setAttribute('letter-spacing', glyphs.style.letterSpacing);
    }
    p.textContent = glyphs.text;
  }
  p.setAttribute('fill', `rgb(${col[0]},${col[1]},${col[2]})`);
  if (col[3] < 1) p.setAttribute('fill-opacity', String(col[3]));
  p.setAttribute('filter', 'url(#ts)');
  svg.appendChild(p);
  const pxW = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(rw * dprX)));
  const pxH = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(rh * dprY)));
  return await rasterizeSvgElement(svg, pxW, pxH, false, imprint);
}

async function rasterizeInsetShadow(
  sh: { x: number; y: number; blur: number; spread: number; color: string },
  wCss: number, hCss: number, radiiCss: CornerRadii, dprX: number, dprY: number, imprint?: ImprintState,
): Promise<string | null> {
  const col = parseCssColorFull(sh.color);
  if (!col || wCss <= 0 || hCss <= 0) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('viewBox', `0 0 ${n2(wCss)} ${n2(hCss)}`);
  const defs = document.createElementNS(NS, 'defs');

  const iw = Math.max(0, wCss - 2 * sh.spread), ih = Math.max(0, hCss - 2 * sh.spread);
  const pad = sh.blur * 3 + Math.abs(sh.x) + Math.abs(sh.y) + Math.abs(sh.spread) + 8;
  const ring = document.createElementNS(NS, 'path');
  ring.setAttribute('d',
    `M${n2(-pad)} ${n2(-pad)}H${n2(wCss + pad)}V${n2(hCss + pad)}H${n2(-pad)}Z` +
    roundedRectPath(sh.x + sh.spread, sh.y + sh.spread, iw, ih, insetCorners(radiiCss, sh.spread)));
  ring.setAttribute('fill-rule', 'evenodd');
  ring.setAttribute('fill', `rgb(${col[0]},${col[1]},${col[2]})`);
  if (col[3] < 1) ring.setAttribute('fill-opacity', String(col[3]));

  if (sh.blur > 0) {
    const filt = document.createElementNS(NS, 'filter');
    filt.setAttribute('id', 'ish');
    filt.setAttribute('filterUnits', 'userSpaceOnUse');
    filt.setAttribute('x', String(n2(-pad))); filt.setAttribute('y', String(n2(-pad)));
    filt.setAttribute('width', String(n2(wCss + 2 * pad))); filt.setAttribute('height', String(n2(hCss + 2 * pad)));
    filt.setAttribute('color-interpolation-filters', 'sRGB');
    const fe = document.createElementNS(NS, 'feGaussianBlur');
    fe.setAttribute('stdDeviation', String(sh.blur / 2));   // CSS blur radius → σ
    filt.appendChild(fe);
    defs.appendChild(filt);
    ring.setAttribute('filter', 'url(#ish)');
  }
  const clip = document.createElementNS(NS, 'clipPath');
  clip.setAttribute('id', 'ic');
  clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
  clip.appendChild(makeRoundedFill(NS, 0, 0, wCss, hCss, radiiCss, uniformRadius(radiiCss), '#fff'));
  defs.appendChild(clip);
  ring.setAttribute('clip-path', 'url(#ic)');
  svg.appendChild(defs);
  svg.appendChild(ring);

  const pxW = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(wCss * dprX)));
  const pxH = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(hCss * dprY)));
  return await rasterizeSvgElement(svg, pxW, pxH, false, imprint);
}

async function rasterizeBoxShadow(
  sh: { x: number; y: number; blur: number; spread: number; color: string },
  wCss: number, hCss: number, radiiCss: CornerRadii, dprX: number, dprY: number, imprint?: ImprintState,
): Promise<{ png: string; rx: number; ry: number; rw: number; rh: number } | null> {
  const col = parseCssColorFull(sh.color);
  if (!col) return null;
  const sw = Math.max(0, wCss + 2 * sh.spread);
  const shh = Math.max(0, hCss + 2 * sh.spread);
  if (sw <= 0 || shh <= 0) return null;
  const pad = sh.blur * 1.5 + Math.abs(sh.spread) + 8;    // matches the SVG walker's blur pad
  const shapeX = sh.x - sh.spread, shapeY = sh.y - sh.spread;   // element-local CSS px
  const rx = shapeX - pad, ry = shapeY - pad, rw = sw + 2 * pad, rh = shh + 2 * pad;
  const sRadii = insetCorners(radiiCss, -sh.spread);             // negative inset = outset
  const fill = col[3] < 1 ? `rgba(${col[0]},${col[1]},${col[2]},${col[3]})` : `rgb(${col[0]},${col[1]},${col[2]})`;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('viewBox', `${n2(rx)} ${n2(ry)} ${n2(rw)} ${n2(rh)}`);
  const shape = makeRoundedFill(NS, shapeX, shapeY, sw, shh, sRadii, uniformRadius(sRadii), fill);
  if (sh.blur > 0) {
    const defs = document.createElementNS(NS, 'defs');
    const filt = document.createElementNS(NS, 'filter');
    filt.setAttribute('id', 'sh');
    filt.setAttribute('filterUnits', 'userSpaceOnUse');
    filt.setAttribute('x', String(n2(rx))); filt.setAttribute('y', String(n2(ry)));
    filt.setAttribute('width', String(n2(rw))); filt.setAttribute('height', String(n2(rh)));
    filt.setAttribute('color-interpolation-filters', 'sRGB');   // CSS composites in sRGB
    const fe = document.createElementNS(NS, 'feGaussianBlur');
    fe.setAttribute('in', 'SourceGraphic');
    fe.setAttribute('stdDeviation', String(sh.blur / 2));
    filt.appendChild(fe);
    defs.appendChild(filt);
    svg.appendChild(defs);
    shape.setAttribute('filter', 'url(#sh)');
  }
  svg.appendChild(shape);
  // Per-axis density (points→px) so the bitmap hits RASTER_DPI in the placed PT region,
  // not RASTER_DPI/scale — the region is placed at rw*scaleX × rh*scaleY pt.
  const pxW = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(rw * dprX)));
  const pxH = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(rh * dprY)));
  const png = await rasterizeSvgElement(svg, pxW, pxH, false, imprint);
  return { png, rx, ry, rw, rh };
}


// Walks the live DOM tree and emits jsPDF vector objects:
//   • background-color → filled rect / roundedRect
//   • border-top → thin filled rect (used for divider lines)
//   • <svg> subtrees → drawSvgVectorsInRegion
//   • <img> → addImage (circular headshots pre-clipped to a canvas)
//   • block-level leaf text → pdf.text() with computed font/color/align
//
// Font: custom webfonts (e.g. SUSE) are approximated with Helvetica. Text is
// still selectable/searchable vector — only the typeface differs from screen.
// Transparency: jsPDF fills are opaque; semi-transparent CSS colors render at
// full opacity (acceptable approximation for brand colours).
// Rasterise a live <svg> subtree (inner <style> + gradients intact) to a PNG
// data URL, alpha preserved. The PDF walker uses this for gradient / filter
// illustrations the vector path can't reproduce faithfully (no shading; CSS-class
// fills). `flipX` mirrors horizontally to honour a scaleX(-1) CSS transform.
async function rasterizeSvgElement(svgEl: Element, pxW: number, pxH: number, flipX = false, imprint?: ImprintState): Promise<string> {
  const clone = svgEl.cloneNode(true) as Element;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width',  String(pxW));
  clone.setAttribute('height', String(pxH));
  await inlineBlobUrlsInEl(clone);
  const xml = new XMLSerializer().serializeToString(clone);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('svg rasterise failed'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width  = pxW;
  canvas.height = pxH;
  const ctx = canvas.getContext('2d')!;
  if (flipX) { ctx.translate(pxW, 0); ctx.scale(-1, 1); }
  ctx.drawImage(img, 0, 0, pxW, pxH);
  // Lolly-rendered gradient/filter/pattern subtree → carry the pixel imprint into
  // the PDF/PPTX raster it becomes (opts.imprint gated, size-floored).
  imprintEmbedCanvas(canvas, imprint);
  return canvas.toDataURL('image/png');
}

const MAX_RASTER_PX = 2000;   // per-side cap for the vector escape-hatch (matches the inline-SVG raster)
// How much already-painted content a single `backdrop-filter: blur()` may duplicate.
// The backdrop is reconstructed by copying what sits behind the element, so a blurred
// bar late in a busy page copies most of that page. Past this, the element falls back
// to the raster hatch — a wrong-but-bounded answer beats an unbounded correct one.
const BACKDROP_MAX_NODES = 400;
const RASTER_DPI = 200;       // resolution for the PDF escape-hatch (points × RASTER_DPI/72)

// Rasterise ONE live element's subtree to a PNG data URL at pxW×pxH device px — the
// vector escape-hatch: dom-to-image serialises the node's computed style into a
// detached <foreignObject> and the browser paints it, so filters / masks / blend /
// conic-gradient / clip-path render FAITHFULLY instead of being dropped by the walker.
// The node is captured into its own box at (0,0) (left/top/margin neutralised, scaled
// to fill). Returns null on failure so the caller falls through to the (lossy) vector
// walk — never worse than before. Nothing mounts on-screen, so the position:fixed
// containing-block gotcha (the offscreen-stage flash) does not apply here.
export async function rasterizeNodeToDataUrl(el: HTMLElement, pxW: number, pxH: number, bg?: string, imprint?: ImprintState, ownPaintOnly?: boolean, padPx = 0): Promise<string | null> {
  const r = el.getBoundingClientRect();
  const cssW = r.width, cssH = r.height;
  if (cssW < 0.5 || cssH < 0.5 || pxW < 2 || pxH < 2) return null;
  // `padPx`: extra output pixels on every side, with the content shifted into the
  // middle. A CSS effect can paint OUTSIDE the element's box — a drop-shadow is the
  // common one — and a capture sized to the box crops it, which is how a drop-shadow
  // came out sheared off in PDF export. The caller places the padded image at the
  // correspondingly enlarged rect.
  const pad = Math.max(0, Math.round(padPx));
  const lib = await getDomToImage();
  const restore = await swapBlobUrls(el);
  try {
    const canvas = await lib.toCanvas(el, {
      width: pxW + 2 * pad, height: pxH + 2 * pad,
      // `ownPaintOnly`: capture the element's OWN paint layer — background, border,
      // effect — and none of its descendants, so the caller can keep walking those
      // as vector. dom-to-image-more applies `filter` to every node it clones EXCEPT
      // the root, so excluding everything yields exactly the root's own paint. The
      // explicit width/height in `style` below keeps the box from collapsing when the
      // element sized to its (now absent) content.
      ...(ownPaintOnly ? { filter: (n: Node) => n === el } : {}),
      style: {
        // translate first (unscaled output px), then scale — so the element lands
        // `pad` pixels in from the top-left of the larger canvas.
        transform: `translate(${pad}px, ${pad}px) scale(${pxW / cssW}, ${pxH / cssH})`,
        transformOrigin: 'top left',
        width: `${cssW}px`, height: `${cssH}px`,
        left: '0', top: '0', margin: '0',
        ...(bg ? { background: bg } : {}),
      },
    });
    // Lolly-composited DOM subtree → carry the imprint into the PDF/PPTX/SVG raster
    // it becomes. (A user <img> descendant baked into this composite is perturbed
    // too — Lolly-composed content, PSNR-bounded; the one caveat, see task notes.)
    imprintEmbedCanvas(canvas, imprint);
    return canvas.toDataURL('image/png');
  } catch (e) {
    _host?.log?.('warn', `vector export: node rasterise fallback failed — ${(e as Error).message}`);
    return null;
  } finally {
    restore();
  }
}

// Draws the live DOM as PDF vectors into the rectangular region (ox, oy, regionW,
// regionH) in page points (top-left origin). Callers pass the full page for an
// ordinary export, or the bleed box for a print export (so the design bleeds).
//
// KNOWN LIMITATION — paint order. This walker paints in DOM order and has no
// z-index handling, exactly as the SVG walker did before `ExportOpts.
// stackingOrder`. That flag was added on the SVG side only (page snapshots go
// out as SVG), so SVG/EMF/EPS/DXF can paint in CSS 2.1 Appendix E §E.2 order and
// PDF cannot. A deliberate, recorded divergence in two walkers whose comments
// otherwise ask that they stay mirrored: PDF has no deferred-append equivalent
// here, because it emits drawing operators straight into a content stream rather
// than building a re-parentable node tree, so the same fix is a different (and
// larger) piece of work. Nothing regresses — PDF keeps the order it always had.
async function drawHtmlVectors(pdf: any, node: Element, ox: number, oy: number, regionW: number, regionH: number, convertPaths = true, onProgress?: (done: number, total: number) => void, rasterFallback = true, imprint?: ImprintState): Promise<void> {
  const rect0 = node.getBoundingClientRect();
  const scaleX = regionW / rect0.width;
  const scaleY = regionH / rect0.height;
  // CSS px → PDF pt — accounts for the CSS transform scale applied to the
  // canvas node. node.clientWidth is the layout width before the transform.
  const cssToPt = regionW / (node.clientWidth || rect0.width);
  // Virtual origin: shifting the reference top-left by the region offset bakes it
  // into every (rect − rootRect)·scale below, so the artwork lands at (ox, oy)
  // without touching the inline-text / pseudo-content helpers downstream.
  const rootRect = {
    left: rect0.left - ox / scaleX, top: rect0.top - oy / scaleY,
    width: rect0.width, height: rect0.height, right: rect0.right, bottom: rect0.bottom,
  };
  // Tracks which font variants have been registered in this PDF instance.
  const registeredFonts = new Set();

  // Cooperative yielding: the vector walk + host.text.toPath (HarfBuzz) shaping
  // below runs fully synchronously and janks the UI for the whole export on a
  // complex document. Mirror the CMYK pixel pass — every YIELD_NODES elements,
  // report progress and hand the event loop a turn. Purely additive: geometry
  // and draw order are untouched, so the emitted PDF bytes are identical.
  const totalNodes = ((node as any).querySelectorAll?.('*').length ?? 0) + 1;
  let nodesWalked = 0;
  const YIELD_NODES = 200;

  async function visit(el: any): Promise<void> {
    if (el.nodeType !== 1) return;
    if (++nodesWalked % YIELD_NODES === 0) {
      onProgress?.(Math.min(nodesWalked, totalNodes), totalNodes);
      await new Promise<void>((r) => setTimeout(r));         // unblock the UI thread
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script') return;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const elOpacity = parseFloat(style.opacity ?? '1');
    if (elOpacity === 0) return;

    // CSS rotate(): neutralise it, walk the axis-aligned subtree, and wrap the draw
    // in a jsPDF rotation about the transform-origin. Additive (no-op unrotated).
    const rotDeg = pureRotationDeg(style.transform);
    if (rotDeg) {
      const prevInline = el.style.transform;
      el.style.transform = 'none';
      const unrot = el.getBoundingClientRect();     // reading forces the reflow
      const pivot = rotationPivot(style, unrot, rootRect);
      try { await withPdfRotation(pdf, rotDeg, pivot.x * scaleX, pivot.y * scaleY, () => visit(el)); }
      finally { el.style.transform = prevInline; }
      return;
    }

    // General 2-D transform (rotate+scale / skew / matrix) that isn't a pure rotation:
    // mirror the SVG walker — neutralise, walk the untransformed subtree, wrap the draw
    // in the full CTM about the transform-origin. Pure translate/scale → AABB path below;
    // 3-D/perspective → parseCssMatrix null → AABB path.
    const mtx = pureRotationDeg(style.transform) === 0 ? parseCssMatrix(style.transform) : null;
    if (mtx && !isAxisAlignedMat(mtx)) {
      const prevInline = el.style.transform;
      el.style.transform = 'none';
      const unrot = el.getBoundingClientRect();
      const pivot = rotationPivot(style, unrot, rootRect);
      // Child geometry is drawn in anisotropically-scaled pt space (S = diag(scaleX,scaleY)),
      // so the CTM that reproduces the CSS matrix M there is S·M·S⁻¹, NOT M: the off-diagonals
      // pick up the aspect ratio (rotate/skew shear differently once x and y are scaled
      // unequally). The SVG walker gets this for free from its single outer scale(scaleX,scaleY)
      // group; the PDF walker bakes scale per-axis into every coord, so conjugate here. e,f are
      // the S-scaled translation. (Uniform scale → ar=1 → unchanged, matching withPdfRotation.)
      const ar = (scaleX && scaleY) ? scaleX / scaleY : 1;
      const mPt: Mat2D = { a: mtx.a, b: mtx.b / ar, c: mtx.c * ar, d: mtx.d, e: mtx.e * scaleX, f: mtx.f * scaleY };
      try { await withPdfMatrix(pdf, mPt, pivot.x * scaleX, pivot.y * scaleY, () => visit(el)); }
      finally { el.style.transform = prevInline; }
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 0.5 || rect.height < 0.5) return;

    const x = (rect.left - rootRect.left) * scaleX;
    const y = (rect.top  - rootRect.top)  * scaleY;
    const w = rect.width  * scaleX;
    const h = rect.height * scaleY;

    // clip-path (circle/ellipse/inset/polygon) → jsPDF clip so the node stays vector
    // (mirrors the SVG walker). Geometry is parsed in CSS px, scaled to pt when applied.
    // The clip wraps the WHOLE element paint (bg/border/content), so it goes around
    // paintEl inside a graphics-state save/restore — restored on every early-return path
    // (raster hatch / svg / img). Unparseable shapes leave clipShape null → paintEl's
    // escape-hatch rasterises them (clipBasicShapes:false).
    const cpVal = style.clipPath || (style as any).webkitClipPath;
    const clipShapeRaw = (cpVal && cpVal !== 'none') ? parseClipShape(cpVal, rect.width, rect.height) : null;
    // A zero-area clip paints nothing — return before any draw, matching the SVG walker.
    if (clipShapeRaw && clipShapeRaw.kind === 'empty') return;
    const clipShape = clipShapeRaw;
    // Partial element opacity (0<o<1): jsPDF has no group-opacity primitive, so apply it
    // as a GState alpha on the element's own draws. Correct for a LEAF (text/solid box —
    // no descendants to composite); non-leaves keep the current opaque behaviour rather
    // than mis-composite overlapping descendants (a per-op alpha ≠ CSS group opacity).
    const alpha = (elOpacity < 1 && el.children.length === 0 && typeof pdf.GState === 'function' && typeof pdf.setGState === 'function') ? elOpacity : 1;
    if (!clipShape && alpha === 1) { await paintEl(el, tag, style, rect, x, y, w, h, false); return; }
    pdf.saveGraphicsState();
    try {
      if (alpha < 1) pdf.setGState(new pdf.GState({ opacity: alpha, 'stroke-opacity': alpha }));
      if (clipShape) pdfApplyClip(pdf, clipShape, x, y, scaleX, scaleY);
      await paintEl(el, tag, style, rect, x, y, w, h, !!clipShape);
    } finally { pdf.restoreGraphicsState(); }
  }

  // Paint one element's background, borders, SVG/image content, and (unless it returns
  // early) its block children + inline text + pseudo content. Split out of visit() so a
  // clip-path can wrap the whole paint with a guaranteed graphics-state restore.
  // `clipBasicShapes` = the element's clip-path was vectorised, so a basic-shape clip
  // isn't re-rasterised by the escape-hatch below.
  async function paintEl(el: any, tag: string, style: CSSStyleDeclaration, rect: DOMRect, x: number, y: number, w: number, h: number, clipBasicShapes: boolean): Promise<void> {
    // CSS-px CornerRadii → pt (per axis). Shared by the box-shadow, background and border.
    const scaleRadii = (r: CornerRadii): CornerRadii => ({
      topLeft:     [r.topLeft[0]     * scaleX, r.topLeft[1]     * scaleY],
      topRight:    [r.topRight[0]    * scaleX, r.topRight[1]    * scaleY],
      bottomRight: [r.bottomRight[0] * scaleX, r.bottomRight[1] * scaleY],
      bottomLeft:  [r.bottomLeft[0]  * scaleX, r.bottomLeft[1]  * scaleY],
    });

    // ── Box shadow (painted behind everything, mirrors the SVG walker) ──────────
    // A HARD shadow (blur 0) is a plain offset shape → true vector rounded rect. A SOFT
    // (blurred) shadow has no jsPDF vector primitive, so it's a bounded shadow-ONLY raster
    // (never the element's content/text). PDF-only path — EMF/EPS go through the SVG walker
    // with noBoxShadow, so no gate is needed here.
    if (tag !== 'img' && tag !== 'svg' && style.boxShadow && style.boxShadow !== 'none') {
      const { radii: shRadiiCss } = resolveRadii(style, rect.width, rect.height);
      // KNOWN DIVERGENCE: outer shadows only. The SVG walker draws inset shadows too
      // (a clipped evenodd ring); the PDF walker has no clip+filter equivalent wired
      // up here yet, and drawing an inset shadow as an outer one would be worse than
      // omitting it.
      for (const sh of parseBoxShadow(style.boxShadow).reverse()) {
        if (sh.inset) continue;
        if (sh.blur <= 0) {
          // hard shadow → vector: offset+spread-grown rounded rect in the shadow colour
          const col = parseCssColorFull(sh.color);
          const sw = Math.max(0, rect.width + 2 * sh.spread), shh = Math.max(0, rect.height + 2 * sh.spread);
          if (!col || sw <= 0 || shh <= 0) continue;
          const sRadii = scaleRadii(insetCorners(shRadiiCss, -sh.spread));
          const sx = x + (sh.x - sh.spread) * scaleX, sy = y + (sh.y - sh.spread) * scaleY;
          pdf.setFillColor(col[0], col[1], col[2]);
          withPdfAlpha(pdf, col[3], () => pdfRoundedRect(pdf, sx, sy, sw * scaleX, shh * scaleY, sRadii, uniformRadius(sRadii), 'F'));
        } else {
          // soft shadow → concentric bands, outermost first. PDF has no blur operator,
          // but the blur of an edge IS the Gaussian CDF, so painting the shape at a
          // series of outsets with the right alpha increments reproduces it in pure
          // vector — no embedded bitmap, editable, resolution-independent. Bands come
          // from the engine (gaussianShadowBands) so PDF and any other blur-less
          // renderer share one derivation.
          const col = parseCssColorFull(sh.color);
          const bands = col ? gaussianShadowBands(sh.blur, col[3]) : [];
          if (col && bands.length) {
            pdf.setFillColor(col[0], col[1], col[2]);
            for (const band of bands) {
              const t = sh.spread + band.outset;
              const bw = rect.width + 2 * t, bh = rect.height + 2 * t;
              if (bw <= 0 || bh <= 0) continue;
              const bRadii = scaleRadii(insetCorners(shRadiiCss, -t));   // negative inset = outset
              const bx = x + (sh.x - t) * scaleX, by = y + (sh.y - t) * scaleY;
              withPdfAlpha(pdf, band.alpha, () =>
                pdfRoundedRect(pdf, bx, by, bw * scaleX, bh * scaleY, bRadii, uniformRadius(bRadii), 'F'));
            }
          } else {
            // No parseable colour → the old bounded shadow-only raster.
            try {
              const dens = RASTER_DPI / 72;
              const res = await rasterizeBoxShadow(sh, rect.width, rect.height, shRadiiCss, dens * scaleX, dens * scaleY, imprint);
              if (res) pdf.addImage(res.png, 'PNG', x + res.rx * scaleX, y + res.ry * scaleY, res.rw * scaleX, res.rh * scaleY);
            } catch { /* skip a shadow that won't rasterise */ }
          }
        }
      }
    }

    // ── Rasterise escape-hatch (mirrors visitSvgNode) ───────────────────────────
    // Node uses CSS the walker can't express → embed it as an image at its rect
    // instead of dropping the effect. Returns on success so children/bg/text aren't
    // re-drawn. w,h are in points; RASTER_DPI sets the embedded bitmap resolution.
    const rasterReason = rasterFallback ? detectUnsupportedCss(el, style, { clipBasicShapes }) : null;
    if (rasterReason) {
      const dpr = RASTER_DPI / 72;
      const pxW = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(w * dpr)));
      const pxH = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(h * dpr)));
      // How far this element's effects paint OUTSIDE its box. A `filter` is the case
      // that matters: capturing a drop-shadowed element at exactly its rect shears
      // the shadow off, which measured 2.1% mean / 32% worst-pixel against the
      // browser — the single largest shadow error left in PDF output.
      //
      // Units are the trap here: `pxW` is derived from `w`, which is POINTS, while the
      // spill is CSS px. The pad has to be converted to points first and only then to
      // capture pixels, or the padded image is placed at a rect that does not match the
      // padding inside it — which measured WORSE than not padding at all.
      const spillCss = effectSpillCss(style);
      const padPt = spillCss * scaleX;
      const padPx = Math.round(padPt * dpr);
      const png = await rasterizeNodeToDataUrl(el as HTMLElement, pxW, pxH, undefined, imprint, false, padPx);
      if (png) {
        _host?.log?.('info', `pdf: rasterised <${tag}> (unsupported ${rasterReason})`);
        pdf.addImage(png, 'PNG', x - padPt, y - padPt, w + 2 * padPt, h + 2 * padPt);
        return;
      }
      // png == null → fall through to the vector walk.
    }

    // ── Background fill ───────────────────────────────────────────────────────
    // CSS corner-overlap clamped (→ pill, not ellipse) via the shared engine math,
    // resolved in CSS px then scaled per axis. Uniform corners take jsPDF's fast
    // roundedRect; differing corners take a four-corner path.
    const { radii: radiiCss, uniform: uniformCss } = resolveRadii(style, rect.width, rect.height);
    const radii = scaleRadii(radiiCss);
    const uniform: CornerPair | null = uniformCss ? [uniformCss[0] * scaleX, uniformCss[1] * scaleY] : null;
    const hasRadius = uniform ? (uniform[0] > 0 || uniform[1] > 0) : true;
    const bgImg = style.backgroundImage;
    if (bgImg && (/^radial-gradient\(/.test(bgImg) || /^linear-gradient\(/.test(bgImg))) {
      // linear/radial gradient: rasterise the fill (faithful multi-stop + angle,
      // alpha-correct) and place it as the box background, clipped to the rounded box —
      // jsPDF compat mode has no vector shading. A solid background-color paints behind it
      // (CSS order) so a gradient with transparent stops sits on the right colour. If the
      // gradient can't be parsed/rasterised we fall back to the flat solid-midpoint so we
      // are never WORSE than before.
      const solid = parseCssColor(style.backgroundColor);
      if (solid) { pdf.setFillColor(solid[0], solid[1], solid[2]); pdfRoundedRect(pdf, x, y, w, h, radii, uniform, 'F'); }
      let placed = false;
      // 1) TRUE VECTOR — a jsPDF ShadingPattern, unless the gradient has transparent
      //    stops (PDF shading carries no per-stop alpha → would lose them).
      const spec = pdfGradientSpec(bgImg, x, y, w, h);
      if (spec && !spec.hasAlpha) {
        placed = fillPdfShading(pdf, spec, (doc) =>
          drawSvgPathToPdf(doc, roundedRectPath(x, y, w, h, radii), (v) => v, (v) => v));
      }
      // 2) FAITHFUL RASTER — alpha stops, an unparseable value, or no shading API.
      if (!placed) {
        try {
          const dpr = RASTER_DPI / 72;
          const pxW = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(w * dpr)));
          const pxH = Math.max(2, Math.min(MAX_RASTER_PX, Math.round(h * dpr)));
          const png = await gradientPng(bgImg, rect.width, rect.height, pxW, pxH, imprint);
          if (png) {
            if (hasRadius) await withPdfRoundedClip(pdf, x, y, w, h, radii, uniform, () => pdf.addImage(png, 'PNG', x, y, w, h));
            else pdf.addImage(png, 'PNG', x, y, w, h);
            placed = true;
          }
        } catch { /* fall through to the midpoint solid */ }
      }
      // 3) LAST RESORT — a flat midpoint solid (only if nothing painted yet).
      if (!placed && !solid) {
        const mid = sampleGradientMidpoint(bgImg);
        if (mid) { pdf.setFillColor(mid[0], mid[1], mid[2]); pdfRoundedRect(pdf, x, y, w, h, radii, uniform, 'F'); }
      }
    } else {
      // Solid background-color first (bottom layer).
      const solid = parseCssColor(style.backgroundColor);
      if (solid) { pdf.setFillColor(solid[0], solid[1], solid[2]); pdfRoundedRect(pdf, x, y, w, h, radii, uniform, 'F'); }
      // background-image: url() → a real embedded image (vector-first for the box: its
      // text/children stay vector instead of the whole node being rasterised). cover/contain
      // fitted from the image's natural size, clipped to the box.
      const bgUrl = (bgImg && bgImg !== 'none') ? firstCssUrl(bgImg) : null;
      if (bgUrl) {
        try {
          const href = await cssUrlToHref(bgUrl);
          if (href) {
            const { src, fmt } = await imageForPdf(href);
            const dims = await imageDims(src);
            const fit = dims ? bgFitRect(dims.w, dims.h, x, y, w, h, style) : { x, y, w, h, overflows: false };
            const draw = () => pdf.addImage(src, fmt, fit.x, fit.y, fit.w, fit.h);
            if (hasRadius || fit.overflows) await withPdfRoundedClip(pdf, x, y, w, h, radii, uniform, draw);
            else draw();
          }
        } catch { /* skip the bg image — the box's own content still renders vector */ }
      } else if (bgImg && bgImg !== 'none' && !solid) {
        // a non-url, non-gradient bg (e.g. a lone unresolved value) → the old midpoint solid
        const mid = sampleGradientMidpoint(bgImg);
        if (mid) { pdf.setFillColor(mid[0], mid[1], mid[2]); pdfRoundedRect(pdf, x, y, w, h, radii, uniform, 'F'); }
      }
    }

    // ── Inset box-shadow ──────────────────────────────────────────────────────
    // CSS paints an inset shadow over the background and under the border, so it goes
    // between the two. Baked to a shadow-only bitmap covering exactly the box: PDF has
    // no blur operator, and baking the shadow is a far smaller compromise than baking
    // the element — the same trade the soft outer shadow already makes here.
    for (const sh of parseBoxShadow(style.boxShadow).reverse()) {
      if (!sh.inset) continue;
      const icol = parseCssColorFull(sh.color);
      // Same band derivation as the outer shadow, mirrored: an inset shadow is the
      // blur of the region OUTSIDE the offset, shrunken inner shape, so each band is
      // a RING — everything except that shape shrunk by the band's outset — filled
      // even-odd and clipped to the box.
      const ibands = icol ? gaussianShadowBands(sh.blur, icol[3]) : [];
      if (icol && (ibands.length || sh.blur <= 0)) {
        const iw = Math.max(0, rect.width - 2 * sh.spread);
        const ih = Math.max(0, rect.height - 2 * sh.spread);
        const iRadiiCss = insetCorners(radiiCss, sh.spread);
        const steps = ibands.length ? ibands : [{ outset: 0, alpha: icol[3] }];
        await withPdfRoundedClip(pdf, x, y, w, h, radii, uniform, () => {
          pdf.setFillColor(icol[0], icol[1], icol[2]);
          for (const band of steps) {
            const t = band.outset;
            const bw = iw - 2 * t, bh = ih - 2 * t;
            // Past the point where the inner shape collapses, the ring is the whole
            // box — the shadow has closed over the middle.
            const inner = bw > 0 && bh > 0
              ? roundedRectPath(sh.x + sh.spread + t, sh.y + sh.spread + t, bw, bh, insetCorners(iRadiiCss, t))
              : '';
            const outer = `M0 0H${n2(rect.width)}V${n2(rect.height)}H0Z`;
            withPdfAlpha(pdf, band.alpha, () => {
              drawSvgPathToPdf(pdf, outer + inner,
                (sx: number) => x + sx * scaleX, (sy: number) => y + sy * scaleY);
              pdf.fillEvenOdd();
            });
          }
        });
      } else {
        try {
          const dens = RASTER_DPI / 72;
          const png = await rasterizeInsetShadow(sh, rect.width, rect.height, radiiCss,
            dens * scaleX, dens * scaleY, imprint);
          if (png) pdf.addImage(png, 'PNG', x, y, w, h);
        } catch { /* skip a shadow that won't rasterise */ }
      }
    }

    // ── Borders ───────────────────────────────────────────────────────────────
    // A uniform border is stroked as one rect/path (so a radius is honoured); a
    // divider (border-top only) or mixed border fills per edge. Colours keep their
    // alpha via GState (jsPDF GState is sticky, so withPdfAlpha resets it).
    const bSide = (wKey: string, cKey: string): { bw: number; rgb: Rgba | null } => {
      const bw = parseFloat((style as any)[wKey]) || 0;
      return { bw, rgb: bw > 0 ? parseCssColorFull((style as any)[cKey]) : null };
    };
    const bT = bSide('borderTopWidth',    'borderTopColor');
    const bR = bSide('borderRightWidth',  'borderRightColor');
    const bB = bSide('borderBottomWidth', 'borderBottomColor');
    const bL = bSide('borderLeftWidth',   'borderLeftColor');
    const eqRgb = (a: Rgba | null, b: Rgba | null) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
    const uniformBorder = bT.rgb && bT.bw === bR.bw && bT.bw === bB.bw && bT.bw === bL.bw
      && eqRgb(bT.rgb, bR.rgb) && eqRgb(bT.rgb, bB.rgb) && eqRgb(bT.rgb, bL.rgb);
    if (uniformBorder) {
      const lw = bT.bw * scaleY;
      pdf.setDrawColor(bT.rgb![0], bT.rgb![1], bT.rgb![2]);
      pdf.setLineWidth(lw);
      // CSS border-box: the border sits inside w×h; jsPDF strokes centred, so inset by lw/2.
      const innerUniform: CornerPair | null = uniform ? [Math.max(0, uniform[0] - lw / 2), Math.max(0, uniform[1] - lw / 2)] : null;
      // dashed/dotted → a line-dash pattern (jsPDF dash is sticky, so reset after). Round
      // caps for dotted give round dots. Guarded — older jsPDF lacks the setters.
      const dash = borderDashArray(style.borderTopStyle, lw);
      if (dash && typeof pdf.setLineDashPattern === 'function') {
        pdf.setLineDashPattern(dash.dash, 0);
        if (dash.round && typeof pdf.setLineCap === 'function') pdf.setLineCap('round');
      }
      withPdfAlpha(pdf, bT.rgb![3], () =>
        pdfRoundedRect(pdf, x + lw / 2, y + lw / 2, w - lw, h - lw,
          insetCorners(radii, lw / 2), innerUniform, 'S'));
      if (dash && typeof pdf.setLineDashPattern === 'function') {
        pdf.setLineDashPattern([], 0);
        if (dash.round && typeof pdf.setLineCap === 'function') pdf.setLineCap('butt');
      }
    } else {
      const edge = (rgb: Rgba, dx: number, dy: number, ew: number, eh: number) => withPdfAlpha(pdf, rgb[3], () => {
        pdf.setFillColor(rgb[0], rgb[1], rgb[2]); pdf.rect(dx, dy, ew, eh, 'F');
      });
      if (bT.rgb) edge(bT.rgb, x, y, w, bT.bw * scaleY);
      if (bB.rgb) edge(bB.rgb, x, y + h - bB.bw * scaleY, w, bB.bw * scaleY);
      if (bL.rgb) edge(bL.rgb, x, y, bL.bw * scaleX, h);
      if (bR.rgb) edge(bR.rgb, x + w - bR.bw * scaleX, y, bR.bw * scaleX, h);
    }

    // ── SVG subtree → vector region (or raster for gradient illustrations) ─────
    if (tag === 'svg') {
      // Gradient / filter illustrations (e.g. the bag-video Geeko) can't be
      // reproduced by the vector walker: drawSvgVectorsInRegion has no axial /
      // radial shading and reads fills only from attributes or inline style, so
      // url(#gradient) fills disappear and CSS-class fills (declared in an inner
      // <style>) fall back to black — a solid silhouette. The SVG export keeps
      // these vector by cloning the node verbatim; for PDF we rasterise just this
      // subtree to a PNG (alpha preserved) so it keeps its shading, and reserve
      // the crisp vector walk for solid-fill SVGs (qr, lockup, …).
      if (el.querySelector('linearGradient, radialGradient, filter, pattern')) {
        try {
          // Resolution from the OUTPUT region (points → px at ~150dpi), not the
          // on-screen box — so it's independent of the preview zoom and bounded.
          const dpr = 150 / 72;
          const pxW = Math.max(2, Math.min(2000, Math.round(w * dpr)));
          const pxH = Math.max(2, Math.min(2000, Math.round(h * dpr)));
          // Honour a scaleX(-1) flip (computed transform's matrix a-component < 0).
          const tm = String(style.transform || '').match(/matrix\(\s*(-?[\d.]+)/);
          const flipX = tm ? parseFloat(tm[1]!) < 0 : el.classList.contains('flip');
          const png = await rasterizeSvgElement(el, pxW, pxH, flipX, imprint);
          pdf.addImage(png, 'PNG', x, y, w, h);
          return;
        } catch { /* fall through to the vector walk */ }
      }
      await drawSvgVectorsInRegion(pdf, el, x, y, w, h, registeredFonts, imprint);
      return;
    }

    // ── Image (raster, or inlined SVG → vectors) ──────────────────────────────
    if (tag === 'img') {
      const src = el.src || el.getAttribute('src') || '';
      if (!src || w <= 0 || h <= 0) return;

      // SVG images (e.g. the corner brand logo) must stay VECTOR — rasterising
      // them breaks true CMYK output and looks soft. Inline the SVG and draw it
      // through the same vector path as an inline <svg>, honouring object-fit:
      // "cover" slice-fits (fills the box, clipping the overflow — e.g. an SVG
      // hero/masthead), everything else "meet"-fits (whole mark, centred = contain).
      // SVG-ness is detected from the bytes (asset URLs are blob: with no hint).
      {
        let svgEl: any = null;
        try {
          svgEl = await inlineSvgFromImg(src);
          if (svgEl) {
            // Off-screen so viewBox.baseVal + any computed fills resolve.
            svgEl.setAttribute('style', `position:absolute;left:-99999px;top:0;width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px`);
            document.body.appendChild(svgEl);
            const vb = svgEl.viewBox?.baseVal;
            const vbW = (vb && vb.width  > 0) ? vb.width  : rect.width;
            const vbH = (vb && vb.height > 0) ? vb.height : rect.height;
            const cover = style.objectFit === 'cover';
            const s = cover ? Math.max(w / vbW, h / vbH) : Math.min(w / vbW, h / vbH);
            const fw = vbW * s, fh = vbH * s;
            const [px, py] = objectPositionFractions(style.objectPosition);
            const dx = x + (w - fw) * px, dy = y + (h - fh) * py;
            // This SVG came from a user <img src> (a logo/photo asset), not from
            // Lolly's own render — never imprint it (KEY PRINCIPLE). imprint omitted,
            // so its gradient-rasterisation fallback keeps the user's pixels intact.
            if (cover) {
              await withPdfClipRect(pdf, x, y, w, h, () => drawSvgVectorsInRegion(pdf, svgEl, dx, dy, fw, fh, registeredFonts));
            } else {
              await drawSvgVectorsInRegion(pdf, svgEl, dx, dy, fw, fh, registeredFonts);
            }
          }
        } catch { /* fall through to the raster path */ }
        finally { svgEl?.remove(); }
        if (svgEl) return;
      }
        try {
          const dataUrl0 = src.startsWith('data:') ? src
            : src.startsWith('blob:') ? await blobToDataUrl(src) : src;
          // Bake any CSS filter() into the bitmap (browser canvas) so PDF matches
          // screen/PNG; no-op + graceful fallback when filter is none.
          const dataUrl = await bakeImageFilter(el, dataUrl0, style.filter);

          // Clip circular images (headshots with border-radius: 50%)
          const rTL = parseCssLen(style.borderTopLeftRadius,     rect.width);
          const rTR = parseCssLen(style.borderTopRightRadius,    rect.width);
          const rBL = parseCssLen(style.borderBottomLeftRadius,  rect.width);
          const rBR = parseCssLen(style.borderBottomRightRadius, rect.width);
          const minR  = Math.min(rTL, rTR, rBL, rBR);
          const halfMin = Math.min(rect.width, rect.height) * 0.45;
          const isCircle = minR >= halfMin;

          // circularClipImage prefers the live (unfiltered) <img>; when a filter was
          // baked, clip the filtered data URL instead so the treatment survives.
          const imgUrl = isCircle
            ? await circularClipImage(style.filter && style.filter !== 'none' ? null : el, dataUrl).catch(() => dataUrl)
            : dataUrl;
          const { src: imgSrc, fmt } = await imageForPdf(imgUrl);
          // Honour object-fit against the image's natural aspect (matches screen/PNG):
          //   contain → meet-fit the whole image into the box, centred (logo-wall tiles);
          //   cover   → fill the box, scaling up by the LARGER ratio and clipping the
          //             overflow (hero/masthead images — see multi-page-pdf);
          //   else    → stretch to the box (the prior default).
          // objectPosition fractions place the fitted image; the same `(box-fit)*frac`
          // offset works for both: it's a positive inset for contain, a negative one
          // (the cropped overflow) for cover.
          const nw = el.naturalWidth || 0, nh = el.naturalHeight || 0;
          const fit = style.objectFit;
          if (!isCircle && (fit === 'contain' || fit === 'cover') && nw > 0 && nh > 0) {
            const r = w / nw, R = h / nh;
            const s = fit === 'cover' ? Math.max(r, R) : Math.min(r, R);
            const fw = nw * s, fh = nh * s;
            const [px, py] = objectPositionFractions(style.objectPosition);
            const dx = x + (w - fw) * px, dy = y + (h - fh) * py;
            if (fit === 'cover') {
              await withPdfClipRect(pdf, x, y, w, h, () => pdf.addImage(imgSrc, fmt, dx, dy, fw, fh));
            } else {
              pdf.addImage(imgSrc, fmt, dx, dy, fw, fh);
            }
          } else {
            pdf.addImage(imgSrc, fmt, x, y, w, h);
          }
        } catch { /* skip unloadable images */ }
      return;
    }

    // ── Content: block children, inline text, pseudo markers ───────────────────
    // Inline children (<strong>, <em>, <span> …) are intentionally skipped in the child
    // loop — their content is rendered by renderInlineContent, where each fragment gets
    // its own computed style (preserving bold, color, etc.).
    //
    // overflow:hidden → clip the CONTENT to the box (mirrors the SVG walker): CSS crops an
    // overflow box's descendants to the box (its corner curve when rounded), so a child that
    // spills — a differently-filled child past a rounded edge, or an over-sized child past a
    // square edge — would otherwise show outside it. Only the content is clipped; bg/border
    // painted above stay, so the box's own edge is intact. A ROUNDED overflow box always
    // clips; a SQUARE one clips only when a descendant ACTUALLY spills (scroll > client), so a
    // clip isn't added to every layout overflow:hidden box (withPdfRoundedClip → a plain rect
    // when there's no radius).
    const clipsOverflow = (style.overflowX && style.overflowX !== 'visible') || (style.overflowY && style.overflowY !== 'visible');
    const spillsBox = (el.scrollWidth || 0) > (el.clientWidth || 0) + 1 || (el.scrollHeight || 0) > (el.clientHeight || 0) + 1;
    const drawContent = async (): Promise<void> => {
      for (const child of el.children) {
        const cd = window.getComputedStyle(child).display;
        // Same carve-out as the SVG walker: inline children are left to the inline-text
        // pass, which emits TEXT and has no <svg> branch — so an inline <svg> was
        // dropped from PDF output entirely, silently. An <svg> is replaced content with
        // a box of its own at any display value. A bare <svg> defaults to display:inline,
        // which is what a tool's own canvas is, so this is the same missing-QR-code bug
        // on the PDF side. Drawing it can only add: the previous behaviour was nothing.
        if ((cd === 'inline' || cd === 'inline-block' || cd === 'inline-flex')
            && child.tagName.toLowerCase() !== 'svg') continue;
        await visit(child);
      }
      await renderInlineContent(pdf, el, style, rootRect, scaleX, scaleY, cssToPt, registeredFonts, convertPaths, imprint);
      await pdfPseudoContent(pdf, el, rootRect, scaleX, scaleY, cssToPt, registeredFonts, convertPaths);
    };
    if (clipsOverflow && (hasRadius || spillsBox)) await withPdfRoundedClip(pdf, x, y, w, h, radii, uniform, drawContent);
    else await drawContent();
  }

  await visit(node);
}

// Walks text nodes and inline elements within blockEl, rendering each fragment
// at its own getBoundingClientRect position with its own computed style.
// This preserves inline formatting (<strong> bold, <em> italic, color spans, etc.)
// that would be lost by reading the block's innerText as a flat string.
//
// Block-level children are skipped — the main visit() loop already handles them.
// <br> is skipped — the line break is implicit in the text nodes' y positions.
async function renderInlineContent(
  pdf: any, blockEl: any, blockStyle: CSSStyleDeclaration,
  rootRect: { left: number; top: number }, scaleX: number, scaleY: number, cssToPt: number,
  registeredFonts: Set<unknown>, convertPaths = true, imprint?: ImprintState,
): Promise<void> {
  async function walk(node: any, nodeStyle: CSSStyleDeclaration, deco: Deco): Promise<void> {
    if (node.nodeType === 3) {
      const text = node.textContent;
      if (!text || !text.trim()) return;

      const fontSizePx = parseFloat(nodeStyle.fontSize) || 16;
      // Resolve the run's real font (SUSE / a user Google font / platform) in
      // BOTH modes — live text needs it to choose embed-vs-outline too.
      const vf = _host?.text ? await resolveVectorFont(nodeStyle, text) : null;
      const fontUrl = vf?.url ?? null;
      const embedUrl = await pdfUserFontEmbed(vf);
      const isUserFont = Boolean(vf?.url.startsWith('blob:'));
      // Outline when converting paths, OR when a user font can't be faithfully
      // embedded in jsPDF (variable off-weight / needs the subset chain) — so
      // weight and coverage never silently break in live-text mode either.
      // A faithfully-embeddable user run stays live (pdf.text below).
      const outline = canVectoriseText(nodeStyle, fontUrl, Boolean(_host?.text))
        && (convertPaths || (isUserFont && !embedUrl));
      // Set the font for the pdf.text path (live text, and the notdef fallback):
      // the embeddable user font when we have one, else SUSE/Helvetica.
      await applyPdfTextStyle(pdf, nodeStyle, cssToPt, registeredFonts, embedUrl);
      const letterSpacing = letterSpacingPx(nodeStyle.letterSpacing);
      const features = featureSettingsToHb(nodeStyle.fontFeatureSettings);
      const textRgb = parseCssColor(nodeStyle.color) || ([0, 0, 0] as Rgb);
      const { ascent, descent } = fontMetricsPx(nodeStyle, fontSizePx);

      // Use the browser's actual line breaks + per-line positions (exact match to
      // on-screen and the SVG output), NOT jsPDF's splitTextToSize — which re-measures
      // with the embedded font's metrics and can wrap a word a character or two early
      // when they differ slightly from the browser's. 'Convert paths' ON outlines each
      // line via host.text.toPath; OFF (or any shape failure) draws embedded pdf.text
      // at the same position, so output is never worse than before.
      const segs = text.split('\n');
      let offset = 0;
      for (const seg of segs) {
        if (seg.trim().length > 0) {
          for (const line of visualLines(node, offset, offset + seg.length)) {
            const r = line.rect;
            if (r.width < 0.5 || r.height < 0.5) continue;
            const x = (r.left - rootRect.left) * scaleX;
            // Baseline within the line box = half-leading + ascent (the SAME textBaselineY
            // the SVG walker uses), so a run with line-height > 1 sits centred instead of
            // riding the top of its line box. (Was `top + ascent`, i.e. half-leading = 0.)
            const baselinePt = textBaselineY(r.top - rootRect.top, r.height, ascent, descent) * scaleY;
            const shown = applyTextTransform(line.text, nodeStyle.textTransform);

            // Shape once and reuse: the shadows and the run itself are the same
            // glyphs, and HarfBuzz shaping is the expensive part of this loop.
            let shapedD: string | null | undefined;
            const textPathFor = async (t: string): Promise<string | null> => {
              if (shapedD !== undefined) return shapedD;
              try {
                const res = await _host!.text!.toPath({ text: t, fontUrl: fontUrl!, fontSize: fontSizePx, features: features as string[], letterSpacing, variations: vf!.variations, fallbackFonts: vf!.fallbacks });
                shapedD = res.d && !res.notdef ? res.d : null;
              } catch { shapedD = null; }
              return shapedD;
            };

            // ── text-shadow, back-to-front (CSS paints the first-listed on top) ──
            // A hard offset is exact vector: the same run again, shifted, in the
            // shadow colour. A blurred one has no PDF operator, so the outlined path
            // is baked to a shadow-only bitmap — the same compromise the box shadows
            // make here, and far smaller than baking the text itself.
            const tShadows = parseTextShadow(nodeStyle.textShadow).reverse();
            for (const tsh of tShadows) {
              const scol = parseCssColorFull(tsh.color);
              if (!scol) continue;
              try {
                if (tsh.blur > 0) {
                  const d0 = outline ? await textPathFor(shown) : null;
                  const pad = tsh.blur * 3 + Math.abs(tsh.x) + Math.abs(tsh.y) + 8;
                  const png = await rasterizeTextShadow(
                    d0 ? { d: d0 } : { text: shown, style: nodeStyle },
                    tsh, scol, r.width, r.height,
                    textBaselineY(0, r.height, ascent, descent), pad,
                    (RASTER_DPI / 72) * scaleX, (RASTER_DPI / 72) * scaleY, imprint);
                  if (png) {
                    pdf.addImage(png, 'PNG', x - pad * scaleX,
                      (r.top - rootRect.top - pad) * scaleY,
                      (r.width + 2 * pad) * scaleX, (r.height + 2 * pad) * scaleY);
                  }
                  continue;
                }
                // Hard offset.
                const d0 = outline ? await textPathFor(shown) : null;
                if (d0) {
                  pdf.setFillColor(scol[0], scol[1], scol[2]);
                  withPdfAlpha(pdf, scol[3], () => {
                    drawSvgPathToPdf(pdf, d0,
                      (sx: number) => x + (sx + tsh.x) * cssToPt,
                      (sy: number) => baselinePt + (sy + tsh.y) * cssToPt);
                    pdf.fill();
                  });
                } else {
                  const prev = pdf.getTextColor?.();
                  pdf.setTextColor(scol[0], scol[1], scol[2]);
                  withPdfAlpha(pdf, scol[3], () => {
                    pdf.text(shown, x + tsh.x * cssToPt, baselinePt + tsh.y * cssToPt, { baseline: 'alphabetic' });
                  });
                  if (prev) pdf.setTextColor(prev);
                }
              } catch { /* a shadow that won't draw must not take the text with it */ }
            }

            let drawn = false;
            if (outline) {
              try {
                // A glyph the face lacks (notdef) would print as tofu — fall through
                // to pdf.text, which at least renders through an embedded/base font.
                const { d, notdef } = await _host!.text!.toPath({ text: shown, fontUrl: fontUrl!, fontSize: fontSizePx, features: features as string[], letterSpacing, variations: vf!.variations, fallbackFonts: vf!.fallbacks });
                if (d && !notdef) {
                  pdf.setFillColor(textRgb[0], textRgb[1], textRgb[2]);
                  drawSvgPathToPdf(pdf, d,
                    (sx: number) => x + sx * cssToPt,
                    (sy: number) => baselinePt + sy * cssToPt);
                  pdf.fill();
                  drawn = true;
                }
              } catch (e) {
                _host?.log?.('warn', `pdf: text-to-path failed, using embedded text — ${(e as Error).message}`);
              }
            }
            if (!drawn) pdf.text(shown, x, baselinePt, { baseline: 'alphabetic' });

            // Underline / strikethrough bars in the run's colour (text-decoration is
            // otherwise dropped by the vector walk). Positioned relative to the baseline;
            // width uses scaleX (matching x), vertical offsets use cssToPt.
            if (deco.u || deco.s) {
              const baseline = baselinePt;
              const thick = Math.max(0.5, fontSizePx * 0.06) * cssToPt;
              const widthPt = r.width * scaleX;
              pdf.setFillColor(textRgb[0], textRgb[1], textRgb[2]);
              if (deco.u) pdf.rect(x, baseline + fontSizePx * 0.11 * cssToPt - thick / 2, widthPt, thick, 'F');
              if (deco.s) pdf.rect(x, baseline - fontSizePx * 0.28 * cssToPt - thick / 2, widthPt, thick, 'F');
            }
          }
        }
        offset += seg.length + 1; // +1 for the '\n'
      }

    } else if (node.nodeType === 1) {
      if (node.tagName.toLowerCase() === 'br') return;
      const s = window.getComputedStyle(node);
      if (s.display === 'none') return;
      // Only descend into inline-level elements; block children are visited by
      // the main visit() loop.
      if (s.display !== 'inline' && s.display !== 'inline-block' && s.display !== 'inline-flex') return;
      const cd = mergeDeco(deco, decoFlags(s));
      for (const child of node.childNodes) await walk(child, s, cd);
    }
  }

  for (const child of blockEl.childNodes) await walk(child, blockStyle, decoFlags(blockStyle));
}

// Emit any ::before/::after markers of `el` into the PDF (mirrors svgPseudoContent).
async function pdfPseudoContent(pdf: any, el: Element, rootRect: { left: number; top: number }, scaleX: number, scaleY: number, cssToPt: number, registeredFonts: Set<unknown>, convertPaths: boolean): Promise<void> {
  for (const name of ['::before', '::after']) {
    const ds = pseudoDescriptor(el, name);
    if (!ds) continue;
    const x = (ds.x - rootRect.left) * scaleX;
    const y = (ds.y - rootRect.top)  * scaleY;
    if (ds.bg && ds.w > 0.5 && ds.h > 0.5) {
      const w = ds.w * scaleX, h = ds.h * scaleY;
      const radii: CornerRadii = {
        topLeft:     [ds.radii.topLeft[0]     * scaleX, ds.radii.topLeft[1]     * scaleY],
        topRight:    [ds.radii.topRight[0]    * scaleX, ds.radii.topRight[1]    * scaleY],
        bottomRight: [ds.radii.bottomRight[0] * scaleX, ds.radii.bottomRight[1] * scaleY],
        bottomLeft:  [ds.radii.bottomLeft[0]  * scaleX, ds.radii.bottomLeft[1]  * scaleY],
      };
      const uniform: CornerPair | null = ds.uniform ? [ds.uniform[0] * scaleX, ds.uniform[1] * scaleY] : null;
      pdf.setFillColor(ds.bg[0], ds.bg[1], ds.bg[2]);
      pdfRoundedRect(pdf, x, y, w, h, radii, uniform, 'F');
    }
    if (!ds.text.trim()) continue;
    const fontSizePx = parseFloat(ds.ps.fontSize) || 16;
    const vf = _host?.text ? await resolveVectorFont(ds.ps, ds.text) : null;
    const fontUrl = vf?.url ?? null;
    const embedUrl = await pdfUserFontEmbed(vf);
    const isUserFont = Boolean(vf?.url.startsWith('blob:'));
    const textRgb = parseCssColor(ds.ps.color) || ([0, 0, 0] as Rgb);
    // Baseline within the marker's line box (half-leading + ascent), matching the SVG
    // pseudo path's textBaselineY — so a bullet/arrow lines up with the main text (which
    // is now also centred), not riding the top of its box.
    const lineHPx = parseFloat(ds.ps.lineHeight) || fontSizePx * 1.2;
    const { ascent: pAsc, descent: pDesc } = fontMetricsPx(ds.ps, fontSizePx);
    const baselinePt = textBaselineY(ds.y - rootRect.top, lineHPx, pAsc, pDesc) * scaleY;
    let drawn = false;
    // Outline in convert-paths mode, or for a user font jsPDF can't embed faithfully.
    if (canVectoriseText(ds.ps, fontUrl, Boolean(_host?.text)) && (convertPaths || (isUserFont && !embedUrl))) {
      try {
        const { d, notdef } = await _host!.text!.toPath({ text: ds.text, fontUrl: fontUrl!, fontSize: fontSizePx, variations: vf!.variations, fallbackFonts: vf!.fallbacks });
        if (d && !notdef) {
          pdf.setFillColor(textRgb[0], textRgb[1], textRgb[2]);
          drawSvgPathToPdf(pdf, d, (sx: number) => x + sx * cssToPt, (sy: number) => baselinePt + sy * cssToPt);
          pdf.fill();
          drawn = true;
        }
      } catch (e) { _host?.log?.('warn', `pdf: pseudo text-to-path failed — ${(e as Error).message}`); }
    }
    if (!drawn) {
      await applyPdfTextStyle(pdf, ds.ps, cssToPt, registeredFonts, embedUrl);
      pdf.text(ds.text, x, baselinePt, { baseline: 'alphabetic' });
    }
  }
}

// Sets jsPDF text color, font size, and the font to draw pdf.text() with. The
// font is chosen in order: a faithfully-embeddable user font (its sfnt URL,
// pre-decided by pdfUserFontEmbed) → the SUSE static for the weight/style →
// Helvetica. Embeds whichever it picks into the PDF (once) as a side effect.
async function applyPdfTextStyle(pdf: any, style: CSSStyleDeclaration, cssToPt: number, registeredFonts: Set<unknown>, userEmbedUrl: string | null = null): Promise<void> {
  const textRgb = parseCssColor(style.color) || ([0, 0, 0] as Rgb);
  pdf.setTextColor(textRgb[0], textRgb[1], textRgb[2]);
  const pdfSize = parseFloat(style.fontSize) * cssToPt;
  pdf.setFontSize(pdfSize);
  const weight = parseInt(style.fontWeight) || 400;
  const italic  = style.fontStyle === 'italic' || style.fontStyle === 'oblique';
  const family  = (style.fontFamily || '').toLowerCase();
  if (userEmbedUrl) {
    const name = await embedUserFont(pdf, registeredFonts, userEmbedUrl);
    if (name) { pdf.setFont(name, 'normal'); return; }
  }
  if (family.includes('suse')) {
    const mono = family.includes('mono');
    const suseStyle = await embedSuseFont(pdf, registeredFonts, weight, italic, mono);
    if (suseStyle) { pdf.setFont(suseFontName(mono), suseStyle); return; }
  }
  const fallback = weight >= 600 ? (italic ? 'bolditalic' : 'bold') : (italic ? 'italic' : 'normal');
  pdf.setFont('helvetica', fallback);
}




// SVG fill element for a (possibly four-corner) rounded rect: a fast <rect rx ry>
// when corners are uniform, else a <path>. `fillOpacity` < 1 emits fill-opacity
// (which svg-ir flattens over the background for EMF/EPS).
function makeRoundedFill(NS: string, x: number, y: number, w: number, h: number, radii: CornerRadii, uniform: CornerPair | null, fill: string, fillOpacity = 1): Element {
  let el: Element;
  if (uniform) {
    el = makeSvgRect(NS, x, y, w, h, uniform[0], fill, uniform[1]);
  } else {
    el = document.createElementNS(NS, 'path');
    el.setAttribute('d', roundedRectPath(x, y, w, h, radii));
    el.setAttribute('fill', fill);
  }
  if (fillOpacity < 1) el.setAttribute('fill-opacity', String(fillOpacity));
  return el;
}

// Bake a CSS filter() into a raster image via the browser's OWN canvas filter, so
// vector exports (which embed photos as bitmaps anyway) match the on-screen / PNG
// result instead of dropping the treatment. Used for tools that expose an image
// filter (e.g. dynamic-layout's mono/punch/warm/cool/fade). Returns a filtered PNG
// data URL, or the original on any failure (filter:none, headless/no-canvas,
// tainted cross-origin canvas) — so it can never make output worse.
async function bakeImageFilter(imgEl: any, dataUrl: string, filterStr: string | null | undefined): Promise<string> {
  if (!filterStr || filterStr === 'none') return dataUrl;
  try {
    let img: any = (imgEl && imgEl.naturalWidth > 0) ? imgEl : null;
    if (!img) {
      img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i); i.onerror = rej; i.src = dataUrl;
      });
    }
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!(w > 0 && h > 0)) return dataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx || !('filter' in ctx)) return dataUrl;   // jsdom / old browsers
    ctx.filter = filterStr;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/png');
  } catch { return dataUrl; }
}


// Clips an image to a circle via an offscreen canvas. Used for headshots that
// carry border-radius: 50%. Returns a PNG data URL.
async function circularClipImage(imgEl: any, dataUrl: string): Promise<string> {
  const img: any = (imgEl && imgEl.naturalWidth > 0) ? imgEl : await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  const size = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

// Fetch + parse an image source into a live <svg> element IFF it is SVG, so it
// can be drawn as true PDF vectors (jsPDF.addImage rejects SVG). Detection is by
// CONTENT, not URL — asset URLs are blob: with no extension or MIME hint, so we
// fetch the bytes and sniff for "<svg". Known raster MIME types are skipped fast.
// Handles blob:, http(s) and data: sources; returns null for non-SVG/unfetchable.
async function inlineSvgFromImg(src: string): Promise<Element | null> {
  if (!src) return null;
  let text: string | null = null;
  if (/^data:/i.test(src)) {
    if (!/^data:(image\/svg|text\/|application\/(xml|svg))/i.test(src)) return null;
    const comma  = src.indexOf(',');
    const header = src.slice(0, comma);
    const body   = src.slice(comma + 1);
    text = /;base64/i.test(header) ? atob(body) : decodeURIComponent(body);
  } else {
    let blob: Blob;
    try {
      const resp = await fetch(src);
      if (!resp.ok) return null;
      blob = await resp.blob();
    } catch { return null; }
    // Skip obvious rasters without reading them; sniff svg/xml/unknown types.
    if (/^image\/(png|jpe?g|webp|gif|avif|bmp|x-icon|vnd)/i.test(blob.type || '')) return null;
    try { text = await blob.text(); } catch { return null; }
  }
  if (!text || !/<svg[\s>]/i.test(text)) return null;
  const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  return (svg && svg.tagName && svg.tagName.toLowerCase() === 'svg') ? svg : null;
}

// ── SUSE font embedding ───────────────────────────────────────────────────────

// Module-level cache: font URL → base64 string. Survives across export calls
// within a session so the TTF files are fetched at most once.
const _fontBase64Cache = new Map<string, string>();

async function loadFontBase64(url: string): Promise<string> {
  if (_fontBase64Cache.has(url)) return _fontBase64Cache.get(url)!;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Font fetch failed: ${url}`);
  const buf = await resp.arrayBuffer();
  // FileReader is the safest way to base64-encode arbitrary binary in a browser.
  // btoa(String.fromCharCode(...uint8)) blows the stack on large font files.
  const b64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]!);
    reader.onerror = reject;
    reader.readAsDataURL(new Blob([buf]));
  });
  _fontBase64Cache.set(url, b64);
  return b64;
}

// Embeds a SUSE weight+style variant into the jsPDF instance and returns the
// jsPDF fontStyle key to use with pdf.setFont(suseFontName(mono), key).
// registeredFonts is a per-PDF-instance Set that avoids re-registering.
// Font-file naming is shared with the SVG path emitter (text-svg.js) so the two
// export paths never resolve the same weight to different files.
const suseFontName = (mono: boolean) => (mono ? 'SUSEMono' : 'SUSE');
async function embedSuseFont(pdf: any, registeredFonts: Set<unknown>, weight: number, italic: boolean, mono = false): Promise<string | null> {
  const style = (mono ? 'm' : '') + (italic ? `wi${weight}` : `w${weight}`);
  if (!registeredFonts.has(style)) {
    const file = suseFontFile(weight, italic, mono);
    const url  = SUSE_FONT_DIR + file;
    try {
      const b64 = await loadFontBase64(url);
      pdf.addFileToVFS(file, b64);
      pdf.addFont(file, suseFontName(mono), style);
      registeredFonts.add(style);
    } catch {
      return null; // fetch failed; caller falls back to helvetica
    }
  }
  return style;
}

// Embeds a decompressed USER font (a blob: sfnt URL minted by the font registry
// from a stored Google woff2) into the jsPDF instance and returns the jsPDF font
// name to setFont with. The name is derived from the url so it's stable and
// unique per face across a PDF; registeredFonts embeds each at most once.
// Unlike SUSE (per-weight static files), a user font is a single variable file,
// so pdfUserFontEmbed only offers it up when jsPDF's default-instance render is
// actually faithful — see there.
async function embedUserFont(pdf: any, registeredFonts: Set<unknown>, url: string): Promise<string | null> {
  const name = `uf_${url}`;
  if (!registeredFonts.has(name)) {
    try {
      const b64 = await loadFontBase64(url); // blob: URLs are fetchable
      const file = `${name}.ttf`;
      pdf.addFileToVFS(file, b64);
      pdf.addFont(file, name, 'normal'); // slant is baked into the embedded file
      registeredFonts.add(name);
    } catch {
      return null;
    }
  }
  return name;
}

// Decide whether a resolved run font can be FAITHFULLY embedded as live text in
// jsPDF, returning its sfnt URL if so, else null (the caller outlines instead —
// the outline path has the variable axis and per-subset fallback jsPDF lacks).
// Only decompressed USER faces (blob: URLs) are candidates; SUSE stays on its
// own per-weight-static path, and the platform face isn't embedded here.
// Embeddable requires a single face covering the whole run (jsPDF can't chain
// subsets) rendering at the requested weight: a static face always does; a
// variable face only when the request equals its default instance (jsPDF can't
// move the axis). axisDefaults is additive — without it, don't risk a variable
// face.
async function pdfUserFontEmbed(vf: VectorFont | null): Promise<string | null> {
  if (!vf || !vf.url.startsWith('blob:') || vf.fallbacks?.length) return null;
  if (!vf.variations?.length) return vf.url; // static face → its own weight
  const wanted = Number(/wght=(\d+(?:\.\d+)?)/.exec(vf.variations[0] ?? '')?.[1]);
  if (!Number.isFinite(wanted)) return vf.url;
  const defs = await _host?.text?.axisDefaults?.(vf.url).catch(() => null);
  const def = defs?.wght;
  return def != null && Math.abs(def - wanted) < 1 ? vf.url : null;
}

// ── CMYK PDF export ───────────────────────────────────────────────────────────
//
// Post-processes a jsPDF-rendered PDF to convert RGB colour operators to CMYK.
// The pipeline: render with jsPDF → load into pdf-lib → decompress each content
// stream → swap `rg`/`RG` operators → recompress → save.
//
// Raster images embedded by jsPDF remain RGB (their pixel data is not touched).
// Fills, strokes, and text colours become DeviceCMYK.
//
// If opts.palette is provided (array of { hex, cmyk: [C,M,Y,K] } entries with
// values 0–100), brand colours are looked up before generic conversion, giving
// exact ink values for registered swatches.

async function renderCmykPdf(node: Element, opts: ExportOpts): Promise<Blob> {
  // Artwork only (no marks/boxes here) — print finishing is applied below, after
  // the RGB→CMYK conversion, so the marks stay DeviceCMYK (incl. registration).
  const geo = printGeometry(node, opts);
  const rgbBlob = await renderArtworkPdf(node, opts, geo);
  const rgbBytes = new Uint8Array(await rgbBlob.arrayBuffer());

  const { PDFDocument, PDFName, PDFNumber, PDFDict } = await import('pdf-lib') as any;
  const pdfDoc = await PDFDocument.load(rgbBytes);
  const m = opts.meta;
  const creator = m?.software || 'Lolly';
  pdfDoc.setCreator(creator);
  pdfDoc.setProducer(creator);
  pdfDoc.setAuthor(m?.author || creator); // the user if known, else the app
  if (m) {
    if (m.tool) pdfDoc.setTitle(m.tool);
    if (m.description) pdfDoc.setSubject(m.description);
    const kw = [m.software, m.source, m.contact].filter(Boolean);
    if (kw.length) pdfDoc.setKeywords(kw);
  }
  const paletteMap = buildCmykPaletteMap(opts.palette ?? []);
  const spotResourceNames = assignSpotResourceNames(paletteMap);
  const usedKeys = new Set<string>();   // brand palette keys actually hit during substitution
  const usedSpots = new Set<string>();  // spot names actually referenced by a content stream

  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!(obj.contents instanceof Uint8Array)) continue;

    const dict = obj.dict;
    if (!dict?.get) continue;

    // Image XObjects contain pixel data, not PDF operators — skip them.
    const sub = dict.get(PDFName.of('Subtype'));
    if (sub && String(sub).includes('Image')) continue;

    // jsPDF uses /FlateDecode; skip other filters (e.g. /DCTDecode for JPEG XObjects).
    const filter = dict.get(PDFName.of('Filter'));
    if (filter && !String(filter).includes('FlateDecode')) continue;

    let raw: Uint8Array;
    try {
      raw = filter ? await inflateBytes(obj.contents) : obj.contents;
    } catch { continue; }

    const text = new TextDecoder('latin1').decode(raw);
    if (!/\brg\b|\bRG\b/.test(text)) continue;

    const modified = substitutePdfRgb(text, paletteMap, spotResourceNames, usedKeys, usedSpots);
    if (modified === text) continue;

    const modBytes = Uint8Array.from(modified, c => c.charCodeAt(0));
    const recompressed = await deflateBytes(modBytes);

    // PDFRawStream.contents is readonly in TypeScript but a plain own property
    // at runtime — assign directly.
    obj.contents = recompressed;
    dict.set(PDFName.of('Length'), PDFNumber.of(recompressed.length));
    if (!filter) dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  }

  // Materialise a /Separation colourspace for every spot a content stream actually
  // referenced above: one Type-2 exponential tint-transform function per spot (a
  // linear ramp from "no ink" at tint 0 to the spot's CMYK equivalent at tint 1 —
  // the standard "spot ink with a process alternate" construction) plus the
  // colourspace array itself, both registered as fresh indirect objects the same
  // way applyPdfX/setPdfxOutputIntent registers the OutputIntent's ICC stream
  // below — then wired into the single artwork page's /Resources/ColorSpace dict
  // under the name substitutePdfRgb already wrote into the content stream
  // ("/CSn cs"/"/CSn CS"). Deferred until after the enumeration loop so no new
  // indirect object is registered while pdfDoc.context.enumerateIndirectObjects()
  // is being walked.
  if (usedSpots.size) {
    const page = pdfDoc.getPage(0);
    const resources = page.node.Resources() || pdfDoc.context.obj({});
    page.node.set(PDFName.of('Resources'), resources);
    const csDict = resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict) || pdfDoc.context.obj({});
    resources.set(PDFName.of('ColorSpace'), csDict);
    for (const hit of paletteMap.values()) {
      const spot = hit.spot;
      if (!spot || !usedSpots.has(spot.name)) continue;
      const resourceName = spotResourceNames.get(spot.name)!;
      if (csDict.get(PDFName.of(resourceName))) continue; // already wired (dup palette entries)
      const fn = pdfDoc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: spot.cmyk, N: 1 });
      const csArr = pdfDoc.context.obj(['Separation', spot.name, 'DeviceCMYK', pdfDoc.context.register(fn)]);
      csDict.set(PDFName.of(resourceName), pdfDoc.context.register(csArr));
    }
  }

  // Print finishing in DeviceCMYK, drawn after the colour swap so registration
  // marks land on every plate (1 1 1 1) and aren't re-mapped by the RGB→CMYK pass.
  // The verification bar shows pairs for only the brand inks that actually
  // substituted in this artwork — rebuild the marks geometry from that used set
  // now that the substitution pass has run (page size is palette-independent).
  if (geo) {
    const page = pdfDoc.getPage(0);
    setPageBoxes(page, geo);
    const usedPalette = (opts.palette ?? []).filter(p => usedKeys.has(paletteHitKey(p) as string));
    const marksGeo = printGeometry(node, opts, usedPalette) ?? geo;
    await drawPrintMarks(page, marksGeo, { space: 'cmyk', labels: provenanceLabels(opts.meta) });
  }

  // PDF/X-4 finishing runs AFTER the colour substitution so the claim gate sees
  // the final image set. The press-condition intent declares what the DeviceCMYK
  // values mean to a RIP; 'none' (user opted out of a condition) writes the
  // metadata without an intent or conformance claim, and anything non-CMYK
  // ('srgb'/absent) falls back to the default condition — mirroring the old
  // addCmykOutputIntent guard. 'own' is the embed route: the DestOutputProfile
  // bytes come from a profile on THIS device, and the intent's identity is read
  // off that profile rather than off the picker (press-profile-embed.ts).
  const intentKind = opts.colorProfile === 'none' ? null
    : isOwnProfile(opts.colorProfile) ? 'own'
    : (opts.colorProfile && opts.colorProfile !== 'srgb' ? opts.colorProfile : 'fogra39');
  await applyPdfX(pdfDoc, opts, intentKind, {
    embed: await embeddedProfile(opts.colorProfile),
    log: pdfxLog,
  });

  // The C2PA embedder only parses a classic xref table — same flag finishPdfX
  // threads for the RGB path when a credential is requested.
  const out = await pdfDoc.save(opts.c2pa ? { useObjectStreams: false } : undefined);
  const cmykBlob = new Blob([out], { type: 'application/pdf' });
  // Strong tier: AES-256 encrypt-last, AFTER the CMYK substitution + marks +
  // output-intent are baked in (pdf-lib can't reopen an encrypted doc, so this
  // must be the final step). The PDF/X-4 conformance claim was already dropped in
  // applyPdfX above. Print PDFs had no password support before this.
  return opts.strongPassword ? encryptPdfStrong(cmykBlob, opts.strongPassword) : cmykBlob;
}





// The computed fill/stroke of a live-DOM SVG element — resolves SVG inheritance
// (an ancestor group's paint) and currentColor. Empty for a detached element, so
// callers keep their own literal fallback.
function computedPaint(el: Element, prop: string): string {
  try {
    // getPropertyValue takes the CSS property NAME, so hyphenated props ('stroke-width')
    // are read here exactly like single-word ones ('fill'/'stroke') — no `as any` index,
    // and none of the camelCase IDL spelling this would need via the property accessor.
    return (typeof window !== 'undefined' && el.isConnected) ? (window.getComputedStyle(el).getPropertyValue(prop) || '') : '';
  } catch { return ''; }
}



/**
 * Resolve an element's stroke paint the way the browser does — the counterpart to
 * resolveColor() below, which has always done this for fill.
 *
 * A presentation attribute and an inline style are only two of the three ways a stroke
 * arrives. Illustrator/Figma SVGs — which is every SUSE catalog illustration — carry
 * theirs in a CSS CLASS instead: `.cls-7{stroke:#003e37;stroke-width:4px}`, with no
 * stroke attribute on any node. Neither of the first two reads can see that, so without
 * the computed fallback every such stroke resolved to 'none' and the artwork exported to
 * PDF as flat fills with EVERY outline missing — while fill came through, because
 * resolveColor already fell back to getComputedStyle. That asymmetry was the bug.
 *
 * Returns 'none' (the SVG initial value for stroke) when nothing paints, where the fill
 * side defaults to black. Detached nodes yield '' from computedPaint → 'none'.
 */
export function strokeOf(el: Element): string {
  const s = el.getAttribute('stroke') ?? resolveStyleProp(el, 'stroke') ?? '';
  return (!s || s === 'currentColor') ? (computedPaint(el, 'stroke') || 'none') : s;
}

/**
 * Stroke width under the same three-way resolution, in SVG user units. A class-declared
 * `stroke-width:4px` is invisible to getAttribute, so this otherwise fell back to 1 and
 * hairlined artwork whose real width was 4. Non-finite/negative input → 1 (the SVG initial
 * value); getComputedStyle reports a resolved px length ("4px"), which parseFloat takes.
 */
export function strokeWidthOf(el: Element): number {
  const raw = el.getAttribute('stroke-width') ?? resolveStyleProp(el, 'stroke-width') ??
              computedPaint(el, 'stroke-width');
  const v = parseFloat(raw || '');
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

/**
 * Carry an SVG shape's stroke DECORATION — dash array, cap, join, miter limit — into the
 * PDF graphics state, and hand back the undo. Without this the PDF walker reproduced only a
 * stroke's colour and width, so a dashed or flat-capped outline exported as a plain round
 * solid one: a control whose effect vanished on export, which is worse than not offering it.
 *
 * jsPDF's line state is STICKY (it writes the operator once and every later stroke inherits
 * it), which is why the caller must run the returned restore — the same discipline the
 * border path already follows. Every setter is feature-checked because older jsPDF builds
 * ship only some of them.
 *
 * Lengths are multiplied by `mul`, the same user-unit → pt factor applied to stroke-width,
 * so a dash keeps its proportion to the line. `stroke-dasharray` is read as numbers only:
 * a non-finite or negative entry, or an all-zero pattern (which PDF rejects), drops the
 * dash rather than emitting an invalid pattern.
 */
export function applySvgStrokeDecoration(pdf: any, el: Element, mul: number): (() => void) | null {
  const undo: Array<() => void> = [];
  const raw = el.getAttribute('stroke-dasharray') ?? resolveStyleProp(el, 'stroke-dasharray') ?? '';
  if (raw && raw !== 'none' && typeof pdf.setLineDashPattern === 'function') {
    const nums = raw.trim().split(/[\s,]+/).map((s) => parseFloat(s) * mul);
    if (nums.length && nums.every((n) => Number.isFinite(n) && n >= 0) && nums.some((n) => n > 0)) {
      pdf.setLineDashPattern(nums, 0);
      undo.push(() => pdf.setLineDashPattern([], 0));
    }
  }
  const cap = el.getAttribute('stroke-linecap') ?? resolveStyleProp(el, 'stroke-linecap') ?? '';
  if ((cap === 'round' || cap === 'square') && typeof pdf.setLineCap === 'function') {
    // jsPDF's CapJoinStyles understands the SVG keywords verbatim ('square' → projecting),
    // and THROWS on anything it does not, which is why only the two are let through.
    pdf.setLineCap(cap);
    undo.push(() => pdf.setLineCap('butt'));
  }
  const join = el.getAttribute('stroke-linejoin') ?? resolveStyleProp(el, 'stroke-linejoin') ?? '';
  if ((join === 'round' || join === 'bevel') && typeof pdf.setLineJoin === 'function') {
    pdf.setLineJoin(join);
    undo.push(() => pdf.setLineJoin('miter'));
  }
  // A miter join is PDF's default, but its default LIMIT is 10 against SVG's 4 — so a
  // shape that says 4 has to say it here too, or a spike PDF keeps is one the browser and
  // the SVG export both bevelled away.
  const ml = parseFloat(el.getAttribute('stroke-miterlimit') ?? resolveStyleProp(el, 'stroke-miterlimit') ?? '');
  if (Number.isFinite(ml) && ml >= 1 && typeof pdf.setLineMiterLimit === 'function') {
    pdf.setLineMiterLimit(ml);
    undo.push(() => pdf.setLineMiterLimit(10));
  }
  return undo.length ? () => { for (const fn of undo) fn(); } : null;
}

function resolveColor(el: any): Rgb | null {
  const attr = el.getAttribute('fill');
  if (attr && attr !== 'currentColor') return parseSvgColor(attr);
  const styleAttr = el.getAttribute('style') ?? '';
  const styleMatch = styleAttr.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/);
  if (styleMatch) return parseSvgColor(styleMatch[1].trim());
  const computed = typeof window !== 'undefined' ? window.getComputedStyle(el).fill : null;
  return computed ? parseSvgColor(computed) : null;
}


// Ensures a canvas is exactly w×h logical pixels. dom-to-image-more may return
// a physical-pixel canvas (canvas.width = w * devicePixelRatio) on HiDPI screens,
// which causes toBlob and getImageData to encode/read only a zoomed-in crop.
// Drawing through an intermediate canvas normalises to the requested dimensions.
function normalizeCanvas(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  if (src.width === w && src.height === h) return src;
  const out = document.createElement('canvas');
  out.width  = w;
  out.height = h;
  out.getContext('2d')!.drawImage(src, 0, 0, w, h);
  return out;
}

// Replaces blob: URLs in-place on the live node and returns a function that
// restores the originals. Used for raster exports so dom-to-image-more receives
// the fully styled live node rather than a detached clone.
async function swapBlobUrls(node: Element): Promise<() => void> {
  const swaps: { el: Element; attr: string; url: string }[] = [];
  await Promise.all([...node.querySelectorAll('image, img')].map(async el => {
    for (const attr of ['href', 'src']) {
      const url = el.getAttribute(attr);
      if (url?.startsWith('blob:')) {
        try {
          el.setAttribute(attr, await blobToDataUrl(url));
          swaps.push({ el, attr, url });
        } catch { /* leave as-is */ }
      }
    }
  }));
  return () => swaps.forEach(({ el, attr, url }) => el.setAttribute(attr, url));
}

// Snapshot every <video> under `node` to a still <img> of its CURRENT frame, in
// place, returning a closure that restores the originals. dom-to-image-more
// serialises the DOM into an SVG <foreignObject>, which does NOT carry decoded video
// pixels — so without this a video box exports BLANK. We use an <img> (PNG data URL)
// rather than a <canvas> deliberately: an <img> is handled by EVERY export path —
// the raster serialiser inlines it, and the true-vector walkers (svg/pdf/emf/eps)
// already know how to place an <img> but NOT a <canvas> — so a video-still now
// behaves exactly like an ordinary still image everywhere. Runs on the LIVE node
// (computed styles + geometry intact); the <img> copies the video's class + inline
// style + key computed replaced-element props so the existing object-fit /
// border-radius handling frames it identically. Per-element try/catch: a not-yet-
// decoded frame (readyState < 2) or a cross-origin (canvas-tainting) video is skipped,
// never thrown — a still-blank video is no worse than today. Synchronous + jsdom-safe
// (videoWidth is 0 there → a clean no-op). gif/apng/animated-webp inside an <img>
// already export as a still, so only <video> needs this.
function snapshotMotion(node: Element): () => void {
  if (!node.querySelectorAll) return () => {};
  const swaps: { video: HTMLElement; still: HTMLElement; prevDisplay: string }[] = [];
  for (const el of [...node.querySelectorAll('video')]) {
    const video = el as HTMLVideoElement;
    try {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h || video.readyState < 2) continue;   // no decoded frame yet
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(video, 0, 0, w, h);                 // SecurityError if the video is cross-origin tainted
      const still = document.createElement('img');
      still.src = canvas.toDataURL('image/png');        // also throws SecurityError if tainted — caught below
      // Marked so a renderer that decodes the video ITSELF can hide the freeze
      // instead of baking it in. The sequence compositor needs exactly that on the
      // ZIP path, where the guard above keys on the outer 'zip' format and the
      // frozen still therefore already exists by the time mp4/webm re-dispatches.
      still.setAttribute('data-motion-still', '1');
      // Reproduce the on-screen framing: the class + inline style carry sizing
      // (e.g. .lolly-box-img width/height + object-fit), and the computed
      // replaced-element props cover a tool that set them elsewhere.
      still.className = video.className;
      const styleAttr = video.getAttribute('style');
      if (styleAttr) still.setAttribute('style', styleAttr);
      const cs = getComputedStyle(video);
      still.style.objectFit = cs.objectFit;
      still.style.objectPosition = cs.objectPosition;
      still.style.borderRadius = cs.borderRadius;
      video.parentNode?.insertBefore(still, video);
      const prevDisplay = video.style.display;
      video.style.display = 'none';                     // keep only the still in the serialised tree
      swaps.push({ video, still, prevDisplay });
    } catch { /* tainted or undecodable — leave the video as-is rather than throw */ }
  }
  return () => {
    for (const { video, still, prevDisplay } of swaps) {
      still.remove();
      video.style.display = prevDisplay;
    }
  };
}

// Replaces blob: URLs in-place on a detached clone. Used by renderSvg which
// owns its clone and just needs self-contained data URLs in the saved file.
export async function inlineBlobUrlsInEl(el: Element): Promise<void> {
  const candidates = el.querySelectorAll('image, img');
  await Promise.all([...candidates].map(async img => {
    for (const attr of ['href', 'src']) {
      const url = img.getAttribute(attr);
      if (url?.startsWith('blob:')) {
        try {
          img.setAttribute(attr, await blobToDataUrl(url));
        } catch { /* leave as-is; export will degrade gracefully */ }
      }
    }
  }));
}

async function blobToDataUrl(url: string): Promise<string> {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Natural pixel dimensions of an image href (for cover/contain fitting). Null on failure.
async function imageDims(src: string): Promise<{ w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(await (await fetch(src)).blob());
    const d = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return d;
  } catch { return null; }
}

// The fitted rect for a background-image inside the box (x,y,w,h), by `background-size` —
// jsPDF's addImage stretches, so compute the fit ourselves to avoid distortion. cover →
// fill+crop (overflows, clip to box); contain → fit inside; exact two-value / stretch →
// the box. `background-position` anchors it. `overflows` tells the caller to clip.
function bgFitRect(natW: number, natH: number, x: number, y: number, w: number, h: number, style: CSSStyleDeclaration): { x: number; y: number; w: number; h: number; overflows: boolean } {
  const size = (style.backgroundSize || 'auto').trim().toLowerCase();
  const stretch = /\S+\s+\S+/.test(size) && !size.includes('auto') && size !== 'cover' && size !== 'contain';
  if (!(natW > 0) || !(natH > 0) || stretch) return { x, y, w, h, overflows: false };
  const s = size === 'contain' ? Math.min(w / natW, h / natH) : Math.max(w / natW, h / natH);   // default cover
  const iw = natW * s, ih = natH * s;
  const [px, py] = objectPositionFractions(style.backgroundPosition);
  return { x: x + (w - iw) * px, y: y + (h - ih) * py, w: iw, h: ih, overflows: iw > w + 0.5 || ih > h + 0.5 };
}

// Pick the jsPDF.addImage format from a data: URL's REAL MIME (the previous
// `.includes('image/png')` guess silently misclassified WebP/AVIF/GIF user images
// as PNG, so jsPDF dropped them). PNG/JPEG/WebP are passed through as the formats
// jsPDF accepts; anything else jsPDF can't embed (AVIF/GIF/BMP…) is rasterised to
// PNG via a canvas first. Non-data / unrecognised sources keep the old PNG fallback.
async function imageForPdf(src: string): Promise<{ src: string; fmt: string }> {
  const mime = (/^data:([^;,]+)/i.exec(src)?.[1] || '').toLowerCase();
  if (mime === 'image/png')  return { src, fmt: 'PNG' };
  if (mime === 'image/jpeg' || mime === 'image/jpg') return { src, fmt: 'JPEG' };
  if (mime === 'image/webp') return { src, fmt: 'WEBP' };
  if (mime.startsWith('image/')) {
    try { return { src: await rasterizeToPng(src), fmt: 'PNG' }; }
    catch { return { src, fmt: 'PNG' }; }
  }
  return { src, fmt: 'PNG' };
}

// Decode any image source the browser understands and re-encode it as a PNG data
// URL, so a format jsPDF can't embed natively can still be placed.
async function rasterizeToPng(src: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width  = img.naturalWidth  || img.width;
  canvas.height = img.naturalHeight || img.height;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  return canvas.toDataURL('image/png');
}

// Best recorder mime, preferring the requested container ('webm' | 'mp4') but
// falling back to the other so a deep-link/CLI request still produces a video.
// With { audio: true } only audio-capable mimetypes are considered — returns
// null when none is supported, so the caller can fall back to a silent
// recording rather than a NotSupportedError mid-record.
// Returns null when no container is recordable.
export function videoMimeType(preferred?: string, { audio = false }: { audio?: boolean } = {}): string | null {
  if (!canRecord()) return null;
  return videoMimeCandidates(preferred as string, { audio }).find(t => MediaRecorder.isTypeSupported?.(t)) ?? null;
}

interface LoopedAudio { track: MediaStreamTrack; start(): void; stop(): void; }

// Decodes an audio file (a catalog music bed — opts.audio.url, typically a
// blob: URL the view resolved via host.assets.get) into a loopable Web Audio
// source whose MediaStream track can be muxed into the recorded stream.
// loop=true makes the bed cover any clip length: recording stop truncates a
// longer track, shorter tracks repeat seamlessly. start() is deferred so the
// caller can align audio time-zero with recorder.start() — Phase 1 frame
// capture is slower than real time and must not consume the track.
/**
 * A gain envelope for a music bed, in seconds, timed against clipSec.
 *   volume — overall bed level (0..1, default 1)
 *   fadeIn/fadeOut — linear ramps from/to silence at the ends
 *   duck — a window over which the bed dips to volume·duck.level, then restores,
 *          so foreground audio (an uploaded clip's own sound) stays intelligible.
 *   start — in-point into the SOURCE (not the clip): playback begins there, and a
 *          looping bed repeats from there. Independent of the envelope, which is
 *          always timed from t0 against clipSec.
 */
interface AudioFade {
  fadeIn?: number;
  fadeOut?: number;
  clipSec?: number;
  volume?: number;
  duck?: { level: number; startSec: number; endSec: number };
  start?: number;
}

/**
 * Clamp a requested bed in-point into a decoded source. A start at or past the end
 * of the track can't be honoured: with loop off it records pure silence, with loop on
 * the spec snaps playback back to loopStart — either way the user gets an unexplained
 * result, so it degrades to 0:00 with a warning.
 */
export function bedStartOffset(start: number | undefined, duration: number): number {
  if (typeof start !== 'number' || !Number.isFinite(start) || start <= 0) return 0;
  if (!(duration > 0) || start >= duration) {
    _host?.log?.('warn', `Audio starts at ${start}s but the track is only ${duration.toFixed(2)}s long; playing it from 0:00.`);
    return 0;
  }
  return start;
}

// Connect a looping music buffer into `dest` within `ctx`, through a GainNode that
// applies an optional volume/fade/duck envelope. start() schedules the ramps at
// ctx.currentTime (so it must be called when playback actually begins); stop() halts
// the source. Shared by createLoopedAudio (the renderVideo music bed) and the
// top-&-tail compositor, which mixes it with the footage's own audio in one context.
export function connectMusic(
  ctx: BaseAudioContext,   // AudioContext (live path) OR OfflineAudioContext (WebCodecs bed render)
  buffer: AudioBuffer,
  dest: AudioNode,
  fade: AudioFade = {},
): { start(): void; stop(): void } {
  const src  = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop   = true;
  // In-point: start playback `offset` into the source, and move the loop window with
  // it — loopStart defaults to 0, so a wrap would otherwise throw the in-point away
  // and play the head of the track the visuals deliberately skipped. loopEnd must be
  // set explicitly too; it only means "end of buffer" while untouched.
  const offset = bedStartOffset(fade.start, buffer.duration);
  if (offset > 0) { src.loopStart = offset; src.loopEnd = buffer.duration; }
  const gain = ctx.createGain();
  src.connect(gain).connect(dest);
  let started = false;
  return {
    start() {
      if (started) return;
      started = true;
      const t0 = ctx.currentTime;
      const g = gain.gain;
      const vol     = Math.max(0, Math.min(1, fade.volume ?? 1));
      const fadeIn  = Math.max(0, fade.fadeIn  ?? 0);
      const fadeOut = Math.max(0, fade.fadeOut ?? 0);
      const clip    = fade.clipSec ?? 0;
      // Fade in to full volume.
      if (fadeIn > 0) { g.setValueAtTime(0, t0); g.linearRampToValueAtTime(vol, t0 + fadeIn); }
      else g.setValueAtTime(vol, t0);
      // Duck under foreground audio: dip to vol·level across the body window, restore
      // for the outro. Guarded so it never schedules out-of-order automation events.
      const d = fade.duck;
      if (d && d.level < 1 && d.endSec - d.startSec > 0.6) {
        const RAMP = 0.25;
        const downStart = t0 + Math.max(fadeIn, d.startSec);
        const downEnd   = downStart + RAMP;
        const upStart   = t0 + d.endSec - RAMP;
        const upEnd     = t0 + d.endSec;
        if (upStart > downEnd) {
          g.setValueAtTime(vol, downStart);
          g.linearRampToValueAtTime(vol * d.level, downEnd);
          g.setValueAtTime(vol * d.level, upStart);
          g.linearRampToValueAtTime(vol, upEnd);
        }
      }
      // Fade out to silence at the end.
      if (fadeOut > 0 && clip > fadeIn) {
        const fs = Math.max(t0 + fadeIn, t0 + clip - fadeOut);
        g.setValueAtTime(vol, fs);
        g.linearRampToValueAtTime(0, t0 + clip);
      }
      src.start(0, offset);
    },
    stop() { try { src.stop(); } catch { /* never started */ } },
  };
}

async function createLoopedAudio(url: string, fade: AudioFade = {}): Promise<LoopedAudio> {
  const AC = globalThis.AudioContext ?? (globalThis as any).webkitAudioContext;
  if (!AC) throw new Error('Web Audio is not supported in this browser');
  const bytes = await (await fetch(url)).arrayBuffer();
  const ctx = new AC();
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(bytes);
  } catch (err) {
    ctx.close().catch(() => {});
    throw err instanceof Error ? err : new Error('audio decode failed');
  }
  const dest  = ctx.createMediaStreamDestination();
  const music = connectMusic(ctx, buffer, dest, fade);
  return {
    track: dest.stream.getAudioTracks()[0]!,
    start() {
      // The context was created inside the export click's gesture, but resume
      // defensively — a suspended context feeds silence into the recording.
      ctx.resume?.().catch(() => {});
      music.start();
    },
    stop() {
      music.stop();
      ctx.close().catch(() => {});
    },
  };
}

// Render the music-bed timeline (the SAME connectMusic fade/loop envelope used by
// the live MediaRecorder path) to a finished PCM AudioBuffer, entirely offline and
// faster than real time — this feeds the WebCodecs AudioEncoder so audio exports
// can take the fast path too. Returns null when OfflineAudioContext is unavailable
// or the clip is empty; throws on decode failure so renderVideo can fall back to the
// live MediaRecorder mux (which decoded the bed successfully earlier).
async function renderMusicBed(url: string, clipSec: number, sampleRate: number, fade: AudioFade): Promise<AudioBuffer | null> {
  const OAC = globalThis.OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext;
  if (!OAC || !(clipSec > 0)) return null;
  const CHANNELS = 2;                                   // deterministic stereo out
  const octx: OfflineAudioContext = new OAC(CHANNELS, Math.max(1, Math.ceil(clipSec * sampleRate)), sampleRate);
  const bytes = await (await fetch(url)).arrayBuffer(); // blob: URL from host.assets.get — no network
  let buffer: AudioBuffer;
  try {
    buffer = await octx.decodeAudioData(bytes);         // resamples the bed to `sampleRate`
  } catch (err) {
    throw err instanceof Error ? err : new Error('audio decode failed');
  }
  connectMusic(octx, buffer, octx.destination, fade).start();  // schedules the envelope at t=0
  return await octx.startRendering();                   // AudioBuffer, exactly clip-length, 2ch
}

// Resolve opts.audio into a started-on-demand looped track, or null when audio
// wasn't requested / can't be delivered (decode failure, no audio-capable
// recorder mime) — in which case the export degrades to a silent video with a
// warning through the log channel rather than failing a multi-second capture.
async function prepareExportAudio(opts: ExportOpts, preferred: string, clipSec?: number): Promise<{ audio: LoopedAudio | null; mimeType: string | null }> {
  if (!opts.audio?.url) return { audio: null, mimeType: videoMimeType(preferred) };
  let audio: LoopedAudio | null = null;
  try {
    audio = await createLoopedAudio(opts.audio.url, { fadeIn: opts.audio.fadeIn, fadeOut: opts.audio.fadeOut, clipSec, volume: opts.audio.volume, start: opts.audio.start });
  } catch (err) {
    _host?.log?.('warn', `Audio track unavailable (${(err as any)?.message ?? err}); exporting silent video.`);
  }
  if (audio) {
    const mimeType = videoMimeType(preferred, { audio: true });
    if (mimeType) return { audio, mimeType };
    audio.stop();
    audio = null;
    _host?.log?.('warn', 'This browser cannot record an audio track into the chosen container; exporting silent video.');
  }
  return { audio: null, mimeType: videoMimeType(preferred) };
}

// Container MIME for the output Blob, derived from the chosen recorder mime.
function videoContainer(mime: string | null): string {
  return mime && mime.includes('mp4') ? 'video/mp4' : 'video/webm';
}

// Stamp the provenance record (opts.meta — same content as the GIF comment and
// PNG iTXt) into a finished recording: MP4 udta/ilst or Matroska Tags, via the
// engine's byte-writers. MediaRecorder can't write metadata during capture, so
// this post-processes the blob. Failure is non-fatal — a playable file without
// provenance beats a corrupted one with it.
async function withVideoMeta(blob: Blob, container: string, meta: ExportMeta | null | undefined): Promise<Blob> {
  if (!meta) return blob;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const tags = videoProvenanceTags(meta, new Date());
    const out = container === 'video/mp4' ? embedMp4Meta(bytes, tags) : embedWebmMeta(bytes, tags);
    if (out === bytes) _host?.log?.('warn', 'Provenance metadata not embedded (unrecognised container structure).');
    return new Blob([out as BlobPart], { type: container });
  } catch (err) {
    _host?.log?.('warn', `Provenance metadata not embedded (${(err as any)?.message ?? err}).`);
    return blob;
  }
}

const NO_VIDEO_MSG = 'Video recording is not supported in this browser. Use GIF instead, or try Chrome or Firefox for WebM.';

// A FrameSource turns a live DOM node into a sequence of rendered frames that
// share ONE capture timeline. Motion encoders (webm/mp4 via renderVideo, gif via
// renderGif — and future apng / image-sequence / spritesheet / favicon) consume it
// instead of each re-implementing the capture loop.
//
// Capture semantics match the original per-encoder loops: blob: URLs are swapped
// to data URLs once up front (so dom-to-image can inline them), CSS animations get
// `opts.wait` seconds to settle before the first frame, then each frame() renders
// the CURRENT animation state via dom-to-image toCanvas(). Sequential frame() calls
// advance the animation in real time (the await between them is the spacing), so
// every frame is a distinct moment — no duplicate or skipped frames.
//
//   width / height — target pixel size (defaults to the node's box)
//   frame()        — Promise<HTMLCanvasElement> for the current moment
//   dispose()      — restore the blob:-URL swap; call once capture is done
// ── Deterministic export-frame clock (opt-in) ────────────────────────────────
// A canvas-animation tool can register `window.__lollyFrameRender(t)` to render a
// deterministic frame at normalized loop time t∈[0,1). The snapshot export paths
// drive it: they raise `window.__lollyFrameDriven` (so the tool's own rAF loop
// bails — dom-to-image's toCanvas is async, and a stray repaint would otherwise
// clobber the frame), paint the exact phase, then capture. Presence-keyed, so a
// tool that never registers the hook is byte-for-byte unchanged. Scoped to these
// snapshot paths ONLY — never the real-time captureStream path (which returns
// before createFrameSource), so the two mechanisms can't both fire per export.
// Per-NODE channel (not a window global): the hook lives ON the tool's canvas, so
// it can't leak across SPA tool navigation — a detached canvas from a previous tool
// is never inside the node being exported, so an unrelated tool never enters this path.
type FrameClockCanvas = HTMLCanvasElement & { __lollyFrameRender?: (t: number) => void; __lollyFrameDriven?: boolean };
function frameClockCanvas(node: Element): FrameClockCanvas | null {
  const self = node as FrameClockCanvas;
  if (typeof self.__lollyFrameRender === 'function') return self;
  for (const c of Array.from(node.querySelectorAll?.('canvas') ?? [])) {
    if (typeof (c as FrameClockCanvas).__lollyFrameRender === 'function') return c as FrameClockCanvas;
  }
  return null;
}
function beginFrameClock(node: Element): FrameClockCanvas | null {
  const c = frameClockCanvas(node);
  if (c) c.__lollyFrameDriven = true;   // freeze the tool's own rAF for the capture
  return c;
}
function renderFrameAt(c: FrameClockCanvas | null, t: number): void {
  if (!c || typeof c.__lollyFrameRender !== 'function') return;
  try { c.__lollyFrameRender(t); } catch (e) { _host?.log?.('warn', `__lollyFrameRender threw: ${(e as Error)?.message ?? e}`); }
}
function endFrameClock(c: FrameClockCanvas | null): void {
  if (c) c.__lollyFrameDriven = false;
}

// ── CSS animation/transition scrubbing (no tool opt-in required) ────────────
// A plain template that animates via CSS `animation`/`transition` (no canvas,
// no __lollyFrameRender) previously had its frames paced by whatever real time
// elapsed between toCanvas() calls — capture jitter (DOM serialize + image
// decode isn't constant-time) meant the exported motion could subtly drift
// from the authored timing. getAnimations() exposes every CSSAnimation/
// CSSTransition affecting the node, so each can be paused and scrubbed to the
// exact elapsed ms for the frame being captured — the same exact-phase
// guarantee __lollyFrameRender gives canvas tools, without requiring one.
// No-op (returns false) for tools with no CSS animations, and for JS/rAF-driven
// motion that never produces a Web Animations API Animation object — those
// still need the explicit clock hook.
function scrubAnimations(node: Element, ms: number): boolean {
  const anims = node.getAnimations?.({ subtree: true }) ?? [];
  if (anims.length === 0) return false;
  for (const a of anims) {
    if (a.playState !== 'paused') a.pause();
    a.currentTime = ms;
  }
  return true;
}

// ── Node-driven capture override (opt-in, Tier-B video prototype) ───────────
// A Node/Playwright caller (packages/node-shell/src/webshell-render.ts,
// renderVideoViaScreenshot) can expose window.__lollyCaptureScreenshot before
// navigating here. When present, frame() calls it instead of dom-to-image: Node
// takes a REAL Chromium screenshot of the live node, clipped to its own box —
// genuine paint, no clone/serialize/reinterpret step — and hands the PNG bytes
// back as base64, which are then scaled to the export's target pixel size on a
// canvas exactly like dom-to-image's own output. Everything else (the
// deterministic clock, scrubAnimations, the WebCodecs encode, C2PA/watermark
// stamping) is the exact same pipeline.
//
// Deliberately does NOT force the live node to the target width/height/scale
// the way dtoOpts styles a dom-to-image CLONE — an earlier version did, and it
// leaked layout: forcing #tool-canvas's box away from its real flex-driven size
// let neighbouring chrome (the sidebar) bleed into the shot. A screenshot is
// captured at the node's own on-screen size and upscaled if needed; call
// page.setViewportSize/deviceScaleFactor Node-side for a sharper native size
// instead of fighting the live layout from here.
declare global { interface Window { __lollyCaptureScreenshot?: () => Promise<string | null> } }

async function captureViaExternalScreenshot(
  targetW: number, targetH: number, capture: () => Promise<string | null>,
): Promise<HTMLCanvasElement> {
  const b64 = await capture();
  if (!b64) throw new Error('external screenshot capture returned nothing');
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('external screenshot frame failed to decode'));
    img.src = `data:image/png;base64,${b64}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = targetW; canvas.height = targetH;
  canvas.getContext('2d')!.drawImage(img, 0, 0, targetW, targetH);
  return canvas;
}

// ── Static-chrome fast path (see ./frame-static.ts for the decision rules) ───
// Every <canvas> that actually paints pixels. A tool's clock anchor is NOT one:
// slides/deck-builder (`.sl-clock`) and all six filter-* tools (`[data-ov-clock]`)
// carry `__lollyFrameRender` on a 0×0 aria-hidden canvas that draws nothing, and
// audiogram's `style=milkdrop` leaves the fallback `#ag-wave` in the DOM at
// display:none next to the mounted viz canvas — so both the backing-store size
// and the computed visibility have to be checked, not just presence.
function visibleCanvases(node: Element): HTMLCanvasElement[] {
  const all: HTMLCanvasElement[] = [];
  if (node instanceof HTMLCanvasElement) all.push(node);
  for (const c of Array.from(node.querySelectorAll?.('canvas') ?? [])) all.push(c as HTMLCanvasElement);
  return all.filter(c => {
    if (!(c.width > 0 && c.height > 0)) return false;   // inert clock anchor — drawImage would throw on it anyway
    const s = window.getComputedStyle(c);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = c.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  });
}

// Everything under the node that is neither a live canvas nor an ancestor of one,
// tagged with whether it contributes pixels at all. url-shot's `.shot-refresh` /
// `.shot-compose` buttons sit right over the canvas at opacity:0 until hover, so
// treating "has a box" as "paints" would reject the best-case tool.
function chromeElements(node: Element, live: HTMLCanvasElement[]): { liveBoxes: Box[]; chrome: ChromeEl[] } {
  const related = new Set<Element>();
  for (const c of live) for (let e: Element | null = c; e; e = e.parentElement) { related.add(e); if (e === node) break; }
  const liveBoxes = live.map(c => c.getBoundingClientRect() as Box);
  const chrome: ChromeEl[] = [];
  for (const el of Array.from(node.querySelectorAll('*'))) {
    if (related.has(el)) { chrome.push({ box: el.getBoundingClientRect(), paints: false, relatedToLive: true }); continue; }
    const s = window.getComputedStyle(el);
    const paints = s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0;
    chrome.push({ box: el.getBoundingClientRect(), paints, relatedToLive: false });
  }
  return { liveBoxes, chrome };
}

// visibility:hidden, not display:none — layout must be preserved so the chrome
// rasterises at exactly the geometry the live canvases will be blitted into.
// !important because it has to beat the tool's own stylesheet.
function hideLiveCanvases(live: HTMLCanvasElement[]): () => void {
  const prev = live.map(c => ({ c, v: c.style.getPropertyValue('visibility'), p: c.style.getPropertyPriority('visibility') }));
  for (const c of live) c.style.setProperty('visibility', 'hidden', 'important');
  return () => {
    for (const { c, v, p } of prev) {
      if (v) c.style.setProperty('visibility', v, p);
      else c.style.removeProperty('visibility');
    }
  };
}

async function createFrameSource(node: Element, opts: ExportOpts = {}): Promise<{ width: number; height: number; frame(t?: number): Promise<HTMLCanvasElement>; dispose(): void }> {
  const lib = await getDomToImage();
  const { width: nodeW, height: nodeH } = node.getBoundingClientRect();
  const targetW = ((opts.width  as number) > 0) ? (opts.width  as number) : nodeW;
  const targetH = ((opts.height as number) > 0) ? (opts.height as number) : nodeH;
  const dtoOpts = {
    width:  targetW,
    height: targetH,
    style: {
      transform:       `scale(${targetW / nodeW})`,
      transformOrigin: 'top left',
      width:  `${nodeW}px`,
      height: `${nodeH}px`,
    },
  };
  const restore = await swapBlobUrls(node);
  const waitMs = (opts.wait ?? 1) * 1000;
  const durationMs = (opts.duration ?? 5) * 1000;   // same default every caller uses to derive frameCount
  let settled = false;
  // Raise the driven flag now (before the first capture) so a frame-clock tool's
  // rAF loop stops advancing on its own; frame(t) then paints the exact phase.
  const frameClock = beginFrameClock(node);

  // ── Static-chrome fast path ────────────────────────────────────────────────
  // Watch from construction, not from the probe: for a tool with NO export clock
  // the only available evidence that its chrome is static is that nothing mutated
  // across the settle wait and a whole real capture, and that is exactly the
  // window this observer covers. Canvas pixel writes raise no records, so "zero
  // records" is positive proof the only per-frame change is canvas pixels.
  //
  // It also stays connected AFTER a yes. For a clockless tool the probe's window is
  // one settle wait plus one capture, so a slow setInterval that retouches the DOM
  // between samples would be missed and frozen into the cached layer for the whole
  // clip. Draining per frame turns the sample into continuous evidence.
  const watcher = typeof MutationObserver === 'function' ? new MutationObserver(() => { /* records read via takeRecords */ }) : null;
  watcher?.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  type FastPath = { chrome: HTMLCanvasElement; live: HTMLCanvasElement[]; own: Set<Element>; out: HTMLCanvasElement; nodeW: number; nodeH: number };
  let framesTaken = 0;
  let decided = false;          // the probe runs at most once; a "no" is never retried
  let fast: FastPath | null = null;
  const guard = createStaticChromeGuard();

  // The one-off chrome shot. visibility:hidden keeps the canvases' LAYOUT intact, so
  // the blit lands exactly where dom-to-image would have drawn them, and their pixels
  // don't get baked into the cached layer underneath the live ones.
  //
  // It does NOT skip dom-to-image's canvas handling: `makeNodeCopy` calls
  // `original.toDataURL()` for every canvas whatever its computed style, so this shot
  // still pays that ~30.8 ms — once, instead of on all 240 frames. That is also why a
  // tainted canvas still throws here rather than silently degrading.
  //
  // Restores on EVERY exit including a throw: a tool left with a hidden canvas after a
  // failed export is a black preview.
  const rasterChrome = async (live: HTMLCanvasElement[]): Promise<HTMLCanvasElement> => {
    const unhide = hideLiveCanvases(live);
    try { return normalizeCanvas(await lib.toCanvas(node, dtoOpts), targetW, targetH); }
    finally { unhide(); }
  };

  const probeStaticChrome = async (): Promise<FastPath | null> => {
    const live = visibleCanvases(node);
    // Drive the clock to two DIFFERENT phases before reading the records: if any
    // chrome is a function of frame time, this is what makes it move where the
    // observer can see it. filter-*'s `[data-ov-clock]` rewrites an SVG overlay
    // from its hook and slides/deck-builder seek CSS keyframes — both are caught
    // here rather than silently frozen into the cached layer.
    if (frameClock) { renderFrameAt(frameClock, 0.37); renderFrameAt(frameClock, 0.71); }
    const geom = live.length ? chromeElements(node, live) : null;
    const verdict = staticChromeVerdict({
      externalScreenshot: !!window.__lollyCaptureScreenshot,
      liveCanvases: live.length,
      // No MutationObserver (a non-browser host) means no proof, so no fast path.
      mutationRecords: watcher ? watcher.takeRecords().length : 1,
      animations: node.getAnimations?.({ subtree: true })?.length ?? 0,
      chromeOverlaps: geom ? chromePaintsOverLive(geom.liveBoxes, geom.chrome) : true,
    });
    if (!verdict.ok) {
      _host?.log?.('info', `frame capture: full rasterise per frame (${verdict.reason})`);
      return null;
    }
    const rect = node.getBoundingClientRect();
    const out = document.createElement('canvas');
    out.width = targetW; out.height = targetH;
    return { chrome: await rasterChrome(live), live, own: new Set<Element>(live), out, nodeW: rect.width, nodeH: rect.height };
  };

  // At 4K the chrome raster plus the composite is tens of MB of backing store, and a
  // mid-export stand-down drops the path with the whole encode still to run.
  const releaseFast = (f: FastPath): void => {
    f.chrome.width = f.chrome.height = 0;
    f.out.width = f.out.height = 0;
  };

  const composeFrame = async (f: FastPath): Promise<HTMLCanvasElement> => {
    const rect = node.getBoundingClientRect();
    // Re-measuring each canvas's box every frame is free; re-rasterising the
    // chrome is the ~31.9 ms this path exists to avoid. So the cached layer is
    // only redone when the NODE's own box changed, which is the one case where
    // the chrome behind the canvases can genuinely have reflowed.
    if (Math.abs(rect.width - f.nodeW) > 0.5 || Math.abs(rect.height - f.nodeH) > 0.5) {
      f.chrome = await rasterChrome(f.live);
      f.nodeW = rect.width; f.nodeH = rect.height;
    }
    // Node space → target space is the single UNIFORM factor dtoOpts already applies
    // to dom-to-image's clone: rasterStyle sets `transform: scale(targetW / node.w)`
    // and never scales height independently. Deriving a separate `sy = targetH/nodeH`
    // looks more correct and is not — the two layers then disagree vertically the
    // moment the target aspect differs from the node's (ask for 1920 wide on a square
    // 1280x1280 stage and the blitted canvas stretches away from the chrome behind
    // it). Taken at construction, so both layers are built from one number.
    const s = targetW / nodeW;
    const ctx = f.out.getContext('2d')!;
    ctx.clearRect(0, 0, targetW, targetH);
    ctx.drawImage(f.chrome, 0, 0);
    for (const c of f.live) {
      const r = c.getBoundingClientRect();
      if (!(c.width > 0 && c.height > 0) || r.width <= 0 || r.height <= 0) continue;   // drawImage throws on a 0-sized source
      ctx.drawImage(c, (r.x - rect.x) * s, (r.y - rect.y) * s, r.width * s, r.height * s);
    }
    return f.out;
  };

  return {
    width: targetW,
    height: targetH,
    async frame(t = 0): Promise<HTMLCanvasElement> {
      if (frameClock) renderFrameAt(frameClock, t);   // deterministic phase — no settle wait needed
      else if (!settled) { await new Promise<void>(r => setTimeout(r, waitMs)); settled = true; }
      // Scrub any CSS animation/transition to the exact frame time regardless of
      // frameClock — a clocked canvas can still share the DOM with CSS-animated
      // chrome around it. No-op when the node has none.
      scrubAnimations(node, t * durationMs);
      if (window.__lollyCaptureScreenshot)
        return captureViaExternalScreenshot(targetW, targetH, window.__lollyCaptureScreenshot);
      framesTaken++;
      // Probe on the SECOND frame, never the first: renderIco takes exactly one
      // frame per size, where caching a chrome layer is pure overhead, and by the
      // second call the observer has watched a whole real capture go by.
      if (!decided && framesTaken > 1) {
        decided = true;
        try { fast = await probeStaticChrome(); }
        catch (e) {
          fast = null;
          _host?.log?.('warn', `static-chrome probe failed, keeping full rasterise: ${(e as Error)?.message ?? e}`);
        }
        // The probe drove the clock to its own phases to shake out time-dependent
        // chrome, so the real one has to be repainted — and that is true WHATEVER the
        // verdict. Gating this on `fast` meant every clocked tool that DECLINED the
        // fast path (slides and deck-builder on their CSS animations, the filter-*
        // tools on their overlay hook's mutations) captured frame 1 at the probe's
        // 0.71 phase instead of its own: a visible time-jump one frame into the clip,
        // on exactly the tools the fast path never touches.
        if (frameClock) renderFrameAt(frameClock, t);
        // Nothing reads records once the fast path is out of the picture, and an
        // observer nobody drains queues every record of a 240-frame export.
        if (!fast) watcher?.disconnect();
      }
      if (fast) {
        // The cached chrome is only usable while nothing but canvas pixels has
        // changed since it was taken. rasterChrome's own visibility swap shows up
        // here as attribute records on those same canvases, so it is filtered out —
        // otherwise the path would invalidate itself on its first composited frame.
        const mutated = watcher ? countToolMutations(watcher.takeRecords(), fast.own) : 0;
        const action = staticChromeFrameAction(guard, mutated);
        if (action === 'stand-down') {
          _host?.log?.('info', `frame capture: standing down to full rasterise per frame (chrome mutated ${guard.invalidations}x mid-export)`);
          releaseFast(fast);
          fast = null;
          watcher?.disconnect();
        } else if (action === 'refresh') {
          fast.chrome = await rasterChrome(fast.live);
          // Re-baseline the box in the same breath: a mutation that also reflowed the
          // node would otherwise make composeFrame rasterise the chrome a second time
          // for this one frame.
          const r = node.getBoundingClientRect();
          fast.nodeW = r.width; fast.nodeH = r.height;
        }
      }
      return fast ? composeFrame(fast) : lib.toCanvas(node, dtoOpts);
    },
    dispose() {
      endFrameClock(frameClock);
      watcher?.disconnect();
      if (fast) { releaseFast(fast); fast = null; }
      restore();
    },
  };
}

// ── Favicon / ICO ─────────────────────────────────────────────────────────────
// Renders the node into a multi-resolution .ico (16/32/48 px PNG entries). Best
// suited to square marks/logos; non-square content is scaled to the box.
const ICO_SIZES = [16, 32, 48];
async function renderIco(node: Element, opts: ExportOpts): Promise<Blob> {
  const sizes = opts.icoSizes ?? ICO_SIZES;
  const entries: { size: number; bytes: Uint8Array }[] = [];
  for (const size of sizes) {
    // wait:0 — favicons are static, so there's no animation to settle.
    const src = await createFrameSource(node, { width: size, height: size, wait: 0 });
    let canvas: HTMLCanvasElement;
    try { canvas = await src.frame(); } finally { src.dispose(); }
    const blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('ICO frame encode failed')), 'image/png'));
    entries.push({ size, bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  return packIco(entries);
}

// Pack PNG entries into an ICO container: ICONDIR + ICONDIRENTRY[] + PNG data.
function packIco(entries: { size: number; bytes: Uint8Array }[]): Blob {
  const count = entries.length;
  const header = new Uint8Array(6 + count * 16);
  const dv = new DataView(header.buffer);
  dv.setUint16(0, 0, true);      // reserved
  dv.setUint16(2, 1, true);      // type 1 = icon
  dv.setUint16(4, count, true);  // image count
  let offset = header.length;
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    header[o]     = e.size >= 256 ? 0 : e.size; // width  (0 ⇒ 256)
    header[o + 1] = e.size >= 256 ? 0 : e.size; // height (0 ⇒ 256)
    dv.setUint16(o + 4, 1, true);               // colour planes
    dv.setUint16(o + 6, 32, true);              // bits per pixel
    dv.setUint32(o + 8, e.bytes.length, true);  // bytes in resource
    dv.setUint32(o + 12, offset, true);         // offset to data
    offset += e.bytes.length;
  });
  const out = new Uint8Array(offset);
  out.set(header, 0);
  let p = header.length;
  for (const e of entries) { out.set(e.bytes, p); p += e.bytes.length; }
  return new Blob([out], { type: 'image/x-icon' });
}

// ── ZIP bundle ────────────────────────────────────────────────────────────────
// Bundles several of the tool's render formats into one archive. The shell passes
// opts.bundleFormats (visual formats only — data/video are excluded). Each entry
// renders through renderFormat on the already-watermarked node, then is zipped.
// Per-member archive filename (base + correct extension). A print PDF is renamed so
// it doesn't clobber an RGB pdf in the same bundle; the animated SVG likewise sits
// beside a still svg. Extensions that differ from the format token are mapped.
const ZIP_MEMBER_EXT: Record<string, string> = { jpeg: 'jpg', 'eps-cmyk': 'eps', 'cmyk-tiff': 'tiff', 'webp-anim': 'webp' };
function zipMemberName(base: string, f: string): string {
  if (f === 'pdf-cmyk') return `${base}-print.pdf`;
  if (f === 'svg-anim') return `${base}-animated.svg`;
  return `${base}.${ZIP_MEMBER_EXT[f] ?? f}`;
}

async function renderZip(node: Element, opts: ExportOpts): Promise<Blob> {
  const base = (opts.filename || 'export').replace(/\.[a-z0-9]+$/i, '') || 'export';
  const password = opts.strongPassword || opts.password;
  // Defense-in-depth, matching the folder/batch path (pro/zip.ts): when the whole zip
  // is locked, any PDF member is ALSO individually AES-256 (R6) locked with the same
  // password — so a PDF stays locked even after the zip is unpacked. Always the strong
  // tier for the inner PDF (RC4 needs a plain unfinished doc; AES composes with any).
  // Non-PDF members carry no lock of their own — only the container protects them.
  const memberOpts: ExportOpts = password
    ? { ...opts, password: undefined, strongPassword: password }
    : { ...opts, password: undefined, strongPassword: undefined };
  const members: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const f of (opts.bundleFormats ?? []).filter(x => x !== 'zip')) {
    const blob = await renderFormat(node, f, memberOpts);
    members.push({ name: zipMemberName(base, f), bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  return packZip(members, opts);
}

// Pack already-rendered members into the archive. Split out of renderZip so the
// contact sheet (bridge/sequence-cuts.ts) gets the identical container — including
// both password tiers — without a second zip implementation.
async function packZip(members: Array<{ name: string; bytes: Uint8Array }>, opts: ExportOpts): Promise<Blob> {
  const password = opts.strongPassword || opts.password;

  // Encrypted bundle: standard = PKWARE ZipCrypto (opens anywhere, incl. Windows
  // Explorer; weak); strong = WinZip AES-256 (7-Zip / Keka / macOS; strong). Mirrors
  // the two-tier PDF lock. The shell compresses each member with fflate + hands the
  // engine bytes + CRC; buildEncryptedZip does the crypto + framing.
  if (password) {
    const { deflateSync } = await import('fflate');
    const entries = members.map(({ name, bytes }) => {
      const deflated = deflateSync(bytes);
      // Store (method 0) when deflate doesn't help (already-compressed png/jpg/webp).
      const stored = deflated.length >= bytes.length;
      return {
        name,
        compressed: stored ? bytes : deflated,
        method: (stored ? 0 : 8) as 0 | 8,
        crc32: crc32(bytes),
        uncompressedSize: bytes.length,
      };
    });
    const out = await buildEncryptedZip(entries, { tier: opts.strongPassword ? 'strong' : 'standard', password });
    return new Blob([out as BlobPart], { type: 'application/zip' });
  }

  const { zipSync } = await import('fflate');
  const files: Record<string, Uint8Array> = {};
  for (const { name, bytes } of members) files[name] = bytes;
  return new Blob([zipSync(files)], { type: 'application/zip' });
}

// ── PPTX (PowerPoint) ─────────────────────────────────────────────────────────
// Purpose: transport a page's treated IMAGES and VECTORS into PowerPoint as separate,
// extractable objects at full fidelity — layout is secondary. So instead of one flat
// picture per slide, the DOM is decomposed:
//   • an <svg> → a real embedded SVG picture (asvg:svgBlip + a PNG fallback), so the
//     recipient can pull the crisp vector out (PowerPoint even "Convert to Shape"s it);
//   • an <img> → a high-res PNG at (up to) its native resolution, with any CSS
//     treatment baked in — the actual treated photo, extractable;
//   • a url() background → the fetched asset bytes as a picture;
//   • text → a native, editable text box (font size / colour / weight / align);
//   • solid/gradient backgrounds + borders → rect shapes (light layout context);
//   • anything the walkers can't express (filter/mask/blend/clip/conic) → that subtree
//     rasterised to a PNG picture (baked, but faithful).
// A paged tool ([data-pdf-page]) fans out to one slide per page; a single-canvas tool
// is one slide. The engine (buildPptxParts) frames the OOXML from the shapes + media.

// Renders the DOM node into a video using captureStream() + MediaRecorder.
//
// Two-phase approach to guarantee stable frame rate regardless of render speed:
//   Phase 1 — render: each frame is captured sequentially via toCanvas() and
//     stored as an ImageBitmap (GPU memory). Takes longer than real-time on
//     slow machines but ensures every frame is visually unique.
//   Phase 2 — replay: pre-rendered frames are painted to an offscreen canvas
//     at exactly the target fps while MediaRecorder encodes the stream.
//
// opts.wait     — seconds to let CSS animations settle before recording starts (default 1)
// opts.duration — length of the recorded clip in seconds (default 5)
//
// Hard ceiling on buffered frames (Phase 1 holds one ImageBitmap each). A normal
// clip is well under this; it exists to bound memory when duration/fps are pushed
// past the UI limits via the URL, which would otherwise OOM a mobile WebView.
// Scaled off navigator.deviceMemory where it's reported (Chromium only — the API
// caps at 8): an 8GB-class device keeps the historical 600, a 2GB mobile WebView
// gets a tighter ceiling instead of the same flat number as desktop. Floored at
// 200 so the default 5s clip (150 frames at 30fps) always completes.
function maxVideoFrames(): number {
  const gb = (navigator as { deviceMemory?: number }).deviceMemory;
  if (!gb) return 600;
  return Math.max(200, Math.round((Math.min(8, gb) / 8) * 600));
}

// ── Encode quality: explicit bitrate + deterministic frame delivery ──────────
// Bitrate math lives in video-mime.ts (DOM-free, shared with recorder.ts) — the
// default 0.1 bits/pixel is tuned for these offline graphic renders. Audio bed
// rides at a fixed 128 kbps.
const AUDIO_BITRATE = 128_000;
function recorderOpts(mimeType: string, width: number, height: number, fps: number, hasAudio: boolean): MediaRecorderOptions {
  const o: MediaRecorderOptions = { mimeType, videoBitsPerSecond: videoBitrate(width, height, fps) };
  if (hasAudio) o.audioBitsPerSecond = AUDIO_BITRATE;
  return o;
}

// A canvas capture stream we drive BY HAND: captureStream(0) emits a frame only when
// we call requestFrame(), so exactly the frames we paint get encoded — frame-accurate,
// with no setTimeout drift, no background-tab throttle, and no auto-sampler picking up
// half-painted or duplicated states. `deliver()` hands the current canvas contents to
// the encoder. Where requestFrame() isn't available the stream falls back to the fps
// auto-sampler and deliver() becomes a no-op, preserving the old behaviour.
function manualCaptureStream(canvas: HTMLCanvasElement, fps: number): { stream: MediaStream; deliver: () => void } {
  const s = canvas.captureStream(0);
  const track = s.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  if (typeof track?.requestFrame === 'function') return { stream: s, deliver: () => track.requestFrame() };
  s.getTracks().forEach(t => t.stop());
  return { stream: canvas.captureStream(fps), deliver: () => {} };
}

// ── WebCodecs encode path (offline, faster-than-real-time) ───────────────────
// A deterministic alternative to the MediaRecorder capture: pre-rendered frames are
// handed straight to a VideoEncoder with exact timestamps and an honoured bitrate, then
// muxed in memory. The muxers (mp4-muxer / webm-muxer) are pure-JS, make no network
// calls, and are lazy-imported so they never touch the initial bundle (loaded — and
// service-worker-cached for offline — only when a video is first exported). Versus
// MediaRecorder this gives frame-accurate output, real H.264 High profile for mp4, and
// encodes as fast as the CPU allows instead of in real time (a big win for long/large
// clips, and it can't stall in a backgrounded tab). pickWebCodecsVideo returns null when
// WebCodecs — or a codec for the requested size — isn't available, so renderVideo falls
// back to the MediaRecorder path.
interface WebCodecsPick { container: 'mp4' | 'webm'; codec: string; muxCodec: string; }
async function pickWebCodecsVideo(preferred: string, width: number, height: number, fps: number, bitrate: number): Promise<WebCodecsPick | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const mp4: WebCodecsPick[] = [
    { container: 'mp4', codec: 'avc1.640033', muxCodec: 'avc' },     // H.264 High L5.1
    { container: 'mp4', codec: 'avc1.4d0033', muxCodec: 'avc' },     // H.264 Main L5.1
  ];
  const webm: WebCodecsPick[] = [
    { container: 'webm', codec: 'vp09.00.10.08', muxCodec: 'V_VP9' },
    { container: 'webm', codec: 'vp8', muxCodec: 'V_VP8' },
  ];
  for (const pick of preferred === 'mp4' ? [...mp4, ...webm] : [...webm, ...mp4]) {
    try {
      const support = await VideoEncoder.isConfigSupported({ codec: pick.codec, width, height, bitrate, framerate: fps });
      if (support?.supported) return pick;
    } catch { /* try the next candidate */ }
  }
  return null;
}

interface WebCodecsAudioPick { codec: string; muxCodec: string; sampleRate: number; numberOfChannels: number; bitrate: number; }
// Pick a WebCodecs audio codec for the chosen container: AAC-LC for mp4, Opus for
// webm. Returns null when AudioEncoder (or that codec) isn't available, so an audio
// export cleanly falls back to the MediaRecorder path that muxes the live track.
async function pickWebCodecsAudio(container: 'mp4' | 'webm'): Promise<WebCodecsAudioPick | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  const sampleRate = 48_000, numberOfChannels = 2, bitrate = AUDIO_BITRATE;
  // WebCodecs codec string vs the muxer's own codec token differ per container.
  const cand = container === 'mp4'
    ? { codec: 'mp4a.40.2', muxCodec: 'aac' }
    : { codec: 'opus',      muxCodec: 'A_OPUS' };
  try {
    const s = await AudioEncoder.isConfigSupported({ codec: cand.codec, sampleRate, numberOfChannels, bitrate });
    if (s?.supported) return { ...cand, sampleRate, numberOfChannels, bitrate };
  } catch { /* unsupported */ }
  return null;
}

interface WebCodecsAudioTrack extends WebCodecsAudioPick { buffer: AudioBuffer; }

// An offline-rendered audio bed (AudioBuffer) → the transferable planar form the DOM-free
// encode core takes. numberOfChannels stays the track's declared count; the core clamps
// to the buffer's actual channel count when a plane is missing.
function audioTrackToPlanar(a: WebCodecsAudioTrack): EncodeAudio {
  const channels = Array.from({ length: a.buffer.numberOfChannels }, (_, i) => a.buffer.getChannelData(i));
  return { channels, sampleRate: a.sampleRate, numberOfChannels: a.numberOfChannels, codec: a.codec, muxCodec: a.muxCodec, bitrate: a.bitrate };
}

// Encode + mux the buffered frames on the MAIN thread (the DOM-free core), then wrap the
// bytes in a Blob and embed provenance. The Worker path (renderVideo) calls the same core
// off-thread and wraps identically.
async function encodeVideoWithWebCodecs(
  frames: ImageBitmap[],
  pick: WebCodecsPick,
  o: { width: number; height: number; fps: number; bitrate: number; meta?: ExportMeta | null; audio?: WebCodecsAudioTrack | null },
): Promise<Blob> {
  const { buffer, type } = await encodeMuxWebCodecs(frames, pick, {
    width: o.width, height: o.height, fps: o.fps, bitrate: o.bitrate,
    audio: o.audio ? audioTrackToPlanar(o.audio) : null,
  });
  return withVideoMeta(new Blob([buffer], { type }), type, o.meta ?? null);
}

async function renderVideo(node: Element, opts: ExportOpts, preferred: string): Promise<Blob> {
  // Audio (opts.audio = { id?, url }) is resolved up front so a bad track fails
  // fast — before the slow Phase 1 capture — and degrades to silent + warning.
  // Pass the clip length so any fade-out lands at the end of the replay.
  const { audio, mimeType } = await prepareExportAudio(opts, preferred, opts.duration ?? 5);
  if (!mimeType) { audio?.stop(); throw new Error(NO_VIDEO_MSG); }

  // A tool with a continuously-animating <canvas> can OPT IN to real-time stream
  // capture by marking it `data-capture-stream` — the canvas's own rAF loop is
  // recorded at wall-clock speed, so a self-looping animation (e.g. the 3d tool's
  // turntable: one revolution per `duration`s) yields a genuine seamless loop, and
  // it's faster than the frame-by-frame path. Opt-in so tools that composite DOM
  // overlays on top of a canvas keep the compositing (frame-by-frame) path.
  const streamCanvas = (node as Element).querySelector?.('canvas[data-capture-stream]') as HTMLCanvasElement | null;
  const captureEl = (typeof (node as any).captureStream === 'function')
    ? (node as HTMLCanvasElement)
    : (streamCanvas && typeof streamCanvas.captureStream === 'function' ? streamCanvas : null);
  if (captureEl) {
    const waitMs     = (opts.wait     ?? 1) * 1000;
    const durationMs = (opts.duration ?? 5) * 1000;
    const canvasFps  = opts.fps ?? 30;
    await new Promise<void>(r => setTimeout(r, waitMs));
    return recordStream(captureEl.captureStream(canvasFps), { durationMs, mimeType, audio, meta: opts.meta, width: captureEl.width, height: captureEl.height, fps: canvasFps });
  }

  const fps        = opts.fps ?? 24;
  const frameMs    = 1000 / fps;
  const durationMs = (opts.duration ?? 5) * 1000;
  let   frameCount = Math.ceil(durationMs / frameMs);

  // Phase 1 buffers every frame as an ImageBitmap before replay, so the frame
  // count is the memory ceiling. Clamp it so a long/high-fps request (the duration
  // limit is bypassable via the URL) can't queue hundreds of bitmaps and OOM a
  // mobile WebView. The cap is generous for normal clips; beyond it the clip is
  // truncated and we warn through the log channel.
  const cap = maxVideoFrames();
  if (frameCount > cap) {
    _host?.log?.('warn', `Video capped at ${cap} frames (requested ${frameCount}); lower the duration or frame rate for a longer clip.`);
    frameCount = cap;
  }

  // Phase 1: render all frames sequentially through the shared FrameSource.
  // Animation advances in real time between frames, so each captures a unique
  // state — recording takes longer than real-time but never duplicates/skips.
  const source  = await (async () => {
    try { return await createFrameSource(node, opts); }
    catch (err) { audio?.stop(); throw err; }
  })();
  const targetW = source.width, targetH = source.height;
  const frames: ImageBitmap[]  = [];
  try {
    for (let i = 0; i < frameCount; i++) {
      frames.push(await createImageBitmap(await source.frame(i / frameCount)));
      // Progress for a slow N-frame render (no-op when no listener is wired).
      opts.onProgress?.(i + 1, frameCount);
    }
  } catch (err) {
    audio?.stop();
    throw err;
  } finally {
    source.dispose();
  }

  // Fast path: encode the buffered frames (and, for an audio export, an offline-
  // rendered music bed) straight through WebCodecs. Deterministic, honours the
  // bitrate, real H.264 High / AAC (mp4) or VP9 / Opus (webm), faster than real time.
  // Audio takes this path ONLY when BOTH VideoEncoder and AudioEncoder support the
  // chosen codecs; otherwise it falls through to the MediaRecorder path below, which
  // muxes the live audio track in real time. Any failure falls through cleanly (the
  // frames + the live `audio` track stay valid for Phase 2).
  {
    const clipSec = frames.length / fps;         // bed length == the ACTUAL (maybe capped) video length
    const bitrate = videoBitrate(targetW, targetH, fps);
    const pick = await pickWebCodecsVideo(preferred, targetW, targetH, fps, bitrate);
    const wantAudio = !!opts.audio?.url;
    const audioPick = pick && wantAudio ? await pickWebCodecsAudio(pick.container) : null;
    if (pick && (!wantAudio || audioPick)) {
      // Resolve the offline music bed once; a failure here (bedOk=false) falls through to
      // the MediaRecorder Phase 2, which muxes the live audio track instead.
      let track: WebCodecsAudioTrack | null = null;
      let bedOk = true;
      try {
        if (wantAudio && audioPick) {
          const bed = await renderMusicBed(opts.audio!.url, clipSec, audioPick.sampleRate, {
            fadeIn: opts.audio!.fadeIn, fadeOut: opts.audio!.fadeOut, clipSec, volume: opts.audio!.volume, start: opts.audio!.start,
          });                                     // matches prepareExportAudio's envelope (renderVideo beds don't duck)
          if (bed) track = { ...audioPick, buffer: bed };
        }
      } catch { bedOk = false; }

      // Off-thread encode (opt-in, probe-gated): hand the buffered frames + a COPY of the
      // bed PCM to a Worker so the encode/mux runs off the main thread. Transfer is one-way,
      // so this is COMMITTED — no Phase 2 fallback (the up-front support probe makes a mid-
      // encode failure unlikely; a failure surfaces as a clear error and the user re-exports).
      if (bedOk && supportsWorkerVideoEncode()) {
        try {
          const workerAudio: EncodeAudio | null = track ? {
            channels: Array.from({ length: track.buffer.numberOfChannels }, (_, i) => new Float32Array(track!.buffer.getChannelData(i))),
            sampleRate: track.sampleRate, numberOfChannels: track.numberOfChannels, codec: track.codec, muxCodec: track.muxCodec, bitrate: track.bitrate,
          } : null;
          _host?.log?.('info', `video: WebCodecs (worker) ${pick.container}/${pick.codec}${track ? '+' + audioPick!.codec : ''} ${targetW}×${targetH}@${fps}`);
          const enc = await encodeVideoInWorker(frames, pick, { width: targetW, height: targetH, fps, bitrate, audio: workerAudio });
          const blob = await withVideoMeta(new Blob([enc.buffer], { type: enc.type }), enc.type, opts.meta ?? null);
          audio?.stop();                            // the worker consumed + closed the frames
          return blob;
        } catch (err) {
          audio?.stop();
          throw err instanceof Error ? err : new Error('worker video encode failed');
        }
      }

      // In-thread encode: on failure the frames + live `audio` track stay valid for Phase 2.
      if (bedOk) {
        try {
          _host?.log?.('info', `video: WebCodecs ${pick.container}/${pick.codec}${track ? '+' + audioPick!.codec : ''} ${targetW}×${targetH}@${fps} ${Math.round(bitrate / 1000)}kbps`);
          const blob = await encodeVideoWithWebCodecs(frames, pick, { width: targetW, height: targetH, fps, bitrate, meta: opts.meta, audio: track });
          frames.forEach(b => b.close());
          audio?.stop();                            // discard the now-unused live MediaRecorder audio track
          return blob;
        } catch (err) {
          _host?.log?.('warn', `WebCodecs encode failed (${(err as { message?: string })?.message ?? err}); falling back to MediaRecorder.`);
          // frames stay open; the live `audio` track stays live for Phase 2 below.
        }
      }
    }
  }

  // Phase 2: replay pre-rendered frames at target fps into captureStream.
  // drawImage(bitmap) is near-instant so the replay timing is stable. The
  // audio bed joins the stream here (not in Phase 1): replay is real-time, so
  // starting the looped source at recorder.start() keeps it in sync and its
  // loop naturally covers the actual replay length — including a clip
  // truncated by maxVideoFrames(), where frames.length is the timeline.
  const offscreen = document.createElement('canvas');
  offscreen.width  = targetW;
  offscreen.height = targetH;
  const ctx    = offscreen.getContext('2d')!;
  // Drive frame delivery by hand so the replay is frame-accurate and stays locked to
  // wall-clock (and thus to the audio bed) — see manualCaptureStream.
  const { stream, deliver } = manualCaptureStream(offscreen, fps);
  if (audio) stream.addTrack(audio.track);

  const recorder = new MediaRecorder(stream, recorderOpts(mimeType, targetW, targetH, fps, !!audio));
  const chunks: Blob[]   = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  return new Promise<Blob>((resolve, reject) => {
    recorder.onerror = e => { audio?.stop(); reject((e as any).error ?? new Error('MediaRecorder error')); };
    recorder.onstop  = () => {
      audio?.stop();
      stream.getTracks().forEach(t => t.stop());
      frames.forEach(b => b.close());
      const container = videoContainer(mimeType);
      resolve(withVideoMeta(new Blob(chunks, { type: container }), container, opts.meta));
    };

    recorder.start();
    audio?.start();

    // Replay: hand each pre-rendered frame to the encoder exactly once — captureStream(0)
    // + requestFrame() means the frame we paint IS the frame that's encoded (no fps
    // auto-sampler duplicating or dropping frames against the paint clock). Paced by
    // setTimeout, NOT rAF: rAF pauses entirely in a backgrounded/headless tab, which
    // would stall the export mid-record; setTimeout keeps advancing (throttled at worst)
    // so the clip always completes, and in the foreground it runs at ~real-time so the
    // audio bed stays in sync.
    let fi = 0;
    function pump() {
      if (fi >= frames.length) { setTimeout(() => { try { recorder.stop(); } catch { /* already stopping */ } }, Math.max(frameMs, 40)); return; }
      ctx.drawImage(frames[fi++]!, 0, 0);
      deliver();
      setTimeout(pump, frameMs);
    }
    pump();
  });
}

// ── Live capture ("Record live") ─────────────────────────────────────────────
// Records the on-screen preview through a screen share so the clip's frame pacing
// matches what the user actually watched — the opt-in alternative to the offline
// paths above. Chromium self-tab shares crop to the element exactly (CropTarget);
// other browsers/surfaces run live-capture.ts's stage-flash calibration and a
// per-frame canvas crop. One MediaRecorder encode at the live bitrate tier (real
// motion, one take, no re-render). The module is lazy-imported so it loads only
// when the option is actually used. wait/fps don't apply: capture starts when the
// stage is located and frames arrive at the compositor's own cadence.
//
// A SEQUENCE STAGE gets a playhead driven for it. Live capture films whatever the
// DOM is doing, and a timed composition does nothing on its own — the preview's
// playhead only moves while the timeline panel drives it — so a live take of a
// sequence used to be one frozen frame for the whole clip. `driveSequenceTime`
// (bridge/sequence-dom.ts, the same applier the preview clock uses, never a second
// copy of the maths) advances t from 0 across the capture window and restores every
// authored style afterwards. It starts on `onRecordStart`, so the composition does
// not play through the screen-share picker before the recorder is rolling.
async function renderLive(node: Element, opts: ExportOpts, preferred: string): Promise<Blob> {
  const durationS = opts.duration ?? 5;
  const { audio, mimeType } = await prepareExportAudio(opts, preferred, durationS);
  if (!mimeType) { audio?.stop(); throw new Error(NO_VIDEO_MSG); }
  const { captureLiveClip } = await import('./live-capture.ts');
  // Bitrate from the stage's device-pixel size — the ceiling either crop tier can
  // deliver. 60fps in the math (compositor rate); the clamp bounds a huge canvas.
  const { width, height } = node.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  // Lazy, like live-capture itself: the applier pulls in the plan module's clamps
  // and the transition maths, which the initial bundle has no use for.
  const playhead = isSequenceStage(node)
    ? (await import('./sequence-dom.ts')).driveSequenceTime(node as HTMLElement, { durationMs: durationS * 1000 })
    : null;
  try {
    const blob = await captureLiveClip(node, {
      durationMs: durationS * 1000,
      mimeType,
      videoBitsPerSecond: videoBitrate(Math.round(width * dpr), Math.round(height * dpr), 60, LIVE_BITS_PER_PIXEL),
      audioTrack: audio?.track ?? null,
      onRecordStart: () => { audio?.start(); playhead?.start(); },
      // Countdown for chrome OUTSIDE the capture (the export button) — the in-page
      // pill is skipped whenever it has no capture-safe spot next to the stage.
      onProgress: opts.onProgress,
      onWarn: msg => _host?.log?.('warn', msg),
    });
    // MediaRecorder may fall back to the other container (mp4 request → webm bytes
    // on Firefox) — derive the label from what it actually produced, like renderVideo.
    const container = videoContainer(blob.type || mimeType);
    return await withVideoMeta(new Blob([blob], { type: container }), container, opts.meta);
  } finally {
    // Restores every class/inline style the playhead wrote, even if the capture threw
    // or the user cancelled the share — the live canvas must be left as it was found.
    playhead?.stop();
    audio?.stop();
  }
}

// ── Top & Tail video compositor ────────────────────────────────────────────────
// The export path for the top-tail-recorder tool: an intro "top" card → the
// recorded footage → an outro "tail" card, composited onto ONE canvas in REAL TIME
// (unlike renderVideo's sequential DOM capture, which would drift against a live
// <video>). The footage is drawn object-fit:cover into the chosen frame, so any
// camera aspect ratio fills a portrait OR landscape output consistently — the cards
// define the frame, the footage fits into it. The footage's own audio is mixed with
// an optional faded music bed into a single track. Detected via [data-toptail]; if
// no footage has been recorded yet it degrades to the plain DOM-timeline capture.
function ttNum(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

async function renderTopTail(node: Element, opts: ExportOpts, preferred: string): Promise<Blob> {
  const stage = ((node as HTMLElement).matches?.('[data-toptail]')
    ? node
    : node.querySelector('[data-toptail]')) as HTMLElement | null;
  const bodyVideo = stage?.querySelector('[data-tt="body"]') as HTMLVideoElement | null;
  const src = bodyVideo && (bodyVideo.currentSrc || bodyVideo.getAttribute('src'));
  // No recorded footage yet → fall back to the plain DOM-timeline capture (the cards
  // alone still make a valid clip), so an export never hard-fails pre-recording.
  if (!stage || !bodyVideo || !src) return renderVideo(node, opts, preferred);

  const mimeType = videoMimeType(preferred, { audio: true }) ?? videoMimeType(preferred);
  if (!mimeType) throw new Error(NO_VIDEO_MSG);

  const introEl = stage.querySelector('[data-tt="intro"]') as HTMLElement | null;
  const outroEl = stage.querySelector('[data-tt="outro"]') as HTMLElement | null;
  const lowerEl = stage.querySelector('[data-tt="lower"]') as HTMLElement | null;
  const introMs = ttNum(stage.dataset.introMs, 1600);
  const outroMs = ttNum(stage.dataset.outroMs, 1800);
  const lowerMs = ttNum(stage.dataset.lowerMs, 2600); // lower-third visible window at head & tail of body
  const fps = 30;
  const frameMs = 1000 / fps;
  const EDGE_FADE = 260; // ms of fade-from/to-black at the very ends

  const box = stage.getBoundingClientRect();
  const nodeW = box.width || 1080, nodeH = box.height || 1080;
  const targetW = Math.round(((opts.width  as number) > 0) ? (opts.width  as number) : nodeW);
  const targetH = Math.round(((opts.height as number) > 0) ? (opts.height as number) : nodeH);

  // Rasterise the card layers once at target size. Intro/outro are full-frame;
  // the lower-third keeps transparency (drawn as an overlay).
  const lib = await getDomToImage();
  const raster = async (el: HTMLElement | null): Promise<HTMLCanvasElement | null> => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const w = r.width || nodeW, h = r.height || nodeH;
    try {
      return await lib.toCanvas(el, {
        width: targetW, height: targetH,
        style: { transform: `scale(${targetW / w})`, transformOrigin: 'top left', width: `${w}px`, height: `${h}px` },
      });
    } catch { return null; }
  };
  const restore = await swapBlobUrls(stage);
  let introCanvas: HTMLCanvasElement | null = null;
  let outroCanvas: HTMLCanvasElement | null = null;
  let lowerCanvas: HTMLCanvasElement | null = null;
  try {
    introCanvas = await raster(introEl);
    outroCanvas = await raster(outroEl);
    lowerCanvas = await raster(lowerEl);
  } finally { restore(); }

  // A dedicated, UN-muted playback of the footage so its audio flows into the mix
  // (the on-canvas preview stays muted for autoplay).
  const play = document.createElement('video');
  play.src = src; play.muted = false; play.playsInline = true; play.preload = 'auto';
  await new Promise<void>((res) => {
    if (play.readyState >= 1) return res();
    play.onloadedmetadata = () => res();
    play.onerror = () => res();
  });
  // MediaRecorder WebM reports duration=Infinity until it's seeked to the end — force
  // it to resolve so the body phase gets the real clip length.
  if (!Number.isFinite(play.duration) || play.duration === 0) {
    await new Promise<void>((res) => {
      const to = setTimeout(res, 1500);
      play.ontimeupdate = () => {
        if (Number.isFinite(play.duration)) { clearTimeout(to); play.ontimeupdate = null; play.currentTime = 0; res(); }
      };
      try { play.currentTime = 1e7; } catch { clearTimeout(to); res(); }
    });
  }
  const TT_MAX_BODY_MS = 120000; // safety ceiling (2 min) on the composited body length
  const durSec = Number.isFinite(play.duration) && play.duration > 0 ? play.duration : 8;
  const bodyMs = Math.min(durSec * 1000, TT_MAX_BODY_MS);
  const totalMs = introMs + bodyMs + outroMs;

  // Whether the footage carries its own audio — the music only ducks when there's
  // something to duck under (a camera video-only recording is silent → no duck; an
  // uploaded talking clip → duck). Best-effort across engines (the forced end-seek
  // above has already decoded some audio, so webkitAudioDecodedByteCount is set).
  const av = play as HTMLVideoElement & { mozHasAudio?: boolean; webkitAudioDecodedByteCount?: number; audioTracks?: { length: number } };
  const footageHasAudio = Boolean(av.mozHasAudio)
    || (av.audioTracks?.length ?? 0) > 0
    || (av.webkitAudioDecodedByteCount ?? 0) > 0;

  // Audio graph: mix the footage's own audio + the (faded) music bed into ONE track
  // (MediaRecorder only reliably muxes a single audio track).
  const AC = globalThis.AudioContext ?? (globalThis as any).webkitAudioContext;
  const actx: AudioContext | null = AC ? new AC() : null;
  const dest = actx ? actx.createMediaStreamDestination() : null;
  let music: { start(): void; stop(): void } | null = null;
  if (actx && dest) {
    try {
      const bodySrc = actx.createMediaElementSource(play);
      const bodyGain = actx.createGain();
      bodyGain.gain.value = 1;
      bodySrc.connect(bodyGain).connect(dest);
    } catch { /* element already tapped / unsupported — footage plays silent */ }
    if (opts.audio?.url) {
      try {
        const bytes = await (await fetch(opts.audio.url)).arrayBuffer();
        const buffer = await actx.decodeAudioData(bytes);
        music = connectMusic(actx, buffer, dest, {
          fadeIn:  opts.audio.fadeIn  ?? 1,
          fadeOut: opts.audio.fadeOut ?? 1.4,
          clipSec: totalMs / 1000,
          volume:  opts.audio.volume,
          start:   opts.audio.start,
          duck: footageHasAudio && (opts.audio.duck ?? 1) < 1
            ? { level: opts.audio.duck ?? 1, startSec: introMs / 1000, endSec: (introMs + bodyMs) / 1000 }
            : undefined,
        });
      } catch (err) {
        _host?.log?.('warn', `Music bed unavailable (${(err as { message?: string })?.message ?? err}).`);
      }
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetW; canvas.height = targetH;
  const ctx = canvas.getContext('2d')!;
  const { stream, deliver } = manualCaptureStream(canvas, fps);
  const mixTrack = dest?.stream.getAudioTracks()[0];
  if (mixTrack) stream.addTrack(mixTrack);

  const container = videoContainer(mimeType);
  const recorder = new MediaRecorder(stream, recorderOpts(mimeType, targetW, targetH, fps, !!mixTrack));
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  const fillBlack = () => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, targetW, targetH); };
  const drawFull = (c: HTMLCanvasElement | null) => { if (c) ctx.drawImage(c, 0, 0, targetW, targetH); else fillBlack(); };
  // Clip fit (data-clip-fit): 'cover' fills the frame (crop); 'contain' fits the whole
  // clip with letterbox bars. Default cover — matches the recorded-camera behaviour.
  const fitContain = stage.dataset.clipFit === 'contain';
  const drawCover = (v: HTMLVideoElement) => {
    const vw = v.videoWidth || targetW, vh = v.videoHeight || targetH;
    const scale = fitContain ? Math.min(targetW / vw, targetH / vh) : Math.max(targetW / vw, targetH / vh);
    const dw = vw * scale, dh = vh * scale;
    if (fitContain) fillBlack();   // letterbox bars behind a contained clip
    ctx.drawImage(v, (targetW - dw) / 2, (targetH - dh) / 2, dw, dh);
  };

  return new Promise<Blob>((resolve, reject) => {
    const cleanup = () => {
      try { stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
      try { play.pause(); } catch { /* ignore */ }
      music?.stop();
      actx?.close().catch(() => {});
    };
    recorder.onerror = e => { cleanup(); reject((e as { error?: Error }).error ?? new Error('MediaRecorder error')); };
    recorder.onstop = () => { cleanup(); resolve(withVideoMeta(new Blob(chunks, { type: container }), container, opts.meta)); };

    let startT = 0;
    let bodyStarted = false;
    let lastFrame = -Infinity;
    const frame = (now: number): void => {
      if (!startT) startT = now;
      const el = now - startT;
      if (el >= totalMs) { try { recorder.stop(); } catch { /* already stopping */ } return; }

      // Composite + hand off one frame per fps tick (wall-clock paced): the live
      // footage is sampled at exactly fps and each painted frame is encoded once.
      if (now - lastFrame >= frameMs) {
        lastFrame = now;
        if (el < introMs) {
          drawFull(introCanvas);
        } else if (el < introMs + bodyMs) {
          if (!bodyStarted) {
            bodyStarted = true;
            try { play.currentTime = 0; } catch { /* ignore */ }
            play.play().catch(() => {});
          }
          if (play.readyState >= 2 && !play.ended) drawCover(play); else fillBlack();
          // Lower-third overlay: slides/fades in over the head and again near the tail.
          const bEl = el - introMs;
          const nearTail = bodyMs - bEl;
          if (lowerCanvas && (bEl < lowerMs || nearTail < lowerMs)) {
            const phase = bEl < lowerMs ? bEl : nearTail;      // 0..lowerMs
            const a = Math.min(1, phase / 350);                // ease in over 350ms
            ctx.globalAlpha = a;
            ctx.drawImage(lowerCanvas, 0, Math.round((1 - a) * 24), targetW, targetH);
            ctx.globalAlpha = 1;
          }
        } else {
          drawFull(outroCanvas);
        }

        // Global fade from/to black at the very ends of the whole clip.
        if (el < EDGE_FADE) { ctx.globalAlpha = 1 - el / EDGE_FADE; fillBlack(); ctx.globalAlpha = 1; }
        else if (totalMs - el < EDGE_FADE) { ctx.globalAlpha = 1 - (totalMs - el) / EDGE_FADE; fillBlack(); ctx.globalAlpha = 1; }

        deliver();
      }

      requestAnimationFrame(frame);
    };

    recorder.start();
    music?.start(); // music plays under the whole clip (intro→body→outro), fading per envelope
    requestAnimationFrame(frame);
  });
}

// ── Record tool compositor ──────────────────────────────────────────────────
// The export path for the `record` tool: a fully-editable INTRO card → the recorded
// camera CLIP → a fully-editable OUTRO card, composited onto ONE canvas in real time.
// Unlike renderTopTail (which fades each card as a single unit), every object animates
// in with its OWN transition (fade / pop / slide / rise / zoom / tilt / …), staggered
// by a per-object delay — and objects on the middle (camera) frame ride over the
// footage as overlays (lower-third, logo bug), entering at the head and leaving at the
// tail. Detected via [data-record-stage].

// The transition vocabulary + its maths live in ../lib/transitions.ts so the timeline
// editing chrome can offer exactly the kinds this compositor implements.

interface RecObject { bmp: HTMLCanvasElement | null; x: number; y: number; w: number; h: number; rot: number; transition: string; delay: number }

async function renderRecord(node: Element, opts: ExportOpts, preferred: string): Promise<Blob> {
  const stage = ((node as HTMLElement).matches?.('[data-record-stage]')
    ? node
    : node.querySelector('[data-record-stage]')) as HTMLElement | null;
  if (!stage) return renderVideo(node, opts, preferred);

  const introEl = stage.querySelector('[data-record-frame="intro"]') as HTMLElement | null;
  const bodyEl  = stage.querySelector('[data-record-frame="body"]')  as HTMLElement | null;
  const outroEl = stage.querySelector('[data-record-frame="outro"]') as HTMLElement | null;
  if (!introEl || !bodyEl || !outroEl) return renderVideo(node, opts, preferred);

  const mimeType = videoMimeType(preferred, { audio: true }) ?? videoMimeType(preferred);
  if (!mimeType) throw new Error(NO_VIDEO_MSG);

  const introMs = ttNum(stage.dataset.introMs, 2200);
  const outroMs = ttNum(stage.dataset.outroMs, 2400);
  const enterMs = Math.max(120, ttNum(stage.dataset.enterMs, 650));
  const fps = 30;
  const frameMs = 1000 / fps;
  const EDGE_FADE = 260; // ms fade-from/to-black at the very ends

  // Output size: the FRAME's native (layout) size — transform-independent, so pan/zoom
  // in the editor never affects it — optionally scaled up by an explicit export width.
  const frameNativeW = introEl.offsetWidth || 1080;
  const frameNativeH = introEl.offsetHeight || 1920;
  const targetW = Math.round(((opts.width as number) > 0) ? (opts.width as number) : frameNativeW);
  const S = targetW / frameNativeW;
  const targetH = Math.round(frameNativeH * S);

  const introBg = introEl.style.background || getComputedStyle(introEl).backgroundColor || '#0c322c';
  const outroBg = outroEl.style.background || getComputedStyle(outroEl).backgroundColor || '#0c322c';

  // The recorded take (or a dropped clip) lives in the middle frame as [data-record-clip].
  const bodyVideo = bodyEl.querySelector('[data-record-clip]') as HTMLVideoElement | null;
  const clipSrc = bodyVideo && (bodyVideo.currentSrc || bodyVideo.getAttribute('src')) || '';

  // Rasterise each object ONCE, unrotated, at target scale — rotation + transition are
  // applied per frame at composite time. Blob: image URLs are swapped to data: first so
  // dom-to-image can serialise them, then restored.
  const lib = await getDomToImage();
  const rasterBox = async (el: HTMLElement): Promise<HTMLCanvasElement | null> => {
    const bw = Math.max(1, parseFloat(el.style.width) || 1);
    const bh = Math.max(1, parseFloat(el.style.height) || 1);
    try {
      return await lib.toCanvas(el, {
        width: Math.max(1, Math.round(bw * S)), height: Math.max(1, Math.round(bh * S)),
        style: { transform: `scale(${S})`, transformOrigin: 'top left', width: `${bw}px`, height: `${bh}px`, left: '0', top: '0', margin: '0' },
      });
    } catch { return null; }
  };
  const collect = async (frameEl: HTMLElement): Promise<RecObject[]> => {
    const els = [...frameEl.querySelectorAll<HTMLElement>('.lolly-box')];
    const out: RecObject[] = [];
    for (const el of els) {
      const x = (parseFloat(el.style.left) || 0) * S;
      const y = (parseFloat(el.style.top) || 0) * S;
      const w = (parseFloat(el.style.width) || 1) * S;
      const h = (parseFloat(el.style.height) || 1) * S;
      const rot = ((): number => { const m = /rotate\(([-\d.]+)deg\)/.exec(el.style.transform || ''); return m ? parseFloat(m[1]!) : 0; })();
      out.push({
        bmp: await rasterBox(el), x, y, w, h, rot,
        transition: el.dataset.transition || 'fade',
        delay: Math.max(0, ttNum(el.dataset.delay, 0)),
      });
    }
    return out;
  };
  const restore = await swapBlobUrls(stage);
  let introObjs: RecObject[] = [], bodyObjs: RecObject[] = [], outroObjs: RecObject[] = [];
  try {
    introObjs = await collect(introEl);
    bodyObjs  = await collect(bodyEl);
    outroObjs = await collect(outroEl);
  } finally { restore(); }

  // A dedicated, UN-muted playback of the footage so its audio flows into the mix.
  const play = clipSrc ? document.createElement('video') : null;
  if (play) {
    play.src = clipSrc; play.muted = false; play.playsInline = true; play.preload = 'auto';
    await new Promise<void>((res) => {
      if (play.readyState >= 1) return res();
      play.onloadedmetadata = () => res();
      play.onerror = () => res();
    });
    if (!Number.isFinite(play.duration) || play.duration === 0) {
      await new Promise<void>((res) => {
        const to = setTimeout(res, 1500);
        play.ontimeupdate = () => {
          if (Number.isFinite(play.duration)) { clearTimeout(to); play.ontimeupdate = null; play.currentTime = 0; res(); }
        };
        try { play.currentTime = 1e7; } catch { clearTimeout(to); res(); }
      });
    }
  }
  const TT_MAX_BODY_MS = 120000;
  let durSec = play && Number.isFinite(play.duration) && play.duration > 0 ? play.duration : 0;
  // A clip was recorded but its duration never resolved (a MediaRecorder WebM/MP4 blob
  // can report duration=Infinity/0 across engines). Rather than DROP the body entirely
  // (which would export just the bookends), keep the footage on screen. Prefer the
  // MEASURED take length the recorder stamped on the element (data-clip-ms) — otherwise a
  // long take would be silently truncated to the blind 6s guess — falling back to 6s only
  // when that hint is absent (a dropped-in clip, or the manual Export button).
  if (play && durSec === 0) {
    const hintMs = Number(bodyVideo?.dataset.clipMs);
    const hinted = Number.isFinite(hintMs) && hintMs > 0;
    durSec = hinted ? hintMs / 1000 : 6;
    _host?.log?.('warn', `record: clip duration unresolved — using ${hinted ? `the measured ${Math.round(hintMs)}ms take` : 'a 6s fallback'} for the body.`);
  }
  const bodyMs = Math.min(durSec * 1000, TT_MAX_BODY_MS);
  const totalMs = introMs + bodyMs + outroMs;

  // Prime playback under the caller's user-activation. autoProcessRecording runs this
  // right after the Stop click, but the deferred body-phase play() only fires after a
  // multi-second decode/compositor await that can outlast the activation — a blocked
  // play() would then freeze the footage on frame 0. Playing once now blesses the element
  // so that later play() resumes without a fresh gesture. We keep it UNMUTED (muted is the
  // property the autoplay policy checks, so a muted prime wouldn't grant unmuted resume on
  // stricter engines) but at volume 0 — no audible blip — and restore volume BEFORE
  // captureStream taps the audio below. Best-effort: if autoplay is refused the loop still
  // retries per frame.
  if (play) {
    try { play.volume = 0; await play.play(); play.pause(); play.currentTime = 0; } catch { /* autoplay blocked */ }
    play.volume = 1;
  }

  // Footage audio via the clip element's OWN capture stream — NO WebAudio graph, so no
  // suspended-context / manual-frame-video mux fragility (a resumed AudioContext dest
  // track combined with a requestFrame() video track was producing 0-byte MP4s).
  // captureStream() is non-destructive (unlike createMediaElementSource), silent while
  // `play` is paused (intro/outro) and audible during the body. Fully NON-FATAL: if it's
  // unavailable the video still records, just silently.
  let clipAudioTrack: MediaStreamTrack | null = null;
  if (play) {
    try {
      const el = play as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
      const capture = el.captureStream ?? el.mozCaptureStream;
      clipAudioTrack = capture ? (capture.call(play).getAudioTracks()[0] ?? null) : null;
    } catch { clipAudioTrack = null; }
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetW; canvas.height = targetH;
  const ctx = canvas.getContext('2d')!;
  const { stream, deliver } = manualCaptureStream(canvas, fps);
  if (clipAudioTrack) { try { stream.addTrack(clipAudioTrack); } catch { /* ignore */ } }

  const container = videoContainer(mimeType);
  const recorder = new MediaRecorder(stream, recorderOpts(mimeType, targetW, targetH, fps, !!clipAudioTrack));
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  const fill = (color: string) => { ctx.fillStyle = color; ctx.fillRect(0, 0, targetW, targetH); };
  // Clip fit (data-clip-fit): 'cover' fills the frame (crop); 'contain' fits the whole
  // clip. Default cover. The body phase already fills '#000' before drawCover, so a
  // contained clip letterboxes onto that without any extra fill here.
  const fitContain = stage.dataset.clipFit === 'contain';
  const drawCover = (v: HTMLVideoElement) => {
    const vw = v.videoWidth || targetW, vh = v.videoHeight || targetH;
    const scale = fitContain ? Math.min(targetW / vw, targetH / vh) : Math.max(targetW / vw, targetH / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.drawImage(v, (targetW - dw) / 2, (targetH - dh) / 2, dw, dh);
  };
  const drawObject = (o: RecObject, p: number): void => {
    if (!o.bmp) return;
    const tr = recTransition(o.transition, p, o.w, o.h);
    if (tr.alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, tr.alpha));
    ctx.translate(o.x + o.w / 2 + tr.dx, o.y + o.h / 2 + tr.dy);
    if (o.rot || tr.rot) ctx.rotate((o.rot + tr.rot) * Math.PI / 180);
    if (tr.sc !== 1) ctx.scale(tr.sc, tr.sc);
    ctx.drawImage(o.bmp, -o.w / 2, -o.h / 2, o.w, o.h);
    ctx.restore();
  };
  // Intro/outro objects: enter (staggered by delay) then hold for the rest of the phase.
  const drawEntering = (objs: RecObject[], phaseMs: number) => {
    for (const o of objs) drawObject(o, Math.min(1, Math.max(0, (phaseMs - o.delay) / enterMs)));
  };
  // Body overlays: enter at the head, hold, exit near the tail (symmetric — leaves the
  // same way it arrived) so lower-thirds/logo bugs come and go over the footage.
  const drawOverlays = (objs: RecObject[], bodyLocal: number) => {
    const tailStart = bodyMs - enterMs;
    for (const o of objs) {
      const headP = Math.min(1, Math.max(0, (bodyLocal - o.delay) / enterMs));
      const exitP = bodyLocal > tailStart ? Math.min(1, Math.max(0, (bodyLocal - tailStart) / enterMs)) : 0;
      drawObject(o, Math.min(headP, 1 - exitP));
    }
  };

  _host?.log?.('info', `record: compositing intro=${introMs} body=${Math.round(bodyMs)} outro=${outroMs} total=${Math.round(totalMs)} clip=${clipSrc ? 'yes' : 'no'} audio=${clipAudioTrack ? 'yes' : 'no'} objs=${introObjs.length}/${bodyObjs.length}/${outroObjs.length} size=${targetW}x${targetH}`);

  return new Promise<Blob>((resolve, reject) => {
    const cleanup = () => {
      try { stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
      try { play?.pause(); } catch { /* ignore */ }
      try { clipAudioTrack?.stop(); } catch { /* ignore */ }
    };
    recorder.onerror = e => { cleanup(); reject((e as { error?: Error }).error ?? new Error('MediaRecorder error')); };
    recorder.onstop = () => {
      cleanup();
      const bytes = chunks.reduce((n, c) => n + c.size, 0);
      _host?.log?.(bytes > 0 ? 'info' : 'warn', `record: encoded ${chunks.length} chunk(s), ${bytes} bytes`);
      resolve(withVideoMeta(new Blob(chunks, { type: container }), container, opts.meta));
    };

    let startT = 0;
    let bodyStarted = false;
    let lastFrame = -Infinity;
    const frame = (now: number): void => {
      if (!startT) startT = now;
      const el = now - startT;
      if (el >= totalMs) { try { recorder.stop(); } catch { /* already stopping */ } return; }

      // Composite + hand off one frame per fps tick (wall-clock paced): live footage
      // is sampled at exactly fps and each painted frame is encoded once.
      if (now - lastFrame >= frameMs) {
        lastFrame = now;
        if (el < introMs) {
          fill(introBg);
          drawEntering(introObjs, el);
        } else if (el < introMs + bodyMs) {
          fill('#000');
          if (play && play.readyState >= 2 && !play.ended) {
            if (!bodyStarted) { bodyStarted = true; try { play.currentTime = 0; } catch { /* ignore */ } play.play().catch(() => {}); }
            drawCover(play);
          } else if (play && !bodyStarted) {
            bodyStarted = true; try { play.currentTime = 0; } catch { /* ignore */ } play.play().catch(() => {});
          }
          drawOverlays(bodyObjs, el - introMs);
        } else {
          fill(outroBg);
          drawEntering(outroObjs, el - introMs - bodyMs);
        }

        // Global fade from/to black at the very ends.
        if (el < EDGE_FADE) { ctx.globalAlpha = 1 - el / EDGE_FADE; fill('#000'); ctx.globalAlpha = 1; }
        else if (totalMs - el < EDGE_FADE) { ctx.globalAlpha = 1 - (totalMs - el) / EDGE_FADE; fill('#000'); ctx.globalAlpha = 1; }

        deliver();
      }

      requestAnimationFrame(frame);
    };

    recorder.start();
    requestAnimationFrame(frame);
  });
}

function recordStream(stream: MediaStream, { durationMs = 5000, mimeType = videoMimeType(), audio = null, meta = null, width = 1080, height = 1080, fps = 30 }: { durationMs?: number; mimeType?: string | null; audio?: LoopedAudio | null; meta?: ExportMeta | null; width?: number; height?: number; fps?: number } = {}): Promise<Blob> {
  if (!mimeType) { audio?.stop(); throw new Error(NO_VIDEO_MSG); }
  if (audio) stream.addTrack(audio.track);
  const recorder = new MediaRecorder(stream, recorderOpts(mimeType, width, height, fps, !!audio));
  const chunks: Blob[]   = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  return new Promise<Blob>((resolve, reject) => {
    recorder.onerror = e => { audio?.stop(); reject((e as any).error ?? new Error('MediaRecorder error')); };
    recorder.onstop  = () => {
      audio?.stop();
      const container = videoContainer(mimeType);
      resolve(withVideoMeta(new Blob(chunks, { type: container }), container, meta));
    };
    recorder.start();
    audio?.start();
    setTimeout(() => recorder.stop(), durationMs);
  });
}

// Renders the DOM node as an animated GIF.
//
// Each frame is rendered sequentially via toCanvas() so every GIF frame
// captures a unique animation state — no duplicate or stale frames.
// Recording takes longer than real-time on slow machines, but the output
// plays back at the intended speed because timing is in the GIF delay metadata.
//
// opts.wait     — seconds before capture starts (default 1)
// opts.duration — clip length in seconds (default 5)
// opts.dither   — Floyd-Steinberg dithering (default false)
async function renderGif(node: Element, opts: ExportOpts): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc') as any;

  const fps           = 15;
  const frameInterval = Math.round(1000 / fps); // 67ms → rounds to 70ms in GIF centiseconds
  const durationMs    = (opts.duration ?? 5) * 1000;
  let   frameCount    = Math.max(1, Math.round(durationMs / frameInterval));
  const dither        = Boolean(opts.dither);

  // Same memory ceiling as renderVideo: duration is URL-bypassable and the GIF
  // encoder buffers every written frame, so clamp to bound memory + warn through
  // the log channel. Generous for normal clips; beyond it the clip is truncated.
  const cap = maxVideoFrames();
  if (frameCount > cap) {
    _host?.log?.('warn', `GIF capped at ${cap} frames (requested ${frameCount}); lower the duration for a longer clip.`);
    frameCount = cap;
  }

  // Shared FrameSource: same sequential, real-time capture as the video path.
  const source  = await createFrameSource(node, opts);
  const targetW = source.width, targetH = source.height;

  const offscreen = document.createElement('canvas');
  offscreen.width  = targetW;
  offscreen.height = targetH;
  const offCtx = offscreen.getContext('2d')!;

  try {
    const gif = GIFEncoder();
    let palette: [number, number, number][] | null = null;

    // Dither scratch buffers are allocated ONCE and reused for every frame: the
    // global palette is fixed after frame 0, so the per-frame ~14MB error buffer
    // and the 64KB nearest-colour cache (previously re-allocated and re-cleared each
    // frame) can persist for the whole clip. The cache stays valid because the
    // palette never changes; output is byte-identical to per-frame allocation.
    const ditherState = dither ? createDitherState(targetW, targetH) : null;

    const repeat = opts.repeat != null ? opts.repeat : 0;
    for (let i = 0; i < frameCount; i++) {
      const canvas = await source.frame(i / frameCount);
      offCtx.clearRect(0, 0, targetW, targetH);
      offCtx.drawImage(canvas, 0, 0, targetW, targetH);
      const pixels = offCtx.getImageData(0, 0, targetW, targetH).data;

      if (dither) {
        // Dithering already hides banding, and its reused error/nearest-colour buffers
        // require a STABLE palette — so this path keeps one global palette, built from
        // frame 0 and reused for the whole clip.
        if (i === 0) palette = quantize(pixels, 256);
        const indexed = ditherFloydSteinberg(pixels, targetW, targetH, palette!, ditherState!);
        gif.writeFrame(indexed, targetW, targetH, i === 0 ? { palette, delay: frameInterval, repeat } : { delay: frameInterval });
      } else {
        // No dithering: give EACH frame its own optimal 256-colour table (a local
        // palette) rather than forcing every frame through frame 0's colours. A clip
        // whose palette evolves — fades, colour shifts, live footage — no longer bands
        // back to the first frame. Costs one quantize per frame and a little more size.
        const framePalette = quantize(pixels, 256);
        const indexed = applyPalette(pixels, framePalette);
        gif.writeFrame(indexed, targetW, targetH, i === 0 ? { palette: framePalette, delay: frameInterval, repeat } : { palette: framePalette, delay: frameInterval });
      }
      // Progress for a slow N-frame render (no-op when no listener is wired).
      opts.onProgress?.(i + 1, frameCount);
    }

    gif.finish();
    let bytes = gif.bytesView();
    if (opts.meta) {
      const credit = [opts.meta.description, opts.meta.contact, opts.meta.source].filter(Boolean).join(' · ');
      bytes = withGifComment(bytes, credit);
    }
    return new Blob([bytes], { type: 'image/gif' });
  } finally {
    source.dispose();
  }
}

// Renders the DOM node as an Animated PNG.
//
// Same capture loop as renderGif (shared FrameSource, sequential real-time
// frames, timing lives in the fcTL delay metadata), but each frame stays a
// full-fidelity PNG — no palette quantisation — and the engine's packApng
// splices the encoded frames into one APNG at the chunk level.
//
// opts.wait     — seconds before capture starts (default 1)
// opts.duration — clip length in seconds (default 5)
// opts.repeat   — loop count: -1 = play once, 0/absent = forever (GIF semantics)
async function renderApng(node: Element, opts: ExportOpts): Promise<Blob> {
  // 15 fps by default; a caller can lower it (opts.fps) to shrink an APNG preview —
  // fewer frames, smaller file — at the cost of smoothness. Clamped to a sane range.
  const fps           = Math.min(30, Math.max(2, Math.round(opts.fps ?? 15)));
  const frameInterval = Math.round(1000 / fps);
  const durationMs    = (opts.duration ?? 5) * 1000;
  let   frameCount    = Math.max(1, Math.round(durationMs / frameInterval));

  // Same memory ceiling as renderVideo: duration is URL-bypassable and every
  // frame is buffered as an encoded PNG in frames[], so clamp to bound memory +
  // warn through the log channel. Generous for normal clips; beyond it truncated.
  const cap = maxVideoFrames();
  if (frameCount > cap) {
    _host?.log?.('warn', `APNG capped at ${cap} frames (requested ${frameCount}); lower the duration for a longer clip.`);
    frameCount = cap;
  }

  // Shared FrameSource: same sequential, real-time capture as the video path.
  const source  = await createFrameSource(node, opts);
  const targetW = source.width, targetH = source.height;

  // toCanvas() may return a DPR-scaled canvas; normalise every frame to the
  // target size so all encoded PNGs share identical IHDR geometry (packApng
  // rejects mismatched frames).
  const offscreen = document.createElement('canvas');
  offscreen.width  = targetW;
  offscreen.height = targetH;
  const offCtx = offscreen.getContext('2d')!;

  const frames: Uint8Array[] = [];
  try {
    for (let i = 0; i < frameCount; i++) {
      const canvas = await source.frame(i / frameCount);
      offCtx.clearRect(0, 0, targetW, targetH);
      offCtx.drawImage(canvas, 0, 0, targetW, targetH);
      const blob = await new Promise<Blob>((res, rej) =>
        offscreen.toBlob(b => b ? res(b) : rej(new Error('APNG frame encode failed')), 'image/png'));
      frames.push(new Uint8Array(await blob.arrayBuffer()));
      // Progress for a slow N-frame render (no-op when no listener is wired).
      opts.onProgress?.(i + 1, frameCount);
    }
  } finally {
    source.dispose();
  }

  // GIF repeat → APNG num_plays: -1 (play once) → 1; 0/absent stays 0 (infinite).
  let bytes = packApng(frames, {
    delayMs: frameInterval,
    loops: opts.repeat === -1 ? 1 : (opts.repeat ?? 0),
  });

  // Stamp DPI + provenance + colour profile exactly as the static PNG path does —
  // all three helpers splice right after IHDR, which the APNG spec allows (acTL
  // only has to precede the first IDAT, not follow IHDR directly).
  const d = exportDims(node, opts);
  const icc = iccWanted(opts) ? iccProfileBytes(opts.colorProfile) : null;
  if (d.dpi > 0) bytes = insertPngPhys(bytes, d.dpi) || bytes;
  bytes = insertPngMeta(bytes, opts.meta);
  if (icc) bytes = await insertPngIcc(bytes, icc);
  return new Blob([bytes as BlobPart], { type: 'image/png' });
}

// Renders the DOM node as an Animated WebP.
//
// Same capture loop as renderGif/renderApng (shared FrameSource, sequential
// real-time frames, timing in the ANMF duration field), but each frame is a
// still WebP from the browser's native canvas.toBlob('image/webp') encoder, and
// the engine's packWebpAnim muxes the extracted VP8/VP8L(+ALPH) bitstreams into
// one animated RIFF/WEBP — full colour + alpha, smaller than GIF or APNG, and no
// new dependency (the browser compresses, the engine assembles the container).
//
// opts.wait     — seconds before capture starts (default 1)
// opts.duration — clip length in seconds (default 5)
// opts.fps      — frames/sec (default 15, clamped 2..30, matches renderApng)
// opts.quality  — per-frame WebP quality 0..1 (default 0.9, matches renderBitmap)
// opts.repeat   — loop count: -1 = play once, 0/absent = forever (GIF semantics)
async function renderWebpAnim(node: Element, opts: ExportOpts): Promise<Blob> {
  const fps           = Math.min(30, Math.max(2, Math.round(opts.fps ?? 15)));
  const frameInterval = Math.round(1000 / fps);
  const durationMs    = (opts.duration ?? 5) * 1000;
  let   frameCount    = Math.max(1, Math.round(durationMs / frameInterval));

  const cap = maxVideoFrames();
  if (frameCount > cap) {
    _host?.log?.('warn', `Animated WebP capped at ${cap} frames (requested ${frameCount}); lower the duration for a longer clip.`);
    frameCount = cap;
  }

  const source  = await createFrameSource(node, opts);
  const targetW = source.width, targetH = source.height;

  // Normalise every frame to the target size so all encoded WebPs share geometry.
  const offscreen = document.createElement('canvas');
  offscreen.width  = targetW;
  offscreen.height = targetH;
  const offCtx = offscreen.getContext('2d')!;
  const quality = opts.quality ?? 0.9;

  const frames: Uint8Array[] = [];
  try {
    for (let i = 0; i < frameCount; i++) {
      const canvas = await source.frame(i / frameCount);
      offCtx.clearRect(0, 0, targetW, targetH);
      offCtx.drawImage(canvas, 0, 0, targetW, targetH);
      const blob = await new Promise<Blob>((res, rej) =>
        offscreen.toBlob(b => b ? res(b) : rej(new Error('WebP frame encode failed')), 'image/webp', quality));
      // A browser without WebP canvas encoding silently yields image/png here.
      if (!/webp/.test(blob.type)) throw new Error('This browser cannot encode WebP; export as GIF or APNG instead.');
      frames.push(new Uint8Array(await blob.arrayBuffer()));
      opts.onProgress?.(i + 1, frameCount);
    }
  } finally {
    source.dispose();
  }

  // GIF repeat → WebP loop_count: -1 (play once) → 1; 0/absent stays 0 (infinite).
  const bytes = packWebpAnim(frames, {
    width: targetW, height: targetH,
    delayMs: frameInterval,
    loops: opts.repeat === -1 ? 1 : (opts.repeat ?? 0),
  });
  return new Blob([bytes as BlobPart], { type: 'image/webp' });
}

// Each animated-SVG frame is a FULL vector snapshot (heavier than a raster frame and
// stacked verbatim in the file), so default to a lower rate and cap well below the
// raster ceiling — a flipbook is meant to stay scalable and self-contained, not to
// rival a 30fps video.
const MAX_SVG_ANIM_FRAMES = 150;

// Renders the DOM node as a self-contained animated SVG (a vector "flipbook").
//
// Unlike gif/apng/webp-anim (which sample the canvas to RASTER frames), this samples
// each moment to a VECTOR snapshot via renderSvgFromHtml — text stays outlined, so the
// result scales to any size with no codec and no external runtime. The snapshots are
// stacked as <g> layers and an embedded step-end @keyframes cross-cuts exactly one
// visible per slice (svg-anim-core assembleAnimatedSvg). Capture semantics match the
// raster animated path: settle once, then walk sequentially — the real-time animation
// advances between the (slow) walks, so every frame is a distinct moment; playback
// timing lives in the flipbook CSS, not in when we happened to capture.
//
// opts.fps      — frames/sec (default 10, clamped 2..24; lower than raster on purpose)
// opts.duration — clip length in seconds (default 5)
// opts.repeat   — loop count: -1 = play once, 0/absent = forever (GIF semantics)
async function renderSvgAnim(node: Element, opts: ExportOpts): Promise<Blob> {
  const fps           = Math.min(24, Math.max(2, Math.round(opts.fps ?? 10)));
  const frameInterval = Math.round(1000 / fps);
  const durationMs    = (opts.duration ?? 5) * 1000;
  let   frameCount    = Math.max(1, Math.round(durationMs / frameInterval));

  if (frameCount > MAX_SVG_ANIM_FRAMES) {
    _host?.log?.('warn', `Animated SVG capped at ${MAX_SVG_ANIM_FRAMES} frames (requested ${frameCount}); lower the duration or frame rate.`);
    frameCount = MAX_SVG_ANIM_FRAMES;
  }

  // Let CSS animations settle once before the first snapshot (mirrors createFrameSource).
  await new Promise<void>(r => setTimeout(r, (opts.wait ?? 1) * 1000));

  // Per-frame snapshot opts: keep the caller's convert-paths choice (vector text by
  // default) but never let the still-SVG metadata be injected per frame — provenance
  // is added ONCE at assembly.
  const frameOpts: ExportOpts = { ...opts, meta: undefined, onProgress: undefined };
  const ser = new XMLSerializer();
  const frames: string[] = [];
  let widthAttr = '', heightAttr = '', viewBox = '';

  for (let i = 0; i < frameCount; i++) {
    const xml = await (await renderSvgFromHtml(node, frameOpts)).text();
    const svg = new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement;
    if (i === 0) {
      widthAttr  = svg.getAttribute('width')  || '';
      heightAttr = svg.getAttribute('height') || '';
      viewBox    = svg.getAttribute('viewBox') || `0 0 ${widthAttr} ${heightAttr}`;
    }
    let inner = '';
    for (const child of Array.from(svg.childNodes)) inner += ser.serializeToString(child);
    frames.push(inner);
    opts.onProgress?.(i + 1, frameCount);
  }

  const svg = assembleAnimatedSvg({
    frames, widthAttr, heightAttr, viewBox,
    frameMs: frameInterval,
    loops: opts.repeat === -1 ? 1 : (opts.repeat ?? 0),
    meta: opts.meta ? { description: opts.meta.description, source: opts.meta.source, contact: opts.meta.contact } : null,
  });
  return new Blob([svg], { type: 'image/svg+xml' });
}

interface DitherState { out: Uint8Array; buf: Float32Array; cache: Int16Array; }

// Allocates the reusable scratch buffers for the Floyd-Steinberg path. Hoisted out
// of ditherFloydSteinberg so an animated GIF can keep ONE set of buffers across all
// frames: the error buffer is re-seeded from each frame's pixels, and the nearest
// -colour cache is carried over (the palette is fixed after frame 0, so cached
// lookups stay correct). `out` is fully overwritten every frame, so no reset needed.
function createDitherState(width: number, height: number): DitherState {
  const n = width * height;
  return {
    out:   new Uint8Array(n),
    buf:   new Float32Array(n * 3),       // diffused error, may exceed [0,255]
    cache: new Int16Array(32768).fill(-1), // 15-bit (5 bits/channel) nearest cache
  };
}

// Floyd-Steinberg ordered dithering.
// Quantizes pixels to the given palette while propagating quantisation error
// to neighbouring pixels to reduce colour banding. Returns a Uint8Array of
// palette indices, matching the layout expected by gifenc's writeFrame().
//
// Cache note: nearest-palette lookups are memoised by a 15-bit colour key
// (5 bits per channel). This trades a tiny amount of precision for a large
// speed improvement — especially effective for flat-colour brand graphics.
//
// `state` (from createDitherState) lets a multi-frame caller reuse the buffers
// across frames; absent, a fresh set is allocated for this single call.
function ditherFloydSteinberg(data: Uint8ClampedArray, width: number, height: number, palette: [number, number, number][], state?: DitherState | null): Uint8Array {
  const n   = width * height;
  const st  = state ?? createDitherState(width, height);
  const out = st.out;

  // Float RGB buffer — accumulates diffused error beyond [0,255]. Re-seeded from
  // this frame's pixels (so a reused buffer carries no error from the prior frame).
  const buf = st.buf;
  for (let i = 0; i < n; i++) {
    buf[i * 3]     = data[i * 4]!;
    buf[i * 3 + 1] = data[i * 4 + 1]!;
    buf[i * 3 + 2] = data[i * 4 + 2]!;
  }

  // Nearest-palette memoisation keyed on a 5-bit-per-channel approximation.
  // Persisted across frames via `state` — valid because the palette is fixed.
  const cache = st.cache;
  function nearest(r: number, g: number, b: number): number {
    const key = (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
    if (cache[key]! >= 0) return cache[key]!;
    let best = 0, bestD = Infinity;
    for (let c = 0; c < palette.length; c++) {
      const pc = palette[c]!;
      const d  = (r - pc[0]) ** 2 + (g - pc[1]) ** 2 + (b - pc[2]) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return (cache[key] = best);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 3;

      const r = Math.round(Math.max(0, Math.min(255, buf[p]!)));
      const g = Math.round(Math.max(0, Math.min(255, buf[p + 1]!)));
      const b = Math.round(Math.max(0, Math.min(255, buf[p + 2]!)));

      const idx    = nearest(r, g, b);
      out[i]       = idx;

      const pc = palette[idx]!;
      const er = r - pc[0];
      const eg = g - pc[1];
      const eb = b - pc[2];

      // Diffuse error: right=7/16, bottom-left=3/16, bottom=5/16, bottom-right=1/16
      if (x + 1 < width) {
        const q = p + 3;
        buf[q] = buf[q]! + er * 0.4375; buf[q+1] = buf[q+1]! + eg * 0.4375; buf[q+2] = buf[q+2]! + eb * 0.4375;
      }
      if (y + 1 < height) {
        if (x > 0) {
          const q = p + width * 3 - 3;
          buf[q] = buf[q]! + er * 0.1875; buf[q+1] = buf[q+1]! + eg * 0.1875; buf[q+2] = buf[q+2]! + eb * 0.1875;
        }
        const q0 = p + width * 3;
        buf[q0] = buf[q0]! + er * 0.3125; buf[q0+1] = buf[q0+1]! + eg * 0.3125; buf[q0+2] = buf[q0+2]! + eb * 0.3125;
        if (x + 1 < width) {
          const q1 = p + width * 3 + 3;
          buf[q1] = buf[q1]! + er * 0.0625; buf[q1+1] = buf[q1+1]! + eg * 0.0625; buf[q1+2] = buf[q1+2]! + eb * 0.0625;
        }
      }
    }
  }

  return out;
}

// Injects a watermark stamp directly on the live node and returns a cleanup fn.
// Using a live overlay (not a detached clone) keeps getComputedStyle working,
// which is required by dom-to-image-more and captureStream-based video capture.
function addWatermarkOverlay(node: HTMLElement): () => void {
  const stamp = document.createElement('div');
  stamp.textContent = 'EXPERIMENTAL — NOT BRAND APPROVED';
  Object.assign(stamp.style, {
    position: 'absolute',
    bottom: '8px',
    right: '8px',
    padding: '4px 8px',
    background: 'rgba(255, 255, 255, 0.85)',
    color: '#c0392b',
    font: 'bold 10px monospace',
    border: '1px solid #c0392b',
    pointerEvents: 'none',
    zIndex: '9999',
  });
  const prevPosition = node.style.position;
  if (!node.style.position) node.style.position = 'relative';
  node.appendChild(stamp);
  return () => {
    stamp.remove();
    node.style.position = prevPosition;
  };
}

// Editor-only chrome (size previews, guides, safe-area overlays) opts out of EVERY
// export by tagging itself [data-export-hide]. We detach those nodes for the
// duration of the render and put them back exactly where they were — so no export
// path (raster, SVG, PDF, …) can pick them up regardless of how it reads the DOM,
// and the live editor is untouched afterwards. Mirrors the watermark overlay's
// add/remove-in-finally discipline above.
function detachExportHidden(node: Element): () => void {
  if (!node?.querySelectorAll) return () => {};
  const marked = [...node.querySelectorAll('[data-export-hide]')]
    // Keep only the outermost when nested, so each re-insertion parent still exists.
    .filter(el => !el.parentElement?.closest('[data-export-hide]'));
  const slots = marked.map(el => ({ el, parent: el.parentNode, next: el.nextSibling }));
  slots.forEach(({ el }) => el.remove());
  return () => slots.forEach(({ el, parent, next }) => { if (parent) (parent as any).insertBefore(el, next); });
}

// ── Text-based export formats ─────────────────────────────────────────────────

// Standalone HTML document with the tool's template CSS and baked-in content.
// The fitting script is stripped — the computed font-size is already on the element.
//
// opts.fullPage drops the fixed-size tool-canvas frame: the canvas div is the
// shell's preview box, so we promote its content straight into the document body
// and let it fill the whole page (no centring, no neutral backdrop). The default
// keeps the canvas as a centred, fixed-size card on a grey backdrop.
function renderStaticHtml(node: Element, opts: ExportOpts = {}): Blob {
  const styles = [...node.querySelectorAll('style')].map(s => s.textContent).join('\n');
  const clone = node.cloneNode(true) as Element;
  clone.querySelectorAll('style, script').forEach(el => el.remove());
  // Full-page: give html/body a definite full-viewport height so a promoted root
  // that sizes itself to height:100% (e.g. bag-video's .scene) resolves against the
  // viewport instead of collapsing to zero (which rendered a blank white page);
  // min-height keeps taller, flowing content able to extend the page.
  const modeCss = opts.fullPage
    ? `html, body { height: 100%; }\nbody { min-height: 100dvh; }`
    : `body { display: flex; align-items: center; justify-content: center; min-height: 100dvh; background: #555; padding: 16px; }`;
  const content = opts.fullPage ? clone.innerHTML : clone.outerHTML;
  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
${modeCss}
${styles}
</style>
</head>
<body>
${content}
</body>
</html>`;
  return new Blob([doc], { type: 'text/html' });
}

interface DomHandlers {
  text: (t: string) => string;
  br?: () => string;
  element?: (tag: string, inner: string, node: Element) => string;
}

// Recursive DOM walker shared by markdown and plain-text exports.
// Skips aria-hidden elements, <style>, <script>, and <img>.
function walkDom(node: Node, handlers: DomHandlers): string {
  if (node.nodeType === 3) return handlers.text(node.textContent as string);
  if (node.nodeType !== 1) return '';
  const elNode = node as Element;
  if (elNode.getAttribute('aria-hidden') === 'true') return '';
  const tag = elNode.tagName.toLowerCase();
  if (tag === 'style' || tag === 'script' || tag === 'img') return '';
  if (tag === 'br') return handlers.br?.() ?? '\n';
  const inner = [...node.childNodes].map(n => walkDom(n, handlers)).join('');
  return handlers.element?.(tag, inner, elNode) ?? inner;
}

// ── HTML DOM → Markdown ───────────────────────────────────────────────────────
// A structural serializer (headings, nested lists, GFM tables, code, blockquote,
// hr, links, emphasis) so ANY text tool that declares the `md` format gets a
// faithful markdown export from its rendered DOM — no per-tool serializer needed.
// (Tools wanting model-derived, CLI-working output ship a template.md instead.)
const mdSkip = (el: Element): boolean =>
  el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('data-export-hide');
function mdFenceFor(code: string): string {
  let longest = 0, run = 0;
  for (const ch of code) { if (ch === '`') { if (++run > longest) longest = run; } else run = 0; }
  return '`'.repeat(Math.max(3, longest + 1));
}
/** Inline serialization: text + emphasis + code + links. */
function mdInlineDom(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (mdSkip(el)) return '';
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return '  \n';
  if (tag === 'style' || tag === 'script' || tag === 'img') return '';
  const inner = [...el.childNodes].map(mdInlineDom).join('');
  switch (tag) {
    case 'strong': case 'b': return inner.trim() ? `**${inner}**` : '';
    case 'em': case 'i': return inner.trim() ? `*${inner}*` : '';
    case 'del': case 's': return inner.trim() ? `~~${inner}~~` : '';
    case 'code': return inner ? '`' + inner + '`' : '';
    case 'a': { const h = el.getAttribute('href'); return h && /^(https?:|mailto:|#|\/)/i.test(h) ? `[${inner}](${h})` : inner; }
    default: return inner;
  }
}
function mdListDom(el: Element, ordered: boolean, depth: number): string {
  const indent = '  '.repeat(depth);
  let out = '', n = 0;
  for (const li of [...el.children]) {
    if (li.tagName.toLowerCase() !== 'li' || mdSkip(li)) continue;
    n++;
    let lead = '', nested = '';
    for (const c of [...li.childNodes]) {
      const ct = c.nodeType === 1 ? (c as Element).tagName.toLowerCase() : '';
      if (ct === 'ul' || ct === 'ol') nested += mdListDom(c as Element, ct === 'ol', depth + 1);
      else lead += mdInlineDom(c);
    }
    out += indent + (ordered ? `${n}. ` : '- ') + lead.trim() + '\n' + nested;
  }
  return out;
}
function mdTableDom(el: Element): string {
  const rows = [...el.querySelectorAll('tr')];
  if (!rows.length) return '';
  const cellsOf = (tr: Element): string[] => [...tr.children]
    .filter(c => /^(td|th)$/.test(c.tagName.toLowerCase()))
    .map(c => mdInlineDom(c).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim());
  const grid = rows.map(cellsOf);
  const cols = Math.max(...grid.map(r => r.length));
  let out = '';
  grid.forEach((r, ri) => {
    while (r.length < cols) r.push('');
    out += '| ' + r.join(' | ') + ' |\n';
    if (ri === 0) out += '| ' + Array(cols).fill('---').join(' | ') + ' |\n';
  });
  return out + '\n';
}
const MD_BLOCK_TAGS = /^(h[1-6]|p|ul|ol|table|blockquote|pre|hr|div|section|article|header|footer|main|figure|figcaption|li)$/;
function mdBlockDom(node: Node, depth = 0): string {
  if (node.nodeType === 3) { const t = (node.textContent ?? '').replace(/\s+/g, ' '); return t.trim() ? t.trim() + '\n\n' : ''; }
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (mdSkip(el)) return '';
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'style': case 'script': case 'img': case 'br': return '';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const t = mdInlineDom(el).trim(); return t ? '#'.repeat(+tag[1]!) + ' ' + t + '\n\n' : '';
    }
    case 'p': { const t = mdInlineDom(el).trim(); return t ? t + '\n\n' : ''; }
    case 'blockquote': {
      const inner = [...el.childNodes].map(c => mdBlockDom(c)).join('').trim();
      return inner ? inner.split('\n').map(l => l ? '> ' + l : '>').join('\n') + '\n\n' : '';
    }
    case 'pre': { const code = el.textContent ?? ''; const f = mdFenceFor(code); return f + '\n' + code.replace(/\n+$/, '') + '\n' + f + '\n\n'; }
    case 'hr': return '---\n\n';
    case 'ul': return mdListDom(el, false, depth) + (depth === 0 ? '\n' : '');
    case 'ol': return mdListDom(el, true, depth) + (depth === 0 ? '\n' : '');
    case 'table': return mdTableDom(el);
    default: {
      // A container: recurse if it holds block children, else treat it as one paragraph.
      const hasBlockChild = [...el.children].some(c => MD_BLOCK_TAGS.test(c.tagName.toLowerCase()));
      if (!hasBlockChild) { const t = mdInlineDom(el).trim(); return t ? t + '\n\n' : ''; }
      return [...el.childNodes].map(c => mdBlockDom(c, depth)).join('');
    }
  }
}
function renderMarkdown(node: Element): Blob {
  const md = mdBlockDom(node).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return new Blob([md + '\n'], { type: 'text/markdown' });
}

function renderPlainText(node: Element): Blob {
  const handlers: DomHandlers = {
    text: t => t,
    br: () => '\n',
    element(tag, inner) {
      const s = inner.trim();
      switch (tag) {
        case 'p':  return s ? s + '\n\n' : '';
        case 'h1': case 'h2': case 'h3': return s ? s + '\n\n' : '';
        case 'blockquote': return s ? s + '\n\n' : '';
        default:   return inner;
      }
    },
  };
  const text = walkDom(node, handlers).replace(/\n{3,}/g, '\n\n').trim();
  return new Blob([text + '\n'], { type: 'text/plain' });
}
