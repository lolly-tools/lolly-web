// footer-nav.ts — the shared bottom nav bar used by the Tools gallery, Projects and
// Catalogue views: [Pro?] [Dashboard]  <search>  [Verify] [What?]. Kept in one place
// so the links, icons, labels and layout stay identical across every listing view
// (previously duplicated in gallery.ts / projects.ts, and missing entirely on the
// Catalogue). Each view supplies its own search-field markup + handler (the field's
// classes/behaviour differ), but the surrounding nav links are shared verbatim.
import { escape } from '../utils.ts';
import { t, docsHref } from '../i18n.ts';

/** The nav-bar glyphs (Lucide house style), shared so all three footers match. */
export const NAV_ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
} as const;

/** The standard `.gallery-search` field (Tools gallery + Catalogue use it verbatim). */
export function gallerySearchBox(opts: { placeholder: string; ariaLabel: string; value?: string; className?: string }): string {
  const cls = opts.className ?? 'gallery-search';
  return `<div class="gallery-search-wrap">
    <div class="gallery-search-box">
      <span class="gallery-search-icon" aria-hidden="true">${NAV_ICONS.search}</span>
      <input class="${cls}" type="search" placeholder="${escape(opts.placeholder)}" autocomplete="off" spellcheck="false" aria-label="${escape(opts.ariaLabel)}"${opts.value ? ` value="${escape(opts.value)}"` : ''}>
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
