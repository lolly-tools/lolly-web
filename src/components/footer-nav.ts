// footer-nav.ts — the shared bottom nav bar used by the Tools gallery, Projects and
// Catalogue views: [Pro?] [Dashboard]  <search>  [Verify] [What?]. Kept in one place
// so the links, icons, labels and layout stay identical across every listing view
// (previously duplicated in gallery.ts / projects.ts, and missing entirely on the
// Catalogue). Each view supplies its own search-field markup + handler (the field's
// classes/behaviour differ), but the surrounding nav links are shared verbatim.
import { escape } from '../utils.ts';
import { t, docsHref } from '../i18n.ts';
import { icon } from '../lib/icons.ts';

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
  return `<div class="gallery-search-wrap">
    <div class="gallery-search-box">
      <span class="gallery-search-icon" aria-hidden="true">${NAV_ICONS.search}</span>
      <input class="${cls}" type="text" placeholder="${escape(opts.placeholder)}" autocomplete="off" spellcheck="false" aria-label="${escape(opts.ariaLabel)}"${value ? ` value="${escape(value)}"` : ''}>
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

/** The shared bottom bar: [Pro?] [Dashboard]  <search>  [Verify] [What?]. */
export function footerNav({ proEnabled, searchHtml, footerClass }: FooterNavOpts): string {
  return `
    <footer class="gallery-footer${footerClass ? ' ' + footerClass : ''}">
      ${proEnabled ? `<a href="#/pro" class="gallery-batch-link btn" aria-label="${escape(t('Open Batch mode — for power users'))}">${NAV_ICONS.zap}<span class="gallery-nav-label">${t('Pro')}</span></a>` : ''}
      <a href="#/d" class="gallery-nav-link btn" data-sfx="dashboard" aria-label="${escape(t('Dashboard — this device, the brand system & the full feature set'))}">${NAV_ICONS.dashboard}<span class="gallery-nav-label">${t('Dashboard')}</span></a>
      ${searchHtml}
      <a href="#/verify" class="gallery-nav-link gallery-nav-link--verify btn" data-sfx="verify" aria-label="${escape(t('Verify Content Credentials — check any file on-device'))}">${NAV_ICONS.shield}<span class="gallery-nav-label">${t('Verify')}</span></a>
      <a href="${escape(docsHref('index'))}" class="gallery-info-link btn" aria-label="${escape(t('What is Lolly? — about & help'))}">${NAV_ICONS.help}<span class="gallery-nav-label">${t('What?')}</span></a>
    </footer>`;
}
