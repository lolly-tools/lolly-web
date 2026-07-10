// Design Import — DOM parser (Figma SVG / any SVG / Penpot .penpot|.zip → Layout Studio boxes).
//
// This is the SHELL half of the import feature: it lives in the web shell because it
// needs the browser DOM (DOMParser + a live-mounted <svg> for getBBox/getCTM) and the
// shell's user-asset store. It is dynamic-imported by free-canvas.js. All the PURE,
// DOM-free geometry/colour/text mapping lives in engine/src/design-map.js and is shared
// via the '@lolly/engine' barrel (same specifier every other view uses, e.g. tool.js).
//
// Strategy for geometry (the load-bearing trick): we can't reliably parse arbitrary SVG
// transform stacks by hand, so instead we mount the sanitized SVG offscreen and let the
// browser resolve every transform for us. For each visual leaf we read:
//   * el.getBBox()  → the element's LOCAL, unrotated bounding box (in its own user space)
//   * el.getCTM()   → the matrix from that local space to the ROOT svg user space (= our
//                     canvas coordinates, because we size the mount to the viewBox)
// design-map.boxGeomFromBBox(bbox, ctm) then folds those into a top-left x/y/w/h + rotation.
// The mount MUST be visible-in-layout (visibility:hidden, NOT display:none) — display:none
// zeroes getBBox()/getCTM() and every element would collapse to 0×0.
//
// Security: imported SVG is untrusted. sanitizeSvg() strips <script>, <foreignObject>,
// every on* handler and javascript: hrefs BEFORE the markup is ever parsed into a live
// document, and any SVG we flatten-and-store is sanitized a SECOND time by storeUserUpload
// (DOMPurify on ingest). Scripts never run and never reach disk.

import { storeUserUpload } from './picker.ts';
import {
  boxGeomFromBBox,
  finalizeBoxes,
  safeColor,
  parsePenpotContent,
  penpotShapeToNode,
  figmaNodesToNodes,
} from '@lolly/engine';
import { unzip, unzipSync, strFromU8, type UnzipFileInfo } from 'fflate';
// Figma .fig decode: a canvas.fig is a Kiwi binary (self-describing schema + data).
// The schema chunk is raw-DEFLATE (native DecompressionStream); the data chunk is zstd
// (fzstd — pure JS, by the fflate author). kiwi-schema is Evan Wallace's official decoder.
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { Decompress as ZstdDecompress } from 'fzstd';
import type { HostV1, AssetRef } from '../../../../engine/src/bridge/host-v1.ts';

// A 2-D affine matrix (a,b,c,d,e,f), as read from getCTM / rebuilt for flatten transforms.
interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number; }
// Inherited paint accumulated down the <g> tree.
interface Inherited { fill: string | null; opacity: number; }
// The result shape every parse branch returns (feeds Layout Studio).
interface DesignImportResult { boxes: unknown[]; width: number; height: number; background: string; }
// Options for svgToNodes (Penpot pages set penpot + zipFiles).
interface SvgToNodesOpts {
  host: HostV1 | undefined;
  warn: (msg: string) => void;
  penpot?: boolean;
  zipFiles?: Record<string, Uint8Array> | null;
}
// Per-element context threaded through elementToNode / flattenToImage.
interface ElementCtx {
  host: HostV1 | undefined;
  warn: (msg: string) => void;
  inherited: Inherited;
  imageCache: Map<string, AssetRef>;
  penpot: boolean;
  zipFiles: Record<string, Uint8Array> | null;
  defsHtml: () => string;
}

// Hard ceiling so a pathological file can't lock the tab building tens of thousands
// of boxes. Anything past this is dropped with a warning.
const MAX_ELEMENTS = 2000;

// Byte bounds for the import pipeline. The picked file is read whole into memory
// and several branches make further copies (text decode, unzip, zstd), so every
// stage is capped: the input itself, each zip entry's DECLARED inflated size and
// their sum (the classic zip bomb hides behind a tiny compressed payload), and
// the two .fig decompressors, which are streamed so a lying header is stopped at
// the cap rather than trusted. All sit far above any real design export.
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FIG_SCHEMA_BYTES = 64 * 1024 * 1024;
const MAX_FIG_DATA_BYTES = 256 * 1024 * 1024;

// Elements that are never drawn on their own (definitions / metadata / containers).
// <g> is intentionally NOT here: it's a container we recurse into, not a leaf.
const SKIP_TAGS = new Set([
  'defs', 'clippath', 'mask', 'symbol', 'style', 'script',
  'title', 'desc', 'metadata', 'filter', 'lineargradient',
  'radialgradient', 'pattern', 'marker',
]);

// Penpot writes its extra data as `penpot:*` attributes. DOMParser keeps the literal
// qualified name, but namespace handling varies, so we look it up defensively.
const PENPOT_NS_CANDIDATES = [
  'http://penpot.app/svg',
  'https://penpot.app/svg',
  'http://penpot.app/xmlns',
];

/**
 * Parse a design file into a Layout Studio boxes array.
 * @param {File|Blob} file
 * @param {{ host: object, log?: (msg: string) => void, interactive?: boolean }} ctx —
 *   `interactive` lets a multi-page PDF/.ai ask which page via the shared page-picker
 *   dialog (cancelling throws 'Import cancelled.'); without it the first page imports
 *   with a warn, the headless-safe default.
 * @returns {Promise<{ boxes: object[], width: number, height: number, background: string }>}
 */
