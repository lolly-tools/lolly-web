// SPDX-License-Identifier: MPL-2.0
/**
 * In-app documentation reader (#/docs/<slug>) - plan "this-is-a-very-sparkling-eich"
 * M2, Phase 1 (reader only; no narration/Listen player - that is a later phase).
 *
 * This brings the /info docs INTO the app so they render inside #view and inherit the
 * ACTIVE brand's design tokens (unlike the published static site, which is neutral for
 * anonymous/SEO). It is a routed utility view like #/ask or the Colour Lab: the shared
 * back pill, a home + theme cluster, and its own scroll.
 *
 * CONTENT SOURCE - "fragment rehost" (the plan's recommended path). Rather than
 * client-rendering markdown (which would need localized `.md` twins the build doesn't
 * yet emit), it fetches the built per-locale page `/info/<lang>/<slug>.html` (English is
 * unprefixed, `/info/<slug>.html` - exactly docsHref/docsInfoHref), extracts the tested
 * `.docs-content` fragment with DOMParser (or `.docs-landing` on the front door, see
 * LANDING MODE below and lib/docs-landing.ts), and injects it into #view. That reuses the
 * exact static-build output, works for all 27 locales for free, shows the committed
 * neutral signed screenshots as <img>, and picks up the active brand purely via CSS
 * (styles/parts/docs.css's scoped legacy-var bridge → the app's brand-reactive slots).
 *
 * Deliberately NOT carried across from the fetched page:
 *   - <script> and <style> nodes (never execute a fetched page's scripts; the only inner
 *     <style> today is the Listen-bar's, and stripping all of them keeps a page's CSS
 *     from leaking into the shell). The reader's own styling lives in docs.css.
 *   - the `.listen-bar` (Phase 1 has no narration player).
 *   - the masthead / nav / sidebar / footer (all live OUTSIDE `.docs-content`, so the
 *     fragment naturally excludes them). Theme/brand-reactive mastheads are M3.
 *
 * LANDING MODE (#/docs/index, plans/123). The /info front door is a docs page like any
 * other now: `slug === 'index'` fetches /info/index.html, rehosts its `.docs-landing`
 * body, and adds `docs-reader--landing` to the reader shell (one full-width column, no
 * sidebar, no table of contents). What the landing needs beyond a plain rehost - the
 * scoped band stylesheet, the scroll-reveal neutralizer, the in-SPA link rewrites -
 * lives in lib/docs-landing.ts. This view used to alias 'index' to the Quickstart
 * page, because the landing shipped no rehostable fragment.
 */
import '../styles/parts/docs.css';
import { escape } from '../utils.ts';
import { t, tRaw, currentLang, normalizeLang, docsInfoHref, type Lang } from '../i18n.ts';
import { armViewEnter } from '../view-enter.ts';
import { backPillHtml, mountBackPill } from '../components/back-pill.ts';
import { createThemeToggle } from '../components/theme-toggle.ts';
import { homeFabHtml, mountHomeFab } from '../components/home-fab.ts';
import { registerNarrationSource, unregisterNarrationSource } from '../lib/audio-dock-singleton.ts';
import { createDocsNarrationHost, type DocsNarrationHandle } from '../lib/docs-narration-host.ts';
import { hydrateDocsTryIt } from '../lib/docs-tryit.ts';
import { enhanceDocsFormats } from '../lib/docs-formats.ts';
import { ensureLandingStyles, adaptLandingLinks } from '../lib/docs-landing.ts';
import {
  rewriteDocLinks,
  extractSidebar,
  extractSitemap,
  extractPathways,
  buildToc,
} from '../lib/docs-nav.ts';
import type { HostV1 } from '@lolly-tools/core/host-v1';

/** The reader drives the theme toggle + home fab; HostV1 covers both. */
type DocsHost = HostV1;

/** The chrome + navigation shell the fragment (or a status message) drops into.
 *  `inner` seeds the content column; the pathways / sidebar / TOC / sitemap slots
 *  start empty + hidden and are filled from the fetched page once it parses (each a
 *  graceful no-op if that page lacks the landmark). The scaffold is fixed class markup
 *  + component HTML + t() labels only - no free/user text reaches this sink. */
