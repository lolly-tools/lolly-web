import { defineConfig } from 'vite';
import { resolve, extname } from 'node:path';
import { existsSync, statSync, readFileSync, cpSync } from 'node:fs';

// Repo root is two directories up from shells/web/.
const repoRoot = resolve(__dirname, '..', '..');

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

        // Serve /info/* directly from public/info/ before the SPA fallback runs.
        if (url?.startsWith('/info')) {
          const normalized = (url === '/info' || url === '/info/') ? '/info/index.html' : url;
          const filePath = resolve(__dirname, 'public', normalized.slice(1));
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
      const outDir = resolve(__dirname, 'dist');
      for (const dir of ['catalog', 'tools', 'schemas']) {
        const src = resolve(repoRoot, dir);
        if (existsSync(src)) cpSync(src, resolve(outDir, dir), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  publicDir: 'public',
  plugins: [serveRepoStatic()],
  resolve: {
    alias: {
      '@lolly/engine': resolve(repoRoot, 'engine/src/index.ts'),
      // jspdf lazy-imports html2canvas (199 KB / 46 KB gz, + its own dompurify)
      // ONLY inside its `.html()`/`addHTML()` method, which lolly never calls.
      // Alias it to an empty stub so it's never built or shipped. (dompurify is
      // NOT stubbed — picker.ts uses the standalone copy directly.)
      'html2canvas': resolve(__dirname, 'html2canvas-stub.js'),
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
            { name: 'engine-util', test: /engine\/src\/(tokens|tool-url|embed)\.ts$/, minSize: 0, minShareCount: 1 },
            // x509 cert parser. bridge/identity.ts needs pemToDer at boot, so isolate
            // it in a tiny (~2 KB gz) chunk. MUST precede engine-c2pa so x509.ts lands
            // here — otherwise it co-locates into the c2pa chunk and pemToDer's boot
            // edge drags the whole 17 KB c2pa blob back onto the preload set.
            { name: 'engine-x509', test: /engine\/src\/x509\.ts$/, minSize: 0, minShareCount: 1 },
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
