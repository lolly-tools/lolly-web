// SPDX-License-Identifier: MPL-2.0
/**
 * PDF redaction (host.pdf.redact, engine v1.85) — rasterise-and-rebuild.
 *
 * Render every page to an image with the app's OWN interpreter
 * (views/pdf-import.ts pageToSvg — the same path a .ai/.pdf upload takes,
 * never an external renderer), burn the bars in as fully opaque fills, and
 * construct a BRAND-NEW pdf-lib document whose pages contain only those
 * images. Nothing is copied from the source, so covered text, fonts,
 * annotations, attachments, layers, scripts and metadata cannot survive by
 * construction. The DOM-free maths + the rebuild live in pdf-redact-core.ts so
 * node can assert them; this half owns the canvas.
 *
 * WEB-ONLY, and a separate module from pdf.ts on purpose: the CLI imports
 * pdf.ts for analyze/strip/compress, and the views/pdf-import + pdf-vector-shot
 * imports below would drag the whole web views graph into its typecheck. The
 * web bridge index wires this in; the CLI's host.pdf simply lacks the method.
 */
import type { PdfPagesResult, PdfRedactOpts, PdfRedactResult, TextAPI } from '@lolly-tools/core/host-v1';
import { PDF_LOAD_OPTS, hasImageCodec, makeCanvas, canvasToJpeg } from './pdf.ts';
import type { RedactedPageImage } from './pdf-redact-core.ts';

/** The slice of the host redaction needs: the HarfBuzz shaper for page text. */
export interface RedactHost { text?: TextAPI }

