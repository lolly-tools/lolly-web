// SPDX-License-Identifier: MPL-2.0
/**
 * Take a PDF apart (#/pdf) — the extraction surface.
 *
 * A PDF is a container, and almost every tool that opens one treats it as a
 * single opaque thing you either read whole or convert whole. This view opens it
 * up: the words, and (as the extraction passes land) the images, fonts and
 * attachments inside it, each one viewable, downloadable, and addable to the
 * catalogue.
 *
 * Everything runs on-device. The words are not OCR'd and never uploaded — a
 * born-digital PDF already contains its glyphs and their positions, so
 * `extractPageText` (engine/src/pdf-text.ts) simply puts them back into reading
 * order. The one case that genuinely cannot be served offline is a SCANNED page,
 * which carries a picture of text and no text at all; those are reported as such
 * per page rather than quietly contributing nothing.
 *
 * Structure: one tab per extraction pass — Text, Images, Fonts, Attachments. A
 * tab whose pass found nothing is not rendered at all, so the strip reflects what
 * this document actually contains rather than what a PDF could contain, and a
 * plain text-only document still reads as a single uncluttered column.
 */

import '../styles/parts/pdf-extract.css';   // async CSS chunk (lazy view)
import { joinPageText } from '@lolly/engine';
import type { PageText, HiddenTextFinding } from '@lolly/engine';
import { escape } from '../utils.ts';
import { icon } from '../lib/icons.ts';
import { t } from '../i18n.ts';
import { armViewEnter } from '../view-enter.ts';
import { playSfx } from '../lib/sfx.ts';
import { langFabHtml, attachLangMenu } from '../components/lang-menu.ts';
import { backPillHtml, mountBackPill } from '../components/back-pill.ts';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
import type { PdfHandle, EmbeddedFont, EmbeddedImage, EmbeddedAttachment, ExtractedVector } from './pdf-import.ts';

/** Beyond this a page-by-page reconstruction stops being interactive. */
const MAX_PAGES = 400;
/** Reading a whole PDF into memory twice (bytes + nodes) has a ceiling. */
const MAX_BYTES = 120 * 1024 * 1024;

interface Extracted {
  fileName: string;
  pages: PageText[];
  /** Pages we refused to walk because the document is enormous. */
  truncated: number;
  /** Text an opaque shape is painted over — the failed-redaction check. */
  hidden: HiddenTextFinding[];
  fonts: EmbeddedFont[];
  images: EmbeddedImage[];
  /** Rasters found but not decodable here (JPX, CCITT, JBIG2, …). */
  imagesSkipped: number;
  attachments: EmbeddedAttachment[];
  vectors: ExtractedVector[];
}

/** Object URLs minted for image previews, revoked when the report is replaced. */
let previewUrls: string[] = [];
function releasePreviews(): void {
  for (const u of previewUrls) URL.revokeObjectURL(u);
  previewUrls = [];
}

// ── helpers ───────────────────────────────────────────────────────────────────

const stem = (name: string): string => name.replace(/\.[^.]+$/, '') || 'document';

