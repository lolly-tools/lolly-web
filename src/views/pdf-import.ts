// Design Import + asset upload — PDF / Adobe Illustrator (.ai) parser.
//
// The SHELL half of the PDF import path. An Illustrator .ai file saved with PDF
// compatibility (Illustrator's default) IS a PDF, so .ai and .pdf both land here.
// This module owns the byte work — it uses pdf-lib to load the document, decode a
// page's content stream(s), and pre-extract resources (fonts → byte→text
// decoders, XObjects → image markers / nested form streams, ExtGStates → alpha,
// optional-content groups → layer labels). It hands the decoded content + a plain
// resource descriptor to the PURE engine interpreter (engine/src/pdf-map.ts), which
// reconstructs editable DesignNodes. Nothing leaves the device — the whole parse is
// local. From those SAME interpreted nodes it serves two ingest surfaces:
//
//   parsePdfFile          → Layout Studio boxes (image/vector placeholders resolved
//                           into individually-stored user assets)
//   ingestPdfAsSvgAssets  → whole pages as standalone SVG user assets (the upload
//                           paths: catalog drop area, asset-picker upload), via the
//                           engine's pdfNodesToSvg with images inlined as data: URIs
//
// A multi-page document asks which page(s) with the pickPdfPages dialog — single-
// select for a canvas import, multi-select (or all) for asset uploads — so the two
// surfaces stay behaviourally identical.
//
// Fidelity: rectangles/ellipses/text/groups come back as editable boxes; arbitrary
// paths come back as crisp vector (SVG) image boxes; raster image XObjects are decoded
// where the browser can (JPEG directly; Flate RGB/Gray via canvas) and otherwise degrade
// to a neutral box rather than being dropped.

import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, decodePDFRawStream,
} from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import {
  interpretPdfPage, parseToUnicode, toUnicodeDecoder, finalizeBoxes, safeColor, pdfNodesToSvg,
  type DesignMapOptions,
} from '@lolly/engine';
import type { PdfNode, PdfFontInfo, PdfXObject } from '../../../../engine/src/pdf-map.ts';
import type { AssetRef, HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
import { storeUserUpload } from './picker.ts';
import { trapFocus } from '../lib/focus-trap.ts';
import type { FocusTrap } from '../lib/focus-trap.ts';
import { NAV_EVENTS } from '../utils.ts';

// A pdf-lib lookup key — a value we can hand to `ctx.lookup(...)`. We also let `null`
// through (some helpers pass a `dictOf(...) → PDFDict | null` result straight back in),
// mirroring the untyped JS where `ctx.lookup(null)` simply yields undefined.
type Ref = PDFObject | null | undefined;

// The interpreter's PdfNode plus the `image` field the shell fills in when it resolves a
// vector/raster placeholder to a stored asset (structurally the design-map DesignNode).
interface ImportNode extends PdfNode { image?: unknown; }

// Fully-populated resource descriptor handed to the engine interpreter.
interface Resources {
  fonts: Record<string, PdfFontInfo>;
  xobjects: Record<string, PdfXObject>;
  extgstates: Record<string, { ca?: number; CA?: number }>;
  ocgs: Record<string, string>;
}

// A raster image XObject the shell will resolve to stored bytes.
interface ImageDesc {
  stream: PDFRawStream;
  filter: string[];
  width: number;
  height: number;
  colorSpace: string | null;
  bpc: number;
  predictor: number | null;
}

// ── document loading + per-page interpretation (shared by both surfaces) ────────

async function loadDoc(file: File | Blob): Promise<PDFDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
  } catch (err) {
    throw new Error('Couldn’t read this PDF/.ai — it may be encrypted or damaged. (' + msg(err) + ')');
  }
}

interface InterpretedPage {
  nodes: ImportNode[];
  width: number;
  height: number;
  /** Raster XObjects found on this page, keyed by the id the engine echoes back. */
  imageStreams: Map<string, ImageDesc>;
}

