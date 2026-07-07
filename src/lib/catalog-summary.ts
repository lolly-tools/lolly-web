// SPDX-License-Identifier: MPL-2.0
/**
 * Catalogue summary — a shared, read-only overview of what ships in this build:
 * the tools (grouped by category, tagged by status) and the brand-asset library
 * (grouped by type). Rendered on BOTH the Dashboard (#/d) and at the foot of the
 * Profile page (#/profile) from ONE source so the two can't drift.
 *
 * Every item type — tool category, tool status, and asset type — carries a
 * Lucide-house icon so the grid reads at a glance. The tools half is known
 * synchronously from window.__toolIndex; the brand-asset counts are filled in
 * after first paint by hydrateCatalogAssets() (a fetch of the asset index), so a
 * caller can paint immediately and the counts fade in when they land.
 */

import { escape } from '../utils.ts';

/** The slice of a catalogue-index tool entry this summary reads (the index shape
 *  is a build artifact, not a domain type the engine owns — see PlatformTool /
 *  GalleryTool for the same local-projection precedent). */
export interface CatalogTool {
  id: string;
  category?: string;
  status?: string;
}

// Lucide-house glyphs (viewBox 0 0 24 24, stroke = currentColor). One per item
// type, plus a generic fallback for each family so a new category/status/type
// added to the data still renders with *an* icon rather than a blank tile.
const svg = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICON = {
  // Tool categories.
  everyone: svg('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
  designer: svg('<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>'),
  event: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>'),
  product: svg('<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>'),
  utility: svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
  categoryOther: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>'),
  // Tool statuses.
  official: svg('<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>'),
  experimental: svg('<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>'),
  community: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  statusOther: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>'),
  // Asset types.
  vector: svg('<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>'),
  raster: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),
  audio: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  lottie: svg('<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M2 9h5"/><path d="M2 15h5"/><path d="M17 9h5"/><path d="M17 15h5"/>'),
  palette: svg('<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>'),
  tokens: svg('<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>'),
  assetOther: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
} as const;

const categoryIcon = (k: string): string => ICON[k as keyof typeof ICON] ?? ICON.categoryOther;
const statusIcon = (k: string): string =>
  k === 'official' || k === 'experimental' || k === 'community' ? ICON[k] : ICON.statusOther;
const assetIcon = (k: string): string =>
  ({ vector: ICON.vector, raster: ICON.raster, audio: ICON.audio, lottie: ICON.lottie, palette: ICON.palette, tokens: ICON.tokens })[k] ??
  ICON.assetOther;

// Friendlier display labels where the raw index key is terse/techy; everything
// else falls back to a capitalised key.
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const LABEL: Record<string, string> = {
  everyone: 'For everyone', utility: 'Utilities', product: 'Products', event: 'Events',
  raster: 'Raster', vector: 'Vector', lottie: 'Lottie', palette: 'Palettes', tokens: 'Tokens',
};
const label = (k: string): string => LABEL[k] ?? cap(k);

/** Count items by a key, returned largest-group first. */
function countBy<T>(items: readonly T[], key: (t: T) => string): Array<[string, number]> {
  const counts: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// One icon tile: big count, glyph, label. Used for tool categories & asset types.
function tile(icon: string, count: number, name: string): string {
  return `
    <div class="cat-tile">
      <span class="cat-tile-icon">${icon}</span>
      <span class="cat-tile-num">${count}</span>
      <span class="cat-tile-label">${escape(name)}</span>
    </div>`;
}

// A compact icon chip for the secondary "by status" row.
function tag(icon: string, count: number, name: string): string {
  return `<span class="cat-tag"><span class="cat-tag-icon">${icon}</span><strong>${count}</strong>${escape(name)}</span>`;
}

/**
 * The full catalogue-summary body: a "Tools" group (category tiles + status
 * chips, known synchronously) and a "Brand assets" group whose grid is a
 * placeholder until hydrateCatalogAssets() fills it. The caller wraps this in its
 * own section chrome (a Platform <details> panel / a Profile card).
 */
export function catalogSummaryBody(tools: readonly CatalogTool[]): string {
  const byCategory = countBy(tools, (t) => t.category ?? 'other');
  const byStatus = countBy(tools, (t) => t.status ?? 'official');
  return `
    <div class="cat-summary">
      <section class="cat-group">
        <h3 class="cat-group-title">Tools <span class="cat-group-count">${tools.length}</span></h3>
        <div class="cat-grid">
          ${byCategory.map(([k, n]) => tile(categoryIcon(k), n, label(k))).join('') || '<p class="cat-empty">none loaded</p>'}
        </div>
        ${byStatus.length ? `<div class="cat-tags">${byStatus.map(([k, n]) => tag(statusIcon(k), n, label(k))).join('')}</div>` : ''}
      </section>

      <section class="cat-group" data-asset-block>
        <h3 class="cat-group-title">Brand assets <span class="cat-group-count" data-asset-count hidden></span></h3>
        <div class="cat-grid" data-asset-grid><p class="cat-empty">reading…</p></div>
      </section>
    </div>`;
}

interface AssetSummary {
  total: number;
  byType: Array<[string, number]>;
}

// Brand-asset catalogue summary — best-effort; absent offline is fine. No
// `cache: 'no-store'` so a repeat visit reuses the HTTP cache (these figures only
// feed the read-only counts).
async function fetchAssetSummary(): Promise<AssetSummary | null> {
  try {
    const resp = await fetch('/catalog/assets/index.json');
    if (!resp.ok) return null;
    // Response.json() is `any` in lib.dom; the parsed index is an array of
    // entries or an object wrapping one under `assets`.
    const idx = await resp.json();
    const arr = Array.isArray(idx) ? idx : idx.assets ?? [];
    return { total: arr.length, byType: countBy(arr, (a: { type?: string }) => a.type ?? 'other') };
  } catch {
    return null;
  }
}

/**
 * Fill the "Brand assets" group inside a rendered summary (found under `root`).
 * Safe to call after the caller has moved on: it writes nothing when the target
 * is gone. Returns once the fetch resolves (best-effort; leaves the placeholder
 * on failure).
 */
export async function hydrateCatalogAssets(root: HTMLElement): Promise<void> {
  const block = root.querySelector<HTMLElement>('[data-asset-block]');
  if (!block) return;
  const grid = block.querySelector<HTMLElement>('[data-asset-grid]');
  const assets = await fetchAssetSummary();
  if (!grid || !block.isConnected) return;
  if (!assets) {
    grid.innerHTML = '<p class="cat-empty">unavailable offline</p>';
    return;
  }
  const count = block.querySelector<HTMLElement>('[data-asset-count]');
  if (count) {
    count.textContent = String(assets.total);
    count.hidden = false;
  }
  grid.innerHTML = assets.byType.map(([k, n]) => tile(assetIcon(k), n, label(k))).join('');
  grid.classList.add('cat-hydrated');
}
