// SPDX-License-Identifier: MPL-2.0
/**
 * Universal drop router — the "drop a file on the front door" seam (gallery +
 * dashboard roots, and the welcome dialog's file-picker fallback). A SCOPED
 * drag-and-drop handler sniffs what landed and opens a chooser sheet offering
 * only the routes that genuinely apply:
 *
 *   design file (.fig/.penpot/.idml/.indd/SVG/zip) → Layout Studio, parsed to boxes
 *   PDF / .ai   → edit as a design · pages → SVG library assets · compress
 *   PowerPoint  → slides → SVG library assets
 *   image/video/audio → the asset library · /verify (Content Credentials)
 *   unknown / C2PA-looking bytes → /verify
 *
 * Design files travel by the same one-shot in-memory handoff pattern
 * lib/verify-handoff.ts proves: the File is stashed here, we navigate to
 * #/tool/layout-studio, and free-canvas consumes it on mount
 * (takePendingDesignImport) through the exact code path of its Import panel.
 *
 * Deliberately light at module scope: the picker (storeUserUpload), pdf-import
 * and pptx-import chunks all load lazily at drop/choice time, so attaching the
 * router costs the gallery cold path nothing. The byte sniff here is a few
 * local magic-number checks (zip 'PK', '%PDF', '<svg', JUMBF/'c2pa' markers) —
 * NOT a duplicate of design-import.ts's full format routing: real format
 * resolution (Penpot vs .fig vs IDML inside a zip, PDF page interpretation)
 * still happens solely in parseDesignFile once a design file reaches it.
 * design-import's own sniffers are module-private and ship in the heavy
 * kiwi/zstd chunk, which a JPEG drop should never pull in.
 *
 * House rules honoured: handlers attach to the given root only (never window/
 * document), preventDefault fires only for actual file drags, the chooser is
 * mountModal-based (via choiceDialog — Escape/backdrop close), and the DOM
 * cost is one hint pill per attached root.
 */

import { t } from '../i18n.ts';
import { NAV_EVENTS } from '../utils.ts';
import { announce } from '../a11y.ts';
import { playSfx } from './sfx.ts';
import { choiceDialog } from '../components/confirm-dialog.ts';
import type { DialogChoice } from '../components/confirm-dialog.ts';
import { setPendingVerify } from './verify-handoff.ts';
import type { PickerHost } from '../views/picker.ts';

type PickerModule = typeof import('../views/picker.ts');

/** Everything the file-picker fallback should let through — a superset of the
 *  picker's UPLOAD_ACCEPT (that list deliberately excludes design formats). */
const UNIVERSAL_ACCEPT =
  '.fig,.penpot,.zip,.svg,.idml,.indd,.pdf,.ai,.pptx,image/*,video/*,audio/*,' +
  '.mov,.json,.lottie,.mp3,.wav,.ogg,.m4a,.flac';

// Extension fallbacks for files whose MIME type the OS didn't fill in.
const DESIGN_EXT_RE = /\.(fig|penpot|idml|indd|svg|zip)$/i;
const MEDIA_EXT_RE = /\.(png|apng|jpe?g|webp|gif|avif|heic|heif|svg|mp4|webm|mov|mp3|wav|ogg|oga|opus|m4a|aac|flac|mid|midi|mod|xm|it|s3m|stm|mtm|json|lottie)$/i;

// ── one-shot handoff stashes (the verify-handoff pattern) ──────────────────────

let pendingDesign: File | null = null;

/** Consume the design file stashed by the "Edit in Layout Studio" route —
 *  single use, cleared on read. free-canvas checks this on mount. */
export function takePendingDesignImport(): File | null {
  const f = pendingDesign;
  pendingDesign = null;
  return f;
}

let pendingToolFile: { toolId: string; file: File } | null = null;

/** Consume a file stashed for a specific tool (e.g. compress-pdf). Single use;
 *  returns null when the stash belongs to a different tool. NOTE: views/tool.ts
 *  does not consume this yet — until it does, the compress route simply lands
 *  the user on the tool's own (empty) drop canvas. */
export function takePendingToolFile(toolId: string): File | null {
  if (pendingToolFile?.toolId !== toolId) return null;
  const f = pendingToolFile.file;
  pendingToolFile = null;
  return f;
}

// ── sniffing ───────────────────────────────────────────────────────────────────

interface Sniff {
  design: boolean;
  pdf: boolean;
  pptx: boolean;
  media: boolean;
  c2pa: boolean;
}

const isMediaFile = (f: File): boolean =>
  /^(image|video|audio)\//.test(f.type) || MEDIA_EXT_RE.test(f.name);

