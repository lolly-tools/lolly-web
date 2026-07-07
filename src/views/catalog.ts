// SPDX-License-Identifier: MPL-2.0
/**
 * Catalog view (route /#/c or /#/catalog) — the third top-level destination alongside
 * Tools and Projects.
 *
 * A gallery-style page over EVERY asset the app knows: the shared SUSE catalog assets AND
 * the user's own uploaded images, unified into one grid grouped by category. Below the
 * grid sit two read-only reference panels: the brand Swatches (click-to-copy) and the
 * bundled Fonts (with download links).
 *
 * Per-asset actions, all persisted on the user PROFILE (see lib/asset-favourites.ts +
 * lib/asset-category.ts), never on the immutable catalog:
 *   ★ Favourite    — pins the asset to a Favourites section here AND at the top of every
 *                    asset picker (lib/asset-favourites.ts, read by views/picker.ts).
 *   Recategorise…  — override which library group an asset falls in (e.g. reclassify a
 *                    headshot as a background). Layers over the tag-derived category.
 *   Delete / Hide  — a USER upload is truly deleted; a shared catalog asset can't be
 *                    (it's a permanent, checksum-validated contract) so it is HIDDEN from
 *                    this user's catalogue + every picker instead — reversible via the
 *                    "Show hidden" toggle.
 *
 * Asset management in /profile (headshot + storage meter) is untouched — this view is
 * additive. The user's headshot is excluded from the grid (it's managed there, and
 * deleting it would orphan profile.headshot).
 */

import { escape } from '../utils.ts';
import { announce } from '../a11y.ts';
import { viewToggle } from '../components/view-toggle.ts';
import { mountFeaturedRow } from '../components/featured-row.ts';
import type { FeaturedEntry, FeaturedRowHandle, FeaturedViewMode } from '../components/featured-row.ts';
import { attachProfileMenu } from '../components/profile-menu.ts';
import { footerNav, NAV_ICONS } from '../components/footer-nav.ts';
import { flagEnabled, PRO_FLAG } from '../feature-flags.ts';
import { themeSegmentHtml, wireThemeSegment } from '../components/theme-toggle.ts';
import { soundSegmentHtml, wireSoundSegment } from '../components/sound-toggle.ts';
import { playSfx, playCatalogAah, cancelArrivalAah } from '../lib/sfx.ts';
import { autoplayLottieThumbs, mountLottieMarker, destroyLottiePlayers, lottiePlayerFor } from './lottie-mount.ts';
import { confirmDialog, choiceDialog, promptDialog, closeConfirmDialogs } from '../components/confirm-dialog.ts';
import { armViewEnter } from '../view-enter.ts';
import {
  libCategory, LIB_GROUPS, categoryLabel, loadAssetCategories, saveAssetCategory,
} from '../lib/asset-category.ts';
import {
  assetBaseId,
  loadFavouriteAssets, saveFavouriteAssets,
  loadHiddenAssets, saveHiddenAssets,
} from '../lib/asset-favourites.ts';
import { groupPalette, swatch } from '../lib/swatches.ts';
import { categoryGlyph } from '../lib/category-icons.ts';
import { staggerReveal } from '../lib/reveal.ts';
import { PALETTE } from '../palette.ts';
import { FONTS, WEIGHT_RAMP, FONT_LICENSE } from '../lib/typefaces.ts';
import {
  restyleIconTheme, buildThemedAssetId, parseThemedAssetId, treatmentFilterSvg,
  buildTreatedAssetId, parseTreatedAssetId, wrapRasterWithTreatment,
} from '@lolly/engine';
import type { AssetRef, HostV1, Profile } from '../../../../engine/src/bridge/host-v1.ts';
import type { PhotoTreatment } from '../../../../engine/src/photo-treatment.ts';
import type { IconTheme } from '../../../../engine/src/icon-theme.ts';

// The user's headshot is a user asset but is managed on /profile (and backs
// profile.headshot) — keep it out of the Catalog grid so it can't be orphaned here.
const HEADSHOT_ID = 'user/headshot';
// Only assets that thumbnail as an image belong in the grid; palette/tokens/font/audio
// entries are engine data (Swatches + Fonts panels cover those below).
const VISUAL_TYPES = new Set(['raster', 'vector', 'video', 'lottie']);

// Coarse filetype filter for the sticky toolbar — three buckets over the four asset
// types, NOT one option per export format (which would be a huge, noisy list): Image =
// raster photos/logos, Vector = SVG/EPS artwork, Motion = video + Lottie animations.
type TypeFilter = 'all' | 'image' | 'vector' | 'motion';
// Toolbar glyphs (Lucide house style). Each button shows icon + label on desktop and
// collapses to the icon alone on mobile (see .cat-btn-label in catalog.css).
const catIco = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const CAT_ICONS = {
  all:      catIco('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'),
  image:    catIco('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),
  vector:   catIco('<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/><path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"/><path d="m2.3 2.3 7.286 7.286"/><circle cx="11" cy="11" r="2"/>'),
  motion:   catIco('<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>'),
  collapse: catIco('<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>'),
  expand:   catIco('<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>'),
  eye:      catIco('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff:   catIco('<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>'),
};
// Update a sticky-toolbar toggle (Collapse-all / Show-hidden) in place: swap its glyph
// + label span and keep the accessible name in sync. A plain `.textContent =` would drop
// the SVG icon entirely — and, since these buttons are icon-only on the toolbar (the
// label is hidden), leave a bare word behind — as well as re-width the centred pill.
function setCatToggle(btn: HTMLElement, icon: string, label: string): void {
  btn.innerHTML = `${icon}<span class="cat-btn-label">${label}</span>`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
}
// Each type filter has a signature click sound: image = a camera shutter snick,
// vector = a pencil scribble, motion = a film reel spinning up to smooth.
const TYPE_FILTERS: { key: TypeFilter; label: string; icon: string; sfx?: string }[] = [
  { key: 'all', label: 'All', icon: CAT_ICONS.all },
  { key: 'image', label: 'Image', icon: CAT_ICONS.image, sfx: 'aperture' },
  { key: 'vector', label: 'Vector', icon: CAT_ICONS.vector, sfx: 'scribble' },
  { key: 'motion', label: 'Motion', icon: CAT_ICONS.motion, sfx: 'reel' },
];
// Which asset types each filter bucket admits ('all' matches everything).
const TYPE_FILTER_TYPES: Record<Exclude<TypeFilter, 'all'>, Set<string>> = {
  image: new Set(['raster']),
  vector: new Set(['vector']),
  motion: new Set(['video', 'lottie']),
};

// The web shell's concrete host exposes more than the tool-facing HostV1 contract; we
// reach for the user-asset helpers + profile.set(). main.ts passes the concrete WebHost
// (assignable to HostV1), so the parameter stays HostV1 and this narrows locally.
interface CatalogHost extends HostV1 {
  assets: HostV1['assets'] & {
    _listUserAssets(): Promise<AssetRef[]>;
    _deleteUserAsset(id: string): Promise<void>;
    _renameUserAsset(id: string, name: string): Promise<void>;
    _iconThemes?(): Promise<IconTheme[]>;
    _photoTreatments?(): Promise<PhotoTreatment[]>;
  };
  profile: HostV1['profile'] & { set(profile: Profile): Promise<unknown> };
}

// Two-colour icons ('themable', c1/c2) and multi-colour illustrations ('illustration',
// monochromatic remap) both take a colour theme — the engine recolour handles each shape.
const isThemable = (ref: AssetRef): boolean => {
  const tags = ref.meta?.tags as string[] | undefined;
  // Content-credentialed assets ship a signed C2PA manifest with a hard byte
  // binding: re-theming on download (restyleIconTheme) would mutate the bytes
  // and break the credential. They must always download byte-exact.
  if (tags?.includes('content-credentials')) return false;
  return Boolean(tags?.includes('themable') || tags?.includes('illustration'));
};

// Sentinel "theme" = the asset's own bytes, unchanged. Downloading the original
// keeps any embedded Content Credential intact; a recolour necessarily changes
// the bytes, so its now-mismatched credential is stripped — a clean unsigned
// asset, never a "broken" one.
const ORIGINAL_THEME = '__original';
const stripC2paManifest = (svg: string): string =>
  svg.replace(/<metadata>\s*<c2pa:manifest>[\s\S]*?<\/c2pa:manifest>\s*<\/metadata>/g, '')
    .replace(/<c2pa:manifest>[\s\S]*?<\/c2pa:manifest>/g, '');
const isVector = (ref: AssetRef): boolean => ref.type === 'vector';
// A safe, readable download filename from an asset's name (or id), + extension.
function downloadName(ref: AssetRef, ext: string): string {
  const base = String(ref.meta?.name ?? ref.id.split('/').pop() ?? 'asset')
    .replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'asset';
  return `${base}.${ext}`;
}
const svgTextToDataUrl = (svg: string): string => 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
// Read a Blob's bytes as a `data:` URI — a self-contained href for an SVG <image>
// (an SVG used as an image may not load external refs), so a photo can be baked into
// a treatment wrapper client-side.
const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result));
  fr.onerror = () => rej(fr.error ?? new Error('blob read failed'));
  fr.readAsDataURL(blob);
});
// Rasterise an SVG (given as its markup) to a Blob at exact pixel dimensions, in the
// given image type. Drawing from a same-origin data URL avoids canvas tainting, so
// toBlob always succeeds. JPEG gets an opaque white fill first (it has no alpha).
async function svgToRaster(svgText: string, w: number, h: number, mime = 'image/png', quality = 0.92): Promise<Blob> {
  const img = new Image();
  img.decoding = 'async';
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('SVG decode failed'));
    img.src = svgTextToDataUrl(svgText);
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context');
  if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, quality));
  if (!blob) throw new Error('raster encode failed');
  return blob;
}
const svgToPng = (svgText: string, w: number, h: number): Promise<Blob> => svgToRaster(svgText, w, h, 'image/png');
// Read the intrinsic aspect ratio (w/h) from an SVG's viewBox, falling back to its
// width/height attributes (many exporters omit viewBox), default 1. Percentage sizes
// (e.g. width="100%") carry no ratio, so they're ignored.
function svgAspect(svgText: string): number {
  const vb = /viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/.exec(svgText);
  if (vb) { const w = parseFloat(vb[1]!), h = parseFloat(vb[2]!); if (w > 0 && h > 0) return w / h; }
  const dim = (name: string): number => {
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"|\\b${name}\\s*=\\s*'([^']+)'`, 'i').exec(svgText);
    const v = (m?.[1] ?? m?.[2] ?? '').trim();
    return !v || v.endsWith('%') ? NaN : parseFloat(v);   // parseFloat tolerates unit suffixes (px/pt)
  };
  const w = dim('width'), h = dim('height');
  if (w > 0 && h > 0) return w / h;
  return 1;
}

