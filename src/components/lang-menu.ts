// SPDX-License-Identifier: MPL-2.0
/**
 * Language switcher FAB — a bare 32×32 icon (no button chrome, unlike the
 * filter/history FABs) that sits in the gallery-topright cluster on Tools,
 * Catalog, and Projects. Clicking it behaves like the filter FAB: a body-mounted
 * popover menu listing every supported language, current one checked.
 *
 * langFabHtml() renders the trigger; attachLangMenu(trigger, host) wires it.
 * Mirrors profile-menu.ts's conventions (body-mounted popover positioned off the
 * trigger's rect, focus trap, Escape + outside-pointerdown + route-change close)
 * but — unlike that menu — is active at every viewport width, not folded behind
 * a mobile-only gate.
 */
import { LANGS, LANG_META, currentLang, switchLang, t, LANG_ICON_SVG } from '../i18n.ts';
import type { Lang, LangSwitchHost } from '../i18n.ts';
import { escape } from '../utils.ts';
import { trapFocus, type FocusTrap } from '../lib/focus-trap.ts';

// Route-change signals the web shell fires (see main.js) — any one dismisses an
// open menu so it never outlives the view that spawned it.
const NAV_EVENTS = ['hashchange', 'popstate', 'lolly:navigate'];

/** The trigger button markup — drop directly into a .gallery-topright cluster. */
export function langFabHtml(): string {
  return `<button type="button" class="lang-fab" aria-label="${escape(t('Language'))}" aria-haspopup="menu" aria-expanded="false" title="${escape(t('Language'))}">${LANG_ICON_SVG}</button>`;
}

export function attachLangMenu(triggerEl: HTMLElement | null, host: LangSwitchHost): () => void {
  if (!triggerEl) return () => {};
  const trigger = triggerEl; // const so closures see the narrowed (non-null) type

  let menu: HTMLDivElement | null = null;
  let items: HTMLButtonElement[] = [];
  let outside: ((e: PointerEvent) => void) | null = null;
  let trap: FocusTrap | null = null;

  function close(returnFocus = false): void {
    if (!menu) return;
    if (outside) document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', position);
    NAV_EVENTS.forEach(ev => window.removeEventListener(ev, onNavAway));
    outside = null;
    trap?.release();
    trap = null;
    menu.remove();
    menu = null;
    items = [];
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus();
  }

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
  const onNavAway = () => close();

  function position(): void {
    if (!menu) return;
    const r = trigger.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 8)}px`;
    menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }

  function rove(active: HTMLElement, focus = true): void {
    items.forEach(b => { b.tabIndex = b === active ? 0 : -1; });
    if (focus) active.focus();
  }

  function open(): void {
    if (menu) return;
    const active = currentLang();
    const el = document.createElement('div');
    menu = el;
    el.className = 'lang-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', escape(t('Language')));
    el.innerHTML = `<div class="lang-menu-list" role="none">${LANGS.map(code =>
      `<button type="button" class="lang-menu-item" role="menuitemradio" data-lang="${code}" aria-checked="${code === active}">${escape(LANG_META[code].nativeName)}</button>`,
    ).join('')}</div>`;
    document.body.appendChild(el);
    position();
    trigger.setAttribute('aria-expanded', 'true');

    items = [...el.querySelectorAll<HTMLButtonElement>('.lang-menu-item')];
    const checked = items.find(b => b.getAttribute('aria-checked') === 'true') ?? items[0]!;
    rove(checked, false);

    el.addEventListener('click', e => {
      const btn = (e.target as Element).closest<HTMLButtonElement>('[data-lang]');
      if (!btn) return;
      const next = btn.dataset.lang as Lang;
      close();
      void switchLang(host, next);
    });
    el.addEventListener('keydown', e => {
      if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      rove(items[(i + step + items.length) % items.length]!);
    });

    outside = (e) => { if (menu && !menu.contains(e.target as Node) && !trigger.contains(e.target as Node)) close(); };
    setTimeout(() => document.addEventListener('pointerdown', outside!), 0);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', position);
    NAV_EVENTS.forEach(ev => window.addEventListener(ev, onNavAway));
    trap = trapFocus(el, { initialFocus: checked });
  }

  const onClick = () => { menu ? close(true) : open(); };
  trigger.addEventListener('click', onClick);

  return () => { close(); trigger.removeEventListener('click', onClick); };
}