function download(host: HostV1, text: string, filename: string, mime: string): void {
  void host.export.download(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

/** Words in a page's reconstructed prose — the honest measure of what came out. */
const wordCount = (p: PageText): number => (p.text.match(/\S+/g) ?? []).length;

// Counts. Two whole keys per phrase behind a ternary — the app-wide convention
// (see catalog.ts / gallery.ts), because a translator needs the whole sentence,
// not "{n}" glued to a noun that inflects differently at one.
const nPages = (n: number): string => (n === 1 ? t('1 page') : t('{n} pages', { n }));
const nWords = (n: number): string => (n === 1 ? t('1 word') : t('{n} words', { n }));
const nPlaces = (n: number): string => (n === 1 ? t('1 place') : t('{n} places', { n }));

// ── rendering ─────────────────────────────────────────────────────────────────

function pageMarkup(p: PageText, index: number): string {
  if (p.scanned) {
    return `
      <section class="pdfx-page pdfx-page--scan" data-page="${index}">
        <h3 class="pdfx-page-n">${t('Page {n}', { n: index + 1 })}</h3>
        <p class="pdfx-scan">
          <span class="pdfx-scan-icon" aria-hidden="true">${icon('camera', { size: 20 })}</span>
          ${t('This page is a scanned image. It holds a picture of text, not text, so there is nothing to extract without OCR.')}
        </p>
      </section>`;
  }
  if (!p.blocks.length) {
    return `
      <section class="pdfx-page pdfx-page--empty" data-page="${index}">
        <h3 class="pdfx-page-n">${t('Page {n}', { n: index + 1 })}</h3>
        <p class="pdfx-empty">${t('No text on this page.')}</p>
      </section>`;
  }

  const body = p.blocks.map((b) => {
    if (b.kind === 'heading') {
      const lvl = Math.min(6, Math.max(1, b.level ?? 1));
      return `<p class="pdfx-b pdfx-b--h" data-level="${lvl}">${escape(b.text)}</p>`;
    }
    if (b.kind === 'list-item') return `<p class="pdfx-b pdfx-b--li">${escape(b.text)}</p>`;
    return `<p class="pdfx-b">${escape(b.text)}</p>`;
  }).join('');

  // Notes the reader needs to judge the reconstruction — how many columns it was
  // read as, and whether anything was left out of the flow.
  const notes: string[] = [];
  if (p.columns > 1) notes.push(t('read as {n} columns', { n: p.columns }));
  if (p.rotated) notes.push(t('{n} rotated runs left out', { n: p.rotated }));

  return `
    <section class="pdfx-page" data-page="${index}">
      <h3 class="pdfx-page-n">
        ${t('Page {n}', { n: index + 1 })}
        <span class="pdfx-page-meta">${escape(nWords(wordCount(p)))}${notes.length ? ` · ${escape(notes.join(' · '))}` : ''}</span>
        <button type="button" class="btn btn--ghost pdfx-page-copy" data-copy-page="${index}">${t('Copy')}</button>
      </h3>
      <div class="pdfx-page-body">${body}</div>
    </section>`;
}

/**
 * The failed-redaction banner.
 *
 * Leads the report when it fires, because it changes what the user should do
 * next more than anything else on the page: a document whose black bars do not
 * actually remove the words underneath must not be sent anywhere.
 *
 * It shows the hidden words. That is the whole point — the words are already
 * trivially readable by any extractor, and seeing them is what makes the problem
 * believable rather than theoretical. The wording stays an observation ("not
 * visible"), never an accusation about why.
 */
function hiddenMarkup(hidden: HiddenTextFinding[]): string {
  if (!hidden.length) return '';
  const words = hidden.reduce((a, f) => a + (f.text.match(/\S+/g) ?? []).length, 0);
  const pages = new Set(hidden.map((f) => f.page ?? 0)).size;

  const rows = hidden.map((f) => `
    <li class="pdfx-hidden-row">
      <span class="pdfx-hidden-where">${escape(t('Page {n}', { n: (f.page ?? 0) + 1 }))}</span>
      <code class="pdfx-hidden-text">${escape(f.text)}</code>
    </li>`).join('');

  return `
    <section class="pdfx-hidden" role="alert">
      <h2 class="pdfx-hidden-head">
        <span aria-hidden="true">${icon('eye', { size: 20 })}</span>
        ${t('Text is hidden behind shapes in this document')}
      </h2>
      <p class="pdfx-hidden-lede">${escape(t('{words} in {runs} are covered by opaque shapes on {pages}. They are still in the file, and any PDF reader can pull them back out, including this one below. If these were meant to be redacted, drawing boxes over them did not remove them.', {
        words: nWords(words), runs: nPlaces(hidden.length), pages: nPages(pages),
      }))}</p>
      <ul class="pdfx-hidden-list">${rows}</ul>
    </section>`;
}


/** Bytes → a short human size. */
function sizeLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The Images panel — every raster at its STORED resolution.
 *
 * Stored, not displayed: a logo placed at 20mm may be a 4000px original, and the
 * original is what someone extracting assets actually wants. Each tile previews
 * from an object URL minted here and released when the report is replaced.
 */
function imagesMarkup(x: Extracted): string {
  if (!x.images.length && !x.imagesSkipped) return '';
  const tiles = x.images.map((im, i) => {
    const url = URL.createObjectURL(new Blob([im.bytes as BlobPart], { type: im.mime }));
    previewUrls.push(url);
    const dims = `${im.width}×${im.height}`;
    return `
      <figure class="pdfx-asset" data-image="${i}">
        <div class="pdfx-asset-art"><img src="${escape(url)}" alt="" loading="lazy" decoding="async"></div>
        <figcaption class="pdfx-asset-meta">
          <span class="pdfx-asset-name">${escape(dims)}</span>
          <span class="pdfx-asset-sub">${escape(`${im.mime.replace(/^image\//, '')} · ${sizeLabel(im.bytes.length)} · ${t('page {n}', { n: im.page + 1 })}`)}</span>
        </figcaption>
        <div class="pdfx-asset-actions">
          <button type="button" class="btn btn--ghost" data-save-image="${i}">${t('Download')}</button>
          <button type="button" class="btn btn--ghost" data-catalog-image="${i}">${t('Add to catalogue')}</button>
        </div>
      </figure>`;
  }).join('');

  // Undecodable rasters are STATED, never silently dropped — otherwise a page of
  // JPEG2000 scans looks like a document with no images in it.
  const note = x.imagesSkipped
    ? `<p class="pdfx-note">${t('{n} more images use a compression this browser cannot decode (JPEG 2000, CCITT fax or JBIG2), so they cannot be shown or saved here.', { n: x.imagesSkipped })}</p>`
    : '';

  return `<div class="pdfx-panel" data-panel="images" hidden>${note}<div class="pdfx-assets">${tiles}</div></div>`;
}

/**
 * The Vectors panel — the logos.
 *
 * Most logos in a PDF are vector, so this is usually the most valuable tab:
 * what comes out stays sharp at any size, unlike the raster in the Images tab.
 * Each mark previews as the actual SVG (inline, so it scales in the tile) and
 * carries the reason it was believed to be artwork rather than page furniture —
 * the judgement is a heuristic and the user should be able to see it was made.
 */
function vectorsMarkup(x: Extracted): string {
  if (!x.vectors.length) return '';
  const tiles = x.vectors.map((v, i) => {
    const url = URL.createObjectURL(new Blob([v.svg], { type: 'image/svg+xml' }));
    previewUrls.push(url);
    const swatches = v.fills.slice(0, 6).map((f) =>
      `<span class="pdfx-swatch" style="background:${escape(f)}" title="${escape(f)}"></span>`).join('');
    return `
      <figure class="pdfx-asset" data-vector="${i}">
        <div class="pdfx-asset-art"><img src="${escape(url)}" alt="" loading="lazy" decoding="async"></div>
        <figcaption class="pdfx-asset-meta">
          <span class="pdfx-asset-name">${escape(`${v.width}×${v.height} pt`)}</span>
          <span class="pdfx-asset-sub">${escape(t('{n} shapes · page {p}', { n: v.shapes, p: v.page + 1 }))}</span>
          <span class="pdfx-swatches">${swatches}</span>
          <span class="pdfx-asset-why">${escape(t('Detected by {reason}', { reason: v.reason }))}</span>
        </figcaption>
        <div class="pdfx-asset-actions">
          <button type="button" class="btn btn--ghost" data-save-vector="${i}">${t('Download SVG')}</button>
          <button type="button" class="btn btn--ghost" data-catalog-vector="${i}">${t('Add to catalogue')}</button>
        </div>
      </figure>`;
  }).join('');

  return `<div class="pdfx-panel" data-panel="vectors" hidden><div class="pdfx-assets">${tiles}</div></div>`;
}

/**
 * The Fonts panel.
 *
 * Two caveats ride on every row, and they are the honest part of this feature.
 * A SUBSET carries only the glyphs the document printed, so it will silently
 * lose characters anywhere else — it is not a usable font, whatever its name
 * says. And `fsType` is the font's own machine-readable statement about reuse;
 * a restrictive one is an unambiguous no, and a permissive one still is not the
 * licence. Both are shown per font rather than buried in a general disclaimer.
 */
function fontsMarkup(x: Extracted): string {
  if (!x.fonts.length) return '';

  const PERMISSION: Record<string, string> = {
    installable: t('The font itself states no embedding restriction, which is not the same as a licence to reuse it.'),
    restricted: t('The font forbids reuse outside this document.'),
    'preview-print': t('The font allows viewing and printing only, not reuse.'),
    editable: t('The font allows embedding for editing.'),
    unknown: t('This format carries no embedding statement, so nothing is stated either way.'),
  };

  const rows = x.fonts.map((f, i) => {
    const tags: string[] = [];
    if (f.subset) tags.push(`<span class="pdfx-tag pdfx-tag--warn">${t('subset')}</span>`);
    if (!f.installable) tags.push(`<span class="pdfx-tag">${t('not installable')}</span>`);
    if (f.embedding.permission === 'restricted') tags.push(`<span class="pdfx-tag pdfx-tag--warn">${t('reuse forbidden')}</span>`);

    const caveats: string[] = [];
    if (f.subset) caveats.push(t('Only the glyphs this document used are embedded, so it will be missing characters anywhere else.'));
    if (!f.installable) caveats.push(t('These are raw font-program bytes, not a file a system can install.'));
    caveats.push(PERMISSION[f.embedding.permission] ?? PERMISSION.unknown!);

    return `
      <li class="pdfx-font">
        <div class="pdfx-font-head">
          <span class="pdfx-font-name">${escape(f.family)}</span>
          ${tags.join('')}
          <span class="pdfx-font-sub">${escape(`.${f.ext} · ${sizeLabel(f.bytes.length)}`)}</span>
          <button type="button" class="btn btn--ghost pdfx-font-save" data-save-font="${i}">${t('Download')}</button>
        </div>
        <p class="pdfx-font-caveat">${escape(caveats.join(' '))}</p>
      </li>`;
  }).join('');

  return `<div class="pdfx-panel" data-panel="fonts" hidden><ul class="pdfx-fonts">${rows}</ul></div>`;
}

/** The Attachments panel — the files the document carries inside it. */
function attachmentsMarkup(x: Extracted): string {
  if (!x.attachments.length) return '';
  const rows = x.attachments.map((a, i) => `
    <li class="pdfx-att">
      <span class="pdfx-att-icon" aria-hidden="true">${icon('package', { size: 18 })}</span>
      <span class="pdfx-att-name">${escape(a.name)}</span>
      <span class="pdfx-att-sub">${escape(sizeLabel(a.bytes.length))}</span>
      <button type="button" class="btn btn--ghost" data-save-att="${i}">${t('Download')}</button>
    </li>`).join('');

  return `
    <div class="pdfx-panel" data-panel="attachments" hidden>
      <p class="pdfx-note">${t('These files ride inside the PDF. Opening one runs whatever it is, so treat an attachment from a document you did not make the way you would treat any other unexpected file.')}</p>
      <ul class="pdfx-atts">${rows}</ul>
    </div>`;
}

function resultMarkup(x: Extracted): string {
  const words = x.pages.reduce((a, p) => a + wordCount(p), 0);
  const scans = x.pages.filter((p) => p.scanned).length;

  const summary: string[] = [nPages(x.pages.length), nWords(words)];
  if (scans) summary.push(t('{n} scanned', { n: scans }));

  // An all-scan document deserves the headline, not a footnote: the user's next
  // move (find an OCR tool) is completely different from "read the text".
  const allScans = scans > 0 && scans === x.pages.length;

  // Only passes that FOUND something get a tab, so the strip describes this
  // document rather than what a PDF could theoretically hold.
  const tabs = [
    { id: 'text', label: t('Text'), n: 0 },
    ...(x.vectors.length ? [{ id: 'vectors', label: t('Logos'), n: x.vectors.length }] : []),
    ...(x.images.length ? [{ id: 'images', label: t('Images'), n: x.images.length }] : []),
    ...(x.fonts.length ? [{ id: 'fonts', label: t('Fonts'), n: x.fonts.length }] : []),
    ...(x.attachments.length ? [{ id: 'attachments', label: t('Attachments'), n: x.attachments.length }] : []),
  ].map((tb) => ({ ...tb, label: tb.n ? `${tb.label} (${tb.n})` : tb.label }));

  return `
    <div class="pdfx-result">
      <div class="pdfx-bar">
        <div class="pdfx-bar-meta">
          <strong class="pdfx-file">${escape(x.fileName)}</strong>
          <span class="pdfx-sum">${escape(summary.join(' · '))}</span>
        </div>
        <div class="pdfx-bar-actions">
          <button type="button" class="btn" data-act="copy">${t('Copy all')}</button>
          <button type="button" class="btn" data-act="md">${t('Download .md')}</button>
          <button type="button" class="btn" data-act="txt">${t('Download .txt')}</button>
          <button type="button" class="btn btn--ghost" data-act="clear">${t('Open another')}</button>
        </div>
      </div>

      ${hiddenMarkup(x.hidden)}

      ${x.truncated ? `<p class="pdfx-note">${t('Only the first {n} pages were read. The rest of this document is too long to take apart here.', { n: x.pages.length })}</p>` : ''}
      ${allScans ? `<p class="pdfx-note pdfx-note--warn">${t('Every page in this document is a scanned image. There is no text layer to extract, and reading it would need OCR, which does not run on-device.')}</p>` : ''}

      <div class="pdfx-tabs" role="tablist">
        ${tabs.map((tb, i) => `<button type="button" class="pdfx-tab${i ? '' : ' is-active'}" role="tab" aria-selected="${i ? 'false' : 'true'}" data-tab="${tb.id}">${escape(tb.label)}</button>`).join('')}
      </div>

      <div class="pdfx-pages pdfx-panel" data-panel="text">
        ${x.pages.map(pageMarkup).join('')}
      </div>
      ${vectorsMarkup(x)}
      ${imagesMarkup(x)}
      ${fontsMarkup(x)}
      ${attachmentsMarkup(x)}
    </div>`;
}

// ── mount ─────────────────────────────────────────────────────────────────────

export async function mountPdfExtract(viewEl: HTMLElement, host: HostV1): Promise<void> {
  viewEl.innerHTML = `
    ${backPillHtml()}
    <div class="gallery-topright">${langFabHtml()}</div>
    <div class="platform-layout pdfx-layout">
      <header class="plat-header">
        <h1 class="plat-title">${t('Take a PDF apart')}</h1>
        <div class="plat-header-text">
          <p class="plat-sub">${t('Pull the words, images, fonts and attachments out of any PDF and keep what you need. Runs entirely on this device; the file is never uploaded.')}</p>
        </div>
      </header>

      <div class="pdfx-drop" data-drop tabindex="0" role="button" aria-label="${escape(t('Choose or drop a PDF to take apart'))}">
        <input type="file" accept=".pdf,.ai,application/pdf" hidden>
        <span class="pdfx-drop-icon" aria-hidden="true">${icon('document', { size: 32 })}</span>
        <strong>${t('Drop a PDF here')}</strong>
        <span>${t('pdf · ai · nothing leaves your device')}</span>
      </div>

      <div class="pdfx-out" data-out hidden></div>
    </div>
  `;
  armViewEnter(viewEl, '.tools-home, .plat-header, .pdfx-drop');
  mountBackPill(viewEl);
  attachLangMenu(viewEl.querySelector<HTMLElement>('.lang-fab'), host);

  const drop = viewEl.querySelector<HTMLElement>('[data-drop]')!;
  const input = drop.querySelector<HTMLInputElement>('input[type="file"]')!;
  const out = viewEl.querySelector<HTMLElement>('[data-out]')!;

  let current: Extracted | null = null;

  function fail(message: string): void {
    current = null;
    out.hidden = false;
    drop.hidden = false;
    out.innerHTML = `<p class="pdfx-error">${escape(message)}</p>`;
  }

  async function open(file: File): Promise<void> {
    if (file.size > MAX_BYTES) {
      fail(t('That file is too large to take apart here (over {n} MB).', { n: Math.round(MAX_BYTES / 1024 / 1024) }));
      return;
    }
    out.hidden = false;
    out.innerHTML = `<p class="pdfx-busy">${t('Reading {name}…', { name: escape(file.name) })}</p>`;

    let handle: PdfHandle;
    try {
      const { openPdfFile } = await import('./pdf-import.ts');
      handle = await openPdfFile(file);
    } catch (err) {
      host.log('warn', 'pdf-extract: open failed', { error: (err as Error)?.message });
      fail(t('That file could not be opened as a PDF. If it is password-protected, remove the password first.'));
      return;
    }
    if (!handle.pageToText) {
      fail(t('This build cannot read text out of that file.'));
      return;
    }

    const total = handle.pageCount;
    const count = Math.min(total, MAX_PAGES);
    const pages: PageText[] = [];
    for (let i = 0; i < count; i++) {
      try {
        pages.push(handle.pageToText(i));
      } catch (err) {
        // One unreadable page must not cost the other 200. It reports as empty,
        // which is what the reader sees anyway.
        host.log('warn', 'pdf-extract: page failed', { page: i, error: (err as Error)?.message });
        pages.push({ blocks: [], text: '', markdown: '', columns: 1, scanned: false, rotated: 0, order: 'geometric' });
      }
      // Yield between pages so a long document keeps the view responsive and the
      // busy line stays painted.
      if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
    }

    // The redaction check reuses the interpreted nodes the text pass just built,
    // so it costs almost nothing here — and it is the finding most worth having.
    let hidden: HiddenTextFinding[] = [];
    try {
      hidden = handle.findHiddenText?.({ maxPages: count })?.findings ?? [];
    } catch (err) {
      host.log('warn', 'pdf-extract: hidden-text scan failed', { error: (err as Error)?.message });
    }

    // Assets. Each pass is independently guarded — a document with an
    // unwalkable font table should still hand over its images.
    let fonts: EmbeddedFont[] = [];
    try { fonts = handle.listFonts?.() ?? []; }
    catch (err) { host.log('warn', 'pdf-extract: font scan failed', { error: (err as Error)?.message }); }

    let images: EmbeddedImage[] = [];
    let imagesSkipped = 0;
    try {
      const scan = await handle.listImages?.();
      images = scan?.images ?? [];
      imagesSkipped = scan?.skipped ?? 0;
    } catch (err) { host.log('warn', 'pdf-extract: image scan failed', { error: (err as Error)?.message }); }

    let vectors: ExtractedVector[] = [];
    try { vectors = await handle.listVectors?.({ maxPages: Math.min(count, 40) }) ?? []; }
    catch (err) { host.log('warn', 'pdf-extract: vector scan failed', { error: (err as Error)?.message }); }

    let attachments: EmbeddedAttachment[] = [];
    try { attachments = handle.listAttachments?.() ?? []; }
    catch (err) { host.log('warn', 'pdf-extract: attachment scan failed', { error: (err as Error)?.message }); }

    releasePreviews();
    current = {
      fileName: file.name, pages, truncated: Math.max(0, total - count), hidden,
      fonts, images, imagesSkipped, attachments, vectors,
    };
    drop.hidden = true;
    out.innerHTML = resultMarkup(current);
    playSfx('land');
  }

  function reset(): void {
    releasePreviews();
    current = null;
    out.hidden = true;
    out.innerHTML = '';
    drop.hidden = false;
    input.value = '';
  }

  /**
   * Put an extracted raster into the user's asset library.
   *
   * This is the point of the whole view over any other PDF tool: an extracted
   * asset lands somewhere it can be used, instead of in a downloads folder.
   */
  async function addToCatalogue(im: EmbeddedImage, index: number, btn: HTMLElement): Promise<void> {
    const was = btn.textContent;
    btn.textContent = t('Adding…');
    try {
      const { storeUserUpload } = await import('./picker.ts');
      const ext = im.mime.replace(/^image\//, '').replace('jpeg', 'jpg');
      const name = `${stem(current!.fileName)}-image-${index + 1}.${ext}`;
      const file = new File([im.bytes as BlobPart], name, { type: im.mime });
      await storeUserUpload(host as unknown as Parameters<typeof storeUserUpload>[0], file);
      btn.textContent = t('Added');
      playSfx('save');
    } catch (err) {
      host.log('warn', 'pdf-extract: catalogue add failed', { error: (err as Error)?.message });
      btn.textContent = t('Could not add');
    }
    setTimeout(() => { btn.textContent = was; }, 1800);
  }

  /**
   * Put an extracted logo into the asset library.
   *
   * The File MUST carry an explicit image/svg+xml MIME: storeUserUpload detects
   * vectors by MIME *or* extension so the SVG would still be sanitised, but the
   * stored `format` comes from the MIME alone — without it the asset is recorded
   * as 'bin' and displayed as "logo.bin". The name is counter-unique because the
   * asset id is minted from `Date.now()` plus the filename, so two same-named
   * files stored in one millisecond silently overwrite each other.
   */
  async function addVectorToCatalogue(v: ExtractedVector, index: number, btn: HTMLElement): Promise<void> {
    const was = btn.textContent;
    btn.textContent = t('Adding…');
    try {
      const { storeUserUpload } = await import('./picker.ts');
      const name = `${stem(current!.fileName)}-logo-${index + 1}.svg`;
      const file = new File([v.svg], name, { type: 'image/svg+xml' });
      await storeUserUpload(host as unknown as Parameters<typeof storeUserUpload>[0], file);
      btn.textContent = t('Added');
      playSfx('save');
    } catch (err) {
      host.log('warn', 'pdf-extract: vector catalogue add failed', { error: (err as Error)?.message });
      btn.textContent = t('Could not add');
    }
    setTimeout(() => { btn.textContent = was; }, 1800);
  }

  async function copy(text: string, btn: HTMLElement | null): Promise<void> {
    try {
      await host.clipboard.writeText(text);
      if (btn) {
        const was = btn.textContent;
        btn.textContent = t('Copied');
        setTimeout(() => { btn.textContent = was; }, 1400);
      }
    } catch {
      host.log('warn', 'pdf-extract: clipboard refused');
    }
  }

  // ── wiring ──────────────────────────────────────────────────────────────────

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void open(f);
  });

  for (const type of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop'] as const) {
    drop.addEventListener(type, () => drop.classList.remove('is-over'));
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void open(f);
  });

  /** Show one panel and light its tab. */
  function showPanel(id: string): void {
    for (const panel of out.querySelectorAll<HTMLElement>('.pdfx-panel')) {
      panel.hidden = panel.dataset.panel !== id;
    }
    for (const tab of out.querySelectorAll<HTMLElement>('.pdfx-tab')) {
      const on = tab.dataset.tab === id;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    }
  }

  function saveBytes(bytes: Uint8Array, filename: string, mime: string): void {
    void host.export.download(new Blob([bytes as BlobPart], { type: mime }), filename);
  }

  out.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (!current) return;

    const tab = el.closest<HTMLElement>('[data-tab]');
    if (tab?.dataset.tab) { showPanel(tab.dataset.tab); return; }

    const pageBtn = el.closest<HTMLElement>('[data-copy-page]');
    if (pageBtn) {
      const p = current.pages[Number(pageBtn.dataset.copyPage)];
      if (p) void copy(p.text, pageBtn);
      return;
    }

    const base = stem(current.fileName);

    const saveImg = el.closest<HTMLElement>('[data-save-image]');
    if (saveImg) {
      const im = current.images[Number(saveImg.dataset.saveImage)];
      if (im) saveBytes(im.bytes, `${base}-image-${Number(saveImg.dataset.saveImage) + 1}.${im.mime.replace(/^image\//, '').replace('jpeg', 'jpg')}`, im.mime);
      return;
    }

    const toCatalog = el.closest<HTMLElement>('[data-catalog-image]');
    if (toCatalog) {
      const i = Number(toCatalog.dataset.catalogImage);
      const im = current.images[i];
      if (im) void addToCatalogue(im, i, toCatalog);
      return;
    }

    const saveVec = el.closest<HTMLElement>('[data-save-vector]');
    if (saveVec) {
      const i = Number(saveVec.dataset.saveVector);
      const v = current.vectors[i];
      if (v) saveBytes(new TextEncoder().encode(v.svg), `${base}-logo-${i + 1}.svg`, 'image/svg+xml');
      return;
    }

    const catVec = el.closest<HTMLElement>('[data-catalog-vector]');
    if (catVec) {
      const i = Number(catVec.dataset.catalogVector);
      const v = current.vectors[i];
      if (v) void addVectorToCatalogue(v, i, catVec);
      return;
    }

    const saveFont = el.closest<HTMLElement>('[data-save-font]');
    if (saveFont) {
      const f = current.fonts[Number(saveFont.dataset.saveFont)];
      // The stored name keeps the subset prefix when there is one — the file IS a
      // subset, and naming it plainly would invite installing it as the real face.
      if (f) saveBytes(f.bytes, `${f.name.replace(/[^a-z0-9.+-]/gi, '_')}.${f.ext}`, 'font/otf');
      return;
    }

    const saveAtt = el.closest<HTMLElement>('[data-save-att]');
    if (saveAtt) {
      const a = current.attachments[Number(saveAtt.dataset.saveAtt)];
      if (a) saveBytes(a.bytes, a.name.replace(/[^a-z0-9._-]/gi, '_') || 'attachment', a.mime);
      return;
    }

    const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'copy') void copy(joinPageText(current.pages, { markdown: false }), el.closest<HTMLElement>('[data-act]'));
    else if (act === 'md') download(host, joinPageText(current.pages), `${base}.md`, 'text/markdown');
    else if (act === 'txt') download(host, joinPageText(current.pages, { markdown: false }), `${base}.txt`, 'text/plain');
    else if (act === 'clear') reset();
  });
}