export async function parseDesignFile(
  file: File | Blob,
  { host, log, interactive }: { host?: HostV1; log?: (msg: string) => void; interactive?: boolean } = {},
): Promise<DesignImportResult> {
  const warn: (msg: string) => void = typeof log === 'function' ? log : () => {};
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`This file is too large to import (over ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB).`);
  }
  const buf = new Uint8Array(await file.arrayBuffer());

  // PDF / Adobe Illustrator: a modern .ai saved with PDF compatibility (the default) IS a
  // PDF, so both route to the PDF interpreter. The heavy pdf-lib parser is its own lazy chunk.
  if (isPdf(buf)) {
    const { parsePdfFile } = await import('./pdf-import.ts');
    return parsePdfFile(file, { host: host as HostV1, warn, interactive });
  }

  // Raw InDesign .indd is a proprietary binary database with no open parser — guide the
  // user to InDesign's open interchange format (IDML) instead of failing opaquely.
  if (isIndd(buf, file && (file as File).name)) {
    throw new Error('A raw .indd file can’t be read directly. In InDesign choose File → Export → InDesign Markup (.idml) and import the .idml.');
  }

  // Sniff: Penpot exports, Figma .fig and InDesign .idml are all ZIPs (magic "PK\x03\x04").
  // Unzip once and route by contents.
  const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  if (isZip) {
    const files = await unzipAsync(buf);
    if (isIdml(files)) {
      const { parseIdmlZip } = await import('./idml-import.ts');
      return parseIdmlZip(files, { host, warn });
    }
    if (files['canvas.fig']) return parseFig(files, { host, warn });
    return parsePenpotZip(files, { host, warn });
  }

  // Otherwise treat the bytes as SVG text.
  const svgText = new TextDecoder('utf-8').decode(buf);
  const svgEl = sanitizeSvg(svgText);
  if (!svgEl) throw new Error('This file isn’t a readable SVG. Export your design as SVG and try again.');

  const { nodes, width, height } = await svgToNodes(svgEl, { host, warn });
  return { boxes: finalizeBoxes(nodes), width, height, background: '#ffffff' };
}

// ---------------------------------------------------------------------------
// Format sniffing
// ---------------------------------------------------------------------------

// A PDF (and a PDF-compatible .ai) begins with "%PDF-" within the first bytes — the spec
// permits a little leading junk, so scan a small window.
function isPdf(buf: Uint8Array): boolean {
  const limit = Math.min(buf.length - 4, 1024);
  for (let i = 0; i <= limit; i++) {
    if (buf[i] === 0x25 && buf[i + 1] === 0x50 && buf[i + 2] === 0x44 && buf[i + 3] === 0x46) return true; // %PDF
  }
  return false;
}

// InDesign .indd documents open with a fixed 16-byte master-page GUID. Match that (or the
// filename as a fallback) so we can point the user at IDML instead of choking on binary.
const INDD_MAGIC = [0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d];
function isIndd(buf: Uint8Array, name?: unknown): boolean {
  if (buf.length >= 16 && INDD_MAGIC.every((b, i) => buf[i] === b)) return true;
  return typeof name === 'string' && /\.indd$/i.test(name.trim());
}

// An IDML package is a ZIP with a root `designmap.xml` (and a `mimetype` naming the format).
function isIdml(files: Record<string, Uint8Array>): boolean {
  if (files['designmap.xml']) return true;
  const mt = files['mimetype'];
  if (mt) { try { return /indesign-idml|idml/i.test(strFromU8(mt)); } catch { /* */ } }
  return false;
}

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

/**
 * Parse untrusted SVG text into a live (but inert) <svg> element, stripping anything
 * executable or navigable. Returns the root <svg> element (belonging to a detached
 * document) or null if the text isn't parseable SVG.
 */
function sanitizeSvg(svgText: string): SVGSVGElement | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch {
    return null;
  }
  // A parse error surfaces as a <parsererror> element in the result.
  if (!doc || doc.querySelector('parsererror')) {
    // Some browsers still yield a usable root alongside a soft parsererror; only bail
    // if there's no <svg> at all.
    if (!doc || !doc.querySelector('svg')) return null;
  }
  const svg = doc.querySelector('svg');
  if (!svg) return null;

  // 1) Drop executable / escape-hatch elements entirely. <style> can pull external
  //    resources via @import / url(...), so it goes too — we only read geometry + paint.
  svg.querySelectorAll('script, foreignObject, style').forEach((n) => n.remove());

  // 2) Walk every element: strip on* handlers, and any href/src that is not a data:
  //    URI or a local #fragment. This is the load-bearing PRIVACY guard — the imported
  //    SVG is untrusted and gets mounted live (to measure it), so an external
  //    <image href="https://tracker/…"> / xlink:href would otherwise fire a network
  //    beacon on import. Only embedded (data:) and internal (#id) refs survive; external
  //    images simply don't import (matching the on-device, nothing-leaves-the-device stance).
  const all = svg.querySelectorAll('*');
  const scrub = (el: Element) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
      if (name === 'href' || name === 'xlink:href' || name === 'src') {
        const v = String(attr.value || '').trim();
        const safe = /^data:/i.test(v) || v.startsWith('#');
        if (!safe) el.removeAttribute(attr.name);
      }
    }
  };
  scrub(svg);
  all.forEach(scrub);

  return svg;
}

// ---------------------------------------------------------------------------
// SVG → DesignNode[]
// ---------------------------------------------------------------------------

/**
 * Mount a sanitized <svg> offscreen, walk its visual leaves, and produce DesignNodes.
 * @param {SVGSVGElement} svgEl  root svg (from sanitizeSvg or a Penpot page)
 * @param {{ host, warn, penpot?: boolean, zipFiles?: object }} opts
 */