/**
 * Classify one file by name/MIME plus (when `deep`) a bounded head read — 64 KB,
 * enough for the zip/PDF/SVG magic and a C2PA marker scan, never the whole file.
 */
async function sniffFile(file: File, deep: boolean, picker: PickerModule): Promise<Sniff> {
  const pptx = picker.isPptxUpload(file);
  let head: Uint8Array | null = null;
  if (deep) {
    try {
      head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
    } catch { /* unreadable — fall back to name/MIME only */ }
  }
  // latin1 keeps a 1:1 byte↔char mapping, so regex offsets equal byte offsets.
  const text = head ? new TextDecoder('latin1').decode(head) : '';
  // "%PDF" within the first 1 KB (the spec permits a little leading junk) —
  // mirrors design-import's isPdf window without pulling its chunk in.
  const pdf = picker.isPdfUpload(file) || text.slice(0, 1028).includes('%PDF');
  const zipMagic = !!head && head.length >= 4
    && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const svgText = /<svg[\s>]/i.test(text.slice(0, 4096));
  // JUMBF box type / C2PA manifest label / PNG caBX chunk — a heuristic "this
  // carries Content Credentials" signal, not a verification (that's /verify's job).
  const c2pa = /jumb|c2pa|caBX/.test(text);
  const design = !pdf && !pptx && (DESIGN_EXT_RE.test(file.name) || zipMagic || svgText);
  return { design, pdf, pptx, media: isMediaFile(file), c2pa };
}

const toolExists = (id: string): boolean =>
  ((window as { __toolIndex?: { tools?: Array<{ id: string }> } }).__toolIndex?.tools ?? [])
    .some((tool) => tool.id === id);

// ── the chooser sheet ──────────────────────────────────────────────────────────

/**
 * Sniff the dropped/picked file(s) and offer the applicable routes. Built on
 * choiceDialog (mountModal + .btn primitives; Escape/backdrop cancel). Multi-file
 * drops keep only the batch routes (library / verify) — the design and PDF routes
 * are single-file journeys.
 */
export async function openDropChooser(files: File[], host: PickerHost): Promise<void> {
  if (!files.length) return;
  const picker = await import('../views/picker.ts');
  const single = files.length === 1;
  const first = files[0]!;
  const s = await sniffFile(first, single, picker);
  const allIngestable = files.every(
    (f) => isMediaFile(f) || picker.isPdfUpload(f) || picker.isPptxUpload(f),
  );

  const choices: DialogChoice[] = [];
  if (single && (s.design || s.pdf) && toolExists('layout-studio')) {
    choices.push({ id: 'design', label: t('Edit in Layout Studio'), primary: true });
  }
  if (single && s.pdf) {
    choices.push({ id: 'library', label: t('Add pages to your library') });
    if (toolExists('compress-pdf')) choices.push({ id: 'compress', label: t('Compress this PDF') });
  }
  if (single && s.pptx) {
    choices.push({ id: 'library', label: t('Add slides to your library'), primary: true });
  }
  if ((single && s.media && !s.pdf && !s.pptx) || (!single && allIngestable)) {
    choices.push({ id: 'library', label: t('Add to your library'), primary: choices.length === 0 });
  }
  const unknown = single && !s.design && !s.pdf && !s.pptx && !s.media;
  // Provenance applies to media, to anything carrying C2PA-looking bytes, to
  // unknown formats — and as the last resort when no other route landed.
  if (s.media || s.c2pa || unknown || choices.length === 0) {
    choices.push({ id: 'verify', label: t('Check Content Credentials') });
  }

  let message: string;
  if (!single) message = t('{n} files are ready to import.', { n: files.length });
  else if (s.pdf) message = t('“{name}” is a PDF or Illustrator document.', { name: first.name });
  else if (s.pptx) message = t('“{name}” is a PowerPoint deck.', { name: first.name });
  else if (s.design) message = t('“{name}” looks like a design file.', { name: first.name });
  else if (s.media) message = t('“{name}” is ready to import.', { name: first.name });
  else message = t('“{name}” isn’t a format Lolly can import directly.', { name: first.name });

  const chosen = await choiceDialog({
    title: single ? t('What should Lolly do with this file?') : t('What should Lolly do with these files?'),
    message,
    choices,
  });
  if (!chosen) return;

  switch (chosen) {
    case 'design':
      pendingDesign = first;
      window.location.hash = '#/tool/layout-studio';
      break;
    case 'compress':
      pendingToolFile = { toolId: 'compress-pdf', file: first };
      window.location.hash = '#/tool/compress-pdf';
      break;
    case 'verify':
      setPendingVerify({ files });
      window.location.hash = '#/verify';
      break;
    case 'library':
      await ingestToLibrary(files, host, picker);
      break;
  }
}

