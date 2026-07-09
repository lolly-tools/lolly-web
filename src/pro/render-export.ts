// SPDX-License-Identifier: MPL-2.0
/**
 * Pro / Batch mode — render one row to an export Blob, fully offscreen.
 *
 * Reuses the SAME engine render path as the single-tool view: loadTool →
 * createRuntime → hydrate → host.export.render. The only difference is that the
 * tool is mounted into a detached, off-viewport node instead of the visible
 * canvas. Because we go through runtime.export(), experimental-tool watermarking
 * is enforced for free (see engine/src/runtime.js).
 *
 * The render-lifecycle helpers (scopeCss / runTemplateScripts /
 * waitForQuiescence) are now shared with views/tool.js via ../lib/
 * (scope-css.ts + render-lifecycle.ts) instead of being hand-copied here, so
 * the batch/compose path can no longer drift from the live view (finding #4).
 */
import { createRuntime, toCssPx, serializeUrlState, packQuery, isPackAvailable, PACK_PARAM } from '@lolly/engine';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
import type { InputValue } from '../../../../engine/src/inputs.ts';
import type { Unit } from '../../../../engine/src/units.ts';

// Absolute short-form tool URL — `https://lolly.tools/t/<id>?<inputs>`, the human
// "open this tool" address (mirrors views/tool.js TOOL_URL_BASE + the domain
// buildEmbedUrl hardcodes). `query` is the already-encoded input/export params.
const LOLLY_ORIGIN = 'https://lolly.tools';
const toolShareUrl = (toolId: string, query: string): string => `${LOLLY_ORIGIN}/t/${toolId}${query ? `?${query}` : ''}`;

// Prefer the compressed `z=<token>` query for long links: a blocks-heavy tool (e.g. a
// wayfinding sign's `directions` JSON) serialises to a huge readable query, so we DEFLATE
// it into the reserved pack param whenever that actually shortens the URL. The reopen
// route (views/tool.js) runs expandQuery on load, so a packed `/t/<id>?z=…` reopens
// identically. Threshold is LOWER than the address bar's ~1800 (see tool.js AUTO_PACK_MIN):
// a lolly.txt link is copied, not hand-edited, so shortness beats readability. Never
// regresses — the packed form is only swapped in when it's strictly shorter.
const PACK_QUERY_MIN = 256;
async function preferCompactQuery(query: string): Promise<string> {
  if (!query || query.length < PACK_QUERY_MIN || !isPackAvailable()) return query;
  const token = await packQuery(query);
  const packed = token && `${PACK_PARAM}=${token}`;
  return packed && packed.length < query.length ? packed : query;
}
import { getTool, chooseFormat, isExportable } from '../bridge/tool-loader.ts';
import { neutralizeEmbeds, hydrateEmbeds } from '../bridge/embed.ts';
import { applyBrandVars } from '../brand-vars.ts';
import { scopeCss } from '../lib/scope-css.ts';
import { runTemplateScripts, waitForQuiescence } from '../lib/render-lifecycle.ts';
import { MOTION_EXPORT_FORMATS } from './folder-rows.ts';

// Re-exported for existing importers (pro/batch, pro/index, pro/sessions) that
// historically pulled these from here. The definitions now live in tool-loader.js
// so bridge/embed.js can share them without a circular import.
export { getTool, chooseFormat, isExportable };

const CANVAS_CLASS = 'pro-export-canvas';

// Motion export formats — captured as a live clip, not a single frame. When one of
// these is requested, the offscreen render feeds the tool's own clip settings
// (render.video) to the exporter's frame loop. Everything else exports one still.
// Single source of truth lives in folder-rows (also used by the batch exporter).
// Cap an embedded/composed clip's length so a nested render can't queue a huge
// real-time capture (Phase-1 buffers every frame) or a multi-MB data URL.
const EMBED_MAX_DURATION = 6;

/** One batch row: which tool to render and the input values to seed it with. */
interface BatchRow {
  toolId: string;
  values?: Record<string, InputValue>;
}

/** Preferred format + optional output dimensions for a batch render. */
interface RenderRowOpts {
  format?: string;
  width?: number;
  height?: number;
  unit?: Unit;
  dpi?: number;
  composeStack?: readonly string[];
  watermark?: boolean;
  embedMeta?: boolean;
  thumbnail?: boolean;
  /**
   * Resolve raster catalog assets to their small `thumb` derivative instead of the
   * full-res original. ONLY for gallery/preview thumbnails (featured row, personalized
   * tile previews) — NOT compose/batch/real exports, which need full resolution. Safe
   * for any asset: pickFormat falls back to the original when no thumb exists, and
   * vector/lottie/video assets ignore the hint. See scripts/build-thumbnails.ts.
   */
  thumbAssets?: boolean;
  /** AES-256 lock applied to a pdf/pdf-cmyk output (ignored for other formats). */
  strongPassword?: string;
}

