import { defineConfig } from 'vite';
import { resolve, extname, relative, join, sep, dirname } from 'node:path';
import { existsSync, statSync, readFileSync, cpSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// This file's directory (shells/web/). Computed from import.meta.url rather
// than the __dirname global only Vite's config bundler shims in, so plain node
// can import this module too — src/sw.test.ts imports the exported precache
// grouping helpers below.
const webDir = dirname(fileURLToPath(import.meta.url));
// Repo root is two directories up from shells/web/.
const repoRoot = resolve(webDir, '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp3':  'audio/mpeg',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mjs':  'text/javascript',
  '.wasm': 'application/wasm',
};

// Vite resolve.alias only rewrites JS import statements — it has no effect on
// browser fetch() calls. This plugin adds an actual HTTP handler for /tools/,
// /catalog/, and /schemas/ so that fetch('/tools/qr-code/tool.json') works in
// dev — and so the schema $id URLs (https://lolly.tools/schemas/*.schema.json)
// resolve to the real files in both dev and the production build.
function serveRepoStatic() {
  return {
    name: 'serve-repo-static',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];

        // Serve the onnxruntime-web WASM runtime (public/ort/*.{mjs,wasm}) RAW,
        // ignoring any query. ORT loads its wasm-glue via a runtime dynamic
        // import(); Vite's client rewrites that to `/ort/x.mjs?import` and routes
        // it through the module-transform pipeline, where a public/ file isn't in
        // the module graph → 404 (the deep scan's "couldn't run" error). Serving
        // it here, before Vite's transform middleware, short-circuits with the raw
        // module so the import resolves. Dev-only; the prod build has no `?import`
        // and serves public/ort/ statically from dist/. (Populated at setup from
        // node_modules/onnxruntime-web/dist/*.{wasm,mjs}.) /ort-hf/ is the same
        // story for the speech worker's transformers.js-pinned ORT runtime
        // (public/ort-hf/<version>/, staged by scripts/copy-transformers-ort.ts).
        if (url?.startsWith('/ort/') || url?.startsWith('/ort-hf/')) {
          const filePath = resolve(webDir, 'public', url.slice(1));
          if (existsSync(filePath) && statSync(filePath).isFile()) {
            const data = readFileSync(filePath);
            res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream');
            res.setHeader('Content-Length', data.byteLength);
            res.end(data);
            return;
          }
        }

        // Serve /info/* directly from public/info/ before the SPA fallback runs.
        if (url?.startsWith('/info')) {
          const normalized = (url === '/info' || url === '/info/') ? '/info/index.html' : url;
          const filePath = resolve(webDir, 'public', normalized.slice(1));
          if (existsSync(filePath) && statSync(filePath).isFile()) {
            const data = readFileSync(filePath);
            res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'text/html; charset=utf-8');
            res.setHeader('Content-Length', data.byteLength);
            res.end(data);
            return;
          }
        }

        if (!url?.startsWith('/tools/') && !url?.startsWith('/catalog/') && !url?.startsWith('/schemas/')) return next();
        const filePath = resolve(repoRoot, url.slice(1));
        if (!existsSync(filePath) || !statSync(filePath).isFile()) return next();
        const data = readFileSync(filePath);
        res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream');
        res.setHeader('Content-Length', data.byteLength);
        res.end(data);
      });
    },
    closeBundle() {
      const outDir = resolve(webDir, 'dist');
      for (const dir of ['catalog', 'tools', 'schemas']) {
        const src = resolve(repoRoot, dir);
        // dereference: tools/ and catalog are profile VIEWS (symlink farms built
        // by scripts/use-profile.ts) — copy the real files, not the links.
        if (existsSync(src)) cpSync(src, resolve(outDir, dir), { recursive: true, dereference: true });
      }
    },
  };
}

