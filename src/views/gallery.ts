// SPDX-License-Identifier: MPL-2.0
/**
 * Gallery view — preview-forward masonry of available tools.
 *
 * Each tool is a card. When the tool has a saved session, the card leads with a
 * preview of the most-recent one at its natural aspect (portrait previews show
 * in full — no crop, no letterbox); the masonry packs the varying heights.
 * Tools with no session show a compact "open to start" tile instead.
 *
 * Feature flags hide whole categories; the remaining categories surface as
 * single-select filter pills, so any mix of flags just reflows the grid.
 *
 * Two per-card actions open modals: (i) tool info (formats + details) and
 * (h) history — the full list of that tool's saved sessions (resume / delete).
 */

import { escape } from '../utils.ts';
import { t } from '../i18n.ts';
import { footerNav, gallerySearchBox } from '../components/footer-nav.ts';
import { toolSupport, capabilityLabel } from '../capabilities.ts';
import { hiddenCategories, flagEnabled, PRO_FLAG } from '../feature-flags.ts';
import { syncCatalog } from '../catalog/sync.ts';
import { privacyNoticeMarkup, mountPrivacyNotice } from './privacy-notice.ts';
import { personalizeNudgeMarkup, mountPersonalizeNudge } from './personalize-nudge.ts';
import { profileSignature, canPersonalize, regeneratePreviews } from '../personalize-previews.ts';
import { viewToggle } from '../components/view-toggle.ts';
import { attachProfileMenu } from '../components/profile-menu.ts';
import { langFabHtml, attachLangMenu } from '../components/lang-menu.ts';
import { mountFeaturedRow, resolveExamples } from '../components/featured-row.ts';
import { previewMedia } from '../lib/preview-media.ts';
import { renderFeaturedVariant, renderFeaturedPages, displayFormatOf } from '../lib/featured-render.ts';
import { currentTheme } from '../theme.ts';
import { themeSegmentHtml, wireThemeSegment } from '../components/theme-toggle.ts';
import { soundSegmentHtml, wireSoundSegment } from '../components/sound-toggle.ts';
import type { FeaturedEntry, FeaturedManifest, FeaturedVariant, FeaturedRowHandle, FeaturedViewMode } from '../components/featured-row.ts';
import { loadFavourites, saveFavourites } from '../lib/favourites.ts';
import { confirmDialog } from '../components/confirm-dialog.ts';
import { announce } from '../a11y.ts';
import { playSfx, playGalleryAah, cancelArrivalAah } from '../lib/sfx.ts';

import type { HostV1, StateEntry } from '../../../../engine/src/bridge/host-v1.ts';
import { toolSeedHref } from '../lib/seed-url.ts';
import type { WebStateAPI } from '../bridge/state.ts';
import type { WebProfileAPI } from '../bridge/profile.ts';
import type { createAssetsAPI } from '../bridge/assets.ts';
import type { WebTokensAPI } from '../bridge/tokens.ts';
import type { PreviewsAPI, PreviewRecord } from '../bridge/previews.ts';

/**
 * The slice of a catalog index entry that this view reads. Kept local: the index
 * is a denormalised, gallery-facing projection of the tool manifest, not a domain
 * type the engine owns.
 */
interface GalleryTool {
  id: string;
  name: string;
  description?: string;
  version?: string;
  status?: string;
  category?: string;
  capabilities?: readonly string[];
  privacy?: string;
  listed?: boolean;   // false = unlisted from the gallery (a mechanism invoked from context, e.g. asset-export)
  formats?: readonly string[];
  width?: number;
  height?: number;
  unit?: string;
  exportable?: boolean;
  icon?: string;
  preview?: string;
  personalized?: boolean;
  featured?: FeaturedManifest;
  examples?: FeaturedVariant[];
  paged?: boolean;
  new?: boolean;
}

// Sort options for the gallery masonry. 'category' (the default) groups tools by
// their catalog category (offline utilities last, see categoryRank); 'recent'
// surfaces the most recently-added tools first — the featured content the hero leads with.
type SortKey = 'recent' | 'az' | 'za' | 'format' | 'category';
const SORT_KEYS: readonly SortKey[] = ['recent', 'az', 'za', 'format', 'category'];
const SORT_LABELS: Record<SortKey, string> = {
  recent: 'Recently updated',
  az: 'Name (A–Z)',
  za: 'Name (Z–A)',
  format: 'Format',
  category: 'Category',
};
const SORT_KEY_STORAGE = 'lolly-gallery-sort';
// Featured hero view mode: the current strip ('gallery') or the Cover Flow player-select.
const FEATURED_VIEWS: readonly FeaturedViewMode[] = ['gallery', 'coverflow'];
const FEATURED_VIEW_LABELS: Record<FeaturedViewMode, string> = { gallery: 'Gallery', coverflow: 'Cover Flow' };
const FEATURED_VIEW_STORAGE = 'lolly-featured-view';
// Sort DIRECTION, orthogonal to the key: 'desc' is each label's natural order
// (Recently updated = newest first, A→Z, …); 'asc' reverses it so the last
// results show first. Persisted alongside the sort key.
type SortDir = 'desc' | 'asc';
const SORT_DIR_STORAGE = 'lolly-gallery-sort-dir';
// How many trailing catalog entries (newest-appended) wear the "New" badge. The
// catalog preserves authoring order and appends new tools, so the tail is genuinely
// the newest — this stays honest and self-expiring as more tools ship.
const NEW_COUNT = 5;
// Most example looks a gallery tile's preview strip will show (after the lead slide).
// Keeps the carousel DOM + the number of live renders per tile bounded.
const EXAMPLE_MAX = 6;

/** A saved-session entry as returned by host.state.list(). */
type SavedEntry = StateEntry & { filename: string | null; thumb: string | null };

/**
 * The host surface the gallery touches: HostV1 plus the web-shell extras this view
 * uses (WebStateAPI's richer list/sizes, WebProfileAPI's set, the concrete assets
 * factory's private user-asset helpers, and the previews cache). The web shell's
 * concrete WebHost interface is not exported, so this is reconstructed from the
 * factory return types.
 */
type GalleryHost = HostV1 & {
  state: WebStateAPI;
  profile: WebProfileAPI;
  assets: ReturnType<typeof createAssetsAPI>;
  tokens?: WebTokensAPI;
  previews?: PreviewsAPI;
};

// Section order for the filter pills. 'utility' is intentionally absent: the
// on-device Offline Utilities pill always sorts last (see categoryRank()).
const CATEGORY_ORDER = ['everyone', 'designer', 'event', 'product'];

function categoryRank(cat: string): number {
  if (cat === 'utility') return Infinity;
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

// Short category names for the filter pills / card sub-lines — distinct from the
// longer feature-flag labels (e.g. "Tools for Everyone") shown in profile settings.
const CAT_LABEL: Record<string, string> = { everyone: 'Everyone', designer: 'Designer', event: 'Event', utility: 'Utilities' };
const catLabel = (c: string | undefined) => CAT_LABEL[c as string] || (c ? c[0]!.toUpperCase() + c.slice(1) : 'Other');
const statusLabel = (s: string | undefined) => ({ official: 'Official', community: 'Community', experimental: 'Experimental' } as Record<string, string>)[s as string] || s;

// Export-format display labels (mirrors the subset used by the tool view).
const FMT_LABEL: Record<string, string> = {
  'pdf-cmyk': 'Print PDF', 'cmyk-tiff': 'Print TIFF', tiff: 'TIFF', jpeg: 'JPG', jpg: 'JPG',
  webm: 'WebM', mp4: 'MP4', emf: 'EMF', eps: 'EPS', 'eps-cmyk': 'EPS (CMYK)', dxf: 'DXF', pptx: 'PowerPoint',
  ics: 'Calendar', vcf: 'vCard', ico: 'Icon',
  zip: 'ZIP', csv: 'CSV', json: 'JSON', svg: 'SVG', 'svg-anim': 'Animated SVG', pdf: 'PDF', png: 'PNG',
  webp: 'WebP', 'webp-anim': 'Animated WebP', avif: 'AVIF', html: 'HTML', md: 'Markdown', txt: 'Text', gif: 'GIF', apng: 'aPNG',
};
const fmtLabel = (f: string) => FMT_LABEL[f] ?? String(f).toUpperCase();

// Export-format families, so the info dialog can group + order chips (vector first,
// then raster, then motion, then data) rather than dumping the raw manifest order.
// Mirrors engine VECTOR_FORMATS (inputs.ts) plus the raster/video/data buckets.
type FmtKind = 'vector' | 'raster' | 'video' | 'data';
const FMT_KIND: Record<string, FmtKind> = {
  svg: 'vector', 'svg-anim': 'vector', pdf: 'vector', 'pdf-cmyk': 'vector',
  eps: 'vector', 'eps-cmyk': 'vector', emf: 'vector', dxf: 'vector',
  png: 'raster', jpg: 'raster', jpeg: 'raster', webp: 'raster', 'webp-anim': 'raster',
  avif: 'raster', gif: 'raster', apng: 'raster', tiff: 'raster', 'cmyk-tiff': 'raster', ico: 'raster',
  webm: 'video', mp4: 'video',
};
const fmtKind = (f: string): FmtKind => FMT_KIND[f] ?? 'data';
// Group order + human label for the dialog's chip sections.
const FMT_KIND_ORDER: readonly FmtKind[] = ['vector', 'raster', 'video', 'data'];
const FMT_KIND_LABEL: Record<FmtKind, string> = { vector: 'Vector', raster: 'Raster', video: 'Video', data: 'Data' };

// "1080 × 1080 px" — the tool's intended output canvas (render.width/height carried
// into the index entry, at the manifest unit; px when unset). Empty when a tool
// declares no size, so callers can drop the line entirely.
function dimText(tool: GalleryTool | undefined): string {
  const w = tool?.width, h = tool?.height;
  if (!w || !h) return '';
  const u = tool!.unit && tool!.unit !== 'px' ? tool!.unit : 'px';
  return `${w} × ${h} ${u}`;
}

// Shared, /pro-free batch-slot helpers (finding #13) — the gallery still takes
// zero dependency on the removable /pro folder.
import { BATCH_SLOT_PREFIX, isBatchSlot } from '../lib/batch-slots.ts';

// Lucide "info" and "history" — per-card action icons (own stroke-width, so the
// thin .tool-card-icon rule doesn't apply to them).
const INFO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
const HISTORY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>';

// Lucide "star" — the per-card favourite toggle. Filled via CSS when active (.is-fav).
const STAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
// Sentinel category id for the starred-favourites filter (not a real catalog category).
const FAV_CAT = 'favourites';

// Lucide "sliders-horizontal" — the filter trigger (collapses the category pills).
const FILTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>';

// (Footer nav links + their glyphs live in components/footer-nav.ts, shared with
// Projects and the Catalogue so all three bottom bars stay identical.)
// Sort-direction toggle — paired up/down arrows. CSS emphasizes the .sd-up or
// .sd-down group depending on the button's .is-asc state, so the lit arrow shows
// which way the results run.
const SORT_DIR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="sd-up"><path d="M8 20V5"/><polyline points="4 9 8 5 12 9"/></g><g class="sd-down"><path d="M16 4v15"/><polyline points="12 15 16 19 20 15"/></g></svg>';

// lucide "package" — placeholder thumbnail for batch sessions, which have no
// single render to show (they resume into #/pro).
const PACKAGE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';

// Lucide "chevron-left/right" — the preview-strip's prev/next affordances (fine-pointer
// only; touch just swipes). Decorative buttons, so aria-hidden.
const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

// Always-present backup art for a tile: the tool's own icon. The icon is INLINED into
// the catalog index (never a network fetch), so unlike a committed preview PNG/SVG — a
// build artifact that can 404 on a fresh install / before `npm run previews` — it can
// never fail to load. It sits BEHIND every preview image and carousel (z-index:-1, see
// gallery.css .gtile-iconfill) as an instant, on-brand placeholder while lazy art
// decodes, and as the permanent fallback if a preview is missing or errors — so a gallery
// tile never shows a broken image or an empty box. '' when a tool has no icon (rare — the
// tile's checkerboard background still stands in).
function iconBackdrop(icon: string | undefined): string {
  if (!icon) return '';
  // Two stacked copies of the icon: a static muted BASE, and a green TRACE on top
  // whose stroke-dasharray leaves only a short segment drawn and whose animated
  // stroke-dashoffset walks that green segment along the icon's outline — a "drawing"
  // shimmer shown WHILE a preview is still loading. The trace is transparent wherever
  // it isn't currently stroking, so the muted base shows through (green passes over a
  // stretch, then it's muted again). CSS stops the trace once art loads / on the
  // permanent icon-only fallback / under reduced-motion (see .gtile-iconfill in gallery.css).
  return `<span class="gtile-iconfill" aria-hidden="true">`
    + `<span class="gtile-iconfill-base">${icon}</span>`
    + `<span class="gtile-iconfill-trace">${icon}</span>`
    + `</span>`;
}

/**
 * The theme-filtered example looks for a tool's gallery preview strip, each paired with
 * its ORIGINAL index in the manifest list (the render cache key `featured:<id>:<i>` is
 * keyed on that index, so it's shared with the featured hero row and stays stable
 * whichever looks the current theme filters in). Capped at EXAMPLE_MAX. Empty for a
 * tool with no examples, no raster format, or one the shell can't run.
 */
function galleryExampleLooks(tool: GalleryTool, darkTheme: boolean): Array<{ v: FeaturedVariant; i: number }> {
  if (!displayFormatOf(tool.formats)) return [];
  return resolveExamples(tool)
    .map((v, i) => ({ v, i }))
    // Same theme filter as the featured row: a reverse/white look on a light tile (or a
    // dark look on a dark tile) would be near-invisible on the checkerboard backdrop.
    .filter(({ v }) => !v.theme || (v.theme === 'dark') === darkTheme)
    .slice(0, EXAMPLE_MAX);
}

// Entrance reveal. Cold load wants "wow, instant" with a quick build-up; an
// IntersectionObserver gives us both: the above-the-fold tiles fire in the first
// callback and cascade by a tiny per-tile delay, while everything below fades in
// only as it scrolls into view (the mobile single-column win). The CSS does the
// actual fade — JS just arms it (.reveal-armed) and toggles .is-in per tile.
// Returns the observer so the caller can disconnect it before the next render.
const REVEAL_STEP_MS = 30;  // delay between tiles within one reveal batch
// Reading order: top-to-bottom, then left-to-right within a row — a gentle wave that
// reads left-to-right regardless of the column-major order the masonry packs the DOM
// into. The 8px top-bucket tolerates sub-pixel row misalignment between columns.
// Each tile's geometry key is read ONCE (getBoundingClientRect forces layout), then we
// sort on the cached keys — a comparator that measured inside itself would re-read both
// operands O(n log n) times, thrashing layout for no reason.
function sortByReadingOrder<T extends Element>(els: T[]): T[] {
  const keyed = els.map(el => {
    const r = el.getBoundingClientRect();
    return { el, top: Math.round(r.top / 8), left: r.left };
  });
  keyed.sort((a, b) => (a.top - b.top) || (a.left - b.left));
  return keyed.map(k => k.el);
}
function reveal(el: HTMLElement, i: number): void {
  el.style.setProperty('--reveal-delay', `${i * REVEAL_STEP_MS}ms`);
  el.classList.add('is-in');
}
function revealCards(masonry: HTMLElement, animate: boolean): IntersectionObserver | null {
  // Not animating — returning from a tool, reduced motion, or no IO support:
  // leave tiles un-armed so the CSS renders them at full opacity immediately.
  if (!animate || typeof IntersectionObserver === 'undefined') {
    masonry.classList.remove('reveal-armed');
    return null;
  }
  masonry.classList.add('reveal-armed');
  const all = [...masonry.querySelectorAll<HTMLElement>('.gtile')];

  // First screen: reveal every currently-visible tile in ONE deterministic,
  // geometry-ordered pass. The old code leaned on the IntersectionObserver to deliver
  // the whole above-the-fold set in a single callback and sorted *that* — but on a cold
  // load the preview images decode and reflow the column masonry, so the set arrived
  // split across several callbacks, each restarting the stagger at 0. The top-right
  // cards (late in the column-major DOM order) landed in a later batch and animated
  // last. Ordering the visible set ourselves, up front, makes the left-to-right cascade
  // reliable and works even before the IO would have fired (e.g. a backgrounded tab).
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const inView: HTMLElement[] = [], below: HTMLElement[] = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    (r.top < vh && r.bottom > 0 ? inView : below).push(el);
  }
  sortByReadingOrder(inView).forEach(reveal);

  // Below the fold: fade in per tile as it scrolls into view. Each batch re-starts the
  // stagger at 0 so a late scroll never inherits a big delay.
  if (!below.length) return null;
  const io = new IntersectionObserver((entries, obs) => {
    sortByReadingOrder(entries.filter(e => e.isIntersecting).map(e => e.target as HTMLElement))
      .forEach((el, i) => { reveal(el, i); obs.unobserve(el); });
  // Pull the trigger up a touch from the bottom edge so scroll reveals read as
  // "fades in as it arrives" rather than only once fully on-screen.
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.02 });
  below.forEach(el => io.observe(el));
  return io;
}

