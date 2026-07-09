// SPDX-License-Identifier: MPL-2.0
/**
 * Theme cycle toggle — one compact, icon-only button that steps through the
 * themes (light → dark → brand → …) on click, showing the active theme's glyph.
 * It lives in the canvas zoom HUD (.stage-nav) so every tool with a live canvas
 * — including the chromeless editor/Layout Studio — carries a theme switcher,
 * and the sidebar header stays uncluttered.
 *
 * Icon-only with a tooltip (title + aria-label carry the theme name), styled as
 * a .stage-nav-btn so it matches the zoom controls it sits with (see
 * .stage-nav-theme in editor.css).
 *
 * The profile is the canonical theme store (localStorage is only the FOUC mirror,
 * kept in sync by applyTheme), so each switch is persisted there too — mirroring
 * the profile view's segmented control.
 *
 * createThemeToggle(host) → HTMLButtonElement
 */
import { THEMES, THEME_LABELS, THEME_ICONS, nextTheme, currentTheme, applyTheme } from '../theme.ts';
import { playThemeSfx } from '../lib/sfx.ts';

interface ThemeToggleHost {
  profile: {
    // The stored theme rides the profile record; treat the record as opaque here
    // (an object we spread), so any host Profile type satisfies this weak slice.
    get(): Promise<object>;
    set(profile: object): Promise<unknown>;
  };
}

export function createThemeToggle(host: ThemeToggleHost): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  // Rides the zoom HUD's button idiom; stage-nav-theme handles its ordering /
  // separator within the capsule. No data-nav attr, so the HUD's zoom click
  // delegation ignores it and only this button's own handler fires.
  btn.className = 'stage-nav-btn stage-nav-theme';

  // Widened views: the stored theme is an arbitrary string until validated.
  const icons: Record<string, string> = THEME_ICONS;
  const labels: Record<string, string> = THEME_LABELS;
  const paint = (theme: string) => {
    btn.dataset.theme = theme;
    btn.innerHTML = icons[theme] ?? '';
    const label = `Theme: ${labels[theme] ?? theme} — switch theme`;
    btn.setAttribute('aria-label', label);
    btn.title = label;
  };
  paint(currentTheme());

  btn.addEventListener('click', async () => {
    const theme = nextTheme(currentTheme());
    applyTheme(theme);
    paint(theme);
    playThemeSfx(theme);   // a little magic per theme (user-initiated, so never on boot)
    // Persist to the profile (canonical store); best-effort — a failed write
    // still leaves the theme applied + mirrored to localStorage by applyTheme.
    try {
      const profile = await host.profile.get();
      await host.profile.set({ ...profile, theme });
    } catch { /* preference save is best-effort */ }
  });

  return btn;
}

/**
 * The theme picker as a segmented control (Light / Dark / Brand) for a view-settings
 * popover — matching the `.view-seg` controls those popovers already carry (the gallery's
 * "Featured view", the catalog's "Favourites"). Returned as an HTML string so it drops
 * straight into the popover markup; wire the clicks with wireThemeSegment() once it's in
 * the DOM. `headClass` styles the section label to match the host popover: `filter-pop-head`
 * for the gallery/catalog popovers, `folder-menu-head` for the Projects view-opts menu.
 */
export function themeSegmentHtml(headClass = 'filter-pop-head'): string {
  const cur = currentTheme();
  return `<p class="${headClass}">Theme</p>
      <div class="view-seg" role="group" aria-label="Theme">
        ${THEMES.map(t => `<button type="button" class="view-seg-btn" data-theme-seg="${t}" aria-pressed="${t === cur}">${THEME_LABELS[t]}</button>`).join('')}
      </div>`;
}

/**
 * Wire a themeSegmentHtml() block within `root`: each button applies + persists its theme
 * (profile is canonical; applyTheme mirrors to localStorage + updates the PWA chrome colour)
 * and flips the pressed state in place. stopPropagation keeps the host popover from treating
 * the click as a select/dismiss. Call once after the popover is in the DOM.
 */
export function wireThemeSegment(root: ParentNode, host: ThemeToggleHost): void {
  const btns = [...root.querySelectorAll<HTMLButtonElement>('[data-theme-seg]')];
  btns.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const theme = btn.dataset.themeSeg!;
      applyTheme(theme);
      playThemeSfx(theme);
      btns.forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      try {
        const profile = await host.profile.get();
        await host.profile.set({ ...profile, theme });
      } catch { /* preference save is best-effort */ }
    });
  });
}