// The SVG's user-space extent [minX, minY, width, height] — from viewBox, else its
// width/height attrs, else a unit square. Used to map a crop fraction onto the real
// coordinate system so a vector crop stays vector (just a narrower viewBox).
function svgViewBox(svgText: string): [number, number, number, number] {
  const vb = /viewBox\s*=\s*["']\s*([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/.exec(svgText);
  if (vb) {
    const p = [vb[1], vb[2], vb[3], vb[4]].map(Number);
    if (p.every(n => isFinite(n)) && p[2]! > 0 && p[3]! > 0) return p as [number, number, number, number];
  }
  const dim = (name: string): number => {
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"|\\b${name}\\s*=\\s*'([^']+)'`, 'i').exec(svgText);
    const v = (m?.[1] ?? m?.[2] ?? '').trim();
    return !v || v.endsWith('%') ? NaN : parseFloat(v);
  };
  const w = dim('width'), h = dim('height');
  return [0, 0, w > 0 ? w : 100, h > 0 ? h : 100];
}

// Crop a vector by narrowing ONLY the root <svg>'s viewBox to the sub-rect (content
// coordinates are untouched, so it stays fully vector); width/height are set to the
// crop's size and preserveAspectRatio is forced to none so the box maps 1:1 (no
// letterbox). Only the opening tag is rewritten — child width/height are left alone.
function cropSvg(svgText: string, box: [number, number, number, number]): string {
  const [x, y, w, h] = box;
  const m = /<svg\b([^>]*)>/i.exec(svgText);
  if (!m) return svgText;
  const attrs = m[1]!.replace(/\s(viewBox|width|height|preserveAspectRatio)\s*=\s*("[^"]*"|'[^']*')/gi, '');
  const open = `<svg${attrs} viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}" preserveAspectRatio="none">`;
  return svgText.replace(m[0], open);
}

// ── Icons (Lucide house style) ────────────────────────────────────────────────
const STAR_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const SHARE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
const TAG_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
const EYE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
// Lucide "crop"
const CROP_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
// Larger left/right chevrons for the details modal's prev/next paging.
const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 6 9 12 15 18"/></svg>';
const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
const SLIDERS_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>';
const PENCIL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ZOOM_IN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
const ZOOM_OUT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
// Filled play/pause glyphs for the details-modal Lottie playback overlay.
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

/**
 * Pan/zoom the details-modal preview so a user can inspect an asset closely. Zoom *sizes*
 * the media element (`.cat-thumb`) — explicit width/height in px — rather than CSS-scaling
 * it, so a vector re-rasterises crisply at every step. (Icons carry a tiny intrinsic size —
 * e.g. `boxes` is 10.58px — which `max-width/object-fit` only *caps*, never upscales, so the
 * old `transform: scale()` was magnifying a ~11px bitmap.) At 100% the art is fit to the
 * stage; pan is a cheap translate, clamped so it can't be dragged fully out of view, and the
 * cursor point is held fixed on wheel/button zoom (focal-zoom formula about the centred
 * origin). Double-click toggles. All listeners live on the stage element, thrown away with
 * the modal — nothing to tear down.
 */
function attachZoom(dlg: HTMLDialogElement): void {
  const stage = dlg.querySelector<HTMLElement>('.cat-zoom-stage');
  const media = stage?.querySelector<HTMLElement>('.cat-thumb') ?? null;
  const pct = dlg.querySelector<HTMLElement>('.cat-zoom-pct');
  if (!stage || !media) return;
  const img = media as HTMLImageElement;
  // A Lottie preview is a mounted <svg> player (data-lottie-src marker), not an <img>: it has no
  // naturalWidth, and the SVG arrives asynchronously — so we read the aspect from its viewBox and
  // re-fit once it lands, rather than from decode()/load.
  const isLottie = media.hasAttribute('data-lottie-src');
  const MIN = 1, MAX = 16;               // 100%…1600%
  const PAD = 20;                        // matches .cat-zoom-stage padding
  let s = 1, tx = 0, ty = 0;
  // The s=1 "fit" box: the largest aspect-preserving rectangle inside the padded stage.
  // Zoom multiplies this box; the SVG/image then renders at that true pixel size. Measured
  // ONCE and locked — never re-measured in place. (In the mobile layout the stage height is
  // indefinite, so an already-enlarged media inflates stage.clientHeight; re-measuring off
  // that would feed back into an ever-growing base. Locking + the viewport cap below make it
  // impossible.) `object-fit: contain` (from CSS) centres the art, so a 0×0-reporting SVG
  // just falls back to the stage aspect without a runaway.
  let baseW = 0, baseH = 0, clipW = 0, clipH = 0, baseLocked = false;
  const measureBase = (): void => {
    // Lock the visible clip box at the SAME moment as the fit box, while the media is reset to
    // fit and the stage is deflated to its true size. clampPan must clamp against these locked
    // values — never a live getBoundingClientRect(). On the mobile layout the stage height is
    // indefinite (`.cat-details-preview` is `max-height: 46vh` + `overflow: hidden`), so a
    // zoomed media inflates the stage's live height to its own; clamping off that would collapse
    // the vertical pan range to ~0 and make the top/bottom corners unreachable.
    clipW = Math.min(stage.clientWidth, window.innerWidth);
    clipH = Math.min(stage.clientHeight, window.innerHeight);
    const availW = Math.max(1, clipW - PAD * 2);
    const availH = Math.max(1, clipH - PAD * 2);
    // Aspect: an <img> exposes naturalWidth/Height; a Lottie renders an <svg viewBox> we read once
    // it has mounted. Until either is known, fall back to the stage aspect (the SVG's own
    // preserveAspectRatio keeps the art undistorted meanwhile — measureBase re-runs on load).
    let ar = availW / availH;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) ar = img.naturalWidth / img.naturalHeight;
    else if (isLottie) {
      const vb = media.querySelector('svg')?.viewBox?.baseVal;
      if (vb && vb.width > 0 && vb.height > 0) ar = vb.width / vb.height;
    }
    baseW = availW; baseH = availW / ar;
    if (baseH > availH) { baseH = availH; baseW = availH * ar; }
    baseLocked = true;
  };
  const clampPan = (): void => {
    // The pan range is the ABSOLUTE gap between the art and the stage, per axis, so
    // the art can sit anywhere from centred to one edge aligned with the matching
    // stage edge. This is what lets a cursor-anchored (focal) zoom actually hold its
    // point: the fit box is sized to the CONSTRAINING dimension, so most assets have
    // a wide margin in the other axis at low zoom — a `max(0, overflow)` clamp pinned
    // that axis to centre and yanked the cursor point back to the middle on the first
    // wheel steps ("zoom doesn't follow the mouse"). Using the absolute gap gives the
    // focal offset room while still never letting the art leave the viewport.
    const mx = Math.abs(baseW * s - clipW) / 2;
    const my = Math.abs(baseH * s - clipH) / 2;
    tx = Math.min(mx, Math.max(-mx, tx));
    ty = Math.min(my, Math.max(-my, ty));
  };
  const apply = (): void => {
    if (!baseLocked) measureBase();
    media.style.maxWidth = 'none';
    media.style.maxHeight = 'none';
    media.style.width = `${baseW * s}px`;
    media.style.height = `${baseH * s}px`;
    // The media is absolutely positioned at the stage centre (CSS left/top:50%); translate(-50%,-50%)
    // pulls it back onto that centre, then (tx,ty) pans. Grid-centring an oversized item pins it to
    // the top-left, which broke focal zoom — see the .cat-zoom-stage CSS note. Order is irrelevant for
    // pure translations, but the -50% must be present so the art's centre = stage centre + (tx,ty).
    media.style.transform = `translate(-50%, -50%) translate(${tx}px, ${ty}px)`;
    if (pct) pct.textContent = `${Math.round(s * 100)}%`;
    stage.classList.toggle('is-zoomed', s > MIN + 0.001);
  };
  const zoomTo = (next: number, ox = 0, oy = 0): void => {
    const s2 = Math.min(MAX, Math.max(MIN, next));
    if (s2 === s) return;
    // Hold the cursor point fixed: screen offset = t + s·p about the centre origin.
    tx = ox - (s2 / s) * (ox - tx);
    ty = oy - (s2 / s) * (oy - ty);
    s = s2;
    if (s <= MIN + 0.001) { s = MIN; tx = 0; ty = 0; }
    clampPan();
    apply();
  };
  const offsetFrom = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = stage.getBoundingClientRect();
    return [e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)];
  };
  dlg.querySelector<HTMLElement>('.cat-zoom-hud')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]');
    if (!b) return;
    const act = b.dataset.zoom;
    if (act === 'in') zoomTo(s * 1.5);
    else if (act === 'out') zoomTo(s / 1.5);
    else { s = MIN; tx = 0; ty = 0; apply(); }
  });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [ox, oy] = offsetFrom(e);
    zoomTo(s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), ox, oy);
  }, { passive: false });
  let dragging = false, lastX = 0, lastY = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (s <= MIN) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    stage.classList.add('is-panning');
    try { stage.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    tx += e.clientX - lastX; ty += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    clampPan(); apply();
  });
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('is-panning');
    try { stage.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', (e) => {
    const [ox, oy] = offsetFrom(e);
    zoomTo(s > MIN ? MIN : 2.5, ox, oy);
  });
  // Re-fit once the intrinsic aspect ratio is known. `decode()` resolves after the bytes are
  // decoded (unlike `complete`, which can be true with naturalWidth still 0); fall back to the
  // load event for older engines. Reset to 100% and drop the inline size first so the stage
  // deflates to its true dimensions before we re-measure.
  const refit = (): void => {
    s = MIN; tx = 0; ty = 0;
    media.style.width = ''; media.style.height = '';
    baseLocked = false;
    apply();
  };
  if (isLottie) {
    // The player's <svg> mounts a tick or two after the modal opens; re-fit the moment it lands so
    // the fit box matches the animation's true aspect (else it stays at the stage-aspect fallback).
    // The observer is dropped after the first mount, or GC'd with the modal if it never arrives.
    if (media.querySelector('svg')) refit();
    else {
      const mo = new MutationObserver(() => {
        if (media.querySelector('svg')) { mo.disconnect(); refit(); }
      });
      mo.observe(media, { childList: true, subtree: true });
    }
  } else if (img.naturalWidth === 0) {
    if (typeof img.decode === 'function') img.decode().then(refit).catch(() => {});
    img.addEventListener('load', refit, { once: true });
  }
  apply();
}

interface ViewElement extends HTMLElement { _cleanup?: () => void; }

