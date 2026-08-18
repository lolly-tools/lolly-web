// SPDX-License-Identifier: MPL-2.0
/**
 * Global job progress toast (plans/124 section 9, WP-F).
 *
 * Mounts ONCE on document.body, OUTSIDE main#view, so a router view teardown
 * (viewEl._cleanup, which only replaces #view's contents) never kills it - the
 * user keeps seeing a video/retouch job's progress after they leave the catalog.
 * It is the sole subscriber the async-job foundation (lib/jobs.ts) needs to have
 * a visible UI; every consumer just calls startJob() and this renders.
 *
 * Shape: a collapsed PILL (active job title + candy-stripe bar + cancel ✕) that
 * expands to per-job rows. Hidden entirely when the registry is empty. Below
 * modals (native <dialog> top-layer always wins) and topbar dropdowns, above
 * content - the z-index is in parts/job-toast.css.
 *
 * DESKTOP NOTIFICATION (an EXTRA, never the channel - the in-toast completed
 * state always shows too):
 *   - Permission is requested ONLY on the first long (heavy) job start, and only
 *     from inside that user gesture. startJob() emits synchronously, so this
 *     module's listener runs on the same call stack as the Run-button click -
 *     still a user gesture - which is the one place a permission prompt is
 *     allowed. Never at boot.
 *   - A notification fires only when document.hidden, on a job reaching `done`.
 *     Clicking it focuses the tab.
 *   - Tauri gets a clearly-marked branch that (for now) no-ops to the web path;
 *     see notifyDone()/requestNotifyPermission().
 */
import { subscribe, jobsSnapshot, cancelJob, type Job, type JobStatus } from './jobs.ts';
import { t, tRaw } from '../i18n.ts';
import { isTauriShell } from './instance-choice.ts';
import { mountPerfHud } from './perf-hud.ts';

let root: HTMLElement | null = null;
let expanded = false;
/** Last rendered structural signature - a pure progress tick patches in place. */
let lastSig = '';
/** Requested the Notification permission this session (once, even if denied). */
let permissionRequested = false;
/** Per-job last-seen status, for detecting the transition into `done`. */
const lastStatus = new Map<string, JobStatus>();

const ESC = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => (
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!
));

/**
 * Mount the toast once. Idempotent - safe to call from main.ts boot more than
 * once (a re-entrant boot, HMR) without stacking duplicates or extra listeners.
 */
export function mountJobToast(): void {
  if (root && typeof document !== 'undefined' && document.body.contains(root)) return;
  if (typeof document === 'undefined' || !document.body) return;
  root = document.createElement('div');
  root.className = 'job-toast';
  root.hidden = true;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-label', tRaw('Background jobs'));
  root.addEventListener('click', onClick);
  document.body.appendChild(root);
  // Esc collapses the expanded panel (no browser-default hijack - only acts when
  // the panel is open and no modal is up, which owns Esc via its own <dialog>).
  document.addEventListener('keydown', onKeydown);
  subscribe(render);
  render(jobsSnapshot());
  // Same body-level floating cluster: the opt-in Performance HUD (lib/perf-hud.ts)
  // mounts here for a returning power user. It reads its own flag and no-ops when
  // off, so with the flag off this call renders nothing and starts no rAF loop.
  mountPerfHud();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !expanded) return;
  if (typeof document !== 'undefined' && document.querySelector('dialog[open]')) return; // a modal owns Esc
  expanded = false;
  render(jobsSnapshot());
}

function onClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'expand') { expanded = true; render(jobsSnapshot()); }
  else if (act === 'collapse') { expanded = false; render(jobsSnapshot()); }
  else if (act === 'cancel') { const id = el.dataset.id; if (id) cancelJob(id); }
}

// ── Render ───────────────────────────────────────────────────────────────────

const isActive = (j: Job): boolean => j.status === 'queued' || j.status === 'running';
/** Indeterminate when there is no progress yet, or no known total. */
const isIndef = (j: Job): boolean => !j.progress || j.progress.total <= 0;