// Demo-preview heroes (a tool with no saved session yet) start hidden on the cold
// paint and fade in per-card as each image decodes — so the first view never shows a
// broken/blank preview, and they "appear as they are" ready. Armed only on the first
// cold paint: when returning from a tool or re-rendering on a filter/search, previews
// must show instantly, and reduced motion opts out entirely (animate is false in all
// those cases, mirroring revealCards). Images already complete (warm cache / a
// re-arm) are revealed at once; the delegated load listener catches the rest and a
// cached 404 is left to the error handler, which morphs the hero to a text tile.
function armPreviewReveal(masonry: HTMLElement, animate: boolean): void {
  if (!animate) { masonry.classList.remove('previews-armed'); return; }
  masonry.classList.add('previews-armed');
  masonry.querySelectorAll<HTMLElement>('.gtile-hero--preview').forEach(hero => {
    const img = hero.querySelector<HTMLImageElement>('.gtile-hero-img');
    if (img?.complete && img.naturalWidth > 0) hero.classList.add('is-ready');
  });
}

export async function mountGallery(viewEl: HTMLElement, host: GalleryHost): Promise<void> {
  document.title = 'Lolly';
  // `window as unknown as …` bypasses the global Window['__toolIndex'] augmentation
  // (typed as the loosely-shaped ToolIndex in catalog/sync); this view reads it as the
  // denormalised GalleryTool slice. Erased cast — no runtime effect.
  const rawIndex: { tools: GalleryTool[] } = (window as unknown as { __toolIndex?: { tools: GalleryTool[] } }).__toolIndex ?? { tools: [] };
  // Unlisted tools (manifest `listed:false`) are mechanisms invoked from context — e.g.
  // asset-export, reached from the catalog's per-asset Download — not gallery destinations.
  // Drop them once, here, so every downstream membership set (grid, search, favourites,
  // featured + utility strips, pill counts) excludes them with no per-site guard. They
  // still load via #/tool/<id>, URL mode and the CLI — this only hides them from the listing.
  const index: { tools: GalleryTool[] } = { tools: rawIndex.tools.filter(t => t.listed !== false) };
  const [savedEntries, profile, sessionSizes] = await Promise.all([
    host.state.list(),
    host.profile.get(),
    host.state.sizes().catch((): Record<string, number> => ({})),
  ]);

  // Profile-personalized previews (see ../personalize-previews.js). `sig` is empty
  // unless the user opted in ("use my details"); only cache entries matching the
  // current sig are fresh — a stale one is ignored and re-rendered below. Held in a
  // Map so re-renders (search/filter) keep the personalized image, not just the
  // committed placeholder.
  const previewSig = profileSignature(profile);
  // Only deserialise the generated-previews store when personalization is on (the
  // default is off): it grows unboundedly with every rendered variant, so scanning it
  // on every gallery mount adds IDB read + deserialise latency before first paint for
  // nothing. The empty-sig path below already ignores cachedPreviews.
  const cachedPreviews = previewSig ? (await host.previews?.list().catch(() => []) ?? []) : [];
  const personalizedByTool = new Map<string, string>();
  if (previewSig) {
    for (const rec of cachedPreviews) {
      if (rec?.sig === previewSig && rec.thumb) personalizedByTool.set(rec.toolId, rec.thumb);
    }
  }

  // Per-tool saved sessions (newest first), batch sessions excluded — they have
  // no toolId and resume into #/pro, so they're not a tool's history.
  const entriesByTool = new Map<string, SavedEntry[]>();
  for (const entry of savedEntries) {
    if (isBatchSlot(entry.slot)) continue;
    if (!entriesByTool.has(entry.toolId)) entriesByTool.set(entry.toolId, []);
    // host.state.list() returns SavedEntry-shaped rows; the intersected host type widens
    // the element to the base StateEntry, so re-narrow at the push. Erased cast.
    entriesByTool.get(entry.toolId)!.push(entry as SavedEntry);
  }
  for (const arr of entriesByTool.values()) {
    arr.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  const latestByTool = (id: string): SavedEntry | undefined => entriesByTool.get(id)?.[0];
  const countByTool = (id: string): number => entriesByTool.get(id)?.length ?? 0;
  // Recent session previews (newest first) that a tool's tile can cross-fade through —
  // capped so a tool with dozens of saved works keeps its tile DOM bounded. Sessions
  // whose preview failed to capture (thumb === null) are skipped.
  const HERO_ROTATE_MAX = 5;
  const thumbsByTool = (id: string): string[] =>
    (entriesByTool.get(id) ?? [])
      .map(e => e.thumb)
      .filter((t): t is string => !!t)
      .slice(0, HERO_ROTATE_MAX);

  const toolById = new Map(index.tools.map(t => [t.id, t]));

  // Catalog order = authoring order with new tools appended, so a tool's position is
  // our recency signal: the index → position map drives the 'recent' sort, and the
  // trailing NEW_COUNT ids wear the "New" badge. Both read the whole catalog (not the
  // filtered view), so applying a filter never changes what counts as new/recent.
  const orderById = new Map(index.tools.map((t, i) => [t.id, i]));
  const newIds = new Set(index.tools.slice(-NEW_COUNT).map(t => t.id));
  // A tool is "new" if it's in the trailing window OR its manifest sets `new: true` —
  // the explicit flag keeps the badge on a tool we want highlighted even after later
  // tools ship and push it out of the positional tail.
  const isNew = (id: string): boolean => newIds.has(id) || toolById.get(id)?.new === true;

  // All saved sessions (tool + batch) newest first — the global drawer's list.
  const sortedSaved = [...savedEntries].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const nameById = new Map(index.tools.map(t => [t.id, t.name]));

  // Group by category; feature flags hide whole categories.
  const grouped: Record<string, GalleryTool[]> = {};
  for (const t of index.tools) (grouped[t.category ?? 'other'] ??= []).push(t);
  const hidden = hiddenCategories(profile);
  const proEnabled = flagEnabled(profile, PRO_FLAG.id);

  // The user's starred tools — held in memory for this mount, persisted to the profile
  // on every toggle. Read here (before the featured row) because a favourite is also
  // promoted INTO the featured hero strip — see featuredEntriesNow().
  const favourites = loadFavourites(profile);
  const isFav = (id: string): boolean => favourites.has(id);
  // Favourites visible in the current catalog (not hidden by a flag) — the pill count.
  const favCount = (): number => index.tools.filter(t => favourites.has(t.id) && !hidden.has(t.category)).length;

  // A catalog tool → a featured-strip entry. A tool with no manifest `featured` block
  // (a favourited plain tool) still gets one, falling back to its description as the
  // blurb — the same shape the Utilities strip uses.
  const toFeaturedEntry = (t: GalleryTool): FeaturedEntry => ({
    id: t.id, name: t.name, preview: t.preview, icon: t.icon, formats: t.formats,
    status: t.status, isNew: isNew(t.id), examples: t.examples,
    featured: t.featured ?? { blurb: t.description },
  });

  // Featured hero row — tools flagged `featured` in their manifest, PLUS the user's
  // favourites (starring a tool promotes it into the hero strip), minus any in a hidden
  // category (a category the user turned off shouldn't be promoted). Manifest-featured
  // lead (in their authored `order`); favourited-but-not-featured tools follow in catalog
  // order. Carries the "New" flag through. Recomputed on every star toggle (refreshFeatured).
  const featuredEntriesNow = (): FeaturedEntry[] => {
    const seen = new Set<string>();
    const out: FeaturedEntry[] = [];
    for (const t of index.tools) {
      if (t.featured && !hidden.has(t.category)) { out.push(toFeaturedEntry(t)); seen.add(t.id); }
    }
    for (const t of index.tools) {
      if (!seen.has(t.id) && favourites.has(t.id) && !hidden.has(t.category)) { out.push(toFeaturedEntry(t)); seen.add(t.id); }
    }
    return out;
  };
  const featuredEntries: FeaturedEntry[] = featuredEntriesNow();

  // Featured hero view mode (Gallery strip vs Cover Flow), persisted like the sort.
  // Declared here (before the markup) since the popover's segmented control reads it.
  let featuredView: FeaturedViewMode = 'gallery';
  try {
    const savedView = localStorage.getItem(FEATURED_VIEW_STORAGE);
    if (savedView && (FEATURED_VIEWS as readonly string[]).includes(savedView)) featuredView = savedView as FeaturedViewMode;
  } catch { /* storage off */ }

  // Utilities live in the grid like every other category now — their own "Utilities"
  // filter pill, always sorted LAST (categoryRank → Infinity). The old bottom carousel
  // is gone; a utility renders as a regular tile.
  const visibleCats = Object.keys(grouped)
    .filter(cat => !hidden.has(cat))
    .sort((a, b) => categoryRank(a) - categoryRank(b));

  // Render shell. The pill bar + masonry are filled by render(); the footer
  // (Pro link, search, info link) is left exactly as before.
  viewEl.classList.add('has-masonry');
  viewEl.innerHTML = `
    <div class="gallery${featuredEntries.length ? ' has-featured' : ''}">
      <h1 class="visually-hidden">${t('Lolly — tools gallery')}</h1>
      <div class="gallery-topbar">
        <div class="view-toggle-wrap">${viewToggle('tools')}</div>
        <div class="gallery-topright">
          ${visibleCats.length ? `<button type="button" class="filter-fab" aria-label="${escape(t('Sort and filter tools'))}" aria-haspopup="true" aria-expanded="false" aria-controls="filter-popover" title="${escape(t('Sort & filter'))}">${FILTER_ICON}</button>` : ''}
          ${sortedSaved.length ? `<button type="button" class="history-fab" title="${escape(t('Saved sessions'))}" aria-label="${escape(t('Saved sessions ({n})', { n: sortedSaved.length }))}">${HISTORY_ICON}<span class="history-fab-count" aria-hidden="true">${sortedSaved.length}</span></button>` : ''}
          ${langFabHtml()}
          <a href="#/profile" class="profile-link" aria-label="${escape(t('Open your profile'))}"><span class="profile-link-name">${escape(profile.firstname || t('Profile'))}</span></a>
          ${visibleCats.length ? `
          <div class="filter-popover" id="filter-popover" role="group" aria-label="${escape(t('Sort and filter tools'))}" hidden>
            <div class="filter-pop-sort">${themeSegmentHtml()}</div>
            <div class="filter-pop-sort">${soundSegmentHtml()}</div>
            ${featuredEntries.length ? `
            <div class="filter-pop-sort">
              <p class="filter-pop-head">${t('Featured view')}</p>
              <div class="view-seg" role="group" aria-label="${escape(t('Featured view'))}">
                ${FEATURED_VIEWS.map(v => `<button type="button" class="view-seg-btn" data-view="${v}" aria-pressed="${v === featuredView}">${escape(t(FEATURED_VIEW_LABELS[v]))}</button>`).join('')}
              </div>
            </div>` : ''}
            <div class="filter-pop-sort">
              <label class="filter-pop-head" for="gallery-sort">${t('Sort by')}</label>
              <div class="gallery-sort-row">
                <select class="gallery-sort" id="gallery-sort">
                  ${SORT_KEYS.map(k => `<option value="${k}">${escape(t(SORT_LABELS[k]))}</option>`).join('')}
                </select>
                <button type="button" class="gallery-sort-dir" id="gallery-sort-dir" aria-pressed="false" aria-label="${escape(t('Sort direction: newest first'))}" title="${escape(t('Reverse order'))}">${SORT_DIR_ICON}</button>
              </div>
            </div>
            <p class="filter-pop-head">${t('Filter')}</p>
            <div class="filter-pop-pills" aria-label="${escape(t('Filter tools by category'))}"></div>
            <label class="filter-pop-check">
              <input type="checkbox" class="filter-hide-previews">
              <span>${t('Hide previews')}</span>
            </label>
          </div>` : ''}
        </div>
      </div>
      ${visibleCats.length ? `<div class="filter-backdrop" hidden></div>` : ''}

      ${visibleCats.length === 0 ? (index.tools.length === 0 ? `
        <div class="gallery-empty" role="status">
          <p class="gallery-empty-title">${t("Couldn't load the tools.")}</p>
          <p class="gallery-empty-hint">${t('Check your connection, then {button}.', { button: `<button type="button" class="gallery-retry">${t('retry')}</button>` })}</p>
        </div>
      ` : `
        <div class="gallery-empty" role="status">
          <p class="gallery-empty-title">${t('It looks like there are no tools available.')}</p>
          <p class="gallery-empty-hint">${t('Try turning on categories in {link}.', { link: `<a href="#/profile?focus=feature-flags">${t('your feature flags')}</a>` })}</p>
        </div>
      `) : `
        ${featuredEntries.length ? '<div class="featured-mount"></div>' : ''}
        <p class="gallery-search-status visually-hidden" role="status" aria-live="polite"></p>
        <div class="tool-masonry"></div>
      `}

      ${footerNav({
        proEnabled,
        searchHtml: gallerySearchBox({ placeholder: t('Search tools…'), ariaLabel: t('Search tools') }),
      })}
      ${privacyNoticeMarkup()}
      ${personalizeNudgeMarkup(profile)}
    </div>
  `;

  mountPrivacyNotice(viewEl);
  mountPersonalizeNudge(viewEl, host);

  // Profile-pill avatar, resolved OFF the first-paint path: the headshot is a blob
  // fetch + createObjectURL (and the stored object URL goes stale across reloads, so
  // it must be re-fetched by id) — awaiting it before the initial innerHTML delayed
  // the whole gallery. The pill renders name-only immediately; once the headshot
  // resolves we swap the <img> in. Fire-and-forget; a failure just leaves the wordmark.
  if (profile.headshot?.id) {
    void host.assets.get(profile.headshot.id).then(res => {
      const url = res?.url;
      if (!url) return;
      const link = viewEl.querySelector<HTMLElement>('.profile-link');
      if (!link || !link.isConnected) return;
      let img = link.querySelector<HTMLImageElement>('.profile-link-avatar');
      if (!img) {
        img = document.createElement('img');
        img.className = 'profile-link-avatar';
        img.alt = '';
        link.prepend(img);
      }
      img.src = url;
      link.classList.add('has-avatar');
    }).catch(() => { /* no avatar — the name-only pill stands */ });
  }

  // Empty catalog: offer a re-sync without a full reload.
  viewEl.querySelector('.gallery-retry')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = t('Retrying…');
    await syncCatalog(host as unknown as Parameters<typeof syncCatalog>[0]);
    await mountGallery(viewEl, host);
  });

  const pillbar    = viewEl.querySelector<HTMLElement>('.filter-pop-pills'); // category pills now live in the filter popover
  const masonry    = viewEl.querySelector<HTMLElement>('.tool-masonry');

  // Cleanup registry — main.js's navigate() calls viewEl._cleanup on unmount. Both
  // the featured row (timers + drift loop) and the personalized-preview queue below
  // register their teardown here so neither keeps running after the user moves on.
  const cleanups: Array<() => void> = [];
  (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
    for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* best-effort teardown */ } }
  };

  // A single punchy, bassy, breathy "ahhh" on arrival at the gallery — one-shot (no loop),
  // gesture-gated, silent when sound is off. Cancel on leave so a pending one can't fire elsewhere.
  playGalleryAah();
  cleanups.push(() => cancelArrivalAah());

  // Mount the cinematic featured hero row (tools flagged `featured` in their manifest)
  // at the top, and a second strip at the very bottom showcasing the on-device
  // Utilities. Both render + cache their own looks lazily; the gallery toggles their
  // visibility as the search / filter / hide-previews state changes, and drives the
  // view mode (Gallery | Cover Flow) of both from one control.
  const featuredMount = viewEl.querySelector<HTMLElement>('.featured-mount');
  let featuredHandle: FeaturedRowHandle | null = null;
  cleanups.push(() => featuredHandle?.destroy());
  // (Re)mount the featured hero strip with the given entries, destroying any prior
  // instance first. Called on mount and again whenever favourites change (a starred tool
  // joins the strip). Toggles `has-featured` so the layout collapses if the strip empties.
  function mountFeatured(entries: FeaturedEntry[]): void {
    if (!featuredMount) return;
    featuredHandle?.destroy();
    featuredHandle = entries.length
      ? mountFeaturedRow(featuredMount, entries, host, { viewMode: featuredView })
      : null;
    viewEl.querySelector('.gallery')?.classList.toggle('has-featured', entries.length > 0);
  }
  // Rebuild the strip from the current favourites + manifest-featured set, then re-apply
  // visibility (a filtered / searched view keeps it hidden).
  function refreshFeatured(): void {
    mountFeatured(featuredEntriesNow());
    updateFeaturedVisibility();
  }
  if (featuredMount) mountFeatured(featuredEntries);
  // Featured view-mode segmented control (Gallery | Cover Flow) in the filter popover —
  // drives BOTH strips.
  // Scoped to the Featured-view seg specifically — the popover now also holds a Theme
  // .view-seg (added above), so a bare `.view-seg` query could grab the wrong one.
  const viewSeg = viewEl.querySelector<HTMLElement>('.view-seg[aria-label="Featured view"]');
  const paintViewSeg = (): void => viewSeg?.querySelectorAll<HTMLElement>('[data-view]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.view === featuredView)));
  wireThemeSegment(viewEl, host);   // Theme picker in the same popover
  wireSoundSegment(viewEl, host);   // Sound on/off segment in the same popover
  paintViewSeg();
  viewSeg?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-view]');
    if (!btn) return;
    const next = btn.dataset.view as FeaturedViewMode;
    const changed = next !== featuredView;
    featuredView = next;
    try { localStorage.setItem(FEATURED_VIEW_STORAGE, featuredView); } catch { /* storage off */ }
    paintViewSeg();
    featuredHandle?.setViewMode(featuredView);
    // Each mode has its own character: Cover Flow = cool & futuristic, Gallery = refined.
    if (changed) playSfx(featuredView === 'coverflow' ? 'coverflow' : 'gallery');
  });
  // Landing state only: the strip is noise above a searched/filtered grid. It is KEPT
  // (collapsed to icon + text via .hide-previews) when previews are off — it doesn't
  // disappear, so the featured picks stay reachable.
  function updateFeaturedVisibility(): void {
    const show = !query && activeCat === 'all';
    if (featuredMount && featuredHandle) { featuredMount.hidden = !show; featuredHandle.setVisible(show); }
  }

  // A demo preview can be absent — it's a build artifact (catalog/previews/) that,
  // though committed, can be missing on a fresh checkout / before `npm run previews`,
  // or drift from the index. The hero img then errors; drop the broken <img> and let
  // the always-present icon backdrop (rendered behind every preview) stand in, so the
  // card shows the tool's own icon rather than a broken image — never a blank or
  // broken tile. Error events don't bubble, so listen in the capture phase. Saved-
  // session thumbs are data: URLs and never hit this path.
  masonry?.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('gtile-hero-img')) return;
    const hero = img.closest('.gtile-hero--preview');
    if (!hero) return; // a saved-session hero failing is handled elsewhere; only demo previews
    // Reveal the hero: the armed cascade keys off .is-ready, normally added on img
    // *load* — which now never fires — so add it here or the tile stays invisible
    // under .previews-armed. The icon backdrop behind the (now-removed) img shows through.
    img.remove();
    hero.classList.add('is-ready', 'gtile-hero--icononly');
  }, true);

  // Demo previews start hidden on the cold paint (the masonry is "previews-armed" —
  // see armPreviewReveal) and fade in only once their image has actually decoded, so
  // the first view never flashes a blank or half-loaded preview — each appears on its
  // own as it arrives. Like the error handler above, load doesn't bubble → capture.
  masonry?.addEventListener('load', (e) => {
    // A committed preview is usually an <img>, but an animated HTML card is an <iframe>
    // (see previewMedia) — both fire a capture-phase load, and both reveal the hero.
    const el = e.target;
    if (!((el instanceof HTMLImageElement || el instanceof HTMLIFrameElement) && el.classList.contains('gtile-hero-img'))) return;
    el.closest('.gtile-hero--preview')?.classList.add('is-ready');
  }, true);

  // First-visit "open what you see": a left-click on an example preview — or anywhere on a
  // card whose strip is currently showing an example look — opens the tool SEEDED with that
  // exact look, rather than a blank session. So the carousel state you're looking at is the
  // first setup you land in (openExample). Modified / middle clicks fall through to the
  // slide's plain href, so cmd/ctrl/middle-click still open a fresh tab. Delegated on the
  // persistent masonry node (attached once) so it survives the innerHTML rebuilds in render().
  masonry?.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as HTMLElement;
    // Controls with their own behaviour (fav/info/history/resume, carousel nav/dots) already
    // stopPropagation or preventDefault; skip anything inside them defensively.
    if (target.closest('.gcar-nav, .gcar-dot, [data-fav], [data-info], [data-history], [data-resume]')) return;
    const tile = target.closest<HTMLElement>('.gtile');
    const gcar = tile?.querySelector<HTMLElement>('.gcar');
    if (!tile || !gcar) return;
    // A click landing ON an example slide uses THAT slide; a click on the card's name / body
    // uses whichever look is currently centred. Either way, null → not an example (paged page,
    // resume frame, or no strip) → leave the default new-session open untouched.
    const clickedSlide = target.closest<HTMLElement>('.gcar-slide[data-ex-index]');
    const idx = clickedSlide ? Number(clickedSlide.dataset.exIndex) : activeExampleIndex(gcar);
    if (idx === null || Number.isNaN(idx)) return;
    e.preventDefault();
    void openExample(tile.dataset.toolId!, idx, tile);
  });

  const searchInput = viewEl.querySelector<HTMLInputElement>('.gallery-search')!;
  const searchStatus = viewEl.querySelector<HTMLElement>('.gallery-search-status');
  const filterFab  = viewEl.querySelector<HTMLButtonElement>('.filter-fab');
  const filterPop  = viewEl.querySelector<HTMLElement>('.filter-popover');
  const filterBackdrop = viewEl.querySelector<HTMLElement>('.filter-backdrop');

  let activeCat = 'all';   // active category pill
  let query = '';          // current search text (lowercased)
  let sortKey: SortKey = 'category';   // global sort default; persisted like the theme
  try {
    const saved = localStorage.getItem(SORT_KEY_STORAGE);
    if (saved && (SORT_KEYS as readonly string[]).includes(saved)) sortKey = saved as SortKey;
  } catch { /* storage off */ }
  let sortDir: SortDir = 'desc';   // 'asc' reverses whatever key is active (last results first)
  try {
    const savedDir = localStorage.getItem(SORT_DIR_STORAGE);
    if (savedDir === 'asc' || savedDir === 'desc') sortDir = savedDir;
  } catch { /* storage off */ }
  // Entrance reveal runs the cascade once, on the cold mount — not when returning
  // from a tool (cards are already known) nor on filter/search re-renders (those
  // show instantly). Tracked here so render() can decide and disconnect cleanly.
  const isReturning = viewEl.classList.contains('is-returning');
  const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  // Which theme-tagged example looks the tiles show (transparent-ink looks are filtered
  // to the matching UI theme — see galleryExampleLooks). Read once at mount, like the
  // featured row; switching theme refreshes on the next gallery visit.
  const darkTheme = currentTheme() !== 'light';
  let firstPaint = true;
  let revealObserver: IntersectionObserver | null = null;

  // Ambient cross-fade for tiles with several saved sessions — the tile cycles
  // through that tool's recent session previews (the same dissolve the featured
  // strip uses). ONE timer scans the DOM each tick, so it survives the masonry
  // re-renders that search / filter / favourite toggles trigger without any
  // per-render re-wiring. Work is staggered across phases (tiles don't all flip
  // at once), and skips tiles that are off-screen or hovered (leave the one the
  // user is aiming at still). Paused wholesale while the tab is hidden; disabled
  // outright under prefers-reduced-motion. Torn down via the cleanup registry.
  const HERO_ROTATE_MS = 2100;
  const HERO_ROTATE_PHASES = 3;
  if (!prefersReduced) {
    let heroTick = 0;
    const heroTimer = setInterval(() => {
      if (document.hidden || !masonry) return;
      heroTick++;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      // Read every hero's rect in ONE pass up front, then act — measuring inside the
      // loop would interleave layout reads with the class writes below and thrash.
      const heroes = [...masonry.querySelectorAll<HTMLElement>('.gtile-hero--rotate')];
      const heroRects = heroes.map(h => h.getBoundingClientRect());
      heroes.forEach((hero, i) => {
        if (i % HERO_ROTATE_PHASES !== heroTick % HERO_ROTATE_PHASES) return; // stagger
        const r = heroRects[i]!;
        if (!r.width) return;                      // filtered-out (display:none) tile
        if (r.bottom < 0 || r.top > vh) return;   // off-screen — don't animate
        if (hero.matches(':hover')) return;        // let the user look while aiming
        const frames = [...hero.querySelectorAll<HTMLImageElement>('.gtile-hero-frame')];
        // Only cross-fade to a DECODED frame — a not-yet-decoded one would fade in
        // blank. Until ≥2 have decoded the tile just holds its first frame.
        const ready = frames.filter(f => f.complete && f.naturalWidth > 0);
        if (ready.length < 2) return;
        const cur = ready.findIndex(f => f.classList.contains('is-active'));
        const next = (cur + 1 + ready.length) % ready.length;
        frames.forEach(f => f.classList.remove('is-active'));
        ready[next]!.classList.add('is-active');
      });
    }, HERO_ROTATE_MS);
    cleanups.push(() => clearInterval(heroTimer));
  }

  // ── Example preview strips (carousels) ──────────────────────────────────────
  // A tile with manifest `examples` is a horizontally-scrollable strip: the newest saved
  // session (if any) then a few live-rendered example states. Each example <img> is empty
  // in the markup and rendered lazily — serial, on idle, cached in host.previews under the
  // same `featured:<id>:<i>` key the hero row uses — only once its tile nears the viewport,
  // so a gallery full of example-bearing tools never fires hundreds of off-screen renders.
  const ricIdle = (cb: () => void): number =>
    (typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 60)) as unknown as number;
  const exJobs: Array<() => Promise<void>> = [];
  let exRunning = false;
  const pumpEx = (): void => {
    if (exRunning) return;
    const job = exJobs.shift();
    if (!job) return;
    exRunning = true;
    ricIdle(() => { void job().finally(() => { exRunning = false; pumpEx(); }); });
  };
  // A paged tool (multi-page-pdf): render each page and rebuild the strip's slides +
  // dots from them (page count is unknown until rendered). The track element persists,
  // so its listeners survive; nav/dots are delegated off .gcar (see wireCarousel).
  async function hydratePaged(gcar: HTMLElement, toolId: string, tool: GalleryTool): Promise<void> {
    if (gcar.dataset.pagedDone === '1') return;
    let urls: string[];
    try {
      urls = await renderFeaturedPages(host, toolId, tool.formats);
    } catch (e) {
      host.log?.('warn', `Gallery pages failed for ${toolId}`, { error: String((e as { message?: unknown })?.message ?? e) });
      return;
    }
    const track = gcar.querySelector<HTMLElement>('.gcar-track');
    if (!gcar.isConnected || !track || !urls.length) return;
    gcar.dataset.pagedDone = '1';
    const openHref = `#/tool/${escape(toolId)}`;
    // Multi-page content reads as a swipeable STACK, not a flat carousel — the same
    // language as carousel-maker's featured card. Show the first few pages as an offset,
    // slightly-rotated deck (front page on top, the rest peeking behind). Cap at 3: enough
    // to say "multiple pages" without clutter; the real page-by-page view is the tool.
    const shown = urls.slice(0, 3);
    const pages = shown.map((u, k) =>
      // --d = depth: 0 = front (on top), higher = further back. Positioned + z-ordered in CSS.
      `<img class="gcar-deck-page" style="--d:${k}" src="${u}" alt="" aria-hidden="true" decoding="async">`,
    ).join('');
    track.outerHTML =
      `<a class="gcar-open gcar-deck" href="${openHref}" data-new-tool="${escape(toolId)}" tabindex="-1" aria-hidden="true">${pages}</a>`;
    gcar.classList.add('has-art', 'gcar--deck');   // pages rendered → stop the waiting tracer
    // The deck is a static preview — it has no per-page nav/dots (unlike the old carousel).
    gcar.querySelectorAll('.gcar-nav, .gcar-dots').forEach(el => el.remove());
  }

  async function hydrateCarousel(gcar: HTMLElement): Promise<void> {
    const toolId = gcar.dataset.tool;
    const tool = toolId ? toolById.get(toolId) : undefined;
    if (!tool) return;
    const fmt = displayFormatOf(tool.formats);
    if (!fmt) return;
    if (gcar.dataset.paged === '1') { await hydratePaged(gcar, toolId!, tool); return; }
    const looks = resolveExamples(tool);
    for (const slide of gcar.querySelectorAll<HTMLElement>('.gcar-slide--ex')) {
      if (!gcar.isConnected) return;                       // tile replaced by a re-render
      const img = slide.querySelector<HTMLImageElement>('.gcar-img');
      if (!img || img.getAttribute('src')) continue;       // already rendered
      const v = looks[Number(slide.dataset.exIndex)];
      if (!v) continue;
      try {
        const thumb = await renderFeaturedVariant(host, toolId!, tool.formats, Number(slide.dataset.exIndex), v.values as Record<string, unknown>);
        if (!gcar.isConnected) return;
        img.addEventListener('load', () => {
          slide.classList.add('is-loaded');
          gcar.classList.add('has-art');   // first rendered look → stop the waiting tracer
        }, { once: true });
        img.src = thumb;
      } catch (e) {
        host.log?.('warn', `Gallery example failed for ${toolId}`, { error: String((e as { message?: unknown })?.message ?? e) });
      }
    }
  }
  let carouselObserver: IntersectionObserver | null = null;
  function armCarousels(): void {
    carouselObserver?.disconnect();
    carouselObserver = null;
    if (!masonry) return;
    const cars = [...masonry.querySelectorAll<HTMLElement>('.gcar')];
    if (!cars.length) return;
    if (typeof IntersectionObserver === 'undefined') {     // legacy: hydrate all, lazily
      cars.forEach(g => exJobs.push(() => hydrateCarousel(g)));
      pumpEx();
      return;
    }
    carouselObserver = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        exJobs.push(() => hydrateCarousel(e.target as HTMLElement));
        pumpEx();
      }
    }, { rootMargin: '250px 0px' });
    cars.forEach(g => carouselObserver!.observe(g));
  }
  cleanups.push(() => carouselObserver?.disconnect());

  // Move to a given slide (by index) and by ±1 (with wrap for the auto-advance loop),
  // then reflect it in the dots. Uses smooth native scroll so touch, trackpad and this
  // code all land on the same scroll-snap points.
  function setCarDot(gcar: HTMLElement, idx: number): void {
    gcar.querySelectorAll<HTMLElement>('.gcar-dot').forEach((d, k) => d.classList.toggle('is-active', k === idx));
  }
  // The strip's box is a FIXED SQUARE (parts/gallery.css .gcar) and every slide is
  // object-fit:contain, so differently-shaped example looks fit within one unchanging
  // frame — no per-look reflow as the carousel advances (which used to jitter the whole
  // masonry). Nothing here resizes the box any more.
  function scrollCarTo(gcar: HTMLElement, idx: number): void {
    const track = gcar.querySelector<HTMLElement>('.gcar-track');
    if (!track || !track.clientWidth) return;
    track.scrollTo({ left: idx * track.clientWidth, behavior: 'smooth' });
    setCarDot(gcar, idx);
  }
  // Child indices of the slides that are actually READY to show — a lead frame (a real
  // src from the start) or an example/page slide whose art has decoded (.is-loaded).
  // Auto-advance and prev/next cycle ONLY these, so a strip with several previews still
  // pending never rotates onto a not-yet-loaded slide's flat skeleton; the set grows as
  // each preview decodes and hydrateCarousel adds .is-loaded.
  function readyCarIndices(track: HTMLElement): number[] {
    const out: number[] = [];
    const kids = track.children;
    for (let i = 0; i < kids.length; i++) {
      const s = kids[i] as HTMLElement;
      if (s.classList.contains('gcar-slide--lead') || s.classList.contains('is-loaded')) out.push(i);
    }
    return out;
  }
  function advanceCarousel(gcar: HTMLElement, dir: number, wrap: boolean): void {
    const track = gcar.querySelector<HTMLElement>('.gcar-track');
    if (!track || !track.clientWidth) return;
    const ready = readyCarIndices(track);
    if (ready.length < 2) return;   // 0–1 loaded → nothing to rotate through yet
    const cur = Math.round(track.scrollLeft / track.clientWidth);
    // Where the centred slide sits within the ready set. If the strip is parked on a
    // slide that hasn't loaded (e.g. a manual dot jump), fall back to the last ready
    // slide at or before it, so the next step still lands on a decoded frame.
    let pos = ready.indexOf(cur);
    if (pos === -1) { pos = 0; for (let k = 0; k < ready.length; k++) if (ready[k]! <= cur) pos = k; }
    let next = pos + dir;
    if (next >= ready.length) next = wrap ? 0 : ready.length - 1;
    if (next < 0) next = wrap ? ready.length - 1 : 0;
    scrollCarTo(gcar, ready[next]!);
  }
  function wireCarousel(gcar: HTMLElement): void {
    const track = gcar.querySelector<HTMLElement>('.gcar-track');
    if (!track) return;
    // Delegated nav/dot clicks off the .gcar root, so the paged path can rebuild the
    // dots/arrows (unknown page count) with no re-wiring. A click on a slide link (not a
    // nav/dot) falls through untouched, so it still opens the tool.
    gcar.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.gcar-prev')) { e.preventDefault(); advanceCarousel(gcar, -1, true); }
      else if (t.closest('.gcar-next')) { e.preventDefault(); advanceCarousel(gcar, 1, true); }
      else { const dot = t.closest<HTMLElement>('.gcar-dot'); if (dot) { e.preventDefault(); scrollCarTo(gcar, Number(dot.dataset.i)); } }
    });
    // pointer/wheel/touch = the user; NOT the programmatic scrollTo above (which emits no
    // such event), so auto-advance can't pause itself. Sync the dots on any scroll.
    track.addEventListener('scroll', () => { if (track.clientWidth) setCarDot(gcar, Math.round(track.scrollLeft / track.clientWidth)); }, { passive: true });
  }

  // The example index of the slide currently centred in a carousel, or null when that
  // slide isn't an example (the resume/lead frame, a document page, or an empty strip).
  // Lets a click anywhere on the card open the SAME look the strip is showing right now.
  function activeExampleIndex(gcar: HTMLElement): number | null {
    const track = gcar.querySelector<HTMLElement>('.gcar-track');
    if (!track) return null;
    const centred = track.querySelectorAll<HTMLElement>('.gcar-slide')[Math.round(track.scrollLeft / (track.clientWidth || 1))];
    const raw = centred?.dataset.exIndex;
    return raw === undefined ? null : Number(raw);
  }

  // Open a tool seeded with one of its manifest example looks — the first-visit path where
  // the preview the user clicked (or is watching) becomes the tool's opening configuration.
  // The seeded URL is built by the shared `toolSeedHref` helper (also used by the featured
  // row) so parseUrlState in the tool view seeds the identical inputs the tile rendered from,
  // and the two surfaces never drift; any failure falls back to a blank session.
  async function openExample(toolId: string, exIndex: number, tile?: HTMLElement | null): Promise<void> {
    tile?.classList.add('is-navigating');
    const tool = toolById.get(toolId);
    const values = tool ? resolveExamples(tool)[exIndex]?.values : undefined;
    window.location.hash = await toolSeedHref(toolId, values);
  }

  // No auto-advance: the example strips move only when the USER moves them
  // (arrows, dots, swipe/scroll). The old shared ticker rotated every visible
  // strip on a stagger — retired 2026-07-09 by request; a busy grid of
  // self-scrolling cards read as noise, and reduced-motion users already had
  // the static behaviour this makes universal.

  const byName = (a: GalleryTool, b: GalleryTool) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const primaryFmt = (t: GalleryTool) =>
    (t.exportable !== false && Array.isArray(t.formats) && t.formats.length) ? fmtLabel(t.formats[0]!) : '';

  // Compare two filtered tools by the active sort. Every sort falls back to name so
  // the order is fully stable (ties never reshuffle between renders).
  function sortCompare(a: GalleryTool, b: GalleryTool): number {
    const r = ((): number => {
      switch (sortKey) {
        case 'az': return byName(a, b);
        case 'za': return byName(b, a);
        case 'recent': return (orderById.get(b.id)! - orderById.get(a.id)!) || byName(a, b); // newest-appended first
        case 'category': return (categoryRank(a.category ?? 'other') - categoryRank(b.category ?? 'other')) || byName(a, b);
        case 'format': {
          const fa = primaryFmt(a), fb = primaryFmt(b);
          if (fa !== fb) { if (!fa) return 1; if (!fb) return -1; return fa.localeCompare(fb); } // formatless (transforms) last
          return byName(a, b);
        }
        default: return byName(a, b);
      }
    })();
    // 'asc' flips the whole order (tiebreaker included) so the last results lead.
    return sortDir === 'asc' ? -r : r;
  }

  // The stable, full tile set: every tool that could ever show in the grid (feature
  // flags hide whole categories). Utilities live in the bottom strip in the default
  // browse view, but they ARE rendered as (hidden) grid tiles too so a search can
  // surface them — matchesQuery gates them to query-only (see below).
  // Search / category / sort only ever hide-show or reorder THIS set's tiles — they
  // never change membership — so we render it to the DOM once and mutate in place.
  const allTools: GalleryTool[] = index.tools.filter(t => !hidden.has(t.category));

  // The search + active-category predicate, WITHOUT the sort (assumes the tool is
  // already in allTools). Drives the in-place hide-show; sort is applied separately.
  function matchesQuery(t: GalleryTool): boolean {
    const q = query.trim();
    // Utilities are "hidden" from the main grid — they browse via the bottom strip, not
    // a category pill — but they must still be findable, so they surface as grid tiles
    // ONLY while a search is active (never in the default / category / favourites views).
    if (t.category === 'utility') {
      return q.length > 0 && (t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q));
    }
    if (q) return t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q);
    if (activeCat === FAV_CAT) return favourites.has(t.id);   // starred collection
    return activeCat === 'all' || t.category === activeCat;
  }

  function renderPills(): void {
    if (!pillbar) return;
    const total = index.tools.filter(t => !hidden.has(t.category) && t.category !== 'utility').length;
    const allActive = activeCat === 'all' && !query;
    let html = `<button class="gallery-pill${allActive ? ' active' : ''}" data-cat="all" type="button" aria-pressed="${allActive}">${t('All')}<span class="ct">${total}</span></button>`;
    // Favourites — the starred collection. Always shown (even at 0) so it's discoverable;
    // clicking into an empty one explains how to add.
    const favActive = activeCat === FAV_CAT && !query;
    html += `<button class="gallery-pill gallery-pill--fav${favActive ? ' active' : ''}" data-cat="${FAV_CAT}" type="button" aria-pressed="${favActive}"><span class="pill-star" aria-hidden="true">★</span>${t('Favourites')}<span class="ct">${favCount()}</span></button>`;
    for (const cat of visibleCats) {
      const n = grouped[cat]!.length;
      const active = activeCat === cat && !query;
      html += `<button class="gallery-pill${active ? ' active' : ''}" data-cat="${escape(cat)}" type="button" aria-pressed="${active}">${escape(t(catLabel(cat)))}<span class="ct">${n}</span></button>`;
    }
    pillbar.innerHTML = html;
  }

  // toolId → its live tile node, rebuilt only on a full render() (rare). applyView()
  // reads it to reorder + hide-show the existing tiles without re-stringifying them.
  const tileById = new Map<string, HTMLElement>();
  // Persistent empty-state line — a real node (not markup) so it survives the in-place
  // filter passes; shown/hidden + re-messaged by applyView(). Lives inside the masonry
  // after the tiles, so with every tile hidden it's the only flowed column item.
  const noResults = document.createElement('p');
  noResults.className = 'gallery-no-results';
  noResults.hidden = true;

  // FULL rebuild: re-stringify EVERY tile in the stable set. Costly (re-inlines base64
  // session thumbs, re-hydrates example <img>s, recreates observers), so it runs only
  // on mount and when the underlying tool SET changes (a saved session deleted). Search
  // / category / sort / direction go through applyView() instead — nodes stay live.
  function render(): void {
    if (!masonry) return;
    masonry.innerHTML = allTools
      .map(t => cardMarkup(t, latestByTool(t.id), countByTool(t.id), host.capabilities, personalizedByTool.get(t.id), isNew(t.id), isFav(t.id), thumbsByTool(t.id), darkTheme))
      .join('');
    masonry.append(noResults);
    tileById.clear();
    for (const el of masonry.querySelectorAll<HTMLElement>('.gtile')) {
      const id = el.dataset.toolId;
      if (id) tileById.set(id, el);
    }
    wireCards(masonry);
    // Order + hide-show the fresh tiles BEFORE measuring geometry for the reveal
    // cascade, so the wave reads in final on-screen order.
    revealObserver?.disconnect();
    const animateReveal = firstPaint && !isReturning && !prefersReduced;
    applyView();
    revealObserver = revealCards(masonry, animateReveal);
    armPreviewReveal(masonry, animateReveal);
    armCarousels();   // lazily hydrate example preview strips as their tiles near the viewport
    firstPaint = false;
  }

  // IN-PLACE update for search / category / sort / direction — the hot path. Reorders
  // the existing tile nodes (append keeps them live, preserving hydrated <img src> and
  // IntersectionObserver registrations) and toggles a hide class on non-matching ones;
  // it never touches innerHTML, so nothing re-decodes and no observer is recreated.
  function applyView(): void {
    if (!masonry) return;
    renderPills();
    // Dot on the filter trigger whenever a non-default category OR non-default sort
    // is in effect, so the collapsed control still signals "a view choice is active".
    filterFab?.classList.toggle('has-active', activeCat !== 'all' || sortKey !== 'category' || sortDir !== 'desc');
    // Show the hero row only in the default landing state — a search or category
    // filter makes it noise above the results. Toggle the mount + pause its motion.
    updateFeaturedVisibility();
    // Reorder: append the tiles in sorted order (moves live nodes, no re-render), then
    // keep the empty-state node last.
    const ordered = [...allTools].sort(sortCompare);
    for (const t of ordered) { const el = tileById.get(t.id); if (el) masonry.append(el); }
    masonry.append(noResults);
    // Hide-show: filtered-out tiles get .is-filtered (display:none); count the shown.
    let shown = 0;
    for (const t of allTools) {
      const el = tileById.get(t.id);
      if (!el) continue;
      const match = matchesQuery(t);
      el.classList.toggle('is-filtered', !match);
      if (match) shown++;
    }
    if (shown === 0) {
      noResults.innerHTML = query
        ? t('No tools match "<strong>{query}</strong>" — {button}', { query: escape(query.trim()), button: `<button type="button" class="gallery-retry" data-search-clear>${t('clear search')}</button>` })
        : activeCat === FAV_CAT
          ? t('No favourites yet — tap the <span class="star-inline" aria-hidden="true">★</span> on any tool to add it here.')
          : t('No tools to show.');
    }
    noResults.hidden = shown > 0;
    if (searchStatus) {
      searchStatus.textContent = query ? (shown === 1 ? t('1 result') : t('{n} results', { n: shown })) : '';
    }
  }

  function wireCards(container: HTMLElement): void {
    // Example preview strips: arrows, dots, and pause-on-interaction. Re-wired each
    // render since innerHTML replaced the elements the prior listeners were bound to.
    container.querySelectorAll<HTMLElement>('.gcar').forEach(wireCarousel);
    // Prefetch a tool's files on first hover of its open affordance.
    container.querySelectorAll<HTMLElement>('[data-new-tool]').forEach(el => {
      el.addEventListener('pointerenter', () => prefetchTool(el.dataset.newTool), { once: true });
      el.addEventListener('click', () => el.closest('.gtile')?.classList.add('is-navigating'));
    });
    // Resume the latest session (the hero preview).
    container.querySelectorAll<HTMLElement>('[data-resume]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        el.closest('.gtile')?.classList.add('is-navigating');
        window.location.hash = `#/tool/${el.dataset.resume}?slot=${encodeURIComponent(el.dataset.slot!)}`;
      });
    });
    // Star / unstar (favourites). Toggles in place; updates the pill count live, and
    // re-renders only when we're inside the Favourites view (the card must leave).
    container.querySelectorAll<HTMLElement>('[data-fav]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        const id = el.dataset.fav!;
        const on = !favourites.has(id);
        if (on) favourites.add(id); else favourites.delete(id);
        void saveFavourites(host, profile, favourites);
        el.classList.toggle('is-fav', on);
        el.setAttribute('aria-pressed', String(on));
        const nm = toolById.get(id)?.name ?? t('tool');
        el.setAttribute('aria-label', on ? t('Remove {name} from favourites', { name: nm }) : t('Add {name} to favourites', { name: nm }));
        el.title = on ? t('In favourites') : t('Add to favourites');
        // A favourited plain tool joins (or leaves) the featured hero strip; a manifest-
        // featured tool is already there, so skip the remount for it.
        if (!toolById.get(id)?.featured) refreshFeatured();
        if (activeCat === FAV_CAT) applyView(); // in the Favourites view the card must now hide/show in place
        else renderPills();                    // otherwise just refresh the pill count
      });
    });
    // Info + history modals.
    container.querySelectorAll<HTMLElement>('[data-info]').forEach(el => {
      el.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showInfoDialog(toolById.get(el.dataset.info!)); });
    });
    container.querySelectorAll<HTMLElement>('[data-history]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        const tool = toolById.get(el.dataset.history!)!;
        showHistoryDialog(tool, entriesByTool.get(tool.id) ?? [], sessionSizes, host, {
          // Update in-memory state (per-tool list + global list + FAB count) as rows
          // are deleted; the heavy masonry re-render is deferred to onClose.
          onDelete: (slot) => {
            const arr = entriesByTool.get(tool.id) ?? [];
            const ai = arr.findIndex(x => x.slot === slot);
            if (ai >= 0) arr.splice(ai, 1);
            const si = sortedSaved.findIndex(x => x.slot === slot);
            if (si >= 0) sortedSaved.splice(si, 1);
            const count = historyFab?.querySelector('.history-fab-count');
            if (count) count.textContent = String(sortedSaved.length);
            if (historyFab && sortedSaved.length === 0) historyFab.hidden = true;
          },
          // Re-render once the dialog is gone, then put focus on the card's info
          // button (stable) so keyboard focus isn't dropped to <body>.
          onClose: () => {
            render();
            masonry!.querySelector<HTMLElement>(`[data-info="${CSS.escape(tool.id)}"]`)?.focus();
          },
        });
      });
    });
  }

  if (pillbar) {
    pillbar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cat]');
      if (!btn) return;
      activeCat = btn.dataset.cat!;
      if (query) { query = ''; searchInput.value = ''; syncSearchClear(); }
      applyView();
      // applyView() rebuilds the pills, dropping focus — restore it to the active one
      // so keyboard users aren't bounced to the top of the tab order. The popover
      // stays open so the choice (and the Hide-previews toggle) remain in reach.
      pillbar.querySelector<HTMLElement>('.gallery-pill.active')?.focus();
    });
  }

  // ── Filter popover: anchored dropdown on desktop, bottom sheet on mobile. ──
  // Matches the color-field popover conventions (Escape + outside-pointerdown
  // close, focus returns to the trigger).
  let filterOutside: ((e: PointerEvent) => void) | null = null;
  function openFilter(): void {
    if (!filterPop || !filterPop.hidden) return;
    filterPop.hidden = false;
    if (filterBackdrop) filterBackdrop.hidden = false;       // CSS shows it on mobile only
    filterFab?.setAttribute('aria-expanded', 'true');
    filterPop.querySelector<HTMLElement>('.gallery-pill.active, .gallery-pill')?.focus();
    filterOutside = (e) => {
      if (!filterPop.contains(e.target as Node) && !filterFab!.contains(e.target as Node)) closeFilter();
    };
    // Defer so the opening click's own pointerdown doesn't immediately close it.
    setTimeout(() => document.addEventListener('pointerdown', filterOutside!), 0);
  }
  function closeFilter(returnFocus = false): void {
    if (!filterPop || filterPop.hidden) return;
    filterPop.hidden = true;
    if (filterBackdrop) filterBackdrop.hidden = true;
    filterFab?.setAttribute('aria-expanded', 'false');
    if (filterOutside) { document.removeEventListener('pointerdown', filterOutside); filterOutside = null; }
    if (returnFocus) filterFab?.focus();
  }
  filterFab?.addEventListener('click', () => { filterPop!.hidden ? openFilter() : closeFilter(); });
  filterPop?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeFilter(true); }
  });
  filterBackdrop?.addEventListener('click', () => closeFilter());
  // If the view is torn down with the popover open, its document-level pointerdown
  // listener would outlive the detached tree — closeFilter is idempotent and its
  // default returnFocus=false makes this a no-op when already closed.
  cleanups.push(() => closeFilter());

  // "Hide previews" — collapse every card (grid AND featured strip) to icon + text,
  // keeping a slim Continue bar on resumable sessions. Device-level view preference,
  // persisted like the theme. The class rides the gallery ROOT so it reaches the
  // featured strip too (not just the masonry).
  const HIDE_PREVIEWS_KEY = 'lolly-hide-previews';
  const galleryEl = viewEl.querySelector<HTMLElement>('.gallery');
  const hideCheckbox = viewEl.querySelector<HTMLInputElement>('.filter-hide-previews');
  let hidePreviews = false;
  try { hidePreviews = localStorage.getItem(HIDE_PREVIEWS_KEY) === '1'; } catch { /* storage off */ }
  if (hideCheckbox) hideCheckbox.checked = hidePreviews;
  // Both the gallery root (drives the featured strip's collapse) and the masonry
  // (existing grid rules key on `.tool-masonry.hide-previews`) carry the class.
  const setHidePreviews = (on: boolean): void => {
    galleryEl?.classList.toggle('hide-previews', on);
    masonry?.classList.toggle('hide-previews', on);
  };
  setHidePreviews(hidePreviews);
  hideCheckbox?.addEventListener('change', () => {
    hidePreviews = hideCheckbox!.checked;
    try { localStorage.setItem(HIDE_PREVIEWS_KEY, hidePreviews ? '1' : '0'); } catch { /* storage off */ }
    setHidePreviews(hidePreviews);
    updateFeaturedVisibility();
  });

  // Global sort — persisted like the theme; re-renders the grid in place.
  const sortSelect = viewEl.querySelector<HTMLSelectElement>('.gallery-sort');
  if (sortSelect) {
    sortSelect.value = sortKey;
    sortSelect.addEventListener('change', () => {
      sortKey = sortSelect.value as SortKey;
      try { localStorage.setItem(SORT_KEY_STORAGE, sortKey); } catch { /* storage off */ }
      applyView();   // reorder the live tiles in place — no re-render
    });
  }

  // Direction toggle: flips the active sort so the last results show first.
  const sortDirBtn = viewEl.querySelector<HTMLButtonElement>('.gallery-sort-dir');
  if (sortDirBtn) {
    const syncDirBtn = (): void => {
      const asc = sortDir === 'asc';
      sortDirBtn.classList.toggle('is-asc', asc);
      sortDirBtn.setAttribute('aria-pressed', String(asc));
      sortDirBtn.setAttribute('aria-label', asc ? t('Sort direction: oldest / last first') : t('Sort direction: newest / first first'));
      sortDirBtn.title = asc ? t('Showing last results first — click for the usual order') : t('Reverse — show the last results first');
    };
    syncDirBtn();
    sortDirBtn.addEventListener('click', () => {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      try { localStorage.setItem(SORT_DIR_STORAGE, sortDir); } catch { /* storage off */ }
      syncDirBtn();
      applyView();   // reorder the live tiles in place — no re-render
    });
  }

  let searchDebounce: ReturnType<typeof setTimeout>;
  searchInput.addEventListener('input', () => {
    syncSearchClear();   // the ✕ tracks the field's content immediately, not the debounced query
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { query = searchInput.value.toLowerCase(); applyView(); }, 120);
  });

  // ── Search clear affordances (match Projects / Catalogue) ──────────────────────
  // The field markup is the shared gallerySearchBox, so the ✕ is created here and slotted
  // into the (relatively-positioned) box. Visibility is driven by inline display: the global
  // `[hidden]{display:none}` rule can't beat an inline `display`, so we flip display directly
  // rather than toggle the hidden attribute.
  const searchClear = document.createElement('button');
  searchClear.type = 'button';
  searchClear.className = 'gallery-search-clear';
  searchClear.setAttribute('aria-label', t('Clear search'));
  searchClear.textContent = '✕';
  searchClear.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);width:24px;height:24px;align-items:center;justify-content:center;border:0;border-radius:50%;background:transparent;color:hsl(var(--muted-foreground));font-size:13px;line-height:1;cursor:pointer;display:none;';
  const searchBox = searchInput.closest<HTMLElement>('.gallery-search-box');
  if (searchBox) { searchBox.appendChild(searchClear); searchInput.style.paddingRight = '34px'; }   // leave room for the ✕

  // The ✕ is present only while there's text to clear.
  function syncSearchClear(): void { searchClear.style.display = searchInput.value ? 'inline-flex' : 'none'; }

  // Empty the field and re-run the filter immediately (no debounce), then re-focus so the
  // user keeps typing. Shared verbatim by the ✕ button, Escape, and the no-results "clear
  // search" link — every path funnels through applyView(), so no filtering logic is duplicated.
  function clearSearch(): void {
    clearTimeout(searchDebounce);
    searchInput.value = '';
    query = '';
    syncSearchClear();
    applyView();
    searchInput.focus({ preventScroll: true });
  }
  searchClear.addEventListener('click', clearSearch);

  // Escape while focused clears the query; when already empty it blurs (and falls through)
  // rather than swallowing the key. stopPropagation keeps a clear off any global Escape handler.
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (searchInput.value || query) { e.preventDefault(); e.stopPropagation(); clearSearch(); }
    else searchInput.blur();
  });

  // "clear search" link inside the empty-state line (rebuilt by applyView). The <p> node
  // persists across renders, so one delegated listener covers every future message.
  noResults.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-search-clear]')) clearSearch();
  });

  // Global saved-sessions overlay (folders over all tool + batch sessions),
  // opened from the history button beside the profile pill — and, on mobile, from
  // the consolidated profile menu (the standalone history button is hidden there).
  // User images are loaded lazily so folders that also hold images render here too.
  const historyFab = viewEl.querySelector<HTMLButtonElement>('.history-fab');
  async function openHistoryOverlay(): Promise<void> {
    const imageRefs = await host.assets._listUserAssets?.().catch(() => []) ?? [];
    // Lazy: folder-overlay (+ folders/folder-tiles chunks) only loads on this
    // deliberate click, not on the gallery boot preload. main.ts's idle prewarm
    // of projects.ts already warms it, so the click still resolves instantly.
    const { openFolderOverlay } = await import('../folder-overlay.ts');
    openFolderOverlay(host, {
      context: 'gallery',
      sessionEntries: sortedSaved,
      imageRefs,
      sessionSizes,
      nameById,
      showCreateFolder: true,
      allowBatchExport: proEnabled,
      onResume: (entry) => {
        window.location.hash = isBatchSlot(entry.slot)
          ? `#/pro?session=${encodeURIComponent(entry.slot)}`
          : `#/tool/${entry.toolId}?slot=${encodeURIComponent(entry.slot)}`;
      },
      onDelete: (ref) => {
        const i = sortedSaved.findIndex(s => s.slot === ref);
        if (i >= 0) sortedSaved.splice(i, 1);
        for (const arr of entriesByTool.values()) {
          const j = arr.findIndex(s => s.slot === ref);
          if (j >= 0) { arr.splice(j, 1); break; }
        }
        const count = historyFab?.querySelector('.history-fab-count');
        if (count) count.textContent = String(sortedSaved.length);
        if (historyFab && sortedSaved.length === 0) historyFab.hidden = true;
        render();
      },
    });
  }
  historyFab?.addEventListener('click', openHistoryOverlay);

  // Mobile: tapping the avatar opens a single menu gathering the theme switcher,
  // saved sessions and a Settings link (the history button + "Profile" wordmark
  // are hidden by CSS at that width). On desktop the avatar stays a plain link.
  attachProfileMenu(viewEl.querySelector<HTMLElement>('.profile-link'), host, {
    savedCount: sortedSaved.length,
    onHistory: openHistoryOverlay,
  });
  attachLangMenu(viewEl.querySelector<HTMLElement>('.lang-fab'), host);

  // Focus the search box on fine-pointer devices for type-to-find (skip touch so
  // the keyboard doesn't pop over the gallery).
  if (window.matchMedia?.('(pointer: fine)').matches) searchInput.focus({ preventScroll: true });

  render();

  // ── First-run welcome + tips strip (unbranded installs only) ────────────────
  // Unbranded = token discovery still resolves the lolly-start placeholder
  // (`lolly/tokens/brand`); once the user installs a brand, discovery returns
  // `user/tokens/brand` and this never fires again. The check rides on the
  // SYNCED asset metadata, so it can resolve null on a pre-sync mount (the
  // boot fast-path paints from the cached tool index before the asset sync
  // lands — including the eviction case where IndexedDB was dropped but the
  // localStorage index survived; main.ts's post-sync re-mount is gated on the
  // TOOL index bytes changing, which says nothing about the asset-meta store).
  // On null we re-run the check ONCE against the catalog index itself — the
  // same cold-load fallback the tokens bridge uses (bridge/tokens.ts
  // findTokensAsset). That's faithful: user tokens live in the same IndexedDB
  // as the asset meta, so a null here means the user store had none either,
  // and the index's first `tokens` asset is exactly what discovery will return
  // once the sync settles. We still only ever prompt off a non-null answer, so
  // the dialog can't flash on a genuinely branded install. Lazy-loaded, so
  // branded installs pay nothing; the continuation re-checks this gallery is
  // still mounted before touching the DOM (the trigger must never surface on
  // another view), and the dialog itself closes on any route change (see
  // components/welcome-dialog.ts) — no cleanup entry here, so the same-route
  // post-sync re-mount keeps it open seamlessly.
  const galleryRoot = viewEl.querySelector<HTMLElement>('.gallery');
  void (async () => {
    let tokensId: string | undefined;
    try {
      // A LOCKED brand (brandLock — e.g. the SUSE build) is branded by decree:
      // there's no brand question to settle, so never greet it with the welcome
      // or the tips strip, whatever the placeholder check below resolves to.
      if (await host.tokens?.isLocked?.()) return;
      tokensId = (await host.assets._findMetaByType('tokens'))?.id;
      if (tokensId === undefined && galleryRoot?.isConnected) {
        const resp = await fetch('/catalog/assets/index.json');
        if (resp.ok) {
          const idx = await resp.json() as { assets?: Array<{ id?: string; type?: string }> };
          tokensId = idx.assets?.find(a => a.type === 'tokens')?.id;
        }
      }
    } catch { /* IDB unavailable / offline — treat as branded; never block or nag here */ }
    const unbranded = tokensId === 'lolly/tokens/brand';
    if (!unbranded || !galleryRoot?.isConnected) return;
    const welcome = await import('../components/welcome-dialog.ts');
    if (!galleryRoot.isConnected) return; // navigated away while the chunk loaded
    welcome.mountBrandTips(viewEl.querySelector<HTMLElement>('.tool-masonry'));
    if (!welcome.isWelcomeDismissed()) void welcome.showWelcomeDialog(host.profile); // 'brand' navigates itself
  })();

  // Profile-personalized previews: once the user has opted in to "use my details",
  // re-render the few profile-bound tools that have no saved session — off the
  // critical path (idle, serial) — and lazily swap the personalized image into its
  // card. Feature-detected (host.previews) and scoped via canPersonalize(), so it's
  // a no-op for shells without the cache and for the ~24 tools whose output doesn't
  // change with the profile. The committed preview shows until the swap lands; cache
  // hits were already applied at mount above. See ../personalize-previews.js.
  if (previewSig && host.previews) {
    const cssEscape = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
    const toRegenerate = index.tools.filter(t =>
      canPersonalize(t) &&
      !latestByTool(t.id) &&                  // no saved session — only placeholders
      !personalizedByTool.has(t.id) &&        // not already fresh in cache
      toolSupport(t, host.capabilities).status !== 'unavailable',
    );
    if (toRegenerate.length) {
      const cancel = regeneratePreviews({
        host,
        tools: toRegenerate,
        sig: previewSig,
        onThumb: (toolId, dataUrl) => {
          personalizedByTool.set(toolId, dataUrl);   // so later re-renders keep it
          if (!masonry?.isConnected) return;         // navigated away mid-render
          const img = masonry.querySelector<HTMLImageElement>(
            `.gtile-hero--preview[data-new-tool="${cssEscape(toolId)}"] .gtile-hero-img`,
          );
          if (img) img.src = dataUrl;
        },
      });
      // Stop the idle render queue when the gallery is torn down or re-mounted
      // (navigate() in main.js calls view._cleanup), so it can't keep rendering
      // off-screen — or double up — after the user has moved on. Registered
      // alongside the featured row's teardown (both run from the one _cleanup).
      cleanups.push(cancel);
    }
  }
}

