// SPDX-License-Identifier: MPL-2.0
/**
 * PowerPoint (.pptx) export — DOM page(s) -> OOXML slides. Extracted verbatim from
 * bridge/export.ts. Self-contained apart from a small set of shared render helpers
 * it imports back from export.ts (pureRotationDeg / detectUnsupportedCss /
 * inlineBlobUrlsInEl / rasterizeNodeToDataUrl / stripCommentNodes + the ExportOpts
 * type). That back-edge is a deliberate, lazy circular import: export.ts imports
 * renderPptx for its dispatch, and every symbol here is referenced only at export
 * time, never at module init, so resolution order is safe. (To remove the cycle
 * later, lift those shared helpers into a common render-util module.)
 */
import { buildPptxParts, EMU_PER_PX, parseGradientAngle, parseGradientStop, splitCssArgs, svgToCustGeomPaths } from "@lolly/engine";
import type { PptxSlide, PptxShape, PptxFill, PptxMedia, PptxPath } from "../../../../engine/src/pptx.ts";
import { parseCssColorFull } from "./export-css.ts";
import { asStr, deckBox, deckFill, deckSrcRect, deckSyncShape, deckTheme, emuOf, parseDeckModel, type DeckBox } from "./pptx-deck.ts";
import { pureRotationDeg, detectUnsupportedCss, inlineBlobUrlsInEl, rasterizeNodeToDataUrl, stripCommentNodes, _host, type ExportOpts } from "./export.ts";

type Rgba = [number, number, number, number];

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MAX_PPTX_PX = 3000;      // per-side cap for any rasterised slide picture
const PPTX_RASTER_SCALE = 2;   // default resolution multiple over an element's CSS box
const MAX_PPTX_SHAPES = 1200;  // safety bound on objects emitted for one slide

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const hex2 = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
const rgbaHex = (c: Rgba): string => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;