// Emit dist/precache.json — the enumerable answer to "what IS the whole app?".
// Vite has no servable manifest of its output (build.manifest is off, and it
// wouldn't cover publicDir anyway), so until this existed nothing could
// precache the ~350 lazy chunks: the SW precaches only '/', every other chunk
// cached organically on first use, and a pinned tool whose editor chunk never
// loaded online died offline with a reload card. The profile view's
// "Available offline" manager (src/lib/offline-manager.ts) downloads these
// groups into the SW's persistent page-owned buckets:
//
//   app — index.html + every hashed chunk under /assets/ + the bundled UI
//         fonts + icons/share stubs. Everything a fully-offline boot of ANY
//         view needs, minus content that has its own pipeline (below).
//   ort — the onnxruntime-web runtime files ORT actually loads at scan time
//         (ort-wasm-*; the ort.*.mjs package entrypoints ship inside the
//         /assets/ bundle and are never fetched from /ort/), PLUS the speech
//         worker's pinned transformers.js runtime under /ort-hf/<version>/ —
//         both read back through the SW's lolly-ort bucket. ~95 MB + ~22 MB,
//         opt-in.
//
//   speech — the on-device voice models (/models/kokoro/, plus /models/whisper/
//         when staged), downloaded by the 'speech' offline part into the
//         transformers-cache + lolly-speech buckets the speech runtime reads
//         (plans/41-tts-stt-programme.md section 3). Opt-in, ~110 MB.
//
// Deliberately NOT listed: /catalog/ + /tools/ (the catalog sync + pin engine
// own those, with checksums), /info/ (docs build emits its own manifest.json),
// /models/trustmark/ bytes ride the `models` group as size metadata only
// (lib/trustmark.ts caches those in IndexedDB itself), sw.js
// (the browser owns SW lifecycle). Runs at closeBundle, AFTER serveRepoStatic's
// copies, by scanning the real dist/ output — so it can never drift from what
// actually shipped. `version` hashes the listing; the manager stores it as its
// re-sync watermark (new deploy → new hash → "update your download").
// Split the scanned dist/ listing into the download groups offline-manager.ts
// reads. Exported for the grouping test in src/sw.test.ts.
export function groupPrecacheFiles(all) {
  // The app group is the offline boot payload: everything EXCEPT the opt-in
  // runtime/model binaries — /ort/, /ort-hf/ (the speech worker's runtime,
  // which the SW can only serve from lolly-ort, never lolly-app) and /models/.
  const app = all.filter(f => !f.url.startsWith('/ort/') && !f.url.startsWith('/ort-hf/') && !f.url.startsWith('/models/'));
  // The runtime wasm each ONNX runtime loads (ort-wasm-*), split by OWNER so each
  // offline part is self-complete: `ort` is the 1.27 build at /ort/ (the verify
  // deep-scan detectors), `ortHf` is transformers.js's pinned build at
  // /ort-hf/<version>/ (the Kokoro/Whisper speech worker). They used to share one
  // `ort` group the VERIFY part downloaded, so pre-downloading Speech alone still
  // fetched the ~22 MB /ort-hf/ runtime on first synthesis; owning it here lets the
  // speech part be truly offline-complete. The other ort.*.mjs files are package
  // dist entrypoints Vite bundles — dead weight.
  const ort = all.filter(f => /^\/ort\/ort-wasm-/.test(f.url));
  const ortHf = all.filter(f => /^\/ort-hf\/[^/]+\/ort-wasm-/.test(f.url));
  // The verify part's models are the TrustMark decoders ONLY — downloaded via
  // lib/trustmark.ts's own IDB path, listed here so the part can state its true
  // size up front. /models/kokoro/ is deliberately NOT here: it belongs to the
  // 'speech' group below (plans/41-tts-stt-programme.md section 3) — counting it in
  // would make the verify part's size lie by ~95 MB.
  const models = all.filter(f => f.url.startsWith('/models/trustmark/'));
  // The speech part's voice models: Kokoro today, Whisper when its STT models
  // are staged. offline-manager.ts splits the group between transformers.js's
  // 'transformers-cache' bucket (model/config/tokenizer) and the worker's
  // 'lolly-speech' bucket (voice matrices) — the caches the runtime reads.
  const speech = all.filter(f => f.url.startsWith('/models/kokoro/') || f.url.startsWith('/models/whisper/'));
  // The AI-upscaler models (host.upscale, engine 1.101) — downloaded via
  // lib/upscaler.ts's own IDB path (the shared ORT model fetcher), listed here so
  // the offline-download manager can state the part's true size up front. Like the
  // verify/speech models, /models/upscale/ is SW-bypassed (single IDB copy).
  const upscale = all.filter(f => f.url.startsWith('/models/upscale/'));
  // The background-removal models (host.matte, engine 1.103) — downloaded via
  // lib/matter.ts's own IDB path (the shared ORT model fetcher), listed here so
  // the offline-download manager can state the part's true size up front. Like the
  // upscale/speech/verify models, /models/matte/ is SW-bypassed (single IDB copy).
  const matte = all.filter(f => f.url.startsWith('/models/matte/'));
  // The OCR models (host.ocr, plans/125) — a detector + recogniser + char dict,
  // downloaded via lib/ocr.ts's own IDB path (the shared ORT model fetcher), listed
  // here so the offline-download manager can state the part's size up front. Like
  // the other model parts, /models/ocr/ is SW-bypassed (single IDB copy).
  const ocr = all.filter(f => f.url.startsWith('/models/ocr/'));
  return { app, ort, ortHf, models, speech, upscale, matte, ocr };
}