/** Decode + interpret ONE page (0-based) into DesignNodes with unresolved placeholders. */
function interpretPage(doc: PDFDocument, pageIndex: number): InterpretedPage {
  const pdfPage = doc.getPage(pageIndex);
  const ctx = doc.context;
  const node = pdfPage.node;
  const mb = pdfPage.getMediaBox();

  // Extract resources (recursively for forms). `imageStreams` collects raster XObjects
  // keyed by a unique id the engine echoes back on each image node.
  const imageStreams = new Map<string, ImageDesc>();
  const resources = extractResources(ctx, getKey(ctx, node, 'Resources'), imageStreams, 0);
  const content = contentString(ctx, node);

  const nodes = interpretPdfPage({
    content,
    width: mb.width, height: mb.height,
    originX: mb.x || 0, originY: mb.y || 0,
    fonts: resources.fonts,
    xobjects: resources.xobjects,
    extgstates: resources.extgstates,
    ocgs: resources.ocgs,
  }) as ImportNode[];

  return { nodes, width: mb.width, height: mb.height, imageStreams };
}

/**
 * Parse a PDF / .ai file into a Layout Studio boxes array.
 *
 * Page choice for a multi-page document: an explicit `page` (0-based) wins; else with
 * `interactive` set the shared pickPdfPages dialog asks (single-select; cancelling
 * throws an 'Import cancelled.' error); else the first page imports with a warn —
 * the pre-existing headless behaviour, kept for non-UI callers.
 */
export async function parsePdfFile(
  file: File | Blob,
  { host, warn = () => {}, page, interactive, map }: {
    host: HostV1; warn?: (msg: string) => void; page?: number; interactive?: boolean; map?: DesignMapOptions;
  } = {} as { host: HostV1; warn?: (msg: string) => void },
) {
  const doc = await loadDoc(file);
  const pageCount = doc.getPageCount();
  if (!pageCount) throw new Error('This PDF has no pages.');

  let pageIndex = Math.min(Math.max(Math.floor(page ?? 0), 0), pageCount - 1);
  if (pageCount > 1 && page == null) {
    if (interactive) {
      const picked = await pickPdfPages(makeHandle(doc), { mode: 'single', fileName: (file as File).name || '' });
      if (!picked?.length) throw new Error('Import cancelled.');
      pageIndex = picked[0]!;
    } else {
      warn(`Imported the first of ${pageCount} pages.`);
    }
  }

  const { nodes, width, height, imageStreams } = interpretPage(doc, pageIndex);
  if (!nodes.length) throw new Error('Couldn’t find any importable artwork on that page.');

  // Resolve placeholders → stored assets.
  const vecCache = new Map<string, unknown>();
  for (const n of nodes) {
    try {
      if (n._vectorPath) {
        const ref = await storeVector(host, n, vecCache);
        if (ref) { n.image = ref; } else { n.kind = 'box'; n.fill = firstColor(n._vectorFill); }
        clearVector(n);
      } else if (n._imageXObject) {
        const desc = imageStreams.get(n._imageXObject);
        const ref = desc ? await resolveImage(host, desc, warn) : null;
        if (ref) { n.image = ref; } else { n.kind = 'box'; n.fill = ''; }
        delete n._imageXObject;
      }
    } catch (err) {
      warn(`Skipped an element that couldn’t be imported (${msg(err)}).`);
      n.kind = 'box'; clearVector(n); delete n._imageXObject;
    }
  }

  const boxes = finalizeBoxes(nodes, { prefix: 'p', ...map });
  if (!boxes.length) throw new Error('Couldn’t find any importable artwork on that page.');
  return { boxes, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), background: '#ffffff' };
}

// ── pdf-lib access helpers ─────────────────────────────────────────────────────