async function svgToNodes(
  svgEl: SVGSVGElement,
  { host, warn, penpot = false, zipFiles = null }: SvgToNodesOpts,
): Promise<{ nodes: any[]; width: number; height: number }> {
  // Determine the canvas size from the viewBox (preferred — it's the true user space
  // that getCTM maps into) or fall back to width/height attributes.
  const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
  let canvasW = vb && vb.width ? vb.width : parseFloat(svgEl.getAttribute('width') as string) || 0;
  let canvasH = vb && vb.height ? vb.height : parseFloat(svgEl.getAttribute('height') as string) || 0;
  if (!canvasW || !canvasH) { canvasW = canvasW || 1080; canvasH = canvasH || 1080; }

  // Import the node so it belongs to the main document, then size + hide it. It must
  // participate in layout (visibility:hidden) for getBBox/getCTM to return real numbers.
  const mount = document.importNode(svgEl, true);
  mount.setAttribute('width', String(canvasW));
  mount.setAttribute('height', String(canvasH));
  mount.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
  document.body.appendChild(mount);

  const nodes: any[] = [];
  const imageCache = new Map<string, AssetRef>(); // href → AssetRef (dedupe identical images)
  // Serialize the root <defs> once, not per flattened element (they all embed the same
  // block) — avoids O(n·|defs|) re-serialization on a defs-heavy file.
  let defsCache: string | undefined;
  const defsHtml = () => (defsCache !== undefined ? defsCache : (defsCache = rootDefsHtml(mount)));
  let count = 0;      // leaf boxes emitted
  let visited = 0;    // ALL elements walked (incl. containers) — bounds a container-only DoS
  let truncated = false;

  try {
    // Depth-first, document order = paint order (back-to-front).
    const walk = async (el: Element, inherited: Inherited) => {
      // Cap BOTH leaves and total nodes: a file made of tens of thousands of nested
      // empty <g>/<svg> containers emits no leaves but would still recurse unbounded.
      if (count >= MAX_ELEMENTS || ++visited > MAX_ELEMENTS * 8) { truncated = true; return; }
      const tag = (el.tagName || '').toLowerCase();
      if (SKIP_TAGS.has(tag)) return;

      // Accumulate inherited fill + opacity from ancestor <g>s.
      const fillAttr = el.getAttribute('fill');
      const opAttr = el.getAttribute('opacity');
      const nextInherited: Inherited = {
        fill: fillAttr != null ? fillAttr : inherited.fill,
        opacity: inherited.opacity * (opAttr != null && opAttr !== '' ? clamp01(parseFloat(opAttr)) : 1),
      };

      if (tag === 'g' || tag === 'svg' || tag === 'a') {
        // Container: recurse; it draws nothing itself.
        for (const child of Array.from(el.children)) {
          await walk(child, nextInherited);
        }
        return;
      }

      count += 1;
      try {
        const node = await elementToNode(el, tag, {
          host, warn, inherited: nextInherited, imageCache,
          penpot, zipFiles, defsHtml,
        });
        if (node) nodes.push(node);
      } catch (err) {
        warn(`Skipped a <${tag}> that couldn’t be imported: ${String((err as Error) && (err as Error).message || err)}`);
      }
    };

    await walk(mount, { fill: null, opacity: 1 });
  } finally {
    mount.remove();
  }

  if (truncated) warn(`This design has a lot of elements — only the first ${MAX_ELEMENTS} were imported.`);

  return { nodes, width: Math.round(canvasW), height: Math.round(canvasH) };
}

/**
 * Map a single visual leaf element to a DesignNode (or null to skip).
 */
