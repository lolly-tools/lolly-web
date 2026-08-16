// SPDX-License-Identifier: MPL-2.0
/**
 * In-app documentation reader (views/docs.ts) - the fragment-rehost mount path.
 *
 * Run directly:
 *   node --import ./tests/css-stub.mjs --test shells/web/src/views/docs.test.ts
 *
 * docs.ts imports a CSS module (../styles/parts/docs.css), so the run MUST use the
 * --import ./tests/css-stub.mjs hook or Node throws ERR_UNKNOWN_FILE_EXTENSION.
 *
 * What is covered: the reader fetches the built /info page, extracts its .docs-content,
 * rehosts the children into a fresh <article> inside [data-content], strips script +
 * .listen-bar while keeping <style>, rewrites internal doc links toward #/docs, fills the
 * pathways / sidebar / sitemap / TOC nav slots, honours a ?h= deep link, and renders a
 * .docs-status message on a 404 or a fetch throw.
 *
 * routeLang is always passed as 'de' (a non-English locale) so the English-only narration
 * block in mountDocs is skipped - that block reaches into the app-global audio dock, which
 * is out of scope for a hermetic reader test. With lang 'de' the fetch URL becomes
 * /info/de/<slug>.html, which the URL assertions check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// jsdom globals pinned onto globalThis BEFORE the dynamic import of the module under test -
// docs.ts and its import graph expect a browser realm (DOMParser, CSS.escape, localStorage).
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lolly.tools/#/docs/quickstart',
  pretendToBeVisual: true,
});
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
// jsdom does not ship window.CSS, so provide the one member docs.ts uses (CSS.escape in
// scrollToHeading). A minimal identifier escaper is enough for the plain heading ids here.
globalThis.CSS = (dom.window as unknown as { CSS?: typeof CSS }).CSS ?? ({
  escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
} as unknown as typeof CSS);
globalThis.localStorage = dom.window.localStorage; // currentTheme() reads localStorage
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;

const { mountDocs } = await import('./docs.ts');

// A minimal host - the reader only touches host.profile when the theme toggle is clicked,
// which no test does, so a get/set pair of no-ops is enough.
const host = {
  profile: { get: async () => ({}), set: async () => {} },
} as unknown as Parameters<typeof mountDocs>[1];

// A full /info page: a .docs-content main with headings, a script + .listen-bar + style to
// exercise sanitisation, and internal doc links to exercise link rewriting - plus the nav
// landmarks (pathways / sidebar / sitemap) that live OUTSIDE .docs-content.
const PAGE_HTML = `<!doctype html><html><head><title>Quickstart — Lolly</title></head>
<body>
  <nav class="nav-group">
    <a href="/info/for-creators.html">For Creators</a>
    <a class="active" href="/info/for-builders.html">For Builders</a>
  </nav>
  <aside class="docs-sidebar">
    <a href="/info/quickstart.html">Quickstart</a>
    <a href="/info/reference.html">Reference</a>
  </aside>
  <main class="docs-content page-quickstart">
    <h1 id="top">Quickstart</h1>
    <p>Intro paragraph with an <a href="/info/quickstart.html">internal link</a> and a
      deeper <a href="/info/reference.html#config">anchored link</a>.</p>
    <style>.cmp-fig{--cmp-a:1}</style>
    <div class="listen-bar">Listen player that must be stripped</div>
    <script>window.__docsShouldNeverRun = true;</script>
    <h2 id="one">Section One</h2>
    <p>Body one.</p>
    <h2 id="two">Section Two</h2>
    <p>Body two.</p>
    <h2 id="some-id">Deep Section</h2>
    <p>Body deep.</p>
  </main>
  <footer class="footer-sitemap">
    <a href="/info/quickstart.html">Quickstart</a>
  </footer>
</body></html>`;

/** A fresh, DOCUMENT-CONNECTED mount element. mountDocs bails after fetch when the view is
 *  not connected (viewEl.isConnected), so every mount target must be appended to the body. */
function freshView(): HTMLElement {
  const el = document.createElement('main');
  el.id = 'view';
  document.body.appendChild(el);
  return el;
}

let fetchUrls: string[] = [];

/** Stub fetch to serve PAGE_HTML for every request. All URLs are recorded (mountDocs fetches
 *  the page; the fire-and-forget Try-it hydration fetches a manifest), so assertions check
 *  membership rather than the single last URL. `json` returns {} so the manifest hydration is
 *  a clean no-op. */
