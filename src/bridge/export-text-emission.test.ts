// SPDX-License-Identifier: MPL-2.0
/**
 * Characterization tests for the `<path>` EMISSION inside renderSvgFromHtml
 * (export.ts) — the seam plans/maintainability-2026-07-29.md item 1 names as the
 * largest untested surface in the repo, and the blocker on decomposing the
 * biggest file.
 *
 * WHAT WAS ALREADY COVERED, AND WHY THAT WASN'T ENOUGH
 * `host.text.toPath` has a real-HarfBuzz golden suite (text-outline-golden.test.ts),
 * and the pure helpers (text-svg.ts, font-registry.ts) have their own. So glyph
 * outlines were proven correct in isolation. What nothing asserted was the
 * DECISION layer around them inside export.ts: which runs get outlined at all,
 * which fall back to `<text>`, and whether the surrounding CSS (letter-spacing,
 * variable weight, text-transform) reaches the shaper. That is precisely where
 * this project's own notes record the historical drift — glyph mangling, pill to
 * ellipse, the inline-flex drop. Every test here asserts an emission DECISION, not
 * glyph geometry, so it stays honest if HarfBuzz's output ever legitimately moves.
 *
 * A REAL CHROMIUM IS THE ORACLE. Every decision hinges on getComputedStyle
 * resolving a font stack, a used weight and a letter-spacing — jsdom has no font
 * matching, so it cannot answer any of them. Same harness shape as
 * export-m3.test.ts (esbuild bundle → page.addScriptTag), which is why the
 * `chromiumOrSkip` dance below looks familiar.
 *
 * THIS TIER IS BRAND-INDEPENDENT ON PURPOSE. The existing golden suite needs SUSE
 * font files under `catalog/fonts/`, a gitignored profile view, so it skips on the
 * `lolly-start` profile and in public CI — the second gap the audit called out.
 * This file instead uses `Outfit[wght].ttf`, which is committed in the WEB SHELL's
 * own `public/fonts/` and is therefore present on every clone regardless of
 * profile. It is also a variable font (wght 100..900), which is what makes the
 * variable-weight case below possible without a brand pack.
 *
 * Run directly: node --test shells/web/src/bridge/export-text-emission.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPORT_MODULE = fileURLToPath(new URL('./export.ts', import.meta.url));
// bridge/ -> src/ -> web/ -> shells/ -> repo root.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The platform face, committed in the web shell itself — not a brand asset. */
const OUTFIT_TTF = join(REPO_ROOT, 'shells/web/public/fonts/Outfit[wght].ttf');
const HB_WASM = join(REPO_ROOT, 'node_modules/harfbuzzjs/dist/harfbuzz.wasm');

async function chromiumOrSkip(): Promise<{ chromium: any } | string> {
  if (!existsSync(OUTFIT_TTF)) return `missing ${OUTFIT_TTF}`;
  if (!existsSync(HB_WASM)) return 'harfbuzzjs wasm not installed';
  let chromium: any;
  try { ({ chromium } = await import('playwright')); }
  catch { return 'playwright not installed'; }
  try {
    const p = chromium.executablePath();
    if (!p || !existsSync(p)) return 'no Chromium (npx playwright install chromium)';
  } catch { return 'no Chromium (npx playwright install chromium)'; }
  return { chromium };
}

const browser = await chromiumOrSkip();
const SKIP = typeof browser === 'string' ? browser : false;

