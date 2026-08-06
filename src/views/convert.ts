// SPDX-License-Identifier: MPL-2.0
/**
 * #/convert — a verify-like on-device file converter. Drop a supported file, pick a
 * target format, convert in the browser (no upload), download. The engine codecs do
 * the work directly (a view CAN import the engine, unlike a tool hook): fonts via
 * sfntToWoff/woffToSfnt, SVG⇄SVGZ via gzip/gunzip, and any image → the whole raster
 * matrix by rasterising to a canvas and encoding it (png/jpeg/webp/avif via the
 * browser; bmp/tiff via the engine writers; pdf via jsPDF; ico wraps a PNG).
 *
 * Deliberately NOT via host.export.render: that path DOM-serialises an on-screen tool
 * canvas and stalls on a detached node — and we already hold the pixels, so encoding
 * them is both faster and reliable. Still a follow-on (plans/84): vector→vector
 * transcoding (svg→eps/dxf), archives, catalog "Download as", provenance on the output.
 */
import type { HostV1 } from '@lolly-tools/core/host-v1';
import { sfntKind, sfntToWoff, woffToSfnt, gzip, gunzip, sniffContainer, encodeBmp, packTiff, readXlsx, writeXlsx, rowsToCsv, parseTableText } from '@lolly/engine';
import { t } from '../i18n.ts';
import { escape } from '../utils.ts';   // the single shared HTML escaper (R11) — never re-fork it
import '../styles/parts/platform.css';   // .platform-layout / .plat-header / .plat-title / .plat-sub
import '../styles/parts/convert.css';    // async CSS chunk (lazy view — not on the landing)

interface Target { id: string; label: string; ext: string; mime: string; render?: boolean; }

// The raster matrix the shell export bridge (host.export.render) produces from a
// rasterised source — the "amazing rendering engine" reused here so a converted file
// reaches the whole matrix, not just its sibling container. Both an SVG and a raster
// source rasterise to a <canvas> first (sourceToCanvas), then ride this path; the
// engine owns the per-format encoders (png/jpg/webp/avif/tiff/bmp) plus the pdf/ico
// wrappers. `render:true` routes the target through renderThroughEngine.
const R = (id: string, label: string, ext: string, mime: string): Target => ({ id, label, ext, mime, render: true });
const RASTER_OUT: Target[] = [
  R('png', 'PNG (.png)', 'png', 'image/png'),
  R('jpeg', 'JPEG (.jpg)', 'jpg', 'image/jpeg'),
  R('webp', 'WebP (.webp)', 'webp', 'image/webp'),
  R('avif', 'AVIF (.avif)', 'avif', 'image/avif'),
  R('tiff', 'TIFF (.tiff)', 'tiff', 'image/tiff'),
  R('bmp', 'BMP (.bmp)', 'bmp', 'image/bmp'),
  R('pdf', 'PDF (.pdf)', 'pdf', 'application/pdf'),
  R('ico', 'Icon (.ico)', 'ico', 'image/x-icon'),
];

/** The on-device targets each source kind can produce (the source format is filtered out by the caller). */
function targetsFor(kind: string): Target[] {
  switch (kind) {
    case 'ttf': case 'otf': case 'woff':
      return [
        { id: 'ttf', label: 'TrueType (.ttf)', ext: 'ttf', mime: 'font/ttf' },
        { id: 'otf', label: 'OpenType (.otf)', ext: 'otf', mime: 'font/otf' },
        { id: 'woff', label: 'Web font (.woff)', ext: 'woff', mime: 'font/woff' },
      ];
    // An SVG reaches its compressed sibling AND the whole raster matrix (the engine
    // rasterises it at its intrinsic size). We do NOT offer vector→vector transcoding
    // (svg→eps/dxf/emf/wmf): the engine's vector writers walk a rendered tool canvas,
    // not arbitrary source SVG, so those would misconvert — a follow-on (plans/84).
    case 'svg': case 'svgz':
      return [
        kind === 'svg'
          ? { id: 'svgz', label: 'Compressed SVG (.svgz)', ext: 'svgz', mime: 'image/svg+xml' }
          : { id: 'svg', label: 'SVG (.svg)', ext: 'svg', mime: 'image/svg+xml' },
        ...RASTER_OUT,
      ];
    // A raster can re-encode to any raster + wrap into PDF/ICO, but cannot become true vector.
    case 'raster': return RASTER_OUT;
    // Tabular data — every data format converts to every other (grid round-trip). The
    // caller drops the source format. An .xlsx converts from its FIRST sheet.
    case 'xlsx': case 'csv': case 'tsv': case 'json':
      return DATA_OUT;
    default: return [];
  }
}

