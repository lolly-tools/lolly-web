// footer-nav.ts — the shared bottom nav bar used by the Tools gallery, Projects and
// Catalogue views: [Pro?] [Dashboard]  <search>  [Verify] [What?]. Kept in one place
// so the links, icons, labels and layout stay identical across every listing view
// (previously duplicated in gallery.ts / projects.ts, and missing entirely on the
// Catalogue). Each view supplies its own search-field markup + handler (the field's
// classes/behaviour differ), but the surrounding nav links are shared verbatim.
import { escape } from '../utils.ts';
import { t, docsHref } from '../i18n.ts';
import { icon } from '../lib/icons.ts';
import { jellyActive } from '../lib/jelly.ts';

/** The nav-bar glyphs (Lucide house style), shared so all three footers match.
 *  Path data lives in lib/icons.ts — .shield is 'shieldCheck' there, deduped
 *  against profile.ts's identical VERIFY_SHIELD (component-audit rec 5). */
export const NAV_ICONS = {
  search: icon('search'),
  shield: icon('shieldCheck'),
  zap: icon('zap'),
  help: icon('help'),
  dashboard: icon('dashboard'),
} as const;

/** The standard `.gallery-search` field + its ✕ clear button (Tools gallery + Catalogue
 *  use it verbatim, component-audit rec 11 — previously the gallery minted its own
 *  `.gallery-search-clear` with inline JS styles while the catalog borrowed projects'
 *  `.projects-search-clear`). `type="text"` (not "search") so the browser's own native
 *  cancel button doesn't double up with ours. The ✕ starts `hidden` unless `value` is
 *  already non-empty (a restored query) — each view toggles the `hidden` attribute as
 *  the field's content changes. */
export function gallerySearchBox(opts: { placeholder: string; ariaLabel: string; value?: string; className?: string; clearLabel?: string }): string {
  const cls = opts.className ?? 'gallery-search';
  const value = opts.value ?? '';
  // Jelly effects mode swaps the native field for a <jelly-input>. Every caller
  // keeps working untouched: they query by the same class, `.value` is a live
  // getter/setter on the host, and the inner field's `input`/keydown events are
  // composed so host-bound listeners fire as before. The icon + ✕ still overlay
  // the field (they need z-index above the jelly canvas — footer-nav.css).
  const field = jellyActive()
    // The inline padding-inline var is load-bearing: it insets the shadow
    // field's text clear of the overlaid magnifier/✕. It must be INLINE — the
    // lib/jelly.ts bridge sheet is unlayered and sets a chrome-wide
    // --jelly-input-padding-inline, and unlayered rules beat any @layer views
    // stylesheet rule regardless of specificity; only an inline style outranks it.
    ? `<jelly-input class="${cls}" style="--jelly-input-padding-inline:2.1rem" type="text" placeholder="${escape(opts.placeholder)}" autocomplete="off" label="${escape(opts.ariaLabel)}"${value ? ` value="${escape(value)}"` : ''}></jelly-input>`
    : `<input class="${cls}" type="text" placeholder="${escape(opts.placeholder)}" autocomplete="off" spellcheck="false" aria-label="${escape(opts.ariaLabel)}"${value ? ` value="${escape(value)}"` : ''}>`;
  return `<div class="gallery-search-wrap${jellyActive() ? ' gallery-search-wrap--jelly' : ''}">
    <div class="gallery-search-box">
      <span class="gallery-search-icon" aria-hidden="true">${NAV_ICONS.search}</span>
      ${field}
      <button type="button" class="gallery-search-clear" data-search-clear aria-label="${escape(opts.clearLabel ?? t('Clear search'))}"${value ? '' : ' hidden'}>✕</button>
    </div>
  </div>`;
}

export interface FooterNavOpts {
  /** Pro link only shows when Batch mode is enabled (flagEnabled(profile, PRO_FLAG.id)). */
  proEnabled: boolean;
  /** The middle search field — e.g. gallerySearchBox(...) or a view's custom box. */
  searchHtml: string;
  /** Extra class(es) on the <footer> (e.g. 'projects-footer'). */
  footerClass?: string;
}

