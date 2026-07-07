// SPDX-License-Identifier: MPL-2.0
/**
 * Pre-rendered preview-look bundle (client side).
 *
 * The gallery's featured hero row and example-carousel tiles cross-fade each tool through
 * a handful of example LOOKS. Rendering those live on the client is the dominant first-load
 * cost — each look loads the engine, runs the tool off-screen, and fetches its own photos/
 * logos on the main thread (the measured LCP 8.3 s / TBT 730 ms — see featured-row.ts).
 *
 * `npm run previews` pre-renders each look to a committed SVGO'd SVG and build:catalog rolls
 * them into ONE catalog/previews/bundle.json. We fetch it ONCE (memoised, HTTP + service-
 * worker cached) and hand renderFeaturedVariant a ready <img> src per look — no engine, no
 * per-look asset request. A look that isn't in the bundle (not yet generated, or a profile-
 * personalised preview) simply falls through to the existing live render, so this is a pure
 * speed-up that degrades gracefully: an absent/failed bundle changes nothing but the timing.
 */

/** One look: an inline SVG string, or a path to a raster look; `sig` guards against staleness. */
interface BundleEntry { svg?: string; src?: string; sig?: string }

// Fetched at most once per page. Any failure resolves to {} → every look live-renders,
// exactly as before the bundle existed.
let bundlePromise: Promise<Record<string, BundleEntry>> | null = null;

export function loadPreviewBundle(): Promise<Record<string, BundleEntry>> {
  if (!bundlePromise) {
    bundlePromise = fetch('/catalog/previews/bundle.json')
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, BundleEntry>>) : {}))
      .catch(() => ({}));
  }
  return bundlePromise;
}

/**
 * A UTF-8 SVG data-URL — the same shape the app's own captureThumbnail emits
 * (`data:image/svg+xml,<uri-encoded>`), so it drops straight into an <img src>.
 * UTF-8 (not base64) keeps the URL ~25% smaller for text-heavy SVG.
 */
function svgToDataUrl(svg: string): string {
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/**
 * The ready <img> src for a pre-rendered look, or null to fall back to a live render.
 * `sig` is JSON.stringify(look.values) — a mismatch means the bundle predates a manifest
 * edit, so we reject it and let the live render (which uses the current values) win.
 */
export async function bundledLook(
  toolId: string,
  index: number,
  sig: string,
): Promise<string | null> {
  const bundle = await loadPreviewBundle();
  const entry = bundle[`${toolId}:${index}`];
  if (!entry) return null;
  if (entry.sig != null && entry.sig !== sig) return null;
  if (entry.svg) return svgToDataUrl(entry.svg);
  if (entry.src) return entry.src;
  return null;
}
