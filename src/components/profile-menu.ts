// SPDX-License-Identifier: MPL-2.0
/**
 * Mobile profile menu — the avatar in the top-right cluster becomes a single
 * compact button on narrow screens (the standalone history button and the
 * "Profile" wordmark are hidden by CSS), and tapping it opens this popover with
 * everything that was scattered across the bar: the theme switcher, saved
 * sessions (history), and a link to the full Settings page.
 *
 * On desktop the avatar is left alone — it stays a plain link to #/profile — so
 * this only intercepts the click while the small-screen layout is active.
 *
 * attachProfileMenu(trigger, host, { savedCount, onHistory }) — wires `trigger`
 * (the .profile-link anchor). Returns a cleanup function that detaches listeners
 * and removes any open popover (the views call it on re-render / unmount).
 *
 * Mirrors the filter popover's conventions: Escape + outside-pointerdown close,
 * focus returns to the trigger.
 */
import { THEMES, THEME_LABELS, currentTheme, applyTheme } from '../theme.ts';
import { playThemeSfx } from '../lib/sfx.ts';
import { escape } from '../utils.ts';
import { trapFocus, type FocusTrap } from '../lib/focus-trap.ts';
import { t } from '../i18n.ts';

// Matches the gallery/projects mobile breakpoint (the chrome only collapses there).
const MOBILE = '(max-width: 640px)';
// Route-change signals the web shell fires (see main.js) — any one dismisses an
// open menu so it never outlives the view that spawned it.
const NAV_EVENTS = ['hashchange', 'popstate', 'lolly:navigate'];

interface ProfileMenuHost {
  profile: {
    // No index signature: a real Profile (no index signature of its own) can
    // never structurally satisfy one. This module only spreads the value, so
    // `object` is enough — see folders.ts FolderProfile for the same pattern.
    get(): Promise<object>;
    set(profile: object): Promise<unknown>;
  };
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

  let menu: HTMLDivElement | null = null;
  let outside: ((e: PointerEvent) => void) | null = null;
  let trap: FocusTrap | null = null;

  function close(returnFocus = false): void {
    if (!menu) return;
    if (outside) document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    NAV_EVENTS.forEach(ev => window.removeEventListener(ev, onNavAway));
    outside = null;
    trap?.release();   // restore inert siblings + drop the Tab-wrap listener
    trap = null;
    menu.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus();
  }

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
  // A viewport resize past the breakpoint (rotate / desktop) makes the menu moot —
  // the inline buttons take over again — so just dismiss it rather than reflow.
  const onResize = () => { if (!window.matchMedia(MOBILE).matches) close(); };
  // The menu lives on document.body, so a route change would otherwise leave it
  // orphaned (the view's innerHTML swap can't reach it). Dismiss on any navigation.
  const onNavAway = () => close();

  function position(): void {
    if (!menu) return;
    const r = trigger.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 8)}px`;
    // Right-align the panel with the avatar's right edge.
    menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }

  function open(): void {
    if (menu) return;
    const theme = currentTheme();
    const el = document.createElement('div');
    menu = el;
    el.className = 'profile-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', escape(t('Profile and settings')));
    el.innerHTML = `
      <div class="profile-menu-theme" role="group" aria-label="${escape(t('Theme'))}">
        ${THEMES.map(seg => `<button type="button" class="profile-menu-seg" role="menuitemradio" data-theme-seg="${seg}" aria-checked="${seg === theme}">${escape(t(THEME_LABELS[seg] ?? seg))}</button>`).join('')}
      </div>
      ${savedCount ? `<button type="button" class="profile-menu-item" role="menuitem" data-act="history">
        <span>${t('Saved sessions')}</span><span class="profile-menu-count">${savedCount}</span>
      </button>` : ''}
      <a class="profile-menu-item" role="menuitem" href="#/start" data-act="brand">
        <span>${t('Set up your brand')}</span>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
      </a>
      <a class="profile-menu-item" role="menuitem" href="#/profile" data-act="settings">
        <span>${t('Settings')}</span>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
      </a>`;
    document.body.appendChild(el);
    position();
    trigger.setAttribute('aria-expanded', 'true');

    // Theme: apply immediately + persist to the profile (canonical store), like the
    // profile view's segmented control. Keep the menu open so it can be re-tried.
    // The theme id rides on data-theme-seg, NOT data-theme: tokens.css scopes every theme
    // variable via the [data-theme="…"] attribute selector, so a data-theme on each button
    // would re-scope the tokens onto it (its --muted-foreground etc. would resolve in the
    // button's OWN theme) — making the "Light" label render in light theme's dark grey,
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
      applyTheme(next);
      playThemeSfx(next);   // theme switch always sings — including this mobile profile-menu path
      segs.forEach(b => b.setAttribute('aria-checked', String(b.dataset.themeSeg === next)));
      rove(btn, false);   // the newly-checked segment becomes the group's single tab stop
      try {
        const profile = await host.profile.get();
        await host.profile.set({ ...profile, theme: next });
      } catch { /* preference save is best-effort */ }
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
      close();
      onHistory?.();
    });
    // Brand wizard + Settings are plain hash links; just let them navigate,
    // closing the menu first. The wizard entry shows always — a branded user
    // re-running it is a supported path (it overwrites the user tokens).
    el.querySelector('[data-act="brand"]')?.addEventListener('click', () => close());
    el.querySelector('[data-act="settings"]')?.addEventListener('click', () => close());

    outside = (e) => { if (menu && !menu.contains(e.target as Node) && !trigger.contains(e.target as Node)) close(); };
    setTimeout(() => document.addEventListener('pointerdown', outside!), 0);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    NAV_EVENTS.forEach(ev => window.addEventListener(ev, onNavAway));
    // Contain keyboard focus: wrap Tab/Shift+Tab within the menu, moving initial
    // focus to the checked theme segment. Escape is still handled by onKey above,
    // so no onEscape is passed here. inertBackground is off — the avatar trigger
    // lives in the branch that would get inerted, and inert cascades with no way
    // for a descendant to opt back out, which would kill the trigger's
    // re-tap-to-close affordance (and looks like the whole page is stuck).
    trap = trapFocus(el, { initialFocus: checkedSeg, inertBackground: false });
  }

  const onClick = (e: MouseEvent) => {
    // Desktop: leave the avatar as a direct link to the profile page.
    if (!window.matchMedia(MOBILE).matches) return;
    e.preventDefault();
    menu ? close(true) : open();
  };
  trigger.addEventListener('click', onClick);

  return () => { close(); trigger.removeEventListener('click', onClick); };
}
