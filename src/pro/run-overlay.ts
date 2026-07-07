// SPDX-License-Identifier: MPL-2.0
/**
 * Pro / Batch mode — the batch-run progress shell, made mount-agnostic.
 *
 * This is the rotating-quip + progress-head + Cancel + live-log UI plus the
 * runBatch call and the zip/sequential delivery, extracted from runBatchFlow so
 * it can render into either:
 *   - the docked `#pro-progress` panel (the in-grid batch run), or
 *   - a floating toast appended to <body> (a folder/group export launched from
 *     the shared overlay, with no /pro grid mounted).
 *
 * It owns its own cancel flag and quip rotator. It deliberately does NOT touch
 * any /pro grid state (state.running / renderGrid) — the docked caller passes an
 * `onRendered` hook to flip those once the renders finish, before delivery.
 */
import './run-overlay.css';
import { runBatch } from './batch.ts';
import { playSfx } from '../lib/sfx.ts';
import { buildZip, saveBlob, saveSequential } from './zip.ts';
import { QUIPS, quipLines } from './quips.ts';
import type { BatchRow, BatchFile, BatchResult } from './batch.ts';
import type { ZipTier } from '@lolly/engine';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';

/** Profile fields the zip credit block uses. */
interface BatchAuthor {
  firstname?: string;
  lastname?: string;
  email?: string;
  phone?: string;
}

/** Options for a batch run + delivery (see the JSDoc on runBatchWithProgress). */
interface RunBatchProgressOpts {
  mount: HTMLElement;
  format?: string;
  unit?: string;
  dpi?: number;
  pathAware?: boolean;
  zipBaseName: string;
  author?: BatchAuthor | null;
  csv?: string;
  skipped?: Array<{ reason: string }>;
  onRendered?: () => void;
  onBatchRendered?: (files: BatchFile[]) => void;
  announce?: (msg: string) => void;
  /** AES-256 lock applied to any pdf/pdf-cmyk outputs in the batch. */
  strongPassword?: string;
  /** Whole-zip encryption tier (uses `strongPassword` as the zip password too). */
  zipLock?: ZipTier;
}

/** Outcome of a run: produced files, per-row results, and whether it was cancelled. */
interface RunBatchProgressResult {
  files: BatchFile[];
  results: BatchResult[];
  cancelled: boolean;
}

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => (
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!
));

// Per-format glyphs for the preview cards — Lucide line icons (matching the app's iconography),
// grouped by kind: a vector PEN for svg/eps/…, a document for pdf, film for video, and the
// IMAGE frame for every raster (png/jpg/webp/gif/…). `fmtIcon()` picks one from the render format.
const ICON_ATTRS = 'viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_PEN = `<svg ${ICON_ATTRS}><path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/><path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.643a1 1 0 0 0 .776.746L13 18"/><path d="m2.3 2.3 7.286 7.286"/><circle cx="11" cy="11" r="2"/></svg>`;
const ICON_IMAGE = `<svg ${ICON_ATTRS}><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;
const ICON_DOC = `<svg ${ICON_ATTRS}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;
const ICON_FILM = `<svg ${ICON_ATTRS}><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/></svg>`;
const fmtIcon = (fmt: string): string => {
  const f = (fmt || '').toLowerCase();
  if (/^(svg|eps|emf|ai|pdf-vector)/.test(f)) return ICON_PEN;   // vector art
  if (f.startsWith('pdf')) return ICON_DOC;                       // pdf / pdf-cmyk
  if (/^(mp4|webm|mov|m4v)/.test(f)) return ICON_FILM;            // video container
  return ICON_IMAGE;                                              // png/jpg/jpeg/webp/gif/avif/ico/bmp/…
};