// Jelly nav items are <jelly-button>s (the component is a real <button>, not a
// link), so they navigate on click here. Composed shadow clicks retarget to the
// host; a modifier click opens a new tab so the "open in new tab" affordance of
// the <a>s they replace is preserved. Installed once, on the first jelly render.
let navHandlerInstalled = false;
function ensureNavHandler(): void {
  if (navHandlerInstalled || typeof document === 'undefined') return;
  navHandlerInstalled = true;
  document.addEventListener('click', (e: MouseEvent) => {
    const host = e.target instanceof Element ? e.target.closest<HTMLElement>('jelly-button[data-href]') : null;
    const href = host?.getAttribute('data-href');
    if (!href) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) window.open(href, '_blank', 'noopener');
    else location.assign(href);
  });
}

/** One footer nav item — the plain `.btn` link, or its soft-body <jelly-button>
 *  stand-in (data-href → the click handler above) when the jelly flag is on. */
function navItem(o: { href: string; nativeClass: string; variant?: string; style?: string; sfx?: string; aria: string; inner: string }): string {
  const sfxAttr = o.sfx ? ` data-sfx="${o.sfx}"` : '';
  if (jellyActive()) {
    // Only the layout class `gallery-nav-jelly` rides on the host — NOT `.btn` /
    // `.gallery-nav-link` (their `.gallery-footer > .btn` display/flex rules would
    // fight the jelly host box). `size="sm"` gives compact padding; the visible
    // .gallery-nav-label span keeps its class so the mobile label-hide still works.
    return `<jelly-button class="gallery-nav-jelly" size="sm"${o.variant ? ` variant="${o.variant}"` : ''}${o.style ?? ''} data-href="${escape(o.href)}"${sfxAttr} aria-label="${escape(o.aria)}">${o.inner}</jelly-button>`;
  }
  return `<a href="${escape(o.href)}" class="${o.nativeClass}"${sfxAttr} aria-label="${escape(o.aria)}">${o.inner}</a>`;
}

/** The shared bottom bar: [Pro?] [Dashboard]  <search>  [Verify] [What?]. */
export function footerNav({ proEnabled, searchHtml, footerClass }: FooterNavOpts): string {
  if (jellyActive()) ensureNavHandler();
  const label = (txt: string) => `<span class="gallery-nav-label">${txt}</span>`;
  const pro = proEnabled ? navItem({
    href: '#/pro', nativeClass: 'gallery-batch-link btn', variant: 'platinum',
    aria: t('Open Batch mode — for power users'), inner: `${NAV_ICONS.zap}${label(t('Pro'))}`,
  }) : '';
  const dashboard = navItem({
    href: '#/d', nativeClass: 'gallery-nav-link btn', variant: 'platinum', sfx: 'dashboard',
    aria: t('Dashboard — this device, the brand system & the full feature set'), inner: `${NAV_ICONS.dashboard}${label(t('Dashboard'))}`,
  });
  // Verify keeps its solid SUSE Pine Green pill (explicit green in every theme,
  // matching the native rule) via an inline --jelly-fill / --jelly-label.
  const verify = navItem({
    href: '#/verify', nativeClass: 'gallery-nav-link gallery-nav-link--verify btn', sfx: 'verify',
    style: ' style="--jelly-fill:hsl(151 57% 42%);--jelly-label:#fff"',
    aria: t('Verify Content Credentials — check any file on-device'), inner: `${NAV_ICONS.shield}${label(t('Verify'))}`,
  });
  const whatIs = navItem({
    href: docsHref('index'), nativeClass: 'gallery-info-link btn', variant: 'platinum',
    aria: t('What is Lolly? — about & help'), inner: `${NAV_ICONS.help}${label(t('What?'))}`,
  });
  return `
    <footer class="gallery-footer${footerClass ? ' ' + footerClass : ''}">
      ${pro}
      ${dashboard}
      ${searchHtml}
      ${verify}
      ${whatIs}
    </footer>`;
}