/** The data-conversion targets (grid round-trip). */
const DATA_OUT: Target[] = [
  { id: 'csv', label: 'CSV (.csv)', ext: 'csv', mime: 'text/csv' },
  { id: 'xlsx', label: 'Excel (.xlsx)', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { id: 'json', label: 'JSON (.json)', ext: 'json', mime: 'application/json' },
  { id: 'tsv', label: 'TSV (.tsv)', ext: 'tsv', mime: 'text/tab-separated-values' },
];

function detectKind(bytes: Uint8Array, file: File): string {
  const k = sfntKind(bytes);
  if (k) return k;                                          // ttf/otf/woff/woff2
  // Tabular data — an .xlsx is a zip (workbook inside), csv/tsv/json are text. Checked
  // before svgz/raster: an .xlsx's PK-zip and a .json's braces must not fall through.
  if (/\.xlsx$/i.test(file.name)
    || (sniffContainer(bytes) === 'zip' && /application\/vnd\.openxmlformats-officedocument\.spreadsheetml/.test(file.type))) return 'xlsx';
  if (/\.tsv$/i.test(file.name)) return 'tsv';
  if (sniffContainer(bytes) === 'gzip' || /\.svgz$/i.test(file.name)) return 'svgz';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256));
  if (/<svg[\s>]/i.test(head) || /^\s*<\?xml/.test(head) || /\.svg$/i.test(file.name)) return 'svg';
  if (/\.csv$/i.test(file.name) || /^text\/csv/.test(file.type)) return 'csv';
  if (/\.json$/i.test(file.name) || (/^application\/json/.test(file.type) && /^\s*[[{]/.test(head))) return 'json';
  if (/^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name)) return 'raster';
  return 'unknown';
}

async function convert(bytes: Uint8Array, kind: string, target: Target, file: File): Promise<Blob> {
  // Fonts — a pure container swap (engine codecs), never a render.
  if (kind === 'ttf' || kind === 'otf' || kind === 'woff') {
    if (target.id === 'woff' && kind !== 'woff') return new Blob([sfntToWoff(bytes) as BlobPart], { type: target.mime });
    if ((target.id === 'ttf' || target.id === 'otf') && kind === 'woff') return new Blob([woffToSfnt(bytes) as BlobPart], { type: target.mime });
    return new Blob([bytes as BlobPart], { type: target.mime });   // sfnt passthrough (ttf⇄otf) / same container
  }
  // SVG⇄SVGZ — exact-byte gzip, no render (keeps the credential + outlined text intact).
  if (kind === 'svg' && target.id === 'svgz') return new Blob([gzip(bytes) as BlobPart], { type: target.mime });
  if (kind === 'svgz' && target.id === 'svg') return new Blob([gunzip(bytes) as BlobPart], { type: target.mime });
  // Tabular data — decode the source to a ragged grid (row 0 = header), re-encode to
  // the target. Pure byte/text work, no canvas. An .xlsx reads its first sheet.
  if (kind === 'xlsx' || kind === 'csv' || kind === 'tsv' || kind === 'json') {
    const grid = sourceToGrid(kind, bytes);
    return new Blob([gridToTarget(grid, target.id) as BlobPart], { type: target.mime });
  }
  // Everything else: rasterise the source to a canvas, then encode that canvas straight
  // to the target with the engine's own codecs. We hold the pixels already, so there is
  // no reason to DOM-serialise them back through the tool-export path (dom-to-image
  // stalls on a detached node anyway) — this is faster and never hangs.
  if (target.render) return encodeFromCanvas(await sourceToCanvas(kind, bytes, file), target);
  throw new Error('That conversion is not supported.');
}

// ── tabular data conversion (grid round-trip) ────────────────────────────────

/** Decode a data source to a ragged grid (row 0 = header). xlsx→first sheet;
 *  csv/tsv→parseTableText; json→array-of-objects (keys become the header) or
 *  array-of-arrays. Throws a user-ready message on an unreadable source. Exported
 *  for the co-located round-trip test. */
export function sourceToGrid(kind: string, bytes: Uint8Array): string[][] {
  if (kind === 'xlsx') return readXlsx(bytes).rows;
  if (kind === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error('That JSON could not be parsed.'); }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Expected a non-empty JSON array of rows.');
    if (Array.isArray(parsed[0])) return (parsed as unknown[][]).map((r) => r.map((c) => String(c ?? '')));
    // Array of objects → header = the union of keys in first-seen order.
    const keys: string[] = [];
    for (const row of parsed as Record<string, unknown>[]) for (const k of Object.keys(row ?? {})) if (!keys.includes(k)) keys.push(k);
    return [keys, ...(parsed as Record<string, unknown>[]).map((row) => keys.map((k) => String(row?.[k] ?? '')))];
  }
  // csv / tsv (parseTableText auto-detects the delimiter + Markdown tables).
  const table = parseTableText(new TextDecoder().decode(bytes));
  if (!table) throw new Error('That file does not parse as CSV/TSV.');
  return [table.columns, ...table.rows];
}

/** Re-encode a grid to the target data format. Returns bytes for xlsx, a string for
 *  the text formats (the Blob wraps either). Exported for the round-trip test. */
export function gridToTarget(grid: string[][], targetId: string): Uint8Array | string {
  switch (targetId) {
    case 'csv':  return rowsToCsv(grid);
    case 'tsv':  return grid.map((r) => r.map((c) => c.replace(/[\t\r\n]/g, ' ')).join('\t')).join('\n');
    case 'xlsx': return writeXlsx({ rows: grid });
    case 'json': {
      const [header = [], ...body] = grid;
      const objs = body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
      return JSON.stringify(objs, null, 2);
    }
    default: throw new Error('That conversion is not supported.');
  }
}

