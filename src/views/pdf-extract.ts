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
 * Structure note: the tab strip exists with one tab today. That is deliberate —
 * Images, Fonts and Attachments are separate extraction passes still to land,
 * and giving them their home now keeps each one a data change rather than a
 * re-layout. A tab with nothing behind it is never rendered.
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
import type { PdfHandle } from './pdf-import.ts';

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
}

// ── helpers ───────────────────────────────────────────────────────────────────

const stem = (name: string): string => name.replace(/\.[^.]+$/, '') || 'document';

function download(host: HostV1, text: string, filename: string, mime: string): void {
  void host.export.download(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

/** Words in a page's reconstructed prose — the honest measure of what came out. */
const wordCount = (p: PageText): number => (p.text.match(/\S+/g) ?? []).length;

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
        <span class="pdfx-page-meta">${escape(t('{n} words', { n: wordCount(p) }))}${notes.length ? ` · ${escape(notes.join(' · '))}` : ''}</span>
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
      <p class="pdfx-hidden-lede">${t('{words} words in {runs} places are covered by opaque shapes on {pages} pages. They are still in the file, and any PDF reader can pull them back out — including this one, below. If these were meant to be redacted, drawing boxes over them did not remove them.', {
        words, runs: hidden.length, pages,
      })}</p>
      <ul class="pdfx-hidden-list">${rows}</ul>
    </section>`;
}

function resultMarkup(x: Extracted): string {
  const words = x.pages.reduce((a, p) => a + wordCount(p), 0);
  const scans = x.pages.filter((p) => p.scanned).length;

  const summary: string[] = [t('{n} pages', { n: x.pages.length }), t('{n} words', { n: words })];
  if (scans) summary.push(t('{n} scanned', { n: scans }));

  // An all-scan document deserves the headline, not a footnote: the user's next
  // move (find an OCR tool) is completely different from "read the text".
  const allScans = scans > 0 && scans === x.pages.length;

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

      ${x.truncated ? `<p class="pdfx-note">${t('Only the first {n} pages were read — the rest of this document is too long to take apart here.', { n: x.pages.length })}</p>` : ''}
      ${allScans ? `<p class="pdfx-note pdfx-note--warn">${t('Every page in this document is a scanned image. There is no text layer to extract, and reading it would need OCR, which does not run on-device.')}</p>` : ''}

      <div class="pdfx-tabs" role="tablist">
        <button type="button" class="pdfx-tab is-active" role="tab" aria-selected="true" data-tab="text">${t('Text')}</button>
      </div>

      <div class="pdfx-pages" data-panel="text">
        ${x.pages.map(pageMarkup).join('')}
      </div>
    </div>`;
}

// ── mount ─────────────────────────────────────────────────────────────────────

export async function mountPdfExtract(viewEl: HTMLElement, host: HostV1): Promise<void> {
  viewEl.innerHTML = `
    <div class="tools-home pdfx-view">
      ${backPillHtml()}
      ${langFabHtml()}
      <header class="plat-header">
        <h1 class="plat-title">${t('Take a PDF apart')}</h1>
        <div class="plat-header-text">
          <p class="plat-sub">${t('Pull the words out of any PDF, page by page, and keep them as plain text or markdown. Runs entirely on this device; the file is never uploaded.')}</p>
        </div>
      </header>

      <div class="pdfx-drop" data-drop tabindex="0" role="button" aria-label="${escape(t('Choose or drop a PDF to take apart'))}">
        <input type="file" accept=".pdf,.ai,application/pdf" hidden>
        <span class="pdfx-drop-icon" aria-hidden="true">${icon('document', { size: 32 })}</span>
        <strong>${t('Drop a PDF here')}</strong>
        <span>${t('pdf · ai — nothing leaves your device')}</span>
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

    current = { fileName: file.name, pages, truncated: Math.max(0, total - count), hidden };
    drop.hidden = true;
    out.innerHTML = resultMarkup(current);
    playSfx('land');
  }

  function reset(): void {
    current = null;
    out.hidden = true;
    out.innerHTML = '';
    drop.hidden = false;
    input.value = '';
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

  out.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (!current) return;

    const pageBtn = el.closest<HTMLElement>('[data-copy-page]');
    if (pageBtn) {
      const p = current.pages[Number(pageBtn.dataset.copyPage)];
      if (p) void copy(p.text, pageBtn);
      return;
    }

    const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    const base = stem(current.fileName);
    if (act === 'copy') void copy(joinPageText(current.pages, { markdown: false }), el.closest<HTMLElement>('[data-act]'));
    else if (act === 'md') download(host, joinPageText(current.pages), `${base}.md`, 'text/markdown');
    else if (act === 'txt') download(host, joinPageText(current.pages, { markdown: false }), `${base}.txt`, 'text/plain');
    else if (act === 'clear') reset();
  });
}
