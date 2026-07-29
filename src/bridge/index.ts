// SPDX-License-Identifier: MPL-2.0
/**
 * Web implementation of the v1 capability bridge.
 *
 * Each capability is in its own file; this index composes them. This makes it
 * easy to swap individual implementations (e.g. test doubles) without touching
 * the rest.
 */

import type { HostV1, AssetRef, AssetPickerOpts } from '@lolly-tools/core/host-v1';
// Deep engine imports, NOT the `@lolly/engine` barrel: this module is on the
// boot path, and engine/src/index.ts is one shared facade whose retained export
// set is the UNION over every importer — touching it here drags createRuntime
// (Handlebars) + loadTool/validate (Ajv) + c2pa onto first paint. See
// scripts/check-bundle-budget.ts.
import { createStateAPI } from './state.ts';
import { createProfileAPI } from './profile.ts';
import { createPreviewsAPI } from './previews.ts';
import { createAssetsAPI } from './assets.ts';
import { createTokensAPI } from './tokens.ts';
import { createClipboardAPI } from './clipboard.ts';
// export.ts (the 90 KB SVG/PDF/video bridge) and compose.ts (which statically pulls
// in the full render runtime — Handlebars — and the tool loader — Ajv) are NOT
// imported statically: they'd land in the boot chunk that the gallery landing loads
// before first paint, yet neither runs until a tool exports or composes. Both are
// wired below as lazy facades (dynamic import on first use), like host.assets.pick.
// net / text / pdf / pptx / capture / viz are wired below as LAZY FACADES for the
// same reason export and compose are: every one of their methods is async, none
// of them is read anywhere on the boot path (the gallery gates tools on
// PROVIDED_CAPABILITIES, a plain const, not on these objects), and between them
// they drag the HarfBuzz glue, pdf-lib's entry, the OOXML zip caps and the WebGL
// probe into the chunk that renders first paint. See scripts/check-bundle-budget.ts.
import { createMediaAPI } from './media.ts';
import { createRecorderAPI } from './recorder.ts';
import { hasCaptureExtension } from './capture-extension.ts';
import { vizSupported } from '../lib/viz-support.ts';
import { PROVIDED_CAPABILITIES } from './capabilities-provided.ts';
import { openDB } from './db.ts';

/**
 * The web shell's full host surface: HostV1 with `shell` pinned to 'web', plus
 * the two web-only host-UI helpers that are NOT part of the tool-facing v1
 * contract — `identity` (Content Credentials device identity + CA cert) and
 * `previews` (cache of profile-personalized gallery thumbnails). Their concrete
 * shapes come straight from their factories.
 */
interface WebHost extends HostV1 {
  readonly shell: 'web';
  identity: Awaited<ReturnType<typeof import('./identity.ts')['createIdentityAPI']>>;
  previews: ReturnType<typeof createPreviewsAPI>;
}

/** One-shot memoiser for the lazy-facade loaders below: the first call starts the
 *  dynamic import, every later call reuses the same promise. */
function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= load());
}

