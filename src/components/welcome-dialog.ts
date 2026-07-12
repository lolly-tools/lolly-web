// SPDX-License-Identifier: MPL-2.0
/**
 * First-run welcome for an UNBRANDED install (the lolly-start profile) — plus
 * the slim "how Lolly works" tips strip the gallery shows until dismissed.
 *
 * The gallery decides WHEN to show these (token discovery still resolves the
 * `lolly/tokens/brand` placeholder — see mountGallery); this module owns the
 * dialog/strip themselves. The welcome is built on mountModal (components/modal.ts,
 * Escape via the `cancel` event, backdrop-box click test, mounted on <body>),
 * offering two paths:
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
import { currentLang, langOptions, setActiveLang, t, LANG_ICON_SVG, flagEmoji } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { escape, NAV_EVENTS } from '../utils.ts';
import type { WebProfileAPI } from '../bridge/profile.ts';
import { mountModal } from './modal.ts';

/** Persisted (localStorage, same tier as the theme) once the welcome is settled. */
export const WELCOME_DISMISSED_KEY = 'lolly-welcome-dismissed';
const TIPS_DISMISSED_KEY = 'lolly-tips-dismissed';

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

// Renders the dialog's own copy through t() so a language-chip switch can
// re-paint it in place, and the chip row itself (native names, active state
// from the resolved boot-time language — see i18n.ts's initI18n).
function renderWelcomeContent(): string {
  return `
    <div class="welcome-langs" role="group" aria-label="Language">
      ${LANG_ICON_SVG}
      ${langOptions().map(o => {
        const flags = o.flags.length ? `<span class="welcome-lang-flags" aria-hidden="true">${o.flags.map(flagEmoji).join('')}</span>` : '';
        return `<button type="button" class="welcome-lang${o.code === currentLang() ? ' is-active' : ''}" data-lang="${o.code}" aria-pressed="${o.code === currentLang()}">${flags}${escape(o.nativeName)}</button>`;
      }).join('')}
    </div>
    <p class="welcome-eyebrow">${t('Welcome to Lolly')}</p>
    <h2 class="welcome-title">${t('Your tools, your rules')}</h2>
    <p class="welcome-sub">${t('Finished creative assets from simple inputs — pick a path, change your mind any time.')}</p>
    <div class="welcome-cards">
      <button type="button" class="welcome-card welcome-card--brand" data-choice="brand">
        <span class="welcome-card-kicker">${t('Make it yours')}</span>
        <span class="welcome-card-line">${t('Start from one colour or your design tokens — everything stays on this device.')}</span>
        <span class="welcome-card-cta" aria-hidden="true">${t('Set up your brand →')}</span>
      </button>
      <button type="button" class="welcome-card" data-choice="explore">
        <span class="welcome-card-kicker">${t('Explore the community tools')}</span>
        <span class="welcome-card-line">${t('Jump straight in — QR codes, street maps, filters and more, no setup needed.')}</span>
        <span class="welcome-card-cta" aria-hidden="true">${t('Browse the gallery →')}</span>
      </button>
    </div>`;
}

/**
 * Show the welcome (or return the already-open instance's promise). Resolves
 * with the user's choice; 'brand' has already navigated to #/start by the time
 * the promise settles, so callers typically don't need to act on it.
 *
 * `profileApi`, when given, lets the language chips persist a choice to the
 * canonical profile record (mirrors the profile-card picker); without it the
 * choice still applies for the session via i18n.ts's localStorage mirror.
 */
export function showWelcomeDialog(profileApi?: WebProfileAPI): Promise<WelcomeChoice> {
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve) => {
    const modal = mountModal<WelcomeChoice | null>(renderWelcomeContent(), {
      className: 'welcome-dialog',
      ariaLabel: 'Welcome to Lolly',
      cancelValue: 'dismiss', // Escape / backdrop click
      initialFocus: (el) => el.querySelector<HTMLElement>('.welcome-card--brand'), // lead with the brand path
      // `result` null = programmatic teardown (a navigation) — resolve without
      // persisting; every USER dismissal except the wizard path sets the flag.
      onClose: (result) => {
        if (result === 'explore' || result === 'dismiss') markWelcomeDismissed();
        NAV_EVENTS.forEach(ev => window.removeEventListener(ev, onNav));
        settleOpen = null;
        openPromise = null;
        resolve(result ?? 'dismiss');
      },
    });
    settleOpen = (choice) => modal.close(choice);
    const onNav = (): void => modal.close(null);

    modal.el.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;

      // Language chip — applies immediately (re-renders this dialog's own copy),
      // persists to the profile (if we have write access) + localStorage, and
      // deliberately does NOT settle the dialog: picking a language isn't a choice
      // about brand vs. explore.
      const langBtn = target?.closest<HTMLButtonElement>('[data-lang]');
      if (langBtn) {
        const lang = langBtn.dataset.lang as Lang;
        void (async () => {
          await setActiveLang(lang, { persist: true });
          if (profileApi) {
            try {
              const current = await profileApi.get();
              const { lang: _drop, ...rest } = current as Record<string, unknown>;
              await profileApi.set(lang === 'en' ? rest : { ...rest, lang });
            } catch { /* preference save is best-effort */ }
          }
          if (modal.el.isConnected) {
            modal.el.innerHTML = renderWelcomeContent();
            modal.el.querySelector<HTMLButtonElement>(`[data-lang="${lang}"]`)?.focus();
          }
        })();
        return;
      }

      const card = target?.closest<HTMLElement>('[data-choice]');
      if (card) {
        const choice = card.dataset.choice as WelcomeChoice;
        modal.close(choice);
        if (choice === 'brand') window.location.hash = '#/start';
      }
      // Backdrop dismissal is handled by mountModal (cancelValue: 'dismiss').
    });
    NAV_EVENTS.forEach(ev => window.addEventListener(ev, onNav));
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