// ── Card markup ───────────────────────────────────────────────────────────

function cardMarkup(
  tool: GalleryTool,
  latest: SavedEntry | undefined,
  sessionCount: number,
  shellCaps: readonly string[] | undefined,
  personalizedThumb: string | undefined,
  isNew = false,
  isFav = false,
  sessionThumbs: string[] = [],
  darkTheme = false,
): string {
  const sup = toolSupport(tool, shellCaps);
  const unavailable = sup.status === 'unavailable';

  const statusBadge = unavailable
    ? `<span class="badge badge-desktop">${t('Desktop')}</span>`
    : sup.status === 'install'
      ? `<span class="badge badge-install">${t('Add&#8209;on')}</span>`
      : (tool.status !== 'official' ? `<span class="badge badge-${tool.status}">${escape(t(tool.status || ''))}</span>` : '');

  const iconSvg = tool.icon ? `<span class="tool-card-icon" aria-hidden="true">${tool.icon}</span>` : '';
  const openHref = `#/tool/${escape(tool.id)}`;
  const hasSession = !!latest && !unavailable;          // resumable, with or without a preview
  const hasThumbHero = hasSession && !!latest!.thumb;    // resumable AND has a preview image
  const hasPreview = !unavailable && !hasSession && !!tool.preview; // committed demo preview, no session yet
  // A committed AUTHORED card (tools/<id>/card.svg|png — e.g. bag-video's animated-Geeko
  // SVG, which animates natively in an <img>) is served from /tools/, unlike a generated
  // preview (/catalog/previews/…). When a tool ALSO has examples, we lead its carousel
  // with this card so the tile opens on the tool's real, often-animated hero and then
  // swipes to the example looks — the best of "show the motion" + "show the range".
  const animCard = (!unavailable && tool.preview && tool.preview.startsWith('/tools/')) ? tool.preview : null;
  // Paged tool (render.paged, e.g. multi-page-pdf): the tile shows the pages as a stacked
  // DECK (hydratePaged) rather than input-variant looks. Needs a displayable (svg/raster)
  // format. A paged tool that ships its OWN authored card (carousel-maker's hand-tuned
  // stacked-deck card.svg — animCard) is EXCLUDED so it shows that card directly, identical
  // to the featured hero, instead of a live-rendered deck that would drift from it.
  const paged = !unavailable && !!tool.paged && !!displayFormatOf(tool.formats) && !animCard;
  // Example looks (manifest.examples) turn the tile into a horizontally-scrollable
  // preview strip — leading with the newest saved session when there is one, then a
  // handful of live-rendered example states. Supersedes the committed demo preview and
  // the multi-session cross-fade (both are the no-examples fallback below).
  const exampleLooks = (unavailable || paged) ? [] : galleryExampleLooks(tool, darkTheme);
  const hasExamples = exampleLooks.length > 0;
  const hasImageHero = hasThumbHero || hasPreview || hasExamples || paged; // the card leads with a real preview image

  // Visual: hero preview to resume the latest session; a compact resume tile when
  // the session has no captured preview; a committed demo preview (starts a NEW
  // session) when there's no session at all; else an "open to start" tile.
  let visual;
  if (unavailable) {
    visual = `<span class="gtile-tile gtile-tile--static"><span class="gtile-tile-txt">${t('Desktop&nbsp;app only')}</span></span>`;
  } else if (paged) {
    // Multi-page document: the strip scrolls through each PAGE. Page count is unknown
    // until the doc renders, so start with one skeleton slide; hydratePaged (mountGallery)
    // renders the pages and rebuilds the slides + dots. Box is a fixed square (gallery.css);
    // each page is object-fit:contain, so a portrait/landscape page fits without cropping.
    visual = `
      <div class="gcar" data-tool="${escape(tool.id)}" data-paged="1">
        ${iconBackdrop(tool.icon)}
        <ol class="gcar-track"><li class="gcar-slide gcar-slide--ex"><span class="gcar-img" aria-hidden="true"></span></li></ol>
        ${statusBadge}
      </div>`;
  } else if (hasExamples) {
    // Horizontally-scrollable preview strip. Slide 0 is the newest saved session (a
    // data-URL — instant, resumes on click) when one exists; the rest are example
    // states, each an EMPTY <img> hydrated lazily by mountGallery (renderFeaturedVariant,
    // cached under featured:<id>:<i>) as the tile nears the viewport. The box is a FIXED
    // SQUARE (gallery.css) so masonry packs it with no reflow ever, and every slide is
    // object-fit:contain (differently-shaped looks fit within, never cropped). Decorative:
    // the real navigation is the card's name link + info/history buttons, so slides are aria-hidden.
    // Lead slide: a saved-session thumb (resume) wins; else the committed authored card
    // (bag-video's animated Geeko) leads with the tool's real hero. Only one lead.
    const leadSlide = hasThumbHero
      ? `<li class="gcar-slide gcar-slide--lead">
           <button class="gcar-open" type="button" data-resume="${escape(latest!.toolId)}" data-slot="${escape(latest!.slot)}" aria-label="${escape(t('Continue {name}', { name: latest!.filename || tool.name }))}">
             <img class="gcar-img" src="${escape(latest!.thumb!)}" alt="" aria-hidden="true" decoding="async">
             <span class="gtile-stamp">${escape(relativeTime(latest!.updatedAt))}</span>
             <span class="gtile-continue">${t('Continue')}</span>
           </button>
         </li>`
      : animCard
        ? `<li class="gcar-slide gcar-slide--lead gcar-slide--card">
             <a class="gcar-open" href="${openHref}" data-new-tool="${escape(tool.id)}" tabindex="-1" aria-hidden="true">
               ${previewMedia(animCard, 'gcar-img')}
             </a>
           </li>`
        : '';
    const hasLead = hasThumbHero || !!animCard;
    const exSlides = exampleLooks.map(({ i }) =>
      `<li class="gcar-slide gcar-slide--ex" data-ex-index="${i}">
         <a class="gcar-open" href="${openHref}" data-new-tool="${escape(tool.id)}" tabindex="-1" aria-hidden="true">
           <img class="gcar-img" alt="" aria-hidden="true" decoding="async">
         </a>
       </li>`).join('');
    const slideCount = (hasLead ? 1 : 0) + exampleLooks.length;
    const dots = slideCount >= 2
      ? `<div class="gcar-dots" aria-hidden="true">${Array.from({ length: slideCount }, (_, k) =>
          `<button class="gcar-dot${k === 0 ? ' is-active' : ''}" type="button" data-i="${k}" tabindex="-1" aria-hidden="true"></button>`).join('')}</div>`
      : '';
    const nav = slideCount >= 2
      ? `<button class="gcar-nav gcar-prev" type="button" tabindex="-1" aria-hidden="true" title="${escape(t('Previous example'))}">${CHEVRON_LEFT}</button>
         <button class="gcar-nav gcar-next" type="button" tabindex="-1" aria-hidden="true" title="${escape(t('Next example'))}">${CHEVRON_RIGHT}</button>`
      : '';
    visual = `
      <div class="gcar${hasThumbHero ? ' has-art' : ''}" data-tool="${escape(tool.id)}">
        ${iconBackdrop(tool.icon)}
        <ol class="gcar-track">${leadSlide}${exSlides}</ol>
        ${nav}
        ${dots}
        ${statusBadge}
      </div>`;
  } else if (hasThumbHero) {
    // One saved session → a single preview. Several → the recent previews cross-fade
    // (an ambient "you have a few saved works here"). The first frame is the newest
    // and sits in normal flow so it sets the tile's natural height; the rest are
    // absolutely stacked over it and only .is-active is opaque (the fade is CSS, the
    // ticker in mountGallery advances .is-active). The rotation is decorative —
    // clicking always resumes the newest, the Continue target.
    const frames = sessionThumbs.length >= 2 ? sessionThumbs : [latest!.thumb!];
    const rotate = frames.length >= 2;
    // Not loading="lazy": the thumbs are data URLs already inlined in this markup
    // (nothing to defer over the network), and a lazy + opacity:0 frame is never
    // considered "intersecting", so it would never decode and the fade would stall.
    const heroImgs = frames.map((thumb, i) =>
      `<img class="gtile-hero-img gtile-hero-frame${i === 0 ? ' is-active' : ' gtile-hero-frame--over'}" src="${escape(thumb)}" alt="" aria-hidden="true" decoding="async">`
    ).join('');
    visual = `
      <button class="gtile-hero${rotate ? ' gtile-hero--rotate' : ''}" data-resume="${escape(latest!.toolId)}" data-slot="${escape(latest!.slot)}"
              aria-label="${escape(t('Continue {name}', { name: latest!.filename || tool.name }))}">
        ${heroImgs}
        <span class="gtile-stamp">${escape(relativeTime(latest!.updatedAt))}</span>
        <span class="gtile-continue">${t('Continue')}</span>
        ${statusBadge}
      </button>`;
  } else if (hasSession) {
    // Session exists but its preview failed to capture — still resumable from the card.
    visual = `<button class="gtile-tile gtile-tile--resume" data-resume="${escape(latest!.toolId)}" data-slot="${escape(latest!.slot)}"
              aria-label="${escape(t('Continue {name}', { name: latest!.filename || tool.name }))}"><span class="gtile-tile-txt">${t('Continue · {time}', { time: escape(relativeTime(latest!.updatedAt)) })}</span></button>`;
  } else if (hasPreview) {
    // No saved session, but a committed demo preview exists (npm run thumbs) — show
    // it as a hero that starts a NEW session. Decorative duplicate of the name link
    // (tabindex/aria-hidden so AT hears one link), matching the empty-tile pattern.
    // When the user has opted in to their profile, a personalized re-render replaces
    // the committed placeholder (in cache at mount, or lazily swapped in when ready).
    visual = `
      <a class="gtile-hero gtile-hero--preview" href="${openHref}" data-new-tool="${escape(tool.id)}" tabindex="-1" aria-hidden="true">
        ${iconBackdrop(tool.icon)}
        ${personalizedThumb
          // A personalized re-render is always a raster data URL — a plain <img>.
          ? `<img class="gtile-hero-img" src="${escape(personalizedThumb)}" alt="" aria-hidden="true" loading="lazy" decoding="async">`
          // Fixed-square hero (gallery.css): the img/iframe fills it and contains within,
          // so no per-tool aspect is threaded through — every preview box is the same size.
          : previewMedia(tool.preview!, 'gtile-hero-img')}
        <span class="gtile-continue">${t('Open')}</span>
        ${statusBadge}
      </a>`;
  } else {
    // No session, no preview, no examples — still lead with the tool's icon (never
    // a network fetch, so never broken) so the tile is a real, on-brand card rather
    // than a bare line of text. Decorative duplicate of the name link (tabindex/
    // aria-hidden so AT hears one link).
    visual = `<a class="gtile-tile gtile-tile--iconled" href="${openHref}" data-new-tool="${escape(tool.id)}" tabindex="-1" aria-hidden="true">${tool.icon ? `<span class="gtile-tile-icon" aria-hidden="true">${tool.icon}</span>` : ''}<span class="gtile-tile-txt">${t('Open to start')}</span></a>`;
  }

  // Caption sub-line: only the last-opened time, and only on resumable cards.
  // The category is deliberately omitted here — it's discoverable via the filter
  // pills and shown in the info dialog — so the card stays about this tool itself.
  const sub = hasSession
    ? t('Last opened · {time}', { time: escape(relativeTime(latest!.updatedAt)) })
    : '';

  // Export formats no longer clutter the card — they live in the info (i) dialog now,
  // grouped by vector / raster with the default highlighted (see showInfoDialog).

  // The title is the "start a new session" link. A stretched ::after (see CSS)
  // makes the whole text body — caption + description — its click target, so a
  // fresh session is as easy to hit as the hero's Continue. On a tool that
  // already has a saved session the link carries an explicit aria-label so it
  // reads as "new" against the hero's "Continue".
  const name = unavailable
    ? `<span class="gtile-name" aria-disabled="true">${escape(tool.name)}</span>`
    : `<a class="gtile-name" href="${openHref}" data-new-tool="${escape(tool.id)}"${hasSession ? ` aria-label="${escape(t('Start a new {name} session', { name: tool.name }))}"` : ''}>${escape(tool.name)}</a>`;

  const historyBtn = (!unavailable && sessionCount > 0)
    ? `<button type="button" class="gtile-iconbtn" data-history="${escape(tool.id)}" title="${escape(t('Saved sessions'))}" aria-label="${escape(sessionCount === 1 ? t('1 saved session for {name}', { name: tool.name }) : t('{n} saved sessions for {name}', { n: sessionCount, name: tool.name }))}">${HISTORY_ICON}</button>`
    : '';

  return `
    <article class="gtile${unavailable ? ' gtile--unavailable' : ''}${hasImageHero ? ' gtile--has-preview' : ''}" data-tool-id="${escape(tool.id)}">
      ${visual}
      <div class="gtile-body${unavailable ? '' : ' gtile-body--link'}">
        <div class="gtile-cap">
          ${iconSvg}
          <span class="gtile-meta">
            ${isNew ? `<span class="gtile-newbadge">${t('New')}</span>` : ''}
            ${name}
            ${sub ? `<span class="gtile-sub">${sub}</span>` : ''}
            <p class="gtile-desc">${escape(tool.description ?? '')}</p>
          </span>
          ${hasSession ? `<span class="gtile-new" aria-hidden="true">${t('+ New')}</span>` : ''}
          ${hasImageHero
            // Badge moved onto the preview image (see the hero markup), but that
            // hero is aria-hidden / aria-labelled, so keep the status announced.
            ? (statusBadge ? `<span class="visually-hidden">${escape(t(statusLabel(tool.status) || ''))}</span>` : '')
            : statusBadge}
        </div>
      </div>
      <div class="gtile-actions">
        <button type="button" class="gtile-iconbtn gtile-fav${isFav ? ' is-fav' : ''}" data-fav="${escape(tool.id)}" data-sfx="twinkle" aria-pressed="${isFav}" title="${escape(isFav ? t('In favourites') : t('Add to favourites'))}" aria-label="${escape(isFav ? t('Remove {name} from favourites', { name: tool.name }) : t('Add {name} to favourites', { name: tool.name }))}">${STAR_ICON}</button>
        <button type="button" class="gtile-iconbtn" data-info="${escape(tool.id)}" title="${escape(t('About this tool'))}" aria-label="${escape(t('About {name}', { name: tool.name }))}">${INFO_ICON}</button>
        ${historyBtn}
      </div>
    </article>
  `;
}