/**
 * A shallow host wrapper whose asset resolver defaults raster lookups to the `thumb`
 * derivative format. The engine runtime resolves example photos via host.assets.get
 * during hydration; wrapping it here means a preview render ingests a ~30 KB thumbnail
 * instead of a 400 KB original — cutting both the fetch weight and the main-thread
 * rasterise cost of the gallery's featured row. host.assets methods are closures (not
 * `this`-bound), so a spread copy is safe.
 */
function withThumbAssets(host: HostV1): HostV1 {
  const assets = host.assets;
  return {
    ...host,
    assets: {
      ...assets,
      get: (id: string, opts: { format?: string; version?: string } = {}) =>
        assets.get(id, { ...opts, format: opts.format ?? 'thumb' }),
    },
  } as HostV1;
}

/**
 * Mount a tool's hydrated template into a fresh off-viewport stage and run the
 * shared post-paint settle. Both renderRowToBlob and renderToolPages go through
 * this so the offscreen lifecycle can't drift between them (they were two near-
 * identical copies), and — like the live view (views/tool.ts paint()) — BOTH
 * lottie AND <video> players are mounted: mountVideoPlayers resolves only once a
 * clip has a decoded frame, so a batch/compose/preview export snapshots a real
 * frame instead of a blank one (previously only lottie was mounted here, so a
 * `[data-video-key]` tool could export a not-yet-decoded frame).
 *
 * `fixedHeight` sets a stage/canvas height for the single-frame row path; omit it
 * for the paged path, which must lay out its full auto height so every page box is
 * measured. Returns the mounted { stage, canvas }; the caller exports from it and
 * MUST call stage._lottieCleanup?.() + stage.remove() in a finally. If the settle
 * itself throws, the stage is torn down here before rethrowing (no leak).
 */
async function mountToolCanvas(
  styles: string | null | undefined,
  hydrated: string,
  { layoutW, fixedHeight, composeStack, host }: { layoutW: number; fixedHeight?: number; composeStack?: readonly string[]; host: HostV1 },
): Promise<{ stage: ExportStage; canvas: HTMLDivElement }> {
  const stage: ExportStage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  // `contain:paint` makes the stage the containing block for `position:fixed` descendants (and
  // clips its paint to this box). Without it, a tool template's fixed element (e.g. text-helper's
  // Copy pill) positions against the VIEWPORT — not this left:-100000px stage — and flashes
  // on-screen for the ~350ms it's mounted; a viewport-unit-sized one flashes huge. Paint
  // containment doesn't contain size, so an auto-height stage still lays out fully.
  const heightCss = fixedHeight !== undefined ? `height:${fixedHeight}px;` : '';
  stage.style.cssText = `position:fixed;left:-100000px;top:0;width:${layoutW}px;${heightCss}contain:paint;pointer-events:none;z-index:-1;`;
  if (styles) {
    const style = document.createElement('style');
    style.textContent = scopeCss(styles, `.${CANVAS_CLASS}`);
    stage.appendChild(style);
  }
  const canvas = document.createElement('div');
  canvas.className = CANVAS_CLASS;
  canvas.style.cssText = fixedHeight !== undefined ? `width:${layoutW}px;height:${fixedHeight}px;` : `width:${layoutW}px;`;
  // Neutralise any lolly.tools embed URLs BEFORE insertion so this off-screen node
  // (batch row / composed child / single export) never fires a network request for
  // them — the live-preview wiring in views/tool.ts isn't on this path.
  canvas.innerHTML = neutralizeEmbeds(hydrated);
  stage.appendChild(canvas);
  document.body.appendChild(stage);

  try {
    // Brand semantic vars (--brand-primary, …) must reach EVERY path that mounts
    // tool markup (plans/brand-token-contract.md §3). This offscreen stage serves
    // /pro batch rows, compose children, featured renders and personalize
    // previews — the live view applies the same vars in mountTool (views/tool.ts),
    // so without this call a batch/compose render of a semantic-var template
    // would fall back to the template defaults and mismatch its direct export.
    // Awaited (unlike the live mount): an offscreen render exports immediately,
    // so the vars must be on the node before the settle/capture below.
    await applyBrandVars(canvas, host);
    runTemplateScripts(canvas);
    // Batch path historically settled a touch faster than the live view (350 vs
    // the shared 400ms default); preserved explicitly so extraction changed nothing.
    await waitForQuiescence(canvas, { silenceMs: 350 });
    // Resolve embeds to local blob/data URLs before export so the embedded render
    // appears in the output. The compose stack is threaded so an embed inside a
    // composed child stays guarded (undefined → [] for the paged path).
    await hydrateEmbeds(canvas, { host, embed: { stack: composeStack ?? [] } });
    // Lottie + video markers: the live view mounts both; the chunks load only when a
    // marker exists. Lottie players are OWNED (must be reaped → _lottieCleanup); video
    // is progressive enhancement that owns nothing, but its promise gates on a decoded
    // frame so the export isn't blank.
    if (canvas.querySelector('[data-lottie-src]')) {
      const { mountLottiePlayers, destroyLottiePlayers } = await import('../views/lottie-mount.ts');
      await mountLottiePlayers(canvas);
      stage._lottieCleanup = () => destroyLottiePlayers(canvas);
    }
    if (canvas.querySelector('video[data-video-key]')) {
      const { mountVideoPlayers } = await import('../views/video-mount.ts');
      await mountVideoPlayers(canvas);
    }
    return { stage, canvas };
  } catch (e) {
    stage._lottieCleanup?.();
    stage.remove();
    throw e;
  }
}