/** Decode the source (SVG markup or a raster file) into a <canvas> at its intrinsic
 *  size. A canvas is a node the export bridge rasterises reliably — passing a bare
 *  <svg>/<img> root to dom-to-image can hang on its foreignObject image load. */
async function sourceToCanvas(kind: string, bytes: Uint8Array, file: File): Promise<HTMLCanvasElement> {
  const isSvg = kind === 'svg' || kind === 'svgz';
  const raw = kind === 'svgz' ? gunzip(bytes) : bytes;
  const mime = isSvg ? 'image/svg+xml' : (file.type || 'image/png');
  // Intrinsic size — an SVG may lack width/height, so fall back to its viewBox, then a
  // square default. A raster's natural size is authoritative.
  let width = 512, height = 512;
  if (isSvg) {
    const svg = new DOMParser().parseFromString(new TextDecoder().decode(raw), 'image/svg+xml').documentElement;
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
    width  = parseFloat(svg.getAttribute('width')  || '') || (vb.length === 4 ? vb[2]! : 0) || 512;
    height = parseFloat(svg.getAttribute('height') || '') || (vb.length === 4 ? vb[3]! : 0) || 512;
  }
  const objUrl = URL.createObjectURL(new Blob([raw as BlobPart], { type: mime }));
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('Could not decode that file.'));
      im.src = objUrl;
    });
    if (!isSvg) { width = img.naturalWidth || width; height = img.naturalHeight || height; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get a canvas to render onto.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

/** Encode a rasterised canvas straight to the target format. png/jpeg/webp/avif ride
 *  the browser's own `canvas.toBlob`; bmp/tiff use the engine writers on the raw RGBA;
 *  pdf wraps the image (jsPDF); ico wraps a ≤256px PNG. */
async function encodeFromCanvas(canvas: HTMLCanvasElement, target: Target): Promise<Blob> {
  switch (target.id) {
    case 'png':  return canvasBlob(canvas, 'image/png');
    case 'jpeg': return canvasBlob(canvas, 'image/jpeg', 0.92);
    case 'webp': return canvasBlob(canvas, 'image/webp', 0.92);
    case 'avif': return canvasBlob(canvas, 'image/avif', 0.6);
    case 'bmp':  return new Blob([encodeBmp(rgbaOf(canvas), canvas.width, canvas.height) as BlobPart], { type: 'image/bmp' });
    case 'tiff': return new Blob([packTiff(rgbaOf(canvas), { width: canvas.width, height: canvas.height, samplesPerPixel: 4, dpi: 96 }) as BlobPart], { type: 'image/tiff' });
    case 'pdf':  return imageToPdf(canvas);
    case 'ico':  return canvasToIco(canvas);
    default:     throw new Error('That conversion is not supported.');
  }
}

/** The canvas's interleaved top-down RGBA, as a plain Uint8Array the engine writers take. */
function rgbaOf(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read the rendered pixels.');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}

/** Promise wrapper over canvas.toBlob. When the browser can't encode the requested
 *  type it doesn't return null — the HTML spec makes it silently fall back to PNG — so
 *  we compare the RESULTING type and reject a mismatch rather than hand back a PNG
 *  wearing an .avif name (e.g. AVIF encode on an engine that lacks it). */
function canvasBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b && b.size > 0 && b.type === mime)
        ? resolve(b)
        : reject(new Error(`This browser can’t encode ${mime.replace('image/', '').toUpperCase()}.`)),
      mime, quality,
    );
  });
}

/** One image, one page, sized to the pixels (points). PNG so transparency survives. */
async function imageToPdf(canvas: HTMLCanvasElement): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: [canvas.width, canvas.height], orientation: canvas.width >= canvas.height ? 'landscape' : 'portrait' });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pw, ph);
  return doc.output('blob');
}

/** ICO wrapping a PNG payload (modern icons allow PNG), downscaled to ≤256px. */
async function canvasToIco(canvas: HTMLCanvasElement): Promise<Blob> {
  const long = Math.max(canvas.width, canvas.height);
  const scale = Math.min(1, 256 / long);
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d')?.drawImage(canvas, 0, 0, w, h);
  const png = new Uint8Array(await (await canvasBlob(c, 'image/png')).arrayBuffer());
  const out = new Uint8Array(22 + png.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(2, 1, true);              // type: icon
  dv.setUint16(4, 1, true);              // one image
  out[6] = w >= 256 ? 0 : w;             // width  (0 encodes 256)
  out[7] = h >= 256 ? 0 : h;             // height
  dv.setUint16(10, 1, true);             // colour planes
  dv.setUint16(12, 32, true);            // bits per pixel
  dv.setUint32(14, png.length, true);    // payload size
  dv.setUint32(18, 22, true);            // payload offset
  out.set(png, 22);
  return new Blob([out as BlobPart], { type: 'image/x-icon' });
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
