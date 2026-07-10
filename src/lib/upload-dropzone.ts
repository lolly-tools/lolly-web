// SPDX-License-Identifier: MPL-2.0
/**
 * Shared upload dropzone — the catalogue view's "Your uploads" drop area, extracted
 * into a mountable component so the #/start Catalogue tab can offer the same ingest
 * surface. Drag files in or click to browse: a <label> over a visually-hidden file
 * input, so click-to-open is native and the input stays keyboard-focusable
 * (Enter/Space opens the OS picker; .updz:focus-within draws the ring).
 *
 * Files ingest through the SAME storeUserUpload path as the asset picker (downscale/
 * sanitise/credential-preserve/animated-sniff); a PDF/.ai converts page(s) to SVG
 * assets via the lazily-loaded pdf-import chunk. Ingest is sequential on purpose —
 * parallel ingest of a big multi-drop would spike memory (each raster decode holds a
 * full bitmap) — and the single-flight guard is module-level so a mid-ingest re-mount
 * (the catalogue rebuilds its body per render) can't open a second lane.
 */
import { storeUserUpload, isPdfUpload, UPLOAD_ACCEPT } from '../views/picker.ts';
import type { PickerHost } from '../views/picker.ts';
import { announce } from '../a11y.ts';
import { playSfx } from './sfx.ts';
import { escape } from '../utils.ts';
import '../styles/parts/dropzone.css';

export interface DropzoneOpts {
  /** Filetype hint line under the prompt; defaults to the full ingest-path list. */
  hint?: string;
  /** Tighter row for dense surfaces (hides the hint line). */
  compact?: boolean;
  /** Called after a successful ingest with how many assets landed. */
  onAdded?: (count: number) => void | Promise<void>;
}

// What the ingest path ACTUALLY accepts — keep in step with UPLOAD_ACCEPT.
const DEFAULT_HINT = 'Images (PNG, JPG, WEBP, GIF), SVG, PDF & Illustrator, audio (MP3, WAV, OGG, M4A, FLAC), plus video & Lottie';

// Lucide-style upload glyph (themes via currentColor; sized in dropzone.css).
const UPLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>';

// One ingest at a time ACROSS every mounted dropzone (see the module doc above).
let ingesting = false;

/**
 * Render the dropzone into `container` and wire its ingest loop. Returns a teardown
 * that drops the listeners — call it before re-painting the surface that holds the
 * mount (an in-flight ingest keeps running and still delivers its onAdded).
 */
export function mountUploadDropzone(container: HTMLElement, host: PickerHost, opts: DropzoneOpts = {}): () => void {
  container.innerHTML = `
    <label class="updz${opts.compact ? ' updz--compact' : ''}">
      <input type="file" class="updz-input visually-hidden" multiple accept="${escape(UPLOAD_ACCEPT)}" aria-label="Upload files to your library">
      <span class="updz-icon" aria-hidden="true">${UPLOAD_ICON}</span>
      <span class="updz-copy">
        <span class="updz-text">Drag &amp; drop files here, or <span class="updz-browse">browse</span></span>
        <span class="updz-hint">${escape(opts.hint ?? DEFAULT_HINT)}</span>
      </span>
    </label>`;
  const zone = container.querySelector<HTMLElement>('.updz')!;
  const input = container.querySelector<HTMLInputElement>('.updz-input')!;

  async function ingestFiles(files: File[]): Promise<void> {
    if (!files.length || ingesting) return;
    ingesting = true;
    const textEl = zone.querySelector<HTMLElement>('.updz-text');
    const idleText = textEl?.innerHTML ?? '';
    zone.classList.add('is-busy');
    if (textEl) textEl.textContent = files.length === 1 ? 'Adding…' : `Adding ${files.length} files…`;
    let stored = 0;
    for (const file of files) {
      try {
        // A PDF/.ai converts page(s) to SVG assets — multi-page docs ask which pages
        // (or all) via the shared picker dialog. Lazy chunk: pdf-lib loads only when
        // a PDF actually arrives. Cancelling the dialog stores nothing for that file.
        if (isPdfUpload(file)) {
          const { ingestPdfAsSvgAssets } = await import('../views/pdf-import.ts');
          const refs = await ingestPdfAsSvgAssets(host, file, {
            mode: 'multi',
            warn: (m) => announce(m, { assertive: true }),
          });
          stored += refs.length;
          continue;
        }
        await storeUserUpload(host, file);
        stored++;
      } catch (err) {
        host.log('error', 'Upload failed', { file: file.name, error: String(err) });
        // Cap/quota errors carry a user-ready message; prefix only the rest.
        announce((err as { code?: unknown }).code ? (err as Error).message : `Upload failed: ${(err as Error).message}`, { assertive: true });
      }
    }
    ingesting = false;
    if (!stored) {
      // Nothing landed — restore the idle drop area (no refresh is coming).
      zone.classList.remove('is-busy');
      if (textEl) textEl.innerHTML = idleText;
      return;
    }
    playSfx('drop');
    announce(`Added ${stored} file${stored === 1 ? '' : 's'} to your uploads.`);
    try {
      await opts.onAdded?.(stored);
    } finally {
      // Surfaces that rebuild after onAdded (the catalogue) orphan this node — the
      // restore is harmless; ones that don't get the zone back ready for the next drop.
      zone.classList.remove('is-busy');
      if (textEl) textEl.innerHTML = idleText;
    }
  }

  const ac = new AbortController();
  const { signal } = ac;
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = ''; // allow re-selecting the same file after an error
    void ingestFiles(files);
  }, { signal });
  // Drag-and-drop onto the zone. dragover MUST preventDefault or the drop never fires;
  // only file drags count (dragging some page image around shouldn't light it up).
  zone.addEventListener('dragover', (e) => {
    if (ingesting || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    zone.classList.add('is-dragover');
  }, { signal });
  zone.addEventListener('dragleave', (e) => {
    // relatedTarget still inside the zone = moving between its children, not a leave.
    if (!(e.relatedTarget instanceof Node && zone.contains(e.relatedTarget))) zone.classList.remove('is-dragover');
  }, { signal });
  zone.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    zone.classList.remove('is-dragover');
    void ingestFiles([...e.dataTransfer.files]);
  }, { signal });

  return () => { ac.abort(); };
}