interface RenderRowResult {
  blob: Blob;
  format: string;
  url: string;
}

interface RenderPagesResult {
  pages: Blob[];
  format: string;
}

// The offscreen stage div also carries a per-render lottie-cleanup callback so
// the finally block can unregister any players it mounted.
type ExportStage = HTMLDivElement & { _lottieCleanup?: () => void };

/**
 * Render a single row and return { blob, format }.
 * @param {{toolId:string, values:object}} row
 * @param {HostV1} host
 * @param {{format?:string, width?:number, height?:number, unit?:string, dpi?:number}} opts
 *        preferred format + optional output dimensions. width/height are values
 *        in `unit` (px/mm/cm/in/pt); blank falls back to the tool's native size.
 *        `dpi` sets raster resolution for physical units.
 */
export async function renderRowToBlob(row: BatchRow, host: HostV1, { format, width, height, unit = 'px', dpi, composeStack, watermark, embedMeta, thumbnail, thumbAssets, strongPassword }: RenderRowOpts = {}): Promise<RenderRowResult> {
  const tool = await getTool(row.toolId);
  if (!isExportable(tool.manifest)) {
    throw new Error(`"${tool.manifest.name}" is render-only and cannot be exported.`);
  }

  const nativeW = tool.manifest.render.width;
  const nativeH = tool.manifest.render.height;

  // Establish the requested ASPECT at canvas creation — not at export. When both
  // dimensions are given we render the (responsive) tool into a box of that
  // aspect, in CSS px, so its layout adapts correctly. The export then does a
  // uniform unit→medium scale (no squashing). Blank → the tool's native size.
  const bothGiven = width !== undefined && width > 0 && height !== undefined && height > 0;
  const layoutW = bothGiven ? Math.max(1, Math.round(toCssPx({ value: width as number, unit }))) : nativeW;
  const layoutH = bothGiven ? Math.max(1, Math.round(toCssPx({ value: height as number, unit }))) : nativeH;

  // Feed the layout size to a tool's width/height inputs (if it declares them),
  // so hook-driven responsive tools recompute — mirrors the single-tool preview.
  const seeded: Record<string, InputValue> = { ...(row.values ?? {}) };
  const inputIds = new Set((tool.manifest.inputs ?? []).map(i => i.id));
  if (bothGiven) {
    if (inputIds.has('width')  && seeded.width  == null) seeded.width  = layoutW;
    if (inputIds.has('height') && seeded.height == null) seeded.height = layoutH;
  }
  // composeStack threads tool-id recursion state down when this render is itself
  // a composed child (set by the compose bridge); undefined for normal batch rows.
  const runtime = await createRuntime(tool, thumbAssets ? withThumbAssets(host) : host, seeded, { composeStack });

  // Export dimension qualified with the unit (px / mm / cm / in / pt) so the
  // engine converts per format; blank falls back to the native canvas size.
  const dim = (v: number | undefined): string | number | undefined => (v !== undefined && v > 0 ? (unit && unit !== 'px' ? `${v}${unit}` : v) : undefined);
  const outW = dim(width);
  const outH = dim(height);

  const { stage, canvas } = await mountToolCanvas(tool.styles, runtime.getHydrated(), { layoutW, fixedHeight: layoutH, composeStack, host });

  try {
    const fmt = chooseFormat(tool.manifest, format);
    // A "reopen in Lolly" link: this tool's short URL carrying the exact inputs +
    // export settings used for THIS render, so a zip recipient can return to
    // lolly.tools and recreate (or tweak) the file. Serialised from the live model so
    // values encode the same compact way the address bar does. Surfaced in the zip's
    // lolly.txt (see creditText in pro/zip.js); ignored on the compose/thumbnail paths.
    // Thumbnail/preview callers discard `url`, so skip serialising (+ its occasional
    // native DEFLATE) entirely on that path — only real exports (batch, compose child) need it.
    const url = thumbnail ? '' : toolShareUrl(tool.manifest.id, await preferCompactQuery(serializeUrlState(runtime.getModel(), {
      format: fmt, width, height, unit, dpi: unit !== 'px' ? dpi : undefined,
    })));
    // watermark/embedMeta/thumbnail are forwarded only when set (compose passes
    // watermark:false + embedMeta:false so an embedded child isn't stamped); batch
    // rows leave them undefined so runtime.export keeps its normal defaults.
    const exportOpts: { width?: string | number; height?: string | number; dpi?: number; watermark?: boolean; embedMeta?: boolean; thumbnail?: boolean; strongPassword?: string; wait?: number; duration?: number; fps?: number } = { width: outW, height: outH, dpi };
    if (watermark !== undefined) exportOpts.watermark = watermark;
    if (embedMeta !== undefined) exportOpts.embedMeta = embedMeta;
    if (thumbnail !== undefined) exportOpts.thumbnail = thumbnail;
    // Motion format → capture a short clip. Its settle time + length come from the
    // tool's own render.video declaration (the same values the single-tool export bar
    // uses), with the length clamped so a composed/embedded render stays bounded. The
    // exporter (renderVideo / renderGif) reads wait/duration/fps; still formats ignore them.
    if (MOTION_EXPORT_FORMATS.has(fmt)) {
      const vid = (tool.manifest.render as { video?: { wait?: number; duration?: number; fps?: number } }).video ?? {};
      exportOpts.wait = vid.wait ?? 1;
      exportOpts.duration = Math.min(vid.duration ?? 5, EMBED_MAX_DURATION);
      if (vid.fps) exportOpts.fps = vid.fps;
    }
    // Strong-lock PDF outputs only; the export bridge ignores it for non-pdf formats.
    if (strongPassword && (fmt === 'pdf' || fmt === 'pdf-cmyk')) exportOpts.strongPassword = strongPassword;
    const blob = await runtime.export(canvas, fmt, exportOpts);
    return { blob, format: fmt, url };
  } finally {
    stage._lottieCleanup?.(); // destroyed players unregister from animationManager
    stage.remove();
  }
}