/** A signature of everything that changes DOM STRUCTURE (not the progress numbers,
 *  which patch in place) - so a per-frame progress tick keeps its width transition. */
function structureSig(jobs: readonly Job[]): string {
  return `${expanded ? 'E' : 'C'}|${jobs.map(j => `${j.id}:${j.status}:${isIndef(j) ? 'i' : 'd'}:${j.cancellable ? 'x' : ''}`).join(',')}`;
}

function render(jobs: readonly Job[]): void {
  if (!root) return;
  maybeRequestPermission(jobs);
  fireCompletionNotices(jobs);

  if (jobs.length === 0) {
    root.hidden = true;
    root.innerHTML = '';
    expanded = false;
    lastSig = '';
    return;
  }
  root.hidden = false;

  const sig = structureSig(jobs);
  if (sig === lastSig && root.firstChild) { patchProgress(jobs); return; }
  lastSig = sig;

  const active = jobs.filter(isActive);
  if (expanded) root.innerHTML = renderPanel(jobs);
  else root.innerHTML = renderPill(active[0] ?? jobs[jobs.length - 1]!, jobs, active);
  patchProgress(jobs);
}

/** Update only the live numbers/widths in place - keeps the bar's width transition. */
function patchProgress(jobs: readonly Job[]): void {
  if (!root) return;
  for (const j of jobs) {
    const pct = isIndef(j) ? '100%' : `${Math.max(0, Math.min(100, ((j.progress!.done / j.progress!.total) * 100)))}%`;
    root.querySelectorAll<HTMLElement>(`[data-fill="${cssId(j.id)}"]`).forEach(el => { el.style.width = pct; });
    const count = root.querySelector<HTMLElement>(`[data-count="${cssId(j.id)}"]`);
    if (count) count.textContent = countText(j);
    const note = root.querySelector<HTMLElement>(`[data-note="${cssId(j.id)}"]`);
    if (note) note.textContent = j.progress?.note ?? '';
  }
}