function msg(err: unknown): string { return String((err && (err as Error).message) || err); }
function dictOf(ctx: PDFContext, o: Ref): PDFDict | null { o = ctx.lookup(o as PDFObject | undefined); return (o instanceof PDFRawStream) ? o.dict : (o instanceof PDFDict ? o : null); }
function getKey(ctx: PDFContext, o: Ref, key: string): PDFObject | undefined { const d = dictOf(ctx, o); return d ? d.get(PDFName.of(key)) : undefined; }
function numOf(ctx: PDFContext, o: Ref): number | null { o = ctx.lookup(o as PDFObject | undefined); return o instanceof PDFNumber ? o.asNumber() : null; }
function nameOf(ctx: PDFContext, o: Ref): string | null { o = ctx.lookup(o as PDFObject | undefined); return o instanceof PDFName ? o.asString().replace(/^\//, '') : null; }
function dictEntries(ctx: PDFContext, o: Ref): [string, PDFObject][] {
  const d = dictOf(ctx, o);
  return d ? [...d.entries()].map(([k, v]): [string, PDFObject] => [k.asString().replace(/^\//, ''), v]) : [];
}
function decodedText(ctx: PDFContext, o: Ref): string | null {
  o = ctx.lookup(o as PDFObject | undefined);
  if (o instanceof PDFRawStream) { try { return new TextDecoder('latin1').decode(decodePDFRawStream(o).decode()); } catch { return null; } }
  return null;
}
function contentString(ctx: PDFContext, pageNode: Ref): string {
  const c = ctx.lookup(getKey(ctx, pageNode, 'Contents'));
  const parts: string[] = [];
  const add = (ref: Ref) => { const t = decodedText(ctx, ref); if (t != null) parts.push(t); };
  if (c instanceof PDFArray) c.asArray().forEach(add); else add(getKey(ctx, pageNode, 'Contents'));
  return parts.join('\n');
}

// ── resource extraction ─────────────────────────────────────────────────────

function extractResources(ctx: PDFContext, resDict: Ref, imageStreams: Map<string, ImageDesc>, depth: number): Resources {
  const res: Resources = { fonts: {}, xobjects: {}, extgstates: {}, ocgs: {} };
  if (!dictOf(ctx, resDict) || depth > 8) return res;

  for (const [name, ref] of dictEntries(ctx, getKey(ctx, resDict, 'ExtGState'))) {
    const ca = numOf(ctx, getKey(ctx, ref, 'ca')), CA = numOf(ctx, getKey(ctx, ref, 'CA'));
    res.extgstates[name] = {};
    if (ca != null) res.extgstates[name]!.ca = ca;
    if (CA != null) res.extgstates[name]!.CA = CA;
  }

  for (const [name, ref] of dictEntries(ctx, getKey(ctx, resDict, 'Font'))) {
    res.fonts[name] = buildFontInfo(ctx, ref);
  }

  for (const [name, ref] of dictEntries(ctx, getKey(ctx, resDict, 'XObject'))) {
    const subtype = nameOf(ctx, getKey(ctx, ref, 'Subtype'));
    if (subtype === 'Image') {
      const key = `img${imageStreams.size}`;
      imageStreams.set(key, {
        stream: ctx.lookup(ref) as PDFRawStream,
        filter: filterList(ctx, getKey(ctx, ref, 'Filter')),
        width: numOf(ctx, getKey(ctx, ref, 'Width')) || 0,
        height: numOf(ctx, getKey(ctx, ref, 'Height')) || 0,
        colorSpace: colorSpaceName(ctx, getKey(ctx, ref, 'ColorSpace')),
        bpc: numOf(ctx, getKey(ctx, ref, 'BitsPerComponent')) || 8,
        predictor: numOf(ctx, getKey(ctx, dictOf(ctx, getKey(ctx, ref, 'DecodeParms')), 'Predictor')),
      });
      res.xobjects[name] = { kind: 'image', imageKey: key };
    } else if (subtype === 'Form') {
      const mtx = ctx.lookup(getKey(ctx, ref, 'Matrix'));
      res.xobjects[name] = {
        kind: 'form',
        content: decodedText(ctx, ref) || '',
        matrix: mtx instanceof PDFArray ? mtx.asArray().map((v) => numOf(ctx, v) ?? 0) : undefined,
        resources: extractResources(ctx, getKey(ctx, ref, 'Resources'), imageStreams, depth + 1),
      };
    }
  }

  // Optional-content groups: /Properties maps a marked-content name → an OCG dict whose
  // /Name is the (Illustrator layer) label.
  for (const [name, ref] of dictEntries(ctx, getKey(ctx, resDict, 'Properties'))) {
    const label = pdfString(ctx, getKey(ctx, ref, 'Name'));
    if (label) res.ocgs[name] = label;
  }
  return res;
}

function filterList(ctx: PDFContext, o: Ref): string[] {
  o = ctx.lookup(o as PDFObject | undefined);
  if (o instanceof PDFName) return [o.asString().replace(/^\//, '')];
  if (o instanceof PDFArray) return o.asArray().map((v) => nameOf(ctx, v)).filter(Boolean) as string[];
  return [];
}
function colorSpaceName(ctx: PDFContext, o: Ref): string | null {
  o = ctx.lookup(o as PDFObject | undefined);
  if (o instanceof PDFName) return o.asString().replace(/^\//, '');
  if (o instanceof PDFArray && o.size()) return nameOf(ctx, o.get(0));
  return null;
}
function pdfString(ctx: PDFContext, o: Ref): string {
  o = ctx.lookup(o as PDFObject | undefined);
  if (!o) return '';
  const s = o as { asString?: () => string; decodeText?: () => string };
  if (typeof s.asString === 'function' && !(o instanceof PDFName)) { try { return s.asString(); } catch { /* */ } }
  if (typeof s.decodeText === 'function') { try { return s.decodeText(); } catch { /* */ } }
  return '';
}

// ── fonts ─────────────────────────────────────────────────────────────────────

function buildFontInfo(ctx: PDFContext, fontRef: Ref): PdfFontInfo {
  const subtype = nameOf(ctx, getKey(ctx, fontRef, 'Subtype')) || '';
  const twoByte = subtype === 'Type0';
  const rawBase = nameOf(ctx, getKey(ctx, fontRef, 'BaseFont')) || '';
  const base = rawBase.replace(/^[A-Z]{6}\+/, ''); // strip subset prefix "ABCDEF+"
  const info: PdfFontInfo = { twoByte, family: base, weight: weightFromName(base) };

  // ToUnicode is the reliable path for embedded / subset fonts. For a Type0 font the
  // ToUnicode may live on the font or (rarely) its descendant — the top-level one wins.
  const tuText = decodedText(ctx, getKey(ctx, fontRef, 'ToUnicode'));
  if (tuText) {
    try { info.decode = toUnicodeDecoder(parseToUnicode(tuText), twoByte); } catch { /* Latin-1 fallback */ }
  }
  return info;
}

function weightFromName(name: string): number {
  const s = String(name || '');
  if (/thin|hairline/i.test(s)) return 100;
  if (/extra[\s-]*light|ultra[\s-]*light/i.test(s)) return 200;
  if (/semi[\s-]*bold|demi/i.test(s)) return 600;
  if (/extra[\s-]*bold|ultra[\s-]*bold/i.test(s)) return 800;
  if (/black|heavy/i.test(s)) return 900;
  if (/bold/i.test(s)) return 700;
  if (/medium/i.test(s)) return 500;
  if (/light/i.test(s)) return 300;
  return 400;
}

// ── image resolution ──────────────────────────────────────────────────────────

/** Decode a raster XObject to browser-displayable bytes (shared by the boxes path,
 *  which stores them as an asset, and the page-SVG path, which inlines a data: URI). */
async function imageBytes(desc: ImageDesc, warn: (msg: string) => void): Promise<{ bytes: Uint8Array; mime: string; ext: string } | null> {
  const last = desc.filter[desc.filter.length - 1];
  try {
    if (last === 'DCTDecode') {
      // Raw stream bytes ARE the JPEG the browser can decode directly.
      return { bytes: desc.stream.getContents(), mime: 'image/jpeg', ext: 'jpg' };
    }
    if ((last === 'FlateDecode' || last == null) && desc.width > 0 && desc.height > 0 && desc.bpc === 8 && !((desc.predictor as number) > 1)) {
      const png = await flateImageToPng(desc);
      if (png) return { bytes: png, mime: 'image/png', ext: 'png' };
    }
    warn(`Skipped an embedded image in an unsupported encoding (${last || 'raw'}).`);
    return null;
  } catch (err) {
    warn(`Couldn’t import an embedded image (${msg(err)}).`);
    return null;
  }
}

async function resolveImage(host: HostV1, desc: ImageDesc, warn: (msg: string) => void): Promise<unknown> {
  const got = await imageBytes(desc, warn);
  return got ? storeBytes(host, got.bytes, got.mime, got.ext) : null;
}

// Decode a Flate RGB/Gray image's raw samples into a PNG via a canvas.
async function flateImageToPng(desc: ImageDesc): Promise<Uint8Array | null> {
  const cs = desc.colorSpace || '';
  const comps = /RGB/i.test(cs) ? 3 : (/Gray/i.test(cs) ? 1 : 0);
  if (!comps) return null;
  const samples = decodePDFRawStream(desc.stream).decode();
  const { width, height } = desc;
  const need = width * height * comps;
  if (samples.length < need) return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, s = 0, d = 0; i < width * height; i++) {
    if (comps === 3) { rgba[d] = samples[s]!; rgba[d + 1] = samples[s + 1]!; rgba[d + 2] = samples[s + 2]!; s += 3; }
    else { const g = samples[s]!; rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; s += 1; }
    rgba[d + 3] = 255; d += 4;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

async function storeBytes(host: HostV1, bytes: Uint8Array, type: string, ext: string): Promise<unknown> {
  const file = new File([bytes as BlobPart], `pdf-${Date.now()}-${Math.round(bytes.length)}.${ext}`, { type });
  // storeUserUpload's param is a shell-internal PickerHost superset of HostV1; the real
  // host satisfies it at runtime (same object the picker uses).
  return storeUserUpload(host as Parameters<typeof storeUserUpload>[0], file);
}

// ── vector path resolution ──────────────────────────────────────────────────

async function storeVector(host: HostV1, n: ImportNode, cache: Map<string, unknown>): Promise<unknown> {
  const vb = n._vectorViewBox || { x: 0, y: 0, w: Math.round(n.w), h: Math.round(n.h) };
  const d = String(n._vectorPath || '').replace(/"/g, '');
  if (!d) return null;
  const fill = colorAttr(n._vectorFill, 'none');
  const st = n._vectorStroke;
  const strokeAttr = (st && st.color)
    ? ` stroke="${colorAttr(st.color, '#000000')}" stroke-width="${Math.max(0.3, +st.width || 1)}" fill-rule="nonzero"` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(vb.x)} ${r(vb.y)} ${r(vb.w)} ${r(vb.h)}" ` +
    `width="${Math.max(1, Math.round(vb.w))}" height="${Math.max(1, Math.round(vb.h))}">` +
    `<path d="${d}" fill="${fill}"${strokeAttr}/></svg>`;
  if (cache.has(svg)) return cache.get(svg);
  const file = new File([svg], `pdf-vec-${cache.size}.svg`, { type: 'image/svg+xml' });
  const ref = await storeUserUpload(host as Parameters<typeof storeUserUpload>[0], file);
  cache.set(svg, ref);
  return ref;
}

function colorAttr(v: unknown, dflt: string): string {
  const s = String(v == null ? '' : v).trim();
  if (s.toLowerCase() === 'none') return 'none';
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : dflt;
}
function firstColor(v: unknown): string { const s = safeColor(v, ''); return (s && s.toLowerCase() !== 'none') ? s : ''; }
function clearVector(n: ImportNode): void { delete n._vectorPath; delete n._vectorFill; delete n._vectorStroke; delete n._vectorViewBox; }
function r(v: number): number { return Math.round((+v || 0) * 100) / 100; }

// ── whole pages as SVG (the asset-upload surface) ──────────────────────────────

/** One page rendered to a standalone SVG document (images inlined as data: URIs). */
export interface PdfPageSvg {
  svg: string;
  width: number;
  height: number;
  /** Drawable nodes the interpreter found — 0 means a blank/unimportable page. */
  elementCount: number;
}

/** An opened document: page count + a cached page→SVG converter. */
export interface PdfHandle {
  pageCount: number;
  pageToSvg(index: number, opts?: { warn?: (msg: string) => void }): Promise<PdfPageSvg>;
}

function makeHandle(doc: PDFDocument): PdfHandle {
  const cache = new Map<number, PdfPageSvg>();
  return {
    pageCount: doc.getPageCount(),
    async pageToSvg(index: number, { warn = () => {} }: { warn?: (msg: string) => void } = {}): Promise<PdfPageSvg> {
      const hit = cache.get(index);
      if (hit) return hit;
      const { nodes, width, height, imageStreams } = interpretPage(doc, index);
      // Inline every raster XObject the page actually uses, so the SVG is
      // self-contained (and survives storeUserUpload's DOMPurify pass, which
      // allows data:image/png|jpeg hrefs on <image>).
      const images: Record<string, string> = {};
      for (const n of nodes) {
        const key = n._imageXObject;
        if (!key || key in images) continue;
        const desc = imageStreams.get(key);
        const got = desc ? await imageBytes(desc, warn) : null;
        if (got) images[key] = `data:${got.mime};base64,${bytesToBase64(got.bytes)}`;
      }
      const out: PdfPageSvg = {
        svg: pdfNodesToSvg(nodes, { width, height, images }),
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
        elementCount: nodes.length,
      };
      cache.set(index, out);
      return out;
    },
  };
}

/** Open a PDF/.ai for page-level conversion (shared by uploads and the page picker). */
export async function openPdfFile(file: File | Blob): Promise<PdfHandle> {
  return makeHandle(await loadDoc(file));
}

// Base64 in chunks — String.fromCharCode(...bigArray) overflows the call stack.
function bytesToBase64(u8: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  return btoa(bin);
}

function xmlEsc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

// Previews (and selection) are capped so a 500-page manual can't queue hundreds of
// full-page conversions from one drop; the footer note says what was cut.
const MAX_PICK_PAGES = 60;

/**
 * The shared "which page(s)?" dialog for a multi-page PDF/.ai. Thumbnails are the
 * pages' actual SVG conversions, generated in the background (and cached on the
 * handle, so a later ingest of the picked pages costs nothing extra).
 *
 * mode 'single' (canvas import, picker upload): clicking a page resolves [index].
 * mode 'multi'  (catalog upload): pages toggle, everything starts selected — "all of
 * them" is the one-click default — and the Add button resolves the selection.
 * Cancel / Escape / backdrop resolve null.
 */
export function pickPdfPages(
  handle: PdfHandle,
  { mode, fileName = '' }: { mode: 'single' | 'multi'; fileName?: string },
): Promise<number[] | null> {
  return new Promise((resolve) => {
    const total = handle.pageCount;
    const shown = Math.min(total, MAX_PICK_PAGES);
    const usable = new Set<number>(Array.from({ length: shown }, (_, i) => i));
    const selected = new Set<number>(mode === 'multi' ? usable : []);

    let trap: FocusTrap | undefined;
    const overlay = document.createElement('div');
    overlay.className = 'pdfpick-overlay';
    overlay.innerHTML = `
      <div class="pdfpick-backdrop" aria-hidden="true"></div>
      <div class="pdfpick-panel" role="dialog" aria-modal="true" aria-label="${mode === 'single' ? 'Choose a page' : 'Choose pages'}">
        <header class="pdfpick-head">
          <span class="pdfpick-title">${mode === 'single' ? 'Choose a page' : 'Choose pages'}${fileName ? ` — ${xmlEsc(fileName)}` : ''}</span>
          <button type="button" class="pdfpick-close" aria-label="Close">&times;</button>
        </header>
        <p class="pdfpick-sub">${mode === 'single'
          ? 'Pick the page to import.'
          : 'Each selected page is added to your library as an SVG.'}</p>
        <div class="pdfpick-grid">
          ${Array.from({ length: shown }, (_, i) => `
            <button type="button" class="pdfpick-page${mode === 'multi' ? ' is-on' : ''}" data-page="${i}" aria-pressed="${mode === 'multi'}">
              <span class="pdfpick-thumb" aria-hidden="true"></span>
              <span class="pdfpick-cap">Page ${i + 1}</span>
            </button>`).join('')}
        </div>
        <footer class="pdfpick-actions">
          <span class="pdfpick-note">${total > shown ? `Showing the first ${shown} of ${total} pages.` : ''}</span>
          ${mode === 'multi' ? '<button type="button" class="pdfpick-btn pdfpick-all"></button>' : ''}
          <button type="button" class="pdfpick-btn pdfpick-cancel">Cancel</button>
          ${mode === 'multi' ? '<button type="button" class="pdfpick-btn pdfpick-btn--primary pdfpick-add"></button>' : ''}
        </footer>
      </div>`;
    document.body.appendChild(overlay);

    const opener = document.activeElement;
    const done = (val: number[] | null): void => {
      trap?.release();
      document.removeEventListener('keydown', onKey);
      NAV_EVENTS.forEach(ev => window.removeEventListener(ev, onNav));
      overlay.remove();
      if (opener instanceof HTMLElement) opener.focus();
      resolve(val);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey);
    // A route change cancels the dialog exactly like Escape/backdrop (resolve null) —
    // the body-mounted overlay must not outlive the view that spawned it, and the
    // trap's inert background must be released (NAV_EVENTS contract, utils.ts).
    const onNav = (): void => done(null);
    NAV_EVENTS.forEach(ev => window.addEventListener(ev, onNav));
    overlay.querySelector('.pdfpick-backdrop')?.addEventListener('click', () => done(null));
    overlay.querySelector('.pdfpick-close')?.addEventListener('click', () => done(null));
    overlay.querySelector('.pdfpick-cancel')?.addEventListener('click', () => done(null));

    const addBtn = overlay.querySelector<HTMLButtonElement>('.pdfpick-add');
    const allBtn = overlay.querySelector<HTMLButtonElement>('.pdfpick-all');
    const sync = (): void => {
      if (addBtn) {
        addBtn.disabled = selected.size === 0;
        addBtn.textContent = selected.size === 1 ? 'Add 1 page' : `Add ${selected.size} pages`;
      }
      if (allBtn) allBtn.textContent = (usable.size > 0 && selected.size === usable.size) ? 'Select none' : 'Select all';
    };
    const paint = (btn: HTMLButtonElement): void => {
      const i = Number(btn.dataset.page);
      btn.classList.toggle('is-on', selected.has(i));
      btn.setAttribute('aria-pressed', String(selected.has(i)));
    };

    overlay.querySelector('.pdfpick-grid')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.pdfpick-page');
      if (!btn || btn.disabled) return;
      const i = Number(btn.dataset.page);
      if (mode === 'single') { done([i]); return; }
      if (selected.has(i)) selected.delete(i); else selected.add(i);
      paint(btn); sync();
    });
    allBtn?.addEventListener('click', () => {
      const all = selected.size < usable.size;
      selected.clear();
      if (all) for (const i of usable) selected.add(i);
      overlay.querySelectorAll<HTMLButtonElement>('.pdfpick-page').forEach(paint);
      sync();
    });
    addBtn?.addEventListener('click', () => done([...selected].sort((a, b) => a - b)));
    trap = trapFocus(overlay, {
      initialFocus: overlay.querySelector<HTMLElement>(mode === 'multi' ? '.pdfpick-add' : '.pdfpick-page'),
    });
    sync();

    // Thumbnails: convert sequentially in the background; the conversions are cached on
    // the handle so confirming costs nothing extra. A page that fails (or holds no
    // artwork) is disabled and dropped from the selection — it can't become an empty asset.
    void (async () => {
      for (let i = 0; i < shown; i++) {
        if (!overlay.isConnected) return;
        const btn = overlay.querySelector<HTMLButtonElement>(`.pdfpick-page[data-page="${i}"]`);
        const thumb = btn?.querySelector<HTMLElement>('.pdfpick-thumb');
        try {
          const pageSvg = await handle.pageToSvg(i);
          if (!overlay.isConnected) return;
          if (!pageSvg.elementCount) throw new Error('empty page');
          if (thumb) {
            const img = document.createElement('img');
            img.alt = '';
            img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(pageSvg.svg);
            thumb.replaceChildren(img);
          }
        } catch {
          usable.delete(i); selected.delete(i);
          if (btn) { btn.disabled = true; paint(btn); }
          if (thumb) thumb.textContent = 'No artwork';
          sync();
        }
      }
    })();
  });
}

/**
 * Upload-path entry: convert a PDF/.ai into stored SVG user assets.
 *
 * One page → converted directly. Multi-page → the pickPdfPages dialog asks which
 * (mode 'multi' offers all-of-them; 'single' picks one, for the asset-picker where a
 * single slot is being filled). Returns the stored refs — empty when cancelled or
 * nothing converted. Per-page failures warn and continue.
 */
export async function ingestPdfAsSvgAssets(
  host: HostV1,
  file: File | Blob,
  { mode = 'multi', warn = () => {} }: { mode?: 'single' | 'multi'; warn?: (msg: string) => void } = {},
): Promise<AssetRef[]> {
  const name = (file as File).name || 'document.pdf';
  const handle = await openPdfFile(file);
  if (!handle.pageCount) throw new Error('This PDF has no pages.');

  let pages: number[];
  if (handle.pageCount === 1) {
    pages = [0];
  } else {
    const picked = await pickPdfPages(handle, { mode, fileName: name });
    if (!picked?.length) return [];
    pages = picked;
  }

  const base = name.replace(/\.(pdf|ai)$/i, '').trim() || 'page';
  const refs: AssetRef[] = [];
  for (const p of pages) {
    try {
      const pageSvg = await handle.pageToSvg(p, { warn });
      if (!pageSvg.elementCount) { warn(`Page ${p + 1} has no importable artwork — skipped.`); continue; }
      const svgName = handle.pageCount === 1 ? `${base}.svg` : `${base} — page ${p + 1}.svg`;
      const svgFile = new File([pageSvg.svg], svgName, { type: 'image/svg+xml' });
      refs.push(await storeUserUpload(host as Parameters<typeof storeUserUpload>[0], svgFile));
    } catch (err) {
      warn(`Couldn’t convert page ${p + 1} (${msg(err)}).`);
    }
  }
  if (!refs.length && handle.pageCount === 1) throw new Error('Couldn’t find any importable artwork in this PDF.');
  return refs;
}