// Draw a self-contained SVG document onto the canvas, scaled to fill it. The
// SVG goes through an <img>, which loads no external resources and paints no
// document fonts — which is why the caller outlines text first (the same
// recipe as views/pdf-extract.ts pageArtUrl / lib/pdf-vector-shot.ts).
async function drawSvgOnCanvas(cx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, svg: string, w: number, h: number): Promise<void> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('the page SVG did not decode'));
      img.src = url;
    });
    cx.drawImage(img, 0, 0, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * host.pdf.pages — each page as a self-contained SVG document, the preview the
 * Redact tool draws its bar overlay on. Same recipe as redactPdf's per-page
 * render (openPdfFile → pageToSvg with outlined text → embedFonts), but the
 * SVG string IS the product: no canvas, no JPEG, so this path is not gated on
 * hasImageCodec. The viewBox is in PDF points, origin top-left — the exact
 * space PdfRedactBar lives in. Pages that fail to render are skipped but
 * REPORTED (collectPages → `failed`, 1-based) so a missing page never passes
 * silently; when EVERY page fails (e.g. an encrypted PDF that loads under
 * ignoreEncryption but whose content streams cannot render) this throws, so
 * the tool shows its render-failure state instead of the false "previews
 * aren't available in this app" fallback. At most maxPages (default 40) come
 * back.
 */
export async function pdfPages(bytes: Uint8Array, opts?: { maxPages?: number }, host?: RedactHost): Promise<PdfPagesResult> {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const core = await import('./pdf-redact-core.ts');
  const maxPages = core.clampMaxPages(opts?.maxPages);

  // Page sizes in points from the ORIGINAL MediaBoxes via pdf-lib, exactly as
  // redactPdf reads them — the preview must report the same geometry the
  // redaction pass will burn bars against.
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(input, PDF_LOAD_OPTS);
  const sizes = src.getPages().map((p) => p.getSize());
  if (!sizes.length) throw new Error('This PDF has no pages.');

  const { openPdfFile } = await import('../views/pdf-import.ts');
  const { makeTextOutliner, embedFonts } = await import('../lib/pdf-vector-shot.ts');
  const handle = await openPdfFile(new Blob([input as BlobPart], { type: 'application/pdf' }));

  const res = await core.collectPages(sizes.length, maxPages, async (i) => {
    const { width: wPt, height: hPt } = sizes[i]!;
    const page = await handle.pageToSvg(i, {
      // The SVG must render with no document fonts — outline every run to real
      // paths, with embedFonts as the safety net for unresolved runs.
      outlineText: makeTextOutliner([], host?.text),
      // Terminal preview output, never re-exported as vectors — safe to hoist.
      dedupePaths: true,
      // Several page SVGs land in one DOM — the ids must not collide.
      idPrefix: `rdpg${i}-`,
    });
    const svg = await embedFonts(page.svg, []);
    return { svg, page: i + 1, widthPt: wPt, heightPt: hPt };
  });
  if (!res.pages.length) {
    throw new Error('None of the pages in this PDF could be rendered. It may be encrypted or damaged.');
  }
  return { pages: res.pages, truncated: res.truncated, ...(res.failed.length ? { failed: res.failed } : {}) };
}

export async function redactPdf(bytes: Uint8Array, opts: PdfRedactOpts, host?: RedactHost): Promise<PdfRedactResult> {
  if (!hasImageCodec() || typeof Image !== 'function' || typeof URL.createObjectURL !== 'function') {
    throw new Error('PDF redaction needs a browser canvas, which this shell does not provide.');
  }
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const core = await import('./pdf-redact-core.ts');
  const dpi = core.clampDpi(opts?.dpi);
  const bars = Array.isArray(opts?.bars) ? opts.bars : [];

  // Page sizes come from the ORIGINAL MediaBoxes via pdf-lib — the rebuilt
  // document must reproduce them exactly, in points.
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(input, PDF_LOAD_OPTS);
  const sizes = src.getPages().map((p) => p.getSize());
  if (!sizes.length) throw new Error('This PDF has no pages.');

  // The app's own page renderer, lazily — the same modules views/valid.ts and
  // views/pdf-extract.ts pull in, so redaction adds nothing to the boot chunk.
  const { openPdfFile } = await import('../views/pdf-import.ts');
  const { makeTextOutliner, embedFonts } = await import('../lib/pdf-vector-shot.ts');
  const handle = await openPdfFile(new Blob([input as BlobPart], { type: 'application/pdf' }));

  const warnings: string[] = [];
  const pages: RedactedPageImage[] = [];
  for (let i = 0; i < sizes.length; i++) {
    const { width: wPt, height: hPt } = sizes[i]!;
    const cw = Math.max(1, Math.round((wPt * dpi) / 72));
    const ch = Math.max(1, Math.round((hPt * dpi) / 72));
    const canvas = makeCanvas(cw, ch);
    const cx = (canvas as HTMLCanvasElement).getContext('2d');
    if (!cx) throw new Error('PDF redaction needs a 2D canvas context, which this shell does not provide.');
    // Opaque white first: kills alpha-hidden content and lets the JPEG encode
    // be unconditional (no transparency to preserve).
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, cw, ch);
    try {
      const page = await handle.pageToSvg(i, {
        // An <img>-embedded SVG paints no document fonts — outline every run to
        // real paths, with embedFonts as the safety net for unresolved runs.
        outlineText: makeTextOutliner([], host?.text),
        // Terminal raster output, never re-exported — safe to hoist repeats.
        dedupePaths: true,
        idPrefix: `redact${i}-`,
      });
      const svg = await embedFonts(page.svg, []);
      await drawSvgOnCanvas(cx, svg, cw, ch);
    } catch {
      warnings.push(`Page ${i + 1} could not be rendered. It ships as a blank page with its bars burned in.`);
    }
    cx.fillStyle = '#000000';
    for (const bar of bars) {
      if (Math.floor(Number(bar?.page)) !== i + 1) continue;
      const r = core.barToPixels(bar, dpi, cw, ch);
      if (r) cx.fillRect(r.x, r.y, r.w, r.h);
    }
    if (opts?.grayscale) {
      const img = cx.getImageData(0, 0, cw, ch);
      core.grayscaleInPlace(img.data);
      cx.putImageData(img, 0, 0);
    }
    const blob = await canvasToJpeg(canvas, 0.92);
    if (!blob) throw new Error(`Page ${i + 1} could not be encoded as an image.`);
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), widthPt: wPt, heightPt: hPt });
  }

  const out = await core.buildImagePdf(pages);
  return { bytes: out, pages: sizes.length, ...(warnings.length ? { warnings } : {}) };
}
