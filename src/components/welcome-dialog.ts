// SPDX-License-Identifier: MPL-2.0
/**
 * First-run welcome for an UNBRANDED install (the lolly-start profile) — plus
 * the slim "how Lolly works" tips strip the gallery shows until dismissed.
 *
 * The gallery decides WHEN to show these (token discovery still resolves the
 * `lolly/tokens/brand` placeholder — see mountGallery); this module owns the
 * dialog/strip themselves. The welcome is a native <dialog> following the
 * confirm-dialog conventions (Escape via the `cancel` event, backdrop-box click
 * test, mounted on <body>), offering two paths:
 *
 *   "Make it yours"          → the #/start brand wizard. Deliberately does NOT
 *                              set the dismissed flag — installing a brand (or
 *                              explicitly choosing to explore) is what settles
 *                              the question; backing out of the wizard brings
 *                              the welcome back next visit.
 *   "Explore the tools"      → dismiss, persist the flag, stay on the gallery.
 *
 * Dismissing by any other means (Escape, backdrop) persists the flag too — a
 * welcome that keeps re-appearing after being waved away is a nag, not a hello.
 *
 * Singleton: the gallery force re-mounts itself after a catalog sync, and a
 * second show call while open must hand back the SAME promise instead of
 * stacking a second modal. Any route change tears the dialog down (without
 * setting the flag — navigation isn't a dismissal), so it can never linger
 * over another view.
 */
import '../styles/parts/welcome.css';

/** Persisted (localStorage, same tier as the theme) once the welcome is settled. */
export const WELCOME_DISMISSED_KEY = 'lolly-welcome-dismissed';
const TIPS_DISMISSED_KEY = 'lolly-tips-dismissed';

// Route-change signals the shell fires (see main.ts) — any one tears down an
// open welcome so it never outlives the gallery that spawned it.
const NAV_EVENTS = ['hashchange', 'popstate', 'lolly:navigate'] as const;

/** True once the user has settled the welcome (or when storage is unavailable —
 *  we'd re-prompt every visit otherwise, which is worse than never prompting). */
export function isWelcomeDismissed(): boolean {
  try { return localStorage.getItem(WELCOME_DISMISSED_KEY) === '1'; }
  catch { return true; }
}

/** Persist the dismissal — also called by the #/start wizard after an install. */
export function markWelcomeDismissed(): void {
  try { localStorage.setItem(WELCOME_DISMISSED_KEY, '1'); } catch { /* storage off — just won't persist */ }
}

export type WelcomeChoice = 'brand' | 'explore' | 'dismiss';

let openPromise: Promise<WelcomeChoice> | null = null;
// The open dialog's settle fn — lets closeWelcomeDialog() tear down through the
// same path a route change does (resolve without persisting the flag).
let settleOpen: ((choice: WelcomeChoice | null) => void) | null = null;

/**
 * Show the welcome (or return the already-open instance's promise). Resolves
 * with the user's choice; 'brand' has already navigated to #/start by the time
 * the promise settles, so callers typically don't need to act on it.
 */
export function showWelcomeDialog(): Promise<WelcomeChoice> {
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'welcome-dialog';
    dlg.setAttribute('aria-label', 'Welcome to Lolly');
    // Static markup — no user-influenced strings, nothing to escape.
    dlg.innerHTML = `
      <p class="welcome-eyebrow">Welcome to Lolly</p>
      <h2 class="welcome-title">Your tools, your rules</h2>
      <p class="welcome-sub">Finished creative assets from simple inputs — pick a path, change your mind any time.</p>
      <div class="welcome-cards">
        <button type="button" class="welcome-card welcome-card--brand" data-choice="brand">
          <span class="welcome-card-kicker">Make it yours</span>
          <span class="welcome-card-line">Start from one colour or your design tokens — everything stays on this device.</span>
          <span class="welcome-card-cta" aria-hidden="true">Set up your brand &rarr;</span>
        </button>
        <button type="button" class="welcome-card" data-choice="explore">
          <span class="welcome-card-kicker">Explore the community tools</span>
          <span class="welcome-card-line">Jump straight in — QR codes, street maps, filters and more, no setup needed.</span>
          <span class="welcome-card-cta" aria-hidden="true">Browse the gallery &rarr;</span>
        </button>
      </div>`;
    document.body.appendChild(dlg);

    let settled = false;
    // `choice` null = programmatic teardown (a navigation) — resolve without
    // persisting; every USER dismissal except the wizard path sets the flag.
    const settle = (choice: WelcomeChoice | null): void => {
      if (settled) return;
      settled = true;
      if (choice === 'explore' || choice === 'dismiss') markWelcomeDismissed();
      NAV_EVENTS.forEach(ev => window.removeEventListener(ev, onNav));
      if (dlg.open) dlg.close();
      dlg.remove();
      settleOpen = null;
      openPromise = null;
      resolve(choice ?? 'dismiss');
    };
    settleOpen = settle;
    const onNav = (): void => settle(null);

    dlg.addEventListener('cancel', (e) => { e.preventDefault(); settle('dismiss'); }); // Escape
    dlg.addEventListener('click', (e) => {
      const card = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-choice]') : null;
      if (card) {
        const choice = card.dataset.choice as WelcomeChoice;
        settle(choice);
        if (choice === 'brand') window.location.hash = '#/start';
        return;
      }
      // Click outside the content box (on the backdrop) dismisses.
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) settle('dismiss');
    });
    NAV_EVENTS.forEach(ev => window.addEventListener(ev, onNav));

    dlg.showModal();
    dlg.querySelector<HTMLButtonElement>('.welcome-card--brand')?.focus(); // lead with the brand path
  });
  return openPromise;
}

/** Tear down an open welcome without persisting the flag (safety hatch for hosts) —
 *  the same non-dismissal path a route change takes. No-op when nothing is open. */
export function closeWelcomeDialog(): void {
  settleOpen?.(null);
}

/**
 * The one-time tips strip — "Every tool is a URL · works offline · nothing
 * leaves this device" — inserted just above the gallery masonry while the
 * install is unbranded and until the user dismisses it. `anchorEl` is the
 * element to insert before (the `.tool-masonry`); no-op when it's gone
 * (navigated away) or the strip was already dismissed.
 */
export function mountBrandTips(anchorEl: HTMLElement | null): void {
  if (!anchorEl || !anchorEl.isConnected) return;
  try { if (localStorage.getItem(TIPS_DISMISSED_KEY) === '1') return; }
  catch { return; } // storage off — a dismissal couldn't persist, so don't nag every visit
  if (anchorEl.parentElement?.querySelector('.brand-tips')) return; // already mounted
  const strip = document.createElement('aside');
  strip.className = 'brand-tips';
  strip.setAttribute('role', 'note');
  strip.setAttribute('aria-label', 'How Lolly works');
  strip.innerHTML = `
    <p class="brand-tips-text">Every tool is a URL <span class="brand-tips-dot" aria-hidden="true">&middot;</span> works offline <span class="brand-tips-dot" aria-hidden="true">&middot;</span> nothing leaves this device</p>
    <button type="button" class="brand-tips-dismiss" aria-label="Dismiss tips">&#x2715;</button>`;
  strip.querySelector<HTMLButtonElement>('.brand-tips-dismiss')?.addEventListener('click', () => {
    try { localStorage.setItem(TIPS_DISMISSED_KEY, '1'); } catch { /* storage off */ }
    strip.remove();
  });
  anchorEl.before(strip);
}
