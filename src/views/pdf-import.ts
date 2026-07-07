// Design Import — PDF / Adobe Illustrator (.ai) parser.
//
// The SHELL half of the PDF import path. An Illustrator .ai file saved with PDF
// compatibility (Illustrator's default) IS a PDF, so .ai and .pdf both land here.
// This module owns the byte work — it uses pdf-lib to load the document, decode the
// first page's content stream(s), and pre-extract resources (fonts → byte→text
// decoders, XObjects → image markers / nested form streams, ExtGStates → alpha,
// optional-content groups → layer labels). It hands the decoded content + a plain
// resource descriptor to the PURE engine interpreter (engine/src/pdf-map.ts), which
// reconstructs editable DesignNodes, then resolves the image/vector placeholders into
// stored user assets. Nothing leaves the device — the whole parse is local.
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
  interpretPdfPage, parseToUnicode, toUnicodeDecoder, finalizeBoxes, safeColor,
} from '@lolly/engine';
import type { PdfNode, PdfFontInfo, PdfXObject } from '../../../../engine/src/pdf-map.ts';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
import { storeUserUpload } from './picker.ts';

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

/**
 * Parse a PDF / .ai file into a Layout Studio boxes array.
 * @param {File|Blob} file
 * @param {{ host: object, warn?: (msg: string) => void }} ctx
 * @returns {Promise<{ boxes: object[], width: number, height: number, background: string }>}
 */
export async function parsePdfFile(
  file: File | Blob,
  { host, warn = () => {} }: { host: HostV1; warn?: (msg: string) => void } = {} as { host: HostV1; warn?: (msg: string) => void },
) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
  } catch (err) {
    throw new Error('Couldn’t read this PDF/.ai — it may be encrypted or damaged. (' + msg(err) + ')');
  }
  const pageCount = doc.getPageCount();
  if (!pageCount) throw new Error('This PDF has no pages.');
  if (pageCount > 1) warn(`Imported the first of ${pageCount} pages.`);

  const pdfPage = doc.getPage(0);
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
  if (!nodes.length) throw new Error('Couldn’t find any importable artwork on the first page.');

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

  const boxes = finalizeBoxes(nodes, { prefix: 'p' });
  if (!boxes.length) throw new Error('Couldn’t find any importable artwork on the first page.');
  return { boxes, width: Math.max(1, Math.round(mb.width)), height: Math.max(1, Math.round(mb.height)), background: '#ffffff' };
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

async function resolveImage(host: HostV1, desc: ImageDesc, warn: (msg: string) => void): Promise<unknown> {
  const last = desc.filter[desc.filter.length - 1];
  try {
    if (last === 'DCTDecode') {
      // Raw stream bytes ARE the JPEG the browser can decode directly.
      const jpeg = desc.stream.getContents();
      return await storeBytes(host, jpeg, 'image/jpeg', 'jpg');
    }
    if ((last === 'FlateDecode' || last == null) && desc.width > 0 && desc.height > 0 && desc.bpc === 8 && !((desc.predictor as number) > 1)) {
      const png = await flateImageToPng(desc);
      if (png) return await storeBytes(host, png, 'image/png', 'png');
    }
    warn(`Skipped an embedded image in an unsupported encoding (${last || 'raw'}).`);
    return null;
  } catch (err) {
    warn(`Couldn’t import an embedded image (${msg(err)}).`);
    return null;
  }
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