// ── Info modal ──────────────────────────────────────────────────────────────

function showInfoDialog(tool: GalleryTool | undefined): void {
  if (!tool) return;
  const caps = Array.isArray(tool.capabilities) ? tool.capabilities : [];
  // Formats + privacy come straight from the catalog index entry — no fetch.
  // Transform-vs-export is decided by the `exportable` flag alone (NOT by whether
  // formats happen to be present), so a tool that declares formats always lists
  // them; only genuinely non-exporting utilities show the transform note.
  // Export formats moved off the tile into this dialog: chips grouped into vector /
  // raster / video / data sections (each keeping the tool's declared order within the
  // group), with the DEFAULT (first-declared) format filled with the accent so a browser
  // sees at a glance what they'll get and the full range on offer.
  const rawFormats = tool.exportable === false || !Array.isArray(tool.formats) ? [] : tool.formats;
  const defaultFmt = rawFormats[0];
  const fmtChip = (f: string): string =>
    `<li class="meta-fmt${f === defaultFmt ? ' meta-fmt--default' : ''}"${f === defaultFmt ? ` title="${escape(t('Default format'))}"` : ''}>${escape(fmtLabel(f))}${f === defaultFmt ? `<span class="visually-hidden"> ${t('(default)')}</span>` : ''}</li>`;
  const fmtGroupsHtml = FMT_KIND_ORDER
    .map(kind => ({ kind, list: rawFormats.filter(f => fmtKind(f) === kind) }))
    .filter(g => g.list.length)
    .map(g => `<div class="meta-fmt-grp"><span class="meta-fmt-kind">${t(FMT_KIND_LABEL[g.kind])}</span><ul class="meta-fmts">${g.list.map(fmtChip).join('')}</ul></div>`)
    .join('');
  const hasFmtChips = tool.exportable !== false && rawFormats.length > 0;
  const exportsDd = tool.exportable === false
    ? t('On-device transform (no file export)')
    : hasFmtChips ? `<div class="meta-fmt-groups">${fmtGroupsHtml}</div>` : '—';
  // Intended canvas size — paired with the format list so the modal answers both
  // "what file" and "how big". Omitted for transforms (size isn't meaningful) and for
  // any tool that declares no render size.
  const dims = tool.exportable === false ? '' : dimText(tool);

  const dialog = document.createElement('dialog');
  dialog.className = 'tool-meta-dialog';
  dialog.setAttribute('aria-labelledby', 'tool-info-title');
  // The same preview the tile shows (previewMedia handles img vs the sandboxed
  // card.html iframe), sized by the tool's declared aspect when it has one.
  const previewAspect = typeof tool.width === 'number' && typeof tool.height === 'number'
    ? ` style="aspect-ratio:${tool.width}/${tool.height}"` : '';
  dialog.innerHTML = `
    <div class="meta-dialog-body">
      <header class="meta-dialog-head">
        ${tool.icon ? `<span class="tool-card-icon meta-dialog-icon" aria-hidden="true">${tool.icon}</span>` : ''}
        <div>
          <h2 id="tool-info-title">${escape(tool.name)}</h2>
          <p class="meta-dialog-sub">${escape(t(catLabel(tool.category)))} · ${escape(t(statusLabel(tool.status) || ''))}</p>
        </div>
      </header>
      ${tool.preview ? `<div class="meta-dialog-preview"${previewAspect}>${previewMedia(tool.preview, 'meta-dialog-preview-img')}</div>` : ''}
      <p class="meta-dialog-desc">${escape(tool.description ?? '')}</p>
      <dl class="meta-dialog-facts">
        <div${hasFmtChips ? ' class="meta-fmts-row"' : ''}><dt>${t('Exports')}</dt><dd>${exportsDd}</dd></div>
        ${dims ? `<div><dt>${t('Size')}</dt><dd>${escape(dims)}</dd></div>` : ''}
        ${caps.length ? `<div><dt>${t('Uses')}</dt><dd>${caps.map(c => escape(capabilityLabel(c))).join(', ')}</dd></div>` : ''}
        ${tool.privacy === 'on-device' ? `<div><dt>${t('Privacy')}</dt><dd>${t('Runs entirely on your device')}</dd></div>` : ''}
        ${tool.version ? `<div><dt>${t('Version')}</dt><dd>${escape(tool.version)}</dd></div>` : ''}
      </dl>
      <section class="meta-defaults" aria-label="${escape(t('Default settings'))}" hidden>
        <h3 class="meta-defaults-title">${t('Defaults')}</h3>
        <dl class="meta-defaults-list"></dl>
      </section>
      <div class="meta-dialog-actions">
        <a class="btn meta-dialog-open" href="#/tool/${escape(tool.id)}">${t('Open tool')}</a>
        <button type="button" class="btn meta-dialog-close">${t('Close')}</button>
      </div>
    </div>`;
  playSfx('whisper'); // airy elevation as the tool details rise in
  openDialog(dialog);
  dialog.querySelector('.meta-dialog-open')?.addEventListener('click', () => closeDialog(dialog));
  void fillDefaultsList(dialog, tool.id);
}

