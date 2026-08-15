// SPDX-License-Identifier: MPL-2.0
/**
 * In-app documentation reader (#/docs/<slug>) — plan "this-is-a-very-sparkling-eich"
 * M2, Phase 1 (reader only; no narration/Listen player — that is a later phase).
 *
 * This brings the /info docs INTO the app so they render inside #view and inherit the
 * ACTIVE brand's design tokens (unlike the published static site, which is neutral for
 * anonymous/SEO). It is a routed utility view like #/ask or the Colour Lab: the shared
 * back pill, a home + theme cluster, and its own scroll.
 *
 * CONTENT SOURCE — "fragment rehost" (the plan's recommended path). Rather than
 * client-rendering markdown (which would need localized `.md` twins the build doesn't
 * yet emit), it fetches the built per-locale page `/info/<lang>/<slug>.html` (English is
 * unprefixed, `/info/<slug>.html` — exactly docsHref/docsInfoHref), extracts the tested
 * `.docs-content` fragment with DOMParser, and injects it into #view. That reuses the
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
import type { HostV1 } from '@lolly-tools/core/host-v1';

/** The reader drives the theme toggle + home fab; HostV1 covers both. */
type DocsHost = HostV1;

/** Rewrite an in-fragment `/info/<lang>/<slug>.html` link to the in-app reader route
 *  `#/docs/<slug>`, so internal navigation stays in the SPA (music keeps playing, no
 *  full page reload) rather than leaving to the static site. Any lang prefix is dropped
 *  — the reader already runs in the app's current locale — and a trailing #anchor/?query
 *  is dropped (a second '#' can't ride a hash route). Non-.html /info links (signed
 *  screenshots, downloads) and app links (`/#/…`) are left untouched. Returns null for a
 *  link this rule does not own. */
