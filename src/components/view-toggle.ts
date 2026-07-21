// SPDX-License-Identifier: MPL-2.0
/**
 * The Projects | Tools | Utilities | Catalog switch shown atop the gallery, the
 * utilities view, the projects view and the catalog view. Two coordinated forms:
 *
 * - Native links (`viewToggle()`, rendered by every listing view's topbar):
 *   pure markup — real hash links (`#` tools, `#/u` utilities, `#/p` projects,
 *   `#/c` catalog), so the router's hashchange listener handles navigation; no
 *   JS wiring. Desktop shows icon+label; on mobile the label hides and the
 *   toggle shrinks to icons (topbar.css). The Utilities tab only renders while
 *   the 'Offline Utilities' feature flag is on — the same flag that gates the
 *   `#/u` route itself (main.ts redirects to the gallery when it's off).
 *
 * - Jelly pill (`syncJellyNavToggle()`, Jelly effects flag on, desktop only):
 *   ONE persistent <jelly-segmented> mounted at body level, ABOVE the
 *   view-fade overlay. It is deliberately NOT part of any view's markup: the
 *   cross-view fade snapshots the outgoing view by MOVING its live nodes, and a
 *   jelly control in that snapshot keeps animating — the pill slid in the dying
 *   copy while the incoming view mounted its own already-parked copy, reading
 *   as a double animation. Hoisted, there is exactly one control; its pill
 *   slides once, continuously, while the views cross-fade beneath it. While the
 *   jelly pill is shown, `:root[data-jelly-nav]` hides the per-view native
 *   toggle on desktop; mobile always keeps the native icons (jelly-segment
 *   labels are textContent-only — no icon glyphs).
 *
 * `active` is 'tools', 'utilities', 'projects' or 'catalog'.
 */
import { flagEnabledSync } from '../feature-flags.ts';
import { t } from '../i18n.ts';
import { icon } from '../lib/icons.ts';
import { jellyActive } from '../lib/jelly.ts';
import { playSfx } from '../lib/sfx.ts';
import { escape } from '../utils.ts';

export type ViewToggleKey = 'tools' | 'utilities' | 'projects' | 'catalog';

/** The feature flag that shows/hides the Utilities view (tab + `#/u` route).
 *  The id predates the view (it used to hide the gallery's utilities section)
 *  and is a persisted key — it stays 'cat-developer'. */
export const UTILITIES_FLAG_ID = 'cat-developer';

// Lucide glyphs — wrench (Tools), hammer (Utilities), folder (Projects),
// layout-grid (Catalog).
const ICONS: Record<ViewToggleKey, string> = {
  tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  utilities: icon('hammer'),
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  catalog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
};

// key → hash target. The jelly segments carry these as their submitted values,
// so the persistent control's change handler is just `location.hash = value`.
export const VIEW_TOGGLE_HREFS: Record<ViewToggleKey, string> = {
  tools: '#',
  utilities: '#/u',
  projects: '#/p',
  catalog: '#/c',
};

// Tab order: Projects leads, then Tools, Utilities, Catalog.
const KEYS: readonly ViewToggleKey[] = ['projects', 'tools', 'utilities', 'catalog'];

const LABELS: Record<ViewToggleKey, string> = {
  tools: 'Tools',
  utilities: 'Utilities',
  projects: 'Projects',
  catalog: 'Catalog',
};

/** The tabs currently on offer — Utilities drops out with its feature flag. */
function activeKeys(): ViewToggleKey[] {
  return KEYS.filter(k => k !== 'utilities' || flagEnabledSync(UTILITIES_FLAG_ID));
}

export function viewToggle(active: ViewToggleKey): string {
  const opt = (key: ViewToggleKey, href: string, label: string) =>
    `<a href="${href}" class="view-toggle-opt${active === key ? ' is-active' : ''}"` +
    // The active tab is a no-op navigation → stays silent; the others play the "navigate"
    // swish (data-sfx is read by the app-wide sfx delegation in lib/sfx.ts).
    `${active === key ? ' aria-current="page"' : ' data-sfx="navigate"'} data-vt="${key}" aria-label="${escape(label)}">` +
    `<span class="view-toggle-ic" aria-hidden="true">${ICONS[key]}</span>` +
    `<span class="view-toggle-label">${escape(label)}</span>` +
    `</a>`;
  return `
    <nav class="view-toggle" aria-label="${escape(t('Switch between tools, utilities, projects and catalog'))}">
      ${activeKeys().map(k => opt(k, VIEW_TOGGLE_HREFS[k], t(LABELS[k]))).join('\n      ')}
    </nav>`;
}

// ── The persistent jelly pill ────────────────────────────────────────────────

let jellyNav: HTMLElement | null = null;

function segmentsHtml(keys: ViewToggleKey[]): string {
  return keys.map(k => `<jelly-segment value="${VIEW_TOGGLE_HREFS[k]}">${escape(t(LABELS[k]))}</jelly-segment>`).join('');
}

/**
 * Reconcile the persistent jelly tab pill with the current route. Call after
 * every route mount: a listing view's key shows it (mounting once, then just
 * steering `value` so the pill SLIDES from the previous tab), `null` (tool,
 * profile, dashboard…) hides it. No-op — and cleans up — when the Jelly flag
 * is off or the bundle isn't loaded yet.
 */
export function syncJellyNavToggle(active: ViewToggleKey | null): void {
  if (!active || !jellyActive()) {
    jellyNav?.setAttribute('hidden', '');
    document.documentElement.removeAttribute('data-jelly-nav');
    return;
  }
  const keys = activeKeys();
  if (!jellyNav) {
    jellyNav = document.createElement('div');
    jellyNav.className = 'jelly-nav-wrap';
    document.body.appendChild(jellyNav);
    jellyNav.addEventListener('change', (e) => {
      if (!(e.target instanceof Element) || e.target.tagName !== 'JELLY-SEGMENTED') return;
      const value = (e as CustomEvent<{ value?: string }>).detail?.value;
      if (!value || (location.hash || '#') === value) return;
      playSfx('navigate');
      // Navigate immediately — this control survives the route swap, so the
      // pill's slide plays out across it with no handoff.
      location.hash = value === '#' ? '' : value;
    });
  }
  // (Re)build the segments only when the tab set changes (the Utilities flag),
  // so ordinary route syncs never reset the physics state mid-slide.
  if (jellyNav.dataset.keys !== keys.join()) {
    jellyNav.dataset.keys = keys.join();
    jellyNav.innerHTML = `<jelly-segmented class="view-toggle-seg" value="${VIEW_TOGGLE_HREFS[active]}" label="${escape(t('Switch between tools, utilities, projects and catalog'))}">${segmentsHtml(keys)}</jelly-segmented>`;
  } else {
    // Steering the value attribute re-syncs the control and the pill ANIMATES
    // from wherever it is — including a route change driven by the native
    // mobile links, the back button, or a deep link.
    jellyNav.querySelector('jelly-segmented')?.setAttribute('value', VIEW_TOGGLE_HREFS[active]);
  }
  jellyNav.removeAttribute('hidden');
  document.documentElement.setAttribute('data-jelly-nav', '');
}
