// SPDX-License-Identifier: MPL-2.0
/**
 * Mobile profile menu - the avatar in the top-right cluster becomes a single
 * compact button on narrow screens (the standalone history button, language FAB
 * and the "Profile" wordmark are hidden by CSS), and tapping it opens this
 * popover with everything that was scattered across the bar: the theme
 * switcher, Home, saved sessions (history), the language menu (opened as a
 * child popover off its row), and a link to the full Settings page. Home and
 * Language live here so utility views (docs, ask) get ONE stable place for
 * them on mobile instead of per-view wandering fabs.
 *
 * On desktop the avatar is left alone - it stays a plain link to #/profile - so
 * this only intercepts the click while the small-screen layout is active.
 *
 * attachProfileMenu(trigger, host, { savedCount, onHistory }) - wires `trigger`
 * (the .profile-link anchor). Returns a cleanup function that detaches listeners
 * and removes any open popover (the views call it on re-render / unmount).
 *
 * Mirrors the filter popover's conventions: Escape + outside-pointerdown close,
 * focus returns to the trigger.
 */
import { THEMES, THEME_LABELS, currentTheme } from '../theme.ts';
import { setTheme, type SetThemeHost } from '../lib/set-theme.ts';
import { escape } from '../utils.ts';
import { icon } from '../lib/icons.ts';
import { mountBodyPopover } from './body-popover.ts';
import { t, LANG_META, currentLang, type LangSwitchHost } from '../i18n.ts';

// Matches the gallery/projects mobile breakpoint (the chrome only collapses there).
const MOBILE = '(max-width: 640px)';

// The chevron every navigation row wears (was hand-copied per row).
const CHEVRON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

// setTheme's weak profile slice (see folders.ts FolderProfile for the same
// no-index-signature pattern) plus switchLang's - the Language row hands the
// host to lang-menu's switchLang. Every caller passes a full HostV1 anyway.
type ProfileMenuHost = SetThemeHost & LangSwitchHost;

/** True when `node` sits inside the language popover this menu spawns - the
 *  body-popover `isInside` escape hatch, so a tap or Escape in the child
 *  doesn't dismiss this menu underneath it. */
function inLangMenu(node: Node | null): boolean {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return !!el?.closest('.lang-menu');
}

