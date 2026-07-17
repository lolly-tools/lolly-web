// SPDX-License-Identifier: MPL-2.0
/**
 * PPTX upload import — slides as standalone SVG user assets.
 *
 * The .pptx sibling of pdf-import.ts's page path: the SAME handle shape
 * (PdfHandle/PdfPageSvg), the SAME pickPdfPages dialog, and the SAME
 * storeUserUpload destination, so a deck dropped on any upload surface behaves
 * exactly like a multi-page PDF — the user picks which slides become assets.
 *
 * The renderer (pptxSlideToSvg) is a PURE string builder over the engine's
 * pptx-read model — no DOM APIs — so the root test suite exercises it directly
 * in node. It is an APPROXIMATION by design: solid fills, outlined shapes,
 * per-paragraph text lines, table grids, and inlined png/jpeg media; charts,
 * SmartArt, and other media degrade to labeled placeholder rects. The stored
 * SVG must survive storeUserUpload's DOMPurify pass, which allows
 * data:image/png|jpeg hrefs on <image> — which is why ONLY inline png/jpeg
 * media is resolved and everything else placeholders.
 *
 * Module-scope imports here MUST stay node-safe (engine + the pptx bridge):
 * pdf-import.ts pulls pdf-lib in at module scope and picker.ts pulls CSS, so
 * both are imported lazily inside ingestPptxAsSvgAssets.
 */

