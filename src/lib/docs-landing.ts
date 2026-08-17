// SPDX-License-Identifier: MPL-2.0
/**
 * Landing mode for the in-app documentation reader (#/docs/index) - plans/123.
 *
 * The built /info landing wraps its body in `<main class="docs-landing page-index">`
 * (docs/build.ts), which is the reader's second extraction marker beside `.docs-content`.
 * It is deliberately NOT a `.docs-content`: the article typography scoped to that class
 * (measure, section padding, `.docs-content h2` at (0,1,1)) would out-specify the
 * landing's class-only band rules and restyle every band.
 *
 * Two things the static page takes from its own <head> have to be supplied here,
 * because the reader imports neither:
 *
 *  1. THE BAND CSS. styles/parts/docs-landing.css is the ONE source both surfaces read
 *     (build.ts inlines it, this module injects it). Its selectors are bare class names
 *     (`.hero`, `.audience-tab`, `.btn`), so it is wrapped in `@scope (.docs-landing)`
 *     before it reaches the document: loose in the app shell, one `.btn` rule would
 *     repaint every button in the chrome. @scope only asks that the SUBJECT of a
 *     selector be in scope, so the file's `html[data-theme="dark"] .quicknav` ancestor
 *     rules keep working, its nested @media still apply, and @keyframes inside the
 *     block register globally as usual.
 *  2. THE REVEAL NEUTRALIZER. The file ships `.reveal{opacity:0;transform:...}` and the
 *     IntersectionObserver that adds `.visible` is a page script the reader strips by
 *     design, so without an override every band mounts invisible. The landing-mode
 *     rules ride in the SAME <style> tag, after the scoped block, so they beat it
 *     wherever the app's cascade layers place the reader's other sheets.
 *
 * The audience strip needs nothing from this module since plan 123 D1 (2026-08-17):
 * it is anchor pills over stacked, always-open cards on both surfaces, and the
 * reader's own in-page anchor handler already intercepts a pill's `#id` jump.
 *
 * Nothing here registers a document- or window-level listener: every listener sits on a
 * node inside the rehosted fragment, which the reader drops on unmount, so landing mode
 * needs no teardown. The injected <style> is a module singleton that outlives the view
 * on purpose - its rules can only match inside a `.docs-landing`, so it costs nothing
 * once the reader has moved on.
 */
import { toAppHref } from './docs-nav.ts';
import landingCss from '../styles/parts/docs-landing.css?raw';

/** Marks the singleton <style> so a second landing mount reuses it. */
const STYLE_MARK = 'data-docs-landing';

/**
 * The element defaults the fragment assumes from the static page's global CSS, which the
 * reader does not import. Only the one that fails LOUDLY is carried: every inline icon in
 * the fragment ships a viewBox and no width/height, so with no rule at all each one
 * balloons to the CSS default 300x150 (or stretches to fill its flex parent). It sits
 * INSIDE the scope block and at the lowest possible specificity (0,0,1), so all 19 of the
 * file's own `.x svg{...}` sizing rules still win.
 */
const ELEMENT_BASELINE = 'svg{width:1em;height:1em;flex:none}';

/**
 * Landing-mode overrides. Unscoped and last in the tag, keyed off the reader's
 * `docs-reader--landing` modifier, which sits on an ancestor of the fragment:
 *   - the reveal neutralizer (see the file header, point 2);
 *   - the sticky in-page quicknav, which is inside the fragment and duplicates the
 *     reader's own navigation. Landing mode hides the TOC slot as well, so the page
 *     carries exactly one jump-nav: none.
 * Both are (0,2,0), so they beat the scoped `.reveal` / `.quicknav` rules (0,1,0) and the
 * `html[data-theme="dark"] .quicknav` one (0,1,1) on specificity alone.
 */
const LANDING_MODE_CSS = `
.docs-reader--landing .reveal,
.docs-reader--landing .reveal.visible { opacity: 1; transform: none; transition: none; }
.docs-reader--landing .quicknav { display: none; }
`;

/**
 * Inject the scoped landing stylesheet once per session. Idempotent: a second call (a
 * remount, or a second reader instance) finds the tag and returns.
 */
export function ensureLandingStyles(): void {
  if (document.head.querySelector(`style[${STYLE_MARK}]`)) return;
  // The `?raw` import is a string under Vite. Under the node:test CSS stub it is
  // undefined (tests/css-stub-hooks.mjs), which must degrade to an empty scope block
  // rather than the text "undefined" in a stylesheet.
  const source = typeof landingCss === 'string' ? landingCss : '';
  const el = document.createElement('style');
  el.setAttribute(STYLE_MARK, '');
  el.textContent = `@scope (.docs-landing) {\n${ELEMENT_BASELINE}\n${source}\n}\n${LANDING_MODE_CSS}`;
  document.head.appendChild(el);
}

/**
 * Point the fragment's app links back into THIS app instance (decision D3 in plans/123).
 * The built page links out to the deployed app - `/#/tool/qr-code?...` in English,
 * `/?lang=de#/tool/...` in a locale - and each of those is a full page load that would
 * drop the reader, the music and the a11y prefs on the floor. Rewritten to the bare
 * `#/...` route they stay in the SPA. The app-root links (the hero mark and both "Launch
 * App" buttons) land on the dashboard: you are already in the app, so the honest target
 * is your own workspace, not a reload of it. Labels and copy are untouched.
 *
 * Doc links (`/info/<slug>.html`) are NOT this function's business - views/docs.ts runs
 * rewriteDocLinks over the same fragment for those.
 */
export function adaptLandingLinks(root: ParentNode): void {
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const app = toAppHref(a.getAttribute('href') || '');
    if (app) a.setAttribute('href', app);
  });
}

