// SPDX-License-Identifier: MPL-2.0
/**
 * Featured-tile variant renderer.
 *
 * The gallery's cinematic hero row (components/featured-row.ts) cross-fades each
 * featured tool through a handful of example input value-sets (manifest.featured
 * .variants). Each look is a REAL render — produced by the same off-screen engine
 * path a normal export takes (renderRowToBlob) — so the row is a live demonstration
 * of "one tool, many on-brand outputs", not a set of static screenshots.
 *
 * Renders are expensive, so each result is memoised in host.previews (the same
 * regenerable cache the profile-personalized previews use) under a synthetic key —
 * `featured:<toolId>:<index>` — with a `sig` of the variant values. Re-visiting the
 * gallery reuses the cached data-URL; editing a variant's values invalidates it.
 * The synthetic key can't collide with a real toolId, so it never disturbs the
 * personalized-preview records keyed by tool id.
 */

// render-export (→ createRuntime → Handlebars + tool loader → Ajv) is imported LAZILY
// inside the render helpers below — the featured row mounts on the gallery landing, and
// a static import would pull the whole render engine onto the render-blocking boot chunk.
// The variant thumbnails render post-paint (the cross-fade builds up), so it loads then.
import { rasterToThumbnailDataUrl } from './raster-thumb.ts';
import { bundledLook } from './preview-bundle.ts';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
import type { PreviewsAPI } from '../bridge/previews.ts';

type FeaturedHost = HostV1 & { previews?: PreviewsAPI };

// Raster formats a featured tile can display as an <img>. A tool with none can
// still be featured — it just shows its committed preview with no live variants.
const RASTER_FORMATS = ['png', 'jpg', 'jpeg', 'webp'];

/** The first raster export format a tool declares, or null if it has none. */
export function rasterFormatOf(formats: readonly string[] | undefined): string | null {
  if (!Array.isArray(formats)) return null;
  return formats.find((f) => RASTER_FORMATS.includes(f)) ?? null;
}

/**
 * The format to render a preview look in. Lolly is vector-first, so SVG wins when a
 * tool exports it — the thumbnail stays crisp at any tile size, it works for vector-only
 * tools (e.g. multi-page-pdf, which has no raster format at all), and the vector export
 * path serialises the DOM instead of rasterising a canvas, so it renders even in a
 * backgrounded tab (no rAF-gated paint). Falls back to the first raster format, then null.
 */
export function displayFormatOf(formats: readonly string[] | undefined): string | null {
  if (!Array.isArray(formats)) return null;
  if (formats.includes('svg')) return 'svg';
  return rasterFormatOf(formats);
}

/** Read any blob to a data-URL as-is (used for SVG — no rasterise/downscale needed). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Render one look at an exact format, cached by (tool, index, format). */
// In-flight renders, keyed by cacheKey. The featured hero row and the gallery
// carousel both call renderVariantAt for the same look during the post-load window;
// without this, each ~350ms offscreen render (+ main-thread raster) runs twice
// concurrently. Both callers share one promise; evicted on settle so failures retry.
const inflight = new Map<string, Promise<string>>();

async function renderVariantAt(
  host: FeaturedHost,
  toolId: string,
  format: string,
  variantIndex: number,
  values: Record<string, unknown>,
): Promise<string> {
  // Format is part of the key: a tool that once cached a raster look and now renders
  // vector (svg) must not return the stale raster thumbnail on a matching `sig`.
  const cacheKey = `featured:${toolId}:${variantIndex}:${format}`;
  const sig = JSON.stringify(values);
  const cached = await host.previews?.get(cacheKey).catch(() => null);
  if (cached && cached.sig === sig && cached.thumb) return cached.thumb;

  const hit = inflight.get(cacheKey);
  if (hit) return hit;

  const p = (async () => {
    // Per-example dimensions: when a look declares width/height (as inputs, in its values),
    // render the preview at THAT aspect rather than the tool's native canvas — so a
    // reflow-first tool like color-block can showcase tall / wide / square / banner looks in
    // one strip. Absent or non-positive → native size (unchanged for every other tool).
    const vw = Number((values as { width?: unknown }).width);
    const vh = Number((values as { height?: unknown }).height);
    const dims = vw > 0 && vh > 0 ? { width: vw, height: vh } : {};
    const { renderRowToBlob } = await import('../pro/render-export.ts');
    const { blob } = await renderRowToBlob(
      // values arrives as JSON (Record<string, unknown>); the render row types it as
      // InputValue — the runtime coerces per the input's declared type, so cast the row.
      { toolId, values } as Parameters<typeof renderRowToBlob>[0],
      host,
      { format, watermark: false, embedMeta: false, thumbnail: true, thumbAssets: true, ...dims },
    );
    // SVG is already display-ready and resolution-independent — embed it verbatim as a
    // data-URL. A raster blob is downscaled to a gallery-weight PNG thumbnail.
    const thumb = format === 'svg' ? await blobToDataUrl(blob) : await rasterToThumbnailDataUrl(blob);
    await host.previews?.put(cacheKey, { thumb, sig }).catch(() => { /* cache is best-effort */ });
    return thumb;
  })();
  inflight.set(cacheKey, p);
  try { return await p; } finally { inflight.delete(cacheKey); }
}