function toReaderHref(href: string): string | null {
  const m = /^\/info\/(?:[a-z][a-z-]*\/)?([^/]+?)\.html(?:[#?].*)?$/.exec(href);
  return m ? `#/docs/${m[1]}` : null;
}

/** The chrome-only shell the fragment (or a status message) drops into. */
function shellHtml(inner: string): string {
  return `
    ${backPillHtml()}
    <div class="docs-topright" data-topright>
      ${homeFabHtml({ className: 'docs-top-btn' })}
    </div>
    <div class="docs-reader" data-reader>${inner}</div>`;
}

export async function mountDocs(
  viewEl: HTMLElement,
  host: DocsHost,
  slug: string,
  routeLang: string | null,
  params: string,
): Promise<void> {
  // Explicit route lang (#/docs/<lang>/<slug>) beats a ?lang= override beats the app's
  // current locale — the fetched page must match whatever language the app is showing.
  const lang: Lang =
    normalizeLang(routeLang) ?? normalizeLang(new URLSearchParams(params).get('lang')) ?? currentLang();

  document.title = tRaw('{name} — Lolly', { name: t('Documentation') });

  // Paint the chrome + a pending state immediately, then swap in the body once fetched.
  viewEl.innerHTML = shellHtml(`<p class="docs-status">${t('Loading…')}</p>`);
  mountBackPill(viewEl);
  mountHomeFab(viewEl);
  viewEl.querySelector('[data-topright]')?.prepend(createThemeToggle(host, { className: 'docs-top-btn' }));

  const readerEl = viewEl.querySelector<HTMLElement>('[data-reader]')!;
  const url = docsInfoHref(slug, lang);

  const showStatus = (message: string, extra = ''): void => {
    readerEl.innerHTML = `<p class="docs-status">${escape(message)}${extra}</p>`;
  };

  let html: string;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!viewEl.isConnected) return;
    if (!res.ok) {
      // 404 etc. — a real message, plus the static page as an escape hatch.
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
  const fragment = doc.querySelector('.docs-content');
  if (!fragment) {
    showStatus(
      t('That documentation page could not be displayed.'),
      ` <a href="${escape(url)}" target="_blank" rel="noopener">${t('Open the docs')}</a>`,
    );
    return;
  }

  // Title from the fetched page (falls back to the slug) — for the tab and history entry.
  const pageTitle = (doc.querySelector('title')?.textContent || '').replace(/\s*[—-]\s*Lolly\s*$/, '').trim();
  if (pageTitle) document.title = tRaw('{name} — Lolly', { name: pageTitle });

  // Sanitise: never run a fetched page's scripts, drop its <style> (own styling comes
  // from docs.css), and drop the Listen bar (no narration player in Phase 1).
  fragment.querySelectorAll('script, style, .listen-bar').forEach((el) => el.remove());

  // Rewrite internal doc links to the in-app reader so navigation stays in the SPA.
  fragment.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const reader = toReaderHref(a.getAttribute('href') || '');
    if (reader) a.setAttribute('href', reader);
  });

  // Adopt the fragment into this document and mount it. `.docs-content` is a <main> in the
  // built page, but #view is ALREADY <main id="view"> — a nested/second <main> is an
  // invalid, duplicate landmark — so rehost its guts in an <article> (valid inside <main>,
  // and the right role for a doc page), keeping the `docs-content page-<slug>` classes so
  // docs.css applies. importNode(true) deep-clones across the parsed document.
  const imported = document.importNode(fragment, true) as HTMLElement;
  const node = document.createElement('article');
  node.className = imported.className;
  node.replaceChildren(...Array.from(imported.childNodes));
  readerEl.replaceChildren(node);

  // Scroll a heading (by fragment id) into view within #view. Returns whether the
  // heading exists, so a click handler can preventDefault only when it will act.
  const scrollToHeading = (id: string, behavior: ScrollBehavior): boolean => {
    const target = id ? node.querySelector(`#${CSS.escape(id)}`) : null;
    if (!target) return false;
    try { target.scrollIntoView({ behavior, block: 'start' }); } catch { /* jsdom has no layout */ }
    return true;
  };

  // In-page anchors (`#heading-id`) must NOT set location.hash — that IS the SPA route,
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

  // ── M3: interactive "Try it" embeds (progressive enhancement) ─────────────────
  // ADDITIVE: turn the static, C2PA-signed tool screenshots into live affordances under
  // the ACTIVE brand. Each shot whose capture recipe is a live TOOL render (recovered
  // from /info/docs-render-manifest.json, keyed by shot slug) gets a keyboard-accessible
  // "Try it" overlay that opens the tool in-app, plus an opt-in in-place live embed. The
  // signed <img> stays as the baseline; non-tool (view/gallery) shots and a missing
  // manifest are silent no-ops. Fire-and-forget — it fetches the manifest and never
  // throws. See lib/docs-tryit.ts.
  void hydrateDocsTryIt(node);

  // Deep-link: a spotlight/Ask docs result routes here as #/docs/<slug>?h=<anchor>
  // (the section heading rides a ?h= query param, since a second '#' can't ride the
  // hash route). Scroll that heading into view now that the fragment is in the DOM —
  // a no-op when absent or the id isn't on the page.
  const initialHeading = new URLSearchParams(params).get('h');
  if (initialHeading) scrollToHeading(initialHeading, 'auto');

  // ── Narration "Listen" dock (unified audio-dock migration, Phase 2a) ──────────
  // ADDITIVE: the reader had no player. Content-gated — mounted ONLY when this slug
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
        // The reader unmounted while the track was resolving — never leave audio behind.
        narration.destroy();
        narration = null;
      } else {
        // The narration host is a valid DockNarrationPlayer (transport + narration adapter).
        registerNarrationSource(narration.host);
      }
    }
  }

  armViewEnter(viewEl, '.docs-content');

  (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
    node.removeEventListener('click', onAnchorClick as EventListener);
    // Order: detach the narration block from the shared window (the window stays if music
    // is still registered) before dropping the host (stops audio, removes the <audio> tap).
    unregisterNarrationSource();
    narration?.destroy();
  };
}