let bundleCache: string | null = null;
async function bundle(): Promise<string> {
  if (bundleCache) return bundleCache;
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      // createExportAPI is what assigns export.ts's module-level `_host`, and the
      // outlining branch is gated on `_host?.text` — without this call every run
      // silently falls back to <text> and the whole suite would pass vacuously.
      // The `emits a <path>` test is the canary for exactly that mistake.
      contents: `import { renderSvgFromHtml, createExportAPI } from ${JSON.stringify(EXPORT_MODULE)};
                 import { createTextAPI } from ${JSON.stringify(join(HERE, 'text.ts'))};
                 window.__setup = () => createExportAPI({ text: createTextAPI(), log: () => {} });
                 window.__render = renderSvgFromHtml;`,
      resolveDir: HERE, loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'browser',
    target: 'esnext', logLevel: 'silent',
    plugins: [{
      // harfbuzzjs's dist/harfbuzz.js does `await import("module")` for a Node
      // createRequire. The real Vite build externalises it for the browser (it
      // logs that warning on every build); esbuild needs it said explicitly. The
      // branch is unreachable in a browser, so an inert createRequire is faithful.
      name: 'stub-node-module',
      setup(b: any) {
        b.onResolve({ filter: /^module$/ }, () => ({ path: 'module', namespace: 'stub-node-module' }));
        b.onLoad({ filter: /.*/, namespace: 'stub-node-module' }, () => ({
          contents: 'export function createRequire(){ return () => ({}); }\nexport default { createRequire };',
          loader: 'js',
        }));
      },
    }],
  });
  bundleCache = out.outputFiles[0]!.text;
  return bundleCache;
}

const FONT_CSS =
  `@font-face{font-family:Outfit;src:url('/fonts/Outfit[wght].ttf') format('truetype');font-weight:100 900}`;

/** One browser for the whole file — launching per test dominates the runtime. */
let shared: any = null;
async function page(): Promise<any> {
  const { chromium } = browser as { chromium: any };
  if (!shared) {
    shared = await chromium.launch();
    shared.__page = await shared.newPage({ viewport: { width: 900, height: 700 } });
    // setContent gives the page a null origin with no server, so the @font-face
    // URL and HarfBuzz's wasm both have to be served here. Serving the font by
    // ROUTE (rather than inlining a data: URL) keeps font-registry on its real
    // resolve-a-URL path instead of a shape this app never actually takes.
    await shared.__page.route('**/*', async (route: any) => {
      const p = decodeURIComponent(new URL(route.request().url()).pathname);
      if (p === '/fonts/Outfit[wght].ttf') {
        return route.fulfill({ status: 200, contentType: 'font/ttf', body: readFileSync(OUTFIT_TTF) });
      }
      if (p.endsWith('.wasm')) {
        return route.fulfill({ status: 200, contentType: 'application/wasm', body: readFileSync(HB_WASM) });
      }
      if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' });
      return route.fulfill({ status: 404, body: '' });
    });
    await shared.__page.goto('http://localhost/');
  }
  return shared.__page;
}
test.after(async () => { if (shared) await shared.close(); });

/** Render `inner` inside #root and return the exported SVG source. */
async function render(inner: string, opts: Record<string, unknown> = {}): Promise<string> {
  const pg = await page();
  await pg.setContent(`<!doctype html><body style="margin:0"><style>${FONT_CSS}</style>` +
    `<div id="root" style="width:500px;height:150px;background:#fff">${inner}</div></body>`);
  await pg.evaluate(() => (document as any).fonts.ready);
  await pg.addScriptTag({ content: await bundle(), type: 'module' });
  await pg.waitForFunction(() => !!(window as any).__render);
  return await pg.evaluate(async (o: Record<string, unknown>) => {
    (window as any).__setup();
    const blob = await (window as any).__render(document.getElementById('root'),
      { rasterFallback: false, ...o });
    return await blob.text();
  }, opts);
}

const pathCount = (s: string): number => (s.match(/<path\b/g) ?? []).length;
const textCount = (s: string): number => (s.match(/<text\b/g) ?? []).length;
/** The `d` attribute of every emitted <path>, in document order. */
const pathData = (s: string): string[] => [...s.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1] as string);

const OUTFIT = (t: string, extra = ''): string =>
  `<div style="font-family:Outfit;font-size:24px;${extra}">${t}</div>`;

// ── the two core decisions ───────────────────────────────────────────────────

