// SPDX-License-Identifier: MPL-2.0
/**
 * #/convert — a verify-like on-device file converter. Drop a supported file, pick a
 * target format, convert in the browser (no upload), download. The engine codecs do
 * the work directly (a view CAN import the engine, unlike a tool hook): fonts via
 * sfntToWoff/woffToSfnt, SVG⇄SVGZ via gzip/gunzip, and raster⇄raster through a canvas.
 *
 * MVP scope: fonts (ttf/otf/woff), SVG⇄SVGZ, and raster (png/jpg/webp). The wider
 * matrix from plans/84 (bmp/ico/pdf/archives, catalog "Download as", provenance on the
 * output) is a follow-on — this is the surface + the two simplest engine-direct paths.
 */
import type { HostV1 } from '@lolly-tools/core/host-v1';
import { sfntKind, sfntToWoff, woffToSfnt, gzip, gunzip, sniffContainer } from '@lolly/engine';
import { t } from '../i18n.ts';
import { escape } from '../utils.ts';   // the single shared HTML escaper (R11) — never re-fork it
import '../styles/parts/platform.css';   // .platform-layout / .plat-header / .plat-title / .plat-sub
import '../styles/parts/convert.css';    // async CSS chunk (lazy view — not on the landing)

interface Target { id: string; label: string; ext: string; mime: string; }

/** The on-device targets each source kind can produce (the source format is filtered out by the caller). */
function targetsFor(kind: string): Target[] {
  switch (kind) {
    case 'ttf': case 'otf': case 'woff':
      return [
        { id: 'ttf', label: 'TrueType (.ttf)', ext: 'ttf', mime: 'font/ttf' },
        { id: 'otf', label: 'OpenType (.otf)', ext: 'otf', mime: 'font/otf' },
        { id: 'woff', label: 'Web font (.woff)', ext: 'woff', mime: 'font/woff' },
      ];
    case 'svg': return [{ id: 'svgz', label: 'Compressed SVG (.svgz)', ext: 'svgz', mime: 'image/svg+xml' }];
    case 'svgz': return [{ id: 'svg', label: 'SVG (.svg)', ext: 'svg', mime: 'image/svg+xml' }];
    case 'raster':
      return [
        { id: 'png', label: 'PNG (.png)', ext: 'png', mime: 'image/png' },
        { id: 'jpg', label: 'JPEG (.jpg)', ext: 'jpg', mime: 'image/jpeg' },
        { id: 'webp', label: 'WebP (.webp)', ext: 'webp', mime: 'image/webp' },
      ];
    default: return [];
  }
}

function detectKind(bytes: Uint8Array, file: File): string {
  const k = sfntKind(bytes);
  if (k) return k;                                          // ttf/otf/woff/woff2
  if (sniffContainer(bytes) === 'gzip' || /\.svgz$/i.test(file.name)) return 'svgz';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256));
  if (/<svg[\s>]/i.test(head) || /^\s*<\?xml/.test(head) || /\.svg$/i.test(file.name)) return 'svg';
  if (/^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name)) return 'raster';
  return 'unknown';
}

async function convert(bytes: Uint8Array, kind: string, target: Target, file: File): Promise<Blob> {
  if (kind === 'ttf' || kind === 'otf' || kind === 'woff') {
    if (target.id === 'woff' && kind !== 'woff') return new Blob([sfntToWoff(bytes) as BlobPart], { type: target.mime });
    if ((target.id === 'ttf' || target.id === 'otf') && kind === 'woff') return new Blob([woffToSfnt(bytes) as BlobPart], { type: target.mime });
    return new Blob([bytes as BlobPart], { type: target.mime });   // sfnt passthrough (ttf⇄otf) / same container
  }
  if (kind === 'svg' && target.id === 'svgz') return new Blob([gzip(bytes) as BlobPart], { type: target.mime });
  if (kind === 'svgz' && target.id === 'svg') return new Blob([gunzip(bytes) as BlobPart], { type: target.mime });
  if (kind === 'raster') {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.type || 'image/png' }));
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Could not decode that image.')); im.src = url;
      });
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth || 1; cv.height = img.naturalHeight || 1;
      const ctx = cv.getContext('2d');
      if (!ctx) throw new Error('Canvas is unavailable.');
      if (target.id === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }  // JPEG has no alpha
      ctx.drawImage(img, 0, 0);
      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, target.mime, 0.95));
      if (!blob) throw new Error('Encoding failed.');
      return blob;
    } finally { URL.revokeObjectURL(url); }
  }
  throw new Error('That conversion is not supported.');
}

export async function mountConvert(viewEl: HTMLElement, host: HostV1, _params = ''): Promise<void> {
  document.title = 'Convert — Lolly';
  viewEl.innerHTML = `
    <div class="platform-layout convert-view">
      <header class="plat-header">
        <h1 class="plat-title">${t('Convert')}</h1>
        <p class="plat-sub">${t('Change a file from one format to another, on your device. Nothing is uploaded.')}</p>
      </header>
      <div class="convert-drop" data-drop tabindex="0" role="button" aria-label="${t('Drop a file to convert')}">
        <p>${t('Drop a font, image, SVG or SVGZ here, or choose one.')}</p>
        <button type="button" class="btn" data-pick>${t('Choose a file…')}</button>
        <input type="file" hidden data-file accept=".ttf,.otf,.woff,.svg,.svgz,image/*">
      </div>
      <div class="convert-result" data-result hidden></div>
    </div>`;
  const drop = viewEl.querySelector<HTMLElement>('[data-drop]')!;
  const fileInput = viewEl.querySelector<HTMLInputElement>('[data-file]')!;
  const result = viewEl.querySelector<HTMLElement>('[data-result]')!;

  viewEl.querySelector('[data-pick]')?.addEventListener('click', () => fileInput.click());
  drop.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) return; fileInput.click(); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0]; if (f) void onFile(f);
  });
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) void onFile(f); });

  async function onFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectKind(bytes, file);
    const targets = targetsFor(kind).filter((tt) => tt.id !== kind);   // never offer the source format
    result.hidden = false;
    if (!targets.length) {
      result.innerHTML = `<p class="convert-none">${t('No on-device conversion is available for')} <b>${escape(file.name)}</b> ${t('yet')}.</p>`;
      return;
    }
    const base = file.name.replace(/\.[^.]+$/, '') || 'converted';
    result.innerHTML = `<p class="convert-file"><b>${escape(file.name)}</b> — ${t('convert to')}:</p>
      <div class="convert-targets">${targets.map((tt) => `<button type="button" class="btn convert-target" data-t="${tt.id}">${tt.label}</button>`).join('')}</div>
      <p class="convert-status" data-status></p>`;
    const status = result.querySelector<HTMLElement>('[data-status]')!;
    result.querySelectorAll<HTMLButtonElement>('[data-t]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const target = targets.find((tt) => tt.id === btn.dataset.t)!;
        btn.disabled = true; status.textContent = t('Converting…');
        try {
          const out = await convert(bytes, kind, target, file);
          await host.export.download(out, `${base}.${target.ext}`);
          status.textContent = `${t('Downloaded')} ${base}.${target.ext} (${fmtBytes(out.size)}).`;
        } catch (e) {
          status.textContent = (e as Error).message || t('Conversion failed.');
        } finally { btn.disabled = false; }
      });
    });
  }
}

function fmtBytes(n: number): string {
  if (!(n > 0)) return '0 B';
  const u = ['B', 'KB', 'MB']; const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i); return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}