function shellHtml(inner: string): string {
  return `
    ${backPillHtml()}
    <div class="docs-topright" data-topright>
      ${homeFabHtml({ className: 'docs-top-btn' })}
    </div>
    <div class="docs-reader" data-reader>
      <div class="docs-pathways-slot" data-pathways hidden></div>
      <div class="docs-reader-grid">
        <div class="docs-sidebar-slot" data-sidebar hidden></div>
        <div class="docs-content-col" data-content>${inner}</div>
        <div class="docs-toc-slot" data-toc hidden></div>
      </div>
      <div class="docs-sitemap-slot" data-sitemap hidden></div>
    </div>`;
}

export async function mountDocs(
  viewEl: HTMLElement,
  host: DocsHost,
  slug: string,
  routeLang: string | null,
  params: string,
): Promise<void> {
  // Explicit route lang (#/docs/<lang>/<slug>) beats a ?lang= override beats the app's
  // current locale - the fetched page must match whatever language the app is showing.
  const lang: Lang =
    normalizeLang(routeLang) ?? normalizeLang(new URLSearchParams(params).get('lang')) ?? currentLang();

  // Deep link: a spotlight/Ask result, a rewritten in-page anchor, or a doc link whose
  // '#heading' was carried across as ?h= (a second '#' cannot ride a hash route).
  const deepLink = new URLSearchParams(params).get('h');

  // LANDING MODE (plans/123): #/docs/index is the front door, not a doc page. The built
  // /info landing marks its body `.docs-landing` rather than `.docs-content`, and the
  // reader answers with its own modifier class - one full-width column, no sidebar, no
  // table of contents, plus the band CSS and tab hydration lib/docs-landing.ts owns.
  const isLanding = slug === 'index';

  document.title = tRaw('{name} — Lolly', { name: t('Documentation') });

  // Paint the chrome + a pending state immediately, then swap in the body once fetched.
  viewEl.innerHTML = shellHtml(`<p class="docs-status">${t('Loading…')}</p>`);
  mountBackPill(viewEl);
  mountHomeFab(viewEl);
  viewEl.querySelector('[data-topright]')?.prepend(createThemeToggle(host, { className: 'docs-top-btn' }));
  if (isLanding) {
    // Both before the fetch, so the loading state already sits in the landing's own
    // single-column shell and the band CSS is parsed by the time the fragment lands.
    viewEl.querySelector('[data-reader]')?.classList.add('docs-reader--landing');
    ensureLandingStyles();
  }

  const contentEl = viewEl.querySelector<HTMLElement>('[data-content]')!;
  const url = docsInfoHref(slug, lang);

  const showStatus = (message: string, extra = ''): void => {
    contentEl.innerHTML = `<p class="docs-status">${escape(message)}${extra}</p>`;
  };

  let html: string;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!viewEl.isConnected) return;
    if (!res.ok) {
      // 404 etc. - a real message, plus the static page as an escape hatch.
      showStatus(
        t('That documentation page could not be found.'),
        ` <a href="${escape(url)}" target="_blank" rel="noopener">${t('Open the docs')}</a>`,
      );
      return;
    }
    html = await res.text();
  } catch {
    if (!viewEl.isConnected) return;
    showStatus(
      t('Could not load the documentation. Check your connection and try again.'),
      ` <a href="${escape(url)}" target="_blank" rel="noopener">${t('Open the docs')}</a>`,
    );
    return;
  }
  if (!viewEl.isConnected) return;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Two extraction markers: `.docs-content` on every doc page, `.docs-landing` on the
  // front door. The landing is kept out of `.docs-content` on purpose (see
  // lib/docs-landing.ts); everything below treats the two the same way.
  const fragment = doc.querySelector('.docs-content, .docs-landing');
  if (!fragment) {
    showStatus(
      t('That documentation page could not be displayed.'),
      ` <a href="${escape(url)}" target="_blank" rel="noopener">${t('Open the docs')}</a>`,
    );
    return;
  }

  // Title from the fetched page (falls back to the slug) - for the tab and history entry.
  // The landing keeps the reader's own "Documentation" title: its <title> is the site
  // sentence ("Lolly - assets that stay the same so everything else can change"), which
  // the suffix strip cannot shorten and which reads as a marketing line in a tab strip.
  const pageTitle = (doc.querySelector('title')?.textContent || '').replace(/\s*[—-]\s*Lolly\s*$/, '').trim();
  if (pageTitle && !isLanding) document.title = tRaw('{name} — Lolly', { name: pageTitle });

  // The formats page's detail-dialog data rides in an inert `<script type=
  // "application/json">`, which the strip below removes with every other script -
  // so read it out FIRST and hand it to the enhancer after mount (the reader's
  // "no fetched scripts survive" invariant stays intact). Null on any other page.
  const fmtCatalogRaw = fragment.querySelector('#fmt-catalog-data')?.textContent ?? null;

  // Sanitise: never run a fetched page's scripts, and drop the Listen bar (the dock owns
  // narration now). KEEP <style>: the only style nodes inside `.docs-content` are a figure's
  // OWN scoped block (e.g. `.cmp-fig` for the comparison matrix) - the page-global CSS lives
  // in <head>, which we never extract. Those blocks also DEFINE the figure's local tokens
  // (`--cmp-*`), so stripping them left figures unstyled and their headings mashed. This is
  // our own trusted, brand-scoped build output, not arbitrary fetched markup.
  fragment.querySelectorAll('script, .listen-bar').forEach((el) => el.remove());

  // Rewrite internal doc links to the in-app reader so navigation stays in the SPA.
  rewriteDocLinks(fragment);

  // Adopt the fragment into this document and mount it. `.docs-content` is a <main> in the
  // built page, but #view is ALREADY <main id="view"> - a nested/second <main> is an
  // invalid, duplicate landmark - so rehost its guts in an <article> (valid inside <main>,
  // and the right role for a doc page), keeping the `docs-content page-<slug>` classes so
  // docs.css applies. importNode(true) deep-clones across the parsed document.
  const imported = document.importNode(fragment, true) as HTMLElement;
  const node = document.createElement('article');
  node.className = imported.className;
  node.replaceChildren(...Array.from(imported.childNodes));
  contentEl.replaceChildren(node);

  // Scroll a heading (by fragment id) into view within #view. Returns whether the
  // heading exists, so a click handler can preventDefault only when it will act.
  // A target inside a closed <details> is opened first, all the way up the chain: the
  // landing's FAQ is a list of `details.faq-item` (the static page runs its own opener
  // script for the same reason), and any doc page's disclosure block gets the same
  // treatment. Scrolling to a hidden answer would land on the summary and look broken.
  const scrollToHeading = (id: string, behavior: ScrollBehavior): boolean => {
    const target = id ? node.querySelector(`#${CSS.escape(id)}`) : null;
    if (!target) return false;
    for (
      let d = target.closest('details');
      d && node.contains(d);
      d = d.parentElement?.closest('details') ?? null
    ) {
      d.open = true;
    }
    try { target.scrollIntoView({ behavior, block: 'start' }); } catch { /* jsdom has no layout */ }
    return true;
  };

  // In-page anchors (`#heading-id`) must NOT set location.hash - that IS the SPA route,
  // so a bare `#foo` would navigate away. Intercept plain clicks and scroll within #view.
  const onAnchorClick = (e: MouseEvent): void => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
    if (!a) return;
    const raw = a.getAttribute('href') || '';
    if (!raw.startsWith('#') || raw.startsWith('#/')) return; // leave real routes alone
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button > 0) return;
    if (!scrollToHeading(decodeURIComponent(raw.slice(1)), 'smooth')) return;
    e.preventDefault();
  };
  node.addEventListener('click', onAnchorClick as EventListener);

  // ── Navigation: cross-doc (pathways / sidebar / footer sitemap) + in-page (TOC) ──
  // The fetched page's real nav lives OUTSIDE .docs-content, so the reader used to throw
  // it away and strand you on one page. Pull each landmark out of `doc` and fill its slot
  // (links already rewritten to #/docs/… by the extractors); the TOC is DERIVED from the
  // rehosted content's stamped heading ids. Every fill is a graceful no-op when absent.
  const fillSlot = (sel: string, el: HTMLElement | null): void => {
    if (!el) return;
    const slot = viewEl.querySelector<HTMLElement>(sel);
    if (!slot) return;
    slot.replaceChildren(el);
    slot.hidden = false;
  };
  fillSlot('[data-pathways]', extractPathways(doc));
  fillSlot('[data-sidebar]', extractSidebar(doc));
  fillSlot('[data-sitemap]', extractSitemap(doc));
  // The landing gets no table of contents: its own sticky quicknav already jumps between
  // bands (hidden in landing mode), and the bands are sections of a front door rather
  // than headings of an article. Its pathways + sitemap slots fill as on any page; it
  // ships no `.docs-sidebar`, so that slot stays hidden on its own.
  const toc = isLanding ? null : buildToc(node);
  if (toc) {
    const tocSlot = viewEl.querySelector<HTMLElement>('[data-toc]');
    if (tocSlot) {
      tocSlot.replaceChildren(toc.el);
      tocSlot.hidden = false;
      // TOC links (`#<id>` + data-toc-target) scroll within the reader, never the route.
      toc.el.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-toc-target]');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button > 0) return;
        if (scrollToHeading(a.dataset.tocTarget || '', 'smooth')) e.preventDefault();
      });
    }
  }

  // ── M3: interactive "Try it" embeds (progressive enhancement) ─────────────────
  // ADDITIVE: turn the static, C2PA-signed tool screenshots into live affordances under
  // the ACTIVE brand. Each shot whose capture recipe is a live TOOL render (recovered
  // from /info/docs-render-manifest.json, keyed by shot slug) gets a keyboard-accessible
  // "Try it" overlay that opens the tool in-app, plus an opt-in in-place live embed. The
  // signed <img> stays as the baseline; non-tool (view/gallery) shots and a missing
  // manifest are silent no-ops. Fire-and-forget - it fetches the manifest and never
  // throws. See lib/docs-tryit.ts.
  void hydrateDocsTryIt(node);

  // Formats page: re-wire the three-zone table's chips to the detail dialog the
  // static site opens on click (lib/docs-formats.ts). No-op on every other page.
  enhanceDocsFormats(node, fmtCatalogRaw);

  // Landing mode: adapt the front door's outward app links to in-SPA routes
  // (lib/docs-landing.ts). The audience strip needs no hydration since plan 123 D1 -
  // its pills are plain #id jump links the anchor handler above already intercepts,
  // and every card is open on both surfaces.
  if (isLanding) adaptLandingLinks(node);

  // Deep-link: a spotlight/Ask docs result routes here as #/docs/<slug>?h=<anchor>
  // (the section heading rides a ?h= query param, since a second '#' can't ride the
  // hash route). Scroll that heading into view now that the fragment is in the DOM -
  // a no-op when absent or the id isn't on the page.
  if (deepLink) scrollToHeading(deepLink, 'auto');

  // ── Narration "Listen" dock (unified audio-dock migration, Phase 2a) ──────────
  // ADDITIVE: the reader had no player. Content-gated - mounted ONLY when this slug
  // has committed narration audio in /info/audio-index.json, AND only on the English
  // reader page (all committed audio is English, and the follow-along block map is
  // re-derived from the English markdown twin). No track / non-English → no narration (the
  // "no dead affordance" rule). Registers into the app-global SINGLETON audio dock (shared
  // with the music player) as the narration BLOCK; unregistered on unmount.
  let narration: DocsNarrationHandle | null = null;
  if (lang === 'en') {
    try {
      narration = await createDocsNarrationHost({ slug, contentRoot: node, title: pageTitle || slug });
    } catch {
      narration = null;
    }
    if (narration) {
      if (!viewEl.isConnected) {
        // The reader unmounted while the track was resolving - never leave audio behind.
        narration.destroy();
        narration = null;
      } else {
        // The narration host is a valid DockNarrationPlayer (transport + narration adapter).
        registerNarrationSource(narration.host);
      }
    }
  }

  armViewEnter(viewEl, '.docs-content, .docs-landing');

  (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
    node.removeEventListener('click', onAnchorClick as EventListener);
    // Order: detach the narration block from the shared window (the window stays if music
    // is still registered) before dropping the host (stops audio, removes the <audio> tap).
    unregisterNarrationSource();
    narration?.destroy();
  };
}
