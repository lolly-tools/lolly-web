// SPDX-License-Identifier: MPL-2.0
/**
 * Web implementation of the v1 capability bridge.
 *
 * Each capability is in its own file; this index composes them. This makes it
 * easy to swap individual implementations (e.g. test doubles) without touching
 * the rest.
 */

import type { HostV1, AssetRef, AssetPickerOpts } from '../../../../engine/src/bridge/host-v1.ts';
import { makeColorApi } from '@lolly/engine';
import { createStateAPI } from './state.ts';
import { createProfileAPI } from './profile.ts';
import { createIdentityAPI } from './identity.ts';
import { createPreviewsAPI } from './previews.ts';
import { createAssetsAPI } from './assets.ts';
import { createTokensAPI } from './tokens.ts';
import { createClipboardAPI } from './clipboard.ts';
// export.ts (the 90 KB SVG/PDF/video bridge) and compose.ts (which statically pulls
// in the full render runtime — Handlebars — and the tool loader — Ajv) are NOT
// imported statically: they'd land in the boot chunk that the gallery landing loads
// before first paint, yet neither runs until a tool exports or composes. Both are
// wired below as lazy facades (dynamic import on first use), like host.assets.pick.
import { createNetAPI } from './net.ts';
import { createTextAPI } from './text.ts';
import { createPdfAPI } from './pdf.ts';
import { createPptxAPI } from './pptx.ts';
import { createCaptureAPI } from './capture.ts';
import { createMediaAPI } from './media.ts';
import { createRecorderAPI } from './recorder.ts';
import { hasCaptureExtension, createExtensionCaptureAPI } from './capture-extension.ts';
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
  identity: ReturnType<typeof createIdentityAPI>;
  previews: ReturnType<typeof createPreviewsAPI>;
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
  // Shell-internal like previews (not part of HostV1): Content Credentials device identity + CA cert.
  host.identity = createIdentityAPI(db);
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
  host.net = createNetAPI({ allowlist: [] });
  host.text = createTextAPI();
  host.pdf = createPdfAPI(); // on-device PDF metadata inspect + strip (pdf-lib, lazy-loaded)
  host.pptx = createPptxAPI(); // on-device .pptx inspect + surgical rebrand (fflate + engine pptx-read/pptx-patch, lazy-loaded)
  // Extension when installed (real capture in the browser); otherwise the stub
  // that throws a clear error. In Tauri, capture.js is overridden to the native impl.
  host.capture = extCapture ? createExtensionCaptureAPI() : createCaptureAPI();
  // Live camera frames (v1.4) for motion-reactive tools. Progressive enhancement,
  // NOT a gated capability: a tool with an onFrame hook offers a "live" toggle only
  // where the camera is available, and runs as a still tool otherwise.
  host.media = createMediaAPI();
  // Device capture (v1.17) — mic (and optionally camera) recording + a live audio
  // level meter. Unlike media this IS capability-gated ('microphone'/'camera'),
  // because record() prompts for a grant; the meter/record affordances still
  // feature-detect host.recorder.isAvailable() at the point of use.
  host.recorder = createRecorderAPI();
  // Perceptual colour tools (v1.40) — pure engine math, attached verbatim so
  // web/CLI/Tauri can never drift.
  host.color = makeColorApi();

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

  // pick is a bridge-level concern: it needs the full host (logging, assets.get,
  // assets._uploadUserAsset). Defined here after all sub-APIs are wired so the
  // closure over `host` is complete by the time pick() is actually called.
  host.assets.pick = async (opts: AssetPickerOpts): Promise<AssetRef | null> => {
    const { openPicker } = await import('../views/picker.ts');
    return openPicker(host as unknown as Parameters<typeof openPicker>[0], opts) as Promise<AssetRef | null>;
  };

  return host;
}