async function elementToNode(el: Element, tag: string, ctx: ElementCtx): Promise<any> {
  const { host, warn, inherited, imageCache, penpot, zipFiles } = ctx;

  // Geometry: local bbox → world box via the CTM. getBBox throws for a few edge cases
  // (empty text, unrenderable defs) — the caller's try/catch handles it.
  const bbox = (el as SVGGraphicsElement).getBBox();
  const ctm = (el as SVGGraphicsElement).getCTM();
  const m: Matrix = ctm ? { a: ctm.a, b: ctm.b, c: ctm.c, d: ctm.d, e: ctm.e, f: ctm.f }
                : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const geom = boxGeomFromBBox({ x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height }, m);

  // Resolved element opacity (own opacity × ancestor opacity), 0..100.
  const ownOp = attrNum(el, 'opacity');
  const opacity = clamp01((ownOp == null ? 1 : ownOp) * inherited.opacity) * 100;

  // Resolve the paint. 'none'/'currentColor' → '' (no fill); gradient/pattern → flatten.
  const rawFill = firstDefined(styleProp(el, 'fill'), el.getAttribute('fill'), inherited.fill);
  const fillIsUrl = typeof rawFill === 'string' && /^url\(/i.test(rawFill.trim());

  const base = {
    x: geom.x, y: geom.y, w: geom.w, h: geom.h, rot: geom.rot,
    opacity,
  };

  // --- Penpot per-element overrides (read before we branch on kind) ---
  let penpotContent: any = null;
  if (penpot) {
    const pr = penpotAttr(el, 'rotation');
    if (pr != null && pr !== '') base.rot = parseFloat(pr) || base.rot;
    const pOp = penpotAttr(el, 'fill-opacity');
    if (pOp != null && pOp !== '') base.opacity = clamp01(parseFloat(pOp)) * 100;
    const pc = penpotAttr(el, 'content');
    if (pc) { try { penpotContent = parsePenpotContent(JSON.parse(pc)); } catch { /* ignore bad json */ } }
  }

  // ---- <image> → image box ----
  if (tag === 'image') {
    const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || el.getAttribute('xlink:href');
    const ref = href ? await storeImage(host, href, imageCache, warn) : null;
    if (ref) {
      // Store the WHOLE AssetRef (with its object URL) — see design-map.nodeToBox: setInput
      // does not re-resolve, so an id-only ref would render as a broken image.
      return { kind: 'image', ...base, image: ref, fit: 'cover' };
    }
    // Couldn't store — degrade to a plain placeholder box rather than dropping it.
    return { kind: 'box', ...base, fill: '' };
  }

  // ---- Penpot fill-image-id → embedded raster in the zip ----
  if (penpot) {
    const imgId = penpotAttr(el, 'fill-image-id');
    if (imgId && zipFiles) {
      const ref = await storeZipImage(host, zipFiles, imgId, imageCache, warn);
      if (ref) return { kind: 'image', ...base, image: ref, fit: 'cover' };
    }
  }

  // ---- <text> / tspan → text box ----
  if (tag === 'text') {
    const info = penpotContent || readTextContent(el);
    const penFill = penpot ? penpotAttr(el, 'fill-color') : null;
    return {
      kind: 'text',
      ...base,
      text: info.text || '',
      fg: safeColor(info.fg || penFill || styleProp(el, 'fill') || el.getAttribute('fill') || inherited.fill || '#000000', '#000000'),
      fontSize: info.fontSize || attrNum(el, 'font-size') || parseFloat(styleProp(el, 'font-size')) || 16,
      fontWeight: info.fontWeight || el.getAttribute('font-weight') || styleProp(el, 'font-weight') || '400',
      fontFamily: info.fontFamily || el.getAttribute('font-family') || styleProp(el, 'font-family') || '',
      textAlign: info.textAlign || anchorToAlign(styleProp(el, 'text-anchor') || el.getAttribute('text-anchor')),
      lineHeight: info.lineHeight || 1.2,
    };
  }

  // ---- Vector fills we can't model cleanly → flatten to an embedded image ----
  // <path> (arbitrary geometry) and any gradient/pattern/image url(#…) fill lose
  // fidelity as a plain rectangle, so we rasterise/embed them as an SVG snippet.
  if (tag === 'path' || tag === 'polygon' || tag === 'polyline' || tag === 'line' || fillIsUrl) {
    const ref = await flattenToImage(el, m, ctx);
    if (ref) {
      // The flattened SVG already bakes in the element's transform, so the image box
      // is an axis-aligned world rect with no extra rotation.
      const wb = worldBBox(bbox, m);
      return { kind: 'image', x: wb.x, y: wb.y, w: wb.w, h: wb.h, rot: 0, opacity: base.opacity, image: ref, fit: 'fill' };
    }
    // Flatten failed → approximate as a solid box using the element's fill.
    return { kind: 'box', ...base, fill: colorOrEmpty(rawFill) };
  }

  // ---- Simple shapes → box ----
  const penFill = penpot ? penpotAttr(el, 'fill-color') : null;
  const node: any = { kind: 'box', ...base, fill: colorOrEmpty(penFill || rawFill) };

  if (tag === 'circle' || tag === 'ellipse') {
    node.shape = 'ellipse';
  } else if (tag === 'rect') {
    const rx = attrNum(el, 'rx') || attrNum(el, 'ry') || 0;
    const pr1 = penpot ? penpotAttr(el, 'r1') : null;
    const radius = (pr1 != null && pr1 !== '') ? parseFloat(pr1) : rx;
    if (radius > 0) { node.shape = 'rounded'; node.radius = radius; }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Flatten-to-image fallback
// ---------------------------------------------------------------------------

/**
 * Render one element (with its gradients/clipPaths) into a standalone SVG whose viewBox
 * is the element's WORLD bounding box, store it as a user asset, and return the AssetRef.
 * The element's own transform is stripped and re-applied via a wrapping <g matrix(CTM)>
 * so it lands at the same world coordinates as the viewBox.
 */
async function flattenToImage(el: Element, m: Matrix, ctx: ElementCtx): Promise<AssetRef | null> {
  const { host, warn, imageCache, defsHtml } = ctx;
  try {
    const bbox = (el as SVGGraphicsElement).getBBox();
    const wb = worldBBox(bbox, m);
    if (wb.w < 1 || wb.h < 1) return null;

    const clone = el.cloneNode(true) as SVGElement;
    clone.removeAttribute('transform'); // its transform is re-expressed by the wrapping <g>
    // The image box re-applies the element's own opacity (base.opacity), so strip it from
    // the embedded snippet to avoid squaring it. fill-opacity is paint (not in base) — keep.
    clone.removeAttribute('opacity');
    if (clone.style) clone.style.removeProperty('opacity');

    const defs = defsHtml ? defsHtml() : '';
    const matrix = `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `viewBox="${wb.x} ${wb.y} ${wb.w} ${wb.h}" width="${wb.w}" height="${wb.h}">` +
      (defs ? `<defs>${defs}</defs>` : '') +
      `<g transform="${matrix}">${new XMLSerializer().serializeToString(clone)}</g>` +
      `</svg>`;

    // Dedupe identical snippets (e.g. a repeated icon) by their serialized bytes.
    const key = 'flat:' + svg;
    if (imageCache.has(key)) return imageCache.get(key)!;

    const fileName = `import-${Date.now()}-${imageCache.size}.svg`;
    const file = new File([svg], fileName, { type: 'image/svg+xml' });
    // storeUserUpload re-sanitizes the SVG (DOMPurify) on ingest — second line of defence.
    const ref = await storeUserUpload(host as Parameters<typeof storeUserUpload>[0], file);
    imageCache.set(key, ref);
    return ref;
  } catch (err) {
    warn(`Couldn’t embed a vector element (${String((err as Error) && (err as Error).message || err)}); using a flat colour instead.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Image storage
// ---------------------------------------------------------------------------

/**
 * Store an <image> href (data: URI or external URL) as a user asset, deduped by href.
 * Returns the AssetRef or null on failure (caller degrades gracefully).
 */
async function storeImage(host: HostV1 | undefined, href: string, imageCache: Map<string, AssetRef>, warn: (msg: string) => void): Promise<AssetRef | null> {
  if (imageCache.has(href)) return imageCache.get(href)!;
  // Defence-in-depth: only embedded (data:) images are imported. sanitizeSvg already
  // strips external hrefs before the mount, but never fetch an off-device URL from an
  // untrusted design file (privacy / SSRF).
  if (!/^data:/i.test(String(href).trim())) {
    warn('Skipped an external image — only images embedded in the design are imported.');
    return null;
  }
  try {
    const resp = await fetch(href);
    const blob = await resp.blob();
    const type = blob.type || 'image/png';
    const ext = extFromType(type);
    const file = new File([blob], `import-${Date.now()}-${imageCache.size}.${ext}`, { type });
    const ref = await storeUserUpload(host as Parameters<typeof storeUserUpload>[0], file);
    imageCache.set(href, ref);
    return ref;
  } catch (err) {
    warn(`Couldn’t import an image (${String((err as Error) && (err as Error).message || err)}).`);
    return null;
  }
}

/**
 * Store a Penpot embedded image (looked up in the zip by its asset id).
 */
async function storeZipImage(host: HostV1 | undefined, zipFiles: Record<string, Uint8Array>, imgId: string, imageCache: Map<string, AssetRef>, warn: (msg: string) => void): Promise<AssetRef | null> {
  const cacheKey = 'zip:' + imgId;
  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey)!;
  try {
    // Penpot stores media under a path containing the asset id.
    const path = Object.keys(zipFiles).find((p) => p.includes(imgId) && /\.(png|jpe?g|webp|gif|svg)$/i.test(p));
    if (!path) return null;
    const bytes = zipFiles[path]!;
    const ext = (path.split('.').pop() || 'png').toLowerCase();
    const type = typeFromExt(ext);
    const file = new File([bytes as BlobPart], `penpot-${imgId}.${ext}`, { type });
    const ref = await storeUserUpload(host as Parameters<typeof storeUserUpload>[0], file);
    imageCache.set(cacheKey, ref);
    return ref;
  } catch (err) {
    warn(`Couldn’t import a Penpot image (${String((err as Error) && (err as Error).message || err)}).`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Penpot ZIP
// ---------------------------------------------------------------------------

async function parsePenpotZip(files: Record<string, Uint8Array>, { host, warn }: { host: HostV1 | undefined; warn: (msg: string) => void }): Promise<DesignImportResult> {
  // The current Penpot `.penpot` export (binfile-v3) is a ZIP of per-shape JSON — no
  // page SVGs. Detect it by its manifest and shape-file layout and parse the JSON.
  const manifest = files['manifest.json'] ? safeJsonParse(strFromU8(files['manifest.json'])) : null;
  const isExportFiles = manifest && typeof manifest.type === 'string' && /export-files/.test(manifest.type);
  const hasShapeJson = Object.keys(files).some((p) => /\/pages\/[^/]+\/[^/]+\.json$/i.test(p));
  if (isExportFiles && hasShapeJson) {
    return parsePenpotBinfile(files, manifest, { host, warn });
  }

  // Legacy path: the standard SVG export (a ZIP of page SVGs with penpot: metadata),
  // or a plain SVG zipped up. Overlay every page onto one canvas.
  const svgPaths = Object.keys(files).filter((p) => /\.svg$/i.test(p) && !/[/\\]$/.test(p));
  if (svgPaths.length) {
    const allNodes: any[] = [];
    let width = 0, height = 0;
    for (const path of svgPaths.sort()) {
      let svgText: string;
      try { svgText = strFromU8(files[path]!); }
      catch { warn(`Skipped a Penpot page that wasn’t text (${path}).`); continue; }
      const svgEl = sanitizeSvg(svgText);
      if (!svgEl) { warn(`Skipped an unreadable Penpot page (${path}).`); continue; }
      const { nodes, width: w, height: h } = await svgToNodes(svgEl, { host, warn, penpot: true, zipFiles: files });
      allNodes.push(...nodes);
      width = Math.max(width, w); height = Math.max(height, h);
    }
    if (!allNodes.length) throw new Error('This Penpot file didn’t contain any importable pages.');
    return { boxes: finalizeBoxes(allNodes), width: width || 1080, height: height || 1080, background: '#ffffff' };
  }

  throw new Error('Could not read this Penpot file. In Penpot use “Export as .penpot” (or export the board as SVG) and import that.');
}

// Parse a Penpot binfile-v3 export (ZIP of per-shape JSON). Geometry is authoritative
// data (selrect + rotation), so the pure engine mapper (penpotShapeToNode) does the
// shape→box work; here we only walk the file structure, order shapes, load embedded
// media, and frame the result.
async function parsePenpotBinfile(files: Record<string, Uint8Array>, manifest: any, { host, warn }: { host: HostV1 | undefined; warn: (msg: string) => void }): Promise<DesignImportResult> {
  const fileId = Array.isArray(manifest.files) && manifest.files[0] ? manifest.files[0].id : null;
  if (!fileId) throw new Error('This Penpot file has no importable file.');

  // Group shape JSONs by page: files/<fid>/pages/<pid>/<shapeid>.json
  const pageDir = `files/${fileId}/pages/`;
  const pageShapes = new Map<string, string[]>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(pageDir)) continue;
    const m = path.slice(pageDir.length).match(/^([^/]+)\/([^/]+)\.json$/i);
    if (m) { if (!pageShapes.has(m[1]!)) pageShapes.set(m[1]!, []); pageShapes.get(m[1]!)!.push(path); }
  }
  if (!pageShapes.size) throw new Error('This Penpot file has no pages to import.');

  // Import the first page (by declared index).
  const pageIndex = (pid: string) => {
    const meta = files[`${pageDir}${pid}.json`] ? safeJsonParse(strFromU8(files[`${pageDir}${pid}.json`]!)) : null;
    return meta && Number.isFinite(meta.index) ? meta.index : 0;
  };
  const pageIds = [...pageShapes.keys()].sort((a, b) => pageIndex(a) - pageIndex(b));
  const pageId = pageIds[0]!;
  if (pageIds.length > 1) warn(`Imported the first of ${pageIds.length} pages.`);

  const shapesById: Record<string, any> = {};
  for (const path of pageShapes.get(pageId)!) {
    const shape = safeJsonParse(strFromU8(files[path]!));
    if (shape && shape.id) shapesById[shape.id] = shape;
  }

  const nodes: any[] = [];
  const imageCache = new Map<string, AssetRef>();
  for (const shape of orderPenpotShapes(shapesById)) {
    let node: any = null;
    try { node = penpotShapeToNode(shape); } catch { node = null; }
    if (!node) continue;
    if (node._fillImageId) {
      const ref = await loadPenpotMedia(host, files, fileId, node._fillImageId, imageCache, warn);
      if (ref) node.image = ref; else node.kind = 'box';
      delete node._fillImageId;
    }
    nodes.push(node);
  }
  if (!nodes.length) throw new Error('This Penpot file has no importable shapes on its first page.');

  const { width, height } = shiftToOrigin(nodes);
  return { boxes: finalizeBoxes(nodes), width, height, background: '#ffffff' };
}

function safeJsonParse(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

// DFS from the root frame following each container's `shapes` array (paint order,
// back-to-front); append any unreachable orphans in map order. penpotShapeToNode drops
// the root frame itself, so it just seeds the order.
function orderPenpotShapes(shapesById: Record<string, any>): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const s = shapesById[id];
    if (!s || seen.has(id)) return;
    seen.add(id);
    out.push(s);
    const kids = Array.isArray(s.shapes) ? s.shapes : [];
    for (const k of kids) visit(k);
  };
  visit('00000000-0000-0000-0000-000000000000');
  for (const id of Object.keys(shapesById)) visit(id);
  return out;
}

// Resolve a Penpot image fill to bytes and store it: fillImage.id → the media meta json
// (→ mediaId + mtype) → the binary blob under objects/. Returns a full AssetRef or null.
async function loadPenpotMedia(host: HostV1 | undefined, files: Record<string, Uint8Array>, fileId: string, fillImageId: string, cache: Map<string, AssetRef>, warn: (msg: string) => void): Promise<AssetRef | null> {
  const key = 'ppmedia:' + fillImageId;
  if (cache.has(key)) return cache.get(key)!;
  try {
    let mediaId = fillImageId, mtype = 'image/png';
    const metaPath = `files/${fileId}/media/${fillImageId}.json`;
    if (files[metaPath]) {
      const meta = safeJsonParse(strFromU8(files[metaPath]!));
      if (meta) { mediaId = meta.mediaId || meta.id || mediaId; mtype = meta.mtype || mtype; }
    }
    const objPath = Object.keys(files).find((p) => p.startsWith(`objects/${mediaId}.`) && !/\.json$/i.test(p));
    if (!objPath) { warn('Couldn’t find an embedded Penpot image.'); return null; }
    const ext = (objPath.split('.').pop() || 'png').toLowerCase();
    const file = new File([files[objPath]! as BlobPart], `penpot-${mediaId}.${ext}`, { type: mtype });
    const ref = await storeUserUpload(host as Parameters<typeof storeUserUpload>[0], file);
    cache.set(key, ref);
    return ref;
  } catch (err) {
    warn(`Couldn’t import a Penpot image (${String((err as Error) && (err as Error).message || err)}).`);
    return null;
  }
}

// Translate all nodes so the union of their rects starts at (0,0); return the canvas
// size. (Penpot shape coords are absolute page coords — a board rarely sits at origin.)
function shiftToOrigin(nodes: any[]): { width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  }
  if (!isFinite(minX)) return { width: 1080, height: 1080 };
  for (const n of nodes) { n.x -= minX; n.y -= minY; }
  return { width: Math.max(1, Math.round(maxX - minX)), height: Math.max(1, Math.round(maxY - minY)) };
}

// ---------------------------------------------------------------------------
// Figma .fig (Kiwi binary)
// ---------------------------------------------------------------------------

// A .fig is a ZIP { canvas.fig, images/<hash>, thumbnail.png, meta.json }. canvas.fig is:
//   "fig-kiwi"(8) | version u32le(4) | schemaLen u32le | schema(deflate-raw) | dataLen u32le | data(zstd)
// The Kiwi schema is embedded (self-describing) so it decodes any file version — but Figma
// calls the format an unstable internal detail, so this may break on future format changes.
async function parseFig(files: Record<string, Uint8Array>, { host, warn }: { host: HostV1 | undefined; warn: (msg: string) => void }): Promise<DesignImportResult> {
  const canvasFig = files['canvas.fig'];
  if (!canvasFig || !canvasFig.length) throw new Error('This .fig has no canvas data.');
  let doc: any;
  try { doc = await decodeCanvasFig(canvasFig); }
  catch (err) {
    throw new Error('Couldn’t read this .fig — Figma may have changed its file format. Try exporting the frame as SVG instead. (' + String((err as Error) && (err as Error).message || err) + ')');
  }
  const nodeChanges = doc && doc.nodeChanges;
  if (!Array.isArray(nodeChanges) || !nodeChanges.length) throw new Error('This .fig contained no nodes.');

  const nodes = figmaNodesToNodes(nodeChanges, doc.blobs);
  if (!nodes.length) throw new Error('This .fig has no visible shapes on its first page.');

  // Resolve image fills (images/<hash>) and reconstructed vector paths into asset refs.
  const imageCache = new Map<string, AssetRef>();
  for (const n of nodes) {
    if (n._vectorPath) {
      const ref = await storeFigVector(host, n._vectorPath, n._vectorFill, n._vectorStroke, n._vectorSize, imageCache, warn);
      if (ref) n.image = ref; else { n.kind = 'box'; n.fill = (n._vectorFill && n._vectorFill !== 'none') ? n._vectorFill : ''; }
      delete n._vectorPath; delete n._vectorFill; delete n._vectorStroke; delete n._vectorSize;
    } else if (n._imageHash) {
      const ref = await loadFigImage(host, files, n._imageHash, imageCache, warn);
      if (ref) n.image = ref; else n.kind = 'box';
      delete n._imageHash;
    }
  }

  const { width, height } = shiftToOrigin(nodes);
  return { boxes: finalizeBoxes(nodes, { prefix: 'f' }), width, height, background: '#ffffff' };
}

async function decodeCanvasFig(bytes: Uint8Array): Promise<any> {
  const magic = new TextDecoder('latin1').decode(bytes.slice(0, 8));
  if (magic !== 'fig-kiwi') throw new Error('not a fig-kiwi file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12; // "fig-kiwi"(8) + version u32(4)
  if (off + 4 > bytes.length) throw new Error('truncated fig-kiwi header');
  const schemaLen = dv.getUint32(off, true); off += 4;
  if (off + schemaLen + 4 > bytes.length) throw new Error('fig-kiwi schema overruns the file');
  const schemaComp = bytes.subarray(off, off + schemaLen); off += schemaLen;
  const dataLen = dv.getUint32(off, true); off += 4;
  if (off + dataLen > bytes.length) throw new Error('fig-kiwi data overruns the file');
  const dataComp = bytes.subarray(off, off + dataLen);

  const schema = await inflateRawBytes(schemaComp, MAX_FIG_SCHEMA_BYTES); // raw DEFLATE (native)
  const data = zstdCapped(dataComp, MAX_FIG_DATA_BYTES);                  // zstd (fzstd)
  const compiled = compileSchema(decodeBinarySchema(schema));
  return compiled.decodeMessage(data);              // Figma's root type is "Message"
}

// Raw DEFLATE via the browser's native DecompressionStream (same primitive — and
// same chunked output cap — url-pack uses: the bomb is stopped at ~cap instead of
// its full expansion being allocated first).
async function inflateRawBytes(bytes: Uint8Array, cap: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {});
  w.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new Error('fig-kiwi schema expands too large');
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

// Streamed zstd with an output cap — fzstd's one-shot decompress() trusts the
// frame's declared content size, which a hostile file controls.
function zstdCapped(bytes: Uint8Array, cap: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const d = new ZstdDecompress((chunk) => {
    total += chunk.length;
    if (total > cap) throw new Error('fig-kiwi data expands too large');
    chunks.push(chunk);
  });
  d.push(bytes, true);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Store a Figma image blob (images/<hash>, extension-less — sniff the type) as a user asset.
async function loadFigImage(host: HostV1 | undefined, files: Record<string, Uint8Array>, hash: string | null, cache: Map<string, AssetRef>, warn: (msg: string) => void): Promise<AssetRef | null> {
  if (!hash) return null;
  if (cache.has(hash)) return cache.get(hash)!;
  try {
    const path = Object.keys(files).find((p) => p === 'images/' + hash || p.startsWith('images/' + hash));
    if (!path || !files[path] || !files[path]!.length) return null;
    const bytes = files[path]!;
    const mime = sniffImageMime(bytes);
    const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const file = new File([bytes as BlobPart], `fig-${String(hash).slice(0, 12)}.${ext}`, { type: mime });
    const ref = await storeUserUpload(host as Parameters<typeof storeUserUpload>[0], file);
    cache.set(hash, ref);
    return ref;
  } catch (err) {
    warn(`Couldn’t import a Figma image (${String((err as Error) && (err as Error).message || err)}).`);
    return null;
  }
}

// Rasterise a reconstructed Figma vector path into a standalone SVG image asset, placed at
// the node's rect (viewBox = the shape's local size). storeUserUpload re-sanitises the SVG.
async function storeFigVector(host: HostV1 | undefined, d: any, fill: any, stroke: any, size: any, cache: Map<string, AssetRef>, warn: (msg: string) => void): Promise<AssetRef | null> {
  try {
    const w = Math.max(1, Math.round((size && size.w) || 1));
    const h = Math.max(1, Math.round((size && size.h) || 1));
    const hex = (v: string, dflt: string): string => (/^#[0-9a-fA-F]{3,8}$/.test(v || '') ? v : dflt);
    const fillAttr = (fill === 'none') ? 'none' : hex(fill, '#000000');
    const strokeAttr = (stroke && stroke.color)
      ? ` stroke="${hex(stroke.color, '#000000')}" stroke-width="${Math.max(0.1, +stroke.width || 1)}"` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<path d="${String(d).replace(/"/g, '')}" fill="${fillAttr}"${strokeAttr}/></svg>`;
    if (cache.has('figvec:' + svg)) return cache.get('figvec:' + svg)!;
    const file = new File([svg], `fig-vector-${cache.size}.svg`, { type: 'image/svg+xml' });
    const ref = await storeUserUpload(host as Parameters<typeof storeUserUpload>[0], file);
    cache.set('figvec:' + svg, ref);
    return ref;
  } catch (err) {
    warn(`Couldn’t import a Figma vector (${String((err as Error) && (err as Error).message || err)}).`);
    return null;
  }
}

function sniffImageMime(b: Uint8Array): string {
  if (!b || b.length < 4) return 'image/png';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return 'image/png';
}

// unzip via fflate, mirroring shells/web/src/data-transfer.js (async offloads to a
// Worker in a real browser; sync fallback where no Worker exists, e.g. tests).
// The filter runs BEFORE each entry is inflated: an entry declaring an absurd
// uncompressed size — or a set of entries summing past the total cap — rejects
// the whole import instead of inflating a zip bomb into memory.
function unzipAsync(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  let total = 0;
  let bomb: string | null = null;
  const filter = (f: UnzipFileInfo): boolean => {
    total += f.originalSize || 0;
    if ((f.originalSize || 0) > MAX_ZIP_ENTRY_BYTES || total > MAX_ZIP_TOTAL_BYTES) {
      bomb = f.name;
      return false;
    }
    return true;
  };
  const guard = <T>(data: T): T => {
    if (bomb) throw new Error(`This archive expands too large to import (${bomb}).`);
    return data;
  };
  const HAS_WORKER = typeof Worker !== 'undefined';
  if (!HAS_WORKER) return Promise.resolve().then(() => guard(unzipSync(bytes, { filter })));
  return new Promise((resolve, reject) => {
    unzip(bytes, { filter }, (err, data) => {
      if (err) return reject(err);
      try { resolve(guard(data)); } catch (e) { reject(e); }
    });
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// World axis-aligned bbox: transform the four local-bbox corners by the CTM and take
// the min/max. Used to size the flatten viewBox + place flattened image boxes.
function worldBBox(bbox: { x: number; y: number; width: number; height: number }, m: Matrix): { x: number; y: number; w: number; h: number } {
  const pts = [
    [bbox.x, bbox.y],
    [bbox.x + bbox.width, bbox.y],
    [bbox.x, bbox.y + bbox.height],
    [bbox.x + bbox.width, bbox.y + bbox.height],
  ].map(([px, py]) => ({ x: m.a * px! + m.c * py! + m.e, y: m.b * px! + m.d * py! + m.f }));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

// Concatenate <text>/<tspan> content, one line per <tspan> (or the whole text if none).
function readTextContent(el: Element) {
  const tspans = el.querySelectorAll('tspan');
  let text: string;
  if (tspans.length) {
    text = Array.from(tspans).map((t) => t.textContent || '').join('\n');
  } else {
    text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  }
  return {
    text,
    fg: styleProp(el, 'fill') || el.getAttribute('fill') || '',
    fontSize: attrNum(el, 'font-size') || parseFloat(styleProp(el, 'font-size')) || 0,
    fontWeight: el.getAttribute('font-weight') || styleProp(el, 'font-weight') || '',
    fontFamily: el.getAttribute('font-family') || styleProp(el, 'font-family') || '',
    textAlign: anchorToAlign(styleProp(el, 'text-anchor') || el.getAttribute('text-anchor')),
    lineHeight: 0,
  };
}

// Serialize the root <defs> of the mounted svg so flattened snippets can resolve
// gradients / clipPaths / patterns referenced by url(#…).
function rootDefsHtml(mount: SVGSVGElement): string {
  try {
    return Array.from(mount.querySelectorAll(':scope > defs'))
      .map((d) => d.innerHTML)
      .join('');
  } catch {
    return '';
  }
}

// SVG text-anchor → box textAlign.
function anchorToAlign(a: unknown): string {
  const s = String(a || '').toLowerCase();
  if (s === 'middle') return 'center';
  if (s === 'end') return 'right';
  return 'left';
}

// Read a Penpot `penpot:<name>` attribute robustly across namespace handling.
function penpotAttr(el: Element, name: string): string | null {
  const direct = el.getAttribute('penpot:' + name);
  if (direct != null) return direct;
  for (const ns of PENPOT_NS_CANDIDATES) {
    const v = el.getAttributeNS(ns, name);
    if (v != null && v !== '') return v;
  }
  // Last resort: scan attributes for a matching prefixed/local name.
  for (const attr of Array.from(el.attributes)) {
    if (attr.name === 'penpot:' + name || (attr.localName === name && (attr.prefix === 'penpot'))) {
      return attr.value;
    }
  }
  return null;
}

// Read a CSS property off the element's inline style="" (cheap; no computed styles).
function styleProp(el: Element, prop: string): string {
  try {
    const st = (el as unknown as ElementCSSInlineStyle).style;
    const v = st && st.getPropertyValue(prop);
    return v ? v.trim() : '';
  } catch {
    return '';
  }
}

function attrNum(el: Element, name: string): number | null {
  const v = el.getAttribute(name);
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// A fill that's paintable as a solid colour, else '' (none/currentColor/url(#…)).
function colorOrEmpty(v: unknown): string {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'currentcolor' || /^url\(/i.test(s)) return '';
  return safeColor(s, '');
}

function firstDefined(...vals: unknown[]): unknown {
  for (const v of vals) if (v != null && v !== '') return v;
  return undefined;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function extFromType(type: string): string {
  const t = String(type || '').toLowerCase();
  if (t.includes('svg')) return 'svg';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif')) return 'gif';
  return 'png';
}

function typeFromExt(ext: string): string {
  const e = String(ext || '').toLowerCase();
  if (e === 'svg') return 'image/svg+xml';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'webp') return 'image/webp';
  if (e === 'gif') return 'image/gif';
  return 'image/png';
}