function pptxSolidFill(colorStr: string | null | undefined): PptxFill | null {
  const c = parseCssColorFull(colorStr);
  return c && c[3] > 0.01 ? { solid: rgbaHex(c), alpha: c[3] < 1 ? c[3] : undefined } : null;
}
// A CSS linear-gradient background → a PptxFill (reuses the engine gradient parsers).
function pptxGradientFill(bgImage: string | null | undefined): PptxFill | null {
  if (!bgImage || !/linear-gradient\(/i.test(bgImage)) return null;
  const m = /linear-gradient\(([\s\S]*)\)\s*$/i.exec(bgImage.trim());
  if (!m) return null;
  const args = splitCssArgs(m[1]!);
  if (!args.length) return null;
  let angle = 180, start = 0;
  if (/(^|\s)to\s|deg|turn|rad|grad/i.test(args[0]!)) { angle = parseGradientAngle(args[0]!) * 180 / Math.PI; start = 1; }
  const stopArgs = args.slice(start);
  const grad: Array<{ pos: number; color: string; alpha?: number }> = [];
  stopArgs.forEach((raw, i) => {
    const s = parseGradientStop(raw, i, stopArgs.length);
    const c = s.colorStr ? parseCssColorFull(s.colorStr) : null;
    if (!c) return;
    const pos = s.offset.endsWith('%') ? parseFloat(s.offset) / 100 : (stopArgs.length > 1 ? i / (stopArgs.length - 1) : 0);
    grad.push({ pos, color: rgbaHex(c), alpha: c[3] < 1 ? c[3] : undefined });
  });
  return grad.length >= 2 ? { grad, angle } : null;
}
// Sniff a fetched background asset's kind from magic bytes / URL.
function sniffImgExt(buf: Uint8Array, url: string): 'png' | 'jpeg' | 'svg' | null {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  const head = new TextDecoder().decode(buf.subarray(0, 256)).trim();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return /\.svg(\?|#|$)/i.test(url) ? 'svg' : null;
}
// Rasterise SVG bytes to a PNG (the fallback blip a PowerPoint svgBlip requires).
async function svgBytesToPng(svgBytes: Uint8Array, w: number, h: number): Promise<Uint8Array | null> {
  if (typeof document === 'undefined') return null;
  const url = URL.createObjectURL(new Blob([svgBytes as BlobPart], { type: 'image/svg+xml' }));
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('svg raster')); im.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.min(MAX_PPTX_PX, Math.round(w)));
    canvas.height = Math.max(2, Math.min(MAX_PPTX_PX, Math.round(h)));
    const cx = canvas.getContext('2d');
    if (!cx) return null;
    cx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return dataUrlToBytes(canvas.toDataURL('image/png'));
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

// Inline tags whose text folds into the PARENT's text box as styled RUNS (instead of
// becoming their own overlapping box). Anything else is block-level → its own object.
const PPTX_INLINE_TAGS = new Set(['span', 'b', 'strong', 'i', 'em', 'a', 'u', 's', 'strike',
  'small', 'sub', 'sup', 'mark', 'code', 'abbr', 'cite', 'q', 'time', 'label', 'wbr', 'bdi', 'bdo', 'font']);

// True when el's content is only text + inline elements (no block/asset descendants) —
// i.e. one flowing text block that should become a single text box, not many.
function pptxIsInlineTextTree(el: Element): boolean {
  for (const nd of Array.from(el.childNodes)) {
    if (nd.nodeType !== 1) continue;
    const t = (nd as Element).tagName.toLowerCase();
    if (t === 'br') continue;
    if (!PPTX_INLINE_TAGS.has(t) || !pptxIsInlineTextTree(nd as Element)) return false;
  }
  return true;
}

type PptxRunDraft = { text: string; sizePt: number; color?: string; bold?: boolean; italic?: boolean; font?: string };
function pptxRunStyle(text: string, cs: CSSStyleDeclaration): PptxRunDraft {
  const cc = parseCssColorFull(cs.color);
  return {
    text,
    sizePt: (parseFloat(cs.fontSize) || 16) * 0.75,
    color: cc ? rgbaHex(cc) : undefined,
    bold: cs.fontWeight === 'bold' || (parseInt(cs.fontWeight, 10) || 400) >= 600,
    italic: cs.fontStyle === 'italic',
    font: (cs.fontFamily || '').split(',')[0]?.replace(/["']/g, '').trim() || undefined,
  };
}

// Flatten an inline text tree into styled runs — each text node carries its OWN parent's
// computed font style, so <b>/<i>/coloured spans keep their formatting in one text box.
function pptxCollectRuns(el: Element): PptxRunDraft[] {
  const runs: PptxRunDraft[] = [];
  const walk = (node: Element): void => {
    for (const nd of Array.from(node.childNodes)) {
      if (nd.nodeType === 3) {
        const raw = (nd.textContent || '').replace(/\s+/g, ' ');
        if (raw) runs.push(pptxRunStyle(raw, window.getComputedStyle(node)));
      } else if (nd.nodeType === 1) {
        if ((nd as Element).tagName.toLowerCase() === 'br') runs.push({ text: ' ', sizePt: 12 });
        else walk(nd as Element);
      }
    }
  };
  walk(el);
  while (runs.length && !runs[0]!.text.trim()) runs.shift();
  while (runs.length && !runs[runs.length - 1]!.text.trim()) runs.pop();
  return runs;
}

// Intrinsic aspect (w,h) of an SVG from its viewBox (or width/height attrs), for
// fitting it into a box without distortion.
function pptxSvgAspect(bytes: Uint8Array): [number, number] | null {
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  const vb = /viewBox\s*=\s*["']\s*[\d.eE+-]+\s+[\d.eE+-]+\s+([\d.eE+-]+)\s+([\d.eE+-]+)/.exec(head);
  if (vb) return [parseFloat(vb[1]!), parseFloat(vb[2]!)];
  const w = /\bwidth\s*=\s*["']?([\d.]+)/.exec(head), h = /\bheight\s*=\s*["']?([\d.]+)/.exec(head);
  return w && h ? [parseFloat(w[1]!), parseFloat(h[1]!)] : null;
}
// object-position → offset of a fitted picture within the leftover box space.
function pptxObjOffset(posStr: string | undefined, freeX: number, freeY: number): { ox: number; oy: number } {
  const toks = (posStr || '50% 50%').trim().toLowerCase().split(/\s+/);
  const fx = (k: string): number => k === 'left' ? 0 : k === 'right' ? 1 : k === 'center' ? 0.5 : k.endsWith('%') ? parseFloat(k) / 100 : 0.5;
  const fy = (k: string): number => k === 'top' ? 0 : k === 'bottom' ? 1 : k === 'center' ? 0.5 : k.endsWith('%') ? parseFloat(k) / 100 : 0.5;
  return { ox: Math.round(freeX * fx(toks[0] ?? '50%')), oy: Math.round(freeY * fy(toks[1] ?? '50%')) };
}
// Fit an intrinsic aspect into a box per object-fit:contain (+ object-position); other
// fit modes keep the full box (stretch), which is what a plain blipFill does.
function pptxFitInto(box: { x: number; y: number; cx: number; cy: number }, aw: number, ah: number, style: CSSStyleDeclaration): { x: number; y: number; cx: number; cy: number } {
  if ((style.objectFit || 'fill') !== 'contain' || !(aw > 0 && ah > 0)) return box;
  const imgA = aw / ah, boxA = box.cx / Math.max(1, box.cy);
  let cx = box.cx, cy = box.cy;
  if (imgA > boxA) cy = Math.round(box.cx / imgA); else cx = Math.round(box.cy * imgA);
  const { ox, oy } = pptxObjOffset(style.objectPosition, box.cx - cx, box.cy - cy);
  return { x: box.x + ox, y: box.y + oy, cx, cy };
}
// object-fit:cover — the box stays full; the SOURCE is cropped (srcRect) so the visible
// aspect matches without distorting. Returns per-edge crop fractions, or null when no
// crop is needed. object-position places the crop window.
function pptxCoverSrcRect(boxCx: number, boxCy: number, aw: number, ah: number, style: CSSStyleDeclaration): { l: number; t: number; r: number; b: number } | null {
  if ((style.objectFit || 'fill') !== 'cover' || !(aw > 0 && ah > 0 && boxCx > 0 && boxCy > 0)) return null;
  const imgA = aw / ah, boxA = boxCx / boxCy;
  if (Math.abs(imgA - boxA) < 1e-3) return null;
  if (imgA > boxA) {                                   // image wider → crop left/right
    const crop = 1 - boxA / imgA;
    const ox = pptxObjOffset(style.objectPosition, 1, 0).ox;
    return { l: crop * ox, t: 0, r: crop * (1 - ox), b: 0 };
  }
  const crop = 1 - imgA / boxA;                        // image taller → crop top/bottom
  const oy = pptxObjOffset(style.objectPosition, 0, 1).oy;
  return { l: 0, t: crop * oy, r: 0, b: crop * (1 - oy) };
}

// Per-side CSS borders → thin rect shapes. A uniform 4-side border returns one outline
// (via `line`); otherwise each visible side becomes its own edge rect — so a heading's
// `border-bottom` accent rule survives (the earlier top-side-only check missed it).
type PptxEdgeRect = { x: number; y: number; cx: number; cy: number; fill: PptxFill };
function pptxBorderRects(style: CSSStyleDeclaration, box: { x: number; y: number; cx: number; cy: number }, E: number): { outline?: { color: string; w: number }; edges: PptxEdgeRect[] } {
  const side = (w: string, s: string, c: string) => {
    const width = parseFloat(w) || 0;
    if (width <= 0 || s === 'none' || s === 'hidden') return null;
    const col = parseCssColorFull(c);
    return col && col[3] > 0.01 ? { w: width, color: rgbaHex(col), alpha: col[3] < 1 ? col[3] : undefined } : null;
  };
  const t = side(style.borderTopWidth, style.borderTopStyle, style.borderTopColor);
  const r = side(style.borderRightWidth, style.borderRightStyle, style.borderRightColor);
  const b = side(style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor);
  const l = side(style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor);
  type Side = ReturnType<typeof side>;
  const same = (a: Side, z: Side): boolean => (!a && !z) || (!!a && !!z && a.w === z.w && a.color === z.color);
  if (t && same(t, r) && same(t, b) && same(t, l)) return { outline: { color: t.color, w: Math.round(t.w * E) }, edges: [] };
  const edges: PptxEdgeRect[] = [];
  const fillOf = (s: NonNullable<Side>): PptxFill => ({ solid: s.color, alpha: s.alpha });
  const px = (w: number) => Math.max(1, Math.round(w * E));
  if (t) edges.push({ x: box.x, y: box.y, cx: box.cx, cy: px(t.w), fill: fillOf(t) });
  if (b) edges.push({ x: box.x, y: box.y + box.cy - px(b.w), cx: box.cx, cy: px(b.w), fill: fillOf(b) });
  if (l) edges.push({ x: box.x, y: box.y, cx: px(l.w), cy: box.cy, fill: fillOf(l) });
  if (r) edges.push({ x: box.x + box.cx - px(r.w), y: box.y, cx: px(r.w), cy: box.cy, fill: fillOf(r) });
  return { edges };
}

// Walk one page element into PPTX shapes + media (see the section comment above).
async function pptxSlideFromPage(pageEl: Element, opts: ExportOpts): Promise<PptxSlide> {
  const shapes: PptxShape[] = [];
  const media: PptxMedia[] = [];
  const rootRect = pageEl.getBoundingClientRect();
  const E = EMU_PER_PX;
  const addMedia = (bytes: Uint8Array, ext: PptxMedia['ext']): number => (media.push({ bytes, ext }), media.length - 1);
  const boxOf = (r: DOMRect) => ({ x: Math.round((r.left - rootRect.left) * E), y: Math.round((r.top - rootRect.top) * E), cx: Math.round(r.width * E), cy: Math.round(r.height * E) });
  const full = () => shapes.length >= MAX_PPTX_SHAPES;

  // NATIVE-vector fast path: lower a FLAT stroke/fill SVG (the user's own line-art)
  // into real, editable PowerPoint custGeom shapes at `box`, killing the round-trip
  // (EMF → Google Drawings → Slides → PPTX) users otherwise do to keep art vector.
  // Returns true when it emitted native shapes; false → the caller keeps its existing
  // raster (svgBlip pic) path, so a gradient/filter/opacity/blend SVG never regresses.
  function tryNativeSvg(svgText: string, box: { x: number; y: number; cx: number; cy: number }): boolean {
    const native: PptxPath[] | null = svgToCustGeomPaths(svgText, box.cx, box.cy);
    if (!native || !native.length) return false;
    for (const s of native) { if (full()) break; shapes.push({ ...s, x: box.x, y: box.y }); }
    return true;
  }

  async function rasterPic(el: HTMLElement, r: DOMRect, name?: string, hiRes = false): Promise<void> {
    let scale = PPTX_RASTER_SCALE;
    if (hiRes) {
      const nat = (el as HTMLImageElement).naturalWidth || 0;
      if (nat > r.width) scale = Math.max(scale, Math.min(nat / r.width, MAX_PPTX_PX / Math.max(1, r.width)));
    }
    const pxW = Math.max(2, Math.min(MAX_PPTX_PX, Math.round(r.width * scale)));
    const pxH = Math.max(2, Math.min(MAX_PPTX_PX, Math.round(r.height * scale)));
    const dataUrl = await rasterizeNodeToDataUrl(el, pxW, pxH);
    if (dataUrl) shapes.push({ kind: 'pic', ...boxOf(r), media: addMedia(dataUrlToBytes(dataUrl), 'png'), name });
  }

  async function svgPic(el: Element, r: DOMRect): Promise<void> {
    const clone = el.cloneNode(true) as Element;
    stripCommentNodes(clone);
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // NATIVE first: a flat SVG becomes editable custGeom shapes (no blob-url inline
    // needed — the lowering bails on <image>/anything raster). Rich SVG → raster below.
    if (tryNativeSvg(new XMLSerializer().serializeToString(clone), boxOf(r))) return;
    await inlineBlobUrlsInEl(clone);
    const svgBytes = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' + new XMLSerializer().serializeToString(clone));
    const png = await svgBytesToPng(svgBytes, r.width * 2, r.height * 2);
    if (!png) { await rasterPic(el as HTMLElement, r, 'vector'); return; }  // no fallback raster → bake
    const pngIdx = addMedia(png, 'png');
    const svgIdx = addMedia(svgBytes, 'svg');
    shapes.push({ kind: 'pic', ...boxOf(r), media: pngIdx, svg: svgIdx, name: 'vector' });
  }

  async function bgImagePic(el: Element, style: CSSStyleDeclaration, r: DOMRect): Promise<void> {
    const m = /url\((["']?)([^"')]+)\1\)/.exec(style.backgroundImage);
    if (!m) return;
    try {
      const buf = new Uint8Array(await (await fetch(m[2]!)).arrayBuffer());
      const ext = sniffImgExt(buf, m[2]!);
      if (ext === 'png' || ext === 'jpeg') { shapes.push({ kind: 'pic', ...boxOf(r), media: addMedia(buf, ext), name: 'background' }); return; }
      if (ext === 'svg') {
        // NATIVE first (flat art fills the element box); else the raster svgBlip.
        if (tryNativeSvg(new TextDecoder().decode(buf), boxOf(r))) return;
        const png = await svgBytesToPng(buf, r.width * 2, r.height * 2);
        if (png) shapes.push({ kind: 'pic', ...boxOf(r), media: addMedia(png, 'png'), svg: addMedia(buf, 'svg'), name: 'background' });
      }
    } catch { /* asset unreachable — skip */ }
  }

  // An <img>. A SVG-sourced logo (the common case in Lolly — assets arrive as
  // <img src="blob:…svg">) is embedded as a REAL vector (svgBlip) so it extracts crisp;
  // an untreated raster embeds its ORIGINAL bytes (native res, no re-encode); a treated
  // image (CSS filter / blend) is rasterised so the treatment is baked in.
  async function imgPic(el: Element, style: CSSStyleDeclaration, r: DOMRect): Promise<void> {
    const src = (el as HTMLImageElement).currentSrc || el.getAttribute('src') || '';
    const treated = (style.filter && style.filter !== 'none') || (style.mixBlendMode && style.mixBlendMode !== 'normal');
    if (src && !treated) {
      try {
        const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
        const ext = sniffImgExt(buf, src);
        if (ext === 'svg') {
          // Keep it a real vector; place it contain-fitted (logos use object-fit:contain).
          const asp = pptxSvgAspect(buf);
          const placed = asp ? pptxFitInto(boxOf(r), asp[0], asp[1], style) : boxOf(r);
          // NATIVE first: a flat logo lowers to editable custGeom at the fitted box.
          if (tryNativeSvg(new TextDecoder().decode(buf), placed)) return;
          const png = await svgBytesToPng(buf, (placed.cx / E) * 2, (placed.cy / E) * 2);
          if (png) { shapes.push({ kind: 'pic', ...placed, media: addMedia(png, 'png'), svg: addMedia(buf, 'svg'), name: 'vector' }); return; }
        } else if (ext === 'png' || ext === 'jpeg') {
          const im = el as HTMLImageElement;
          const nw = im.naturalWidth || 0, nh = im.naturalHeight || 0;
          const box = boxOf(r);
          // cover → keep the full box but crop the source (srcRect); contain → letterbox;
          // fill/default → stretch to the box (a plain blipFill).
          const srcRect = pptxCoverSrcRect(box.cx, box.cy, nw, nh, style) ?? undefined;
          const placed = srcRect ? box : pptxFitInto(box, nw, nh, style);
          shapes.push({ kind: 'pic', ...placed, media: addMedia(buf, ext), name: 'image', srcRect }); return;
        }
      } catch { /* fall through to rasterise */ }
    }
    await rasterPic(el as HTMLElement, r, 'image', true);
  }

  async function visit(el: Element): Promise<void> {
    if (full() || el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script') return;
    // Speaker notes travel as slide.notes (read below), never as a shape. The
    // display:none guard underneath already drops them, but that leans on the
    // tool's CSS surviving — this makes it structural.
    if (el.hasAttribute('data-slide-notes')) return;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 0.5 || rect.height < 0.5) return;

    // A rotated element: bake it to a picture (rotation preserved) rather than
    // reconstructing the transform per shape kind. Rare in these tools; layout secondary.
    if (pureRotationDeg(style.transform)) { await rasterPic(el as HTMLElement, rect, 'rotated'); return; }
    if (tag === 'svg') { await svgPic(el, rect); return; }
    if (tag === 'img') { await imgPic(el, style, rect); return; }
    if (tag === 'canvas' || tag === 'video') { await rasterPic(el as HTMLElement, rect, tag); return; }

    // Effects the shape/text walkers can't express → bake the subtree to a picture.
    // (background-image:url() is handled specially below — it's an extractable asset.)
    const reason = detectUnsupportedCss(el, style);
    if (reason && reason !== 'background-image:url()') { await rasterPic(el as HTMLElement, rect, reason); return; }

    // Background / border / radius → rect shape(s) (layout context). A uniform border
    // becomes the rect's outline; per-side borders (e.g. a heading's accent
    // border-bottom rule) each become their own thin edge rect.
    const box = boxOf(rect);
    const fill = pptxGradientFill(style.backgroundImage) ?? pptxSolidFill(style.backgroundColor) ?? undefined;
    const borders = pptxBorderRects(style, box, E);
    const radiusPx = parseFloat(style.borderTopLeftRadius) || 0;
    if (fill || borders.outline || radiusPx > 0) {
      shapes.push({ kind: 'rect', ...box, fill, line: borders.outline, radius: radiusPx > 0 ? Math.round(radiusPx * E) : undefined });
    }
    for (const e of borders.edges) shapes.push({ kind: 'rect', x: e.x, y: e.y, cx: e.cx, cy: e.cy, fill: e.fill });
    if (/url\(/.test(style.backgroundImage)) await bgImagePic(el, style, rect);

    // A pure text block (only text + inline formatting) → ONE editable text box whose
    // runs carry per-fragment styling, so <b>/<i>/coloured spans stay in the same box
    // instead of each becoming a separate, overlapping shape.
    if (pptxIsInlineTextTree(el) && (el.textContent || '').trim()) {
      const runs = pptxCollectRuns(el);
      if (runs.length) {
        const align: 'l' | 'ctr' | 'r' | 'just' =
          style.textAlign === 'center' ? 'ctr' : style.textAlign === 'right' ? 'r' : style.textAlign === 'justify' ? 'just' : 'l';
        shapes.push({ kind: 'text', ...boxOf(rect), anchor: 't', paras: [{ align, runs }] });
      }
      return;   // inline children are consumed as runs — don't recurse into them
    }

    // Otherwise recurse block children (each stacks above this element's background).
    for (const child of Array.from(el.children)) { if (full()) break; await visit(child); }
  }

  await visit(pageEl);
  if (full()) _host?.log?.('warn', `pptx: slide hit the ${MAX_PPTX_SHAPES}-object cap; some elements were dropped.`);
  return { shapes, media };
}

function pptxMeta(opts: ExportOpts): PptxBuildOptsMeta {
  return opts.meta ? { title: opts.meta.tool, description: opts.meta.description, source: opts.meta.source, contact: opts.meta.contact } : null;
}
type PptxBuildOptsMeta = { title?: string; description?: string; source?: string; contact?: string } | null;

async function zipPptxParts(parts: Record<string, string | Uint8Array>): Promise<Blob> {
  const { zipSync } = await import('fflate');
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(parts)) {
    files[path] = typeof content === 'string' ? enc.encode(content) : content;
  }
  return new Blob([zipSync(files) as BlobPart], { type: PPTX_MIME });
}

// ─── authored deck model (tool-driven NATIVE pptx) ───────────────────────────
// A tool may emit its OWN deck as inline JSON — <script type="application/json"
// data-pptx-deck>{…}</script> — instead of relying on the DOM walk above. That is how a
// tool gets NATIVE tables + precise editable text/theme into PowerPoint. The PURE lowering
// (css→hex, px→EMU, native tables, defensive coercion of the untrusted tool JSON) lives in
// ./pptx-deck.ts (node-tested); this file keeps only the async image fetch + orchestration.
// A malformed/absent model falls back to the DOM walk. See engine PptxSlide/PptxShape.
const PPTX_DECK_SEL = '[data-pptx-deck]';
const MAX_DECK_SLIDES = 500;         // upper bound on an authored deck
const MAX_DECK_ELEMENTS = MAX_PPTX_SHAPES; // elements processed per slide (bounds the fetch storm)
const MAX_DECK_IMG_BYTES = 32 * 1024 * 1024; // 32 MB per embedded image (`src` is tool-controlled)

// An image element — the sole async lowering (it fetches bytes). SVG rides in as a real
// vector (svgBlip + PNG fallback); raster embeds its original bytes; an unreachable/oversized
// asset drops the element but keeps the deck.
async function deckImageShape(el: Record<string, unknown>, box: DeckBox, addMedia: (b: Uint8Array, e: PptxMedia['ext']) => number): Promise<PptxShape | null> {
  const src = asStr(el?.src); if (!src) return null;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_DECK_IMG_BYTES) return null;
    const ext = sniffImgExt(buf, src);
    if (ext === 'png' || ext === 'jpeg') return { kind: 'pic', ...box, media: addMedia(buf, ext), srcRect: deckSrcRect(el?.srcRect) };
    if (ext === 'svg') {
      const png = await svgBytesToPng(buf, (box.cx / EMU_PER_PX) * 2, (box.cy / EMU_PER_PX) * 2);
      if (png) return { kind: 'pic', ...box, media: addMedia(png, 'png'), svg: addMedia(buf, 'svg') };
    }
  } catch { /* asset unreachable — drop the element, keep the deck */ }
  return null;
}

async function deckElementToShape(el: Record<string, unknown>, addMedia: (b: Uint8Array, e: PptxMedia['ext']) => number): Promise<PptxShape | null> {
  if (!el || typeof el !== 'object') return null;
  if (el.t === 'image') return await deckImageShape(el, deckBox(el), addMedia);
  return deckSyncShape(el); // rect / text / table (pure)
}

// Read + validate a tool-authored deck model off the export node, or null to DOM-walk.
function readDeckModel(node: Element): Record<string, unknown> | null {
  const el = node.querySelector?.(PPTX_DECK_SEL) ?? (node.matches?.(PPTX_DECK_SEL) ? node : null);
  return parseDeckModel(el?.textContent);
}

async function renderPptxFromDeck(deck: Record<string, unknown>, opts: ExportOpts): Promise<Blob> {
  const size = deck.size as { w?: unknown; h?: unknown } | undefined;
  const emuW = Math.max(1, emuOf(size?.w, 1280));
  const emuH = Math.max(1, emuOf(size?.h, 720));
  const slidesIn = (deck.slides as Array<Record<string, unknown>>).slice(0, MAX_DECK_SLIDES);
  const slides: PptxSlide[] = [];
  for (const s of slidesIn) {
    const shapes: PptxShape[] = [];
    const media: PptxMedia[] = [];
    const addMedia = (bytes: Uint8Array, ext: PptxMedia['ext']): number => (media.push({ bytes, ext }), media.length - 1);
    const bg = deckFill(s?.bg);
    if (bg) shapes.push({ kind: 'rect', x: 0, y: 0, cx: emuW, cy: emuH, fill: bg });
    // Bound by elements PROCESSED (not shapes produced): a slide of 100k {t:'image'}
    // elements would otherwise fire 100k fetches even though each returns null.
    const els = (Array.isArray(s?.elements) ? s.elements : []).slice(0, MAX_DECK_ELEMENTS);
    for (const el of els) {
      if (shapes.length >= MAX_PPTX_SHAPES) { _host?.log?.('warn', `pptx: slide hit the ${MAX_PPTX_SHAPES}-object cap; some elements were dropped.`); break; }
      const shape = await deckElementToShape(el, addMedia);
      if (shape) shapes.push(shape);
    }
    const slide: PptxSlide = { shapes, media };
    const notes = asStr(s?.notes)?.trim();
    if (notes) slide.notes = notes;
    slides.push(slide);
    opts.onProgress?.(slides.length, slidesIn.length);
  }
  const parts = buildPptxParts(slides, { emuW, emuH, theme: deckTheme(deck.theme), meta: pptxMeta(opts), now: new Date().toISOString() });
  return zipPptxParts(parts);
}

export async function renderPptx(node: Element, opts: ExportOpts): Promise<Blob> {
  // Fast path: a tool that authored its own native deck model (tables, precise text,
  // brand theme) drives the OOXML directly; the DOM walk below is the general fallback.
  const deck = readDeckModel(node);
  if (deck) return renderPptxFromDeck(deck, opts);

  const pages = node.querySelectorAll ? [...node.querySelectorAll('[data-pdf-page]')] : [];
  const pageEls: Element[] = pages.length ? pages : [node];

  // A PPTX deck has ONE slide size; take it from page 0 (uniform in the common case).
  const r0 = pageEls[0]!.getBoundingClientRect();
  const emuW = Math.max(1, Math.round((r0.width || 1) * EMU_PER_PX));
  const emuH = Math.max(1, Math.round((r0.height || 1) * EMU_PER_PX));

  const slides: PptxSlide[] = [];
  for (const el of pageEls) {
    const slide = await pptxSlideFromPage(el, opts);
    // Speaker notes: a display:none [data-slide-notes] node inside the page (the
    // convention any tool can emit). Hidden from the shape walk above and from
    // every rasteriser, but readable here — and it is NOT [data-export-hide], so
    // detachExportHidden can't have pulled it out from under us.
    const note = (el.querySelector?.('[data-slide-notes]')?.textContent ?? '').trim();
    if (note) slide.notes = note;
    slides.push(slide);
    opts.onProgress?.(slides.length, pageEls.length);
  }

  const parts = buildPptxParts(slides, { emuW, emuH, meta: pptxMeta(opts), now: new Date().toISOString() });
  return zipPptxParts(parts);
}