// Content hash for files whose URL does NOT already encode their bytes.
// /assets/ chunks are content-hash-named (a change renames them), the /ort/ +
// /models/ binaries are release-versioned and too big to hash every build, and
// /ort-hf/ carries its release version in the path — everything else (fonts,
// icons, share stubs, index.html, voice, viz-presets) keeps a stable name, so
// a same-size content change is invisible to a size compare. The hash is what
// offline-manager.ts's cachedMatches uses to catch that. Exported for the
// grouping test in src/sw.test.ts.
export const precacheNeedsHash = (url) =>
  !url.startsWith('/assets/') && !url.startsWith('/ort/') && !url.startsWith('/ort-hf/') && !url.startsWith('/models/');

function precacheManifest() {
  const SKIP = new Set(['catalog', 'tools', 'schemas', 'info', 'sw.js', 'precache.json']);
  const needsHash = precacheNeedsHash;
  const walk = (dir, base) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Finder droppings and other dotfiles are not app payload (.well-known,
      // a dot-DIRECTORY with real policy files, stays).
      if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
      const full = join(dir, entry.name);
      // sep-normalised so the emitted URLs are stable on Windows checkouts too
      const rel = relative(base, full).split(sep).join('/');
      if (SKIP.has(rel.split('/')[0])) continue;
      if (entry.isDirectory()) out.push(...walk(full, base));
      else if (entry.isFile()) {
        const url = '/' + rel;
        const file = { url, size: statSync(full).size };
        if (needsHash(url)) {
          file.hash = createHash('sha256').update(readFileSync(full)).digest('base64url').slice(0, 16);
        }
        out.push(file);
      }
    }
    return out;
  };
  return {
    name: 'lolly-precache-manifest',
    apply: 'build',
    closeBundle() {
      const outDir = resolve(webDir, 'dist');
      if (!existsSync(outDir)) return;
      const all = walk(outDir, outDir).sort((a, b) => a.url.localeCompare(b.url));
      const groups = groupPrecacheFiles(all);
      const version = createHash('sha256')
        .update(all.map(f => `${f.url}:${f.size}:${f.hash ?? ''}`).join('\n'))
        .digest('base64url').slice(0, 16);
      writeFileSync(resolve(outDir, 'precache.json'), JSON.stringify({ version, groups }));
    },
  };
}

