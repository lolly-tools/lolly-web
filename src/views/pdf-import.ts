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
  unfilterPng,
  type DesignMapOptions,
} from '@lolly/engine';
import type { PdfNode, PdfFontInfo, PdfXObject, PdfShading, PdfPattern, PdfGradientStop } from '../../../../engine/src/pdf-map.ts';
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
  shadings: Record<string, PdfShading>;
  patterns: Record<string, PdfPattern>;
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
  /** Soft mask (/SMask) — a grayscale alpha image composited over the base at
   *  decode time. How print engines encode blurred shadows and any alpha raster:
   *  without it the base decodes as an opaque plate. */
  smask?: ImageDesc;
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
    shadings: resources.shadings,
    patterns: resources.patterns,
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

  // Resolve placeholders → stored assets. Clip stacks are a serializer concern
  // (pageToSvg honours them); free-canvas boxes can't clip, so drop them here.
  const vecCache = new Map<string, unknown>();
  for (const n of nodes) {
    delete n._clips;
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
  const res: Resources = { fonts: {}, xobjects: {}, extgstates: {}, ocgs: {}, shadings: {}, patterns: {} };
  if (!dictOf(ctx, resDict) || depth > 8) return res;

  for (const [name, ref] of dictEntries(ctx, getKey(ctx, resDict, 'ExtGState'))) {
    const ca = numOf(ctx, getKey(ctx, ref, 'ca')), CA = numOf(ctx, getKey(ctx, ref, 'CA'));
    res.extgstates[name] = {};
    if (ca != null) res.extgstates[name]!.ca = ca;
    if (CA != null) res.extgstates[name]!.CA = CA;
  }

  for (const [name, ref] of dictEntries(ctx, getKey(ctx, resDict, 'Font'))) {
    res.fonts[name] = buildFontInfo(ctx, ref, imageStreams, depth);
  }

  for (const [name, ref] of dictEntries(ctx, getKey(ctx, resDict, 'XObject'))) {
    const subtype = nameOf(ctx, getKey(ctx, ref, 'Subtype'));
    if (subtype === 'Image') {
      const key = `img${imageStreams.size}`;
      imageStreams.set(key, makeImageDesc(ctx, ref));
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

  // Shadings (the `sh` operator) and shading Patterns (PatternType 2, used as a
  // `scn` fill). Chromium emits CSS gradients as shading patterns; decoding them
  // to a pre-sampled colour ramp lets the engine paint a real SVG gradient instead
  // of dropping the fill. Tiling patterns (PatternType 1) are left out.
  for (const [name, ref] of dictEntries(ctx, getKey(ctx, resDict, 'Shading'))) {
    const sh = buildShading(ctx, ref);
    if (sh) res.shadings[name] = sh;
  }
  for (const [name, ref] of dictEntries(ctx, getKey(ctx, resDict, 'Pattern'))) {
    const pt = buildPattern(ctx, ref);
    if (pt) res.patterns[name] = pt;
  }
  return res;
}

/** Descriptor for one image XObject, including its /SMask (one level — an SMask
 *  never carries an SMask of its own). */
function makeImageDesc(ctx: PDFContext, ref: Ref, depth = 0): ImageDesc {
  const desc: ImageDesc = {
    stream: ctx.lookup(ref as PDFObject | undefined) as PDFRawStream,
    filter: filterList(ctx, getKey(ctx, ref, 'Filter')),
    width: numOf(ctx, getKey(ctx, ref, 'Width')) || 0,
    height: numOf(ctx, getKey(ctx, ref, 'Height')) || 0,
    colorSpace: colorSpaceName(ctx, getKey(ctx, ref, 'ColorSpace')),
    bpc: numOf(ctx, getKey(ctx, ref, 'BitsPerComponent')) || 8,
    predictor: numOf(ctx, getKey(ctx, dictOf(ctx, getKey(ctx, ref, 'DecodeParms')), 'Predictor')),
  };
  if (depth === 0) {
    const smaskRef = getKey(ctx, ref, 'SMask');
    if (smaskRef && ctx.lookup(smaskRef as PDFObject | undefined) instanceof PDFRawStream) {
      desc.smask = makeImageDesc(ctx, smaskRef, 1);
    }
  }
  return desc;
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
  if (o instanceof PDFArray && o.size()) {
    const head = nameOf(ctx, o.get(0));
    // ICCBased is an embedded profile with no device name — resolve it to a
    // device space by its component count (/N). Chromium encodes EVERY print
    // raster as [/ICCBased <N=3>], so without this every screenshot/photo on a
    // captured page decodes as "unsupported" and drops.
    if (head === 'ICCBased') {
      const n = numOf(ctx, dictOf(ctx, o.get(1))?.get(PDFName.of('N')));
      return n === 1 ? 'DeviceGray' : n === 4 ? 'DeviceCMYK' : 'DeviceRGB';
    }
    return head;
  }
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

function buildFontInfo(ctx: PDFContext, fontRef: Ref, imageStreams: Map<string, ImageDesc>, depth: number): PdfFontInfo {
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

  // Type3 glyphs are content-stream drawing procedures — the interpreter executes
  // them into real vector paths (engine pdf-map drawType3). This is how Chromium's
  // printToPDF encodes app text, so it's the path every docs screenshot takes.
  if (subtype === 'Type3') {
    const fmArr = ctx.lookup(getKey(ctx, fontRef, 'FontMatrix'));
    const fontMatrix = fmArr instanceof PDFArray ? fmArr.asArray().map((v) => numOf(ctx, v) ?? 0) : [0.001, 0, 0, 0.001, 0, 0];
    const charProcs: Record<string, string> = {};
    for (const [gname, gref] of dictEntries(ctx, getKey(ctx, fontRef, 'CharProcs'))) {
      const t = decodedText(ctx, gref);
      if (t != null) charProcs[gname] = t;
    }
    const encoding: Record<number, string> = {};
    const encDict = dictOf(ctx, getKey(ctx, fontRef, 'Encoding'));
    const diffs = encDict ? ctx.lookup(encDict.get(PDFName.of('Differences'))) : null;
    if (diffs instanceof PDFArray) {
      let code = 0;
      for (const item of diffs.asArray()) {
        const o = ctx.lookup(item);
        if (o instanceof PDFNumber) code = o.asNumber();
        else if (o instanceof PDFName) { encoding[code] = o.asString().replace(/^\//, ''); code++; }
      }
    }
    const widths: Record<number, number> = {};
    const firstChar = numOf(ctx, getKey(ctx, fontRef, 'FirstChar')) ?? 0;
    const wArr = ctx.lookup(getKey(ctx, fontRef, 'Widths'));
    if (wArr instanceof PDFArray) wArr.asArray().forEach((v, i) => { const w = numOf(ctx, v); if (w != null) widths[firstChar + i] = w; });
    info.type3 = { fontMatrix, charProcs, encoding, widths, resources: extractResources(ctx, getKey(ctx, fontRef, 'Resources'), imageStreams, depth + 1) };
    info.twoByte = false;
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

// ── shadings & gradients ────────────────────────────────────────────────────
//
// PDF axial (ShadingType 2) / radial (ShadingType 3) shadings → a normalized
// descriptor the engine can emit as an SVG <linearGradient>/<radialGradient>. The
// byte work — evaluating the PDF /Function that maps the [0,1] axis to colour — lives
// HERE (in the shell), so the pure engine only ever sees a pre-sampled colour ramp.
// Chromium's print backend emits every CSS gradient as a shading pattern, so this is
// the path the docs-screenshot pipeline and any .pdf/.ai upload take for gradients.

/** A parsed PDF function: axis parameter t → colour components (each in [0,1]). */
type PdfFn = (t: number) => number[];

function numArray(ctx: PDFContext, o: Ref): number[] | null {
  o = ctx.lookup(o as PDFObject | undefined);
  return o instanceof PDFArray ? o.asArray().map((v) => numOf(ctx, v) ?? 0) : null;
}
function boolArray(ctx: PDFContext, o: Ref): boolean[] {
  o = ctx.lookup(o as PDFObject | undefined);
  // PDFBool stringifies to "true"/"false"; avoids importing the class.
  return o instanceof PDFArray ? o.asArray().map((v) => String(ctx.lookup(v)) === 'true') : [];
}

/** Component count for a shading colour space (device or ICCBased-resolved). */
function shadingComps(cs: string | null): number {
  return cs ? (/CMYK/i.test(cs) ? 4 : /Gray/i.test(cs) ? 1 : 3) : 3;
}
function chan(v: number): string { return Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255).toString(16).padStart(2, '0'); }
/** Shading colour components → #rrggbb (Gray/RGB/CMYK by component count). */
function componentsToHex(vals: number[], comps: number): string {
  if (comps === 1) { const g = vals[0] ?? 0; return '#' + chan(g) + chan(g) + chan(g); }
  if (comps === 4) {
    const c = vals[0] ?? 0, m = vals[1] ?? 0, y = vals[2] ?? 0, k = vals[3] ?? 0;
    return '#' + chan((1 - c) * (1 - k)) + chan((1 - m) * (1 - k)) + chan((1 - y) * (1 - k));
  }
  return '#' + chan(vals[0] ?? 0) + chan(vals[1] ?? 0) + chan(vals[2] ?? 0);
}

// A shading /Function is one function, or an array of n single-output functions
// (one per colour component). Return a single t → components evaluator either way.
function parseShadingFunction(ctx: PDFContext, o: Ref): PdfFn | null {
  const lu = ctx.lookup(o as PDFObject | undefined);
  if (lu instanceof PDFArray) {
    const fns = lu.asArray().map((f) => parseFunction(ctx, f, 0));
    if (!fns.length || fns.some((f) => !f)) return null;
    return (t) => fns.map((f) => f!(t)[0] ?? 0);
  }
  return parseFunction(ctx, o, 0);
}

// PDF functions: Type 2 (exponential), Type 3 (stitching), Type 0 (sampled stream).
// Type 4 (PostScript calculator) is unsupported → null (the shading is dropped).
function parseFunction(ctx: PDFContext, o: Ref, depth: number): PdfFn | null {
  if (depth > 8) return null;
  const d = dictOf(ctx, o);
  if (!d) return null;
  const type = numOf(ctx, d.get(PDFName.of('FunctionType')));
  const domain = numArray(ctx, d.get(PDFName.of('Domain'))) || [0, 1];
  const d0 = domain[0] ?? 0, d1 = domain[1] ?? 1;
  const clampT = (t: number): number => (t < d0 ? d0 : t > d1 ? d1 : t);

  if (type === 2) {
    const c0 = numArray(ctx, d.get(PDFName.of('C0'))) || [0];
    const c1 = numArray(ctx, d.get(PDFName.of('C1'))) || [1];
    const N = numOf(ctx, d.get(PDFName.of('N'))) ?? 1;
    return (t) => { const p = Math.pow(clampT(t), N); return c0.map((c, j) => c + p * ((c1[j] ?? c) - c)); };
  }

  if (type === 3) {
    const subs = (ctx.lookup(d.get(PDFName.of('Functions'))) as PDFObject | undefined);
    const fnRefs = subs instanceof PDFArray ? subs.asArray() : [];
    const fns = fnRefs.map((f) => parseFunction(ctx, f, depth + 1));
    if (!fns.length || fns.some((f) => !f)) return null;
    const bounds = numArray(ctx, d.get(PDFName.of('Bounds'))) || [];
    const encode = numArray(ctx, d.get(PDFName.of('Encode'))) || [];
    const k = fns.length;
    return (t) => {
      const tt = clampT(t);
      let i = 0;
      while (i < bounds.length && i < k - 1 && tt >= (bounds[i] ?? Infinity)) i++;
      const lo = i === 0 ? d0 : (bounds[i - 1] ?? d0);
      const hi = i >= k - 1 ? d1 : (bounds[i] ?? d1);
      const e0 = encode[2 * i] ?? 0, e1 = encode[2 * i + 1] ?? 1;
      const x = hi > lo ? e0 + (tt - lo) * (e1 - e0) / (hi - lo) : e0;
      return fns[i]!(x);
    };
  }

  if (type === 0) return parseSampledFunction(ctx, o, d0, d1);
  return null;
}

// Type 0 sampled function: a stream of N samples × M components packed at
// BitsPerSample bits, big-endian. Linear-interpolate between the two nearest
// samples and decode each component to its output range.
function parseSampledFunction(ctx: PDFContext, o: Ref, d0: number, d1: number): PdfFn | null {
  const stream = ctx.lookup(o as PDFObject | undefined);
  if (!(stream instanceof PDFRawStream)) return null;
  const d = stream.dict;
  const size = numArray(ctx, d.get(PDFName.of('Size'))) || [];
  const range = numArray(ctx, d.get(PDFName.of('Range'))) || [];
  const bps = numOf(ctx, d.get(PDFName.of('BitsPerSample'))) ?? 8;
  const n = Math.floor(size[0] ?? 0), m = Math.floor(range.length / 2);
  if (n < 1 || m < 1 || bps < 1 || bps > 32) return null;
  const encode = numArray(ctx, d.get(PDFName.of('Encode'))) || [0, n - 1];
  const decode = numArray(ctx, d.get(PDFName.of('Decode'))) || range;
  let bytes: Uint8Array;
  try { bytes = decodePDFRawStream(stream).decode(); } catch { return null; }
  if (bytes.length < Math.ceil((n * m * bps) / 8)) return null;
  const maxVal = Math.pow(2, bps) - 1;
  const sampleAt = (idx: number, comp: number): number => {
    let bit = (idx * m + comp) * bps, v = 0;
    for (let b = 0; b < bps; b++, bit++) v = (v << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
    return v;
  };
  return (t) => {
    const tt = t < d0 ? d0 : t > d1 ? d1 : t;
    let e = d1 > d0 ? (encode[0] ?? 0) + (tt - d0) * ((encode[1] ?? n - 1) - (encode[0] ?? 0)) / (d1 - d0) : (encode[0] ?? 0);
    e = e < 0 ? 0 : e > n - 1 ? n - 1 : e;
    const i0 = Math.floor(e), i1 = Math.min(n - 1, i0 + 1), frac = e - i0;
    const out: number[] = [];
    for (let c = 0; c < m; c++) {
      const s = sampleAt(i0, c) + (sampleAt(i1, c) - sampleAt(i0, c)) * frac;
      const dl = decode[2 * c] ?? 0, dh = decode[2 * c + 1] ?? 1;
      out.push(dl + (s / maxVal) * (dh - dl));
    }
    return out;
  };
}

// Sample the colour ramp into stops. 16 uniform samples render a smooth gradient
// faithfully once SVG linearly interpolates between them; interior stops that add
// nothing (a flat run) are collapsed, endpoints always kept.
function sampleStops(fn: PdfFn, domain: number[], comps: number): PdfGradientStop[] {
  const t0 = domain[0] ?? 0, t1 = domain[1] ?? 1;
  const span = (t1 - t0) || 1;
  const N = 16;
  const raw: PdfGradientStop[] = [];
  for (let i = 0; i <= N; i++) {
    let col: string;
    try { col = componentsToHex(fn(t0 + (span * i) / N), comps); } catch { return []; }
    if (!/^#[0-9a-f]{6}$/i.test(col)) return [];
    raw.push({ offset: i / N, color: col });
  }
  const out: PdfGradientStop[] = [];
  for (let i = 0; i < raw.length; i++) {
    const keep = i === 0 || i === raw.length - 1 || raw[i]!.color !== raw[i - 1]!.color || raw[i]!.color !== raw[i + 1]!.color;
    if (keep) out.push(raw[i]!);
  }
  return out;
}

function buildShading(ctx: PDFContext, o: Ref): PdfShading | null {
  const d = dictOf(ctx, o);
  if (!d) return null;
  const type = numOf(ctx, d.get(PDFName.of('ShadingType')));
  if (type !== 2 && type !== 3) return null; // only axial / radial
  const coords = numArray(ctx, d.get(PDFName.of('Coords'))) || [];
  if ((type === 2 && coords.length < 4) || (type === 3 && coords.length < 6)) return null;
  const fn = parseShadingFunction(ctx, d.get(PDFName.of('Function')));
  if (!fn) return null;
  const domain = numArray(ctx, d.get(PDFName.of('Domain'))) || [0, 1];
  const comps = shadingComps(colorSpaceName(ctx, d.get(PDFName.of('ColorSpace'))));
  const stops = sampleStops(fn, domain, comps);
  if (stops.length < 2) return null;
  const ext = boolArray(ctx, d.get(PDFName.of('Extend')));
  return { type: type as 2 | 3, coords, stops, extend: [ext[0] ?? false, ext[1] ?? false] };
}

/** A shading Pattern (PatternType 2) → { shading, matrix }; others → null. */
function buildPattern(ctx: PDFContext, o: Ref): PdfPattern | null {
  const d = dictOf(ctx, o);
  if (!d || numOf(ctx, d.get(PDFName.of('PatternType'))) !== 2) return null;
  const shading = buildShading(ctx, d.get(PDFName.of('Shading')));
  if (!shading) return null;
  const matrix = numArray(ctx, d.get(PDFName.of('Matrix'))) || undefined;
  return { shading, matrix };
}

// ── image resolution ──────────────────────────────────────────────────────────

/** Decode a raster XObject to browser-displayable bytes (shared by the boxes path,
 *  which stores them as an asset, and the page-SVG path, which inlines a data: URI). */
async function imageBytes(desc: ImageDesc, warn: (msg: string) => void): Promise<{ bytes: Uint8Array; mime: string; ext: string } | null> {
  const last = desc.filter[desc.filter.length - 1];
  try {
    let base: { bytes: Uint8Array; mime: string; ext: string } | null = null;
    if (last === 'DCTDecode') {
      // Raw stream bytes ARE the JPEG the browser can decode directly.
      base = { bytes: desc.stream.getContents(), mime: 'image/jpeg', ext: 'jpg' };
    } else {
      // Flate RGB/Gray at 8bpc. Accept no predictor / TIFF-none (<=1) AND PNG
      // predictors (>=10) — the latter is what jsPDF's addImage(png,'PNG') writes
      // (/Predictor 15), so this is how /verify can read Lolly's OWN PDF PNG embeds.
      // TIFF predictor 2 (2..9) stays skipped (flateImageToPng would return null).
      const pred = (desc.predictor as number) ?? 1;
      if ((last === 'FlateDecode' || last == null) && desc.width > 0 && desc.height > 0 && desc.bpc === 8 && (pred <= 1 || pred >= 10)) {
        const png = await flateImageToPng(desc);
        if (png) base = { bytes: png, mime: 'image/png', ext: 'png' };
      }
    }
    if (!base) {
      warn(`Skipped an embedded image in an unsupported encoding (${last || 'raw'}).`);
      return null;
    }
    // A soft mask carries the image's alpha as a separate grayscale plane — how
    // print engines encode blurred shadows and any transparent raster. Composite
    // it, or the base renders as an opaque plate.
    if (desc.smask) {
      const masked = await applySmask(base, desc.smask);
      if (masked) return masked;
      warn('Kept an embedded image opaque (its soft mask was undecodable).');
    }
    return base;
  } catch (err) {
    warn(`Couldn’t import an embedded image (${msg(err)}).`);
    return null;
  }
}

/** Decode displayable bytes into pixels via the browser's own decoders. */
async function decodeToImageData(bytes: Uint8Array, mime: string): Promise<ImageData | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    return g.getImageData(0, 0, bmp.width, bmp.height);
  } catch {
    return null;
  }
}

/** Merge a /SMask's grayscale plane into the base image's alpha channel (nearest-
 *  neighbour scaled when the planes' dimensions differ). Returns a PNG. */
async function applySmask(base: { bytes: Uint8Array; mime: string }, smask: ImageDesc): Promise<{ bytes: Uint8Array; mime: string; ext: string } | null> {
  const img = await decodeToImageData(base.bytes, base.mime);
  if (!img) return null;

  // The alpha plane: Flate gray samples directly, or a JPEG-coded mask's luma.
  let alpha: Uint8Array | Uint8ClampedArray | null = null;
  let aw = smask.width, ah = smask.height;
  if (smask.filter[smask.filter.length - 1] === 'DCTDecode') {
    const m = await decodeToImageData(smask.stream.getContents(), 'image/jpeg');
    if (m) {
      const gray = new Uint8Array(m.width * m.height);
      for (let i = 0; i < gray.length; i++) gray[i] = m.data[i * 4]!;
      alpha = gray; aw = m.width; ah = m.height;
    }
  } else if (smask.bpc === 8) {
    alpha = flateSamples(smask, 1);
  }
  if (!alpha || aw < 1 || ah < 1) return null;

  const { width, height, data } = img;
  for (let y = 0; y < height; y++) {
    const sy = height === ah ? y : Math.min(ah - 1, Math.floor((y * ah) / height));
    for (let x = 0; x < width; x++) {
      const sx = width === aw ? x : Math.min(aw - 1, Math.floor((x * aw) / width));
      data[(y * width + x) * 4 + 3] = alpha[sy * aw + sx]!;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', ext: 'png' } : null;
}

async function resolveImage(host: HostV1, desc: ImageDesc, warn: (msg: string) => void): Promise<unknown> {
  const got = await imageBytes(desc, warn);
  return got ? storeBytes(host, got.bytes, got.mime, got.ext) : null;
}

/** Inflate + de-predictor a Flate image stream's raw samples (8bpc only).
 *  PNG predictor (/Predictor >= 10): pdf-lib's FlateStream only inflates — it
 *  never applies predictors — so the samples are still PNG-row-filtered (a 1-byte
 *  filter tag + width*comps bytes per row); reverse them to get real pixels.
 *  TIFF predictor 2 (2..9) isn't handled. Shared by the color path and /SMask
 *  alpha planes (comps=1). */
function flateSamples(desc: ImageDesc, comps: number): Uint8Array | Uint8ClampedArray | null {
  if (desc.bpc !== 8 || desc.width < 1 || desc.height < 1) return null;
  let samples: Uint8Array | Uint8ClampedArray;
  try { samples = decodePDFRawStream(desc.stream).decode(); } catch { return null; }
  const pred = (desc.predictor as number) ?? 1;
  if (pred >= 10) {
    const un = unfilterPng(samples, desc.width, desc.height, comps);
    if (!un) return null;
    samples = un;
  } else if (pred > 1) {
    return null;
  }
  return samples.length >= desc.width * desc.height * comps ? samples : null;
}

// Decode a Flate RGB/Gray image's raw samples into a PNG via a canvas.
async function flateImageToPng(desc: ImageDesc): Promise<Uint8Array | null> {
  const cs = desc.colorSpace || '';
  const comps = /RGB/i.test(cs) ? 3 : (/Gray/i.test(cs) ? 1 : 0);
  if (!comps) return null;
  const { width, height } = desc;
  const samples = flateSamples(desc, comps);
  if (!samples) return null;
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

export interface PdfPageSvgOpts {
  warn?: (msg: string) => void;
  /**
   * Override an image node's payload. Called once per drawable image node with
   * its geometry in the page's own (point) space and the decoded fallback data:
   * URI (null when the XObject couldn't be decoded); return a data: URI to
   * substitute, or null to keep the fallback. Lets a caller re-source rasters it
   * knows better than the PDF's re-encode — the docs-screenshot pipeline swaps
   * the app's ORIGINAL webp/canvas pixels back in (lib/pdf-vector-shot.ts).
   */
  resolveImage?: (rect: { x: number; y: number; w: number; h: number }, fallback: string | null) => string | null;
  /**
   * Outline a text run's glyphs to SVG path `d` strings, one per line (baseline
   * at y=0, pen at x=0). Return null to keep the font-dependent `<text>` (an
   * uncovered glyph, an unresolved font). Lets a caller that can shape text
   * (HarfBuzz) make the SVG self-contained — the docs-screenshot pipeline outlines
   * every run so a shot needs no fonts at render time (lib/pdf-vector-shot.ts).
   */
  outlineText?: (run: { text: string; fontFamily: string; fontWeight: string | number; fontSize: number }) => Promise<string[] | null>;
}

/** An opened document: page count + a cached page→SVG converter. */
export interface PdfHandle {
  pageCount: number;
  pageToSvg(index: number, opts?: PdfPageSvgOpts): Promise<PdfPageSvg>;
}

function makeHandle(doc: PDFDocument): PdfHandle {
  const cache = new Map<number, PdfPageSvg>();
  return {
    pageCount: doc.getPageCount(),
    async pageToSvg(index: number, { warn = () => {}, resolveImage, outlineText }: PdfPageSvgOpts = {}): Promise<PdfPageSvg> {
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
      // Per-NODE substitution: the same XObject can draw at several geometries,
      // so re-sourcing keys the override by node, leaving other uses untouched.
      if (resolveImage) {
        let i = 0;
        for (const n of nodes) {
          const key = n._imageXObject;
          if (!key) continue;
          const fallback = images[key] ?? null;
          const sub = resolveImage({ x: n.x, y: n.y, w: n.w, h: n.h }, fallback);
          if (sub && sub !== fallback) {
            const nk = `${key}~${i++}`;
            images[nk] = sub;
            n._imageXObject = nk;
          }
        }
      }
      // Outline text runs to real <path>s (self-contained, no font at render
      // time). Un-rotated runs only; a null result keeps the <text> fallback.
      if (outlineText) {
        for (const n of nodes) {
          if (n.kind !== 'text' || !n.text || (n.rot && Math.abs(n.rot) > 0.5)) continue;
          const lines = await outlineText({ text: n.text, fontFamily: n.fontFamily ?? '', fontWeight: n.fontWeight ?? 400, fontSize: n.fontSize ?? 12 });
          if (lines && lines.length) n._outlinePath = lines;
        }
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

// ── raster inspection (the /verify Lolly-Imprint scan) ─────────────────────────

/** The result of decoding a PDF's embedded raster image XObjects for pixel-domain
 *  inspection. `skipped`/`skippedFilters` count the image XObjects present that
 *  this path can't yet turn into pixels — TIFF-predictor Flate (Predictor 2) and
 *  JPXDecode / CCITTFax / JBIG2 — so a caller can report the coverage gap honestly
 *  instead of reading "no hit" as "nothing there". jsPDF's own FlateDecode PNG-
 *  predictor rasters (/Predictor 15) ARE decoded now (via unfilterPng), so Lolly's
 *  own PDF PNG embeds are readable by the Lolly-Imprint scan. */
export interface PdfImageScan {
  /** Image XObjects decoded to browser-readable bytes, native stored resolution. */
  images: Array<{ bytes: Uint8Array; mime: string }>;
  /** How many image XObjects were found but NOT decodable to pixels by this path. */
  skipped: number;
  /** Distinct undecodable filter names seen (for the coverage log). */
  skippedFilters: string[];
}

/**
 * Enumerate + decode a PDF/.ai's raster image XObjects to browser-decodable bytes,
 * for pixel-domain inspection (the Lolly-Imprint check on /verify). Reuses the
 * exact decode `imageBytes` uses — DCTDecode (JPEG) pass-through and Flate
 * RGB/Gray (no predictor OR a PNG predictor, unfiltered via unfilterPng) — at
 * each image's NATIVE stored resolution (NO resize, so the watermark's 8×8 grid
 * stays intact). Walks page + nested-form
 * resources, dedupes image streams shared across pages (a logo reused on every
 * slide decodes once), caps the count, and reports what it couldn't decode.
 * Read-only: never touches storeUserUpload. Never throws for a per-image fault —
 * a bad XObject is counted as skipped and the walk continues.
 */
export async function extractPdfImageBytes(
  file: File | Blob,
  { max = 32 }: { max?: number } = {},
): Promise<PdfImageScan> {
  const doc = await loadDoc(file);
  const ctx = doc.context;
  const images: Array<{ bytes: Uint8Array; mime: string }> = [];
  const skippedFilters = new Set<string>();
  let skipped = 0;
  const seen = new Set<PDFRawStream>();
  const pageCount = doc.getPageCount();
  for (let p = 0; p < pageCount && images.length < max; p++) {
    const imageStreams = new Map<string, ImageDesc>();
    try {
      const node = doc.getPage(p).node;
      extractResources(ctx, getKey(ctx, node, 'Resources'), imageStreams, 0);
    } catch { continue; } // a malformed page's resources — skip it, keep scanning
    for (const desc of imageStreams.values()) {
      if (images.length >= max) break;
      if (seen.has(desc.stream)) continue;
      seen.add(desc.stream);
      const got = await imageBytes(desc, () => {});
      if (got) images.push({ bytes: got.bytes, mime: got.mime });
      else { skipped++; skippedFilters.add(desc.filter[desc.filter.length - 1] || 'raw'); }
    }
  }
  return { images, skipped, skippedFilters: [...skippedFilters] };
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