export async function createBridge(): Promise<WebHost> {
  const db = await openDB();

  // Best-effort: ask the browser to keep our local data durable so it's less
  // likely to be evicted under storage pressure (matters most on iOS/Safari).
  // Heuristic and silent in most browsers; never blocks startup.
  if (navigator.storage?.persist) {
    navigator.storage.persisted?.()
      .then(already => (already ? null : navigator.storage.persist()))
      .catch(() => {});
  }

  // The Lolly Chrome extension (if installed) provides page capture in the browser.
  // It's detected synchronously via a flag it sets at document_start, so this adds
  // no startup cost. When present, the 'capture' capability un-greys URL Screenshot.
  const extCapture = hasCaptureExtension();

  const host = {
    version: '1',
    shell: 'web',
    // What this shell can fulfil. Tools needing anything outside this set (e.g.
    // 'capture') are gated in the gallery and tool view. Other shells override
    // capabilities-provided.js to declare their own set.
    capabilities: extCapture ? [...PROVIDED_CAPABILITIES, 'capture'] : PROVIDED_CAPABILITIES,
    log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: object) =>
      console[level === 'debug' ? 'log' : level](`[${level}]`, msg, ctx ?? ''),
  } as WebHost;

  // Order matters: assets depends on db; export depends on host for watermark style.
  host.state = createStateAPI(db);
  host.profile = createProfileAPI(db);
  // Shell-internal like previews (not part of HostV1): Content Credentials device
  // identity + CA cert. A lazy facade — all five methods are async, and its only
  // callers are the /profile view's credentials card and tool-actions' signer
  // choice, both far past first paint. Its cross-tab BroadcastChannel is built
  // with the impl, which is correct: a tab that never touches identity has no
  // cached record to invalidate.
  const loadIdentity = memo(async () => (await import('./identity.ts')).createIdentityAPI(db));
  host.identity = {
    status: async () => (await loadIdentity()).status(),
    completeEnrollment: async (token, days) => (await loadIdentity()).completeEnrollment(token, days),
    enroll: async (provider, opts) => (await loadIdentity()).enroll(provider, opts),
    signer: async () => (await loadIdentity()).signer(),
    forget: async () => (await loadIdentity()).forget(),
  } as WebHost['identity'];
  // Web-only host-UI helper (not in the tool-facing contract): cache of
  // profile-personalized gallery thumbnails. The gallery feature-detects it.
  host.previews = createPreviewsAPI(db);
  // `pick` is attached below (line ~99), so the factory return is intentionally
  // missing it here; the cast reconciles that with the AssetsAPI-typed field.
  host.assets = createAssetsAPI(db as unknown as Parameters<typeof createAssetsAPI>[0]) as unknown as WebHost['assets'];
  host.tokens = createTokensAPI(host as unknown as Parameters<typeof createTokensAPI>[0]); // depends on assets (reads the brand tokens asset)
  host.clipboard = createClipboardAPI();

  // Lazy export facade: build (and cache) the real 90 KB export bridge on first
  // export — always a user gesture (Get/Save), never on the gallery landing. Keeps
  // it out of the boot chunk. All three ExportAPI methods are async, so the facade
  // is transparent to callers.
  let exportImpl: WebHost['export'] | null = null;
  const loadExport = async (): Promise<WebHost['export']> => {
    if (!exportImpl) { const { createExportAPI } = await import('./export.ts'); exportImpl = createExportAPI(host); }
    return exportImpl;
  };
  host.export = {
    render: async (node, format, opts) => (await loadExport()).render(node, format, opts),
    download: async (blob, filename) => (await loadExport()).download(blob, filename),
    file: async (blob, opts) => (await loadExport()).file(blob, opts),
  };

  // Lazy compose facade: compose renders CHILD tools through the same bridge, so it
  // statically pulls in the render runtime (Handlebars) + tool loader (Ajv) — ~90 KB
  // gz the gallery never needs. Built + cached on first compose/embed. Exposes the
  // web-only `_describeUrl` host-UI helper alongside the ComposeAPI contract.
  type WebComposeImpl = Awaited<ReturnType<typeof import('./compose.ts')['createComposeAPI']>>;
  let composeImpl: WebComposeImpl | null = null;
  const loadCompose = async (): Promise<WebComposeImpl> => {
    if (!composeImpl) { const { createComposeAPI } = await import('./compose.ts'); composeImpl = createComposeAPI(host); }
    return composeImpl;
  };
  host.compose = {
    render: async (spec) => (await loadCompose()).render(spec),
    renderUrl: async (url, opts) => (await loadCompose()).renderUrl!(url, opts),
    _describeUrl: async (url: string) => (await loadCompose())._describeUrl(url),
  } as WebHost['compose'];

  // Fail-closed boot default — an EMPTY allowlist, never mutated. A tool that
  // declares network.allowlist gets a per-mount HOST CLONE with a scoped net
  // instead: views/tool.ts (the live canvas), views/multi-edit.ts (each member's
  // runtime), and pro/render-export.ts withToolNet (offscreen batch/zip/compose).
  const loadNet = memo(async () => (await import('./net.ts')).createNetAPI({ allowlist: [] }));
  host.net = { fetch: async (url, init) => (await loadNet()).fetch(url, init) };

  const loadText = memo(async () => (await import('./text.ts')).createTextAPI());
  host.text = {
    toPath: async (opts) => (await loadText()).toPath(opts),
    preload: async (fontUrl) => (await loadText()).preload(fontUrl),
    axisDefaults: async (fontUrl) => (await loadText()).axisDefaults!(fontUrl),
    fontUrl: async (family, opts) => (await loadText()).fontUrl!(family, opts),
  } as WebHost['text'];

  // on-device PDF metadata inspect + strip/compress (pdf-lib, itself lazy inside)
  const loadPdf = memo(async () => (await import('./pdf.ts')).createPdfAPI());
  host.pdf = {
    analyze: async (bytes) => (await loadPdf()).analyze(bytes),
    strip: async (bytes) => (await loadPdf()).strip(bytes),
    compress: async (bytes, opts) => (await loadPdf()).compress!(bytes, opts),
  } as WebHost['pdf'];

  // on-device .pptx inspect + surgical rebrand (fflate + engine pptx-read/pptx-patch)
  const loadPptx = memo(async () => (await import('./pptx.ts')).createPptxAPI());
  host.pptx = {
    inspect: async (bytes, o) => (await loadPptx()).inspect(bytes, o),
    rebrand: async (bytes, plan) => (await loadPptx()).rebrand(bytes, plan),
  } as WebHost['pptx'];

  // Extension when installed (real capture in the browser); otherwise the stub
  // that throws a clear error. In Tauri, capture.js is overridden to the native impl.
  // Which of the two it is stays a SYNCHRONOUS decision (the extension sets its flag
  // at document_start, and `capabilities` above already read it) — only the impl is lazy.
  const loadCapture = memo(async () => extCapture
    ? (await import('./capture-extension.ts')).createExtensionCaptureAPI()
    : (await import('./capture.ts')).createCaptureAPI());
  host.capture = { page: async (spec) => (await loadCapture()).page(spec) } as WebHost['capture'];
  // Live camera frames (v1.4) for motion-reactive tools. Progressive enhancement,
  // NOT a gated capability: a tool with an onFrame hook offers a "live" toggle only
  // where the camera is available, and runs as a still tool otherwise.
  host.media = createMediaAPI();
  // Device capture (v1.17) — mic (and optionally camera) recording + a live audio
  // level meter. Unlike media this IS capability-gated ('microphone'/'camera'),
  // because record() prompts for a grant; the meter/record affordances still
  // feature-detect host.recorder.isAvailable() at the point of use.
  host.recorder = createRecorderAPI();
  // host.color (perceptual colour tools, v1.40) and host.geom (path booleans,
  // offset, stroke-to-fill, spline lowering, hit testing, v1.64) are pure engine
  // math attached verbatim so web/CLI/Tauri can never drift — but they are also
  // ~39 KB gz between them (makeColorApi eagerly reaches the ICC/gamut parsers;
  // makeGeomApi reaches the whole bezier/boolean kernel), and NOTHING in this
  // shell reads either one: `grep -rn 'host\.color\|host\.geom' shells/web/src`
  // finds only this file. Their only consumers are TOOL HOOKS, which cannot run
  // before a runtime exists. So they are installed by installToolApis() below,
  // awaited at the single chokepoint every runtime goes through
  // (lib/mount-runtime.ts's createToolRuntime). Both contracts are SYNCHRONOUS
  // (`deltaE` returns a number, `union` returns a path — not promises), so a
  // lazy facade like host.images is not available here; a pre-mount await is.
  // MilkDrop availability + preset attribution (v1.72). `isAvailable` is
  // contractually SYNCHRONOUS, so — exactly like host.audio below — it is answered
  // here by the same lib/viz-support probe the real impl calls, imported directly
  // rather than re-typed so the two cannot drift; `presets` is async and lazy.
  const loadViz = memo(async () => (await import('./viz.ts')).createVizAPI());
  host.viz = {
    isAvailable: () => vizSupported(),
    presets: async () => (await loadViz()).presets(),
  } as WebHost['viz'];

  // Lazy images facade (v1.60): decode/resize/re-encode wraps the upload path's
  // codec glue (and, inside it, the 3 MB lazy HEIC WASM decoder) — none of which
  // belongs in the boot chunk. Built + cached on first host.images call; every
  // ImagesAPI method is async, so the facade is transparent to callers.
  let imagesImpl: NonNullable<WebHost['images']> | null = null;
  const loadImages = async (): Promise<NonNullable<WebHost['images']>> => {
    if (!imagesImpl) { const { createImagesAPI } = await import('./images.ts'); imagesImpl = createImagesAPI(); }
    return imagesImpl;
  };
  host.images = {
    decode: async (input) => (await loadImages()).decode(input),
    resize: async (input, opts) => (await loadImages()).resize(input, opts),
    encode: async (input, opts) => (await loadImages()).encode(input, opts),
  };

  // Lazy audio facade (v1.71) — decode + per-frame analysis. Lazy for the same
  // reason as images: it reaches the ZzFXM renderer and (for procedural song refs)
  // the sequence providers, none of which belongs in the boot chunk. `isAvailable`
  // is contractually SYNCHRONOUS, so it is answered here from feature detection
  // rather than behind the import — the same two things audio.ts itself checks.
  let audioImpl: NonNullable<WebHost['audio']> | null = null;
  const loadAudio = async (): Promise<NonNullable<WebHost['audio']>> => {
    if (!audioImpl) { const { createAudioAPI } = await import('./audio.ts'); audioImpl = createAudioAPI(); }
    return audioImpl;
  };
  host.audio = {
    isAvailable: () => typeof Worker === 'function'
      && (typeof window.OfflineAudioContext === 'function'
        || typeof (window as { webkitOfflineAudioContext?: unknown }).webkitOfflineAudioContext === 'function'),
    analyse: async (src, opts) => (await loadAudio()).analyse(src, opts),
  };

  // pick is a bridge-level concern: it needs the full host (logging, assets.get,
  // assets._uploadUserAsset). Defined here after all sub-APIs are wired so the
  // closure over `host` is complete by the time pick() is actually called.
  host.assets.pick = async (opts: AssetPickerOpts): Promise<AssetRef | null> => {
    const { openPicker } = await import('../views/picker.ts');
    return openPicker(host as unknown as Parameters<typeof openPicker>[0], opts) as Promise<AssetRef | null>;
  };

  return host;
}