/** `job-<n>` is attribute-safe already, but keep the selector escape honest. */
const cssId = (id: string): string => id.replace(/["\\]/g, '\\$&');

function countText(j: Job): string {
  if (!j.progress || j.progress.total <= 0) return '';
  return tRaw('{done} of {total}', { done: j.progress.done, total: j.progress.total });
}

/** One reusable candy-stripe bar. */
function barHtml(j: Job): string {
  return `<span class="job-bar${isIndef(j) ? ' job-bar--indef' : ''}"><span class="job-bar-fill" data-fill="${ESC(j.id)}"></span></span>`;
}

function cancelBtnHtml(j: Job): string {
  if (!isActive(j) || !j.cancellable) return '';
  return `<button type="button" class="job-x" data-act="cancel" data-id="${ESC(j.id)}" aria-label="${ESC(tRaw('Cancel job'))}" title="${ESC(tRaw('Cancel job'))}">\u2715</button>`;
}

const STATUS_WORD: Record<Exclude<JobStatus, 'running'>, string> = {
  queued: 'Queued', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};

function renderPill(head: Job, jobs: readonly Job[], active: readonly Job[]): string {
  const count = jobs.length > 1
    ? `<span class="job-pill-count" title="${ESC(tRaw('{n} jobs', { n: jobs.length }))}">${ESC(String(jobs.length))}</span>`
    : '';
  // Active head → title + bar; a lingering finished head → title + a status word.
  const body = isActive(head)
    ? `${barHtml(head)}`
    : `<span class="job-row-status job-row-status--${head.status}">${ESC(t(STATUS_WORD[head.status as Exclude<JobStatus, 'running'>] ?? 'Done'))}</span>`;
  return `<div class="job-pill">
    <button type="button" class="job-pill-main" data-act="expand" aria-label="${ESC(tRaw('Show job details'))}" aria-expanded="false">
      <span class="job-pill-title">${ESC(head.title)}</span>
      ${body}
    </button>
    ${count}
    ${active[0] ? cancelBtnHtml(active[0]) : ''}
  </div>`;
}

function rowHtml(j: Job): string {
  if (isActive(j)) {
    return `<li class="job-row">
      <span class="job-row-title">${ESC(j.title)}</span>
      ${cancelBtnHtml(j)}
      <span class="job-row-bar-wrap">${barHtml(j)}</span>
      <span class="job-row-meta"><span class="job-row-note" data-note="${ESC(j.id)}">${ESC(j.progress?.note ?? '')}</span><span class="job-row-count" data-count="${ESC(j.id)}">${ESC(countText(j))}</span></span>
    </li>`;
  }
  const word = STATUS_WORD[j.status as Exclude<JobStatus, 'running'>] ?? 'Done';
  const detail = j.status === 'failed' && j.error ? `<span class="job-row-note">${ESC(j.error)}</span>` : '';
  return `<li class="job-row">
    <span class="job-row-title">${ESC(j.title)}</span>
    <span class="job-row-meta"><span class="job-row-status job-row-status--${j.status}">${ESC(t(word))}</span>${detail}</span>
  </li>`;
}

function renderPanel(jobs: readonly Job[]): string {
  const rows = jobs.map(rowHtml).join('');
  return `<div class="job-panel">
    <div class="job-panel-head">
      <span class="job-panel-title">${ESC(t('Background jobs'))}</span>
      <button type="button" class="job-x" data-act="collapse" aria-label="${ESC(tRaw('Hide job details'))}" title="${ESC(tRaw('Hide job details'))}">\u2304</button>
    </div>
    <ol class="job-list">${rows}</ol>
    <p class="job-panel-note">${ESC(t('Jobs stop if you reload or close this tab.'))}</p>
  </div>`;
}

// ── Desktop notification ──────────────────────────────────────────────────────

/**
 * Request Notification permission on the FIRST heavy (long) job start, once per
 * session. Runs synchronously inside startJob()'s emit → inside the Run-button
 * click, so it is inside the user gesture a permission prompt requires. If
 * denied or unsupported we simply never notify and rely on the toast.
 */
function maybeRequestPermission(jobs: readonly Job[]): void {
  if (permissionRequested) return;
  if (!jobs.some(j => j.heavy && isActive(j))) return;
  permissionRequested = true;
  requestNotifyPermission();
}

function requestNotifyPermission(): void {
  if (isTauriShell()) {
    // TODO(plans/124 WP-F · Tauri): request via @tauri-apps/plugin-notification
    // (isPermissionGranted/requestPermission). It is NOT statically importable in
    // the web build - the Tauri shells are not npm workspaces, so the package is
    // unresolvable here and a static import breaks tsc + the Vite build. Falling
    // through to the web Notification API for now, which works inside the Tauri
    // webview too, so desktop still gets a prompt.
  }
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  } catch { /* some engines throw on the deprecated sync form - ignore, toast still shows */ }
}

/** Detect jobs that just reached `done` and (when the tab is hidden) notify. */
function fireCompletionNotices(jobs: readonly Job[]): void {
  const seen = new Set<string>();
  for (const j of jobs) {
    seen.add(j.id);
    const prev = lastStatus.get(j.id);
    if (j.status === 'done' && (prev === 'running' || prev === 'queued')) notifyDone(j);
    lastStatus.set(j.id, j.status);
  }
  for (const id of [...lastStatus.keys()]) if (!seen.has(id)) lastStatus.delete(id);
}

function notifyDone(job: Job): void {
  // In-tab: the toast's completed state is the whole story; no OS notification.
  if (typeof document !== 'undefined' && !document.hidden) return;
  if (isTauriShell()) {
    // TODO(plans/124 WP-F · Tauri): sendNotification() via the notification plugin
    // (see requestNotifyPermission for why it isn't imported here). Web path below
    // still fires inside the Tauri webview, so this is not a regression on desktop.
  }
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(job.title || tRaw('Job finished'), { body: tRaw('Ready in Lolly.'), tag: job.id });
    n.onclick = () => {
      try { window.focus(); } catch { /* focus can throw in some embeds */ }
      try { n.close(); } catch { /* ignore */ }
    };
  } catch { /* Notification construction can throw; the toast still shows done */ }
}