function stubOkFetch(html = PAGE_HTML): void {
  fetchUrls = [];
  globalThis.fetch = (async (u: unknown) => {
    fetchUrls.push(String(u));
    return { ok: true, text: async () => html, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

test('mounts the .docs-content fragment into a fresh article inside [data-content]', async () => {
  stubOkFetch();
  const view = freshView();

  await mountDocs(view, host, 'quickstart', 'de', '');

  // Non-English route => the localized fetch URL.
  assert.ok(
    fetchUrls.includes('/info/de/quickstart.html'),
    `fetched the de-localized page (saw ${JSON.stringify(fetchUrls)})`,
  );

  const article = view.querySelector('[data-content] article.docs-content');
  assert.ok(article, 'a fresh <article class="docs-content ..."> is mounted in the content column');
  // The rehosted class list is kept from the imported fragment.
  assert.ok(article!.classList.contains('page-quickstart'), 'the page-<slug> class rides across');
  // The fragment content came with it.
  assert.ok(article!.querySelector('#one'), 'a heading from the fragment is present');
  assert.ok(article!.textContent?.includes('Body one.'), 'fragment prose is present');
  // No second <main> landmark was introduced (the fragment main became an article).
  assert.equal(article!.querySelector('main'), null, 'the fragment main is rehosted, not nested');

  view.remove();
});

test('strips script and .listen-bar from the fragment but keeps <style>', async () => {
  stubOkFetch();
  const view = freshView();

  await mountDocs(view, host, 'quickstart', 'de', '');

  const article = view.querySelector('[data-content] article.docs-content')!;
  assert.equal(article.querySelector('script'), null, 'fetched scripts are removed');
  assert.equal(article.querySelector('.listen-bar'), null, 'the listen bar is removed');
  assert.ok(article.querySelector('style'), 'an inner <style> block survives (figure-local tokens)');

  view.remove();
});

test('rewrites internal /info doc links toward the in-app #/docs reader', async () => {
  stubOkFetch();
  const view = freshView();

  await mountDocs(view, host, 'quickstart', 'de', '');

  const article = view.querySelector('[data-content] article.docs-content')!;
  // /info/quickstart.html -> #/docs/quickstart (rewriteDocLinks + toReaderHref).
  assert.ok(
    article.querySelector('a[href="#/docs/quickstart"]'),
    'a plain internal doc link is rewritten to the reader route',
  );
  // /info/reference.html#config -> #/docs/reference?h=config (the anchor rides as ?h=).
  assert.ok(
    article.querySelector('a[href="#/docs/reference?h=config"]'),
    'an anchored internal doc link carries its anchor as ?h=',
  );

  view.remove();
});

test('fills the pathways, sidebar, sitemap and TOC nav slots', async () => {
  stubOkFetch();
  const view = freshView();

  await mountDocs(view, host, 'quickstart', 'de', '');

  const pathways = view.querySelector<HTMLElement>('[data-pathways]')!;
  assert.equal(pathways.hidden, false, 'the pathways slot is shown once filled');
  assert.ok(pathways.querySelector('.docs-pathways'), 'the pathways bar was built from .nav-group');

  const sidebar = view.querySelector<HTMLElement>('[data-sidebar]')!;
  assert.equal(sidebar.hidden, false, 'the sidebar slot is shown once filled');
  assert.ok(sidebar.querySelector('.docs-sidebar'), 'the docs sidebar rail was adopted');

  const sitemap = view.querySelector<HTMLElement>('[data-sitemap]')!;
  assert.equal(sitemap.hidden, false, 'the sitemap slot is shown once filled');
  assert.ok(sitemap.querySelector('.footer-sitemap'), 'the footer sitemap was adopted');

  // The TOC is DERIVED from the rehosted content's h2[id] set (three sections here).
  const toc = view.querySelector<HTMLElement>('[data-toc]')!;
  assert.equal(toc.hidden, false, 'the TOC slot is shown once the content has >= 2 h2 sections');
  const tocLinks = toc.querySelectorAll('.docs-toc a[data-toc-target]');
  assert.equal(tocLinks.length, 3, 'one TOC entry per stamped h2 heading');

  view.remove();
});

test('a ?h=<id> deep link mounts cleanly when the heading exists', async () => {
  stubOkFetch();
  const view = freshView();

  // scrollIntoView has no layout in jsdom and is wrapped in try/catch; the mount must not throw.
  await mountDocs(view, host, 'quickstart', 'de', 'h=some-id');

  const article = view.querySelector('[data-content] article.docs-content');
  assert.ok(article, 'the page still mounts with a deep-link heading param');
  assert.ok(article!.querySelector('#some-id'), 'the deep-link target heading is present in the DOM');

  view.remove();
});

test('a non-ok response renders a .docs-status message and mounts no article', async () => {
  fetchUrls = [];
  globalThis.fetch = (async (u: unknown) => {
    fetchUrls.push(String(u));
    return { ok: false, text: async () => '', json: async () => ({}) };
  }) as unknown as typeof fetch;
  const view = freshView();

  await mountDocs(view, host, 'missing-page', 'de', '');

  assert.ok(view.querySelector('.docs-status'), 'a not-found status message is shown');
  assert.equal(view.querySelector('article.docs-content'), null, 'no fragment article is mounted');

  view.remove();
});

test('a fetch throw renders the connection-error .docs-status message', async () => {
  fetchUrls = [];
  globalThis.fetch = (async (u: unknown) => {
    fetchUrls.push(String(u));
    throw new Error('net down');
  }) as unknown as typeof fetch;
  const view = freshView();

  await mountDocs(view, host, 'quickstart', 'de', '');

  const status = view.querySelector('.docs-status');
  assert.ok(status, 'a connection-error status message is shown');
  assert.ok(
    /connection|Could not load/i.test(status!.textContent || ''),
    'the message names the connection failure',
  );
  assert.equal(view.querySelector('article.docs-content'), null, 'no fragment article is mounted');

  view.remove();
});