import { EMU_PER_PX, isPptx, readPptx } from '@lolly/engine';
import { inflatePptx } from '../bridge/pptx.ts';
import type {
  PptxReadColor, PptxReadSlide, PptxReadTheme,
  PptxPicNode, PptxShapeNode, PptxTableNode, PptxTextNode,
} from '../../../../engine/src/pptx-read.ts';
import type { AssetRef, HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
// Type-only — erased at runtime, so this does NOT load the pdf-lib chunk.
import type { PdfHandle, PdfPageSvg } from './pdf-import.ts';

// ── rendering constants ────────────────────────────────────────────────────────

const PX_PER_PT = 96 / 72;
/** Run/paragraph size when the deck declares none (PowerPoint's usual body size). */
const DEFAULT_SIZE_PT = 18;
/** Paragraph advance: 1.25 × the paragraph's max size (PowerPoint's single-spacing feel). */
const LINE_HEIGHT = 1.25;
/** A media part bigger than this is not inlined — the pic degrades to a placeholder. */
const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
const MAX_TABLE_ROWS = 20;
const MAX_TABLE_COLS = 12;
const TABLE_TEXT_PT = 11;
const PLACEHOLDER_FILL = '#e8e8e8';
const PLACEHOLDER_INK = '#8a8a8a';

// ── small helpers (mirror pdf-import.ts) ───────────────────────────────────────

function msg(err: unknown): string { return String((err && (err as Error).message) || err); }
function r(v: number): number { return Math.round((+v || 0) * 100) / 100; }
function px(emu: number): number { return emu / EMU_PER_PX; }

function xmlEsc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/** `#RRGGBB` when the colour carries a hex (literal OR theme-resolved scheme), else null. */
function hexAttr(c: PptxReadColor | undefined): string | null {
  return c?.hex ? `#${c.hex}` : null;
}

// Base64 in chunks — String.fromCharCode(...bigArray) overflows the call stack.
function bytesToBase64(u8: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  return btoa(bin);
}

// ── the pure slide renderer ────────────────────────────────────────────────────

export interface PptxSlideRenderOpts {
  widthEmu: number;
  heightEmu: number;
  theme: PptxReadTheme;
  /** Resolve a media part path (e.g. "ppt/media/image1.png") to an inlineable
   *  data: URI — null when missing, oversized, or not png/jpeg. */
  getMedia: (path: string) => { dataUrl: string } | null;
}

interface RenderCtx {
  /** Text ink fallback: theme dk1, else black. */
  ink: string;
  /** Body typeface fallback: theme minorFont, else sans-serif. */
  bodyFont: string;
  getMedia: PptxSlideRenderOpts['getMedia'];
}

/**
 * Render ONE read-model slide to a standalone SVG document (the PdfPageSvg
 * shape, so pickPdfPages and the ingest loop take it unchanged). Pure string
 * building — no DOM. `elementCount` counts drawn content nodes (the background
 * rect excluded), so a blank slide reports 0 and gets skipped like a blank PDF
 * page.
 */
export function pptxSlideToSvg(slide: PptxReadSlide, opts: PptxSlideRenderOpts): PdfPageSvg {
  const width = Math.max(1, Math.round(px(opts.widthEmu)));
  const height = Math.max(1, Math.round(px(opts.heightEmu)));
  const bg = opts.theme.colors.lt1 ? `#${opts.theme.colors.lt1}` : '#ffffff';
  const ctx: RenderCtx = {
    ink: opts.theme.colors.dk1 ? `#${opts.theme.colors.dk1}` : '#000000',
    bodyFont: opts.theme.minorFont || 'sans-serif',
    getMedia: opts.getMedia,
  };

  let elementCount = 0;
  const body: string[] = [];
  for (const node of slide.nodes) {
    const x = px(node.xEmu), y = px(node.yEmu);
    const w = Math.max(0, px(node.cxEmu)), h = Math.max(0, px(node.cyEmu));
    let markup = '';
    switch (node.type) {
      case 'shape': markup = renderShape(node, x, y, w, h); break;
      case 'text': markup = renderText(node, x, y, ctx); break;
      case 'pic': markup = renderPic(node, x, y, w, h, ctx); break;
      case 'table': markup = renderTable(node, x, y, w, h, ctx); break;
      default: markup = placeholder(x, y, w, h, 'Chart / SmartArt');
    }
    if (!markup) continue;
    elementCount++;
    body.push(node.rot
      ? `<g transform="rotate(${r(node.rot)} ${r(x + w / 2)} ${r(y + h / 2)})">${markup}</g>`
      : markup);
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${bg}"/>` +
    body.join('') +
    '</svg>';
  return { svg, width, height, elementCount };
}

function renderShape(node: PptxShapeNode, x: number, y: number, w: number, h: number): string {
  const fill = hexAttr(node.fill);
  const line = hexAttr(node.line);
  if (!fill && !line) return ''; // nothing visible — skip the node entirely
  const paint = ` fill="${fill ?? 'none'}"${line ? ` stroke="${line}" stroke-width="1.5"` : ''}`;
  if (node.geom === 'ellipse') {
    return `<ellipse cx="${r(x + w / 2)}" cy="${r(y + h / 2)}" rx="${r(w / 2)}" ry="${r(h / 2)}"${paint}/>`;
  }
  const rx = node.geom === 'roundRect' ? ` rx="${r(Math.min(w, h) * 0.15)}"` : '';
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"${rx}${paint}/>`;
}

// Text is NOT clipped to its box in v1 — a per-node clipPath needs unique-id
// management across an SVG that may be re-inlined next to its siblings (see the
// SUSE illustration id-collision precedent), so overflow is accepted as part of
// the approximation.
function renderText(node: PptxTextNode, x: number, y: number, ctx: RenderCtx): string {
  const lines: string[] = [];
  let cursor = y;
  for (const para of node.paras) {
    const sizes = para.runs
      .map((run) => run.sizePt)
      .filter((n): n is number => typeof n === 'number' && n > 0);
    const maxPt = sizes.length ? Math.max(...sizes) : DEFAULT_SIZE_PT;
    const ascent = maxPt * PX_PER_PT; // em-box ascent approximation
    const baseline = cursor + ascent;
    cursor += ascent * LINE_HEIGHT; // an empty paragraph still advances (blank line)
    const spans = para.runs
      .filter((run) => run.text)
      .map((run) => {
        const attrs =
          ` font-family="${xmlEsc(run.font || ctx.bodyFont)}"` +
          ` font-size="${r((run.sizePt ?? DEFAULT_SIZE_PT) * PX_PER_PT)}"` +
          ` fill="${hexAttr(run.color) ?? ctx.ink}"` +
          (run.bold ? ' font-weight="bold"' : '') +
          (run.italic ? ' font-style="italic"' : '') +
          (run.underline ? ' text-decoration="underline"' : '');
        return `<tspan${attrs}>${xmlEsc(run.text)}</tspan>`;
      });
    if (spans.length) lines.push(`<text x="${r(x)}" y="${r(baseline)}">${spans.join('')}</text>`);
  }
  return lines.join('');
}

function renderPic(node: PptxPicNode, x: number, y: number, w: number, h: number, ctx: RenderCtx): string {
  const media = node.media ? ctx.getMedia(node.media) : null;
  if (media) {
    return `<image x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" preserveAspectRatio="none" href="${xmlEsc(media.dataUrl)}"/>`;
  }
  return placeholder(x, y, w, h, 'Image');
}

function renderTable(node: PptxTableNode, x: number, y: number, w: number, h: number, ctx: RenderCtx): string {
  const rows = node.rows.slice(0, MAX_TABLE_ROWS);
  const cols = Math.min(MAX_TABLE_COLS, Math.max(1, ...rows.map((row) => row.length)));
  const rowCount = Math.max(1, rows.length);
  const rowH = h / rowCount, colW = w / cols;
  const out: string[] = [
    `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="none" stroke="${ctx.ink}" stroke-width="1"/>`,
  ];
  for (let i = 1; i < rowCount; i++) {
    out.push(`<line x1="${r(x)}" y1="${r(y + rowH * i)}" x2="${r(x + w)}" y2="${r(y + rowH * i)}" stroke="${ctx.ink}" stroke-width="1"/>`);
  }
  for (let j = 1; j < cols; j++) {
    out.push(`<line x1="${r(x + colW * j)}" y1="${r(y)}" x2="${r(x + colW * j)}" y2="${r(y + h)}" stroke="${ctx.ink}" stroke-width="1"/>`);
  }
  const fontPx = r(TABLE_TEXT_PT * PX_PER_PT);
  rows.forEach((row, i) => {
    row.slice(0, cols).forEach((cell, j) => {
      if (!cell) return;
      out.push(
        `<text x="${r(x + colW * j + 4)}" y="${r(y + rowH * i + rowH / 2)}" dominant-baseline="middle"` +
        ` font-family="${xmlEsc(ctx.bodyFont)}" font-size="${fontPx}" fill="${ctx.ink}">${xmlEsc(cell)}</text>`,
      );
    });
  });
  return out.join('');
}

/** Light-grey labeled stand-in for content the renderer can't draw (charts,
 *  SmartArt, non-png/jpeg media) — the slide keeps its layout instead of a hole. */
function placeholder(x: number, y: number, w: number, h: number, label: string): string {
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="${PLACEHOLDER_FILL}"/>` +
    `<text x="${r(x + w / 2)}" y="${r(y + h / 2)}" text-anchor="middle" dominant-baseline="middle"` +
    ` font-family="sans-serif" font-size="12" fill="${PLACEHOLDER_INK}">${xmlEsc(label)}</text>`;
}

// ── opening a deck (the PdfHandle shape) ───────────────────────────────────────

/** Open a .pptx for slide-level conversion — the same handle shape as openPdfFile,
 *  so pickPdfPages and the ingest loop work over either document kind. */
export async function openPptxFile(file: File | Blob): Promise<PdfHandle> {
  const parts = await inflatePptx(new Uint8Array(await file.arrayBuffer()));
  if (!isPptx(parts)) throw new Error('Not a PowerPoint (.pptx) file.');
  // The parser is constructed here, not at module scope — node shells have no
  // DOMParser global (same rule as bridge/pptx.ts's createPptxAPI).
  const deck = readPptx(parts, (xml) => new DOMParser().parseFromString(xml, 'application/xml'));

  // Media parts inline as data: URIs so the stored SVG stays self-contained AND
  // survives storeUserUpload's DOMPurify pass (data:image/png|jpeg only).
  // Memoised per path — the same logo on every slide encodes once.
  const mediaCache = new Map<string, { dataUrl: string } | null>();
  const getMedia = (path: string): { dataUrl: string } | null => {
    const hit = mediaCache.get(path);
    if (hit !== undefined) return hit;
    let out: { dataUrl: string } | null = null;
    const ext = /\.(png|jpe?g)$/i.exec(path)?.[1]?.toLowerCase();
    const part = parts[path];
    if (ext && part && part.length > 0 && part.length <= MAX_MEDIA_BYTES) {
      out = { dataUrl: `data:image/${ext === 'png' ? 'png' : 'jpeg'};base64,${bytesToBase64(part)}` };
    }
    mediaCache.set(path, out);
    return out;
  };

  const cache = new Map<number, PdfPageSvg>();
  return {
    pageCount: deck.slides.length,
    async pageToSvg(index: number): Promise<PdfPageSvg> {
      const hit = cache.get(index);
      if (hit) return hit;
      const slide = deck.slides[index];
      if (!slide) throw new Error(`No slide ${index + 1} in this deck.`);
      const out = pptxSlideToSvg(slide, {
        widthEmu: deck.widthEmu, heightEmu: deck.heightEmu, theme: deck.theme, getMedia,
      });
      cache.set(index, out);
      return out;
    },
  };
}

// ── upload-path entry (mirrors ingestPdfAsSvgAssets) ───────────────────────────

/**
 * Convert a .pptx into stored SVG user assets.
 *
 * One slide → converted directly. Multi-slide → the SAME pickPdfPages dialog asks
 * which (its copy says "page", generic enough with the deck's fileName in the
 * title; mode 'multi' offers all-of-them, 'single' picks one for a single slot).
 * Returns the stored refs — empty when cancelled or nothing converted. Per-slide
 * failures warn and continue.
 */
export async function ingestPptxAsSvgAssets(
  host: HostV1,
  file: File | Blob,
  { mode = 'multi', warn = () => {} }: { mode?: 'single' | 'multi'; warn?: (msg: string) => void } = {},
): Promise<AssetRef[]> {
  const name = (file as File).name || 'deck.pptx';
  const handle = await openPptxFile(file);
  if (!handle.pageCount) throw new Error('This deck has no slides.');

  let pages: number[];
  if (handle.pageCount === 1) {
    pages = [0];
  } else {
    // pickPdfPages is generic over the handle shape. Imported lazily: pdf-import
    // pulls pdf-lib in at MODULE scope, so a value import here would load the pdf
    // chunk for every deck (and break this module's node-side purity).
    const { pickPdfPages } = await import('./pdf-import.ts');
    const picked = await pickPdfPages(handle, { mode, fileName: name });
    if (!picked?.length) return [];
    pages = picked;
  }

  // Lazy for the same reason — picker.ts is a DOM/CSS chunk.
  const { storeUserUpload } = await import('./picker.ts');
  const base = name.replace(/\.pptx$/i, '').trim() || 'slide';
  const refs: AssetRef[] = [];
  for (const p of pages) {
    try {
      const pageSvg = await handle.pageToSvg(p, { warn });
      if (!pageSvg.elementCount) { warn(`Slide ${p + 1} has no importable content — skipped.`); continue; }
      const svgName = handle.pageCount === 1 ? `${base}.svg` : `${base} — slide ${p + 1}.svg`;
      const svgFile = new File([pageSvg.svg], svgName, { type: 'image/svg+xml' });
      // storeUserUpload's param is a shell-internal PickerHost superset of HostV1;
      // the real host satisfies it at runtime (same object the picker uses).
      refs.push(await storeUserUpload(host as Parameters<typeof storeUserUpload>[0], svgFile));
    } catch (err) {
      warn(`Couldn’t convert slide ${p + 1} (${msg(err)}).`);
    }
  }
  if (!refs.length && handle.pageCount === 1) throw new Error('Couldn’t find any importable content in this deck.');
  return refs;
}