/**
 * The library route — the same sequential ingest loop as lib/upload-dropzone.ts:
 * PDFs/decks convert page(s)/slide(s) to SVG assets via their lazy chunks,
 * everything else stores through storeUserUpload (downscale/sanitise/credential-
 * preserve). Sequential on purpose: parallel decodes of a big drop spike memory.
 */
async function ingestToLibrary(files: File[], host: PickerHost, picker: PickerModule): Promise<void> {
  let stored = 0;
  for (const file of files) {
    try {
      if (picker.isPdfUpload(file)) {
        const { ingestPdfAsSvgAssets } = await import('../views/pdf-import.ts');
        stored += (await ingestPdfAsSvgAssets(host, file, {
          mode: 'multi',
          warn: (m: string) => announce(m, { assertive: true }),
        })).length;
      } else if (picker.isPptxUpload(file)) {
        const { ingestPptxAsSvgAssets } = await import('../views/pptx-import.ts');
        stored += (await ingestPptxAsSvgAssets(host, file, {
          mode: 'multi',
          warn: (m: string) => announce(m, { assertive: true }),
        })).length;
      } else {
        await picker.storeUserUpload(host, file);
        stored += 1;
      }
    } catch (err) {
      // Cap/quota errors carry a user-ready message; prefix only the rest.
      announce(
        (err as { code?: unknown }).code
          ? (err as Error).message
          : t('Upload failed: {message}', { message: (err as Error).message }),
        { assertive: true },
      );
    }
  }
  if (!stored) return;
  playSfx('drop');
  announce(stored === 1
    ? t('Added 1 file to your library.')
    : t('Added {n} files to your library.', { n: stored }));
}

// ── scoped drag-and-drop attachment ────────────────────────────────────────────

// One live attachment per root: same-route re-mounts (the gallery re-mounts
// after a catalog sync) replace theirs instead of stacking listeners.
const ATTACHED = new WeakMap<HTMLElement, () => void>();

/**
 * Attach the drop router to a view root. Only file drags are handled (text/image
 * drags keep their browser defaults untouched); while one hovers, the root gains
 * `.is-file-drag` and a small hint pill (styled by the view's own stylesheet).
 * The shell reuses one #view element across routes, so the attachment tears
 * itself down on any navigation — a tool view can never inherit it. Returns the
 * teardown for callers that want it earlier.
 */
export function attachDropRouter(rootEl: HTMLElement, host: PickerHost): () => void {
  ATTACHED.get(rootEl)?.();
  const ac = new AbortController();
  const { signal } = ac;
  let depth = 0;
  let hint: HTMLElement | null = null;

  const isFileDrag = (e: DragEvent): boolean => !!e.dataTransfer?.types?.includes('Files');
  const showHint = (on: boolean): void => {
    if (on) {
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'drop-hint';
        hint.setAttribute('aria-hidden', 'true');
        hint.textContent = t('Drop to import');
      }
      // (Re-)append: a same-route innerHTML repaint may have orphaned the pill.
      if (!hint.isConnected) rootEl.appendChild(hint);
    } else {
      depth = 0;
    }
    rootEl.classList.toggle('is-file-drag', on);
  };

  rootEl.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth++;
    showHint(true);
  }, { signal });
  rootEl.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); // required, or the drop never fires
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, { signal });
  rootEl.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    // A depth counter tracks enter/leave across child nodes so the hint
    // doesn't flicker as the pointer crosses them.
    if (--depth <= 0) showHint(false);
  }, { signal });
  rootEl.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    showHint(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void openDropChooser(files, host);
  }, { signal });

  const teardown = (): void => {
    ac.abort();
    hint?.remove();
    rootEl.classList.remove('is-file-drag');
    NAV_EVENTS.forEach((ev) => window.removeEventListener(ev, teardown));
    if (ATTACHED.get(rootEl) === teardown) ATTACHED.delete(rootEl);
  };
  NAV_EVENTS.forEach((ev) => window.addEventListener(ev, teardown));
  ATTACHED.set(rootEl, teardown);
  return teardown;
}

/**
 * No-drag fallback (the welcome dialog's "Bring your design" tile): a native
 * file picker that feeds the same chooser. The input is parked on <body> and
 * removed on change/cancel.
 */
export function openDropFilePicker(host: PickerHost): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = UNIVERSAL_ACCEPT;
  input.style.display = 'none';
  document.body.appendChild(input);
  const done = (): void => input.remove();
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    done();
    if (files.length) void openDropChooser(files, host);
  });
  input.addEventListener('cancel', done);
  input.click();
}
