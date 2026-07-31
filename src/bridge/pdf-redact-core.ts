// SPDX-License-Identifier: MPL-2.0
/**
 * The DOM-free core of PDF redaction (host.pdf.redact) — everything that can be
 * asserted in node. pdf.ts owns the canvas work (render page SVG, burn bars,
 * encode JPEG) and calls in here for the maths and for the rebuild:
 *
 * - point→pixel bar mapping (integer-snapped, inflated, clamped to the canvas),
 * - the DPI clamp,
 * - the grayscale pass over raw RGBA pixels,
 * - buildImagePdf: a BRAND-NEW pdf-lib document whose pages contain only the
 *   supplied page images at the original sizes in points. Nothing is copied
 *   from the source document — no Info values, no XMP, no annotations,
 *   attachments, layers or scripts — so removed content cannot survive by
 *   construction.
 */

/** Raster resolution bounds for the rebuilt pages. */
export const REDACT_DPI_DEFAULT = 200;
export const REDACT_DPI_MIN = 72;
export const REDACT_DPI_MAX = 300;

/** Bars are inflated by this many device pixels on every side before burning,
 *  so chroma subsampling in the JPEG encode cannot bleed covered ink past the
 *  bar's edge. */
export const BAR_INFLATE_PX = 2;

/** Clamp a requested DPI into the supported window; non-numbers get the default. */
export function clampDpi(dpi: unknown): number {
  const n = Number(dpi);
  if (!isFinite(n)) return REDACT_DPI_DEFAULT;
  return Math.min(REDACT_DPI_MAX, Math.max(REDACT_DPI_MIN, n));
}

/** Page cap for host.pdf.pages previews when the caller names none. */
export const PAGES_MAX_DEFAULT = 40;

/** Clamp a requested page cap: a whole number of at least 1; anything else gets the default. */
export function clampMaxPages(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : PAGES_MAX_DEFAULT;
}

/**
 * Drive the per-page loop of host.pdf.pages: run `renderOne` for the first
 * `maxPages` of `count` pages, SKIPPING any page whose render throws — one
 * broken page must not kill the whole preview. A skipped page is never silent:
 * its 1-based number lands in `failed` so the caller can say which pages have
 * no preview. `truncated` reports that the document has more pages than the
 * cap allowed.
 */
export async function collectPages<T>(
  count: number,
  maxPages: number,
  renderOne: (index: number) => Promise<T>,
): Promise<{ pages: T[]; truncated: boolean; failed: number[] }> {
  const limit = Math.min(count, maxPages);
  const pages: T[] = [];
  const failed: number[] = [];
  for (let i = 0; i < limit; i++) {
    try { pages.push(await renderOne(i)); } catch { failed.push(i + 1); }
  }
  return { pages, truncated: count > maxPages, failed };
}

/** A pixel-space rectangle, integer coordinates, ready for fillRect. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Map one bar from PDF point space (y from the TOP of the page) onto a page
 * raster of `cw`×`ch` device pixels rendered at `dpi`. The result is snapped
 * OUTWARD to whole pixels, inflated by BAR_INFLATE_PX on every side, and
 * clamped to the canvas. Returns null for a bar that is degenerate, not finite,
 * or entirely off the page — the caller skips it.
 */
export function barToPixels(
  bar: { x: number; y: number; w: number; h: number },
  dpi: number,
  cw: number,
  ch: number,
): PixelRect | null {
  const s = dpi / 72;
  if (![bar.x, bar.y, bar.w, bar.h].every((v) => isFinite(v))) return null;
  if (bar.w <= 0 || bar.h <= 0) return null;
  const x0 = Math.max(0, Math.floor(bar.x * s) - BAR_INFLATE_PX);
  const y0 = Math.max(0, Math.floor(bar.y * s) - BAR_INFLATE_PX);
  const x1 = Math.min(cw, Math.ceil((bar.x + bar.w) * s) + BAR_INFLATE_PX);
  const y1 = Math.min(ch, Math.ceil((bar.y + bar.h) * s) + BAR_INFLATE_PX);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Convert tightly-packed RGBA pixels to grayscale IN PLACE, using the CSS
 * `grayscale()` luminance weights (Rec. 709) so the result matches what a
 * canvas filter would produce. Alpha is left alone — the caller has already
 * composited onto an opaque background.
 */
export function grayscaleInPlace(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    data[i] = data[i + 1] = data[i + 2] = Math.round(y);
  }
}

/** One rebuilt page: its JPEG bytes and the original page size in points. */
export interface RedactedPageImage {
  jpeg: Uint8Array;
  widthPt: number;
  heightPt: number;
}

/**
 * Build the output document: one page per source page at the original MediaBox
 * size in points, containing only the page image, scaled to fill the page
 * exactly. The document is created from scratch, and the Info dictionary
 * pdf-lib pre-fills at create() is emptied before save, so the result carries
 * no metadata at all — a redacted file must not even say what wrote it beyond
 * its own bytes.
 */
export async function buildImagePdf(pages: RedactedPageImage[]): Promise<Uint8Array> {
  if (!pages.length) throw new Error('This PDF has no pages.');
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const img = await doc.embedJpg(p.jpeg);
    const page = doc.addPage([p.widthPt, p.heightPt]);
    page.drawImage(img, { x: 0, y: 0, width: p.widthPt, height: p.heightPt });
  }
  // PDFDocument.create() pre-fills Producer/Creator/dates — remove every entry,
  // the same way stripPdf does, so the output's Info dictionary is empty.
  const infoRef = doc.context.trailerInfo && doc.context.trailerInfo.Info;
  if (infoRef) {
    let info: { keys(): unknown[]; delete(key: unknown): void } | null;
    try { info = doc.context.lookup(infoRef) as unknown as { keys(): unknown[]; delete(key: unknown): void }; } catch { info = null; }
    if (info && typeof info.keys === 'function' && typeof info.delete === 'function') {
      for (const key of [...info.keys()]) info.delete(key);
    }
  }
  try { doc.catalog.delete(PDFName.of('Metadata')); } catch { /* none present */ }
  return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}
