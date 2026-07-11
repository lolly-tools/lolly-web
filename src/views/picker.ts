// SPDX-License-Identifier: MPL-2.0
/**
 * Asset Picker — a host-owned modal UI.
 *
 * Why this is a host concern, not a tool concern: tools have no business
 * rendering picker chrome. They declare what they want; the host owns the
 * UX. This means picker UX improves across every tool simultaneously.
 *
 * Mounted lazily on first use. The picker calls back into:
 *   - host.assets.query(filter)  → list candidate library assets
 *   - host.assets.get(id)        → resolve the chosen one to an AssetRef
 *   - host.state.list()/load()   → the user's saved tool sessions (Saved creations)
 *   - host.compose.renderUrl()   → render a Lolly tool/session as the image
 *   - user-asset upload          → stores blob in IDB, returns user/* AssetRef
 *
 * Three ways in beyond the library, all producing an ordinary image AssetRef:
 *   - "Saved creations" — a previous saved single-tool session, re-rendered to an image
 *   - "Tools"           — any local tool, configured first (opts.editTool) then inserted
 *   - paste a Lolly link in the search box (the original smart-paste flow)
 *
 * Exported function: openPicker(host, opts) → Promise<AssetRef | null>
 *   opts.editTool?(toolUrl, mode?) → Promise<AssetRef|null> — when present, choosing a
 *   tool opens the full input editor (the caller wires it to tool.js's openEmbedEditor)
 *   so the user can configure the tool before it's inserted. Absent (e.g. batch mode) →
 *   the picker falls back to its inline format/size render card.
 *   opts.currentToolUrl / opts.currentToolName — when the slot being changed already
 *   holds a Lolly render (the AssetRef's meta.toolUrl), the picker shows an "edit the
 *   tool you're already using" banner that re-opens its inputs pre-filled (mode 'edit');
 *   the grids below still offer choosing a different image instead.
 */

import '../styles/picker.css';   // async CSS chunk (lazy view — not on the landing)
import DOMPurify from 'dompurify';
import { createRuntime, serializeUrlState, buildEmbedUrl, parseThemedAssetId, buildThemedAssetId, restyleIconTheme, sniffAnimatedRaster, sniffVideoContainer, parseTreatedAssetId, buildTreatedAssetId, treatmentFilterSvg, stripAssetModifiers, extractC2paStore, prepareC2paIngredientFromStore, stripMetadata, midiToZzfxm, bakeAssetRef } from '@lolly/engine';
import { fmtBytes } from '../lib/format.ts';
import { getTool } from '../bridge/tool-loader.ts';
import { trapFocus, type FocusTrap } from '../lib/focus-trap.ts';
import { downscaleRaster, computeResize, MAX_LONGEST_EDGE, readVideoDimensions } from '../bridge/image-resize.ts';
import { createFolderStore, childFolders, folderPath } from '../folders.ts';
import { announce } from '../a11y.ts';
import { choiceDialog, confirmDialog } from '../components/confirm-dialog.ts';
import { maybeNudgeAssetMilestone } from '../lib/asset-milestone.ts';
import { invalidateNeurospicyTracks } from '../lib/neurospicy.ts';
import { libCategory, LIB_GROUPS, loadAssetCategories, categoryLabel } from '../lib/asset-category.ts';
import type { LibGroup } from '../lib/asset-category.ts';
import { categoryGlyph } from '../lib/category-icons.ts';
import { loadFavouriteAssets, loadHiddenAssets, assetBaseId } from '../lib/asset-favourites.ts';
import { autoplayLottieThumbs } from './lottie-mount.ts';
import { previewMedia } from '../lib/preview-media.ts';
import { escapeHtml } from '../lib/html.ts';
import { genAiPill, assetAiKind } from '../lib/genai-pill.ts';
import { isFlagOn, STRIP_UPLOAD_META_FLAG } from '../feature-flags.ts';
import type { AssetRef, AssetPickerOpts, ComposeUrlOpts, ExportFormat, HostV1, Profile } from '../../../../engine/src/bridge/host-v1.ts';
import type { InputValue } from '../../../../engine/src/inputs.ts';
import type { IconTheme } from '../../../../engine/src/icon-theme.ts';
import type { PhotoTreatment } from '../../../../engine/src/photo-treatment.ts';
import type { Folder, FolderItem, FolderHost } from '../folders.ts';
import type { WebStateAPI } from '../bridge/state.ts';

/** Every file kind the upload surfaces can ingest — the `accept` list for any
 *  affordance that feeds storeUserUpload (the picker's footer input, the catalog's
 *  drop area). Images (raster + SVG), short video, Lottie, and audio all flow
 *  through storeUserUpload; audio (the user's own music) is stored verbatim as a
 *  type:'audio' asset. PDF/.ai don't go through storeUserUpload itself: callers
 *  route them to pdf-import.ts's ingestPdfAsSvgAssets (page(s) → stored SVG) via
 *  isPdfUpload. */
export const UPLOAD_ACCEPT = 'image/svg+xml,image/png,image/apng,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif,video/mp4,video/webm,.mp4,.webm,.mov,audio/*,.mp3,.wav,.ogg,.oga,.opus,.m4a,.aac,.flac,.mid,.midi,application/json,.json,.lottie,application/pdf,.pdf,application/illustrator,.ai';

/** A PDF — or an Illustrator .ai, which saved PDF-compatible IS a PDF — that upload
 *  surfaces must hand to the page→SVG converter instead of storeUserUpload. Sync and
 *  chunk-free on purpose: callers decide the route before lazy-loading pdf-import. */
export const isPdfUpload = (file: File): boolean =>
  /\.(pdf|ai)$/i.test(file.name) || /^application\/(pdf|illustrator)$/i.test(file.type);

/** The window.__toolIndex tool slice the picker reads (a denormalised catalog/sync
 *  projection, not an engine domain type). */
interface PickerTool {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  preview?: string;
  formats?: readonly string[];
  exportable?: boolean;
  // Canvas dimensions (from the catalog index) — used to fit an animated card.html banner
  // to the fixed-height preview slot at the right aspect. See toolCard / previewMedia.
  width?: number;
  height?: number;
}

/** A saved single-tool session, projected for the "Saved creations" tab. */
interface PickerSession {
  slot: string;
  toolId: string;
  label?: string;
  toolName: string;
  toolIcon: string | null;
  thumb: string | null;
  updatedAt: string;
}

type TabId = 'library' | 'sessions' | 'projects' | 'tools';
interface Tab {
  id: TabId;
  label: string;
}

/** The picker-facing shape of bridge/compose.ts's `_describeUrl` result (the
 *  detected-tool card). Local: `_describeUrl` is web-only host-UI chrome with no
 *  exported type. */
interface ToolUrlDescription {
  toolId: string;
  name: string;
  formats: string[];
  format: string;
  /** Subset of `formats` that carries movement (webm/mp4/gif/apng the tool
   *  supports and this browser can produce) — a motion pick renders a live clip. */
  motion: string[];
  width: number | null;
  height: number | null;
  unit: string | null;
  dpi: number | null;
}

/** The user-asset record storeUserUpload writes via host.assets._uploadUserAsset
 *  (mirrors bridge/assets.ts's non-exported UserAssetRecord for the fields we set). */
interface UserAssetRecordInput {
  id: string;
  type: AssetRef['type'];
  format: string;
  blob?: Blob;
  version?: string;
  width?: number;
  height?: number;
  meta?: Record<string, unknown>;
  credential?: Uint8Array;
  credentialFormat?: string;
}

/** The picker's option bag: AssetPickerOpts (title/allowUpload/current/type/…)
 *  widened with the web-only `type: 'image'` slot value and the editTool /
 *  current-tool banner hooks the caller (views/tool.js's openEmbedEditor) wires in. */
interface PickerOpts {
  type?: 'vector' | 'raster' | 'video' | 'audio' | 'lottie' | 'palette' | 'tokens' | 'font' | 'image';
  namespace?: string;
  tags?: string[];
  includeDeprecated?: boolean;
  title?: string;
  allowUpload?: boolean;
  current?: string;
  editTool?: (toolUrl: string, mode?: string) => Promise<AssetRef | null>;
  currentToolUrl?: string;
  currentToolName?: string;
}

/** The web compose surface the picker uses: the v1 ComposeAPI plus the web-only
 *  `_describeUrl` host-UI helper, with `renderUrl` pinned present (the web shell
 *  always provides it — see bridge/compose.ts). */
type WebComposeAPI = NonNullable<HostV1['compose']> & {
  renderUrl(url: string, opts?: ComposeUrlOpts): Promise<AssetRef | null>;
  _describeUrl(url: string): Promise<ToolUrlDescription | null>;
};

/** The web host surface the picker touches: HostV1 plus the web-only asset/state/
 *  compose helpers (underscore-prefixed, not part of the tool-facing v1 contract).
 *  Exported for surfaces that reuse the picker's ingest path (lib/upload-dropzone.ts). */
export interface PickerHost extends HostV1 {
  state: WebStateAPI;
  compose: WebComposeAPI;
  assets: HostV1['assets'] & {
    _deleteUserAsset(id: string): Promise<void>;
    _listUserAssets(): Promise<AssetRef[]>;
    _userAssetsCount(): Promise<number>;
    _iconThemes(): Promise<IconTheme[]>;
    _photoTreatments(): Promise<PhotoTreatment[]>;
    _uploadUserAsset(record: UserAssetRecordInput): Promise<void>;
  };
}

type WindowWithToolIndex = typeof window & { __toolIndex?: { tools?: PickerTool[] } };

let modalEl: HTMLDivElement | null = null;

/**
 * Clicking an image slot that already holds a live Lolly render doesn't jump
 * straight into the picker: ask which of the two intents the click meant.
 * Shared by every Lolly-image surface (top-level slot, block fields, free-canvas
 * boxes) so the wording stays identical. Resolves 'edit' | 'pick' | null.
 */
export function askLollyIntent(toolName?: string): Promise<string | null> {
  return choiceDialog({
    title: 'This image is a Lolly',
    message: `It's a live render from ${toolName ?? 'a Lolly tool'}. Tweak its inputs, or put a different image in this slot?`,
    choices: [
      { id: 'edit', label: '✦ Edit this Lolly', primary: true },
      { id: 'pick', label: 'Select another asset' },
    ],
  });
}

// Lucide-style camera glyph for the "Take a photo" affordance (themes via currentColor).
const cameraGlyph = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>';

// Lucide-style folder glyph for the Projects tab's folder cards.
const folderGlyph = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';

export function openPicker(host: PickerHost, opts: PickerOpts = {}): Promise<AssetRef | null> {
  return new Promise(resolve => {
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.className = 'asset-picker-modal';
      document.body.appendChild(modalEl);
    }
    render(modalEl, host, opts, resolve);
  });
}