// Bake per-brand browser/PWA chrome into index.html at build time. The static
// theme-color in index.html is SUSE pine (#0c322c); on any OTHER brand (e.g. the
// blank lolly.art profile) that would wrongly tint the mobile address bar / PWA
// titlebar SUSE green, and the SUSE webfont preload would just 404. Resolve the
// active profile (LOLLY_PROFILE env on Vercel → the repo-root .lolly-profile
// sticky file → the suse default) and, for a non-SUSE brand, neutralise the
// theme-color and drop the dead SUSE font preload. SUSE builds are untouched.
// (Longer term the colour should come from the active brand's own tokens.)
function brandChrome() {
  const NEUTRAL = '#4f84ba'; // the app's canonical brand fallback (brand-vars.ts)
  let profile = process.env.LOLLY_PROFILE?.trim();
  if (!profile) {
    try { profile = readFileSync(resolve(repoRoot, '.lolly-profile'), 'utf8').trim(); } catch { /* no sticky file */ }
  }
  if (!profile) profile = 'suse';
  const isSuse = profile === 'suse';
  // Canonical host for the origin guard baked into index.html. index.html hardcodes
  // the SUSE default ('lolly.tools'); a non-SUSE brand gets its own host here, and an
  // unknown brand gets '' so the guard no-ops rather than force-redirecting somewhere
  // wrong. (The lolly.art/start split folds into lolly.tools on 2026-08-29.)
  const CANON_BY_PROFILE = { suse: 'lolly.tools', 'lolly-start': 'lolly.art' };
  return {
    name: 'lolly-brand-chrome',
    transformIndexHtml(html) {
      if (isSuse) return html; // index.html already carries the SUSE chrome
      return html
        .replace("var CANON = 'lolly.tools';", `var CANON = '${CANON_BY_PROFILE[profile] ?? ''}';`)
        .replace('<meta name="theme-color" content="#0c322c" />', `<meta name="theme-color" content="${NEUTRAL}" />`)
        .replace(/\n\s*<link rel="preload" as="font"[^>]*SUSE\[wght\][^>]*>/, '');
    },
  };
}