export function attachProfileMenu(
  triggerEl: HTMLElement | null,
  host: ProfileMenuHost,
  { savedCount = 0, onHistory }: { savedCount?: number; onHistory?: () => void } = {},
): () => void {
  if (!triggerEl) return () => {};
  const trigger = triggerEl; // const so closures see the narrowed (non-null) type
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  // The Language row's child popover detach - re-wired per open (render runs
  // fresh each time), torn down with the menu so the child can't outlive it.
  let detachLang: (() => void) | null = null;

  const popover = mountBodyPopover(trigger, (el, pop) => {
    const theme = currentTheme();
    el.innerHTML = `
      <div class="profile-menu-theme" role="group" aria-label="${escape(t('Theme'))}">
        ${THEMES.map(seg => `<button type="button" class="profile-menu-seg" role="menuitemradio" data-theme-seg="${seg}" aria-checked="${seg === theme}">${escape(t(THEME_LABELS[seg] ?? seg))}</button>`).join('')}
      </div>
      <a class="profile-menu-item" role="menuitem" href="/#/" data-act="home">
        <span>${t('Home')}</span>
        ${CHEVRON}
      </a>
      ${savedCount ? `<button type="button" class="profile-menu-item" role="menuitem" data-act="history">
        <span>${t('Saved sessions')}</span><span class="profile-menu-count">${savedCount}</span>
      </button>` : ''}
      <button type="button" class="profile-menu-item" role="menuitem" data-act="lang" aria-haspopup="menu" aria-expanded="false">
        <span>${t('Language')}</span><span class="profile-menu-count">${escape(LANG_META[currentLang()].nativeName)}</span>
      </button>
      <a class="profile-menu-item" role="menuitem" href="#/start" data-act="brand">
        <span>${t('Set up your brand')}</span>
        ${CHEVRON}
      </a>
      <a class="profile-menu-item" role="menuitem" href="#/profile" data-act="settings">
        <span>${t('Settings')}</span>
        ${CHEVRON}
      </a>`;

    // Theme: apply immediately + persist to the profile (canonical store), like the
    // profile view's segmented control. Keep the menu open so it can be re-tried.
    // The theme id rides on data-theme-seg, NOT data-theme: tokens.css scopes every theme
    // variable via the [data-theme="…"] attribute selector, so a data-theme on each button
    // would re-scope the tokens onto it (its --muted-foreground etc. would resolve in the
    // button's OWN theme) - making the "Light" label render in light theme's dark grey,
    // near-invisible on a dark menu. Matching the other segments' data-*-seg keeps that off.
    // The theme segments form a radio group: use a roving tabindex so Tab treats the
    // whole group as one stop (landing on the checked segment) and Arrow keys move
    // between segments. focus-trap skips the tabindex="-1" segments, so Tab steps
    // straight past the group to the menu items below.
    const segs = [...el.querySelectorAll<HTMLElement>('[data-theme-seg]')];
    const checkedSeg = segs.find(b => b.getAttribute('aria-checked') === 'true') ?? segs[0]!;
    const rove = (active: HTMLElement, focus = true): void => {
      segs.forEach(b => { b.tabIndex = b === active ? 0 : -1; });
      if (focus) active.focus();
    };
    rove(checkedSeg, false);

    const themeGroup = el.querySelector<HTMLElement>('.profile-menu-theme');
    themeGroup?.addEventListener('click', async (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('[data-theme-seg]');
      if (!btn) return;
      const next = btn.dataset.themeSeg!;
      segs.forEach(b => b.setAttribute('aria-checked', String(b.dataset.themeSeg === next)));
      rove(btn, false);   // the newly-checked segment becomes the group's single tab stop
      await setTheme(host, next);   // theme switch always sings - including this mobile profile-menu path
    });
    // Roving arrow-key navigation between the radio segments (Up/Left ←, Down/Right →), wrapping.
    themeGroup?.addEventListener('keydown', (e) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const i = segs.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      rove(segs[(i + step + segs.length) % segs.length]!);
    });

    el.querySelector('[data-act="history"]')?.addEventListener('click', () => {
      pop.close();
      onHistory?.();
    });
    // Home / Brand wizard / Settings are plain hash links; just let them
    // navigate, closing the menu first. Home is `/#/` (root-absolute like the
    // back pill's HOME_HREF - a bare '#/' resolves against a /t/<id> path). The
    // wizard entry shows always - a branded user re-running it is a supported
    // path (it overwrites the user tokens).
    el.querySelector('[data-act="home"]')?.addEventListener('click', () => pop.close());
    el.querySelector('[data-act="brand"]')?.addEventListener('click', () => pop.close());
    el.querySelector('[data-act="settings"]')?.addEventListener('click', () => pop.close());

    // Language opens the full lang-menu popover as a CHILD anchored off this
    // row (mountBodyPopover's documented spawns-popovers case - `isInside`
    // below keeps this menu open under it and yields Escape to it). Same lazy
    // import as view-topbar's fab wiring: the chunk loads while the menu is
    // open, so the row wires within ~ms of first paint.
    const langBtn = el.querySelector<HTMLElement>('[data-act="lang"]');
    if (langBtn) {
      void import('./lang-menu.ts').then((m) => {
        if (langBtn.isConnected) detachLang = m.attachLangMenu(langBtn, host);
      });
    }

    // Contain keyboard focus: wrap Tab/Shift+Tab within the menu, moving initial
    // focus to the checked theme segment. inertBackground is off - the avatar
    // trigger lives in the branch that would get inerted, and inert cascades with
    // no way for a descendant to opt back out, which would kill the trigger's
    // re-tap-to-close affordance (and looks like the whole page is stuck).
    return checkedSeg;
  }, {
    className: 'profile-menu',
    ariaLabel: escape(t('Profile and settings')),
    // A viewport resize past the breakpoint (rotate / desktop) makes the menu moot -
    // the inline buttons take over again - so just dismiss it rather than reflow.
    onResize: (pop) => { if (!window.matchMedia(MOBILE).matches) pop.close(); },
    // The Language row's child popover is a body sibling - own it (see inLangMenu).
    isInside: inLangMenu,
    // Close the child with the parent, whichever route closed it (Escape,
    // outside tap, route change) - detachLang's cleanup closes the child popover.
    onClose: () => { detachLang?.(); detachLang = null; },
  });

  const onClick = (e: MouseEvent) => {
    // Desktop: leave the avatar as a direct link to the profile page.
    if (!window.matchMedia(MOBILE).matches) return;
    e.preventDefault();
    popover.isOpen() ? popover.close(true) : popover.open();
  };
  trigger.addEventListener('click', onClick);

  return () => { popover.close(); trigger.removeEventListener('click', onClick); };
}

/**
 * Append the profile FAB (icon-only `#/profile` link, skinned `.profile-fab` -
 * topbar.css, same box as `.theme-fab`) to a view's fixed top-right cluster and
 * attach the mobile menu to it - the mirror of theme-toggle.ts's mountThemeFab,
 * for the nav-less utility views (Dashboard, Verify, Convert, Spreadsheet,
 * Unpack, Script, /start, the Lab). Desktop: a plain quick link to the profile;
 * ≤640px: the consolidated menu, and the cluster's own language FAB hides
 * against it (overrides.css `.gallery-topright:has(.profile-fab) .lang-fab`).
 * A no-op when the cluster isn't present, like mountThemeFab.
 */
export function mountProfileFab(
  cluster: Element | null,
  host: ProfileMenuHost,
  opts: { className?: string } = {},
): void {
  if (!cluster) return;
  const link = document.createElement('a');
  link.href = '#/profile';
  link.className = opts.className ?? 'profile-fab';
  link.setAttribute('aria-label', t('Open your profile'));
  link.title = t('Profile');
  link.innerHTML = icon('user');
  cluster.appendChild(link);
  attachProfileMenu(link, host);
}
