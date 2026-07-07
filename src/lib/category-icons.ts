// SPDX-License-Identifier: MPL-2.0
/**
 * Library-category glyphs — one Lucide-house icon per Catalog section, so a
 * category reads at a glance and identically everywhere it appears: the Catalog
 * view (views/catalog.ts) and the asset picker (views/picker.ts).
 *
 * Keys mirror LIB_GROUPS (lib/asset-category.ts) plus the sibling sections that
 * render alongside the tag-bucketed groups — 'swatches', 'fonts', 'uploads' — and
 * a couple of synonym aliases ('stock'→photos, 'type'→fonts, 'lottie'→animations)
 * so a caller using either name resolves. Deliberately SEPARATE from
 * lib/catalog-summary.ts's ICON map, which is a different taxonomy (tool
 * categories + asset TYPES like vector/raster) — merging would force one map to
 * carry the other's keys.
 */

// viewBox 0 0 24 24, stroke = currentColor, 18px — matches every other inline
// glyph in the shell (catalog.ts STAR_ICON/…, free-canvas SVG.*, the summary's
// svg()). Colour + vertical centring come from the header's flex layout.
const g = (paths: string): string =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// Shared glyphs (referenced by a canonical key AND a synonym alias below, and the
// grid is also the unknown-key fallback) — held as consts so the map has no
// index-typed self-reads.
const PHOTOS = g('<rect x="6" y="2" width="16" height="16" rx="2"/><path d="M18 22H4a2 2 0 0 1-2-2V6"/><circle cx="12" cy="8" r="2"/><path d="m22 13-1.3-1.3a2.4 2.4 0 0 0-3.4 0L11 18"/>');          // stacked images
const FONTS = g('<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>');                                                                                                              // serifed "T"
const ANIMATIONS = g('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>'); // film strip
const GRID = g('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'); // four-square

const CATEGORY_ICON: Record<string, string> = {
  // Content Credentials — a shield with a check (provenance / "made with Lolly").
  credentials: g('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
  // Logos — a hexagon brand mark with a struck centre.
  logos: g('<path d="M21 16.05V7.95a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4a2 2 0 0 0-1 1.73v8.1a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z"/><circle cx="12" cy="12" r="3"/>'),
  // Backgrounds — stacked layers (depth / fill behind everything).
  backgrounds: g('<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
  // Campaign Photos — a megaphone (a campaign / promotion).
  campaign: g('<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>'),
  // Photos (stock) — a stack of images.
  photos: PHOTOS,
  stock: PHOTOS,
  // Headshots — a head-and-shoulders portrait.
  headshots: g('<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>'),
  // Icons — the universal triangle / square / circle shapes mark.
  icons: g('<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>'),
  // Illustrations — a vector pen tool (drawn art).
  illustrations: g('<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/><path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"/><path d="m2.3 2.3 7.286 7.286"/><circle cx="11" cy="11" r="2"/>'),
  // Animations — a film strip (lottie / video motion).
  animations: ANIMATIONS,
  lottie: ANIMATIONS,
  // Swatches — a painter's palette (colour).
  swatches: g('<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>'),
  // Fonts (type) — a serifed "T".
  fonts: FONTS,
  type: FONTS,
  // Your uploads — an image with an up-arrow.
  uploads: g('<path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7"/><path d="m14 19.5 3-3 3 3"/><path d="M17 22.5v-6"/><circle cx="9" cy="9" r="2"/>'),
  // More / other — a four-square grid (the catch-all).
  other: GRID,
};

/**
 * Lucide-house glyph for a Catalog section key (a LIB_GROUPS key, or one of the
 * sibling sections 'swatches' / 'fonts' / 'uploads'). Falls back to the four-square
 * grid so an unknown key still renders an icon rather than a blank slot.
 */
export function categoryGlyph(key: string): string {
  return CATEGORY_ICON[key] ?? GRID;
}