/**
 * Install the two synchronous, tool-hook-only engine APIs — `host.color`
 * (v1.40) and `host.geom` (v1.64) — that createBridge() deliberately leaves
 * off the boot path (see the comment where they used to be attached).
 *
 * Idempotent and safe to call concurrently: the in-flight promise is cached, so
 * N runtimes mounting at once share one import. Every path that mounts a tool
 * MUST await this first; do not call it directly — go through
 * lib/mount-runtime.ts's createToolRuntime(), which is the enforced chokepoint.
 *
 * Failure is non-fatal by design: both APIs are OPTIONAL in the v1 contract and
 * tools feature-detect them, so a failed import degrades a colour/vector tool to
 * its own fallback rather than blocking the mount.
 */
let toolApiModules: Promise<{ color: HostV1['color']; geom: HostV1['geom'] }> | null = null;
export async function installToolApis(host: HostV1): Promise<void> {
  // Cache the MODULES, not the install: multi-edit and pro/render-export mount
  // runtimes against per-mount host CLONES (scoped net, thumb assets), so the
  // attach step has to run for whichever host object this call was handed.
  if (!toolApiModules) {
    toolApiModules = Promise.all([
      import('../../../../engine/src/color-tools.ts'),
      import('../../../../engine/src/geom-api.ts'),
    ]).then(([c, g]) => ({ color: c.makeColorApi(), geom: g.makeGeomApi() }));
  }
  try {
    const apis = await toolApiModules;
    host.color ??= apis.color;
    host.geom ??= apis.geom;
  } catch (err) {
    toolApiModules = null; // let a later mount retry
    console.warn('[warn] could not install host.color/host.geom', err);
  }
}