test('a run whose font resolves is emitted as <path> glyph outlines, not <text>',
  { skip: SKIP }, async () => {
    const svg = await render(OUTFIT('Hello Outfit'));
    assert.ok(pathCount(svg) >= 1, 'expected at least one <path> of glyph outlines');
    assert.doesNotMatch(svg, /<text[^>]*>[^<]*Hello Outfit/,
      'the run resolved to a real font file, so it must NOT remain a <text> element');
    // Guards the whole file against passing vacuously: if createExportAPI were
    // never called, _host.text would be null, every run would fall back to
    // <text>, and only this assertion would notice.
    assert.match(pathData(svg)[0] ?? '', /^M[\d.,\- ]/, 'the <path> must carry real outline data');
  });

test('a run with no resolvable font file falls back to <text>', { skip: SKIP }, async () => {
  // The documented fallback: font-registry resolves nothing for this family, so
  // outlining is skipped and the run stays selectable text naming the family.
  const svg = await render(
    `<div style="font-family:'No Such Family XYZ',monospace;font-size:18px">Fallback run</div>`);
  assert.match(svg, /Fallback run/, 'the text must still be present');
  assert.equal(pathCount(svg), 0, 'nothing resolved, so no glyph outlines may be emitted');
  assert.ok(textCount(svg) >= 1, 'the run must survive as a <text> element');
});

// ── CSS that must reach the shaper ───────────────────────────────────────────

test('letter-spacing reaches the shaper and changes the emitted geometry',
  { skip: SKIP }, async () => {
    const tight = pathData(await render(OUTFIT('AVWA')))[0];
    const loose = pathData(await render(OUTFIT('AVWA', 'letter-spacing:6px')))[0];
    assert.ok(tight && loose, 'both runs must outline');
    assert.notEqual(tight, loose,
      'letter-spacing was dropped on the way to toPath — the glyphs would export at the wrong advances');
  });

test('a variable-font weight reaches the shaper (Outfit is wght 100..900)',
  { skip: SKIP }, async () => {
    const light = pathData(await render(OUTFIT('Weight', 'font-weight:200')))[0];
    const heavy = pathData(await render(OUTFIT('Weight', 'font-weight:800')))[0];
    assert.ok(light && heavy, 'both weights must outline');
    assert.notEqual(light, heavy,
      'both weights produced identical outlines — the variations axis is not being passed, ' +
      'so every weight would export at the default instance');
  });

test('text-transform is applied BEFORE shaping, not left to the renderer',
  { skip: SKIP }, async () => {
    // An outlined path has no text-transform to apply later, so the transform has
    // to happen before toPath or the export silently shows the untransformed text.
    const transformed = pathData(await render(OUTFIT('abc', 'text-transform:uppercase')))[0];
    const literal = pathData(await render(OUTFIT('ABC')))[0];
    assert.ok(transformed && literal, 'both runs must outline');
    assert.equal(transformed, literal,
      'uppercased "abc" must shape identically to a literal "ABC"');
  });

// ── the refusal paths ────────────────────────────────────────────────────────

test('a run the font cannot cover (notdef) keeps its <text> instead of emitting tofu',
  { skip: SKIP }, async () => {
    // Outfit has no CJK. export.ts refuses the path when toPath reports notdef
    // glyphs — emitting them would bake a row of .notdef boxes into the artwork,
    // which is worse than a <text> the viewer's own fonts can still render.
    const svg = await render(OUTFIT('漢字テスト'));
    assert.equal(pathCount(svg), 0, 'uncovered glyphs must NOT be outlined');
    assert.ok(textCount(svg) >= 1, 'the run must survive as <text>');
  });

test('convertPaths:false keeps every run as selectable <text>', { skip: SKIP }, async () => {
  // The user-facing "Convert paths" toggle. Same markup as the first test, which
  // DOES outline — so this pins the toggle itself, not an accident of the fixture.
  const svg = await render(OUTFIT('NoConvert'), { convertPaths: false });
  assert.equal(pathCount(svg), 0, 'convertPaths:false must suppress every outline');
  assert.match(svg, /NoConvert/, 'the text must be present and selectable');
});

// ── the property a snapshot suite depends on ─────────────────────────────────