/**
 * Render (or reuse a cached) featured-tile variant and return a thumbnail data-URL.
 * `values` is the manifest variant's input map — seeded into the render exactly the
 * way URL params are. watermark/embedMeta are off: this is a showcase thumbnail, not
 * a deliverable.
 *
 * Vector-first: renders at displayFormatOf (SVG when the tool lists it). If that throws
 * — an svg-less tool, or one the HTML→SVG walker can't handle — and the tool also has a
 * raster format, it falls back to raster so the preview still shows rather than vanishing.
 */
export async function renderFeaturedVariant(
  host: FeaturedHost,
  toolId: string,
  formats: readonly string[] | undefined,
  variantIndex: number,
  values: Record<string, unknown>,
): Promise<string> {
  // Pre-rendered look from the build bundle (npm run previews → build:catalog) — an instant
  // ready <img> src with no engine load and no per-look asset fetch, shared by the featured
  // hero and every example carousel (both funnel through here). Falls through to the live
  // render below when the look isn't bundled (not yet generated / profile-personalised) or
  // the bundle is stale (sig mismatch), so this only ever speeds up, never changes output.
  const bundled = await bundledLook(toolId, variantIndex, JSON.stringify(values));
  if (bundled) return bundled;

  const primary = displayFormatOf(formats);
  if (!primary) throw new Error(`no displayable export format for ${toolId}`);
  try {
    return await renderVariantAt(host, toolId, primary, variantIndex, values);
  } catch (e) {
    const raster = rasterFormatOf(formats);
    if (primary === 'svg' && raster && raster !== primary) {
      return await renderVariantAt(host, toolId, raster, variantIndex, values);
    }
    throw e;
  }
}

/** Render one page set at an exact format, cached as a JSON array of data-URLs. */
async function renderPagesAt(host: FeaturedHost, toolId: string, format: string): Promise<string[]> {
  const cacheKey = `featured:${toolId}:pages:${format}`;
  const cached = await host.previews?.get(cacheKey).catch(() => null);
  if (cached?.thumb) {
    try { const arr = JSON.parse(cached.thumb); if (Array.isArray(arr) && arr.length) return arr; } catch { /* re-render */ }
  }
  const { renderToolPages } = await import('../pro/render-export.ts');
  const { pages } = await renderToolPages(
    { toolId, values: {} } as Parameters<typeof renderToolPages>[0],
    host,
    { format, thumbnail: true, thumbAssets: true },
  );
  const urls: string[] = [];
  for (const blob of pages) urls.push(format === 'svg' ? await blobToDataUrl(blob) : await rasterToThumbnailDataUrl(blob));
  // Stash the whole array under one synthetic key (distinct from the per-variant keys).
  await host.previews?.put(cacheKey, { thumb: JSON.stringify(urls), sig: 'pages' }).catch(() => { /* best-effort */ });
  return urls;
}

/**
 * Render (or reuse cached) previews of EVERY PAGE of a paged tool (render.paged) and
 * return one data-URL per page. Vector-first with the same raster fallback as
 * renderFeaturedVariant. Used by the gallery tile's preview strip so a multi-page doc
 * scrolls through its actual pages instead of one cramped all-pages thumbnail.
 */
export async function renderFeaturedPages(
  host: FeaturedHost,
  toolId: string,
  formats: readonly string[] | undefined,
): Promise<string[]> {
  const primary = displayFormatOf(formats);
  if (!primary) throw new Error(`no displayable export format for ${toolId}`);
  try {
    return await renderPagesAt(host, toolId, primary);
  } catch (e) {
    const raster = rasterFormatOf(formats);
    if (primary === 'svg' && raster && raster !== primary) {
      return await renderPagesAt(host, toolId, raster);
    }
    throw e;
  }
}