// ── Info dialog: the defaults spec list ──────────────────────────────────────
// The gallery index deliberately carries no input model, so the dialog fetches
// the manifest on open and renders each input's out-of-the-box value — a small
// spec sheet, not a settings UI. Failure (offline, tool gated) just leaves the
// section hidden; the dialog stands on the index data alone.

/** One input's default, formatted for the spec list. null = skip the row. */
function defaultText(input: Record<string, unknown>): { text: string; swatch?: string } | null {
  const d = input.default;
  const type = String(input.type ?? 'text');
  if (type === 'file') return null;                       // user-supplied by nature — no default exists
  if (d === undefined || d === null || d === '') return { text: '—' };
  switch (type) {
    case 'boolean': return { text: d ? t('On') : t('Off') };
    case 'color': {
      const v = String(d);
      return { text: v, swatch: /^(#[0-9a-fA-F]{3,8}|transparent)$/.test(v) ? v : undefined };
    }
    case 'select': {
      const opts = Array.isArray(input.options) ? input.options as Array<{ value?: unknown; label?: unknown }> : [];
      const hit = opts.find(o => (o && typeof o === 'object' ? o.value : o) === d);
      return { text: String((hit && typeof hit === 'object' && hit.label) || d) };
    }
    case 'blocks': return { text: Array.isArray(d) ? (d.length === 1 ? t('1 item') : t('{n} items', { n: d.length })) : '—' };
    case 'vector': return { text: Array.isArray(d) ? d.join(' × ') : String(d) };
    case 'number': return { text: String(d) + (input.unit ? ` ${input.unit}` : '') };
    default: {
      const s = String(d);
      return { text: s.length > 42 ? `${s.slice(0, 41)}…` : s };
    }
  }
}

async function fillDefaultsList(dialog: HTMLElement, toolId: string): Promise<void> {
  let inputs: Array<Record<string, unknown>>;
  try {
    const resp = await fetch(`/tools/${encodeURIComponent(toolId)}/tool.json`);
    if (!resp.ok) return;
    const manifest = await resp.json() as { inputs?: Array<Record<string, unknown>> };
    inputs = Array.isArray(manifest.inputs) ? manifest.inputs : [];
  } catch { return; }
  const section = dialog.querySelector<HTMLElement>('.meta-defaults');
  const list = dialog.querySelector<HTMLElement>('.meta-defaults-list');
  if (!section || !list || !dialog.isConnected || !inputs.length) return;

  const MAX_ROWS = 14; // a spec sheet, not a scroll chore — the tool itself shows the rest
  const rows: string[] = [];
  for (const input of inputs) {
    if (rows.length >= MAX_ROWS) break;
    const v = defaultText(input);
    if (!v) continue;
    const label = String(input.label ?? input.id ?? '');
    const fromProfile = typeof input.bindToProfile === 'string'
      ? `<span class="meta-default-note">${t('from profile')}</span>` : '';
    rows.push(`<div class="meta-default-row">
      <dt>${escape(label)}</dt>
      <dd>${v.swatch ? `<span class="meta-default-swatch${v.swatch === 'transparent' ? ' color-swatch--transparent' : ''}"${v.swatch !== 'transparent' ? ` style="background:${escape(v.swatch)}"` : ''} aria-hidden="true"></span>` : ''}<span class="meta-default-value">${escape(v.text)}</span>${fromProfile}</dd>
    </div>`);
  }
  const skipped = inputs.filter(i => String(i.type) !== 'file').length - rows.length;
  if (!rows.length) return;
  list.innerHTML = rows.join('') +
    (skipped > 0 ? `<div class="meta-default-row meta-default-more"><dt></dt><dd>${t('+ {n} more in the tool', { n: skipped })}</dd></div>` : '');
  section.hidden = false;
}

// ── History modal ───────────────────────────────────────────────────────────

interface ShowHistoryDialogOpts {
  onDelete?(slot: string): void;
  onClose?(): void;
}

function showHistoryDialog(tool: GalleryTool | undefined, entries: SavedEntry[], sizes: Record<string, number>, host: GalleryHost, { onDelete, onClose }: ShowHistoryDialogOpts = {}): void {
  if (!tool) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'tool-meta-dialog tool-history-dialog';
  dialog.setAttribute('aria-labelledby', 'tool-history-title');

  const countText = (n: number) => (n === 1 ? t('1 saved session') : t('{n} saved sessions', { n }));
  // Defer the gallery re-render until the dialog closes: rebuilding the masonry
  // (and the (h) trigger button) mid-dialog would break the UA's focus restore.
  let changed = false;
  dialog.innerHTML = `
    <div class="meta-dialog-body">
      <header class="meta-dialog-head">
        ${tool.icon ? `<span class="tool-card-icon meta-dialog-icon" aria-hidden="true">${tool.icon}</span>` : ''}
        <div>
          <h2 id="tool-history-title">${escape(tool.name)}</h2>
          <p class="meta-dialog-sub history-count">${countText(entries.length)}</p>
        </div>
      </header>
      <ul class="saved-list history-list">
        ${entries.map(e => savedItem(e, sizes[e.slot], '')).join('')}
      </ul>
      <div class="meta-dialog-actions">
        <button type="button" class="btn meta-dialog-close">${t('Close')}</button>
      </div>
    </div>`;
  openDialog(dialog);
  dialog.addEventListener('close', () => { if (changed) onClose?.(); });

  dialog.querySelectorAll<HTMLElement>('[data-resume]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDialog(dialog);
      window.location.hash = `#/tool/${el.dataset.resume}?slot=${encodeURIComponent(el.dataset.slot!)}`;
    });
  });
  dialog.querySelectorAll<HTMLElement>('[data-delete]').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const slot = el.dataset.delete!;
      const ok = await confirmDialog({
        title: t('Delete session?'),
        message: t('Delete this saved session? This can’t be undone.'),
        confirmLabel: t('Delete'),
      });
      if (!ok) return;
      await host.state.delete(slot);
      el.closest('.saved-row')?.remove();
      onDelete?.(slot);            // update in-memory state only — render happens on close
      changed = true;
      announce(t('Session deleted'));
      const left = dialog.querySelectorAll('.saved-row').length;
      const countEl = dialog.querySelector('.history-count');
      if (countEl) countEl.textContent = countText(left);
      if (left === 0) closeDialog(dialog);
    });
  });
}