/**
 * Render a batch with the full progress UI and deliver the result as one zip
 * (falling back to spaced sequential downloads if zipping fails).
 *
 * @param {HostV1} host
 * @param {Array} rows                         renderable rows (already planned)
 * @param {object} opts
 * @param {HTMLElement} opts.mount             where to render the progress shell
 * @param {string} [opts.format]
 * @param {string} [opts.unit]
 * @param {number} [opts.dpi]
 * @param {boolean} [opts.pathAware]           keep `/` in names → nested zip dirs
 * @param {string}  opts.zipBaseName           zip filename stem (no extension)
 * @param {object|null} [opts.author]          profile for the zip credit block
 * @param {string} [opts.csv]                  re-importable batch CSV manifest
 * @param {Array<{reason:string}>} [opts.skipped]  rows dropped before the run
 * @param {() => void} [opts.onRendered]       fired after renders, before delivery
 * @param {(files:Array)=>void} [opts.onBatchRendered]  usage-metric hook
 * @param {(msg:string)=>void} [opts.announce] screen-reader announcer
 * @returns {Promise<{files:Array, results:Array, cancelled:boolean}>}
 */
export async function runBatchWithProgress(host: HostV1, rows: BatchRow[], {
  mount, format, unit, dpi, pathAware = false,
  zipBaseName, author = null, csv, skipped = [],
  onRendered, onBatchRendered, announce, strongPassword, zipLock,
}: RunBatchProgressOpts = {} as RunBatchProgressOpts): Promise<RunBatchProgressResult> {
  const total = rows.length;
  let cancelRequested = false;

  const skipNote = skipped.length
    ? `<li class="pro-log-skip">${skipped.length} row${skipped.length === 1 ? '' : 's'} skipped (${esc(skipped[0]!.reason)}${skipped.length > 1 ? ', …' : ''})</li>`
    : '';

  // Persistent progress shell: a rotating quip on top, then a head line + a
  // single Cancel button, then the live log. Built ONCE; draw() rewrites only the
  // head text and each finished row appends one <li>.
  mount.hidden = false;
  mount.innerHTML = `
    <div class="pro-quip" aria-hidden="true"></div>
    <div class="pro-progress-body">
      <div class="pro-progress-head">
        <span class="pro-progress-headtext"></span>
        <button type="button" class="pro-btn" id="pro-cancel">Cancel</button>
      </div>
      <div class="pro-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="0"><span class="pro-progress-fill"></span></div>
      <div class="pro-cardwall" aria-hidden="true"></div>
      <div class="pro-timechart-mount"></div>
      <ol class="pro-log"></ol>
    </div>`;
  const quipEl = mount.querySelector<HTMLElement>('.pro-quip')!;
  const headEl = mount.querySelector<HTMLElement>('.pro-progress-headtext')!;
  const barTrack = mount.querySelector<HTMLElement>('.pro-progress-track')!;
  const barFill = mount.querySelector<HTMLElement>('.pro-progress-fill')!;
  const wallEl = mount.querySelector<HTMLElement>('.pro-cardwall')!;
  const chartMount = mount.querySelector<HTMLElement>('.pro-timechart-mount')!;
  const logEl = mount.querySelector<HTMLElement>('.pro-log')!;
  const cancelBtn = mount.querySelector<HTMLButtonElement>('#pro-cancel')!;
  if (skipNote) logEl.insertAdjacentHTML('beforeend', skipNote);
  const draw = (head: string) => { headEl.innerHTML = head; };
  const appendLog = (li: string) => logEl.insertAdjacentHTML('beforeend', li);

  // A live wall of preview cards — each finished export pops in as a thumbnail so the
  // job reads as a visual build-up, not a wall of text. Newest first; capped so the DOM
  // (and the live object URLs) stay bounded on a big batch (the evicted card's URL is
  // revoked). Image-like formats show the render; pdf/video show a format badge.
  const CARD_CAP = 60;
  const RASTERIZABLE = /^(svg|png|jpe?g|webp|gif|avif|ico|bmp)$/i;
  // A render time worth bragging about: sub-second in ms, otherwise seconds (one decimal
  // until it's long enough not to need it).
  const fmtDuration = (ms: number): string =>
    ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  const addCard = (name: string, blob: Blob, fmt: string, ms: number): void => {
    const card = document.createElement('figure');
    card.className = 'pro-card';
    // A per-format glyph in the corner — a vector pen for svg, the image frame for png, etc.
    const fi = document.createElement('span');
    fi.className = 'pro-card-fmticon';
    fi.title = (fmt || 'file').toUpperCase();
    fi.innerHTML = fmtIcon(fmt);
    card.appendChild(fi);
    if (RASTERIZABLE.test(fmt) || blob.type.startsWith('image/')) {
      const url = URL.createObjectURL(blob);
      card.dataset.url = url;   // revoked when the card is evicted
      const img = document.createElement('img');
      img.className = 'pro-card-img'; img.loading = 'lazy'; img.alt = ''; img.src = url;
      card.appendChild(img);
    } else {
      card.classList.add('pro-card--badge');
      const badge = document.createElement('span');
      badge.className = 'pro-card-fmt'; badge.textContent = (fmt || 'file').toUpperCase();
      card.appendChild(badge);
    }
    // Render-time brag — a small ⚡ pill under the preview showing how fast it rendered.
    const time = document.createElement('span');
    time.className = 'pro-card-time';
    time.textContent = `⚡ ${fmtDuration(ms)}`;
    card.appendChild(time);
    const cap = document.createElement('figcaption');
    cap.className = 'pro-card-name'; cap.textContent = name.split('/').pop() || name;
    card.appendChild(cap);
    wallEl.insertAdjacentElement('afterbegin', card);
    while (wallEl.children.length > CARD_CAP) {
      const old = wallEl.lastElementChild as HTMLElement | null;
      if (!old) break;
      if (old.dataset.url) URL.revokeObjectURL(old.dataset.url);
      old.remove();
    }
  };

  // Per-asset render timings — kept for EVERY item (not capped like the card wall), so the
  // completion chart can plot the whole batch. Rendered when the queue finishes.
  const timings: Array<{ name: string; ms: number }> = [];
  // A horizontal bar chart of render time per asset, shortest → longest, so the slow ones
  // stand out at a glance. Bars scale to the slowest; the list scrolls if the batch is huge.
  const renderTimeChart = (items: Array<{ name: string; ms: number }>): string => {
    if (!items.length) return '';
    const sorted = [...items].sort((a, b) => a.ms - b.ms); // shortest first
    const max = Math.max(...sorted.map((t) => t.ms), 1);
    const totalMs = sorted.reduce((s, t) => s + t.ms, 0);
    const rows = sorted.map((t) => {
      const pct = Math.max(3, (t.ms / max) * 100); // a visible minimum so sub-ms items still show
      const name = t.name.split('/').pop() || t.name;
      return `<li class="pro-tc-row">
        <span class="pro-tc-name" title="${esc(t.name)}">${esc(name)}</span>
        <span class="pro-tc-bar"><span class="pro-tc-fill" style="width:${pct.toFixed(1)}%"></span></span>
        <span class="pro-tc-val">${esc(fmtDuration(t.ms))}</span>
      </li>`;
    }).join('');
    return `<div class="pro-timechart">
      <div class="pro-tc-head">Render times<span class="pro-tc-sub">${sorted.length} asset${sorted.length === 1 ? '' : 's'} · ${esc(fmtDuration(totalMs))} total</span></div>
      <ol class="pro-tc-list">${rows}</ol>
    </div>`;
  };
  // One Cancel listener, bound once to the stable button, so even a long batch
  // stays cancellable.
  cancelBtn.addEventListener('click', () => { cancelRequested = true; cancelBtn.disabled = true; });

  // Shuffle the quips and rotate one every few seconds (re-triggering the CSS
  // fade on each swap). Just for fun while a big batch grinds away.
  const order = QUIPS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  let qi = 0;
  // `done` counts completed renders — hoisted so the quip painter can show how many are
  // still to go ([Remaining]) alongside the total ([Count]).
  let done = 0;
  const paintQuip = () => {
    quipEl.innerHTML = quipLines(QUIPS[order[qi]!]!, total, Math.max(0, total - done)).map(l => `<span>${esc(l)}</span>`).join('');
    quipEl.style.animation = 'none'; void quipEl.offsetWidth; quipEl.style.animation = '';
  };
  paintQuip();
  const quipTimer = setInterval(() => { qi = (qi + 1) % order.length; paintQuip(); }, 4200);

  try {
    draw(`<strong>Rendering 0 / ${total}…</strong>`);
    announce?.(`Rendering ${total} item${total === 1 ? '' : 's'}…`);

    const { files, results } = await runBatch(rows, host, {
      format, unit, dpi, pathAware, strongPassword,
      isCancelled: () => cancelRequested,
      onProgress: (p) => {
        if (p.status === 'rendering') { draw(`<strong>Rendering ${done + 1} / ${total}…</strong>`); return; }
        if (p.status === 'done') { addCard(p.name, p.blob, p.fmt, p.ms); timings.push({ name: p.name, ms: p.ms }); } // preview card + per-asset timing for the chart
        else if (p.status === 'error') appendLog(`<li class="pro-log-err">✕ row ${p.index + 1}: ${esc(p.error)}</li>`);
        else if (p.status === 'cancelled') appendLog(`<li class="pro-log-skip">Cancelled</li>`);
        done++;
        draw(`<strong>Rendered ${done} / ${total}</strong>`);
        // Advance the progress bar (a real fill, not just the head text count).
        const pct = total ? Math.round((done / total) * 100) : 0;
        barFill.style.width = `${pct}%`;
        barTrack.setAttribute('aria-valuenow', String(done));
      },
    });

    // Hand control back to the caller (clear running state / re-render grid)
    // before the potentially-slow zip build.
    onRendered?.();
    clearInterval(quipTimer);
    quipEl.remove();   // the job's done talking
    cancelBtn.remove(); // …and there's nothing left to cancel

    // The queue is done rendering — plot every asset's render time, shortest → longest,
    // so the whole batch's timing reads at a glance (independent of the zip step below).
    chartMount.innerHTML = renderTimeChart(timings);

    // Rows that errored mid-run still produce no file — surface the count so a
    // "Done — 480 files" can't quietly hide 20 failures.
    const failed = results.filter(r => !r.ok).length;
    const failNote = failed ? `, ${failed} failed` : '';

    if (files.length === 0) {
      draw(`<strong>No files produced.</strong>`);
      announce?.('Batch finished — no files produced.');
      return { files, results, cancelled: cancelRequested };
    }

    onBatchRendered?.(files); // host-injected usage metric (see main.js)

    // Deliver: one zip when possible; spaced sequential downloads as a fallback.
    try {
      const zip = await buildZip(files, { zipName: `${zipBaseName}.zip`, author, csv, zipLock, password: strongPassword });
      saveBlob(zip, `${zipBaseName}.zip`);
      draw(`<strong>Done — ${files.length} file${files.length === 1 ? '' : 's'} in one zip${failNote}.</strong>`);
      announce?.(`Batch complete — ${files.length} file${files.length === 1 ? '' : 's'} in one zip${failNote}.`);
      // The whole queue finished — celebrate: the big trumpet for a real batch, the subtle
      // "ta-da" for a lone render (matching the single-session download path).
      if (!cancelRequested) playSfx(total > 1 ? 'fanfare' : 'victory');
    } catch (zipErr) {
      const msg = esc(String((zipErr as { message?: unknown }).message ?? zipErr));
      if (zipLock && strongPassword) {
        // A lock was requested — NEVER fall back to unencrypted sequential downloads,
        // which would silently ship the non-PDF members (and the lolly.txt manifest
        // with author details) in cleartext. Fail loudly and save nothing.
        appendLog(`<li class="pro-log-err">Couldn't build the password-protected zip (${msg}) — nothing was downloaded. Try again, or export fewer files at once.</li>`);
        draw(`<strong>Couldn't build the password-protected zip — nothing was saved.</strong>`);
        announce?.('Encrypted download failed; nothing was saved.');
      } else {
        appendLog(`<li class="pro-log-skip">Zip failed (${msg}); downloading files individually…</li>`);
        draw(`<strong>Downloading ${files.length} files individually…</strong>`);
        await saveSequential(files, {
          delayMs: 600,
          onSaved: (n, tot) => draw(`<strong>Saving ${n} / ${tot}…</strong>`),
        });
        draw(`<strong>Done — ${files.length} files downloaded${failNote}.</strong>`);
        announce?.(`Batch complete — ${files.length} file${files.length === 1 ? '' : 's'} downloaded${failNote}.`);
        if (!cancelRequested) playSfx(total > 1 ? 'fanfare' : 'victory'); // finished (fallback path) — big trumpet for a batch, subtle "ta-da" for one
      }
    }
    return { files, results, cancelled: cancelRequested };
  } finally {
    clearInterval(quipTimer); // never leave the rotator running
  }
}