// Strip model STAGING dirs from the production build. scripts/fetch-{matte,upscale}-
// models.ts stage a candidate model under public/models/<cat>/.candidates/ for
// evaluation before it is promoted into its served /models/<cat>/ path — and the DEV
// server serves them (so a candidate can be tested at that URL), which is why they live
// under public/. But vite copies publicDir wholesale, so a plain build would SHIP them
// too: ~700 MB of dead weight nothing references (they are dot-dirs, so precacheManifest's
// walk already skips them — no manifest/group/client points at them; they were reachable
// only incidentally). Delete them from dist so they never ship via ANY path — local dist,
// git-integration, or the loldev-ship archive. Build-only (`apply: 'build'`), so dev-server
// candidate evaluation is untouched. Runs before precacheManifest for tidiness; the scan
// skips dot-dirs regardless, so the emitted manifest is byte-identical either way.
function stripModelCandidates() {
  return {
    name: 'lolly-strip-model-candidates',
    apply: 'build',
    closeBundle() {
      const modelsDir = resolve(webDir, 'dist', 'models');
      if (!existsSync(modelsDir)) return;
      for (const cat of readdirSync(modelsDir, { withFileTypes: true })) {
        if (!cat.isDirectory()) continue;
        const cand = resolve(modelsDir, cat.name, '.candidates');
        if (existsSync(cand)) rmSync(cand, { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig({
  publicDir: 'public',
  // stripModelCandidates before precacheManifest: remove the /models/*/.candidates
  // staging dirs from dist before the manifest scan. precacheManifest LAST: its
  // closeBundle scans dist/ after serveRepoStatic's closeBundle has copied
  // catalog/tools/schemas in (it skips those, but the ordering keeps the scan
  // deterministic either way).
  plugins: [serveRepoStatic(), brandChrome(), stripModelCandidates(), precacheManifest()],
  // The Neurospicy player + video music-bed exporter render ZzFXM songs in a
  // module worker (src/lib/zzfxm-worker.ts, which ESM-imports the engine). Emit
  // it as an ES module so the import graph survives the build unchanged.
  worker: { format: 'es' },
  // onnxruntime-web (lazy-loaded by the /verify deep-scan: lib/trustmark.ts +
  // lib/contentseal.ts) must NOT go through Vite's esbuild dep pre-bundler — it
  // rewrites the package's `import.meta.url`-relative wasm/worker loading and the
  // dynamic `import('onnxruntime-web')` then throws at runtime (surfaced as the
  // deep scan's 'error' / "couldn't run in this browser"). Excluding it makes Vite
  // serve the package's own ESM untouched; the wasm binaries load at runtime from
  // /ort/ via `ort.env.wasm.wasmPaths` (populated into public/ort/ at setup), not
  // through the bundler. Standard onnxruntime-web + Vite requirement.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  resolve: {
    alias: {
      '@lolly/engine': resolve(repoRoot, 'engine/src/index.ts'),
      // jspdf lazy-imports html2canvas (199 KB / 46 KB gz, + its own dompurify)
      // ONLY inside its `.html()`/`addHTML()` method, which lolly never calls.
      // Alias it to an empty stub so it's never built or shipped. (dompurify is
      // NOT stubbed — picker.ts uses the standalone copy directly.)
      'html2canvas': resolve(webDir, 'html2canvas-stub.js'),
    },
  },
  server: {
    fs: { allow: [repoRoot] },
    // dev-only: the standalone CA service — node services/ca/server.mjs
    // (string shorthand preserves the /api/ca path prefix, which the handler routes on).
    proxy: { '/api/ca': 'http://localhost:8787' },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Split the heavy render-only engine deps into their own chunks. `@lolly/engine`
        // is aliased straight to its barrel (above), so package.json `sideEffects` never
        // applies and the whole engine otherwise lands in one shared chunk the gallery/
        // catalog boot preloads. engine-render is imported only from LAZY views (tool,
        // projects, picker, pro, compose, featured-render — all dynamic-imported), so as
        // its own chunk it loads with those views instead of blocking first paint.
        //
        // Uses rolldown's `advancedChunks` (not the `manualChunks` compat shim): the
        // shim's tiny groups get merged back into the chunk that imports them, which
        // was silently folding engine-util below back into engine-render. Per-group
        // `minSize: 0` + `minShareCount: 1` keep every group as a real, separate chunk.
        advancedChunks: {
          minSize: 0,
          minShareCount: 1,
          groups: [
            { name: 'handlebars', test: /\/node_modules\/handlebars\//, minSize: 0, minShareCount: 1 },
            { name: 'ajv', test: /\/node_modules\/ajv\//, minSize: 0, minShareCount: 1 },
            // Pure engine util files (tokens/tool-url/embed) — NO runtime/template/
            // loader/validate dependency, so no Handlebars/Ajv. runtime.ts imports
            // them, so without their own chunk rolldown tree-shakes the tiny boot-time
            // helpers the entry legitimately needs — createTokenSet + isTokenValue/
            // isAssetRef (tokens.ts; used by bridge/tokens.ts token & asset resolution)
            // and isToolUrl (tool-url.ts) — INTO engine-render, dragging the whole
            // render/validate blob (+ Ajv + Handlebars, ~83 KB gz) into the entry's
            // static graph so it modulepreloads at first paint. Isolating them lets the
            // entry import from this light chunk while the lazy views still get the
            // helpers on demand. MUST precede engine-render so these files land here.
            { name: 'engine-util', test: /engine\/src\/tokens\.ts$/, minSize: 0, minShareCount: 1 },
            // tool-url.ts + embed.ts used to share the engine-util group above. They
            // belong OFF that group: nothing on the boot path imports either (a grep
            // of shells/web/src finds only lazy views and comment references), but
            // tokens.ts IS a boot import, so co-locating them meant their ~10 KB of
            // source rode the preload set for free. Same isolation reasoning as
            // engine-util itself — a separate group, still ahead of engine-render, so
            // the lazy views get them on demand without dragging Handlebars/Ajv.
            { name: 'engine-toolurl', test: /engine\/src\/(tool-url|embed)\.ts$/, minSize: 0, minShareCount: 1 },
            // ENGINE_VERSION — one string constant, but loader.ts imports it too, so
            // default chunking parks version.ts INSIDE engine-render. lib/instance.ts
            // (sync base URL, boot) and the geom kernel both read it, and that single
            // edge drags engine-render + Handlebars + Ajv + engine-c2pa (~156 KB gz)
            // onto the preload set. MUST precede engine-render.
            { name: 'engine-version', test: /engine\/src\/version\.ts$/, minSize: 0, minShareCount: 1 },
            // bytes.ts — the shared byte/crypto primitive leaf (concatBytes, sha256,
            // sha256Hex, bytesToHex, base64ToBytes) every binary format module in the
            // engine imports. ~0.6 KB, and genuinely on the boot path: design-version.ts
            // (reached from bridge/assets.ts at first paint) re-exports sha256Hex from
            // it. x509.ts imports it too, so WITHOUT this group rolldown co-locates
            // bytes.ts INTO engine-x509 and that one boot edge drags the cert parser +
            // der-read (~2.4 KB gz) back onto the preload set — the exact mechanism the
            // engine-util note above describes, measured again on 2026-08-10. MUST
            // precede engine-x509 / engine-c2pa / engine-render.
            { name: 'engine-bytes', test: /engine\/src\/bytes\.ts$/, minSize: 0, minShareCount: 1 },
            // x509 cert parser (pemToDer + the DER walk). NOT a boot dependency any
            // more — bridge/identity.ts is a lazy facade and catalog-integrity.ts is
            // dynamically imported by catalog/integrity.ts — but it keeps its own chunk
            // so it never co-locates into engine-c2pa, where its next boot edge would
            // drag the whole 17 KB c2pa blob onto the preload set. MUST precede
            // engine-c2pa.
            { name: 'engine-x509', test: /engine\/src\/x509\.ts$/, minSize: 0, minShareCount: 1 },
            // Catalog signature verification (catalog-integrity.ts) — inert unless a
            // build pins VITE_CATALOG_PUBLIC_KEY_JWK, and imported dynamically by
            // catalog/integrity.ts for exactly that reason. Its own chunk regardless,
            // so it can never co-locate into engine-render and put the render/validate
            // blob (+ Handlebars + Ajv) behind a catalog sync. MUST precede
            // engine-render. Its only engine deps are engine-x509 + engine-bytes above.
            { name: 'engine-integrity', test: /engine\/src\/catalog-integrity\.ts$/, minSize: 0, minShareCount: 1 },
            // Vector geometry kernel (host.geom, v1.64): bezier flattening, the
            // polynomial root solver, path booleans/offset/stroke-to-fill/spline
            // lowering — ~28 KB gz. Nothing in the shell reads host.geom; only tool
            // hooks and the (lazy) free-canvas vector-ops do. Without its OWN group
            // these files co-locate with the small icon-theme/photo-treatment/
            // session-record helpers the gallery genuinely needs at first paint, so
            // deferring the bridge's import alone would not move the bytes — same
            // mechanism the engine-util/engine-version notes above describe.
            { name: 'engine-geom', test: /engine\/src\/(geom-api\.ts|geom\/)/, minSize: 0, minShareCount: 1 },
            // Perceptual colour tools (host.color, v1.40) + the ICC/gamut machinery
            // makeColorApi eagerly reaches (icc.ts alone is 62 KB of source). Same
            // story as geom: tool-hook-only, installed by lib/mount-runtime.ts before
            // the first runtime, and a separate group so it can actually leave boot.
            { name: 'engine-color', test: /engine\/src\/(color-tools|gamut|icc|gamut-source|gradient-spec|brand-schemes)\.ts$/, minSize: 0, minShareCount: 1 },
            // On-device C2PA sign/verify + CBOR codec (~17 KB gz). Only the lazy
            // /valid view and export-with-provenance run these — keep them off the
            // render-blocking gallery boot path.
            { name: 'engine-c2pa', test: /engine\/src\/(c2pa|c2pa-verify)\.ts$/, minSize: 0, minShareCount: 1 },
            // The engine's render + manifest-validate source (runtime/template →
            // Handlebars, loader/validate → Ajv). Only the lazy views import these.
            { name: 'engine-render', test: /engine\/src\/(runtime|template|loader|validate)\.ts$/, minSize: 0, minShareCount: 1 },
          ],
        },
      },
    },
  },
});