test('emission is deterministic — the same markup exports byte-identical SVG',
  { skip: SKIP }, async () => {
    // Item 1's plan is to pin these formats as exact snapshots before splitting
    // export.ts. That is only sound if the output is stable; this is the check
    // that says so, and it would catch an id counter or Map iteration order
    // leaking into the bytes.
    const a = await render(OUTFIT('Same'));
    const b = await render(OUTFIT('Same'));
    assert.equal(a, b, 'two identical renders diverged — the output is not snapshot-safe');
  });

// ── tiled conic backgrounds (the transparency checkerboard) ──────────────────

test('a TILED conic background becomes one <pattern>, not an element-sized sweep',
  { skip: SKIP }, async () => {
    // The stage's transparency checkerboard is
    //   repeating-conic-gradient(...) 50% / 2em 2em
    // Until 2026-07-30 the walker passed the ELEMENT box to parseConicGradient and
    // fanned wedges across it, ignoring background-size — so a 32px checkerboard
    // rendered as a single 800x500 four-quadrant sweep. Not a raster, but silently
    // WRONG PIXELS, which is worse. Chromium cannot help here either: PDF has no
    // conic shading type, so the print path rasterises it (measured), which makes
    // the walker the only way to get a crisp checkerboard.
    const svg = await render(
      `<div style="width:200px;height:120px;background:` +
      `repeating-conic-gradient(rgba(255,255,255,.025) 0% 25%, rgba(0,0,0,.025) 0% 50%) 50% / 2em 2em"></div>`);
    const pats = svg.match(/<pattern\b[^>]*>/g) ?? [];
    assert.equal(pats.length, 1, 'expected exactly one <pattern> for the tiled conic');
    assert.match(pats[0] as string, /width="32"/, 'the pattern tile must be the 2em background-size, not the element width');
    assert.match(pats[0] as string, /height="32"/);
    assert.equal((svg.match(/<image\b/g) ?? []).length, 0, 'a tiled conic must never rasterise');
  });

test('an UNTILED conic is still emitted as a wedge fan, unchanged', { skip: SKIP }, async () => {
  // Guards the other side of the branch: no background-size means the sweep covers
  // the element, and that path must keep behaving exactly as it did.
  const svg = await render(
    `<div style="width:200px;height:120px;background:` +
    `repeating-conic-gradient(rgba(255,255,255,.5) 0% 25%, rgba(0,0,0,.5) 0% 50%)"></div>`);
  assert.equal((svg.match(/<pattern\b/g) ?? []).length, 0, 'an untiled conic must not become a pattern');
  assert.ok((svg.match(/<path\b/g) ?? []).length > 8, 'expected a wedge fan');
  assert.equal((svg.match(/<image\b/g) ?? []).length, 0);
});

// ── self-containment: every <image> href must be inlinable ───────────────────

test('an <img> with a PATH src is inlined as a data: URI, not left as a fetchable href',
  { skip: SKIP }, async () => {
    // A docs screenshot is served as `<img src="/info/shots/x.svg">`, and an SVG
    // consumed that way runs in SECURE STATIC MODE with no network access — so a
    // bare `href="/catalog/thumb.png"` renders blank and the file is not
    // self-contained. Until 2026-07-30 only data: and blob: were inlined; an
    // http/relative src fell through verbatim. The sibling CSS-url branch
    // (cssUrlToHref) already fetched http, so this was an inconsistency, not a
    // deliberate exemption. It is the hard blocker on migrating the docs corpus to
    // the walker: any shot framing a catalogue thumbnail would lose its images.
    const pg = await page();
    await pg.route('**/thumb-fixture.png', (route: any) => route.fulfill({
      status: 200, contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'),
    }));
    const svg = await render('<img src="/thumb-fixture.png" width="40" height="30">');
    assert.match(svg, /<image[^>]*href="data:image\//, 'the path src must be inlined as a data: URI');
    assert.doesNotMatch(svg, /href="https?:\/\/[^"]*thumb-fixture/, 'no fetchable href may survive');
    assert.doesNotMatch(svg, /href="\/thumb-fixture/, 'no root-relative href may survive');
  });