async function render(
  root: HTMLElement,
  host: PickerHost,
  opts: PickerOpts,
  resolve: (value: AssetRef | null) => void,
): Promise<void> {
  // The personal-image library is offered only when this input accepts uploads.
  const showUserAssets = opts.allowUpload === true;
  let userAssets: AssetRef[] = [];

  // Per-user asset overlays (profile-backed, shared with the Catalog view): starred
  // assets pin to a "Favourites" section at the top; hidden assets drop from the library
  // AND user list; category overrides re-bucket assets. Loaded non-blocking (after the
  // synchronous first paint below), then the renders that depend on them await it.
  let favSet = new Set<string>();
  let hiddenSet = new Set<string>();
  let assetCategoryOverrides: Record<string, string> = {};
  const profileReady = host.profile.get().then((p: Profile) => {
    favSet = loadFavouriteAssets(p);
    hiddenSet = loadHiddenAssets(p);
    assetCategoryOverrides = loadAssetCategories(p);
  }).catch(() => { /* no profile → empty overlays */ });
  // Folders the user has organized their images into (in the gallery overlay).
  // Browse-only here — the picker reflects the grouping; it doesn't edit it.
  // host.profile (HostV1's ProfileAPI) is a superset of FolderHost's narrower
  // profile shape at runtime; the cast is type-only (FolderHost's structural
  // subset isn't inferable from HostV1's declared ProfileAPI).
  const folderStore = createFolderStore(host as unknown as FolderHost);
  let folders: Folder[] = [];
  let foldersLoaded = false;
  // The folder the Projects tab is currently browsing (null = the top level).
  let projectFolder: string | null = null;

  // "Take a photo" is offered on the same terms as upload (the slot accepts the
  // user's own images) for raster-capable slots, when the browser exposes a camera.
  // It produces an ordinary raster AssetRef — no engine/bridge involvement, purely a
  // shell affordance like upload. Pixels are captured + stored on-device.
  const canWebcam = showUserAssets && opts.type !== 'vector'
    && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

  // Smart-paste / compose: any image slot can render a Lolly tool (or a previous
  // saved creation) AS the image — available whenever the shell can compose and the
  // slot isn't video-only. The toolId in any link/tool must resolve to a real local
  // tool, so this can only ever render a tool that ships in this build.
  const allowToolUrl = Boolean((host.compose as Partial<WebComposeAPI> | undefined)?.renderUrl
    && (host.compose as Partial<WebComposeAPI> | undefined)?._describeUrl)
    && opts.type !== 'video';

  // The Projects tab browses the user's folders of saved creations + images. It's
  // worth showing whenever a folder could hold something pickable here: saved
  // creations (needs compose) or the user's own images (needs an upload-capable slot).
  const showProjects = allowToolUrl || showUserAssets;
  // Load the folder tree once whenever it could be shown (the Projects tab or the
  // "Your images" folder grouping), so a slot that only offers saved creations (no
  // upload) still gets its projects.
  const foldersReady: Promise<void> = showProjects
    ? folderStore.list().then(fs => { folders = fs; foldersLoaded = true; })
        .catch(() => { foldersLoaded = true; })
    : Promise.resolve();

  // A vector slot wants vector renders, so only tools that can emit SVG qualify.
  const needsSvg = opts.type === 'vector';

  // The runtime tool list is populated at boot by catalog/sync (window.__toolIndex);
  // every field we need (id, name, icon, formats, exportable) is already on it, so no
  // fetch. Restrict to tools that can produce an image (mirrors compose IMAGE_FORMATS)
  // and, for a vector slot, SVG specifically.
  const toolIndex = ((typeof window !== 'undefined' && (window as WindowWithToolIndex).__toolIndex?.tools) || []) as PickerTool[];
  const toolById  = new Map(toolIndex.map((t): [string, PickerTool] => [t.id, t]));
  const embedTools = allowToolUrl
    ? toolIndex.filter(t => isEmbeddable(t, needsSvg)).sort((a, b) => a.name.localeCompare(b.name))
    : [];

  // The slot's current image may itself be a Lolly render (meta.toolUrl on the
  // AssetRef). Offer an edit path back into that tool's own inputs — pre-filled
  // with the values already in use — without giving up the normal pick-another-
  // image grids below. Needs editTool (the caller's embed editor) to mean anything.
  const currentToolUrl = (opts.editTool && typeof opts.currentToolUrl === 'string' && opts.currentToolUrl) || null;

  // Saved single-tool sessions (filled async below); null while loading.
  let sessions: PickerSession[] | null = null;

  // ── Icon colour themes ──────────────────────────────────────────────────────
  // Themable two-colour icons (assets tagged "themable") can take a colour
  // pairing chosen here. The pairings come from the catalog's icon-themes
  // palette asset via host.assets._iconThemes(); the strip mounts only when the
  // library actually contains themable icons. The first pairing is the default
  // (identical to the fills baked into every icon) — choosing it keeps the plain
  // asset id, so default picks stay class-overridable when inlined.
  // A non-default choice is carried in the picked id (`<id>?theme=<themeId>`).
  let iconThemes: IconTheme[] = [];
  const currentBaseId = stripAssetModifiers(String(opts.current ?? ''));
  const { theme: currentTheme } = parseThemedAssetId(String(opts.current ?? ''));
  let activeTheme: string | null | undefined = currentTheme;
  // Two-colour icons (tag 'themable', c1/c2 swap) AND multi-colour illustrations
  // (tag 'illustration', monochromatic remap) both take a colour theme here — the
  // engine's restyle/apply pick the right recolour per SVG shape.
  const isThemableRef = (ref: AssetRef | undefined): ref is AssetRef => {
    const tags = ref?.meta?.tags as string[] | undefined;
    return Boolean(tags?.includes('themable') || tags?.includes('illustration'));
  };

  // ── Photo colour treatments ─────────────────────────────────────────────────
  // The raster analogue of the icon colour strip: a raster photo can take a
  // greyscale or duotone-wash treatment chosen here. The treatments come from the
  // catalog's photo-treatments palette via host.assets._photoTreatments(); the
  // strip mounts only on groups that hold raster photos. "None" is the plain
  // photo (no suffix); a treatment choice rides in the picked id
  // (`<id>?treatment=<treatmentId>`).
  let photoTreatments: PhotoTreatment[] = [];
  const { treatment: currentTreatment } = parseTreatedAssetId(String(opts.current ?? ''));
  let activeTreatment: string | null | undefined = currentTreatment;
  const isTreatableRef = (ref: AssetRef | undefined): ref is AssetRef => ref?.type === 'raster';

  // Which sources get a tab. Library is always present; the rest are conditional.
  const tabs: Tab[] = [{ id: 'library', label: 'Library' }];
  if (allowToolUrl) tabs.push({ id: 'sessions', label: 'Saved creations' });
  if (showProjects) tabs.push({ id: 'projects', label: 'Projects' });
  if (embedTools.length) tabs.push({ id: 'tools', label: 'Tools' });
  let activeTab: TabId = 'library';

  const placeholderFor = (id: TabId): string =>
    id === 'tools'    ? 'Search tools…'
    : id === 'sessions' ? 'Search your saved creations…'
    : id === 'projects' ? 'Search your projects…'
    : allowToolUrl    ? 'Search, or paste a Lolly link…'
    : 'Search…';

  // A real ARIA tab widget only when there's an actual tab strip (>1 source): each
  // source pane becomes its tab's panel, wired back to the tab that labels it. With a
  // single source there's no tablist, so the lone pane stays a plain section.
  const hasTabs = tabs.length > 1;
  const paneAria = (id: TabId): string =>
    hasTabs ? ` role="tabpanel" id="asset-picker-pane-${id}" aria-labelledby="asset-picker-tab-${id}"` : '';

  root.innerHTML = `
    <div class="asset-picker-backdrop" aria-hidden="true"></div>
    <div class="asset-picker-panel" role="dialog" aria-modal="true" aria-labelledby="asset-picker-title">
      <header class="asset-picker-header">
        <h2 id="asset-picker-title">${escapeHtml(opts.title ?? 'Choose an asset')}</h2>
        <input type="search" class="asset-picker-search" placeholder="${escapeHtml(placeholderFor('library'))}" autocomplete="off" spellcheck="false" aria-label="Search assets">
        <button type="button" class="asset-picker-close" aria-label="Close">×</button>
      </header>
      ${tabs.length > 1 ? `<div class="asset-picker-tabs" role="tablist" aria-label="Asset sources">${tabs.map(tabBtn).join('')}</div>` : ''}
      ${currentToolUrl ? `<div class="asset-picker-current">
        <span class="asset-picker-current-label"><span class="asset-picker-current-spark" aria-hidden="true">✦</span> Current image is from <strong>${escapeHtml(opts.currentToolName ?? 'a Lolly tool')}</strong> — tweak it, or pick a different image below</span>
        <button type="button" class="asset-picker-current-edit">Edit inputs…</button>
      </div>` : ''}
      <div class="asset-picker-body">
        <section class="asset-picker-pane"${paneAria('library')} data-pane="library">
          <div class="asset-picker-catbar" role="group" aria-label="Filter by category" hidden></div>
          <section class="asset-picker-favourites" hidden></section>
          ${showUserAssets ? `<section class="asset-picker-userassets" hidden></section>` : ''}
          <section class="asset-picker-library">
            <div class="asset-picker-loading">Loading…</div>
          </section>
        </section>
        ${allowToolUrl ? `<section class="asset-picker-pane"${paneAria('sessions')} data-pane="sessions" hidden></section>` : ''}
        ${showProjects ? `<section class="asset-picker-pane"${paneAria('projects')} data-pane="projects" hidden></section>` : ''}
        ${embedTools.length ? `<section class="asset-picker-pane"${paneAria('tools')} data-pane="tools" hidden></section>` : ''}
        <div class="asset-picker-toolcard-host" hidden></div>
      </div>
      ${opts.allowUpload ? `
        <footer class="asset-picker-footer">
          <label class="asset-picker-upload">
            <input type="file" accept="${UPLOAD_ACCEPT}" hidden />
            <span class="asset-picker-upload-label">Upload your own…</span>
          </label>
          ${canWebcam ? `<button type="button" class="asset-picker-webcam">${cameraGlyph} Take a photo</button>` : ''}
        </footer>
      ` : ''}
    </div>
  `;

  function tabBtn(tab: Tab): string {
    const on = tab.id === activeTab;
    // Roving tabindex: only the selected tab is in the page Tab sequence; the rest
    // are reached with Arrow keys (see the tablist keydown handler below).
    return `<button type="button" id="asset-picker-tab-${tab.id}" class="asset-picker-tab${on ? ' is-active' : ''}" role="tab" data-tab="${tab.id}" aria-selected="${on}" aria-controls="asset-picker-pane-${tab.id}" tabindex="${on ? '0' : '-1'}">${escapeHtml(tab.label)}</button>`;
  }

  // Return focus to whatever opened the picker (the asset-picker trigger button)
  // when the dialog closes.
  const opener = document.activeElement;
  // On-screen-gated lottie autoplayer over the whole library pane (see refreshLottieThumbs);
  // torn down when the picker closes so no player keeps ticking after the dialog is gone.
  let lottieThumbs: { destroy(): void } | null = null;
  let trap: FocusTrap | undefined;
  const close = (value: AssetRef | null): void => {
    trap?.release();
    lottieThumbs?.destroy();
    root.innerHTML = '';
    if (opener instanceof HTMLElement) opener.focus();
    resolve(value);
  };

  root.querySelector('.asset-picker-close')?.addEventListener('click', () => close(null));
  root.querySelector('.asset-picker-backdrop')?.addEventListener('click', () => close(null));

  const body         = root.querySelector<HTMLElement>('.asset-picker-body')!;
  const currentEl    = root.querySelector<HTMLElement>('.asset-picker-current');
  const libraryPane  = root.querySelector<HTMLElement>('.asset-picker-pane[data-pane="library"]')!;
  // (Re)arm the lottie autoplayer over the library pane — its favourites, user-uploads, and
  // library grids all render inside it. Called after each of those grids (re)renders so newly
  // built [data-lottie-src] markers get observed; destroys the prior observer to avoid stacking.
  const refreshLottieThumbs = (): void => {
    lottieThumbs?.destroy();
    lottieThumbs = autoplayLottieThumbs(libraryPane, { isCurrent: () => libraryPane.isConnected });
  };
  const libraryEl    = root.querySelector<HTMLElement>('.asset-picker-library')!;
  const favEl        = root.querySelector<HTMLElement>('.asset-picker-favourites');
  const userEl       = root.querySelector<HTMLElement>('.asset-picker-userassets');
  const searchInput  = root.querySelector<HTMLInputElement>('.asset-picker-search')!;
  // Contain keyboard focus within the modal (inert the page behind + wrap Tab) and
  // land focus in the search field. Escape/arrow-roving are handled below already.
  trap = trapFocus(root, { initialFocus: searchInput });
  const toolcardHost = root.querySelector<HTMLElement>('.asset-picker-toolcard-host')!;
  const footerEl     = root.querySelector<HTMLElement>('.asset-picker-footer');
  const sessionsPane = root.querySelector<HTMLElement>('.asset-picker-pane[data-pane="sessions"]');
  const projectsPane = root.querySelector<HTMLElement>('.asset-picker-pane[data-pane="projects"]');
  const toolsPane    = root.querySelector<HTMLElement>('.asset-picker-pane[data-pane="tools"]');
  const catbarEl     = root.querySelector<HTMLElement>('.asset-picker-catbar');

  // "Edit the tool you're already using": re-open the source tool's inputs seeded
  // from the slot's current embed URL (mode 'edit' → "Re-apply to slot"). A commit
  // resolves the picker with the fresh render; cancelling stays here so the user
  // can still pick a different image instead.
  currentEl?.querySelector('.asset-picker-current-edit')?.addEventListener('click', async () => {
    const ref = await opts.editTool!(currentToolUrl!, 'edit');
    if (ref) close(ref);
  });

  // ── Keyboard navigation over the (responsive) card grid ────────────────────
  // Cards flow left-to-right then wrap, so DOM order == visual reading order:
  // Left/Right step through that order. The column count is unknown (responsive),
  // so Up/Down can't index by row — instead they pick the geometrically nearest
  // card in the row above/below by comparing on-screen centres. Scoped to the
  // currently visible pane so arrows never jump into a hidden one.
  const visiblePane = (): HTMLElement | null => root.querySelector<HTMLElement>('.asset-picker-pane:not([hidden])');
  const navCards = (): HTMLElement[] => {
    const pane = visiblePane();
    // Skip cards inside a collapsed section (offsetParent is null when display:none).
    return pane ? [...pane.querySelectorAll<HTMLElement>('[data-asset-id],[data-tool-id],[data-session-slot]')]
      .filter(el => el.offsetParent !== null) : [];
  };
  function focusCard(el: HTMLElement | null | undefined): void { if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); } }
  function moveSelection(cur: HTMLElement, key: string): void {
    const cards = navCards();
    const i = cards.indexOf(cur);
    if (key === 'ArrowRight') return focusCard(cards[i + 1]);
    if (key === 'ArrowLeft')  return focusCard(cards[i - 1]);
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const down = key === 'ArrowDown';
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const c of cards) {
      if (c === cur) continue;
      const cr = c.getBoundingClientRect();
      const vy = (cr.top + cr.height / 2) - cy;
      if (down ? vy <= r.height * 0.4 : vy >= -r.height * 0.4) continue; // must be a further row
      const dx = Math.abs((cr.left + cr.width / 2) - cx);
      const score = dx + Math.abs(vy) * 1.5; // nearest column first, then nearest row
      if (score < bestScore) { bestScore = score; best = c; }
    }
    focusCard(best);
  }

  root.querySelector<HTMLElement>('.asset-picker-panel')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
    if (e.target === searchInput) {
      // Enter commits a ready tool-render card (paste link → ↵ → use).
      if (e.key === 'Enter') {
        const use = root.querySelector<HTMLButtonElement>('.asset-picker-toolcard .tc-use');
        if (use && !use.disabled) { e.preventDefault(); use.click(); }
        return;
      }
      // Down out of the search field drops into the grid.
      if (e.key === 'ArrowDown') { e.preventDefault(); focusCard(navCards()[0]); }
      return;
    }
    const cur = (e.target as HTMLElement).closest?.('[data-asset-id],[data-tool-id],[data-session-slot]') as HTMLElement | null | undefined;
    if (cur && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      moveSelection(cur, e.key);
    }
    // Enter / Space activate the focused card button natively → selects.
  });

  // Tab strip: click switches which source pane is visible; Arrow keys rove focus
  // between tabs (Home/End jump to the ends), activating each as it's reached — the
  // ARIA tabs pattern. Roving keeps focus on the tab (setTab lands it on the pane's
  // first card, so we re-focus the tab afterwards).
  const tabsEl = root.querySelector<HTMLElement>('.asset-picker-tabs');
  tabsEl?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (btn) setTab(btn.dataset.tab as TabId);
  });
  tabsEl?.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const btns = [...tabsEl.querySelectorAll<HTMLElement>('.asset-picker-tab')];
    const i = btns.findIndex(b => b === document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? btns.length - 1
      : e.key === 'ArrowLeft' ? (i - 1 + btns.length) % btns.length
      : (i + 1) % btns.length;
    const target = btns[next];
    if (!target) return;
    setTab(target.dataset.tab as TabId);
    target.focus();
  });

  // One delegated handler serves every region: choose an icon colour, pick a
  // library/user asset, delete a user image, embed a saved session, or open a tool.
  body.addEventListener('click', async (e) => {
    // Icon colour pairing — the strip lives inside the (re-rendered) Icons group,
    // so it's handled by delegation rather than a per-render listener.
    const theme = (e.target as HTMLElement).closest<HTMLElement>('[data-theme-id]');
    if (theme) {
      // The first pairing is the icons' baked default → no id suffix in the pick.
      activeTheme = theme.dataset.themeId === iconThemes[0]?.id ? null : theme.dataset.themeId;
      libraryEl.querySelectorAll<HTMLElement>('[data-theme-id]').forEach(b => {
        const on = b === theme;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      retintThemableCards();
      return;
    }
    // Photo colour treatment — same delegation story as the icon strip above.
    const treat = (e.target as HTMLElement).closest<HTMLElement>('[data-treatment-id]');
    if (treat) {
      // The "None" button carries an empty id → the plain photo, no suffix.
      activeTreatment = treat.dataset.treatmentId || null;
      libraryEl.querySelectorAll<HTMLElement>('[data-treatment-id]').forEach(b => {
        const on = b === treat;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      retreatPhotoCards();
      return;
    }
    // Quick-filter by category: the icon row pins one library section open and
    // collapses the rest (click the active one again to collapse everything). The
    // section headers still toggle independently; both keep the row's indicator in
    // sync via updateCatbar().
    const catBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-cat-filter]');
    if (catBtn) {
      const key = catBtn.dataset.catFilter!;
      const isOnlyOpen = !collapsedGroups.has(key)
        && libraryGroupKeys.every(k => k === key || collapsedGroups.has(k));
      if (isOnlyOpen) {
        collapsedGroups.add(key); // it was the sole open section → collapse all
      } else {
        for (const k of libraryGroupKeys) { if (k === key) collapsedGroups.delete(k); else collapsedGroups.add(k); }
      }
      applyLibraryCollapse();
      updateCatbar();
      if (!collapsedGroups.has(key)) {
        libraryEl.querySelector<HTMLElement>(`.asset-picker-group[data-group="${CSS.escape(key)}"]`)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      return;
    }
    // Collapse / expand a library section. State is kept in `collapsedGroups` so it
    // survives the innerHTML rebuild a search / tab-return does.
    const gt = (e.target as HTMLElement).closest<HTMLElement>('[data-group-toggle]');
    if (gt) {
      const key = gt.dataset.groupToggle!;
      const sec = gt.closest('.asset-picker-group')!;
      const collapse = !sec.classList.contains('is-collapsed');
      sec.classList.toggle('is-collapsed', collapse);
      gt.setAttribute('aria-expanded', String(!collapse));
      if (collapse) collapsedGroups.add(key); else collapsedGroups.delete(key);
      updateCatbar(); // manually opening/closing a section moves the row's indicator too
      return;
    }
    // Projects tab: drill into a folder (or a breadcrumb) — empty id = the top level.
    const fo = (e.target as HTMLElement).closest<HTMLElement>('[data-folder-open]');
    if (fo) {
      projectFolder = fo.dataset.folderOpen || null;
      renderProjects(searchInput.value.trim().toLowerCase());
      focusCard(navCards()[0]);
      return;
    }
    const del = (e.target as HTMLElement).closest<HTMLElement>('[data-delete-id]');
    if (del) {
      const id = del.dataset.deleteId!;
      const name = (userAssets.find(a => a.id === id)?.meta?.name as string | undefined) ?? 'this image';
      // Deleting a user image is destructive and can't be undone — confirm first
      // (shared modal, matching the Catalog/Projects delete flows).
      const ok = await confirmDialog({
        title: 'Delete this image?',
        message: `“${name}” will be permanently removed from your images. This can’t be undone.`,
      });
      if (!ok) return;
      const card = del.closest<HTMLElement>('.asset-picker-card');
      card?.querySelector('.asset-picker-card-error')?.remove(); // clear any prior failure note
      try {
        // The bridge announces the delete ('lolly:user-asset-deleted', wired in
        // main.ts), which also drops an audio upload from the Neurospicy player.
        await host.assets._deleteUserAsset(id);
        userAssets = userAssets.filter(a => a.id !== id);
        renderUserAssets();
        renderFavourites();
        updateUploadAffordance();
        announce(`Deleted ${name}.`);
      } catch (err) {
        host.log('error', 'Failed to delete user image', { id, error: String(err) });
        // The card is still on screen (the delete threw) — surface the failure beside
        // it rather than leaving the user staring at a card that wouldn't go away.
        if (card) {
          const msg = document.createElement('p');
          msg.className = 'asset-picker-card-error';
          msg.setAttribute('role', 'alert');
          msg.style.cssText = 'margin:4px 0 0;font-size:11px;color:hsl(var(--destructive));text-align:center';
          msg.textContent = 'Couldn’t delete — try again.';
          card.appendChild(msg);
        }
      }
      return;
    }
    const sess = (e.target as HTMLElement).closest<HTMLElement>('[data-session-slot]');
    if (sess) { embedSession(sess.dataset.sessionSlot!); return; }
    const tool = (e.target as HTMLElement).closest<HTMLElement>('[data-tool-id]');
    if (tool) { embedTool(tool.dataset.toolId!); return; }
    const pick = (e.target as HTMLElement).closest<HTMLElement>('[data-asset-id]');
    if (pick) {
      // A non-default icon theme / photo treatment rides in the picked id so it
      // survives URL-mode round-trips (an asset value persists as its id alone).
      let pickId = pick.dataset.assetId!;
      const pickRef = candidateById.get(pickId);
      if (activeTheme && isThemableRef(pickRef)) {
        pickId = buildThemedAssetId(pickId, activeTheme);
      } else if (activeTreatment && isTreatableRef(pickRef)) {
        pickId = buildTreatedAssetId(pickId, activeTreatment);
      }
      try {
        const resolved = await host.assets.get(pickId);
        close(resolved);
      } catch (err) {
        host.log('error', 'Failed to resolve asset', { id: pickId, error: String(err) });
        announce(`Could not resolve asset: ${(err as Error).message}`, { assertive: true });
        // The picked card is still on screen — surface the failure beside it rather than
        // blocking on a native alert (same inline note as the delete path above).
        const card = pick.closest<HTMLElement>('.asset-picker-card');
        card?.querySelector('.asset-picker-card-error')?.remove(); // clear any prior failure note
        if (card) {
          const msg = document.createElement('p');
          msg.className = 'asset-picker-card-error';
          msg.setAttribute('role', 'alert');
          msg.style.cssText = 'margin:4px 0 0;font-size:11px;color:hsl(var(--destructive));text-align:center';
          msg.textContent = 'Couldn’t load — try again.';
          card.appendChild(msg);
        }
      }
    }
  });

  // A tool preview is a build artifact (catalog/previews/) that, though committed, can
  // be missing on a fresh checkout / before `npm run previews`, or drift from the index
  // — when one 404s, reveal the tool's inline icon instead of a broken image. Error
  // events don't bubble, so listen in the capture phase, scoped to tool previews so
  // library/session thumbs are untouched (mirrors gallery.ts).
  body.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.classList.contains('asset-picker-toolitem-preview')) {
      img.closest('.asset-picker-toolitem')?.classList.add('no-preview');
    }
  }, true);

  function setFooter(show: boolean): void { footerEl?.toggleAttribute('hidden', !show); }

  // Show/hide panes for the chosen tab, dismiss any tool-render takeover, re-filter
  // the now-visible pane with the current query, and land focus on its first card.
  function setTab(id: TabId): void {
    activeTab = id;
    root.querySelectorAll<HTMLElement>('.asset-picker-tab').forEach(b => {
      const on = b.dataset.tab === id;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1; // keep the roving tabindex on the selected tab
    });
    toolcardHost.hidden = true;
    toolcardHost.innerHTML = '';
    if (currentEl) currentEl.hidden = false;
    root.querySelectorAll<HTMLElement>('.asset-picker-pane').forEach(p => { p.hidden = p.dataset.pane !== id; });
    setFooter(id === 'library');
    searchInput.placeholder = placeholderFor(id);
    const raw = searchInput.value.trim();
    const q = raw.toLowerCase();
    // A URL in the box is a paste-to-render intent, handled by the search listener —
    // don't fight it by re-filtering a list underneath.
    if (!(allowToolUrl && /^https?:\/\//i.test(raw))) {
      if (id === 'library') restoreLibrary(q);
      else if (id === 'sessions') renderSessions(q);
      else if (id === 'projects') renderProjects(q);
      else if (id === 'tools') renderTools(q);
    }
    const first = navCards()[0];
    if (first) first.focus({ preventScroll: true });
  }

  function renderUserAssets(): void {
    if (!userEl) return;
    if (userAssets.length === 0) { userEl.hidden = true; userEl.innerHTML = ''; return; }
    userEl.hidden = false;

    // Group the loaded images by the folder each belongs to (if any), preserving
    // the newest-first order within each group. Cards keep their existing markup
    // so pick/delete/keyboard-nav are unchanged — only headings are added.
    const folderOf = new Map<string, Folder>();
    for (const f of folders) for (const it of f.items) if (it.type === 'image') folderOf.set(it.ref, f);
    const groups = new Map<string, { name: string; items: AssetRef[] }>();   // folderId → { name, items }
    const ungrouped: AssetRef[] = [];
    for (const a of userAssets) {
      const f = folderOf.get(a.id);
      if (f) { if (!groups.has(f.id)) groups.set(f.id, { name: f.name, items: [] }); groups.get(f.id)!.items.push(a); }
      else ungrouped.push(a);
    }

    let inner = '';
    for (const g of groups.values()) {
      inner += `<div class="asset-picker-folder-head">${escapeHtml(g.name)}</div>`;
      inner += `<div class="asset-picker-grid">${g.items.map(userCard).join('')}</div>`;
    }
    if (ungrouped.length) {
      if (groups.size) inner += `<div class="asset-picker-folder-head">Ungrouped</div>`;
      inner += `<div class="asset-picker-grid">${ungrouped.map(userCard).join('')}</div>`;
    }
    // Same collapsible section chrome as the library groups (one delegated toggle
    // handler serves both); state persists in collapsedGroups across re-renders.
    userEl.innerHTML = sectionHtml(
      { key: 'your-images', label: 'Your images' },
      String(userAssets.length),
      '',
      inner,
    );
    refreshLottieThumbs();
  }

  function updateUploadAffordance(): void {
    // No upload cap any more — the affordance is always available. Kept as a hook
    // so the label stays correct if a section re-render leaves it disabled.
    const labelEl   = root.querySelector<HTMLElement>('.asset-picker-upload-label');
    const fileInput = root.querySelector<HTMLInputElement>('.asset-picker-upload input[type="file"]');
    if (fileInput) fileInput.disabled = false;
    root.querySelector('.asset-picker-upload')?.classList.remove('is-disabled');
    if (labelEl) labelEl.textContent = 'Upload your own…';
  }

  if (opts.allowUpload) {
    const fileInput = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        // A PDF/.ai becomes an SVG asset of one chosen page (the picker fills a single
        // slot, so single-select). The converter is a lazy chunk — pdf-lib only loads
        // when a PDF actually arrives. A cancelled page pick returns no refs: stay open.
        if (isPdfUpload(file)) {
          const { ingestPdfAsSvgAssets } = await import('./pdf-import.ts');
          const refs = await ingestPdfAsSvgAssets(host, file, {
            mode: 'single',
            warn: (m) => announce(m, { assertive: true }),
          });
          if (refs[0]) close(refs[0]);
          return;
        }
        const ref = await storeUserUpload(host, file);
        close(ref);
      } catch (e) {
        host.log('error', 'Upload failed', { error: String(e) });
        // Cap/quota errors carry a user-ready message; prefix only the rest.
        announce((e as { code?: unknown }).code ? (e as Error).message : `Upload failed: ${(e as Error).message}`, { assertive: true });
      } finally {
        fileInput.value = ''; // allow re-selecting the same file after an error
      }
    });
  }

  // "Take a photo": open a live webcam preview, capture one frame, and store it as an
  // ordinary raster user asset (same path + AssetRef as an upload). Camera teardown is
  // handled inside openWebcamCapture so no track outlives the dialog.
  root.querySelector('.asset-picker-webcam')?.addEventListener('click', async () => {
    const ref = await openWebcamCapture(host);
    if (ref) close(ref);
  });

  // Library sections + bucketing live in lib/asset-category.ts (shared with the Catalog
  // view so both group identically). A per-user override (profile.assetCategories) layers
  // over the tag inference — loaded once per open, refreshed on each render() below.
  const cat = (ref: AssetRef): string => libCategory(ref, assetCategoryOverrides);
  const collapsedGroups = new Set<string>(); // group keys the user collapsed; persists across re-render
  // The present top-level library category keys, in display order — the model behind
  // the category filter row. Refreshed on every renderLibrary (search narrows it).
  let libraryGroupKeys: string[] = [];
  // Seed the "one category open" default exactly once, on the first full render.
  let catFilterSeeded = false;
  const CHEVRON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';

  // One collapsible section shell — used by the library groups, their nested
  // sub-groups, and the "Your images" section, so the delegated toggle handler
  // and collapse-state Set serve all of them identically. `collapsed` defaults to
  // the persisted state but callers can override it (the library forces every
  // section open while a search query is active so matches are never hidden).
  function sectionHtml(
    g: { key: string; label: string }, count: string | number, strip: string, bodyHtml: string,
    collapsed: boolean = collapsedGroups.has(g.key),
  ): string {
    return `<section class="asset-picker-group${collapsed ? ' is-collapsed' : ''}" data-group="${escapeHtml(g.key)}">
      <div class="asset-picker-group-head">
        <button type="button" class="asset-picker-group-toggle" data-group-toggle="${escapeHtml(g.key)}" aria-expanded="${!collapsed}">
          <span class="asset-picker-group-chevron">${CHEVRON}</span>
          <span class="asset-picker-group-icon">${categoryGlyph(g.key)}</span>
          <span class="asset-picker-group-title">${escapeHtml(g.label)}</span>
          <span class="asset-picker-count">${count}</span>
        </button>
        ${strip}
      </div>
      <div class="asset-picker-group-body">${bodyHtml}</div>
    </section>`;
  }

  // The category filter row (icons up the top of the library pane): one glyph per
  // present category, active when its section is open, hidden while searching or
  // when there's only one category (nothing to filter between).
  function renderCatbar(): void {
    if (!catbarEl) return;
    const searching = searchInput.value.trim() !== '';
    if (searching || libraryGroupKeys.length < 2) { catbarEl.hidden = true; catbarEl.innerHTML = ''; return; }
    catbarEl.hidden = false;
    catbarEl.innerHTML = libraryGroupKeys.map(key => {
      const on = !collapsedGroups.has(key);
      const label = categoryLabel(key);
      return `<button type="button" class="asset-picker-catbtn${on ? ' is-active' : ''}" data-cat-filter="${escapeHtml(key)}" aria-pressed="${on}" aria-label="${escapeHtml(label)}" data-tip="${escapeHtml(label)}">
        <span class="asset-picker-catbtn-glyph">${categoryGlyph(key)}</span>
      </button>`;
    }).join('');
  }

  // Reflect collapsedGroups onto the filter row's active states (called after a
  // section toggle or a filter click, without rebuilding the row).
  function updateCatbar(): void {
    if (!catbarEl) return;
    for (const btn of catbarEl.querySelectorAll<HTMLElement>('[data-cat-filter]')) {
      const on = !collapsedGroups.has(btn.dataset.catFilter!);
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  // Apply collapsedGroups to the already-rendered top-level library sections (so a
  // filter click doesn't rebuild the grids, losing scroll / live thumbnails).
  function applyLibraryCollapse(): void {
    for (const sec of libraryEl.querySelectorAll<HTMLElement>(':scope > .asset-picker-group[data-group]')) {
      const collapsed = collapsedGroups.has(sec.dataset.group!);
      sec.classList.toggle('is-collapsed', collapsed);
      sec.querySelector('.asset-picker-group-toggle')?.setAttribute('aria-expanded', String(!collapsed));
    }
  }

  // A group's body: the items not claimed by a sub-group as a grid, then each
  // non-empty sub-group as a nested collapsible section.
  function groupBodyHtml(g: LibGroup, items: AssetRef[]): string {
    const subs: string[] = [];
    let rest = items;
    for (const s of g.sub ?? []) {
      const inSub = rest.filter(c => (c.meta?.tags as string[] | undefined)?.includes(s.tag));
      if (inSub.length) {
        subs.push(sectionHtml(s, inSub.length, '', `<div class="asset-picker-grid">${inSub.map(card).join('')}</div>`));
        rest = rest.filter(c => !(c.meta?.tags as string[] | undefined)?.includes(s.tag));
      }
    }
    const restGrid = rest.length ? `<div class="asset-picker-grid">${rest.map(card).join('')}</div>` : '';
    return restGrid + subs.join('');
  }

  function renderLibrary(candidates: AssetRef[]): void {
    if (candidates.length === 0) {
      libraryEl.innerHTML = `<p class="asset-picker-empty" role="status">No assets match.${opts.allowUpload ? ' Upload one below.' : ''}</p>`;
      libraryGroupKeys = [];
      renderCatbar(); // nothing to filter → hide the row (esp. on a zero-result search)
      return;
    }
    // Bucket by category, preserving order within each bucket.
    const buckets = new Map<string, AssetRef[]>();
    for (const c of candidates) {
      const k = cat(c);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(c);
    }
    const present = LIB_GROUPS.filter(g => buckets.get(g.key)?.length);
    libraryGroupKeys = present.map(g => g.key);
    // First render seeds the "one category open" default: everything collapses except
    // the current asset's category (or the first present one). After that the user's
    // own expand/collapse choices, held in collapsedGroups, are respected.
    if (!catFilterSeeded) {
      catFilterSeeded = true;
      const curRef = currentBaseId ? candidates.find(c => assetBaseId(c.id) === currentBaseId) : undefined;
      const openKey = (curRef && present.some(g => g.key === cat(curRef))) ? cat(curRef) : present[0]?.key;
      for (const g of present) if (g.key !== openKey) collapsedGroups.add(g.key);
    }
    // While a search query is active every section renders open, so matches are
    // never hidden behind a collapsed folder; the filter row is hidden meanwhile.
    const searching = searchInput.value.trim() !== '';
    // A group carries a colour strip in its header: the icon pairing strip when
    // it holds themable icons, or the photo treatment strip when it holds raster
    // photos. A group is one or the other, never both.
    const themableOf = (items: AssetRef[]) => iconThemes.length > 1 && items.some(isThemableRef);
    const treatableOf = (items: AssetRef[]) => photoTreatments.length > 0 && items.some(isTreatableRef);
    // Every picker gets the same section chrome — even a single-category one
    // (e.g. a raster-only field) — so a narrow slot's picker matches the full
    // catalog selector: collapsible folders, nested sub-groups (Headshots), and
    // the colour strip whenever themable icons / treatable photos are present.
    libraryEl.innerHTML = present.map(g => {
      const items = buckets.get(g.key)!;
      const strip = themableOf(items) ? themeStripHtml() : treatableOf(items) ? treatmentStripHtml() : '';
      return sectionHtml(g, items.length, strip, groupBodyHtml(g, items), searching ? false : collapsedGroups.has(g.key));
    }).join('');
    renderCatbar();
    ensureTreatmentDefs();
    retintThemableCards(); // re-applied after every innerHTML rebuild (search, tab return)
    retreatPhotoCards();
    refreshLottieThumbs();
  }

  // ── Icon theme strip ────────────────────────────────────────────────────────
  // Markup for the colour-pairing strip. Rebuilt with the Icons group on every
  // renderLibrary (search / tab return); the active pairing lives in `activeTheme`
  // and clicks are handled by the delegated body listener, so no per-render wiring.
  function themeStripHtml(): string {
    return `<div class="asset-picker-themes" role="group" aria-label="Colour theme">`
      + `<span class="asset-picker-themes-label">Colours</span>`
      + iconThemes.map((t, i) => {
          const on = activeTheme ? t.id === activeTheme : i === 0;
          return `<button type="button" class="asset-picker-theme${on ? ' is-active' : ''}" data-theme-id="${escapeHtml(t.id)}" data-sfx="shimmer" data-voice="${escapeHtml(t.label ?? t.id)}" aria-pressed="${on}">
            <span class="asset-picker-theme-duo" style="background:${escapeHtml(t.previewBg ?? '#ffffff')}"><i style="background:${escapeHtml(t.c2)}"></i><i style="background:${escapeHtml(t.c1)}"></i></span>
            <span>${escapeHtml(t.label ?? t.id)}</span>
          </button>`;
        }).join('')
      + `</div>`;
  }

  // Live-preview the chosen pairing on every themable thumbnail. Restyle (class
  // contract kept) rather than bake — each thumb is its own <img> document, so
  // there is no cross-icon CSS collision here. SVG text is fetched once per
  // asset and finished data URLs are cached per pairing, so a rebuild (every
  // search keystroke re-renders the grid) just reassigns strings; a seq guard
  // drops stale passes when the user flips themes quickly.
  const iconSvgTextCache = new Map<string, Promise<string | null>>();  // asset id → Promise<string|null>
  const themedThumbCache = new Map<string, string>();  // `${asset id}:${theme id}` → data URL
  let retintSeq = 0;
  function retintThemableCards(): void {
    const def = activeTheme ? iconThemes.find(t => t.id === activeTheme) : null;
    const seq = ++retintSeq;
    // Scope to the whole library PANE (not just libraryEl) so themable icons pinned in
    // the Favourites section retint too — they share candidateById with the grid.
    for (const cardEl of libraryPane.querySelectorAll<HTMLElement>('[data-asset-id]')) {
      const ref = candidateById.get(cardEl.dataset.assetId!);
      if (!isThemableRef(ref)) continue;
      const img = cardEl.querySelector<HTMLImageElement>('img.asset-picker-thumb');
      if (!img) continue;
      if (!def) { img.src = ref.url; img.style.background = ''; continue; }
      const cached = themedThumbCache.get(`${ref.id}:${def.id}`);
      if (cached) { img.src = cached; img.style.background = def.previewBg ?? ''; continue; }
      let textP = iconSvgTextCache.get(ref.id);
      if (!textP) {
        textP = fetch(ref.url).then(r => (r.ok ? r.text() : null)).catch(() => null);
        iconSvgTextCache.set(ref.id, textP);
      }
      textP.then(text => {
        const restyled = text ? restyleIconTheme(text, def) : null;
        if (!restyled) return;
        const src = svgDataUrl(restyled);
        themedThumbCache.set(`${ref.id}:${def.id}`, src);
        if (seq !== retintSeq) return; // superseded by a newer theme choice
        img.src = src;
        img.style.background = def.previewBg ?? '';
      });
    }
  }

  // ── Photo treatment strip ────────────────────────────────────────────────────
  // Markup for the treatment strip, rebuilt with each photo group. A leading
  // "None" button clears the treatment; the rest are the catalog's treatments,
  // each with a swatch previewing its look (a grey ramp, or the duotone's
  // shadow→highlight gradient).
  function treatmentStripHtml(): string {
    const swatch = (t: PhotoTreatment): string =>
      t.kind === 'greyscale'
        ? 'linear-gradient(135deg,#2b2b2b,#e9e9e9)'
        : `linear-gradient(135deg,${[t.shadow, t.mid, t.highlight].filter(Boolean).join(',')})`;
    const btn = (id: string, label: string, swClass: string, swStyle: string, on: boolean): string =>
      `<button type="button" class="asset-picker-theme asset-picker-treat${on ? ' is-active' : ''}" data-treatment-id="${escapeHtml(id)}" aria-pressed="${on}">`
      + `<span class="asset-picker-treat-sw${swClass}"${swStyle ? ` style="${swStyle}"` : ''}></span><span>${escapeHtml(label)}</span></button>`;
    return `<div class="asset-picker-treatments" role="group" aria-label="Photo colour treatment">`
      + `<span class="asset-picker-themes-label">Colour</span>`
      + btn('', 'None', ' is-none', '', !activeTreatment)
      + photoTreatments.map(t => btn(t.id, t.label ?? t.id, '', `background:${swatch(t)}`, t.id === activeTreatment)).join('')
      + `</div>`;
  }

  // Live-preview the chosen treatment on every photo thumbnail via a CSS filter
  // that points at an injected SVG <filter> def — cheap, no re-encode (the real
  // bake happens once, at resolve, when the photo is actually picked). Mirrors
  // retintThemableCards but for raster cards.
  function retreatPhotoCards(): void {
    const def = activeTreatment ? photoTreatments.find(t => t.id === activeTreatment) : null;
    for (const cardEl of libraryPane.querySelectorAll<HTMLElement>('[data-asset-id]')) {
      if (!isTreatableRef(candidateById.get(cardEl.dataset.assetId!))) continue;
      const img = cardEl.querySelector<HTMLImageElement>('img.asset-picker-thumb');
      if (img) img.style.filter = def ? `url(#${TREATMENT_FILTER_PREFIX}${def.id})` : '';
    }
  }

  // A hidden <svg><defs> of the treatment filters, injected once so the preview
  // CSS `filter: url(#…)` above can reference them. Rebuilt from the catalog's
  // treatments (ids are validated [a-z0-9-], so the fragment refs are safe).
  const TREATMENT_FILTER_PREFIX = 'lolly-pt-';
  function ensureTreatmentDefs(): void {
    if (!photoTreatments.length || root.querySelector('#lolly-pt-defs')) return;
    const defs = photoTreatments.map(t => treatmentFilterSvg(t, `${TREATMENT_FILTER_PREFIX}${t.id}`)).join('');
    const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    holder.id = 'lolly-pt-defs';
    holder.setAttribute('width', '0');
    holder.setAttribute('height', '0');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    holder.innerHTML = `<defs>${defs}</defs>`;
    root.appendChild(holder);
  }

  // Library candidates resolve async (host.assets.query); `restoreLibrary` filters
  // them and is safe to call before they land (shows the loading state until then).
  let libraryCandidates: AssetRef[] = [];
  let candidateById = new Map<string, AssetRef>();
  let libraryLoaded = false;
  function restoreLibrary(q: string): void {
    renderUserAssets();
    if (!libraryLoaded) { libraryEl.innerHTML = `<div class="asset-picker-loading">Loading…</div>`; return; }
    if (!q) { renderLibrary(libraryCandidates); return; }
    renderLibrary(libraryCandidates.filter(c =>
      ((c.meta?.name ?? c.id) as string).toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
    ));
  }

  // ── Favourites — a pinned, collapsible section at the top of the library pane ──
  // Unions the user's starred LIBRARY assets and starred USER images (keyed by base id,
  // so a themed icon starred once shows once). Read-only pins here — a favourite is
  // picked like any other card (delegated [data-asset-id] handler resolves it, incl.
  // user ids). Starring itself happens in the Catalog view. Rebuilt whenever the sources
  // or the favourites set change; unaffected by the search box (it's a fixed shortcut).
  function renderFavourites(): void {
    if (!favEl) return;
    if (favSet.size === 0) { favEl.hidden = true; favEl.innerHTML = ''; return; }
    // Candidates the picker can actually pick, deduped by base id, in library-then-user
    // order. Hidden assets are already filtered out of both source lists upstream.
    const seen = new Set<string>();
    const favItems: AssetRef[] = [];
    for (const ref of [...libraryCandidates, ...userAssets]) {
      const base = assetBaseId(ref.id);
      if (!favSet.has(base) || seen.has(base)) continue;
      seen.add(base);
      favItems.push(ref);
    }
    if (favItems.length === 0) { favEl.hidden = true; favEl.innerHTML = ''; return; }
    favEl.hidden = false;
    favEl.innerHTML = sectionHtml(
      { key: 'favourites', label: '★ Favourites' },
      favItems.length, '',
      `<div class="asset-picker-grid">${favItems.map(card).join('')}</div>`,
    );
    retintThemableCards();
    retreatPhotoCards();
    refreshLottieThumbs();
  }

  // ── Saved creations (previous single-tool sessions) ────────────────────────
  function renderSessions(q: string): void {
    if (!sessionsPane) return;
    if (sessions === null) { sessionsPane.innerHTML = `<div class="asset-picker-loading">Loading…</div>`; return; }
    const list = q
      ? sessions.filter(s => (s.toolName ?? '').toLowerCase().includes(q)
          || (s.label ?? '').toLowerCase().includes(q) || s.toolId.includes(q))
      : sessions;
    if (list.length === 0) {
      sessionsPane.innerHTML = `<p class="asset-picker-empty">${sessions.length
        ? 'No saved creations match.'
        : 'No saved creations yet — save a tool you’ve made, then embed it here as an image.'}</p>`;
      return;
    }
    sessionsPane.innerHTML =
      `<div class="asset-picker-section-head">Your saved creations <span class="asset-picker-count">${sessions.length}</span></div>` +
      `<div class="asset-picker-grid">${list.map(sessionCard).join('')}</div>`;
  }

  // ── Projects (browse the user's folders of saved creations + images) ────────
  // The items a folder holds that this picker can actually place: saved creations
  // whose tool still renders here, and user images that are loaded. Non-pickable
  // refs (a session tool that can't embed, images on a no-upload slot) are skipped.
  function pickableFolderItems(f: Folder): FolderItem[] {
    return f.items.filter(it => it.type === 'session'
      ? (sessions ?? []).some(s => s.slot === it.ref)
      : userAssets.some(a => a.id === it.ref));
  }

  function folderCard(f: Folder): string {
    const subs  = childFolders(folders, f.id).length;
    const items = pickableFolderItems(f).length;
    const bits: string[] = [];
    if (subs)  bits.push(`${subs} folder${subs === 1 ? '' : 's'}`);
    if (items) bits.push(`${items} item${items === 1 ? '' : 's'}`);
    return `
      <button type="button" class="asset-picker-card asset-picker-folderitem" data-folder-open="${escapeHtml(f.id)}" title="${escapeHtml(f.name)}">
        <span class="asset-picker-thumb asset-picker-folder-thumb" aria-hidden="true">${folderGlyph}</span>
        <span class="asset-picker-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
        <span class="asset-picker-sessitem-when">${escapeHtml(bits.join(' · ') || 'Empty')}</span>
      </button>`;
  }

  // An image inside a folder — a plain pick tile (no delete affordance; deletion
  // lives in the Your images list). Picking routes through the shared [data-asset-id] handler.
  function projectImageCard(ref: AssetRef): string {
    const name = String(ref.meta?.name ?? 'Image');
    const thumb = ref.type === 'lottie'
      ? (lottieThumb(ref, 'asset-picker-thumb') ?? `<span class="asset-picker-thumb asset-picker-thumb-stub" aria-hidden="true">▶</span>`)
      : ref.type === 'video'
        ? videoThumb(ref.url, 'asset-picker-thumb')
        : `<img class="asset-picker-thumb" src="${escapeHtml(ref.url)}" alt="" loading="lazy" decoding="async">`;
    return `
      <button type="button" class="asset-picker-card" data-asset-id="${escapeHtml(ref.id)}" title="${escapeHtml(name)}">
        ${thumb}
        <span class="asset-picker-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        ${formatBadge(ref)}
      </button>`;
  }

  function renderProjects(q: string): void {
    if (!projectsPane) return;
    if (!foldersLoaded) { projectsPane.innerHTML = `<div class="asset-picker-loading">Loading…</div>`; return; }
    // A folder that vanished (deleted elsewhere / synced-away) drops us back to the top.
    if (projectFolder && !folders.some(f => f.id === projectFolder)) projectFolder = null;

    const path = projectFolder ? folderPath(folders, projectFolder) : [];
    const crumbs = `<nav class="asset-picker-crumbs" aria-label="Folder path">`
      + `<button type="button" class="asset-picker-crumb" data-folder-open="">Projects</button>`
      + path.map((f, i) => {
          const last = i === path.length - 1;
          return `<span class="asset-picker-crumb-sep" aria-hidden="true">›</span>`
            + (last
                ? `<span class="asset-picker-crumb is-current" aria-current="true">${escapeHtml(f.name)}</span>`
                : `<button type="button" class="asset-picker-crumb" data-folder-open="${escapeHtml(f.id)}">${escapeHtml(f.name)}</button>`);
        }).join('')
      + `</nav>`;

    if (!folders.length) {
      projectsPane.innerHTML = crumbs
        + `<p class="asset-picker-empty">No projects yet — group your saved creations and images into folders to browse them here.</p>`;
      return;
    }

    const kids = childFolders(folders, projectFolder).filter(f => !q || f.name.toLowerCase().includes(q));
    const cur = projectFolder ? folders.find(f => f.id === projectFolder) ?? null : null;
    const itemCards: string[] = [];
    if (cur) {
      for (const it of pickableFolderItems(cur)) {
        if (it.type === 'session') {
          const s = (sessions ?? []).find(x => x.slot === it.ref)!;
          if (q && !((s.toolName ?? '').toLowerCase().includes(q) || (s.label ?? '').toLowerCase().includes(q))) continue;
          itemCards.push(sessionCard(s));
        } else {
          const a = userAssets.find(x => x.id === it.ref)!;
          if (q && !String(a.meta?.name ?? '').toLowerCase().includes(q)) continue;
          itemCards.push(projectImageCard(a));
        }
      }
    }

    const parts: string[] = [];
    if (kids.length)      parts.push(`<div class="asset-picker-grid asset-picker-foldergrid">${kids.map(folderCard).join('')}</div>`);
    if (itemCards.length) parts.push(`<div class="asset-picker-grid">${itemCards.join('')}</div>`);
    projectsPane.innerHTML = crumbs + (parts.length
      ? parts.join('')
      : `<p class="asset-picker-empty">${q ? 'Nothing here matches.' : (cur ? 'This folder is empty.' : 'No folders yet.')}</p>`);
  }

  // ── Tools (configure first, then insert) ───────────────────────────────────
  function renderTools(q: string): void {
    if (!toolsPane) return;
    const list = q
      ? embedTools.filter(t => t.name.toLowerCase().includes(q)
          || (t.description ?? '').toLowerCase().includes(q) || t.id.includes(q))
      : embedTools;
    if (list.length === 0) { toolsPane.innerHTML = `<p class="asset-picker-empty">No tools match.</p>`; return; }
    toolsPane.innerHTML =
      `<div class="asset-picker-section-head">Make an image from a tool <span class="asset-picker-count">${embedTools.length}</span></div>` +
      `<div class="asset-picker-grid asset-picker-toolgrid">${list.map(toolCard).join('')}</div>`;
  }

  // Take over the body with the tool-render card / a status message (back returns
  // to the active pane). Used by the paste flow, saved-session embeds, and the
  // tools fallback when no input editor is available.
  function showTakeover(html: string): void {
    root.querySelectorAll<HTMLElement>('.asset-picker-pane').forEach(p => { p.hidden = true; });
    if (currentEl) currentEl.hidden = true;
    setFooter(false);
    toolcardHost.hidden = false;
    toolcardHost.innerHTML = html;
  }
  function dismissTakeover(): void {
    searchInput.value = '';
    setTab(activeTab);
  }

  // Build the "render this Lolly tool/session as your image" card: detected-tool
  // header, format + size controls, a live preview, and a commit button. "Use this
  // render" resolves the picker with a tool-sourced AssetRef whose id is the
  // canonical embed URL, so it persists + re-renders exactly like a library asset.
  // `editUrl` (when the host provided opts.editTool) adds an "Edit inputs…" escape
  // hatch into the full input editor.
  function showToolCard(desc: ToolUrlDescription, url: string, { editUrl }: { editUrl?: string } = {}): void {
    const allowed = formatsForType(desc.formats, opts.type);
    const fmtOptions = allowed.map(f =>
      `<option value="${escapeHtml(f)}"${f === desc.format ? ' selected' : ''}>${escapeHtml(f.toUpperCase())}</option>`
    ).join('');
    const canEdit = Boolean(editUrl && opts.editTool);
    showTakeover(`
      <div class="asset-picker-toolcard">
        <div class="asset-picker-toolcard-head">
          <button type="button" class="asset-picker-toolcard-back" aria-label="Back to list">←</button>
          <span class="asset-picker-toolcard-spark" aria-hidden="true">✦</span>
          <span>Render the <strong>${escapeHtml(desc.name)}</strong> tool as your image</span>
        </div>
        <div class="asset-picker-toolcard-controls">
          <label>Format <select class="tc-format" aria-label="Render format">${fmtOptions}</select></label>
          <label>Width <input type="number" class="tc-w" min="1" inputmode="numeric" placeholder="auto" value="${desc.width ?? ''}"></label>
          <label>Height <input type="number" class="tc-h" min="1" inputmode="numeric" placeholder="auto" value="${desc.height ?? ''}"></label>
        </div>
        <div class="asset-picker-toolcard-preview"><div class="asset-picker-loading">Rendering…</div></div>
        <label class="asset-picker-toolcard-freeze"><input type="checkbox" class="tc-freeze"> Freeze as a static image</label>
        <p class="asset-picker-toolcard-freeze-help">Won't update when the source tool changes, but doesn't count against nesting depth.</p>
        <div class="asset-picker-toolcard-actions">
          ${canEdit ? `<button type="button" class="tc-edit">Edit inputs…</button>` : ''}
          <button type="button" class="tc-use" disabled>Use this render</button>
        </div>
      </div>`);
    const cardEl    = toolcardHost.querySelector('.asset-picker-toolcard')!;
    const fmtSel    = cardEl.querySelector<HTMLSelectElement>('.tc-format')!;
    const wEl       = cardEl.querySelector<HTMLInputElement>('.tc-w')!;
    const hEl       = cardEl.querySelector<HTMLInputElement>('.tc-h')!;
    const previewEl = cardEl.querySelector<HTMLElement>('.asset-picker-toolcard-preview')!;
    const useBtn    = cardEl.querySelector<HTMLButtonElement>('.tc-use')!;
    const freezeEl  = cardEl.querySelector<HTMLInputElement>('.tc-freeze')!;

    cardEl.querySelector('.asset-picker-toolcard-back')?.addEventListener('click', dismissTakeover);
    if (canEdit) {
      cardEl.querySelector('.tc-edit')?.addEventListener('click', async () => {
        const ref = await opts.editTool!(editUrl!);
        // Through finish(), not close(): the freeze toggle applies to BOTH commit
        // paths, so an edited render still bakes when the box is ticked.
        if (ref) finish(ref);
      });
    }

    // Motion formats this card can commit (from describeUrl). A motion pick is
    // encoded as a live clip, which is SLOW (real-time frame capture), so the preview
    // always shows a cheap STILL poster and the clip is rendered only on commit.
    const motionSet = new Set((desc.motion ?? []).map(f => f.toLowerCase()));
    const isMotion = (f: string): boolean => motionSet.has(f.toLowerCase());
    const stillFmt = allowed.find(f => !isMotion(f)) ?? 'png'; // still stand-in for the poster
    const size = (): { width?: number; height?: number } => ({
      width:  parseInt(wEl.value, 10) || undefined,
      height: parseInt(hEl.value, 10) || undefined,
    });

    let posterRef: AssetRef | null = null;   // the still shown in the card (a still pick commits this as-is)
    let renderSeq = 0;      // drop a stale render when controls change again
    // A child whose preview ever took longer than this stops auto-rendering on
    // control changes — the user triggers each render instead (click-to-render),
    // so a heavy child (a 3D scene, a big PDF) can't make the card feel hung.
    const SLOW_RENDER_MS = 1000;
    let slowTool = false;
    const renderingHtml =
      `<button type="button" class="tc-render is-rendering" disabled><span class="tc-render-ring" aria-hidden="true"></span>Rendering…</button>`;
    const renderPreview = async (): Promise<void> => {
      const seq = ++renderSeq;
      posterRef = null;
      useBtn.disabled = true;
      previewEl.innerHTML = slowTool ? renderingHtml : `<div class="asset-picker-loading">Rendering…</div>`;
      // Crossing the threshold mid-render upgrades the plain loading text to the
      // animated button in place and flips the card to click-to-render from then on.
      const slowTimer = setTimeout(() => {
        if (seq !== renderSeq || slowTool) return;
        slowTool = true;
        previewEl.innerHTML = renderingHtml;
      }, SLOW_RENDER_MS);
      // The poster is always a still: the selected format when it's an image, else a
      // still stand-in for a motion pick (encoding the real clip per keystroke is too slow).
      const posterFmt = isMotion(fmtSel.value) ? stillFmt : fmtSel.value;
      const ref = await host.compose.renderUrl(url, { format: posterFmt as ExportFormat, ...size() }).catch(() => null);
      clearTimeout(slowTimer);
      if (seq !== renderSeq) return; // a newer change supersedes this render
      if (!ref) { previewEl.innerHTML = `<p class="asset-picker-error">Couldn't render this link.</p>`; return; }
      posterRef = ref;
      const note = isMotion(fmtSel.value)
        ? `<p class="asset-picker-toolcard-note" style="margin:.4rem 0 0;font-size:.8rem;opacity:.7;">▶ Placed as a moving ${escapeHtml(fmtSel.value.toUpperCase())} — the clip renders when you add it.</p>`
        : '';
      previewEl.innerHTML = `<img class="asset-picker-toolcard-img" src="${escapeHtml(ref.url)}" alt="Preview of the ${escapeHtml(desc.name)} render">${note}`;
      useBtn.disabled = false;
    };

    // Idle click-to-render state (slow tools only). Entering it also invalidates
    // any in-flight render — the controls just changed, so its poster is stale.
    const showRenderButton = (): void => {
      renderSeq++;
      posterRef = null;
      useBtn.disabled = true;
      previewEl.innerHTML = `<button type="button" class="tc-render">Render preview</button>`;
      previewEl.querySelector('.tc-render')!.addEventListener('click', () => { void renderPreview(); });
    };

    // Resolve the picker with the committed ref — frozen (baked into a static
    // data: asset that never live-re-renders and consumes no nesting depth) when
    // the toggle is on. A render the engine refuses to bake (too large / not
    // self-contained) is placed LIVE instead, with a brief inline note so the
    // fallback is visible before the picker closes.
    const finish = (ref: AssetRef): void => {
      if (!freezeEl.checked) { close(ref); return; }
      try { close(bakeAssetRef(ref)); }
      catch (e) {
        host.log?.('warn', `freeze failed (${(e as { code?: string }).code ?? (e as Error).message}) — placing live`);
        // Freeze the card while the note shows — a back/edit click here would
        // race the delayed commit below.
        cardEl.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = true; });
        previewEl.insertAdjacentHTML('beforeend',
          `<p class="asset-picker-toolcard-note" style="margin:.4rem 0 0;font-size:.8rem;opacity:.7;">Placed live — this render is too large to freeze.</p>`);
        announce('Placed live — this render is too large to freeze.');
        setTimeout(() => close(ref), 1500);
      }
    };

    // Commit: a still pick uses the already-rendered poster; a motion pick encodes the
    // real clip now (a few seconds) before resolving the picker.
    const commit = async (): Promise<void> => {
      const fmt = fmtSel.value;
      if (!isMotion(fmt)) { if (posterRef) finish(posterRef); return; }
      const label = useBtn.textContent;
      useBtn.disabled = true;
      useBtn.classList.add('is-rendering');
      useBtn.textContent = 'Rendering motion…';
      const ref = await host.compose.renderUrl(url, { format: fmt as ExportFormat, ...size() }).catch(() => null);
      useBtn.classList.remove('is-rendering');
      if (ref) { finish(ref); return; }
      useBtn.textContent = label;
      useBtn.disabled = false;
      previewEl.innerHTML = `<p class="asset-picker-error">Couldn't render the motion clip.</p>`;
    };

    let debounce: ReturnType<typeof setTimeout> | undefined;
    const onSize = (): void => {
      clearTimeout(debounce);
      if (slowTool) { showRenderButton(); return; }
      debounce = setTimeout(renderPreview, 350);
    };
    fmtSel.addEventListener('change', () => { if (slowTool) showRenderButton(); else void renderPreview(); });
    wEl.addEventListener('input', onSize);
    hEl.addEventListener('input', onSize);
    useBtn.addEventListener('click', commit);
    renderPreview();
  }

  // Open a saved single-tool session as an image: reconstruct its canonical embed
  // URL from the stored values (the same createRuntime → serializeUrlState → buildEmbedUrl
  // recipe the in-place editor uses) and hand it to the render card. Pre-configured,
  // so it goes straight to preview/size — with an Edit-inputs escape hatch.
  async function embedSession(slot: string): Promise<void> {
    const entry = (sessions ?? []).find(s => s.slot === slot);
    if (!entry) return;
    showTakeover(`<div class="asset-picker-loading">Opening “${escapeHtml(entry.toolName)}”…</div>`);
    try {
      const data = await host.state.load(slot);
      if (!data) throw new Error('empty session');
      const tool = await getTool(entry.toolId);
      const runtime = await createRuntime(tool, host, data as Record<string, InputValue>);
      const query = serializeUrlState(runtime.getModel());
      const url = buildEmbedUrl({ toolId: entry.toolId, format: imageFormatSeed(data.__export_format), query });
      const desc = url ? await host.compose._describeUrl(url) : null;
      if (!url || !desc) throw new Error('not renderable');
      showToolCard(desc, url, { editUrl: url });
    } catch (e) {
      host.log('warn', 'Embed saved session failed', { slot, error: String(e) });
      showTakeover(`<p class="asset-picker-error">Couldn't open this saved creation.</p><div class="asset-picker-toolcard-actions"><button type="button" class="tc-back">← Back</button></div>`);
      toolcardHost.querySelector('.tc-back')?.addEventListener('click', dismissTakeover);
    }
  }

  // Open a tool with default inputs. If the host gave us an input editor (top-level /
  // block asset slots do), configure it FIRST then insert; otherwise fall back to the
  // inline format/size render card on the tool's defaults.
  async function embedTool(toolId: string): Promise<void> {
    const t = toolById.get(toolId);
    const url = buildEmbedUrl({ toolId, format: 'svg', query: '' });
    if (!url) return;
    if (opts.editTool) {
      const ref = await opts.editTool(url);
      if (ref) close(ref);
      return; // cancelled → stay on the Tools tab
    }
    showTakeover(`<div class="asset-picker-loading">Opening ${escapeHtml(t?.name ?? toolId)}…</div>`);
    const desc = await host.compose._describeUrl(url).catch(() => null);
    if (desc) showToolCard(desc, url, { editUrl: url });
    else {
      showTakeover(`<p class="asset-picker-error">Couldn't open this tool.</p><div class="asset-picker-toolcard-actions"><button type="button" class="tc-back">← Back</button></div>`);
      toolcardHost.querySelector('.tc-back')?.addEventListener('click', dismissTakeover);
    }
  }

  // Load the user's saved images (filtered to the requested type) in parallel with
  // the library — they don't depend on each other.
  if (showUserAssets) {
    Promise.all([
      host.assets._listUserAssets(),
      foldersReady, // shared with the Projects tab; sets `folders`
      profileReady,
    ])
      .then(([list]) => {
        // An `image` slot accepts raster OR vector (SVG); every other type is exact.
        const typeOk = (t: string): boolean => !opts.type || t === opts.type
          || (opts.type === 'image' && (t === 'raster' || t === 'vector'));
        userAssets = list.filter(a => typeOk(a.type)).filter(a => !hiddenSet.has(assetBaseId(a.id)));
        renderUserAssets();
        renderFavourites();
        updateUploadAffordance();
        // Images just landed — refresh Projects so folder item tiles + counts fill in.
        if (activeTab === 'projects') renderProjects(searchInput.value.trim().toLowerCase());
      })
      .catch(e => host.log('warn', 'Failed to list user images', { error: String(e) }));
  }

  // The folder tree may resolve before (or without) the user-image / session lists;
  // paint the Projects tab as soon as it's ready so folders show without waiting.
  foldersReady.then(() => {
    if (activeTab === 'projects') renderProjects(searchInput.value.trim().toLowerCase());
  });

  // Load saved sessions in parallel too (only when composing is possible). Restrict
  // to single-tool sessions whose tool still ships AND can render an image.
  if (allowToolUrl) {
    host.state.list()
      .then(list => {
        sessions = (list ?? [])
          .filter(e => e.slot && !e.slot.startsWith('__batch__:')) // single-tool only (see pro/sessions.js)
          .filter(e => e.toolId && isEmbeddable(toolById.get(e.toolId), needsSvg))
          .map(e => {
            const t = toolById.get(e.toolId);
            return {
              slot: e.slot, toolId: e.toolId, label: e.label,
              toolName: t?.name ?? e.toolId, toolIcon: t?.icon ?? null,
              thumb: e.thumb ?? null, updatedAt: e.updatedAt,
            };
          })
          .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
        const q = searchInput.value.trim().toLowerCase();
        if (activeTab === 'sessions') renderSessions(q);
        else if (activeTab === 'projects') renderProjects(q); // session tiles + counts fill in
      })
      .catch(e => {
        host.log('warn', 'Failed to list saved sessions', { error: String(e) });
        sessions = [];
        if (activeTab === 'sessions') renderSessions('');
        else if (activeTab === 'projects') renderProjects(searchInput.value.trim().toLowerCase());
      });
  }

  try {
    // Only visual assets are pickable images — palette / tokens / font entries are
    // engine data (JSON), never something a user places in a slot, so keep them out
    // of the library (a `type`-scoped pick already excludes them; this covers `any`).
    // Lottie counts as visual: it thumbnails as a static poster and plays live once
    // placed. It only surfaces for untyped/`any`/`lottie` picks — an `image` slot is
    // already narrowed to raster/vector upstream by query()'s typeMatches().
    const VISUAL_TYPES = new Set(['raster', 'vector', 'video', 'lottie']);
    // opts widens AssetPickerOpts with a web-only `type: 'image'` value; query only
    // reads the catalog-facing AssetQuery fields, so narrow at the boundary.
    const queried = (await host.assets.query(opts as AssetPickerOpts)).filter(a => VISUAL_TYPES.has(a.type));
    // Drop the user's hidden assets before anything renders (profileReady populates
    // hiddenSet; it's fast and usually already resolved by the time the query lands).
    await profileReady;
    const candidates = queried.filter(a => !hiddenSet.has(assetBaseId(a.id)));
    libraryCandidates = candidates;
    candidateById = new Map(candidates.map((c): [string, AssetRef] => [c.id, c]));
    libraryLoaded = true;

    // Colour pairings for themable icons — only worth mounting when this
    // library actually contains some and the bridge can supply pairings.
    if (candidates.some(isThemableRef) && typeof host.assets._iconThemes === 'function') {
      iconThemes = await host.assets._iconThemes().catch(() => []);
      if (activeTheme && !iconThemes.some(t => t.id === activeTheme)) activeTheme = null;
      // renderLibrary renders the strip inside the Icons group when iconThemes.length > 1.
    }

    // Colour treatments for raster photos — mounted only when this library holds
    // some and the bridge can supply them (same discipline as icon themes).
    if (candidates.some(isTreatableRef) && typeof host.assets._photoTreatments === 'function') {
      photoTreatments = await host.assets._photoTreatments().catch(() => []);
      if (activeTreatment && !photoTreatments.some(t => t.id === activeTreatment)) activeTreatment = null;
    }

    renderLibrary(candidates);
    renderFavourites();

    // Land focus on an asset (the current one if provided) so the keyboard can
    // drive the picker straight away. A themed current id matches its base card.
    const libCards = [...libraryEl.querySelectorAll<HTMLElement>('[data-asset-id]')];
    (libCards.find(c => c.dataset.assetId === currentBaseId) || libCards[0])?.focus({ preventScroll: true });

    // A Lolly tool URL pasted into the search box flips the picker into a "render
    // this tool" card; anything else filters the active pane. The seq guard drops a
    // stale describeUrl (async tool load) when the user keeps typing.
    let detectSeq = 0;
    let searchDebounce: ReturnType<typeof setTimeout>;
    searchInput?.addEventListener('input', async () => {
      const raw = searchInput.value.trim();
      if (allowToolUrl && /^https?:\/\//i.test(raw)) {
        const seq = ++detectSeq;
        showTakeover(`<div class="asset-picker-loading">Checking link…</div>`);
        const desc = await host.compose._describeUrl(raw).catch(() => null);
        if (seq !== detectSeq) return; // superseded by a newer keystroke
        if (desc) showToolCard(desc, raw, { editUrl: raw });
        else showTakeover(`<p class="asset-picker-empty">That isn't a Lolly tool link this app can open.</p>`);
        return;
      }
      detectSeq++; // invalidate any in-flight detection now that it's not a URL
      const q = raw.toLowerCase();
      // Resuming typing after a paste/embed takeover returns to the active pane —
      // without stealing focus out of the search field (so don't go via setTab).
      if (!toolcardHost.hidden) {
        toolcardHost.hidden = true;
        toolcardHost.innerHTML = '';
        if (currentEl) currentEl.hidden = false;
        const pane = root.querySelector<HTMLElement>(`.asset-picker-pane[data-pane="${activeTab}"]`);
        if (pane) pane.hidden = false;
        setFooter(activeTab === 'library');
      }
      // Debounce only the filter dispatch (rebuilds the whole pane DOM) so fast typing
      // doesn't rebuild per keystroke; 120 ms matches the Catalog view. q is captured
      // at schedule time. The URL detection + pane-restore above stay immediate.
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        if (activeTab === 'library') restoreLibrary(q);
        else if (activeTab === 'sessions') renderSessions(q);
        else if (activeTab === 'projects') renderProjects(q);
        else if (activeTab === 'tools') renderTools(q);
      }, 120);
    });
  } catch (e) {
    libraryEl.innerHTML = `<p class="asset-picker-error">Failed to load: ${escapeHtml((e as Error).message)}</p>`;
  }
}