export async function mountCatalog(viewEl: HTMLElement, hostIn: HostV1, params = ''): Promise<void> {
  const host = hostIn as CatalogHost;
  // Deep link: /#/c?asset=<id> focuses (scrolls to + highlights) that asset on load.
  const linkedAsset = new URLSearchParams(params).get('asset');
  // Deep link: /#/c?section=<key>[,<key>…] lands with those sections EXPANDED (over the
  // collapsed-by-default state) and scrolls the first into view — the section-level sibling
  // of ?asset=. Validated against ALL_SECTION_KEYS at apply time (below).
  const linkedSections = (new URLSearchParams(params).get('section') || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  // Live state, re-read on reload(); the render reads these closure vars.
  let profile: Profile | null = null;
  let allAssets: AssetRef[] = [];
  let assetById = new Map<string, AssetRef>();
  let favSet = new Set<string>();
  let hiddenSet = new Set<string>();
  let overrides: Record<string, string> = {};
  // Lazily-built { assetId → lowercased search haystack }. Rebuilt on the first
  // matchesQuery of a search burst; invalidated whenever `overrides` (category labels
  // feed the haystack) or `allAssets` changes. Route every overrides write through
  // setOverrides so a future assignment can't leave a stale category label in search.
  let searchHaystack: Map<string, string> | null = null;
  const setOverrides = (v: Record<string, string>) => { overrides = v; searchHaystack = null; };
  let headshotUrl = '';
  let showHidden = false;
  let loadFailed = false;                    // the catalog query threw — a total sync failure, distinct from an empty catalogue
  let typeFilter: TypeFilter = 'all';        // filetype filter in the sticky toolbar (all/image/vector/motion)
  let query = '';                            // footer search text (lowercased); filters the asset grid
  let iconThemes: IconTheme[] = [];          // two-colour pairings for themable icons (styler)
  let catIconTheme: string | null = null;    // colour applied to a themable category's grid (null = base)
  const iconSvgCache = new Map<string, string>();  // base SVG text per themable-icon id — the recolour source
  let photoTreatments: PhotoTreatment[] = [];  // greyscale/duotone washes for raster photo groups (like iconThemes)
  let catPhotoTreatment: string | null = null; // treatment applied to a raster category's grid (null = original)
  const TREATMENT_FILTER_PREFIX = 'lolly-pt-'; // id prefix for the injected <filter> defs (live CSS preview)
  const collapsed = new Set<string>();      // section keys folded; survives re-render + persisted (see COLLAPSE_KEY)
  let mounted = true;                        // false after the view swaps out (guards async)
  let firstPaint = true;                     // arm the entrance cascade only on the first render
  let dlDialog: HTMLDialogElement | null = null;        // the download dialog, if open
  let detailsDialog: HTMLDialogElement | null = null;   // the asset details modal, if open
  let cropDialog: HTMLDialogElement | null = null;      // the crop dialog, if open

  // Multi-select of the user's OWN uploads (a closure Set of user-asset ids; survives the
  // render() that wipes viewEl.innerHTML). Only user uploads are selectable — shared
  // catalog assets can't be deleted (they're a permanent contract), only hidden. Mirrors
  // the projects view's checkbox + floating bulk-bar pattern.
  const selected = new Set<string>();

  // Favourites strip presentation — the same cinematic component as the Tools hero,
  // with a Gallery ↔ Cover Flow view mode and an on/off switch, both persisted. Kept
  // shorter than the hero (the previews shouldn't dominate the page here).
  const FAV_VIEW_KEY = 'lolly-catalog-fav-view';
  const FAV_STRIP_KEY = 'lolly-catalog-fav-strip';
  let favView: FeaturedViewMode = 'gallery';
  let favStripOn = true;
  let featuredHandle: FeaturedRowHandle | null = null;   // the mounted favourites strip, if any
  let lottieThumbs: { destroy(): void } | null = null;   // on-screen-gated lottie grid autoplayer
  let viewOptsOpen = false;
  let closeViewOpts: () => void = () => {};              // set in wire(); called on teardown
  try {
    const v = localStorage.getItem(FAV_VIEW_KEY);
    if (v === 'coverflow' || v === 'gallery') favView = v;
    if (localStorage.getItem(FAV_STRIP_KEY) === 'off') favStripOn = false;
  } catch { /* storage off */ }

  // Section fold state persists across reloads (like the fav-strip prefs above). The great
  // default for a big catalogue is EVERYTHING FOLDED — the page opens as a tidy stack of
  // section headers you expand on demand — so an absent key seeds every collapsible section.
  const COLLAPSE_KEY = 'lolly-catalog-collapsed';
  const ALL_SECTION_KEYS = ['your-uploads', ...LIB_GROUPS.map(g => g.key), 'hidden', 'swatches', 'fonts'];
  try {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    const keys = stored ? (JSON.parse(stored) as string[]) : ALL_SECTION_KEYS;
    for (const k of keys) collapsed.add(k);
  } catch { for (const k of ALL_SECTION_KEYS) collapsed.add(k); }
  const persistCollapsed = (): void => {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* storage off */ }
  };
  // Keep the address bar in step with the currently-EXPANDED sections (…#/c?section=a,b)
  // via replaceState — no navigation / no remount — so the live view is itself a copy-able
  // deep link. A bare #/c when everything is folded. Runs on user fold/unfold only.
  const syncSectionUrl = (): void => {
    const open = ALL_SECTION_KEYS.filter(k => !collapsed.has(k));
    const base = location.hash.split('?')[0] || '#/c';
    try {
      history.replaceState(history.state, '', `${location.pathname}${base}${open.length ? `?section=${open.join(',')}` : ''}`);
    } catch { /* history unavailable — non-fatal */ }
  };

  async function reload(): Promise<void> {
    // A thrown catalog query is a TOTAL sync failure — track it so the render can show a
    // distinct "couldn't load" state (with a Retry) rather than the identical-looking empty
    // catalogue. The other two loads degrade quietly (uploads/profile are best-effort).
    let failed = false;
    const [catalog, user, prof] = await Promise.all([
      host.assets.query({ includeDeprecated: true }).catch(() => { failed = true; return [] as AssetRef[]; }),
      host.assets._listUserAssets().catch(() => [] as AssetRef[]),
      host.profile.get().catch(() => null),
    ]);
    if (!mounted) return;
    loadFailed = failed;
    profile = prof;
    favSet = loadFavouriteAssets(prof);
    hiddenSet = loadHiddenAssets(prof);
    setOverrides(loadAssetCategories(prof));
    headshotUrl = prof?.headshot?.id
      ? (await host.assets.get(prof.headshot.id).catch(() => null))?.url || ''
      : '';
    const userVisual = user.filter(a => a.id !== HEADSHOT_ID);
    // Catalog first, then user uploads; only image-thumbnailable types.
    allAssets = [...catalog, ...userVisual].filter(a => VISUAL_TYPES.has(a.type));
    assetById = new Map(allAssets.map(a => [a.id, a]));
    searchHaystack = null; // asset set changed — drop the stale search index

    // Colour pairings for the themable-icon styler — only if the catalog supplies them.
    if (allAssets.some(isThemable) && typeof host.assets._iconThemes === 'function') {
      iconThemes = await host.assets._iconThemes().catch(() => [] as IconTheme[]);
    }
    // Photo colour treatments (greyscale/duotone) for raster groups — the bitmap sibling
    // of the icon colours; only fetched when the catalogue actually holds raster assets.
    if (allAssets.some(a => a.type === 'raster') && typeof host.assets._photoTreatments === 'function') {
      photoTreatments = await host.assets._photoTreatments().catch(() => [] as PhotoTreatment[]);
      if (catPhotoTreatment && !photoTreatments.some(t => t.id === catPhotoTreatment)) catPhotoTreatment = null;
    }
  }

  // ── markup ───────────────────────────────────────────────────────────────────
  function topRight(): string {
    return `
      <div class="gallery-topright">
        <button type="button" class="filter-fab cat-viewopts-btn" aria-label="View options" aria-haspopup="true" aria-expanded="${viewOptsOpen}" title="View options">${SLIDERS_ICON}</button>
        <a href="#/profile" class="profile-link${headshotUrl ? ' has-avatar' : ''}" aria-label="Open your profile">${headshotUrl ? `<img class="profile-link-avatar" src="${escape(headshotUrl)}" alt="">` : ''}<span class="profile-link-name">${escape(profile?.firstname || 'Profile')}</span></a>
        <div class="cat-viewopts filter-popover" role="group" aria-label="Catalog view options"${viewOptsOpen ? '' : ' hidden'}>
          ${themeSegmentHtml()}
          ${soundSegmentHtml()}
          <p class="filter-pop-head">Favourites</p>
          <div class="view-seg" role="group" aria-label="Favourites view mode">
            <button type="button" class="view-seg-btn" data-favview="gallery" aria-pressed="${favView === 'gallery'}">Gallery</button>
            <button type="button" class="view-seg-btn" data-favview="coverflow" aria-pressed="${favView === 'coverflow'}">Cover Flow</button>
          </div>
          <label class="filter-pop-check">
            <input type="checkbox" class="cat-favstrip-toggle"${favStripOn ? ' checked' : ''}>
            <span>Show favourites strip</span>
          </label>
        </div>
      </div>`;
  }

  // One collapsible section shell — the category, hidden, Swatches and Fonts groups all
  // use it, so "Collapse all" and the [data-cat-toggle] handler treat them uniformly.
  // Driven by the `collapsed` Set; an active search force-expands every group so matches
  // are never hidden behind a fold. `count` is optional (null → no pill); `extraClass`
  // lets a group opt into extra chrome (e.g. the reference-panel divider).
  function groupSection(key: string, label: string, count: number | null, bodyHtml: string, extraClass = ''): string {
    const isCollapsed = collapsed.has(key) && !query;
    return `<section class="cat-group${isCollapsed ? ' is-collapsed' : ''}${extraClass ? ' ' + extraClass : ''}" data-group="${escape(key)}">
      <button type="button" class="cat-group-head" data-cat-toggle="${escape(key)}" aria-expanded="${!isCollapsed}">
        <span class="cat-group-chevron">${CHEVRON}</span>
        <span class="cat-group-icon">${categoryGlyph(key)}</span>
        <span class="cat-group-title">${escape(label)}</span>
        ${count != null ? `<span class="cat-group-count">${count}</span>` : ''}
      </button>
      <div class="cat-group-body">${bodyHtml}</div>
    </section>`;
  }
  // Asset groups wrap their tiles in the responsive .cat-grid.
  const sectionHtml = (key: string, label: string, count: number, tilesHtml: string): string =>
    groupSection(key, label, count, `<div class="cat-grid">${tilesHtml}</div>`);

  // `asSpan` renders the thumbnail with span-only markup (for nesting inside a <button>);
  // otherwise a plain <img>/<div>. Both are used: tiles nest it in the open-details button.
  function thumbHtml(ref: AssetRef, asSpan = false, full = false): string {
    const tag = asSpan ? 'span' : 'div';
    if (ref.meta?._placeholder) return `<${tag} class="cat-thumb cat-thumb-stub">${escape(ref.type)}</${tag}>`;
    // Lottie: a looping player mounted over the still poster — autoplayLottieThumbs mounts it
    // while the tile is on screen; the poster background (or a ▶ for a posterless user upload)
    // is the resting frame. The json is the play source: a library lottie exposes it on
    // meta.animationUrl (ref.url is the poster); a user upload's url IS the json.
    if (ref.type === 'lottie') {
      const json = ref.source === 'user' ? ref.url : (typeof ref.meta?.animationUrl === 'string' ? ref.meta.animationUrl : '');
      const poster = ref.source !== 'user' && typeof ref.meta?.posterUrl === 'string' ? ref.meta.posterUrl : '';
      // A looping SVG player mounted over the still poster. Grid tiles get it via
      // autoplayLottieThumbs (on-screen gated); the details modal (full) mounts one player and
      // makes it zoomable — a Lottie renders as SVG, so it inspects crisply like vector art,
      // with a play/pause overlay (openDetails). The poster is the resting background until the
      // player loads; a posterless user upload shows a centred ▶. In the modal attachZoom sizes
      // the box explicitly, so the "no intrinsic height" grid caveat doesn't apply.
      if (json) {
        const style = poster ? ` style="background-image:url('${escape(poster)}')"` : '';
        return `<${tag} class="cat-thumb cat-thumb-motion" data-lottie-src="${escape(json)}" data-lottie-fit="contain"${style} aria-hidden="true">${poster ? '' : '▶'}</${tag}>`;
      }
      if (poster) return `<img class="cat-thumb" src="${escape(poster)}" alt="" loading="lazy" decoding="async">`;
      return `<span class="cat-thumb cat-thumb-stub" aria-hidden="true">▶</span>`;
    }
    // A video plays itself (an <img> src=mp4 would break). <video> is phrasing
    // content, so it's valid inside the tile's <button> — no span/div switch needed.
    // muted + playsinline are mandatory for autoplay. (gif/apng/animated-webp are
    // type:'raster' and animate natively in the <img> below.)
    if (ref.type === 'video') {
      return `<video class="cat-thumb" src="${escape(ref.url)}" muted loop autoplay playsinline preload="metadata"></video>`;
    }
    // Grid tiles show the small `thumb` derivative (query() puts its url on meta.thumbUrl);
    // the details/zoom modal passes full=true to keep the original for close inspection.
    const src = !full && typeof ref.meta?.thumbUrl === 'string' && ref.meta.thumbUrl ? ref.meta.thumbUrl : ref.url;
    return `<img class="cat-thumb" src="${escape(src)}" alt="" loading="lazy" decoding="async">`;
  }

  // A row of two-colour theme swatches (the icon "colours" picker) — shared by the download
  // dialog, the asset-details modal and the icons-category header, so they all offer the same
  // control. Reuses the download dialog's .cat-dl-theme / .cat-dl-duo chrome; `active` marks
  // the current pairing.
  const iconSwatchRow = (active: string | null): string =>
    `<div class="cat-dl-themes" role="group" aria-label="Icon colours">${iconThemes.map(t =>
      `<button type="button" class="cat-dl-theme${t.id === active ? ' is-active' : ''}" data-theme="${escape(t.id)}" data-sfx="shimmer" data-voice="${escape(t.label ?? t.id)}" aria-pressed="${t.id === active}" title="${escape(t.label ?? t.id)}"><span class="cat-dl-duo" style="background:${escape(t.previewBg ?? '#fff')}"><i style="background:${escape(String(t.c2 ?? '#888'))}"></i><i style="background:${escape(String(t.c1 ?? '#333'))}"></i></span></button>`).join('')}</div>`;

  // The bitmap sibling of iconSwatchRow: a photo-treatment strip for raster groups. Leads
  // with an "Original" (no-treatment) button, then one gradient swatch per treatment
  // (greyscale ramp / duotone shadow→highlight). Reuses the .cat-dl-theme chrome; the extra
  // .cat-dl-treat class routes clicks to the treatment handler (not the icon one).
  const treatmentSwatchRow = (active: string | null): string => {
    const swatch = (t: PhotoTreatment): string => {
      if (t.kind === 'greyscale') return 'linear-gradient(135deg,#2b2b2b,#e9e9e9)';
      const stops = [t.shadow ?? '#333', t.mid, t.highlight ?? '#eee'].filter(Boolean).map(c => escape(String(c)));
      return `linear-gradient(135deg,${stops.join(',')})`;
    };
    return `<div class="cat-dl-themes" role="group" aria-label="Photo colour treatment">`
      + `<button type="button" class="cat-dl-theme cat-dl-treat${!active ? ' is-active' : ''}" data-treatment="" data-voice="Original" aria-pressed="${!active}" title="Original — no treatment" style="width:auto;padding:0 9px;font-size:11px;font-weight:600">Original</button>`
      + photoTreatments.map(t =>
        `<button type="button" class="cat-dl-theme cat-dl-treat${t.id === active ? ' is-active' : ''}" data-treatment="${escape(t.id)}" data-sfx="shimmer" data-voice="${escape(t.label ?? t.id)}" aria-pressed="${t.id === active}" title="${escape(t.label ?? t.id)}"><span class="cat-dl-duo" style="background:${swatch(t)}"></span></button>`).join('')
      + `</div>`;
  };

  function assetTile(ref: AssetRef): string {
    const base = assetBaseId(ref.id);
    const fav = favSet.has(base);
    const hidden = hiddenSet.has(base);
    const name = String(ref.meta?.name ?? ref.id);
    const fmt = ref.type === 'lottie' ? 'LOTTIE' : (ref.format ? String(ref.format).toUpperCase() : '');
    const isUser = ref.source === 'user';
    const sourceLabel = isUser ? 'Yours' : 'Catalog';
    // Only the user's own uploads carry a selection checkbox (catalog assets can't be
    // bulk-deleted). The whole tile body (bar the star + checkbox) opens the details modal.
    const sel = isUser && selected.has(ref.id);
    return `
      <div class="cat-tile${fav ? ' is-fav' : ''}${hidden ? ' is-hidden-asset' : ''}${sel ? ' is-selected' : ''}" data-id="${escape(ref.id)}">
        ${isUser ? `<button type="button" class="cat-check" data-select="${escape(ref.id)}" aria-pressed="${sel}" aria-label="Select ${escape(name)}" title="Select">${CHECK_ICON}</button>` : ''}
        <button type="button" class="cat-tile-open" data-open="${escape(ref.id)}" aria-label="View ${escape(name)} details">
          <span class="cat-tile-fig">${thumbHtml(ref, true)}</span>
          <span class="cat-tile-cap">
            <span class="cat-tile-name" title="${escape(name)}">${escape(name)}</span>
            <span class="cat-tile-sub"><span class="cat-src cat-src--${isUser ? 'user' : 'lib'}">${sourceLabel}</span>${fmt ? ` · ${escape(fmt)}` : ''}</span>
          </span>
        </button>
        <button type="button" class="cat-star" data-star="${escape(ref.id)}" data-sfx="twinkle" aria-pressed="${fav}" title="${fav ? 'Remove from favourites' : 'Add to favourites'}" aria-label="${fav ? 'Remove' : 'Add'} ${escape(name)} ${fav ? 'from' : 'to'} favourites">${STAR_ICON}</button>
      </div>`;
  }

  // Assets the user hasn't hidden.
  const visibleAssets = (): AssetRef[] => allAssets.filter(a => !hiddenSet.has(assetBaseId(a.id)));
  // Filetype-filter predicate (sticky toolbar) — 'all' passes everything; otherwise the
  // asset's type must fall in the selected bucket (image/vector/motion).
  function matchesType(a: AssetRef): boolean {
    return typeFilter === 'all' || TYPE_FILTER_TYPES[typeFilter].has(a.type);
  }
  // Footer-search predicate: match the name, id, tags, category label or format.
  function matchesQuery(a: AssetRef): boolean {
    if (!query) return true;
    if (!searchHaystack) {
      searchHaystack = new Map();
      for (const x of allAssets) {
        const tags = ((x.meta?.tags as string[] | undefined) ?? []).join(' ');
        searchHaystack.set(x.id, `${String(x.meta?.name ?? '')} ${x.id} ${tags} ${categoryLabel(libCategory(x, overrides))} ${x.format ?? x.type}`.toLowerCase());
      }
    }
    return (searchHaystack.get(a.id) ?? '').includes(query);
  }
  // Favourited, visible assets — deduped by base id, catalog-then-user order.
  function favItems(): AssetRef[] {
    const seen = new Set<string>(); const out: AssetRef[] = [];
    for (const a of visibleAssets()) {
      const b = assetBaseId(a.id);
      if (favSet.has(b) && !seen.has(b)) { seen.add(b); out.push(a); }
    }
    return out;
  }

  // The "Your uploads" section — a standard `.cat-group`, but its body leads with a
  // "Select all / Deselect all" control. The control lives INSIDE the collapsible body
  // (not the header) so it folds away with the grid when the section is collapsed —
  // a bulk-select toggle over a hidden grid just reads as confusing.
  function uploadsSectionHtml(items: AssetRef[]): string {
    const key = 'your-uploads';
    const isCollapsed = collapsed.has(key) && !query;
    const allSel = items.length > 0 && items.every(a => selected.has(a.id));
    // Your own raster uploads get the same photo-treatment strip the library photo
    // groups do — pick a greyscale/duotone wash and the whole uploads grid recolours
    // in place (retreatGroup keys off tile type, not source, so it just works).
    const treatable = photoTreatments.length > 0 && items.some(a => a.type === 'raster');
    const colourRow = treatable
      ? `<div class="cat-dl-section cat-group-colours"><span class="cat-dl-label">Colour</span>${treatmentSwatchRow(catPhotoTreatment)}</div>`
      : '';
    return `<section class="cat-group cat-group--uploads${isCollapsed ? ' is-collapsed' : ''}" data-group="${key}">
      <button type="button" class="cat-group-head" data-cat-toggle="${key}" aria-expanded="${!isCollapsed}">
        <span class="cat-group-chevron">${CHEVRON}</span>
        <span class="cat-group-icon">${categoryGlyph('uploads')}</span>
        <span class="cat-group-title">Your uploads</span>
        <span class="cat-group-count">${items.length}</span>
      </button>
      <div class="cat-group-body">
        <div class="cat-uploads-bar"><button type="button" class="cat-uploads-selectall" data-selectall aria-pressed="${allSel}">${allSel ? 'Deselect all' : 'Select all'}</button></div>
        ${colourRow}
        <div class="cat-grid">${items.map(assetTile).join('')}</div>
      </div>
    </section>`;
  }

  function assetsSectionHtml(): string {
    const hiddenItems = allAssets.filter(a => hiddenSet.has(assetBaseId(a.id)));
    // Filter by search first; the count + category buckets both read the matched set.
    const visible = visibleAssets().filter(matchesQuery).filter(matchesType);

    // A total sync failure (nothing loaded) reads distinctly from a genuinely empty
    // catalogue — a "couldn't load" message with a Retry that re-runs the load (wired in
    // wire()). Uploads loading while the catalog query failed fall through to the grid.
    if (loadFailed && allAssets.length === 0) {
      return `<div class="cat-empty" role="alert">
        <p>Couldn't load the catalogue. Check your connection, then retry.</p>
        <button type="button" class="btn cat-retry" style="margin-top:1rem">Retry</button>
      </div>`;
    }

    if (allAssets.length === 0) {
      return `<p class="cat-empty" role="status">No assets found. Once the catalogue syncs — and after you upload your own images — they'll appear here.</p>`;
    }

    // Favourites are presented as a cinematic strip (mounted after render, see
    // mountFavStrip) — a placeholder goes here when the strip is enabled and non-empty.
    // Favourited items still appear in their category group below (the strip is a
    // shortcut, matching the picker's favourites-plus-groups behaviour). Hidden while
    // searching so the results grid is the whole focus.
    const showStrip = favStripOn && !query && favItems().length > 0;

    // The user's OWN uploads lead the grid (right after the favourites strip): pulled out
    // of the category groups into one "Your uploads" section they manage in one place.
    // Catalog assets keep their category bucketing below.
    const userItems = visible.filter(a => a.source === 'user');
    const catalogItems = visible.filter(a => a.source !== 'user');

    // Bucket the catalog assets by (override-aware) category, in LIB_GROUPS order.
    const buckets = new Map<string, AssetRef[]>();
    for (const a of catalogItems) {
      const k = libCategory(a, overrides);
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(a);
    }

    const parts: string[] = [];
    if (userItems.length) parts.push(uploadsSectionHtml(userItems));
    for (const g of LIB_GROUPS) {
      const items = buckets.get(g.key);
      if (!items?.length) continue;
      // A category of themable icons gets the same colour swatches as the download/details
      // views — pick one and the whole grid recolours (see the .cat-dl-theme handler in wire).
      // A raster/bitmap category (photos, campaign, headshots) instead gets a photo-treatment
      // strip — the bitmap sibling — that washes the whole grid in place. Mutually exclusive.
      const themableGroup = iconThemes.length > 0 && items.some(isThemable);
      const treatableGroup = !themableGroup && photoTreatments.length > 0 && items.some(a => a.type === 'raster');
      const colourRow = themableGroup
        ? `<div class="cat-dl-section cat-group-colours"><span class="cat-dl-label">Colours</span>${iconSwatchRow(catIconTheme)}</div>`
        : treatableGroup
          ? `<div class="cat-dl-section cat-group-colours"><span class="cat-dl-label">Colour</span>${treatmentSwatchRow(catPhotoTreatment)}</div>`
          : '';
      parts.push(groupSection(g.key, g.label, items.length, colourRow + `<div class="cat-grid">${items.map(assetTile).join('')}</div>`));
    }
    // Hidden assets never match a search (they're not in `visible`); keep them under a
    // dedicated group only in the normal (non-search) view.
    if (showHidden && !query && hiddenItems.length) {
      parts.push(sectionHtml('hidden', 'Hidden', hiddenItems.length, hiddenItems.map(assetTile).join('')));
    }

    // No group matched the active filters → a clear empty line instead of a bare toolbar.
    // Guarded on the search AND the type filter, so choosing a filter (e.g. Motion) that
    // matches nothing explains the empty grid rather than showing a bare "0 assets".
    if (!parts.length && (query || typeFilter !== 'all')) {
      const typeLabel = typeFilter === 'all' ? '' : (TYPE_FILTERS.find(f => f.key === typeFilter)?.label ?? '').toLowerCase();
      const msg = query && typeLabel
        ? `No ${typeLabel} assets match “${escape(query)}”.`
        : query
          ? `No assets match “${escape(query)}”.`
          : `No ${typeLabel} assets in the catalogue.`;
      // A "clear search" button when a query is active (mirrors projects.ts) — routed to
      // clearSearch() via the body's delegated [data-search-clear] handler in wire().
      const clearBtn = query ? ` <button type="button" class="projects-linkbtn" data-search-clear>Clear search</button>` : '';
      parts.push(`<p class="cat-empty" role="status">${msg}${clearBtn}</p>`);
    }

    // Label the Collapse/Expand-all toggle for the state it will actually be in: with folds
    // now defaulting to closed, "Expand all" is the honest first-load label. Mirror the set
    // of sections the body will render (asset groups here + Swatches/Fonts from bodyHtml).
    const renderedKeys = [
      ...(userItems.length ? ['your-uploads'] : []),
      ...LIB_GROUPS.filter(g => buckets.get(g.key)?.length).map(g => g.key),
      ...(showHidden && hiddenItems.length ? ['hidden'] : []),
      'swatches', 'fonts',
    ];
    const anyExpanded = renderedKeys.some(k => !collapsed.has(k));
    // The toolbar is a floating pill that sticks to the top as you scroll past the header,
    // so the filetype filter + Expand/Collapse-all + Hide-hidden are always reachable. The
    // filter (image/vector/motion) stays available even during a search, so you can narrow
    // results by type; the collapse + hide-hidden toggles are section-management, so they're
    // dropped while searching (there are no folds to manage in a flat results grid).
    const filterSeg = `
      <div class="cat-typefilter" role="group" aria-label="Filter by file type">
        ${TYPE_FILTERS.map(f => `<button type="button" class="cat-typefilter-opt${typeFilter === f.key ? ' is-on' : ''}" data-typefilter="${f.key}"${f.sfx ? ` data-sfx="${f.sfx}"` : ''} data-voice="${escape(f.label)}" aria-pressed="${typeFilter === f.key}" aria-label="${f.label}" title="${f.label}">${f.icon}<span class="cat-btn-label">${f.label}</span></button>`).join('')}
      </div>`;
    const collapseLabel = anyExpanded ? 'Collapse all' : 'Expand all';
    const showHiddenLabel = showHidden ? 'Hide hidden' : `Show hidden (${hiddenItems.length})`;
    // Reserve the counter's width for the widest string it can ever show, so switching filters
    // (which only ever shrink the number) never re-widths the centred toolbar pill and shifts the
    // filter buttons. Floor the digit count at 4 — a few thousand assets — so the reservation
    // doesn't track the current total and a low filtered number can't narrow it; size the suffix
    // for the mode (" assets" normally, " assets found" while searching, where the trailing
    // buttons drop but the type pills still centre off this width). +1ch of slack keeps min-width
    // clear of the text so the span is a true fixed width, not sitting on the content boundary.
    const countCh = Math.max(String(visibleAssets().length).length, 4) + (query ? 14 : 8);
    const toolbar = `
      <div class="cat-toolbar">
        ${filterSeg}
        <span class="cat-count" style="min-width:${countCh}ch">${visible.length} asset${visible.length === 1 ? '' : 's'}${query ? ' found' : ''}</span>
        ${query ? '' : `<button type="button" class="cat-showhidden cat-collapse-all" aria-label="${collapseLabel}" title="${collapseLabel}">${anyExpanded ? CAT_ICONS.collapse : CAT_ICONS.expand}<span class="cat-btn-label">${collapseLabel}</span></button>`}
        ${hiddenItems.length && !query ? `<button type="button" class="cat-showhidden${showHidden ? ' is-on' : ''}" aria-pressed="${showHidden}" aria-label="${showHiddenLabel}" title="${showHiddenLabel}">${showHidden ? CAT_ICONS.eyeOff : CAT_ICONS.eye}<span class="cat-btn-label">${showHiddenLabel}</span></button>` : ''}
      </div>`;
    return `
      <section class="cat-assets">
        ${showStrip ? '<div class="cat-fav-strip"></div>' : ''}
        ${toolbar}${parts.join('')}
      </section>`;
  }

  // Mount (or re-mount) the favourites strip into its placeholder using the shared
  // featured-row component — same Gallery/Cover-Flow presentation as the Tools hero,
  // but each tile links to the asset's share deep link (→ its details modal).
  function mountFavStrip(): void {
    featuredHandle?.destroy();
    featuredHandle = null;
    const mount = viewEl.querySelector<HTMLElement>('.cat-fav-strip');
    if (!mount) return;
    const items = favItems();
    if (!items.length) return;
    const entries: FeaturedEntry[] = items.map(a => ({
      id: a.id,
      name: String(a.meta?.name ?? a.id),
      // A user-uploaded lottie's url is JSON, and a video's url is mp4/webm — an <img>
      // (what the featured-row renders) would break on either, so omit the preview
      // (the strip shows its themed backdrop) rather than a broken tile.
      preview: (a.meta?._placeholder || (a.type === 'lottie' && a.source === 'user') || a.type === 'video') ? undefined : a.url,
      formats: a.format ? [a.format] : undefined,
      href: `#/c?asset=${encodeURIComponent(a.id)}`,   // → this view + the details modal
      featured: {},                                     // no tool variants: strip just shows the preview
    }));
    featuredHandle = mountFeaturedRow(mount, entries, host, {
      viewMode: favView,
      label: 'Favourites',
      ariaLabel: 'Favourite assets',
    });
  }

  // Reflect a favourites-MEMBERSHIP change (add/remove) in the strip without a full
  // re-render. The featured-row handle has no incremental entry API, so re-mount just the
  // strip (cheap next to rebuilding the whole grid) — creating or dropping its placeholder
  // as the favourites set crosses empty↔non-empty, exactly like the .cat-favstrip-toggle
  // handler. No-op while the strip is off or a search is active (it isn't shown then).
  function refreshFavStrip(): void {
    if (!favStripOn || query) return;
    const assets = viewEl.querySelector<HTMLElement>('.cat-assets');
    if (!assets) return;
    let mount = viewEl.querySelector<HTMLElement>('.cat-fav-strip');
    if (favItems().length) {
      if (!mount) {
        mount = document.createElement('div'); mount.className = 'cat-fav-strip';
        assets.insertBefore(mount, assets.firstChild);
      }
      mountFavStrip();
    } else {
      featuredHandle?.destroy(); featuredHandle = null; mount?.remove();
    }
  }

  // Flip every grid tile sharing this base id to the given favourite state, in place —
  // the tile class, star pressed-state and its labels — matching what assetTile() would
  // render. Favourited assets keep their category-bucket tile (the strip is a shortcut,
  // not a bucket move), so this + refreshFavStrip() fully cover a fav toggle.
  function reflectFavInGrid(base: string, on: boolean): void {
    for (const tile of viewEl.querySelectorAll<HTMLElement>('.cat-tile')) {
      const id = tile.dataset.id ?? '';
      if (assetBaseId(id) !== base) continue;
      tile.classList.toggle('is-fav', on);
      const star = tile.querySelector<HTMLElement>('.cat-star');
      if (!star) continue;
      const name = String(assetById.get(id)?.meta?.name ?? id);
      star.setAttribute('aria-pressed', String(on));
      star.setAttribute('title', on ? 'Remove from favourites' : 'Add to favourites');
      star.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${name} ${on ? 'from' : 'to'} favourites`);
    }
  }

  // Swatches + Fonts are collapsible groups too (same shell as the asset categories), so
  // "Collapse all" folds them and the whole page reads as one uniform stack of sections.
  // Their rich bodies keep the existing .cat-panel-* / .plat-* styling. `cat-group--ref`
  // draws a divider above the first one to set the reference zone apart from the assets.
  function swatchesSectionHtml(): string {
    const { brand, spectrum, ramps } = groupPalette(PALETTE);
    const total = brand.length + spectrum.length + ramps.reduce((n, [, cols]) => n + cols.length, 0);
    const grid = (list: typeof brand) => `<div class="plat-swatch-grid">${list.map(swatch).join('')}</div>`;
    const rampBlocks = ramps.map(([fam, cols]) =>
      `<h3 class="cat-panel-subhead">${escape(fam)}</h3>${grid(cols)}`).join('');
    const body = `
      <p class="cat-panel-desc">The brand palette. Click any chip to copy its hex. A <span class="plat-chip-flag is-static">CMYK</span> flag marks measured ink values used directly in CMYK PDF exports.</p>
      <h3 class="cat-panel-subhead">Brand</h3>${grid(brand)}
      ${spectrum.length ? `<h3 class="cat-panel-subhead">Spectrum</h3>${grid(spectrum)}` : ''}
      ${rampBlocks}`;
    return groupSection('swatches', 'Swatches', total, body, 'cat-group--ref');
  }

  function fontsSectionHtml(): string {
    const cards = FONTS.map(f => `
      <article class="plat-font cat-font">
        <header class="plat-font-head">
          <span class="plat-font-name" style="font-family:${f.stack}">${escape(f.family)}</span>
          <span class="plat-font-role">${escape(f.role)}</span>
        </header>
        <div class="plat-font-specimen" style="font-family:${f.stack}">
          <div class="plat-font-aa">Aa</div>
          <p class="plat-font-pangram">The quick brown fox jumps over the lazy dog 0123456789</p>
          <div class="plat-font-weights">
            ${WEIGHT_RAMP.map(w => `<span style="font-weight:${w}">${w}</span>`).join('')}
          </div>
        </div>
        <dl class="plat-kv">
          <div><dt>Type</dt><dd>${f.variable ? 'Variable' : 'Static'} · ${escape(f.weights)}</dd></div>
          <div><dt>Styles</dt><dd>${f.styles.map(escape).join(', ')}</dd></div>
        </dl>
        <div class="cat-font-downloads">
          ${f.downloads.map(d => `<a class="cat-download" href="${d.href}" download>${DOWNLOAD_ICON}<span>${escape(d.label)}</span></a>`).join('')}
        </div>
      </article>`).join('');
    const body = `
      <p class="cat-panel-desc">The bundled variable typefaces — available to every tool canvas and the app UI. Download the axis files, or read the licence.</p>
      <div class="plat-font-grid cat-font-grid">${cards}</div>
      <p class="cat-panel-foot">Licensed under the <a href="${FONT_LICENSE.href}" target="_blank" rel="noopener">${escape(FONT_LICENSE.label)}</a>.</p>`;
    return groupSection('fonts', 'Fonts', FONTS.length, body);
  }

  // The scrollable content. Swatches + Fonts are reference material, not searchable
  // assets — drop them while a search is active so the results grid stands alone.
  const bodyHtml = (): string =>
    `${assetsSectionHtml()}${(query || typeFilter !== 'all') ? '' : swatchesSectionHtml() + fontsSectionHtml()}`;

  // Floating bulk-action bar for a multi-selection of uploads (mirrors the projects
  // view's bar). Rendered once per render(); shown/populated by syncBulkBar().
  function bulkBarHtml(): string {
    return `
      <div class="cat-bulkbar" role="region" aria-label="Selection actions" hidden>
        <span class="cat-bulkbar-count" aria-live="polite"></span>
        <div class="cat-bulkbar-actions">
          <button type="button" class="btn cat-bulk-danger" data-bulk="delete">${TRASH_ICON}<span>Delete</span></button>
        </div>
        <button type="button" class="cat-bulkbar-clear" data-bulk="clear" aria-label="Clear selection">✕</button>
      </div>`;
  }

  function render(): void {
    pruneSelection();
    viewEl.innerHTML = `
      <div class="catalog">
        <div class="gallery-topbar">
          <div class="view-toggle-wrap">${viewToggle('catalog')}</div>
          ${topRight()}
        </div>
        <h1 class="visually-hidden">Catalogue</h1>
        <div class="catalog-body">${bodyHtml()}</div>
        ${footerNav({
          proEnabled: flagEnabled(profile, PRO_FLAG.id),
          // The gallery's search field + a visible ✕ clear button (shown only while there's
          // a query) — like the Tools box but with the clear affordance projects.ts carries.
          // type="text" (not "search") so the browser's own cancel button doesn't double up
          // with ours; the ✕ reuses projects' fully-styled .projects-search-clear chrome.
          searchHtml: `
            <div class="gallery-search-wrap">
              <div class="gallery-search-box">
                <span class="gallery-search-icon" aria-hidden="true">${NAV_ICONS.search}</span>
                <input class="gallery-search" type="text" placeholder="Search the catalogue…" autocomplete="off" spellcheck="false" aria-label="Search the catalogue" value="${escape(query)}" style="padding-right:32px">
                <button type="button" class="projects-search-clear" data-search-clear aria-label="Clear search"${query ? '' : ' hidden'}>✕</button>
              </div>
            </div>`,
        })}
        ${bulkBarHtml()}
      </div>`;
    wire();
    mountFavStrip();
    syncBulkBar();
    reapplyTreatment();
    mountLottieThumbs();
    if (firstPaint) { armViewEnter(viewEl, '.cat-assets, .cat-group--ref'); firstPaint = false; }
  }

  // Search re-render: rebuild ONLY the body so the fixed footer — and the search input's
  // focus + caret — survive between keystrokes. The body's delegated click handler is
  // bound to the persistent .catalog-body element, so it survives too.
  // (Re)mount the on-screen-gated lottie autoplayer over the current grid. Called after every
  // body (re)render; destroys the prior observer first so re-renders don't stack players.
  function mountLottieThumbs(): void {
    lottieThumbs?.destroy();
    const body = viewEl.querySelector<HTMLElement>('.catalog-body');
    lottieThumbs = body ? autoplayLottieThumbs(body, { isCurrent: () => mounted }) : null;
  }

  function renderBody(): void {
    const body = viewEl.querySelector<HTMLElement>('.catalog-body');
    if (!body) { render(); return; }
    pruneSelection();
    body.innerHTML = bodyHtml();
    mountFavStrip();
    syncBulkBar();
    reapplyTreatment();
    mountLottieThumbs();
  }

  // Re-render from state, preserving the document scroll position so an in-page action
  // (star / hide / recategorise) doesn't jump the page to the top.
  function rerender(): void {
    if (!mounted) return;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  // ── asset details modal ─────────────────────────────────────────────────────────
  // Opened by clicking a tile OR by a share deep link (/#/c?asset=<id>). Holds the big
  // preview, metadata, and every per-asset action, so a shared link resolves to a real
  // destination (this modal over the catalog), not a bare download.
  function closeDetails(): void {
    if (detailsDialog) {
      // Destroy any Lottie player mounted in the preview — lottie-web ticks every mounted player
      // from one global rAF and won't stop on removal alone, so an un-reaped modal player leaks a loop.
      destroyLottiePlayers(detailsDialog);
      if (detailsDialog.open) detailsDialog.close(); detailsDialog.remove(); detailsDialog = null;
    }
  }
  // The canonical shareable link that reopens this modal from the catalog view.
  const assetLink = (ref: AssetRef): string =>
    `${location.origin}${location.pathname}#/c?asset=${encodeURIComponent(ref.id)}`;

  // The previous/next asset for the details modal's lightbox paging — in on-screen grid
  // order, skipping tiles inside a collapsed group so paging matches what's visible.
  function navRefs(ref: AssetRef): { prev: AssetRef | null; next: AssetRef | null } {
    const ids = [...viewEl.querySelectorAll<HTMLElement>('[data-open]')]
      .filter(el => !el.closest('.cat-group.is-collapsed'))
      .map(el => el.dataset.open!)
      .filter(Boolean);
    const i = ids.indexOf(ref.id);
    const at = (k: number): AssetRef | null => {
      const id = k >= 0 && k < ids.length ? ids[k] : undefined;
      return id ? assetById.get(id) ?? null : null;
    };
    return { prev: i > 0 ? at(i - 1) : null, next: i >= 0 ? at(i + 1) : null };
  }

  function openDetails(ref: AssetRef, initialTheme?: string | null, initialTreatment?: string | null): void {
    const nav = navRefs(ref);
    const base = assetBaseId(ref.id);
    const isUser = ref.source === 'user';
    const fav = favSet.has(base);
    const hidden = hiddenSet.has(base);
    const name = String(ref.meta?.name ?? ref.id);
    const tags = (ref.meta?.tags as string[] | undefined) ?? [];
    // Themable icons get the same colour swatches as the download dialog, right here in the
    // details view — pick a pairing and the preview recolours live; Download + Copy-link then
    // carry the choice. dBaseSvg caches the raw SVG so re-colouring doesn't re-fetch.
    const themable = isThemable(ref) && iconThemes.length > 0;
    // Raster photos get the bitmap sibling: a colour-treatment strip (greyscale/duotone) that
    // washes the preview live and bakes into the download — mirroring the category grid.
    const treatable = ref.type === 'raster' && !ref.meta?._placeholder && photoTreatments.length > 0;
    // Anything with a styler (vector/themable icon, or a treatable photo) offers a Download…
    // dialog rather than a bare download.
    const configurable = isVector(ref) || isThemable(ref) || treatable;
    // Honour a theme from a shared link (initialTheme) if it's valid, else the first pairing.
    let dTheme: string | null = themable
      ? ((initialTheme && iconThemes.some(t => t.id === initialTheme) ? initialTheme : iconThemes[0]?.id) ?? null)
      : null;
    // Photo treatment: honour a valid initial (shared link / category selection), else Original.
    let dTreatment: string | null = treatable && initialTreatment && photoTreatments.some(t => t.id === initialTreatment)
      ? initialTreatment
      : null;
    let dBaseSvg: string | null = null;
    // A Lottie plays in the details view as a live SVG player (mounted below), not a still — with a
    // play/pause overlay. Both library (json on meta.animationUrl) and user (url IS the json) lotties.
    const lottieJson = ref.type === 'lottie'
      ? (ref.source === 'user' ? ref.url : (typeof ref.meta?.animationUrl === 'string' ? ref.meta.animationUrl : ''))
      : '';
    const isMotionLottie = !!lottieJson;
    // Zoomable when the preview is a real still image OR a Lottie (both inspect crisply under zoom —
    // a Lottie renders as SVG). A video reads better auto-playing at fit-size, so it opts out; a
    // placeholder/dataless-lottie stub has nothing to zoom. attachZoom handles the <svg> player.
    const zoomable = !ref.meta?._placeholder
      && ref.type !== 'video'
      && !(ref.type === 'lottie' && !isMotionLottie);
    // Crop only makes sense on a static raster/vector — never a live motion preview.
    const croppable = zoomable && !isMotionLottie;
    const wasOpen = !!detailsDialog; // paging (←/→) replaces an open modal — cue only a FRESH open
    closeDetails();
    const dlg = document.createElement('dialog');
    dlg.className = 'cat-details';
    dlg.innerHTML = `
      <button type="button" class="cat-details-close" data-act="close" aria-label="Close">×</button>
      <div class="cat-details-preview${zoomable ? ' is-zoomable' : ''}">
        ${nav.prev ? `<button type="button" class="cat-details-nav cat-details-prev" data-nav="prev" aria-label="Previous asset">${CHEVRON_LEFT}</button>` : ''}
        ${nav.next ? `<button type="button" class="cat-details-nav cat-details-next" data-nav="next" aria-label="Next asset">${CHEVRON_RIGHT}</button>` : ''}
        ${zoomable
          ? `<div class="cat-zoom-stage">${thumbHtml(ref, false, true)}</div>
             ${isMotionLottie ? `<button type="button" class="cat-motion-toggle is-playing" data-act="motion-toggle" aria-label="Pause" title="Pause">${PAUSE_ICON}</button>` : ''}
             <div class="cat-zoom-hud" role="group" aria-label="Zoom">
               <button type="button" class="cat-zoom-btn" data-zoom="out" aria-label="Zoom out" title="Zoom out">${ZOOM_OUT_ICON}</button>
               <button type="button" class="cat-zoom-btn cat-zoom-pct" data-zoom="reset" aria-label="Reset zoom" title="Reset zoom">100%</button>
               <button type="button" class="cat-zoom-btn" data-zoom="in" aria-label="Zoom in" title="Zoom in">${ZOOM_IN_ICON}</button>
             </div>`
          : thumbHtml(ref, false, true)}
      </div>
      <div class="cat-details-body">
        <h2 class="cat-details-name">${escape(name)}</h2>
        <dl class="cat-details-meta">
          <div><dt>Source</dt><dd>${isUser ? 'Your upload' : 'SUSE catalog'}</dd></div>
          <div><dt>Category</dt><dd>${escape(categoryLabel(libCategory(ref, overrides)))}</dd></div>
          <div><dt>Format</dt><dd>${escape(String(ref.format ?? ref.type).toUpperCase())}</dd></div>
          <div><dt>ID</dt><dd><code>${escape(ref.id)}</code></dd></div>
          ${tags.length ? `<div><dt>Tags</dt><dd class="cat-details-tags">${tags.map(t => `<span class="cat-tag">${escape(String(t))}</span>`).join('')}</dd></div>` : ''}
        </dl>
        ${themable ? `<div class="cat-dl-section"><span class="cat-dl-label">Colours</span>${iconSwatchRow(dTheme)}</div>` : ''}
        ${treatable ? `<div class="cat-dl-section"><span class="cat-dl-label">Colour</span>${treatmentSwatchRow(dTreatment)}</div>` : ''}
        <div class="cat-details-actions">
          <button type="button" class="btn cat-act-fav${fav ? ' is-fav' : ''}" data-act="fav" data-sfx="twinkle" aria-pressed="${fav}">${STAR_ICON}<span>${fav ? 'Favourited' : 'Favourite'}</span></button>
          <button type="button" class="btn cat-act-download" data-act="download">${DOWNLOAD_ICON}<span>${configurable ? 'Download…' : 'Download'}</span></button>
          ${croppable ? `<button type="button" class="btn cat-act-crop" data-act="crop">${CROP_ICON}<span>Crop…</span></button>` : ''}
          <button type="button" class="btn" data-act="recategorise">${TAG_ICON}<span>Recategorise…</span></button>
          <button type="button" class="btn cat-act-share" data-act="share">${SHARE_ICON}<span>Copy link</span></button>
          ${isUser
            ? `<button type="button" class="btn" data-act="rename">${PENCIL_ICON}<span>Rename</span></button>
               <button type="button" class="btn cat-act-danger" data-act="delete">${TRASH_ICON}<span>Delete</span></button>`
            : (hidden
                ? `<button type="button" class="btn" data-act="unhide">${EYE_ICON}<span>Unhide</span></button>`
                : `<button type="button" class="btn cat-act-danger" data-act="hide">${EYE_OFF_ICON}<span>Hide</span></button>`)}
        </div>
      </div>`;
    document.body.appendChild(dlg);
    detailsDialog = dlg;

    // A shared themed link opens on that colour — recolour the preview to match on open
    // (the swatch is already marked active above). Best-effort; leaves the base otherwise.
    if (themable && initialTheme && dTheme) {
      void (async () => {
        try {
          if (!dBaseSvg) dBaseSvg = await (await fetch(ref.url)).text();
          const th = iconThemes.find(x => x.id === dTheme);
          const img = dlg.querySelector<HTMLImageElement>('.cat-thumb');
          if (img && th) img.src = svgTextToDataUrl(restyleIconTheme(dBaseSvg, th) || dBaseSvg);
        } catch { /* leave the base preview */ }
      })();
    }
    // A raster photo opens on its carried treatment (category selection / shared link) — a
    // cheap live CSS filter over the injected defs, exactly like the grid + picker previews.
    if (treatable && dTreatment) {
      ensureTreatmentDefs();
      const img = dlg.querySelector<HTMLImageElement>('.cat-thumb');
      if (img) img.style.filter = `url(#${TREATMENT_FILTER_PREFIX}${dTreatment})`;
    }

    dlg.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;
      if (t === dlg) { closeDetails(); return; }   // backdrop
      // Prev/next lightbox paging — reopen the modal on the neighbouring asset, carrying the
      // current colour choice so paging keeps the look.
      const navBtn = t.closest<HTMLElement>('[data-nav]');
      if (navBtn) { const r = navBtn.dataset.nav === 'prev' ? nav.prev : nav.next; if (r) openDetails(r, dTheme, dTreatment); return; }
      // Play/pause the Lottie preview. The player mounts a tick after open, so this is a no-op
      // until then (the marker still shows its resting poster, and the button reflects "playing").
      const motionBtn = t.closest<HTMLElement>('[data-act="motion-toggle"]');
      if (motionBtn) {
        const motionEl = dlg.querySelector<HTMLElement>('.cat-thumb-motion');
        const player = motionEl ? lottiePlayerFor(motionEl) : null;
        if (player) {
          player.togglePause();
          const playing = !player.isPaused;
          motionBtn.classList.toggle('is-playing', playing);
          motionBtn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
          motionBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
          motionBtn.title = playing ? 'Pause' : 'Play';
        }
        return;
      }
      // Colour treatment swatch (raster photos): wash the preview in place via the live CSS
      // filter, keep the modal open. Checked before the icon branch — treat buttons also carry
      // .cat-dl-theme, but this .cat-dl-treat branch owns them.
      const treatSw = t.closest<HTMLElement>('.cat-dl-treat');
      if (treatSw && treatable) {
        dTreatment = treatSw.dataset.treatment || null;
        dlg.querySelectorAll<HTMLElement>('.cat-dl-treat').forEach(b => {
          const on = b === treatSw; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on));
        });
        ensureTreatmentDefs();
        const img = dlg.querySelector<HTMLImageElement>('.cat-thumb');
        if (img) img.style.filter = dTreatment ? `url(#${TREATMENT_FILTER_PREFIX}${dTreatment})` : '';
        return;
      }
      // Colour swatch (themable icons): recolour the preview in place, keep the modal open.
      const sw = t.closest<HTMLElement>('.cat-dl-theme');
      if (sw && themable) {
        dTheme = sw.dataset.theme ?? dTheme;
        dlg.querySelectorAll<HTMLElement>('.cat-dl-theme').forEach(b => {
          const on = b === sw; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on));
        });
        try {
          if (!dBaseSvg) dBaseSvg = await (await fetch(ref.url)).text();
          const th = iconThemes.find(x => x.id === dTheme);
          const img = dlg.querySelector<HTMLImageElement>('.cat-thumb');
          if (img && th) img.src = svgTextToDataUrl(restyleIconTheme(dBaseSvg, th) || dBaseSvg);
        } catch { /* recolour is best-effort — leaves the base preview */ }
        return;
      }
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'close') { closeDetails(); return; }
      if (act === 'fav') {
        if (favSet.has(base)) favSet.delete(base); else favSet.add(base);
        if (profile) await saveFavouriteAssets(host, profile, favSet);
        const on = favSet.has(base);
        const btn = dlg.querySelector<HTMLElement>('.cat-act-fav');
        btn?.classList.toggle('is-fav', on); btn?.setAttribute('aria-pressed', String(on));
        const lbl = btn?.querySelector('span'); if (lbl) lbl.textContent = on ? 'Favourited' : 'Favourite';
        // Reflect in the grid + favourites strip behind the modal, in place (no full
        // re-render — favouriting never moves a tile between buckets).
        if (mounted) { reflectFavInGrid(base, on); refreshFavStrip(); }
        announce(on ? `Added ${name} to favourites` : `Removed ${name} from favourites`);
        return;
      }
      if (act === 'share') {
        const btn = t.closest<HTMLElement>('.cat-act-share');
        // Share the styled variant when a colour is picked, so the recipient reopens the same
        // look (the modifier rides in the asset id — buildThemedAssetId / buildTreatedAssetId).
        const link = themable && dTheme
          ? `${location.origin}${location.pathname}#/c?asset=${encodeURIComponent(buildThemedAssetId(base, dTheme))}`
          : treatable && dTreatment
            ? `${location.origin}${location.pathname}#/c?asset=${encodeURIComponent(buildTreatedAssetId(base, dTreatment))}`
            : assetLink(ref);
        try { await navigator.clipboard.writeText(link); } catch { /* clipboard blocked */ }
        const s = btn?.querySelector('span');
        if (s) s.textContent = 'Copied!'; btn?.classList.add('is-copied');
        // Restore to the fixed label (never the current text) so a rapid re-click can't
        // capture 'Copied!' and leave the button stuck.
        setTimeout(() => { if (s) s.textContent = 'Copy link'; btn?.classList.remove('is-copied'); }, 1200);
        return;
      }
      // The remaining actions leave this asset's detail context, so close first.
      closeDetails();
      if (act === 'download') {
        if (isVector(ref) || isThemable(ref)) await openDownloadDialog(ref, dTheme);
        else if (treatable) await openPhotoDownloadDialog(ref, dTreatment);
        else await directDownload(ref);
      }
      else if (act === 'crop') await openCropDialog(ref, isThemable(ref) ? dTheme : dTreatment);
      else if (act === 'recategorise') await recategorise(ref);
      else if (act === 'rename') await renameUserAsset(ref);
      else if (act === 'hide') await setHidden(base, true);
      else if (act === 'unhide') await setHidden(base, false);
      else if (act === 'delete') await deleteUserAsset(ref);
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDetails(); });
    // ← / → page through assets (lightbox style), like the on-screen prev/next buttons.
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' && nav.prev) { e.preventDefault(); openDetails(nav.prev, dTheme, dTreatment); }
      else if (e.key === 'ArrowRight' && nav.next) { e.preventDefault(); openDetails(nav.next, dTheme, dTreatment); }
    });
    dlg.showModal();
    if (!wasOpen) playSfx('whisper'); // airy elevation as the asset details rise in (silent on ←/→ paging)
    if (zoomable) attachZoom(dlg);
    // Mount the looping Lottie player over the poster (autoplays). Guarded so a mount that resolves
    // after the modal was paged/closed doesn't attach to a stale node; closeDetails reaps it.
    if (isMotionLottie) {
      const motionEl = dlg.querySelector<HTMLElement>('.cat-thumb-motion');
      if (motionEl) void mountLottieMarker(motionEl, { isCurrent: () => detailsDialog === dlg });
    }
    dlg.querySelector<HTMLButtonElement>('.cat-details-close')?.focus();
  }

  // ── actions ──────────────────────────────────────────────────────────────────
  async function toggleFavourite(id: string): Promise<void> {
    const base = assetBaseId(id);
    const on = !favSet.has(base);
    if (on) favSet.add(base); else favSet.delete(base);
    if (profile) await saveFavouriteAssets(host, profile, favSet);
    if (!mounted) return;
    // In place: flip the affected grid tile(s) + re-mount only the favourites strip (whose
    // membership just changed) instead of rebuilding the whole grid via render().
    reflectFavInGrid(base, on);
    refreshFavStrip();
    const name = String(assetById.get(id)?.meta?.name ?? id);
    announce(on ? `Added ${name} to favourites` : `Removed ${name} from favourites`);
  }

  async function setHidden(base: string, hide: boolean): Promise<void> {
    if (hide) hiddenSet.add(base); else hiddenSet.delete(base);
    if (profile) await saveHiddenAssets(host, profile, hiddenSet);
    if (!mounted) return;
    const hidName = String(assetById.get(base)?.meta?.name ?? base);
    announce(`${hidName} ${hide ? 'hidden' : 'unhidden'}`);
    // Hiding relocates a tile between buckets (category grid ↔ Hidden section), so a naive
    // class-toggle isn't faithful. Try a minimal in-place DOM move for the common case and
    // fall back to a full re-render for the structural sub-cases where splicing a section
    // in/out (or building the toolbar's "Show hidden" control) isn't clearly safe.
    if (!applyHiddenInPlace(base, hide)) rerender();
  }

  // Minimal in-place reflection of a hide/unhide; returns false to request a full render()
  // when the change would create/reorder a section (not clearly safe to splice). Only the
  // repeated-hide path (Show hidden off, its toggle already present) is handled in place —
  // the same set of tiles just leaves the grid, exactly as a re-render would omit them.
  function applyHiddenInPlace(base: string, hide: boolean): boolean {
    if (query) return false;                       // search view buckets differently
    if (!hide) return false;                        // unhide re-inserts into an ordered category → render()
    if (showHidden) return false;                   // would need to move tiles INTO the Hidden section
    const assets = viewEl.querySelector<HTMLElement>('.cat-assets');
    if (!assets) return false;
    const tiles = [...viewEl.querySelectorAll<HTMLElement>('.cat-tile')]
      .filter(t => assetBaseId(t.dataset.id ?? '') === base);
    if (!tiles.length) return false;
    // The "Show hidden (N)" toggle (the .cat-showhidden that isn't Collapse-all) must
    // already exist; building it from scratch on the first-ever hide isn't clearly safe.
    const toggle = [...assets.querySelectorAll<HTMLElement>('.cat-showhidden')]
      .find(b => !b.classList.contains('cat-collapse-all'));
    if (!toggle) return false;
    // Drop the tiles; remove any category/uploads section they leave empty (render omits it).
    for (const tile of tiles) {
      const sec = tile.closest<HTMLElement>('.cat-group');
      tile.remove();
      if (sec && !sec.querySelector('.cat-tile')) sec.remove();
    }
    // Toolbar count + the toggle's own tally both read the (now smaller) visible/hidden sets.
    const hiddenCount = allAssets.filter(a => hiddenSet.has(assetBaseId(a.id))).length;
    // This path only runs while hidden assets are folded away (showHidden === false), so the
    // eye icon + "Show hidden (N)" is always the right pairing. Preserve the icon (setCatToggle).
    setCatToggle(toggle, CAT_ICONS.eye, `Show hidden (${hiddenCount})`);
    const count = assets.querySelector<HTMLElement>('.cat-count');
    if (count) { const n = visibleAssets().length; count.textContent = `${n} asset${n === 1 ? '' : 's'}`; }
    if (favSet.has(base)) refreshFavStrip();   // a hidden favourite leaves the strip
    return true;
  }

  async function recategorise(ref: AssetRef): Promise<void> {
    const base = assetBaseId(ref.id);
    const current = libCategory(ref, overrides);
    const chosen = await choiceDialog({
      title: 'Recategorise asset',
      message: `Move “${String(ref.meta?.name ?? ref.id)}” into which group? (Currently ${categoryLabel(current)}.)`,
      choices: [
        ...LIB_GROUPS.map(g => ({ id: g.key, label: g.label, primary: g.key === current })),
        { id: '__auto__', label: 'Auto (from tags)' },
      ],
    });
    if (!chosen || !mounted) return;
    if (profile) await saveAssetCategory(host, profile, base, chosen === '__auto__' ? null : chosen);
    setOverrides(loadAssetCategories(profile));
    // '__auto__' clears the override, so the resulting group is the tag-derived one.
    const newCat = chosen === '__auto__' ? libCategory(ref, overrides) : chosen;
    announce(`Moved ${String(ref.meta?.name ?? ref.id)} to ${categoryLabel(newCat)}`);
    rerender();
  }

  async function deleteUserAsset(ref: AssetRef): Promise<void> {
    const base = assetBaseId(ref.id);
    const ok = await confirmDialog({
      title: 'Delete this image?',
      message: 'This permanently removes your uploaded image from this device. This cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!ok || !mounted) return;
    await host.assets._deleteUserAsset(ref.id).catch(() => {});
    // Prune any dangling per-user overlay entries for the gone asset (one write each,
    // only when actually present).
    if (profile && favSet.delete(base)) await saveFavouriteAssets(host, profile, favSet);
    if (profile && hiddenSet.delete(base)) await saveHiddenAssets(host, profile, hiddenSet);
    if (profile && overrides[base]) { await saveAssetCategory(host, profile, base, null); setOverrides(loadAssetCategories(profile)); }
    allAssets = allAssets.filter(a => a.id !== ref.id);
    assetById.delete(ref.id);
    selected.delete(ref.id);
    rerender();
  }

  async function renameUserAsset(ref: AssetRef): Promise<void> {
    const current = String(ref.meta?.name ?? '');
    const name = await promptDialog({
      title: 'Rename image',
      message: 'Give this upload a new name.',
      value: current,
      placeholder: 'Image name',
      confirmLabel: 'Rename',
    });
    if (name == null || !mounted) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === current) return;
    await host.assets._renameUserAsset(ref.id, trimmed).catch(() => {});
    // allAssets holds the same AssetRef objects assetById maps to, so one write updates both.
    const rec = assetById.get(ref.id);
    if (rec) rec.meta = { ...rec.meta, name: trimmed };
    rerender();
  }

  // ── selection (user uploads only) ───────────────────────────────────────────────
  // The set of currently-selectable ids (visible, matches search, and a user upload).
  const selectableIds = (): Set<string> =>
    new Set(visibleAssets().filter(matchesQuery).filter(a => a.source === 'user').map(a => a.id));

  // Drop selected ids that are gone (deleted, or filtered out by a search) so the count
  // stays honest. Runs at the top of every render().
  function pruneSelection(): void {
    if (!selected.size) return;
    const present = selectableIds();
    for (const id of [...selected]) if (!present.has(id)) selected.delete(id);
  }

  function toggleSelect(id: string): void {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    // Update the one tile in place — no full render, so scroll + focus are kept.
    const on = selected.has(id);
    const tile = [...viewEl.querySelectorAll<HTMLElement>('.cat-tile')].find(t => t.dataset.id === id);
    tile?.classList.toggle('is-selected', on);
    tile?.querySelector('.cat-check')?.setAttribute('aria-pressed', String(on));
    syncSelectAll();
    syncBulkBar();
  }

  function selectAllUploads(): void {
    const ids = selectableIds();
    const allSel = ids.size > 0 && [...ids].every(id => selected.has(id));
    if (allSel) for (const id of ids) selected.delete(id);
    else for (const id of ids) selected.add(id);
    // Flip each upload tile's checkbox in place (mirrors toggleSelect) rather than
    // rebuilding the grid — selection never moves a tile between buckets.
    for (const tile of viewEl.querySelectorAll<HTMLElement>('.cat-tile')) {
      const id = tile.dataset.id ?? '';
      if (!ids.has(id)) continue;
      const on = selected.has(id);
      tile.classList.toggle('is-selected', on);
      tile.querySelector('.cat-check')?.setAttribute('aria-pressed', String(on));
    }
    syncSelectAll();
    syncBulkBar();
  }

  // Keep the "Select all / Deselect all" label + pressed state in sync after a single toggle.
  function syncSelectAll(): void {
    const ids = selectableIds();
    const allSel = ids.size > 0 && [...ids].every(id => selected.has(id));
    const btn = viewEl.querySelector<HTMLElement>('.cat-uploads-selectall');
    if (btn) { btn.textContent = allSel ? 'Deselect all' : 'Select all'; btn.setAttribute('aria-pressed', String(allSel)); }
  }

  function syncBulkBar(): void {
    const bar = viewEl.querySelector<HTMLElement>('.cat-bulkbar');
    if (!bar) return;
    const n = selected.size;
    bar.hidden = n === 0;
    const count = bar.querySelector('.cat-bulkbar-count');
    if (count) count.textContent = `${n} selected`;
    viewEl.querySelector('.catalog')?.classList.toggle('has-selection', n > 0);
  }

  function handleBulk(action: string): void {
    if (action === 'clear') {
      // Deselect in place — drop the highlight from every selected tile, no full re-render.
      for (const tile of viewEl.querySelectorAll<HTMLElement>('.cat-tile.is-selected')) {
        tile.classList.remove('is-selected');
        tile.querySelector('.cat-check')?.setAttribute('aria-pressed', 'false');
      }
      selected.clear();
      syncSelectAll();
      syncBulkBar();
    } else if (action === 'delete') void deleteSelection();
  }

  async function deleteSelection(): Promise<void> {
    const ids = [...selected];
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: `Delete ${ids.length} selected image${ids.length === 1 ? '' : 's'}?`,
      message: 'This permanently removes your uploaded images from this device. This cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!ok || !mounted) return;
    for (const id of ids) {
      const base = assetBaseId(id);
      await host.assets._deleteUserAsset(id).catch(() => {});
      // Prune any dangling per-user overlay entries (one write each, only when present).
      if (profile && favSet.delete(base)) await saveFavouriteAssets(host, profile, favSet);
      if (profile && hiddenSet.delete(base)) await saveHiddenAssets(host, profile, hiddenSet);
      if (profile && overrides[base]) { await saveAssetCategory(host, profile, base, null); setOverrides(loadAssetCategories(profile)); }
      allAssets = allAssets.filter(a => a.id !== id);
      assetById.delete(id);
    }
    selected.clear();
    if (!mounted) return;
    rerender();
  }

  // ── downloads ──────────────────────────────────────────────────────────────────
  async function saveUrl(url: string, filename: string): Promise<void> {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      await host.export.download(await r.blob(), filename);
    } catch {
      // Fallback for same-origin / data URLs when fetch is blocked.
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
    }
  }

  // Raster / video / lottie: download the file as-is (no styling or reformat to offer).
  async function directDownload(ref: AssetRef): Promise<void> {
    await saveUrl(ref.url, downloadName(ref, String(ref.format || 'bin')));
  }

  function closeDownloadDialog(): void {
    if (dlDialog) { if (dlDialog.open) dlDialog.close(); dlDialog.remove(); dlDialog = null; }
  }

  function closeCropDialog(): void {
    if (cropDialog) { if (cropDialog.open) cropDialog.close(); cropDialog.remove(); cropDialog = null; }
  }

  // Crop-before-download: a dialog with the asset fitted into an aspect-matched stage and
  // a drag/resize crop box over it. The box is the ONLY way to change dimensions (there is
  // no width/height resize anywhere else) — you frame the region and download just that.
  // The stage matches the asset's aspect so the image fills it with no letterbox, which
  // makes the crop a straight fraction of the asset: box/stage → fraction → asset pixels
  // (raster, canvas-crop) or a narrowed viewBox (vector, stays vector).
  async function openCropDialog(ref: AssetRef, modifier?: string | null): Promise<void> {
    const vector = isVector(ref);
    let svgText: string | null = null;
    let rasterSrc = ref.url;   // crop source for raster — a treatment bakes it into a wrapper
    let aspect = 1;   // provisional for raster; set from naturalWidth on load
    if (vector) {
      try { const r = await fetch(ref.url); svgText = await r.text(); if (!/<svg[\s>]/i.test(svgText)) throw new Error('not svg'); }
      catch { await directDownload(ref); return; }   // not fetchable/SVG → just save it
      // For a themable icon `modifier` is a theme id — bake it into the crop source.
      if (isThemable(ref) && modifier && modifier !== ORIGINAL_THEME) {
        const t = iconThemes.find(x => x.id === modifier);
        const out = t && restyleIconTheme(svgText, t);
        if (out && out !== svgText) svgText = stripC2paManifest(out);
      }
      aspect = svgAspect(svgText);
    } else if (modifier && ref.type === 'raster' && photoTreatments.length) {
      // For a raster photo `modifier` is a treatment id — bake it into the crop source so the
      // cropped-out region carries the wash (the wrapper's pixel size = the photo's, so the
      // canvas-cut in downloadCrop is unchanged).
      const wrap = await treatedWrapperSvg(ref, modifier).catch(() => null);
      if (wrap) { rasterSrc = svgTextToDataUrl(wrap.svg); aspect = wrap.w / wrap.h; }
    }
    if (!mounted) return;
    closeCropDialog();

    const name = String(ref.meta?.name ?? ref.id);
    const fmts: [string, string][] = vector ? [['svg', 'SVG'], ['png', 'PNG']] : [['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP']];
    const dlg = document.createElement('dialog');
    dlg.className = 'cat-crop';
    dlg.innerHTML = `
      <h2 class="cat-dl-title">Crop ${escape(name)}</h2>
      <div class="cat-crop-stage">
        <img class="cat-crop-img" alt="" src="${escape(vector ? svgTextToDataUrl(svgText!) : rasterSrc)}">
        <div class="cat-crop-box">
          <span class="cat-crop-h" data-h="nw"></span>
          <span class="cat-crop-h" data-h="ne"></span>
          <span class="cat-crop-h" data-h="sw"></span>
          <span class="cat-crop-h" data-h="se"></span>
        </div>
      </div>
      <div class="cat-dl-section">
        <span class="cat-dl-label">Format</span>
        <div class="cat-dl-fmt cat-crop-fmt" role="radiogroup">${fmts.map(([v, l], i) =>
          `<label><input type="radio" name="cat-crop-fmt" value="${v}"${i === 0 ? ' checked' : ''}> ${l}</label>`).join('')}</div>
      </div>
      <div class="cat-dl-actions">
        <button type="button" class="btn cat-crop-cancel">Cancel</button>
        <button type="button" class="btn cat-crop-go projects-confirm-primary">Download crop</button>
      </div>`;
    document.body.appendChild(dlg);
    cropDialog = dlg;

    const stage = dlg.querySelector<HTMLElement>('.cat-crop-stage')!;
    const imgEl = dlg.querySelector<HTMLImageElement>('.cat-crop-img')!;
    const boxEl = dlg.querySelector<HTMLElement>('.cat-crop-box')!;
    let bx = 0, by = 0, bw = 0, bh = 0;    // crop box in stage px
    const paintBox = (): void => {
      boxEl.style.left = `${bx}px`; boxEl.style.top = `${by}px`;
      boxEl.style.width = `${bw}px`; boxEl.style.height = `${bh}px`;
    };
    const sizeStage = (): void => {
      // Fit the asset's aspect into a max workspace so the image fills the stage exactly.
      const maxW = Math.min(680, window.innerWidth * 0.82);
      const maxH = Math.min(460, window.innerHeight * 0.5);
      let w = maxW, h = maxW / aspect;
      if (h > maxH) { h = maxH; w = maxH * aspect; }
      stage.style.width = `${Math.round(w)}px`;
      stage.style.height = `${Math.round(h)}px`;
    };
    const initGeom = (): void => {
      sizeStage();
      const sw = stage.clientWidth, sh = stage.clientHeight;   // default box: 80% centred
      bx = sw * 0.1; by = sh * 0.1; bw = sw * 0.8; bh = sh * 0.8;
      paintBox();
    };
    if (vector) initGeom();
    else if (imgEl.complete && imgEl.naturalWidth) { aspect = imgEl.naturalWidth / imgEl.naturalHeight; initGeom(); }
    else imgEl.addEventListener('load', () => { aspect = imgEl.naturalWidth / imgEl.naturalHeight || 1; initGeom(); }, { once: true });

    // Drag the box body to move; drag a corner handle to resize (opposite corner fixed).
    const MIN = 16;
    let mode: string | null = null, sx = 0, sy = 0, ox = 0, oy = 0, ow = 0, oh = 0;
    stage.addEventListener('pointerdown', (e) => {
      const handle = (e.target as HTMLElement).closest<HTMLElement>('.cat-crop-h');
      const onBox = (e.target as HTMLElement).closest('.cat-crop-box');
      if (handle) mode = handle.dataset.h!;
      else if (onBox) mode = 'move';
      else return;
      sx = e.clientX; sy = e.clientY; ox = bx; oy = by; ow = bw; oh = bh;
      try { stage.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
      e.preventDefault();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!mode) return;
      const sw = stage.clientWidth, sh = stage.clientHeight;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (mode === 'move') {
        bx = Math.min(sw - bw, Math.max(0, ox + dx));
        by = Math.min(sh - bh, Math.max(0, oy + dy));
      } else {
        let x0 = ox, y0 = oy, x1 = ox + ow, y1 = oy + oh;
        if (mode.includes('w')) x0 = Math.min(x1 - MIN, Math.max(0, ox + dx));
        if (mode.includes('e')) x1 = Math.max(x0 + MIN, Math.min(sw, ox + ow + dx));
        if (mode.includes('n')) y0 = Math.min(y1 - MIN, Math.max(0, oy + dy));
        if (mode.includes('s')) y1 = Math.max(y0 + MIN, Math.min(sh, oy + oh + dy));
        bx = x0; by = y0; bw = x1 - x0; bh = y1 - y0;
      }
      paintBox();
    });
    const endDrag = (e: PointerEvent): void => {
      if (!mode) return; mode = null;
      try { stage.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    const fmt = (): string => dlg.querySelector<HTMLInputElement>('input[name="cat-crop-fmt"]:checked')?.value ?? (vector ? 'svg' : 'png');
    dlg.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.cat-crop-cancel')) { closeCropDialog(); return; }
      if (t.closest('.cat-crop-go')) {
        const sw = stage.clientWidth || 1, sh = stage.clientHeight || 1;
        const frac = { fx: bx / sw, fy: by / sh, fw: bw / sw, fh: bh / sh };
        try { await downloadCrop(ref, vector, svgText, imgEl, frac, fmt()); }
        catch (err) { host.log?.('error', 'Catalog crop failed', { id: ref.id, error: String(err) }); }
        closeCropDialog();
      }
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeCropDialog(); });
    dlg.showModal();
  }

  // Render the framed region. Vector → a narrowed viewBox (SVG stays vector; PNG rasterises
  // that sub-viewBox). Raster → a canvas cut of the source at natural resolution.
  async function downloadCrop(
    ref: AssetRef, vector: boolean, svgText: string | null, imgEl: HTMLImageElement,
    frac: { fx: number; fy: number; fw: number; fh: number }, fmt: string,
  ): Promise<void> {
    const { fx, fy, fw, fh } = frac;
    if (vector && svgText) {
      const [vx, vy, vw, vh] = svgViewBox(svgText);
      const box: [number, number, number, number] = [vx + fx * vw, vy + fy * vh, fw * vw, fh * vh];
      const cropped = cropSvg(svgText, box);
      if (fmt === 'svg') { await host.export.download(new Blob([cropped], { type: 'image/svg+xml' }), downloadName(ref, 'svg')); return; }
      const edge = 1024, ar = box[2] / box[3];
      const w = ar >= 1 ? edge : Math.max(1, Math.round(edge * ar));
      const h = ar >= 1 ? Math.max(1, Math.round(edge / ar)) : edge;
      await host.export.download(await svgToPng(cropped, w, h), downloadName(ref, 'png'));
      return;
    }
    // Raster: cut the source at its NATURAL pixels (fraction × naturalWidth/Height).
    const NW = imgEl.naturalWidth, NH = imgEl.naturalHeight;
    const sxp = Math.round(fx * NW), syp = Math.round(fy * NH);
    const swp = Math.max(1, Math.round(fw * NW)), shp = Math.max(1, Math.round(fh * NH));
    const canvas = document.createElement('canvas');
    canvas.width = swp; canvas.height = shp;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');
    if (fmt === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, swp, shp); }   // JPEG has no alpha
    ctx.drawImage(imgEl, sxp, syp, swp, shp, 0, 0, swp, shp);
    const mime = fmt === 'jpg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, 0.92));
    if (!blob) throw new Error('crop encode failed');
    await host.export.download(blob, downloadName(ref, fmt === 'jpg' ? 'jpg' : fmt));
  }

  // Vector / themable icon: a small dialog to (optionally) recolour a themable icon via
  // the icon styler, then download as SVG or as PNG at a chosen size.
  async function openDownloadDialog(ref: AssetRef, initialTheme?: string | null): Promise<void> {
    let baseSvg: string;
    try {
      const r = await fetch(ref.url);
      baseSvg = await r.text();
      if (!/<svg[\s>]/i.test(baseSvg)) throw new Error('not svg');
    } catch { await directDownload(ref); return; }   // not fetchable/SVG → just save it
    if (!mounted) return;

    const themable = isThemable(ref) && iconThemes.length > 0;
    // Default to the ORIGINAL bytes (keeps a Content Credential intact); honour a
    // colour already chosen in the details view (initialTheme) as an explicit recolour.
    let themeId: string | null = themable
      ? ((initialTheme && iconThemes.some(t => t.id === initialTheme) ? initialTheme : ORIGINAL_THEME))
      : null;
    const aspect = svgAspect(baseSvg);
    const name = String(ref.meta?.name ?? ref.id);

    const currentSvg = (): string => {
      if (!themable || themeId === ORIGINAL_THEME || !themeId) return baseSvg;
      const t = iconThemes.find(x => x.id === themeId);
      const out = (t && restyleIconTheme(baseSvg, t)) || baseSvg;
      // A recolour changes the bytes; strip any credential so the file is a clean
      // unsigned asset rather than one that reads as "broken". Unchanged → intact.
      return out === baseSvg ? out : stripC2paManifest(out);
    };

    closeDownloadDialog();
    const dlg = document.createElement('dialog');
    dlg.className = 'cat-dl';
    dlg.innerHTML = `
      <h2 class="cat-dl-title">Download ${escape(name)}</h2>
      <div class="cat-dl-preview"><img alt="" class="cat-dl-img"></div>
      ${themable ? `
      <div class="cat-dl-section">
        <span class="cat-dl-label">Colours</span>
        <div class="cat-dl-themes" role="group" aria-label="Icon colours">
          <button type="button" class="cat-dl-theme${themeId === ORIGINAL_THEME ? ' is-active' : ''}" data-theme="${ORIGINAL_THEME}" aria-pressed="${themeId === ORIGINAL_THEME}" title="Original — unchanged; keeps its Content Credential" style="width:auto;padding:0 9px;font-size:11px;font-weight:600">Original</button>
          ${iconThemes.map((t) => `
            <button type="button" class="cat-dl-theme${t.id === themeId ? ' is-active' : ''}" data-theme="${escape(t.id)}" data-sfx="shimmer" aria-pressed="${t.id === themeId}" title="${escape(t.label ?? t.id)}">
              <span class="cat-dl-duo" style="background:${escape(t.previewBg ?? '#fff')}"><i style="background:${escape(String(t.c2 ?? '#888'))}"></i><i style="background:${escape(String(t.c1 ?? '#333'))}"></i></span>
            </button>`).join('')}
        </div>
      </div>` : ''}
      <div class="cat-dl-section">
        <span class="cat-dl-label">Format</span>
        <div class="cat-dl-fmt" role="radiogroup">
          <label><input type="radio" name="cat-dl-fmt" value="svg" checked> SVG <span class="cat-dl-hint">vector</span></label>
          <label><input type="radio" name="cat-dl-fmt" value="png"> PNG <span class="cat-dl-hint">raster</span></label>
        </div>
      </div>
      <div class="cat-dl-actions">
        <button type="button" class="btn cat-dl-cancel">Cancel</button>
        <button type="button" class="btn cat-dl-go projects-confirm-primary">Download</button>
      </div>`;
    document.body.appendChild(dlg);
    dlDialog = dlg;

    const imgEl = dlg.querySelector<HTMLImageElement>('.cat-dl-img')!;
    const paintPreview = (): void => { imgEl.src = svgTextToDataUrl(currentSvg()); };
    paintPreview();
    const fmt = (): string => (dlg.querySelector<HTMLInputElement>('input[name="cat-dl-fmt"]:checked')?.value ?? 'svg');

    dlg.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;
      // Scope to THIS dialog's colour buttons (.cat-dl-theme). A bare [data-theme]
      // selector also matches the <html data-theme> root, so it hijacked EVERY click in
      // the dialog (Download included) → the theme branch returned early and no download
      // ever ran (all vector/icon downloads were dead).
      const themeBtn = t.closest<HTMLElement>('.cat-dl-theme');
      if (themeBtn) {
        themeId = themeBtn.dataset.theme!;
        dlg.querySelectorAll<HTMLElement>('[data-theme]').forEach(b => {
          const on = b === themeBtn; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on));
        });
        paintPreview();
        return;
      }
      if (t.closest('.cat-dl-cancel')) { closeDownloadDialog(); return; }
      if (t.closest('.cat-dl-go')) {
        const svg = currentSvg();
        try {
          if (fmt() === 'png') {
            // No user resize (dimension changes live in the details-view crop). PNG renders
            // the whole asset at a sensible fixed resolution — longest edge 1024, aspect kept.
            const edge = 1024;
            const w = aspect >= 1 ? edge : Math.max(1, Math.round(edge * aspect));
            const h = aspect >= 1 ? Math.max(1, Math.round(edge / aspect)) : edge;
            await host.export.download(await svgToPng(svg, w, h), downloadName(ref, 'png'));
          } else {
            await host.export.download(new Blob([svg], { type: 'image/svg+xml' }), downloadName(ref, 'svg'));
          }
        } catch (err) { host.log?.('error', 'Catalog download failed', { id: ref.id, error: String(err) }); }
        closeDownloadDialog();
      }
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDownloadDialog(); });
    dlg.showModal();
    dlg.querySelector<HTMLButtonElement>('.cat-dl-go')?.focus();
  }

  // Bake a photo treatment into a self-contained SVG wrapper (the source photo inlined as a
  // data URI + the treatment <filter>), at the photo's natural pixel size — the same wrapper
  // the bridge bakes at resolve, but built here so it works for user uploads too (which carry
  // no catalog format dimensions). Returns null when there's no valid treatment.
  async function treatedWrapperSvg(ref: AssetRef, treatmentId: string | null): Promise<{ svg: string; w: number; h: number } | null> {
    const def = treatmentId ? photoTreatments.find(t => t.id === treatmentId) : null;
    if (!def) return null;
    const blob = await (await fetch(ref.url)).blob();
    const href = await blobToDataUrl(blob);
    const { w, h } = await new Promise<{ w: number; h: number }>((res) => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
      im.onerror = () => res({ w: 1, h: 1 });
      im.src = href;
    });
    return { svg: wrapRasterWithTreatment({ href, width: w, height: h, treatment: def }), w, h };
  }

  // Raster photo: a small dialog to (optionally) apply a colour treatment via the photo
  // styler, then download as PNG / JPG / WebP. The bitmap sibling of openDownloadDialog —
  // the preview washes live via the injected CSS filter (no re-encode until download); the
  // chosen treatment is baked into the exported bytes. "Original" downloads the source as-is.
  async function openPhotoDownloadDialog(ref: AssetRef, initialTreatment?: string | null): Promise<void> {
    if (ref.type !== 'raster' || photoTreatments.length === 0) { await directDownload(ref); return; }
    ensureTreatmentDefs();
    let treatmentId: string | null = initialTreatment && photoTreatments.some(t => t.id === initialTreatment) ? initialTreatment : null;
    const name = String(ref.meta?.name ?? ref.id);

    closeDownloadDialog();
    const dlg = document.createElement('dialog');
    dlg.className = 'cat-dl';
    dlg.innerHTML = `
      <h2 class="cat-dl-title">Download ${escape(name)}</h2>
      <div class="cat-dl-preview"><img alt="" class="cat-dl-img" src="${escape(ref.url)}"></div>
      <div class="cat-dl-section">
        <span class="cat-dl-label">Colour</span>
        ${treatmentSwatchRow(treatmentId)}
      </div>
      <div class="cat-dl-section">
        <span class="cat-dl-label">Format</span>
        <div class="cat-dl-fmt" role="radiogroup">
          <label><input type="radio" name="cat-dl-fmt" value="png" checked> PNG <span class="cat-dl-hint">lossless</span></label>
          <label><input type="radio" name="cat-dl-fmt" value="jpg"> JPG <span class="cat-dl-hint">smaller</span></label>
          <label><input type="radio" name="cat-dl-fmt" value="webp"> WebP <span class="cat-dl-hint">modern</span></label>
        </div>
      </div>
      <div class="cat-dl-actions">
        <button type="button" class="btn cat-dl-cancel">Cancel</button>
        <button type="button" class="btn cat-dl-go projects-confirm-primary">Download</button>
      </div>`;
    document.body.appendChild(dlg);
    dlDialog = dlg;

    const imgEl = dlg.querySelector<HTMLImageElement>('.cat-dl-img')!;
    const applyPreview = (): void => { imgEl.style.filter = treatmentId ? `url(#${TREATMENT_FILTER_PREFIX}${treatmentId})` : ''; };
    applyPreview();
    const fmt = (): string => (dlg.querySelector<HTMLInputElement>('input[name="cat-dl-fmt"]:checked')?.value ?? 'png');

    dlg.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;
      const treatBtn = t.closest<HTMLElement>('.cat-dl-treat');
      if (treatBtn) {
        treatmentId = treatBtn.dataset.treatment || null;
        dlg.querySelectorAll<HTMLElement>('.cat-dl-treat').forEach(b => {
          const on = b === treatBtn; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on));
        });
        applyPreview();
        return;
      }
      if (t.closest('.cat-dl-cancel')) { closeDownloadDialog(); return; }
      if (t.closest('.cat-dl-go')) {
        try {
          const f = fmt();
          const wrap = treatmentId ? await treatedWrapperSvg(ref, treatmentId) : null;
          if (!wrap) {
            // Original (or an unresolvable treatment) → the source bytes, untouched.
            await directDownload(ref);
          } else {
            const mime = f === 'jpg' ? 'image/jpeg' : f === 'webp' ? 'image/webp' : 'image/png';
            const blob = await svgToRaster(wrap.svg, wrap.w, wrap.h, mime);
            await host.export.download(blob, downloadName(ref, f === 'jpg' ? 'jpg' : f));
          }
        } catch (err) { host.log?.('error', 'Catalog photo download failed', { id: ref.id, error: String(err) }); }
        closeDownloadDialog();
      }
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDownloadDialog(); });
    dlg.showModal();
    dlg.querySelector<HTMLButtonElement>('.cat-dl-go')?.focus();
  }

  // ── wiring ───────────────────────────────────────────────────────────────────
  // Recolour every themable icon in a category group in place (the category "Colours"
  // switcher). A null theme restores the base URL; base SVGs are cached (iconSvgCache) so
  // flipping between colours never re-fetches. Best-effort per tile — a failure leaves it.
  async function retheemeGroup(group: HTMLElement, themeId: string | null): Promise<void> {
    const th = themeId ? iconThemes.find(x => x.id === themeId) : null;
    // Recolour every icon in the group concurrently. The old serial `for…await`
    // did up to ~111 network round-trips one after another on the first colour
    // pick (before iconSvgCache warms), stalling the whole group visibly.
    await Promise.all([...group.querySelectorAll<HTMLElement>('.cat-tile')].map(async tile => {
      const id = tile.dataset.id;
      const ref = id ? assetById.get(id) : null;
      const img = tile.querySelector<HTMLImageElement>('.cat-thumb');
      if (!ref || !img || !isThemable(ref)) return;
      if (!th) { img.src = ref.url; return; }   // back to base
      try {
        let base = iconSvgCache.get(id!);
        if (!base) { base = await (await fetch(ref.url)).text(); iconSvgCache.set(id!, base); }
        img.src = svgTextToDataUrl(restyleIconTheme(base, th) || base);
      } catch { /* leave this tile on its current art */ }
    }));
  }

  // Inject the treatment <filter> defs once (a hidden 0×0 SVG in the view root) so the
  // grid can preview a wash with a live CSS `filter: url(#…)` — no re-encode, and
  // pixel-identical to the baked result (treatmentFilterSvg uses sRGB interpolation).
  // Re-injected after a full render() (which wipes viewEl); a no-op otherwise.
  function ensureTreatmentDefs(): void {
    if (!photoTreatments.length || viewEl.querySelector('#lolly-pt-defs')) return;
    const defs = photoTreatments.map(t => treatmentFilterSvg(t, `${TREATMENT_FILTER_PREFIX}${t.id}`)).join('');
    const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    holder.id = 'lolly-pt-defs';
    holder.setAttribute('width', '0'); holder.setAttribute('height', '0'); holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    holder.innerHTML = `<defs>${defs}</defs>`;
    viewEl.appendChild(holder);
  }

  // The bitmap sibling of retheemeGroup: wash every raster tile in the group with the
  // chosen treatment via the live CSS filter (or clear it when null). Cheaper than the
  // icon path — no fetch/re-serialise; raster just points at the injected <filter> def.
  function retreatGroup(group: HTMLElement, treatmentId: string | null): void {
    const def = treatmentId ? photoTreatments.find(t => t.id === treatmentId) : null;
    for (const tile of group.querySelectorAll<HTMLElement>('.cat-tile')) {
      const ref = tile.dataset.id ? assetById.get(tile.dataset.id) : null;
      const img = tile.querySelector<HTMLElement>('.cat-thumb');
      if (ref?.type !== 'raster' || !(img instanceof HTMLImageElement)) continue;
      img.style.filter = def ? `url(#${TREATMENT_FILTER_PREFIX}${def.id})` : '';
    }
  }

  // Re-apply the active treatment to every raster group after a (re-)render — the wash
  // is a CSS style on fresh tiles, so it must be re-stamped when the grid rebuilds.
  function reapplyTreatment(): void {
    ensureTreatmentDefs();
    if (!catPhotoTreatment) return;
    viewEl.querySelectorAll<HTMLElement>('.cat-group').forEach(g => retreatGroup(g, catPhotoTreatment));
  }

  function wire(): void {
    const body = viewEl.querySelector<HTMLElement>('.catalog-body');
    if (!body) return;

    // Clear the search from either affordance — the ✕ in the footer field or the "clear
    // search" button in the no-results copy. The footer (input + ✕) survives renderBody(),
    // so we re-query live rather than capture a possibly-stale node.
    const clearSearch = (): void => {
      const input = viewEl.querySelector<HTMLInputElement>('.gallery-search');
      if (input) input.value = '';
      viewEl.querySelector<HTMLElement>('.projects-search-clear')?.setAttribute('hidden', '');
      if (query) { query = ''; renderBody(); }
      input?.focus();
    };

    body.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;

      // "Clear search" link in the no-results copy (the footer ✕ is wired separately).
      const clr = t.closest<HTMLElement>('[data-search-clear]');
      if (clr) { e.preventDefault(); clearSearch(); return; }

      // Retry the catalogue load after a total sync failure (the failed state's control).
      const retry = t.closest<HTMLButtonElement>('.cat-retry');
      if (retry) {
        retry.disabled = true; retry.textContent = 'Retrying…';
        await reload();
        if (mounted) render();
        return;
      }

      const check = t.closest<HTMLElement>('[data-select]');
      if (check) { toggleSelect(check.dataset.select!); return; }

      const selectAll = t.closest<HTMLElement>('[data-selectall]');
      if (selectAll) { selectAllUploads(); return; }

      const star = t.closest<HTMLElement>('[data-star]');
      if (star) { await toggleFavourite(star.dataset.star!); return; }

      // Category "Colour" treatment swatch — wash this group's raster photos in place
      // (checked before the icon branch: treatment buttons also carry .cat-dl-theme).
      const treatSw = t.closest<HTMLElement>('.cat-dl-treat');
      const treatGroup = treatSw?.closest<HTMLElement>('.cat-group');
      if (treatSw && treatGroup) {
        catPhotoTreatment = treatSw.dataset.treatment || null;
        treatGroup.querySelectorAll<HTMLElement>('.cat-dl-treat').forEach(b => {
          const on = b === treatSw; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on));
        });
        retreatGroup(treatGroup, catPhotoTreatment);
        return;
      }

      // Category "Colours" swatch — recolour this group's themable icons in place.
      const catSw = t.closest<HTMLElement>('.cat-dl-theme');
      const catGroup = catSw?.closest<HTMLElement>('.cat-group');
      if (catSw && catGroup) {
        catIconTheme = catSw.dataset.theme ?? null;
        catGroup.querySelectorAll<HTMLElement>('.cat-dl-theme').forEach(b => {
          const on = b === catSw; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on));
        });
        await retheemeGroup(catGroup, catIconTheme);
        return;
      }

      const openBtn = t.closest<HTMLElement>('[data-open]');
      if (openBtn) {
        const ref = assetById.get(openBtn.dataset.open!);
        // Carry the category grid's colour choice into the details modal — an icon opens on
        // its category theme, a photo on its category treatment (openDetails picks the one
        // that applies to the asset's type; passing both is harmless).
        if (ref) openDetails(ref, catIconTheme, catPhotoTreatment);
        return;
      }

      const toggle = t.closest<HTMLElement>('[data-cat-toggle]');
      if (toggle) {
        const key = toggle.dataset.catToggle!;
        const sec = toggle.closest('.cat-group')!;
        const collapse = !sec.classList.contains('is-collapsed');
        sec.classList.toggle('is-collapsed', collapse);
        toggle.setAttribute('aria-expanded', String(!collapse));
        if (collapse) collapsed.add(key); else collapsed.delete(key);
        persistCollapsed();
        syncSectionUrl();
        // Expanding → cascade the category's tiles in with a soft shuffle (like the gallery).
        if (!collapse) staggerReveal([...sec.querySelectorAll('.cat-tile')]);
        return;
      }

      // Collapse-all / Expand-all — fold or unfold every section in place (no re-render,
      // so scroll is kept). Checked BEFORE .cat-showhidden since it reuses that button
      // style. If anything is open we collapse all; once all are folded we expand all.
      const collapseAll = t.closest<HTMLElement>('.cat-collapse-all');
      if (collapseAll) {
        const groups = [...body.querySelectorAll<HTMLElement>('.cat-group')];
        const anyOpen = groups.some(g => !g.classList.contains('is-collapsed'));
        for (const g of groups) {
          g.classList.toggle('is-collapsed', anyOpen);
          g.querySelector('.cat-group-head')?.setAttribute('aria-expanded', String(!anyOpen));
          const key = g.dataset.group;
          if (key) { if (anyOpen) collapsed.add(key); else collapsed.delete(key); }
        }
        persistCollapsed();
        syncSectionUrl();
        // Just collapsed everything → the next action (and icon) is "Expand all", and vice
        // versa. Swap glyph + label together so the icon survives (setCatToggle, not textContent).
        setCatToggle(collapseAll, anyOpen ? CAT_ICONS.expand : CAT_ICONS.collapse, anyOpen ? 'Expand all' : 'Collapse all');
        return;
      }

      // Filetype filter (sticky toolbar) — narrow the grid to image / vector / motion.
      // Body-only re-render keeps the footer search + its focus; the toolbar (rebuilt with
      // it) reflects the new pressed state.
      const typeBtn = t.closest<HTMLElement>('[data-typefilter]');
      if (typeBtn) {
        const next = (typeBtn.dataset.typefilter || 'all') as TypeFilter;
        if (next !== typeFilter) { typeFilter = next; renderBody(); }
        return;
      }

      if (t.closest('.cat-showhidden')) { showHidden = !showHidden; rerender(); return; }

      // Read-only convenience: click a swatch chip to copy its hex.
      const chip = t.closest<HTMLElement>('.plat-swatch-chip[data-copy]');
      if (chip) {
        const hex = chip.dataset.copy!;
        navigator.clipboard?.writeText(hex).then(() => {
          chip.classList.add('is-copied');
          setTimeout(() => chip.classList.remove('is-copied'), 900);
        }).catch(() => {});
      }
    });

    // Capture-phase broken-image fallback: a grid thumbnail whose bytes fail to load (a
    // stale/missing derivative) is swapped for the same cat-thumb-stub the placeholder path
    // renders, so a tile never shows a broken image. Error events don't bubble, so listen in
    // the capture phase (mirrors gallery.ts's hero-preview morph). Delegated on the persistent
    // .catalog-body so it survives the innerHTML rebuilds in renderBody().
    body.addEventListener('error', (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains('cat-thumb')) return;
      const id = img.closest<HTMLElement>('.cat-tile')?.dataset.id ?? '';
      const stub = document.createElement('span');
      stub.className = 'cat-thumb cat-thumb-stub';
      stub.textContent = assetById.get(id)?.type ?? 'image';
      img.replaceWith(stub);
    }, true);

    // ── Bulk-action bar (lives in .catalog, outside .catalog-body) ──────────────
    viewEl.querySelector<HTMLElement>('.cat-bulkbar')?.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-bulk]');
      if (b) handleBulk(b.dataset.bulk!);
    });

    // ── Footer search (gallery field + a ✕ clear button) ────────────────────────
    // Lives in the fixed footer, OUTSIDE .catalog-body, so a search re-renders only the
    // body (renderBody) and this input keeps its focus + caret between keystrokes.
    const searchInput = viewEl.querySelector<HTMLInputElement>('.gallery-search');
    const clearBtn = viewEl.querySelector<HTMLButtonElement>('.projects-search-clear');
    let searchDebounce: ReturnType<typeof setTimeout>;
    searchInput?.addEventListener('input', () => {
      // Reflect the field state on the ✕ immediately (before the debounce): the footer isn't
      // rebuilt on renderBody(), so its visibility is toggled imperatively as you type.
      clearBtn?.toggleAttribute('hidden', !searchInput.value);
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        const q = searchInput.value.trim().toLowerCase();
        if (q === query) return;
        query = q;
        renderBody();
      }, 120);
    });
    // The ✕ clears + re-filters (mirrors projects.ts); Esc does the same for an active query.
    clearBtn?.addEventListener('click', clearSearch);
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (query || searchInput.value)) { e.stopPropagation(); clearSearch(); }
    });

    // ── View-options popover (favourites view mode + strip on/off) ──────────────
    const voBtn = viewEl.querySelector<HTMLElement>('.cat-viewopts-btn');
    const voPop = viewEl.querySelector<HTMLElement>('.cat-viewopts');
    if (voPop) wireThemeSegment(voPop, host);   // Theme picker in the view-options popover
    if (voPop) wireSoundSegment(voPop, host);   // Sound on/off segment in the view-options popover
    const onVODocDown = (e: PointerEvent): void => {
      if (!voPop) return;
      const t = e.target as Node;
      if (!voPop.contains(t) && t !== voBtn && !voBtn?.contains(t)) closeViewOpts();
    };
    const onVOKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeViewOpts(); };
    closeViewOpts = () => {
      viewOptsOpen = false;
      voPop?.setAttribute('hidden', '');
      voBtn?.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onVODocDown, true);
      document.removeEventListener('keydown', onVOKey);
    };
    voBtn?.addEventListener('click', () => {
      viewOptsOpen = !viewOptsOpen;
      if (viewOptsOpen) {
        voPop?.removeAttribute('hidden');
        voBtn.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', onVODocDown, true);
        document.addEventListener('keydown', onVOKey);
      } else { closeViewOpts(); }
    });
    // Gallery ↔ Cover Flow: switch the live strip in place (no full re-render).
    voPop?.addEventListener('click', (e) => {
      const seg = (e.target as HTMLElement).closest<HTMLElement>('[data-favview]');
      if (!seg) return;
      const next: FeaturedViewMode = seg.dataset.favview === 'coverflow' ? 'coverflow' : 'gallery';
      const changed = next !== favView;
      favView = next;
      try { localStorage.setItem(FAV_VIEW_KEY, favView); } catch { /* storage off */ }
      voPop.querySelectorAll<HTMLElement>('[data-favview]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.favview === favView)));
      featuredHandle?.setViewMode(favView);
      // Same cue as the main gallery's Gallery|Cover Flow switch (gallery.ts) — Cover Flow is
      // cool & futuristic, Gallery is refined.
      if (changed) playSfx(favView === 'coverflow' ? 'coverflow' : 'gallery');
    });
    // Show / hide the favourites strip — mount or tear down in place (no full re-render,
    // so the open popover isn't disturbed).
    voPop?.querySelector<HTMLInputElement>('.cat-favstrip-toggle')?.addEventListener('change', (e) => {
      favStripOn = (e.target as HTMLInputElement).checked;
      try { localStorage.setItem(FAV_STRIP_KEY, favStripOn ? 'on' : 'off'); } catch { /* storage off */ }
      const assets = viewEl.querySelector<HTMLElement>('.cat-assets');
      let mount = viewEl.querySelector<HTMLElement>('.cat-fav-strip');
      if (favStripOn) {
        if (!mount && assets && favItems().length) {
          mount = document.createElement('div'); mount.className = 'cat-fav-strip';
          assets.insertBefore(mount, assets.firstChild);
        }
        mountFavStrip();
      } else {
        featuredHandle?.destroy(); featuredHandle = null; mount?.remove();
      }
    });

    // Mobile: the avatar opens the shared profile menu (theme + settings); desktop
    // keeps it a plain link to /profile. Matches Tools + Projects.
    attachProfileMenu(viewEl.querySelector<HTMLElement>('.profile-link'), host);
  }

  // ── mount ──────────────────────────────────────────────────────────────────────
  // A lighter, brighter arrival "ahhh" led in by four rising "stacking" clicks — the catalog's
  // counterpart to the gallery's bassy one. One-shot, gesture-gated, silent when sound's off.
  playCatalogAah();
  (viewEl as ViewElement)._cleanup = () => {
    mounted = false;
    cancelArrivalAah();
    featuredHandle?.destroy();
    featuredHandle = null;
    lottieThumbs?.destroy();
    lottieThumbs = null;
    closeViewOpts();
    closeDetails();
    closeDownloadDialog();
    closeCropDialog();
    closeConfirmDialogs();
  };

  await reload();
  if (!mounted) return;
  // Deep link: expand the linked sections (validated) BEFORE the first paint so they render
  // open over the collapsed-by-default state; persist so the choice sticks for this user.
  const openTargets = linkedSections.filter(k => ALL_SECTION_KEYS.includes(k));
  if (openTargets.length) { for (const k of openTargets) collapsed.delete(k); persistCollapsed(); }
  render();
  // …then scroll the first linked section into view. The favourites hero + first images grow
  // the layout above the target during the opening moments and reset an early scroll, so we
  // re-measure and re-scroll across that window; the later passes land once it settles.
  if (openTargets.length) {
    const firstKey = openTargets.find(k => viewEl.querySelector(`.cat-group[data-group="${k}"]`));
    const scrollToSection = (smooth: boolean): void => {
      const el = firstKey ? viewEl.querySelector<HTMLElement>(`.cat-group[data-group="${firstKey}"]`) : null;
      if (!el || !mounted) return;
      window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 72), behavior: smooth ? 'smooth' : 'auto' });
    };
    setTimeout(() => scrollToSection(true), 400);
    setTimeout(() => scrollToSection(false), 900);
    setTimeout(() => scrollToSection(false), 1500);
  }
  // Deep link: open the shared asset's details modal over the catalog once it's painted.
  // A styled id opens the base asset with its colour pre-selected + applied — an icon theme
  // (…?theme=<id>) or a photo treatment (…?treatment=<id>). An id carries at most one.
  if (linkedAsset) {
    const { theme } = parseThemedAssetId(linkedAsset);
    const { treatment } = parseTreatedAssetId(linkedAsset);
    const baseId = assetBaseId(linkedAsset);   // strips ?theme= AND ?treatment=
    const ref = assetById.get(baseId)
      ?? assetById.get(linkedAsset)
      ?? [...assetById.values()].find(a => assetBaseId(a.id) === baseId);
    if (ref) openDetails(ref, theme, treatment);
    else {
      // The deep-linked asset isn't in this user's catalogue (never synced, a deleted upload,
      // or an unknown id) — say so instead of a silent no-op: announce() for assistive tech,
      // plus a brief self-clearing line at the top of the grid so a sighted user sees it too.
      announce('That asset isn’t in your catalogue');
      const bodyEl = viewEl.querySelector<HTMLElement>('.catalog-body');
      if (bodyEl) {
        const note = document.createElement('p');
        note.className = 'cat-empty';
        note.style.cssText = 'padding:0.85rem 1rem';
        note.textContent = 'That asset isn’t in your catalogue.';
        bodyEl.insertBefore(note, bodyEl.firstChild);
        setTimeout(() => note.remove(), 6000);
      }
    }
  }
}