/**
 * Render a PAGED tool (manifest render.paged — a document that lays out several
 * `[data-pdf-page]` boxes, e.g. multi-page-pdf) and return ONE export blob PER PAGE, so
 * a caller can show each page as its own preview. Mirrors renderRowToBlob's offscreen
 * mount, but the canvas is left auto-height (every page box is laid out and measured,
 * not clipped to one page) and each page element is exported individually. A single
 * page's geometry is simple — it renders cleanly and, unlike the whole stacked-pages
 * SVG, doesn't choke resvg. Falls back to a single whole-canvas export for a tool that
 * declares no page boxes.
 */
export async function renderToolPages(row: BatchRow, host: HostV1, { format, thumbnail, thumbAssets }: RenderRowOpts = {}): Promise<RenderPagesResult> {
  const tool = await getTool(row.toolId);
  if (!isExportable(tool.manifest)) {
    throw new Error(`"${tool.manifest.name}" is render-only and cannot be exported.`);
  }
  const layoutW = tool.manifest.render.width;   // one page's native size

  const runtime = await createRuntime(tool, thumbAssets ? withThumbAssets(host) : host, { ...(row.values ?? {}) });

  // No fixed height: let the document lay out its FULL height so every page box is
  // measured (page boxes are fixed-size, so they render identically whether or not
  // the viewport clips them).
  const { stage, canvas } = await mountToolCanvas(tool.styles, runtime.getHydrated(), { layoutW, host });

  try {
    const fmt = chooseFormat(tool.manifest, format);
    // Each page box is exported on its own; no page boxes → export the whole canvas once.
    const pageEls = [...canvas.querySelectorAll<HTMLElement>('[data-pdf-page]')];
    const targets: HTMLElement[] = pageEls.length ? pageEls : [canvas];
    const pages: Blob[] = [];
    for (const el of targets) {
      pages.push(await runtime.export(el, fmt, { watermark: false, embedMeta: false, thumbnail }));
    }
    return { pages, format: fmt };
  } finally {
    stage._lottieCleanup?.();
    stage.remove();
  }
}