// Video containers (need a <video>) vs animated rasters (animate in an <img>). A
// motion slot offers both; a still/image slot offers animated rasters but not video.
const VIDEO_FMTS = new Set(['webm', 'mp4']);
const RASTER_MOTION_FMTS = new Set(['gif', 'apng']);

// Constrain the offered child-render formats to the slot's asset type. A 'vector'
// slot semantically wants vector (e.g. an inline-recolourable logo) → restrict to
// SVG. A motion slot ('video' / 'lottie', i.e. the free-canvas Video/Animation
// add-kinds) wants MOVEMENT → offer every motion format the tool supports. Every
// other slot accepts an SVG render fine and animated rasters (gif/apng animate in an
// <img>), but not <video>-only formats (webm/mp4 need the video slot). assetType
// constrains the LIBRARY picker, not what a tool render can produce; a constraint that
// empties falls back to the full list.
function formatsForType(formats: readonly string[], type: string | undefined): readonly string[] {
  if (type === 'vector') {
    const svgOnly = formats.filter(f => f === 'svg');
    return svgOnly.length ? svgOnly : formats;
  }
  if (type === 'video' || type === 'lottie') {
    const motion = formats.filter(f => VIDEO_FMTS.has(f) || RASTER_MOTION_FMTS.has(f));
    return motion.length ? motion : formats;
  }
  const kept = formats.filter(f => !VIDEO_FMTS.has(f));
  return kept.length ? kept : formats;
}

