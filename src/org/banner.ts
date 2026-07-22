// SPDX-License-Identifier: MPL-2.0
/**
 * org/banner — surface a deployment's inbox as ONE dismissible message.
 *
 * Loaded lazily by src/org/index.ts, and only for a member whose org-config
 * reports unread messages, so a plain (control-plane-free) deployment never
 * touches this file. It fetches `GET /api/v1/inbox`, shows the single
 * highest-severity message (blocking > action > info), and acks it on dismiss
 * (`POST /api/v1/inbox/:id/ack`).
 *
 * Presentation follows the message's severity but never obstructs the app:
 *   - info / action → a slim, dismissible bar pinned above the app content
 *     (inserted into #app before #view, so it survives view navigation).
 *   - blocking → the house modal primitive (Escape-closable per the app-wide
 *     convention). It is a speed-bump, not a lock: closing it (button OR Escape)
 *     acks the message and hands control straight back to the app.
 */

import { instanceFetch, instancePath } from '../lib/instance.ts';
import { mountModal } from '../components/modal.ts';
import { t } from '../i18n.ts';
import { escape } from '../utils.ts';

export type Severity = 'info' | 'action' | 'blocking';

export interface InboxMessage {
  id: string;
  kind: string;
  severity: Severity;
  title: string;
  body?: string;
  cta?: { label: string; url: string };
  dismissible: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 1, action: 2, blocking: 3 };

/**
 * The single message to show: the highest-severity one (blocking > action >
 * info), ties broken by input order. Pure — exported for tests.
 */
export function pickMessage(messages: readonly InboxMessage[]): InboxMessage | null {
  let best: InboxMessage | null = null;
  for (const m of messages) {
    if (!m || !SEVERITY_RANK[m.severity]) continue;
    if (!best || SEVERITY_RANK[m.severity] > SEVERITY_RANK[best.severity]) best = m;
  }
  return best;
}

/** Fire-and-forget ack. Best-effort: a failed ack never blocks the UI removal. */
function ack(id: string): void {
  void instanceFetch(instancePath(`/api/v1/inbox/${encodeURIComponent(id)}/ack`), { method: 'POST' })
    .catch(() => { /* best-effort — the message is already gone from the UI */ });
}

/** A CTA link (if the message carries one), styled as a small shell button. */
function ctaHtml(m: InboxMessage): string {
  if (!m.cta?.url || !m.cta.label) return '';
  return `<a class="btn btn--sm org-banner-cta" href="${escape(m.cta.url)}">${escape(m.cta.label)}</a>`;
}

let mounted = false;

/**
 * Fetch the inbox and render the single most important message. Idempotent per
 * session (a second call is a no-op while one message is already showing).
 */
export async function mountOrgBanner(): Promise<void> {
  if (mounted) return;
  const res = await instanceFetch(instancePath('/api/v1/inbox')).catch(() => null);
  if (!res || !res.ok) return;
  let messages: InboxMessage[] = [];
  try {
    const body = (await res.json()) as { messages?: InboxMessage[] };
    messages = Array.isArray(body?.messages) ? body.messages : [];
  } catch { return; }

  const msg = pickMessage(messages);
  if (!msg) return;
  mounted = true;

  if (msg.severity === 'blocking') showBlocking(msg);
  else showBar(msg);
}

/** info / action — a slim dismissible bar above the app. */
function showBar(m: InboxMessage): void {
  const app = document.getElementById('app');
  const view = document.getElementById('view');
  if (!app) { mounted = false; return; }
  document.getElementById('org-banner')?.remove();

  const bar = document.createElement('div');
  bar.id = 'org-banner';
  bar.className = `org-banner org-banner--${escape(m.severity)}`;
  bar.setAttribute('role', m.severity === 'action' ? 'status' : 'note');
  // Theme-aware, self-contained styling — no stylesheet touch for this additive
  // seam. An `action` message leans on the brand accent, `info` on muted chrome.
  const accent = m.severity === 'action' ? 'var(--primary)' : 'var(--muted-foreground)';
  bar.style.cssText = `display:flex;align-items:center;gap:.75rem;padding:.6rem 1rem;font-size:.9rem;line-height:1.4;border-bottom:1px solid hsl(var(--border));background:hsl(${accent} / .08);color:hsl(var(--foreground))`;

  const body = m.body ? ` <span style="color:hsl(var(--muted-foreground))">${escape(m.body)}</span>` : '';
  bar.innerHTML = `
    <span style="flex:0 0 auto;width:.5rem;height:.5rem;border-radius:50%;background:hsl(${accent})" aria-hidden="true"></span>
    <span style="flex:1 1 auto;min-width:0"><strong style="font-weight:650">${escape(m.title)}</strong>${body}</span>
    ${ctaHtml(m)}
    ${m.dismissible ? `<button type="button" class="org-banner-dismiss" aria-label="${escape(t('Dismiss'))}" style="flex:0 0 auto;border:0;background:transparent;color:inherit;cursor:pointer;font-size:1.2rem;line-height:1;padding:.1rem .3rem;opacity:.7">&times;</button>` : ''}`;

  app.insertBefore(bar, view ?? null);

  bar.querySelector('.org-banner-dismiss')?.addEventListener('click', () => {
    bar.remove();
    mounted = false;
    ack(m.id);
  });
}

/** blocking — the house modal, Escape-closable; any close acks. */
function showBlocking(m: InboxMessage): void {
  const content = `
    <h2 class="modal-title">${escape(m.title)}</h2>
    ${m.body ? `<p class="modal-msg">${escape(m.body)}</p>` : ''}
    <div class="modal-actions">
      ${ctaHtml(m)}
      <button type="button" class="btn modal-primary" data-act="ok">${escape(m.cta ? t('Dismiss') : t('Got it'))}</button>
    </div>`;
  const modal = mountModal<void>(content, {
    className: 'modal',
    ariaLabel: m.title,
    initialFocus: (el) => el.querySelector<HTMLElement>('[data-act="ok"]'),
    // Closing however (button, Escape, backdrop) acks and frees the app.
    onClose: () => { mounted = false; ack(m.id); },
  });
  modal.el.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-act="ok"]')) modal.close();
  });
}

/** TEST-ONLY: reset the once-per-session guard. */
export function _resetBannerForTests(): void {
  mounted = false;
}