// ── Native <dialog> helpers (Esc + backdrop click come free) ────────────────

function openDialog(dialog: HTMLDialogElement): void {
  document.body.appendChild(dialog);
  dialog.showModal();
  // Esc → close() (not bare remove()) so the UA restores focus to the opener.
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(dialog); }); // Esc
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(dialog); }); // backdrop
  dialog.querySelectorAll('.meta-dialog-close').forEach(b => b.addEventListener('click', () => closeDialog(dialog)));
}
function closeDialog(dialog: HTMLDialogElement): void {
  dialog.close();
  dialog.remove();
}

// ── Saved-session row (shared by the history modal) ─────────────────────────

function savedItem(entry: SavedEntry, bytes: number | undefined, toolName = ''): string {
  const batch = isBatchSlot(entry.slot);
  const thumb = batch
    ? `<span class="saved-thumb saved-thumb--batch" aria-hidden="true">${PACKAGE_ICON}</span>`
    : entry.thumb
      ? `<img class="saved-thumb" src="${escape(entry.thumb)}" alt="" aria-hidden="true">`
      : `<span class="saved-thumb saved-thumb--empty"></span>`;
  const when = entry.updatedAt ? fmtDateTime(new Date(entry.updatedAt)) : '';
  const size = bytes ? `<small class="session-size">${fmtBytes(bytes)}</small>` : '';
  const title = batch ? (entry.label || t('Batch session')) : (entry.filename || toolName || entry.toolId);
  // The tool name is the row's title (h4) just above, so the sub-line only needs
  // the timestamp — no need to repeat the name.
  const subtitle = batch ? t('Batch · {when}', { when }) : when;
  const searchText = [title, entry.toolId, toolName, batch ? 'batch' : ''].filter(Boolean).join(' ').toLowerCase();
  // Tool sessions resume into #/tool; batch sessions resume into #/pro.
  const resumeAttrs = batch
    ? `data-batch data-slot="${escape(entry.slot)}"`
    : `data-resume="${escape(entry.toolId)}" data-slot="${escape(entry.slot)}"`;
  return `
    <li class="saved-row${batch ? ' saved-row--batch' : ''}" data-search="${escape(searchText)}">
      <button class="saved-resume" ${resumeAttrs} aria-label="${escape(batch ? t('Open batch') : t('Resume'))} ${escape(entry.label ?? entry.slot)}"></button>
      ${thumb}
      <span class="saved-label"><h4>${escape(title)}</h4><small>${escape(subtitle)}</small>
      ${size}
      <button class="saved-delete" data-delete="${escape(entry.slot)}" title="${escape(t('Delete'))}" aria-label="${escape(t('Delete'))}">&#x2715;</button>
    </span></li>
  `;
}

// ── Misc helpers ────────────────────────────────────────────────────────────

function prefetchTool(toolId: string | undefined): void {
  if (!toolId) return;
  const base = `/tools/${toolId}`;
  for (const file of ['tool.json', 'template.html', 'hooks.js']) {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'fetch';
    link.href = `${base}/${file}`;
    document.head.appendChild(link);
  }
}

function relativeTime(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return t('just now');
  const m = s / 60; if (m < 60) return t('{n}m ago', { n: Math.round(m) });
  const h = m / 60; if (h < 24) return t('{n}h ago', { n: Math.round(h) });
  const d = h / 24; if (d < 7) return t('{n}d ago', { n: Math.round(d) });
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function fmtDateTime(d: Date): string {
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

function fmtBytes(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