// Image formats a composed tool render can take (mirrors compose.js IMAGE_FORMATS).
const IMG_FORMATS = new Set(['svg', 'png', 'jpg', 'jpeg', 'webp']);

// Can this catalog tool be rendered to an embeddable image? It must be exportable and
// emit at least one image format (and SVG specifically for a vector slot). Mirrors the
// gate compose uses — described tools that only export e.g. pdf/ics are dropped, as are
// non-exportable transform utilities (strip-data, compress-pdf).
function isEmbeddable(t: PickerTool | undefined, needsSvg: boolean): boolean {
  if (!t || t.exportable !== true || !Array.isArray(t.formats)) return false;
  const fmts = t.formats.map(f => String(f).toLowerCase());
  return needsSvg ? fmts.includes('svg') : fmts.some(f => IMG_FORMATS.has(f));
}

// A saved session records its last export format; seed the render card with it only
// when it's an image format (else let describeUrl choose, defaulting to SVG).
function imageFormatSeed(fmt: unknown): string | undefined {
  const f = String(fmt ?? '').toLowerCase();
  return IMG_FORMATS.has(f) ? (f === 'jpeg' ? 'jpg' : f) : undefined;
}

// Compact relative time for a saved session ("3d ago"). Browser-only (Date.now).
function relTime(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24; if (d < 7)  return `${Math.floor(d)}d ago`;
  const w = d / 7;  if (w < 5)  return `${Math.floor(w)}w ago`;
  const mo = d / 30; if (mo < 12) return `${Math.floor(mo)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// A muted, looping, autoplaying <video> thumbnail. muted + playsinline are
// mandatory for the browser to allow autoplay; preload="metadata" keeps a grid of
// them light. Class-scoped CSS (.asset-picker-thumb / .cat-thumb) sizes <video>
// the same as <img>, so no per-element rule is needed.
function videoThumb(url: string, className: string): string {
  return `<video class="${className}" src="${escapeHtml(url)}" muted loop autoplay playsinline preload="metadata"></video>`;
}

// A looping Lottie thumbnail: an on-screen-gated player (autoplayLottieThumbs, wired by the
// picker) mounts over the still poster while the tile is on screen — the poster background, or
// a ▶ for a posterless user upload, is the resting frame. Returns null when no json url is
// resolvable, so the caller keeps its own stub. A library lottie's url is the poster and the
// json lives on meta.animationUrl; a user upload's url IS the json.
function lottieThumb(ref: AssetRef, className: string): string | null {
  const json = ref.source === 'user' ? ref.url : (typeof ref.meta?.animationUrl === 'string' ? ref.meta.animationUrl : '');
  if (!json) return null;
  const poster = ref.source !== 'user' && typeof ref.meta?.posterUrl === 'string' ? ref.meta.posterUrl : '';
  const style = poster ? ` style="background-image:url('${escapeHtml(poster)}')"` : '';
  return `<span class="${className} asset-picker-thumb-motion" data-lottie-src="${escapeHtml(json)}" data-lottie-fit="contain"${style} aria-hidden="true">${poster ? '' : '▶'}</span>`;
}

function card(ref: AssetRef): string {
  const isPlaceholder = ref.meta?._placeholder;
  const name = ref.meta?.name ?? ref.id;
  // A user-uploaded lottie's url is JSON (no still poster), so an <img> would 404 — show
  // a play glyph, matching userCard. (Catalog lotties resolve to a poster url upstream.)
  // A video plays itself in a muted looping <video>; everything else is an <img>
  // (gif/apng/animated-webp animate natively there).
  const thumb = isPlaceholder
    ? `<div class="asset-picker-thumb asset-picker-thumb-stub">${escapeHtml(ref.type)}</div>`
    : ref.type === 'lottie'
      ? (lottieThumb(ref, 'asset-picker-thumb') ?? `<span class="asset-picker-thumb asset-picker-thumb-stub" aria-hidden="true">▶</span>`)
      : ref.type === 'video'
        ? videoThumb(ref.url, 'asset-picker-thumb')
        : `<img class="asset-picker-thumb" src="${escapeHtml(ref.url)}" alt="" loading="lazy" decoding="async">`;
  return `
    <button type="button" class="asset-picker-card" data-asset-id="${escapeHtml(ref.id)}">
      ${thumb}
      <span class="asset-picker-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="asset-picker-id">${escapeHtml(ref.id)}</span>
      ${formatBadge(ref)}
    </button>
  `;
}

// A tool the user can render to an image. Preview-forward like the gallery: show the
// tool's rendered preview thumbnail, falling back to its inline icon. The `preview` is
// a build artifact (catalog/previews/ — committed, but absent on a fresh checkout or
// after index drift) that can still 404 — so the icon is always rendered too, revealed
// by a capture-phase error handler (see render). The index ships the icon as trusted
// inline SVG (built from tools/<id>/icon.svg) — inlined so it themes via currentColor.
function toolCard(t: PickerTool): string {
  const hasPreview = Boolean(t.preview);
  // The preview slot is a fixed 84px-tall box (picker.css). A card.html banner renders in
  // a sandboxed iframe fitted to that height at the tool's aspect (so a square ad isn't
  // stretched to the tile width); svg/png stay <img> with the slot's object-fit.
  // Keep the slot's fixed 84px height (from the class) and derive width from the tool's
  // aspect, so an animated banner tile is the same height as its <img> neighbours.
  const iframeSize = (t.width && t.height)
    ? `aspect-ratio:${t.width} / ${t.height};width:auto;margin-inline:auto`
    : 'width:100%;height:100%';
  return `
    <button type="button" class="asset-picker-card asset-picker-toolitem${hasPreview ? '' : ' no-preview'}" data-tool-id="${escapeHtml(t.id)}" title="${escapeHtml(t.description ?? t.name)}">
      ${hasPreview ? previewMedia(t.preview!, 'asset-picker-toolitem-preview', iframeSize) : ''}
      <span class="asset-picker-toolitem-icon" aria-hidden="true">${t.icon ?? ''}</span>
      <span class="asset-picker-name">${escapeHtml(t.name)}</span>
    </button>
  `;
}

// A previous saved creation. Its thumbnail is a PNG data-URL (raster tools) or raw SVG
// markup (vector tools); SVG is rendered via a data-URL <img> so any embedded script in
// an imported session can't execute. No thumb → the tool's icon as a stub.
function sessionCard(s: PickerSession): string {
  const name = s.toolName ?? s.toolId;
  return `
    <button type="button" class="asset-picker-card asset-picker-sessitem" data-session-slot="${escapeHtml(s.slot)}" title="${escapeHtml(name)}">
      ${sessionThumb(s.thumb, s.toolIcon)}
      <span class="asset-picker-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="asset-picker-sessitem-when">${escapeHtml(relTime(s.updatedAt))}</span>
    </button>
  `;
}

// One encoding for every SVG-text-as-<img> use (session thumbs, themed icon
// thumbnails) so quirks fixes land in one place.
function svgDataUrl(svgText: string): string {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svgText);
}

function sessionThumb(thumb: string | null, iconSvg: string | null): string {
  if (typeof thumb === 'string' && thumb) {
    if (thumb.startsWith('data:')) {
      return `<img class="asset-picker-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">`;
    }
    if (/^\s*<(\?xml|svg)/i.test(thumb)) {
      return `<img class="asset-picker-thumb" src="${escapeHtml(svgDataUrl(thumb))}" alt="" loading="lazy" decoding="async">`;
    }
  }
  return `<span class="asset-picker-thumb asset-picker-thumb-stub asset-picker-thumb-icon" aria-hidden="true">${iconSvg ?? ''}</span>`;
}

function formatBadge(ref: AssetRef): string {
  // Generative-AI provenance badge — a sparkle-circle top-left (the format badge owns
  // bottom-right). Authored on catalog entries; auto-detected on uploads via C2PA.
  const ai = assetAiKind(ref);
  const aiBadge = ai ? genAiPill(ai, true) : '';
  // A lottie card thumbnails as its static poster — badge the motion, not the
  // misleading underlying file format.
  if (ref.type === 'lottie') return `<span class="asset-picker-fmt">▶ LOTTIE</span>${aiBadge}`;
  // Video and animated rasters (gif/apng/animated-webp) get a play glyph so their
  // motion reads at a glance (a still preview frame can look identical to a photo).
  if (ref.type === 'video') return `<span class="asset-picker-fmt">▶ ${escapeHtml(String(ref.format ?? 'video').toUpperCase())}</span>${aiBadge}`;
  if (ref.meta?.animated && ref.format) return `<span class="asset-picker-fmt">▶ ${escapeHtml(String(ref.format).toUpperCase())}</span>${aiBadge}`;
  return (ref.format ? `<span class="asset-picker-fmt">${escapeHtml(String(ref.format).toUpperCase())}</span>` : '') + aiBadge;
}

// A user image: a pick button plus a delete affordance (siblings, not nested —
// nested buttons are invalid HTML and break the delegated click handler).
function userCard(ref: AssetRef): string {
  const name = ref.meta?.name ?? 'Image';
  // A user-uploaded lottie's url is the JSON itself, so it plays as a looping motion marker
  // (autoplayLottieThumbs mounts it on screen); the ▶ stub is only the pre-mount resting frame.
  const thumb = ref.type === 'lottie'
    ? (lottieThumb(ref, 'asset-picker-thumb') ?? `<span class="asset-picker-thumb asset-picker-thumb-stub" aria-hidden="true">▶</span>`)
    : ref.type === 'video'
      ? videoThumb(ref.url, 'asset-picker-thumb')
      : `<img class="asset-picker-thumb" src="${escapeHtml(ref.url)}" alt="" loading="lazy" decoding="async">`;
  return `
    <div class="asset-picker-card asset-picker-card-user">
      <button type="button" class="asset-picker-card-pick" data-asset-id="${escapeHtml(ref.id)}">
        ${thumb}
        <span class="asset-picker-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      </button>
      <button type="button" class="asset-picker-card-delete" data-delete-id="${escapeHtml(ref.id)}" title="Delete" aria-label="Delete ${escapeHtml(name)}">×</button>
      ${formatBadge(ref)}
    </div>
  `;
}

// Strip anything executable or external from an uploaded SVG before we persist
// it. DOMPurify's SVG profile removes <script>, on*= handlers, <foreignObject>
// scripts and external entity/resource refs while keeping the drawable markup.
// The result (even if empty for a non-SVG masquerading as one) is what we store,
// so script bytes never reach disk; we only keep the original as a last resort
// if DOMPurify itself is unavailable (it isn't in a browser).
/**
 * Make an uploaded SVG scale by its `viewBox`: strip the root `width`/`height` so it renders
 * at the display size (crisp at any zoom, in any container) instead of pinning a fixed
 * intrinsic size — an icon authored at `width="10.58"` was otherwise a ~11px bitmap that any
 * larger render just magnified. If there's no `viewBox` but numeric dimensions exist, we
 * synthesise one first so the art is never left sizeless (which collapses to the 300×150
 * default). An SVG with neither a viewBox nor derivable dimensions is returned untouched.
 * Returns the (best-effort) intrinsic aspect for the stored record's metadata.
 */
function normalizeSvg(svgText: string): { svg: string; width?: number; height?: number } {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return { svg: svgText };
    // Plain number, optionally with an absolute unit — rejects `%`, `calc()`, `em`, etc.
    const num = (v: string | null): number | null => {
      const m = v && /^\s*(-?[\d.]+)\s*(px|pt|pc|mm|cm|in|q)?\s*$/i.exec(v);
      return m ? parseFloat(m[1]!) : null;
    };
    let w = num(svg.getAttribute('width'));
    let h = num(svg.getAttribute('height'));
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const hasViewBox = vb.length === 4 && vb.every((n) => Number.isFinite(n));
    if (!hasViewBox) {
      if (w && h && w > 0 && h > 0) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      else return { svg: svgText, width: w ?? undefined, height: h ?? undefined }; // can't make it scalable safely
    }
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    if (!(w && h) && hasViewBox) { w = vb[2]!; h = vb[3]!; } // fall back to the viewBox extent for metadata
    return { svg: new XMLSerializer().serializeToString(svg), width: w ?? undefined, height: h ?? undefined };
  } catch {
    return { svg: svgText };
  }
}

async function sanitizeSvgFile(file: Blob): Promise<{ blob: Blob; width?: number; height?: number }> {
  try {
    const clean = DOMPurify.sanitize(await file.text(), {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
    const { svg, width, height } = normalizeSvg(clean);
    return { blob: new Blob([svg], { type: 'image/svg+xml' }), width, height };
  } catch {
    return { blob: file };
  }
}

/**
 * Webcam capture → Promise<AssetRef | null>.
 *
 * A live <video> preview of the user's camera with a Capture button; the captured
 * frame becomes a raster user asset via the SAME storeUserUpload path as an upload
 * (downscale + on-device store), so the rest of the app treats it identically. This
 * is a pure shell affordance — no engine/bridge/runtime involvement — which is why
 * "webcam as a still image" needs no architectural change. The camera stream is torn
 * down on every exit path (capture, cancel, Escape, backdrop, error) so no track
 * outlives the dialog. Pixels never leave the device.
 */
function openWebcamCapture(host: PickerHost): Promise<AssetRef | null> {
  return new Promise((resolve) => {
    let stream: MediaStream | null = null;
    let trap: FocusTrap | undefined;
    const overlay = document.createElement('div');
    overlay.className = 'webcam-capture-overlay';
    overlay.innerHTML = `
      <div class="webcam-capture-backdrop" aria-hidden="true"></div>
      <div class="webcam-capture-panel" role="dialog" aria-modal="true" aria-label="Take a photo">
        <header class="webcam-capture-head">
          <span>Take a photo</span>
          <button type="button" class="webcam-capture-close" aria-label="Close">&times;</button>
        </header>
        <div class="webcam-capture-stage">
          <video class="webcam-capture-video" autoplay playsinline muted></video>
          <div class="webcam-capture-status">Starting camera…</div>
        </div>
        <footer class="webcam-capture-actions">
          <button type="button" class="webcam-capture-cancel">Cancel</button>
          <button type="button" class="webcam-capture-shoot" disabled>Capture</button>
        </footer>
      </div>`;
    document.body.appendChild(overlay);

    const videoEl  = overlay.querySelector<HTMLVideoElement>('.webcam-capture-video')!;
    const statusEl = overlay.querySelector<HTMLElement>('.webcam-capture-status')!;
    const shootBtn = overlay.querySelector<HTMLButtonElement>('.webcam-capture-shoot')!;
    const opener   = document.activeElement;

    const cleanup = (): void => {
      trap?.release();
      if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch { /* already stopped */ } });
      stream = null;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (opener instanceof HTMLElement) opener.focus();
    };
    const done = (val: AssetRef | null): void => { cleanup(); resolve(val); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.webcam-capture-backdrop')?.addEventListener('click', () => done(null));
    overlay.querySelector('.webcam-capture-close')?.addEventListener('click', () => done(null));
    overlay.querySelector('.webcam-capture-cancel')?.addEventListener('click', () => done(null));
    // Contain focus over the (already-modal) picker; Escape is handled above. Nested
    // traps stack — this inerts the picker beneath while the camera sheet is open.
    trap = trapFocus(overlay, { initialFocus: overlay.querySelector<HTMLElement>('.webcam-capture-cancel') });

    const showError = (msg: string): void => {
      statusEl.hidden = false;
      statusEl.textContent = msg;
      statusEl.classList.add('webcam-capture-error');
    };

    shootBtn.addEventListener('click', async () => {
      const w = videoEl.videoWidth, h = videoEl.videoHeight;
      if (!w || !h) return;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d')!.drawImage(videoEl, 0, 0, w, h);
      const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
      if (!blob) { showError('Couldn’t capture the frame.'); return; }
      const file = new File([blob], `webcam-${Date.now()}.png`, { type: 'image/png' });
      try {
        const ref = await storeUserUpload(host, file);
        done(ref);
      } catch (e) {
        host.log?.('error', 'Webcam capture store failed', { error: String(e) });
        showError('Couldn’t save the photo.');
      }
    });

    // Kick off the camera; leave the dialog open on failure showing why.
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        videoEl.srcObject = stream;
        await videoEl.play().catch(() => {});
        statusEl.hidden = true;
        shootBtn.disabled = false;
        shootBtn.focus();
      } catch (e) {
        host.log?.('warn', 'Webcam start failed', { error: String(e) });
        showError((e as Error | null)?.name === 'NotAllowedError'
          ? 'Camera permission was declined. Allow camera access, then try again.'
          : 'Couldn’t start the camera on this device.');
      }
    })();
  });
}

// A .lottie is a ZIP (dotLottie): manifest.json + animations/<id>.json (+ optional
// images/). lottie-web only understands raw Bodymovin JSON, so unzip, pull the first
// animation out, and inline any zip-embedded images as data URIs so the stored JSON is
// self-contained. fflate (the shell's zip lib) is dynamic-imported — only paid for when
// someone actually uploads a .lottie. Returns the animation JSON as text.
async function dotLottieToJson(file: File): Promise<string> {
  const { unzipSync, strFromU8 } = await import('fflate');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error('That .lottie file couldn’t be opened (not a valid dotLottie archive).');
  }
  const names = Object.keys(entries);
  let animPath: string | undefined;
  if (entries['manifest.json']) {
    try {
      const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as { animations?: Array<{ id?: string }> };
      const id = manifest.animations?.[0]?.id;
      if (id) animPath = names.find(n => n === `animations/${id}.json`) ?? names.find(n => n.endsWith(`/${id}.json`));
    } catch { /* fall through to a filename scan */ }
  }
  animPath ??= names.find(n => /^animations\/.+\.json$/i.test(n)) ?? names.find(n => /\.json$/i.test(n) && n !== 'manifest.json');
  if (!animPath) throw new Error('That .lottie file has no animation inside.');
  const data = JSON.parse(strFromU8(entries[animPath]!)) as { assets?: Array<Record<string, unknown>> };
  // Inline embedded images (assets with e:0 that reference a file inside the zip) so
  // the animation renders once stored — otherwise those image refs would 404.
  if (Array.isArray(data.assets)) {
    for (const a of data.assets) {
      if (!a || typeof a.p !== 'string' || a.e === 1) continue;
      const dir = typeof a.u === 'string' ? a.u.replace(/^\//, '') : '';
      const bytes = entries[dir + a.p] ?? entries['images/' + a.p] ?? entries[a.p];
      if (!bytes) continue;
      const ext = a.p.toLowerCase();
      const mime = ext.endsWith('.png') ? 'image/png'
        : ext.endsWith('.svg') ? 'image/svg+xml'
        : /\.jpe?g$/.test(ext) ? 'image/jpeg'
        : ext.endsWith('.webp') ? 'image/webp'
        : ext.endsWith('.gif') ? 'image/gif' : 'application/octet-stream';
      a.u = '';
      a.p = `data:${mime};base64,${u8ToBase64(bytes)}`;
      a.e = 1;
    }
  }
  return JSON.stringify(data);
}

// Base64 a byte array in chunks — String.fromCharCode(...bigArray) overflows the call
// stack on large images, so feed it fixed-size slices.
function u8ToBase64(u8: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  return btoa(bin);
}

// Verbatim uploads — animated rasters (gif/apng/animated-webp) and video — bypass
// downscaleRaster's implicit shrink (re-encoding would flatten the animation), so
// they need an EXPLICIT byte ceiling here or one large clip/gif could blow the
// IndexedDB quota. "Very small video" by design; a friendly error asks the user to
// trim/compress rather than letting the store throw QuotaExceededError mid-write.
const MAX_VIDEO_BYTES = 15 * 1024 * 1024;         // 15 MB
const MAX_ANIMATED_RASTER_BYTES = 20 * 1024 * 1024; // 20 MB
// Audio is stored verbatim too (no re-encode), so it needs its own ceiling. A little
// roomier than video — a few minutes of compressed music (opus/mp3/m4a) sits well
// under this; an uncompressed wav/flac can blow past it, and the friendly error asks
// the user to compress rather than the store throwing QuotaExceededError mid-write.
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;         // 30 MB
// Credential preservation reads the ORIGINAL bytes whole (the only branch that
// does — rasters otherwise stream through createImageBitmap without a JS-heap
// copy). Skip the scan for outsized originals rather than buffer them: a real
// credentialed asset is nowhere near this, and preservation is best-effort.
const MAX_CREDENTIAL_SCAN_BYTES = 64 * 1024 * 1024; // 64 MB
// Only a genuinely HUGE raster — a heavy file, or well past 2× the resize target on its
// longest edge — prompts the keep/resize decision. A merely-large "good size" image is
// stored verbatim without asking (see storeUserUpload's raster branch).
const HUGE_UPLOAD_BYTES = 40 * 1024 * 1024;         // 40 MB

function assertVerbatimSize(file: File, max: number, kind: string): void {
  if (file.size > max) {
    throw Object.assign(
      new Error(`This ${kind} is ${(file.size / 1e6).toFixed(1)} MB — over the ${Math.round(max / 1e6)} MB limit. Trim or compress it and try again.`),
      { code: 'FILE_TOO_LARGE' },
    );
  }
}

// The stored format string for a video, robust to a blank/wrong OS-supplied MIME.
function videoFormatOf(file: File): string {
  const t = file.type.toLowerCase(), n = file.name.toLowerCase();
  if (/webm/.test(t) || n.endsWith('.webm')) return 'webm';
  if (/quicktime/.test(t) || n.endsWith('.mov')) return 'mov';
  if (/mp4|m4v/.test(t) || /\.(mp4|m4v)$/.test(n)) return 'mp4';
  const ext = extFromMime(file.type);
  return ext === 'bin' ? 'mp4' : ext;
}

// The stored format string for an audio track. Prefer the extension (the OS-supplied
// MIME for audio is often blank or generic), falling back to a MIME sniff. .oga → ogg.
function audioFormatOf(file: File): string {
  const n = file.name.toLowerCase(), t = file.type.toLowerCase();
  const m = n.match(/\.(mp3|wav|ogg|oga|opus|m4a|aac|flac)$/);
  if (m) return m[1] === 'oga' ? 'ogg' : m[1]!;
  if (/mpeg|mp3/.test(t)) return 'mp3';
  if (/wav/.test(t)) return 'wav';
  if (/opus/.test(t)) return 'opus';
  if (/ogg/.test(t)) return 'ogg';
  if (/aac/.test(t)) return 'aac';
  if (/flac/.test(t)) return 'flac';
  if (/mp4|m4a/.test(t)) return 'm4a';
  const ext = extFromMime(file.type);
  return ext && ext !== 'bin' ? ext : 'mp3';
}

export async function storeUserUpload(host: PickerHost, file: File): Promise<AssetRef> {
  // Read the file as a blob, stash it in the user-assets IDB store, return
  // a `user/...` AssetRef. The bridge's assets.get() resolves these via the
  // same lookup path as library assets — uniform from the tool's POV.
  const id = `user/upload/${Date.now()}-${file.name.replace(/[^a-z0-9.-]/gi, '_')}`;
  // A Lottie is JSON, not an image — accepted for motion, stored verbatim (no
  // raster resize, which would choke on non-image bytes). Both the raw Bodymovin
  // JSON and dotLottie (.lottie, a zip) land here; the latter is unwrapped to JSON.
  const isDotLottie = /\.lottie$/i.test(file.name);
  const isLottie = isDotLottie || /\.json$/i.test(file.name) || file.type.includes('json');
  // Detect SVG by extension too, not just MIME: a dragged-in .svg (or one the OS gives a
  // blank/wrong type) would otherwise fall through to the raster path and get rasterized
  // into a tiny bitmap. As a vector it's sanitised + normalised to a viewBox-only SVG that
  // scales crisply everywhere (sanitizeSvgFile below).
  const isVector = !isLottie && (file.type.includes('svg') || /\.svg$/i.test(file.name));
  // A short video (webm/mp4/mov) — kept for motion. Stored verbatim (no raster
  // re-encode, which can't handle a video container at all). `let` because the byte
  // backstop below can promote a mislabelled clip to video.
  let isVideo = !isLottie && !isVector && (/^video\//i.test(file.type) || /\.(mp4|m4v|mov|webm)$/i.test(file.name));
  // Music the browser can't decode from an <audio> element, handled before the
  // verbatim-audio test below. MIDI is CONVERTED on the way in: a Standard MIDI File
  // becomes a tiny ZzFXM song (engine midiToZzfxm) stored as a format:'zzfxm' asset —
  // the same synthesised-on-device path as the catalog's generated tracks, so it
  // plays and previews everywhere. A .mid commonly arrives as audio/midi, which would
  // otherwise pass the generic audio test, so it's detected first (ext, MIME, or the
  // 'MThd' header magic) and excluded from isAudio.
  const head4 = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isMidi = !isLottie && !isVector && !isVideo
    && (/\.midi?$/i.test(file.name) || /^audio\/(x-)?midi?$/i.test(file.type)
        || (head4[0] === 0x4d && head4[1] === 0x54 && head4[2] === 0x68 && head4[3] === 0x64)); // 'MThd'
  // Tracker modules (.mod/.xm/.it/.s3m) are sample-based — ZzFXM can't represent them
  // and no browser <audio> plays them — so reject with a clear, user-ready message
  // (the .code makes the caller surface it verbatim) instead of storing dead bytes
  // that get mislabelled and fail to preview.
  if (/\.(mod|xm|it|s3m|stm|mtm)$/i.test(file.name) || /audio\/(x-)?(mod|it|s3m|xm)/i.test(file.type)) {
    const e: Error & { code?: string } = new Error('Tracker modules (.mod, .xm, .it, .s3m) aren’t playable in the browser yet — export the track to MP3, Opus or WAV, or upload a MIDI file instead.');
    e.code = 'unsupported-format';
    throw e;
  }
  // The user's own music (opus/mp3/wav/ogg/m4a/aac/flac) — stored verbatim as a
  // type:'audio' asset (a canvas re-encode can't touch audio bytes). Detected by
  // MIME or extension; .oga/.ogg both map to ogg. Checked after video so a container
  // MIME collision (audio/mp4 vs video/mp4) can't misroute — .m4a carries audio/mp4
  // but its extension isn't a video one, so the isVideo test above already excluded it.
  const isAudio = !isLottie && !isVector && !isVideo && !isMidi
    && (/^audio\//i.test(file.type) || /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac)$/i.test(file.name));

  // Classify animated rasters (gif/apng/animated-webp) and catch mislabelled video —
  // both from the HEADER BYTES, since an animated raster shares its MIME with the
  // still form and an OS can hand over a blank/wrong type or extension. The magic
  // bytes are the source of truth (that is the whole reason to byte-sniff); MIME/name
  // only widen which files we bother to read. (Audio is verbatim — nothing to sniff.)
  let animatedKind: 'gif' | 'apng' | 'webp' | null = null;
  if (!isLottie && !isVector && !isAudio && !isMidi) {
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    // Byte-level video backstop: a real mp4/webm handed over with a wrong extension
    // AND a blank/non-video MIME would otherwise fall to downscaleRaster and be
    // rejected as an unreadable image. Its container magic (ftyp / EBML) is at the head.
    if (!isVideo && sniffVideoContainer(head)) isVideo = true;
    if (!isVideo) {
      const magicGif  = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46;                       // "GIF"
      const magicPng  = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;   // PNG
      const magicWebp = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;   // "RIFF" (WebP)
      const animatable = magicGif || magicPng || magicWebp
        || /gif|png|webp/i.test(file.type) || /\.(gif|png|apng|webp)$/i.test(file.name);
      if (animatable) {
        // Read up to the verbatim cap: a GIF's 2nd frame or an APNG's acTL can sit far
        // past a short peek (behind a large first frame or an ICC/metadata chunk), and a
        // short read would misclassify it as still and flatten it. Files above the cap
        // are rejected by assertVerbatimSize anyway, so they can't be stored verbatim.
        const len = Math.min(file.size, MAX_ANIMATED_RASTER_BYTES);
        const bytes = len <= head.length ? head : new Uint8Array(await file.slice(0, len).arrayBuffer());
        animatedKind = sniffAnimatedRaster(bytes, { mime: file.type, name: file.name });
      }
    }
  }

  let blob: Blob = file;
  let format = extFromMime(file.type);
  let width: number | undefined, height: number | undefined;
  let animated = false;

  if (isLottie) {
    const text = isDotLottie ? await dotLottieToJson(file) : await file.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('That file isn’t valid JSON, so it can’t be a Lottie animation.');
    }
    // A Lottie/Bodymovin document has a `layers` array, or the version + timing
    // fields (`v` plus `op`/`fr`). Guard so a random .json can't masquerade as one.
    const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const looksLottie = !!data && (Array.isArray(data.layers) || ('v' in data && ('op' in data || 'fr' in data)));
    if (!looksLottie) throw new Error('That JSON doesn’t look like a Lottie animation.');
    blob = new Blob([text], { type: 'application/json' });
    format = 'json';
    if (typeof data!.w === 'number') width = data!.w;
    if (typeof data!.h === 'number') height = data!.h;
  } else if (isVector) {
    // Vectors are resolution-independent — no raster resize. But an uploaded SVG
    // can carry <script>, on*= handlers or external refs, so sanitize on ingest
    // (belt-and-suspenders — assets render via <img>/object-URL, where scripts
    // are already inert). sanitizeSvgFile also normalises to a viewBox-only SVG so
    // it scales crisply everywhere, and hands back the intrinsic aspect for metadata.
    const cleaned = await sanitizeSvgFile(file);
    blob = cleaned.blob;
    ({ width, height } = cleaned);
    // Fallback for an SVG with no viewBox/dimensions to derive from (left un-normalised).
    if (width == null || height == null) {
      ({ width, height } = await readDimensions(blob).catch(() => ({}) as { width?: number; height?: number }));
    }
  } else if (isVideo) {
    // Verbatim: keep the original container bytes (a canvas re-encode can't carry
    // video). Bounded by an explicit cap since downscaleRaster's implicit shrink is
    // skipped. Dimensions come from a <video>, not <img> (naturalWidth is 0 for video).
    assertVerbatimSize(file, MAX_VIDEO_BYTES, 'video');
    format = videoFormatOf(file);
    ({ width, height } = await readVideoDimensions(file));
  } else if (isMidi) {
    // Convert the SMF to a ZzFXM song on device and store the JSON (a few KB) as a
    // format:'zzfxm' audio asset — the browser can't play raw MIDI, but it renders
    // ZzFXM to PCM (zzfxm.ts) for the player and the catalog preview. A file with no
    // notes / an unsupported time division throws with a user-ready message.
    assertVerbatimSize(file, MAX_AUDIO_BYTES, 'MIDI file');
    try {
      const song = midiToZzfxm(new Uint8Array(await file.arrayBuffer()), { name: file.name.replace(/\.midi?$/i, '') });
      blob = new Blob([JSON.stringify(song)], { type: 'application/json' });
    } catch {
      const e: Error & { code?: string } = new Error('Couldn’t read that MIDI file — it may be empty, corrupt, or use an unsupported format.');
      e.code = 'unsupported-format';
      throw e;
    }
    format = 'zzfxm';
  } else if (isAudio) {
    // Verbatim: keep the original encoded bytes (there is no raster/canvas path for
    // audio). Bounded by an explicit cap since downscaleRaster's implicit shrink is
    // skipped. No dimensions — audio has none.
    assertVerbatimSize(file, MAX_AUDIO_BYTES, 'audio track');
    format = audioFormatOf(file);
  } else if (animatedKind) {
    // Verbatim: re-encoding an animated gif/apng/webp through a canvas flattens it
    // to a single frame, so store the original bytes. It stays type:'raster' — it
    // animates natively in <img> and can fill any image slot — but is marked
    // `animated` so the UI badges the motion (and export knows it flattens to a still).
    assertVerbatimSize(file, MAX_ANIMATED_RASTER_BYTES, 'animation');
    animated = true;
    format = animatedKind;
    ({ width, height } = await readDimensions(file).catch(() => ({}) as { width?: number; height?: number }));
  } else {
    // Raster. A good-size image is stored VERBATIM (a silent re-encode would break a C2PA hard
    // binding, so a credentialed AI render / signed photo always keeps its bytes; other images
    // keep theirs too). The "strip metadata on upload" flag (default OFF) governs OTHER metadata:
    // ON → scrub EXIF/XMP/GPS (in place for png/jpeg, preserving any C2PA store; via re-encode
    // for other formats). OFF → keep the bytes exactly. ONLY when an image is genuinely HUGE do
    // we prompt + advise (Keep original / Resize) — giving the user the choice rather than
    // silently shrinking; resizing a credentialed original re-signs it as a c2pa.resized
    // derivative so its provenance still validates to its best extent.
    const raw = new Uint8Array(await file.arrayBuffer());
    // Scan for a credential structurally (no size cap — a large signed image can still
    // preserve its chain on resize; `raw` is already read, so this parse is ~free).
    const ex = extractC2paStore(raw);
    // Opt-in privacy flag (default OFF — we keep uploads as they arrive unless asked).
    const stripMeta = isFlagOn(await host.profile.get(), STRIP_UPLOAD_META_FLAG);
    if (ex) format = ex.format;
    const dims = await readDimensions(file).catch(() => ({}) as { width?: number; height?: number });
    const longest = Math.max(dims.width ?? 0, dims.height ?? 0);
    const isHuge = file.size > HUGE_UPLOAD_BYTES || longest > MAX_LONGEST_EDGE * 2;
    // Keep the exact bytes — but honour the privacy flag: strip-on png/jpeg drops EXIF/XMP/GPS
    // IN PLACE (no quality loss, C2PA store preserved so a credential still verifies).
    const keepBytes = (): void => {
      const out = stripMeta && (format === 'png' || format === 'jpeg') ? stripMetadata(raw, format) : raw;
      blob = new Blob([out as BlobPart], { type: file.type || undefined });
      width = dims.width; height = dims.height;
    };
    // Downscale + re-encode to WebP (the space-saver; also the only way to scrub metadata from a
    // format stripMetadata can't touch). Re-signs a CREDENTIALED original as a c2pa.resized
    // derivative — the original rides in as a preserved ingredient — so a good credential still
    // validates to its best extent instead of just breaking.
    const reencode = async (): Promise<void> => {
      const resized = await downscaleRaster(file);
      ({ format, width, height } = resized);
      blob = resized.blob;
      if (ex) {
        try {
          const { stampDerivedC2pa } = await import('../bridge/export.ts');
          const ingredient = prepareC2paIngredientFromStore(ex.store, ex.format);
          blob = await stampDerivedC2pa(host, resized.blob, format, {
            title: file.name,
            tool: 'Upload',
            actions: [{ action: 'c2pa.resized', description: `Resized to ${width}×${height}px (from ${dims.width ?? '?'}×${dims.height ?? '?'}px) when added to your library` }],
            ...(ingredient ? { ingredients: [ingredient] } : {}),
            dimensions: `${width}×${height}`,
          });
        } catch { /* re-sign failed — ship the resized bytes; the record still preserves the original credential below */ }
      }
    };
    const canStripInPlace = format === 'png' || format === 'jpeg';
    if (ex && file.size <= MAX_CREDENTIAL_SCAN_BYTES) {
      // Credentialed AND it fits → ALWAYS verbatim; the C2PA hard binding stays intact + validates.
      keepBytes();
    } else if (stripMeta && !canStripInPlace) {
      // Privacy strip is ON but this format can't be scrubbed in place → re-encode (the
      // only way to drop its metadata). Checked BEFORE the size prompt: "Keep original"
      // there must never silently override an explicit strip-metadata opt-in.
      await reencode();
    } else if (isHuge) {
      // Genuinely huge → let the USER decide (the size warning + a bypass) rather than silently
      // shrinking. Escape/Cancel keeps the original (non-destructive). "Keep original" stores it
      // verbatim (device quota still applies); "Resize" re-encodes (re-signing a credentialed
      // original as a c2pa.resized derivative).
      const r = computeResize(dims.width ?? 0, dims.height ?? 0);
      const picked = await choiceDialog({
        title: 'Very large image',
        message: `“${file.name}” is ${fmtBytes(file.size)}${longest ? ` (${dims.width}×${dims.height}px)` : ''}. Keep the original — best for a Content Credential — or resize it${r.width ? ` to ${r.width}×${r.height}px` : ''} to save space?`,
        choices: [{ id: 'resize', label: 'Resize' }, { id: 'keep', label: 'Keep original', primary: true }],
      });
      if (picked === 'resize') await reencode();
      else keepBytes();
    } else {
      // Good size → keep the exact bytes. keepBytes() still scrubs EXIF/XMP/GPS in place for
      // png/jpeg when the privacy flag is on (no quality loss, C2PA store preserved).
      keepBytes();
    }
  }

  // Content Credentials for the STORED bytes — the raw C2PA manifest store only (no
  // pixels/EXIF), so `host.assets.credential(id)` can serve it as an export ingredient.
  // Prefer the stored blob's own credential: a verbatim/stripped copy keeps the original's
  // (the binding survives), and a resized upload was re-signed as a derivative that embeds a
  // fresh one. Fall back to the ORIGINAL file when a plain re-encode dropped it — SVG
  // sanitisation strips the in-file manifest, so the record still carries the original's
  // chain. Lottie/audio/MIDI carry nothing to scan. Best-effort — absent = nothing to preserve.
  let credential: Uint8Array | undefined, credentialFormat: string | undefined;
  if (!isLottie && !isAudio && !isMidi) {
    try {
      const fromBlob = blob.size <= MAX_CREDENTIAL_SCAN_BYTES ? extractC2paStore(new Uint8Array(await blob.arrayBuffer())) : null;
      const src = fromBlob ?? (file.size <= MAX_CREDENTIAL_SCAN_BYTES ? extractC2paStore(new Uint8Array(await file.arrayBuffer())) : null);
      if (src) { credential = src.store; credentialFormat = src.format; }
    } catch { /* nothing to preserve */ }
  }

  const record: UserAssetRecordInput = {
    id,
    type: isLottie ? 'lottie' : isVector ? 'vector' : isVideo ? 'video' : (isAudio || isMidi) ? 'audio' : 'raster',
    format,
    blob,
    width,
    height,
    version: '1.0.0',
    ...(credential && credentialFormat ? { credential, credentialFormat } : {}),
    // Rasters get re-encoded (usually to WebP), so the original extension can
    // lie — a "photo.jpg" now holds WebP bytes. Show a name whose extension
    // matches what we actually stored so the filename and format badge agree.
    // (Verbatim animated/video/audio keep their real bytes, so the name stays true.)
    // Audio — verbatim uploads AND MIDI-converted songs — carries `tags` so it can
    // surface as focus music: `neurospicy` is the focus-set tag, `audio` groups it
    // with the music beds. (The player lists ANY user audio regardless, but the tags
    // keep grouping/search consistent with catalog audio.)
    meta: {
      name: renameExt(file.name, format),
      ...(animated ? { animated: true } : {}),
      ...(isAudio || isMidi ? { tags: ['audio', 'neurospicy'] } : {}),
    },
  };

  // Reach into the underlying IDB the bridge owns. The bridge exposes a
  // narrow upload helper rather than full DB access — keeps surface tight.
  await host.assets._uploadUserAsset(record);

  // A new audio track should appear in the Neurospicy player right away — drop its
  // cached track list; a mounted player rebuilds via the 'lolly:neuro-tracks' event.
  if (record.type === 'audio') invalidateNeurospicyTracks();

  // Friendly, one-shot nudge as the library crosses a milestone (20/100/500).
  // Fire-and-forget: it must never delay or fail the upload it follows.
  void maybeNudgeAssetMilestone(host);

  // Re-resolve via the public API so we get a proper AssetRef with object URL.
  return host.assets.get(id);
}

/**
 * Persist a freshly-recorded clip (the Record tool's camera take) as a durable
 * user asset, so a SAVED session restores its footage after a reload — a blob:
 * URL dies on navigation and a bare `recording.mp4` id can't be re-resolved.
 *
 * Deliberately NOT storeUserUpload: a full-length take can exceed that path's
 * 15 MB verbatim cap, and these are always a finished video container (no
 * raster/animation sniffing needed). The only guard is _uploadUserAsset's
 * device-quota check. The `user/recording/*` id namespace marks these as
 * tool-generated so a re-record can retire the PREVIOUS take (prevId) without
 * touching a clip the user picked from their own library. `meta.bytes` rides
 * along so the save/exit dialog can show the stored size without a re-read.
 *
 * `credential` (the C2PA manifest store extracted from the just-signed clip) is
 * persisted on the record so host.assets.credential(id) serves it — `user/`
 * lookups read the stored store, not the bytes — letting the take chain as an
 * ingredient when composited, exactly like a credentialed upload.
 */
export async function storeRecordingAsset(
  host: PickerHost, blob: Blob, ext: 'mp4' | 'webm', prevId?: string,
  credential?: { store: Uint8Array; format: string },
): Promise<AssetRef> {
  const id = `user/recording/${Date.now()}.${ext}`;
  await host.assets._uploadUserAsset({
    id, type: 'video', format: ext, blob, version: '1.0.0',
    ...(credential ? { credential: credential.store, credentialFormat: credential.format } : {}),
    meta: { name: `Recording.${ext}`, bytes: blob.size },
  });
  if (prevId && prevId.startsWith('user/recording/') && prevId !== id) {
    try { await host.assets._deleteUserAsset(prevId); } catch { /* orphan take is harmless */ }
  }
  return host.assets.get(id);
}

function readDimensions(file: Blob): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return resolve({});
    let settled = false;
    const url = URL.createObjectURL(file);
    const img = new Image();
    // A cap mirrors readVideoDimensions: <img> normally fires load or error, but a
    // valid-container-yet-undecodable file could fire neither and wedge the awaiting
    // upload forever (and leak the object URL). Resolve empty dims after the cap.
    const cap = setTimeout(() => { if (!settled) { settled = true; URL.revokeObjectURL(url); resolve({}); } }, 5000);
    img.onload = () => {
      if (settled) return;
      settled = true; clearTimeout(cap); URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = (e) => {
      if (settled) return;
      settled = true; clearTimeout(cap); URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function extFromMime(mime: string): string {
  if (mime.includes('json')) return 'json';
  if (mime.includes('svg')) return 'svg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('avif')) return 'avif';
  if (mime.includes('heic') || mime.includes('heif')) return 'heic';
  if (mime.includes('tiff')) return 'tiff';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('mp4') || mime.includes('m4v')) return 'mp4';
  return 'bin';
}

// Swap a filename's extension for `ext` (e.g. "photo.jpg" -> "photo.webp").
// Appends if there was no extension; collapses an already-matching one.
function renameExt(name: string, ext: string): string {
  return String(name ?? '').replace(/\.[^./\\]+$/, '') + '.' + ext;
}
