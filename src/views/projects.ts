// SPDX-License-Identifier: MPL-2.0
/**
 * Projects view (route /p and /p/<folderId>).
 *
 * A gallery-style page over the FOLDERS of saved sessions (the same data the folder
 * overlay manages, surfaced as a first-class destination). Two modes:
 *
 *   ROOT (/p) - a grid of the TOP-LEVEL folder tiles: an always-present
 *                          "Uncategorised" folder (every saved session not filed into a
 *                          folder), the user's folders, then a "+ New folder" + "+ New
 *                          tool" tile. Open a folder → /p/<id>.
 *   FOLDER (/p/<id>) - that folder's SUB-FOLDERS and saved sessions as tiles, a
 *                          breadcrumb of its ancestors, "+ New folder" (nests here) and
 *                          "+ New tool" tiles, a "Move to" rail of other folders as drop
 *                          targets, rename, and "Render folder" (export its whole subtree
 *                          as one nested batch zip).
 *
 * Folders nest: each folder has a `parentId` (see ../folders.js). Moving a session OR a
 * sub-folder is drag-and-drop (drop onto a folder tile / rail chip) with a per-tile
 * "Move to…" menu as the fallback; reparenting a folder is kept acyclic by the store.
 * Folders live on the profile via the pro-free folder store; rendering a folder gates a
 * dynamic import of ./pro so the Projects chunk stays light and /pro stays removable.
 */
import { escape } from '../utils.ts';
import { t, tRaw } from '../i18n.ts';
import { icon } from '../lib/icons.ts';
import { isPlaceableAsset } from '../lib/asset-kinds.ts';
import { createFolderStore, childFolders, folderPath, descendantFolderIds } from '../folders.ts';
import type { Folder } from '../folders.ts';
import {
  folderTile, sessionTile, imageTile, FOLDER_ICON, MENU_ICON,
  isBatchSlot, BATCH_SLOT_PREFIX,
  type MemberPreview,
} from '../folder-tiles.ts';
import type { PickerHost } from './picker.ts';   // type-only (erased); the value is lazy-imported in openAddPicker
import { wireTileSelect } from '../lib/tile-select.ts';
import { wireTileContextMenu, menuItemHtml } from '../lib/context-menu.ts';
import { bulkBarHtml as buildBulkBar, syncBulkBar as syncSharedBulkBar, wireEscapeClearsSelection } from '../lib/bulk-bar.ts';
import type { BulkBarConfig } from '../lib/bulk-bar.ts';
import { playProjectsAah, cancelArrivalAah } from '../lib/sfx.ts';
import { mountFeaturedRow } from '../components/featured-row.ts';
import type { FeaturedEntry, FeaturedRowHandle, FeaturedViewMode } from '../components/featured-row.ts';
import { viewTopbarHtml, mountViewTopbar } from '../components/view-topbar.ts';
import { claimSearchBar, clearSearchBar } from '../components/search-bar.ts';
import {
  RETURN_KEY, armSessionReturn, sessionOpenHref,
  buildSessionHaystack, buildFolderHaystack, matchesHaystack,
} from '../lib/search/projects-source.ts';
import { tokenize } from '../lib/search/match.ts';
import { confirmDialog as baseConfirmDialog, choiceDialog, closeConfirmDialogs } from '../components/confirm-dialog.ts';
import type { ConfirmDialogOpts } from '../components/confirm-dialog.ts';
import { mountModal } from '../components/modal.ts';
import type { ModalHandle } from '../components/modal.ts';
import { mountProgressToast } from '../components/progress-toast.ts';
import { announce } from '../a11y.ts';
import { soundSegmentHtml, wireSoundSegment } from '../components/sound-toggle.ts';
import { openShareDialog } from '../components/share-dialog.ts';
import { themeSegmentHtml, wireThemeSegment } from '../components/theme-toggle.ts';
import { openFolderOverlay } from '../folder-overlay.ts';
import { flagEnabled, PRO_FLAG } from '../feature-flags.ts';
import { serializeUrlState } from '@lolly/engine';
import { createToolRuntime as createRuntime } from '../lib/mount-runtime.ts';
import { getTool } from '../bridge/tool-loader.ts';
import type { UserTemplate } from '../lib/user-templates.ts';   // type-only (erased) - the store is lazy-imported
import type { ProjectedUserTool } from '../lib/user-tools.ts';   // type-only (erased) - the store is lazy-imported
import { setPendingToolSeed } from '../lib/drop-router.ts';
import { getSessionSource } from '../lib/session-source.ts';
// A leaf with no imports of its own (module state, no network/DOM), so this costs the
// Projects chunk nothing and drags no control-plane code onto any path - see its header.
import { rememberTeamSessionOrigin } from '../org/team-session-origin.ts';
import { getCollabTileProvider, renderCollabBadge } from '../lib/collab-tile-state.ts';
import type { HostV1, Profile, AssetRef } from '@lolly-tools/core/host-v1';
import type { WebStateAPI } from '../bridge/state.ts';
import type { BatchFile } from '../pro/batch.ts';

// The web shell hands mountProjects its concrete host, whose state/assets/profile
// expose more than the tool-facing HostV1 contract: state.sizes(), a thumbnail-carrying
// 3-arg save(), the user-asset helpers, and profile.set(). We describe just that extra
// surface this view reaches for and cast to it at the (few) call sites - erased at
// runtime, no behaviour change. main.js passes the concrete WebHost (assignable to
// HostV1), so the parameter stays typed HostV1 and this narrows locally.
interface ProjectsHost extends HostV1 {
  state: WebStateAPI;
  assets: HostV1['assets'] & {
    // `type` is read here to keep the non-visual user assets (fonts, tokens, ICC
    // profiles) out of surfaces that tile the list as images.
    _listUserAssets(): Promise<ReadonlyArray<{ id: string; type: string }>>;
    _deleteUserAsset(id: string): Promise<void>;
  };
  profile: HostV1['profile'] & { set(profile: object): Promise<unknown> };
}

// Denormalised projection of a catalogue-index tool entry this view reads off
// window.__toolIndex - a build artifact, not a domain type the engine owns.
interface ProjectsTool {
  id: string;
  name: string;
  description?: string;
  category?: string;
  icon?: string;
  formats?: readonly string[];
  width?: number;
  height?: number;
  unit?: string;
  exportable?: boolean;
}

/** A host.state.list() row, as this view reads it (WebStateAPI's return shape). */
type Entry = Awaited<ReturnType<WebStateAPI['list']>>[number];

// 'added' = creation time (createdAt, with a slot-timestamp fallback for legacy rows);
// 'modified' = last save (updatedAt) - the old catch-all 'date', which stored prefs
// migrate to on load. 'tool' groups by the owning tool (folder views only).
type SortBy = 'modified' | 'added' | 'name' | 'tool';
type ViewMode = 'preview' | 'list';
type SelectKind = 'folder' | 'session' | 'image';   // images join via marquee (no checkbox)

/** Query result: the (capped) tiles to render plus the true `total` so the header can
 *  say "showing the first N of M" without holding every match's DOM. */
interface SearchMatches { folders: Folder[]; sessions: Entry[]; total: number; capped: boolean }
// Ceiling on rendered result tiles. A one- or two-character handoff query can match
// thousands of sessions; building that many tiles (+ their drag/select wiring) in one
// render is the one place this view could stall at scale, so we render the first slice
// and tell the user to narrow. Filtering still scans everything (it's O(n) over a
// prebuilt index) - only the DOM is bounded.
const SEARCH_LIMIT = 200;

/** Options passed in by main.js - a metrics hook injected so /pro isn't imported
 *  eagerly (see the batch export call sites below). */
interface MountProjectsOpts {
  onBatchRendered?: (files: BatchFile[]) => void;
  /** Raw route query string (#/p?q=…). `q` enters the explicit results mode
   *  (plans/99 §2a) - read at mount only; exitSearch leaves by replacing the
   *  hash with the q-less form, which remounts (the signature carries ?q=). */
  params?: string;
}

// Sentinel folderId for the synthetic "Uncategorised" folder (sessions in no folder).
const UNCAT = '__uncat__';
// Set by the "+ New tool" tile so the next saved session files into this folder; read
// + cleared by the tool view after its first save. sessionStorage so it survives the
// navigation to the tool and dies with the tab.
const FILE_INTO_KEY = 'lolly:fileInto';

// (RETURN_KEY - the one-shot "Save returns to this page" marker - lives in
// lib/search/projects-source.ts now, shared with the spotlight's projects
// provider alongside the session-open semantics; imported above.)

// The Uncategorised view floats the same cinematic strip the gallery's Featured row uses
// (drift · Cover Flow · mobile grip) as a browsable ribbon of loose-session previews above
// the "Move to" rail. It honours the SAME view-mode preference the gallery persists, so
// switching to Cover Flow in the gallery carries over here.
const FEATURED_VIEW_STORAGE = 'lolly-featured-view';
const FEATURED_VIEWS: readonly FeaturedViewMode[] = ['gallery', 'coverflow'];

const FOLDER_PLUS_ICON = icon('folderPlus', { strokeWidth: 1.8 });
const FILE_PLUS_ICON = icon('filePlus', { strokeWidth: 1.8 });
const BACK_ICON = icon('chevronLeft');
const RENDER_ICON = icon('play');
// "history" (clock-rewind) - matches the gallery's saved-sessions button.
const HISTORY_ICON = icon('history');
// "sliders-horizontal" - the gallery's filter/view-options button, reused here for
// view mode (preview/list) + sort.
const FILTER_ICON = icon('filterLines');
// Context-menu glyphs (lucide house style). None of these existed in the codebase.
const OPEN_ICON = icon('externalLink', { strokeWidth: 1.9 });
const EDIT_ICON = icon('pen', { strokeWidth: 1.9 });
const SHEET_ICON = icon('grid', { strokeWidth: 1.9 });
const MOVE_ICON = icon('move', { strokeWidth: 1.9 });
const TRASH_ICON = icon('trash', { strokeWidth: 1.9 });
const CHEVRON_ICON = icon('chevronRight');
// lucide "link" - the shareable-link glyph (matches the tool view's Share button).
const SHARE_ICON = icon('share', { strokeWidth: 1.9 });
// lucide "users" - the team-projects create tile (shown only when a control plane
// registers a session source; see lib/session-source.ts).
const TEAM_ICON = icon('users', { strokeWidth: 1.9 });
// (The bottom bar - nav links + search field - is the shell-level singleton in
// components/search-bar.ts, shared with every browse view; this view just claims it.)

export async function mountProjects(
  viewEl: HTMLElement,
  host: HostV1,
  folderId: string | null,
  opts: MountProjectsOpts = {},
): Promise<void> {
  const store = createFolderStore(host as ProjectsHost);
  // The soft "stacking clicks → puff of wind" arrival - only on the MAIN projects view
  // (folderId null), NOT every time a folder opens. One-shot, gesture-gated, silent when
  // sound's off; cancelled on leave (see _cleanup) so it can't fire on another page.
  if (!folderId) playProjectsAah();
  const w = window as typeof window & { __toolIndex?: { tools?: ProjectsTool[] } };
  const nameById = new Map((w.__toolIndex?.tools ?? []).map((tool): [string, string] => [tool.id, (tool as unknown as ProjectsTool).name]));
  const toolName = (id: string): string => nameById.get(id) || id || t('Saved session');
  // Full index entries (formats + intended width/height/unit) so session tiles can show
  // the same "what you'll get" spec the gallery cards do - see sessionTile's `tool` opt.
  const toolById = new Map((w.__toolIndex?.tools ?? []).map((t): [string, ProjectsTool] => [t.id, t as unknown as ProjectsTool]));

  // Live data, re-read on every reload() so a move/rename/delete reflects at once.
  let folders: Folder[] = [];
  let entries: Entry[] = [];          // host.state.list() rows
  let sizes: Record<string, number> = {};            // slot -> bytes
  // Derived indices, rebuilt once per reload() (see reindex()). `folders`/`entries` only
  // change in reload(), so these stay valid between renders and turn the per-tile lookups
  // below from O(entries)/O(folders×items) rebuilds-per-call into O(1) map hits - the
  // difference between linear and quadratic work when a project holds thousands of sessions.
  let entryMap = new Map<string, Entry>();       // slot → row
  let ownerByRef = new Map<string, Folder>();    // item ref (session OR image) → the folder that holds it
  let searchIndex = new Map<string, string>();   // slot → folded search haystack (lib/search/projects-source.ts)
  let uncatCache: Entry[] = [];                  // sessions filed into no folder
  // Folder IMAGE items resolved to AssetRefs (url/format/name) so their tiles + folder
  // mosaics can render. Keyed by the item ref: a user upload (`user/…`) or a catalog asset
  // referenced by id. Resolved once per reload() - folders hold few images relative to a
  // whole library, and get() is a local (offline) lookup for both id shapes.
  let imageRefs = new Map<string, AssetRef>();
  let profile: Profile | null = null;
  let headshotUrl = '';
  let mounted = true;        // false after the view is swapped out (guards async renders)
  const toasts = new Set<HTMLElement>();  // live "Render folder" toasts, torn down on navigate-away
  let overlayModal: ModalHandle<any> | null = null;      // the move-picker / new-folder-name dialog, if open
  let releaseSearch: (() => void) | null = null;         // the shell search-bar claim (set in boot, below)
  let featuredHandle: FeaturedRowHandle | null = null; // the Uncategorised preview ribbon (drift/coverflow/grip), if mounted
  // Multi-select: ref → 'folder' | 'session'. A closure var (NOT the DOM) because
  // render() wipes viewEl.innerHTML - the selection is re-emitted from this Map each
  // render, and toggles update just the affected tile + the bulk bar in place.
  const selected = new Map<string, SelectKind>();
  let viewMode: ViewMode = 'preview';  // 'preview' (tile grid) | 'list'
  let sortBy: SortBy = 'modified';   // display preference - see the SortBy type note
  // The results-mode query (trimmed). Non-empty ONLY via the ?q= URL param - the
  // spotlight's explicit "See all in Projects →" handoff (plans/99 §2a): typing in the
  // bottom bar feeds the overlay and NEVER reshapes this view, so the user's items
  // can't seem to disappear without obvious context. When set, the view swaps to a
  // flat "results" grid searching the CURRENT scope's WHOLE subtree - every folder
  // and saved session nested beneath it - under an explicit "N results for X · Clear"
  // header. Exited only by exitSearch() (the bar's ✕/Escape via the claim's onClear,
  // or an in-body [data-search-clear]). Matching is the shared folded token-AND
  // (lib/search/projects-source.ts), so case is kept here for display.
  let query = (new URLSearchParams(opts.params || '').get('q') || '').trim();
  // The "sessions for these tools" filter (?tools=id,id) - where the gallery's
  // "View sessions" group action lands (root scope only). A flat results-style grid
  // of every saved session whose toolId is in the set, exited via its own status-line
  // Clear (which just navigates to the bare #/p). Distinct from `query`: no text
  // matching, and the search bar stays unclaimed by it.
  const toolsFilter = (new URLSearchParams(opts.params || '').get('tools') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  // Leave the ?tools= grid for the normal root, stripping the param from the URL
  // without a router round-trip (a same-folderId hash change is sig-deduped).
  function exitToolsFilter(): void {
    toolsFilter.length = 0;
    const h = window.location.href;
    const qi = h.indexOf('?');
    if (qi >= 0) {
      const params = new URLSearchParams(h.slice(qi + 1));
      params.delete('tools');
      const rest = params.toString();
      window.location.replace(h.slice(0, qi) + (rest ? `?${rest}` : ''));
    }
    render();
  }
  // Memoised searchMatches() result (invalidated on data reload + query change) so the two
  // callers in a render - pruneSelection + searchBodyHtml - don't each re-scan the tree.
  let searchCache: { q: string; scope: string | null; matches: SearchMatches } | null = null;
  try {
    if (localStorage.getItem('lolly:projectsView') === 'list') viewMode = 'list';
    const s = localStorage.getItem('lolly:projectsSort');
    if (s === 'name' || s === 'tool' || s === 'added' || s === 'modified') sortBy = s;
    else if (s === 'date') sortBy = 'modified';   // pre-'added' prefs stored 'date'
  } catch { /* localStorage unavailable */ }

  async function reload(): Promise<void> {
    [folders, entries, sizes, profile] = await Promise.all([
      store.list(),
      (host as ProjectsHost).state.list().catch(() => []),
      (host as ProjectsHost).state.sizes().catch(() => ({}) as Record<string, number>),
      host.profile.get().catch(() => null),
    ]);
    headshotUrl = profile?.headshot?.id
      ? (await host.assets.get(profile.headshot.id).catch(() => null))?.url || ''
      : '';
    // Self-heal stale refs (a session deleted elsewhere) so counts/mosaics are honest.
    await store.prune().catch(() => {});
    folders = await store.list();
    reindex();
    await resolveImages();
  }

  // Resolve every folder's IMAGE items to AssetRefs so their tiles / mosaics can paint.
  // A ref get() may fail (a race with a delete elsewhere) - those drop out and prune
  // reconciles the membership on the next pass.
  async function resolveImages(): Promise<void> {
    const refs = [...new Set(folders.flatMap(f => f.items.filter(i => i.type === 'image').map(i => i.ref)))];
    const resolved = await Promise.all(refs.map(ref =>
      host.assets.get(ref).then(r => [ref, r] as const).catch(() => null)));
    imageRefs = new Map(resolved.filter(Boolean) as [string, AssetRef][]);
  }

  // Rebuild the derived indices from the freshly-loaded folders/entries. One linear pass
  // each - everything downstream then reads O(1) instead of re-deriving per call/per tile.
  function reindex(): void {
    entryMap = new Map(entries.map(e => [e.slot, e]));
    ownerByRef = new Map();
    const claimed = new Set<string>();
    for (const f of folders) {
      for (const it of f.items) {
        // Every item (session OR image) lives in at most one folder (store invariant);
        // map it to its owner so a per-tile "remove"/"move" can find its home in O(1).
        ownerByRef.set(it.ref, f);
        if (it.type === 'session') claimed.add(it.ref);   // only sessions gate the Uncategorised bucket
      }
    }
    uncatCache = entries.filter(e => !claimed.has(e.slot));
    searchIndex = new Map(entries.map(e => [e.slot, buildSessionHaystack(e, toolName, isBatchSlot(e.slot))]));
    searchCache = null;   // matches depend on the data that just changed
  }

  const entryBySlot = (): Map<string, Entry> => entryMap;
  const uncategorised = (): Entry[] => uncatCache;

  // Resolve an item ref → a mosaic preview cell ({thumb}|{url}|{batch}) for folder tiles.
  // Sessions resolve via the state index; images via the resolved AssetRef map.
  function previewForRef(ref: string): MemberPreview | null {
    const e = entryMap.get(ref);
    if (e) return isBatchSlot(e.slot) ? { batch: true } : { thumb: e.thumb || null };
    const img = imageRefs.get(ref);
    return img?.url ? { url: img.url } : null;
  }
  function sessionsInFolder(f: Folder | null | undefined): Entry[] {
    return (f?.items ?? []).filter(i => i.type === 'session').map(i => entryMap.get(i.ref)).filter(Boolean) as Entry[];
  }

  // Sort helpers honouring the view-options menu. 'modified' is the default (recent first).
  function sortFolders(arr: readonly Folder[]): Folder[] {
    const a = [...arr];
    if (sortBy === 'name') a.sort((x, y) => x.name.localeCompare(y.name));
    else if (sortBy === 'added') a.sort((x, y) => +new Date(y.createdAt || 0) - +new Date(x.createdAt || 0));
    else if (sortBy === 'modified') a.sort((x, y) => +new Date(y.updatedAt || y.createdAt || 0) - +new Date(x.updatedAt || x.createdAt || 0));
    // 'tool' has no meaning for folders → keep stored order.
    return a;
  }
  // Tile / header count = every renderable file (session or image) in a folder's WHOLE
  // subtree - exactly what "Render folder" would output - so "N items" matches the number
  // of files you'd get even when they live in sub-folders. Sub-folders are containers, not
  // files, so they aren't counted themselves (a folder of two sub-folders holding 11
  // sessions reads "11 items", not "2"). Mirrors renderFolder's subtreeItems gather.
  const tileItemCount = (f: Folder): number =>
    [f.id, ...descendantFolderIds(folders, f.id)]
      .reduce((n, cid) => n + (folders.find(x => x.id === cid)?.items?.length ?? 0), 0);

  // ── selection helpers ───────────────────────────────────────────────────────
  const isSelected = (ref: string): boolean => selected.has(ref);
  const selectedByKind = (kind: SelectKind): string[] => [...selected].filter(([, k]) => k === kind).map(([ref]) => ref);
  // Selection is scoped to what the CURRENT view can show as a tile. Drop any selected
  // ref that isn't currently visible - deleted, OR moved out of view via drag / a per-tile
  // "Move to…" / the history overlay (none of which clear selection). This keeps the bulk
  // bar count honest and stops a bulk action (esp. Delete) from silently hitting an item
  // the user can no longer see was selected. Called at the top of every render().
  function pruneSelection(): void {
    if (!selected.size) return;
    const visible = new Set<string>();
    if (query) {
      // Searching swaps the grid for a flat results set spanning the subtree - the
      // selection stays valid for anything the results still show.
      const m = searchMatches();
      for (const f of m.folders) visible.add(f.id);
      for (const e of m.sessions) visible.add(e.slot);
    } else if (folderId == null && toolsFilter.length) {
      // The ?tools= results grid shows only the named tools' sessions.
      const set = new Set(toolsFilter);
      for (const e of entries) if (set.has(e.toolId)) visible.add(e.slot);
    } else if (folderId == null) {
      for (const f of childFolders(folders, null)) visible.add(f.id);
      for (const e of uncategorised()) visible.add(e.slot);   // loose sessions now tile at root
    } else if (folderId === UNCAT) {
      for (const e of uncategorised()) visible.add(e.slot);
    } else {
      const folder = folders.find(f => f.id === folderId);
      for (const f of childFolders(folders, folderId)) visible.add(f.id);
      for (const e of sessionsInFolder(folder)) visible.add(e.slot);
      for (const it of folder?.items ?? []) if (it.type === 'image') visible.add(it.ref);
    }
    for (const ref of [...selected.keys()]) if (!visible.has(ref)) selected.delete(ref);
  }

  const sessionTitle = (e: Entry): string => (e.label || e.filename || toolName(e.toolId) || '').toLowerCase();
  // A session's creation time for the "Date added" sort: the stored createdAt when the
  // row has one, else the timestamp minted into the slot (`<toolId>:<Date.now()>` - 
  // batch `__batch__:` and font-asset pseudo-slots carry none), else last-saved.
  const sessionAdded = (e: Entry): number => {
    if (e.createdAt) return +new Date(e.createdAt);
    const m = /:(\d{12,})$/.exec(e.slot);
    if (m) return Number(m[1]);
    return +new Date(e.updatedAt || 0);
  };
  function sortSessions(arr: Entry[]): Entry[] {
    const a = [...arr];
    if (sortBy === 'name') a.sort((x, y) => sessionTitle(x).localeCompare(sessionTitle(y)));
    else if (sortBy === 'tool') a.sort((x, y) => (toolName(x.toolId) || '').localeCompare(toolName(y.toolId) || '') || sessionTitle(x).localeCompare(sessionTitle(y)));
    else if (sortBy === 'added') a.sort((x, y) => sessionAdded(y) - sessionAdded(x));
    else a.sort((x, y) => +new Date(y.updatedAt || 0) - +new Date(x.updatedAt || 0)); // modified
    return a;
  }

  // ── search (within the current scope's whole subtree) ───────────────────────
  // Haystacks + matching live in lib/search/projects-source.ts, shared verbatim with
  // the spotlight's projects provider so the two can't drift (plans/99 §8 M2). That
  // move also migrated matching from substring .includes onto the shared folded
  // token-AND matcher - the plan's deliberate unification: every query word must hit
  // (in any field) and diacritics fold, same hits here as in the overlay.

  // All folders + sessions in scope for the current view, BEFORE the query filter:
  //   root         → every folder + every saved session (the whole tree)
  //   Uncategorised → the loose sessions (flat, no sub-folders)
  //   a folder      → that folder's descendant folders + every session in its subtree
  function searchScope(): { folders: Folder[]; sessions: Entry[] } {
    if (folderId == null) return { folders, sessions: entries };
    if (folderId === UNCAT) return { folders: [], sessions: uncategorised() };
    const subIds = descendantFolderIds(folders, folderId);          // strictly inside
    const map = entryBySlot();
    const refs = [folderId, ...subIds].flatMap(id =>
      folders.find(f => f.id === id)?.items.filter(i => i.type === 'session').map(i => i.ref) ?? []);
    return {
      folders: folders.filter(f => subIds.includes(f.id)),
      sessions: refs.map(r => map.get(r)).filter(Boolean) as Entry[],
    };
  }

  // The query-filtered, sorted matches for the current scope - capped for render (see
  // SEARCH_LIMIT) and memoised so a single render's two callers scan the tree once.
  function searchMatches(): SearchMatches {
    if (!query) return { folders: [], sessions: [], total: 0, capped: false };
    if (searchCache && searchCache.q === query && searchCache.scope === folderId) return searchCache.matches;
    const scope = searchScope();
    const tokens = tokenize(query);
    // Sessions match via the prebuilt folded haystack (searchIndex) - no per-query
    // string building. Folders match on name (there are far fewer of them). Results
    // keep the view's sort preference (date/name/tool), not match score: this is a
    // browse surface; score-ranking lives in the spotlight overlay.
    const mf = sortFolders(scope.folders.filter(f => matchesHaystack(buildFolderHaystack(f.name), tokens) > 0));
    const ms = sortSessions(scope.sessions.filter(e => matchesHaystack(searchIndex.get(e.slot) ?? '', tokens) > 0));
    const total = mf.length + ms.length;
    const cf = total > SEARCH_LIMIT ? mf.slice(0, SEARCH_LIMIT) : mf;
    const cs = total > SEARCH_LIMIT ? ms.slice(0, Math.max(0, SEARCH_LIMIT - cf.length)) : ms;
    const matches: SearchMatches = { folders: cf, sessions: cs, total, capped: total > SEARCH_LIMIT };
    searchCache = { q: query, scope: folderId, matches };
    return matches;
  }

  // ── render ───────────────────────────────────────────────────────────────
  function render(): void {
    if (!mounted) return; // an async callback fired after we navigated away - don't clobber the new view
    // Title the view for the tab bar AND for back-nav (lib/back-nav.ts labels the
    // previous view off document.title - this is how a tool opened from a folder,
    // or #/start reached from one, gets a back pill wearing the folder's name).
    const titleName = folderId == null ? t('Projects')
      : folderId === UNCAT ? t('Uncategorised')
      : (folders.find(f => f.id === folderId)?.name || t('Projects'));
    document.title = tRaw('{name} — Lolly', { name: titleName });
    featuredHandle?.destroy(); featuredHandle = null;  // stop the prior ribbon's rAF loop + listeners before its DOM is wiped
    searchCache = null;   // recompute matches once for this render (sort/data may have changed); the two callers below then share it
    pruneSelection();     // forget refs that vanished since the last render
    viewEl.innerHTML = folderId == null ? rootHtml() : folderHtml(folderId);
    wire();
  }

  function rootHtml(): string {
    if (query) return shell(t('Projects'), 'projects', searchBodyHtml());
    if (toolsFilter.length) return shell(t('Projects'), 'projects', toolsBodyHtml());
    const loose = sortSessions(uncategorised());
    const createFolder = createTile('folder', FOLDER_PLUS_ICON, t('New folder'), t('Group saved sessions'));
    const createTool = createTile('tool', FILE_PLUS_ICON, t('New asset'), t('Start a fresh creation'));
    // Only TOP-LEVEL folders at the root; nested folders show inside their parent.
    const topFolders = sortFolders(childFolders(folders, null));
    const folderTiles = topFolders.map(f => folderTile(f, {
      memberPreviews: f.items.map(i => previewForRef(i.ref)).filter(Boolean) as MemberPreview[],
      count: tileItemCount(f),
      selectable: true, selected: isSelected(f.id),
    })).join('');
    // Loose (uncategorised) saved sessions render as tiles directly on the root grid - 
    // a just-added creation shows here at once instead of vanishing into an
    // "Uncategorised" bucket. They're the SAME sessionTile a folder uses, so
    // drag-into-folder, select, rename, render, and open all work by delegation
    // (see wire()/wireDrag()). Newest first (the default sort) so a fresh add lands top-left.
    const looseTiles = loose.map(e => sessionTile(e, {
      toolName: toolName(e.toolId), sizeBytes: sizes[e.slot] || 0, tool: toolById.get(e.toolId),
      selectable: true, selected: isSelected(e.slot),
    })).join('');
    // First run: no folders AND no loose sessions → lead with a one-line invite explaining
    // what Projects hold, instead of a grid that's only the two "new" tiles.
    const invite = (!topFolders.length && !loose.length)
      ? `<p class="projects-empty">${t('Your saved sessions land here — save one from any tool to start a project.')}</p>`
      : '';
    // Folders lead (the file-manager convention - containers first, so the structure
    // reads before the loose items), then loose creations (newest first within their
    // block), then the "new" affordances trailing.
    // A "Team projects" tile appears only when a deployment's control plane has
    // registered a session source (lib/session-source.ts); dormant otherwise, so
    // the grid is byte-identical on the public shell.
    const teamTile = getSessionSource()
      ? createTile('team', TEAM_ICON, t('Team projects'), t('Shared with you on this instance'))
      : '';
    return shell(t('Projects'), 'projects', `
      ${invite}
      <div class="folder-grid projects-grid${viewMode === 'list' ? ' projects-list' : ''}">
        ${folderTiles}${looseTiles}${createFolder}${createTool}${teamTile}
      </div>`);
  }

  // The flat results grid for the ?tools= filter - every saved session belonging to
  // the named tools, under an explicit status line with its own way out. Mirrors
  // searchBodyHtml's shape (status + .projects-search-grid) so the two modes read
  // the same; tiles are the shared sessionTile, so open/select/menu/drag all work
  // by the existing delegation.
  function toolsBodyHtml(): string {
    const set = new Set(toolsFilter);
    const ms = sortSessions(entries.filter(e => set.has(e.toolId)));
    const names = toolsFilter.map(id => toolName(id));
    const label = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
    const clearBtn = `<button type="button" class="projects-linkbtn" data-tools-clear>${t('Show all projects')}</button>`;
    if (!ms.length) {
      return `<p class="projects-search-status" role="status" aria-live="polite">${tRaw('No saved sessions yet for {names}', { names: escape(label) })} · ${clearBtn}</p>
        <p class="projects-empty">${t('Save a session from one of these tools and it will land here.')}</p>`;
    }
    const countText = ms.length === 1 ? t('1 saved session') : t('{n} saved sessions', { n: ms.length });
    const status = `<p class="projects-search-status" role="status" aria-live="polite">${tRaw('{count} for {names}', { count: countText, names: escape(label) })} · ${clearBtn}</p>`;
    const gridClass = `folder-grid projects-grid projects-search-grid${viewMode === 'list' ? ' projects-list' : ''}`;
    const tiles = ms.map(e => sessionTile(e, {
      toolName: toolName(e.toolId), sizeBytes: sizes[e.slot] || 0, tool: toolById.get(e.toolId),
      selectable: true, selected: isSelected(e.slot),
    })).join('');
    return `${status}<div class="${gridClass}">${tiles}</div>`;
  }

  function folderHtml(id: string): string {
    const isUncat = id === UNCAT;
    const folder = isUncat ? null : folders.find(f => f.id === id);
    if (!isUncat && !folder) {
      return shell(t('Projects'), 'projects', `<p class="projects-empty">${tRaw('That folder no longer exists. {link}.', { link: `<a href="#/p">${t('Back to Projects')}</a>` })}</p>`, { inFolder: true });
    }
    const subfolders = isUncat ? [] : sortFolders(childFolders(folders, id));
    const sessions = sortSessions(isUncat ? uncategorised() : sessionsInFolder(folder));
    const title = isUncat ? t('Uncategorised') : folder!.name;
    // Header count matches the folder tile: total renderable files in the whole subtree
    // (Uncategorised is flat, so its direct session count is already the full picture).
    const count = isUncat ? sessions.length : tileItemCount(folder!);

    // Breadcrumb + parent - the back arrow climbs ONE level (to the parent folder, or
    // the root), and the trail links every ancestor. The current folder is the <h2>.
    const ancestors = isUncat ? [] : folderPath(folders, id).slice(0, -1);
    const parentId = ancestors.length ? ancestors[ancestors.length - 1]!.id : null;
    const backHref = parentId ? `#/p/${escape(parentId)}` : '#/p';
    const crumbs = `
      <nav class="projects-crumbs" aria-label="${escape(t('Folder path'))}">
        <a href="#/p">${t('Projects')}</a>
        ${ancestors.map(a => `<span class="projects-crumb-sep" aria-hidden="true">/</span><a href="#/p/${escape(a.id)}">${escape(a.name)}</a>`).join('')}
      </nav>`;

    // "Move to" rail: CONTEXTUAL drop targets only (not the whole tree dumped flat) - 
    // inside a folder it's Top level + the parent + siblings; in Uncategorised it's the
    // top-level folders. Arbitrary-depth moves use the per-tile "Move to…" drill-down.
    const railTargets = isUncat
      ? childFolders(folders, null).map(f => ({ id: f.id, name: f.name }))
      : [
          { id: UNCAT, name: t('Top level') },
          ...(parentId ? [{ id: parentId, name: folders.find(f => f.id === parentId)?.name || t('Parent') }] : []),
          ...childFolders(folders, folder!.parentId ?? null).filter(f => f.id !== id).map(f => ({ id: f.id, name: f.name })),
        ];
    const rail = railTargets.length ? `
      <div class="projects-rail" aria-label="${escape(t('Drag a session or folder onto a folder to move it'))}">
        <span class="projects-rail-hint">${t('Move to')}</span>
        ${railTargets.map(rt => `<button type="button" class="projects-chip" data-drop-folder="${escape(rt.id)}" data-open-folder-nav="${escape(rt.id)}">${escape(rt.name)}</button>`).join('')}
      </div>` : '';

    // Uncategorised only: a cinematic preview ribbon of the loose sessions, ABOVE the
    // "Move to" rail. Empty mount now; wire() hydrates it with the shared Featured strip
    // (drift · Cover Flow · mobile grip) once the DOM exists - see mountUncatRibbon().
    const ribbon = isUncat && sessions.length ? `<div class="projects-featured" data-uncat-ribbon></div>` : '';
    // Preview-strip view switcher, BELOW the ribbon - the SAME `.view-seg` segmented control
    // the catalog uses for its favourites strip (Gallery drift | Cover Flow), so the two match
    // instead of this being buried as menu items. Shares the FEATURED_VIEW_STORAGE pref.
    const stripFview = readFeaturedView();
    const stripSwitch = isUncat && sessions.length
      ? `<div class="view-seg projects-featured-switch" role="group" aria-label="${escape(t('Preview strip view mode'))}">
          <button type="button" class="view-seg-btn" data-fview="gallery" aria-pressed="${stripFview === 'gallery'}">${t('Gallery')}</button>
          <button type="button" class="view-seg-btn" data-fview="coverflow" aria-pressed="${stripFview === 'coverflow'}">${t('Cover Flow')}</button>
        </div>`
      : '';

    // Content first (sub-folders, then sessions); create tiles LAST. No "+ New folder"
    // inside the synthetic Uncategorised bucket (it isn't a real folder to nest under).
    const createFolder = isUncat ? '' : createTile('folder', FOLDER_PLUS_ICON, t('New folder'), tRaw('Group inside {title}', { title }));
    const createTool = createTile('tool', FILE_PLUS_ICON, t('New asset'), isUncat ? t('New saved session') : tRaw('Add to {title}', { title }));
    // Image items in this folder (never in Uncategorised - an image needs a folder to
    // live in), resolved to AssetRefs so their tiles render. Kept in store order after
    // the sessions.
    const images = isUncat ? [] : (folder!.items
      .filter(i => i.type === 'image')
      .map(i => imageRefs.get(i.ref))
      .filter(Boolean) as AssetRef[]);
    const tiles = [
      ...subfolders.map(f => folderTile(f, {
        memberPreviews: f.items.map(i => previewForRef(i.ref)).filter(Boolean) as MemberPreview[],
        count: tileItemCount(f),
        selectable: true, selected: isSelected(f.id),
      })),
      ...sessions.map(e => sessionTile(e, {
        toolName: toolName(e.toolId), sizeBytes: sizes[e.slot] || 0, tool: toolById.get(e.toolId),
        selectable: true, selected: isSelected(e.slot),
      })),
      ...images.map(a => imageTile(a, {
        selectable: true, selected: isSelected(a.id),
        sub: a.id.startsWith('user/') ? t('Image') : t('Catalog image'),
      })),
    ].join('');

    // While a search is active the folder's own actions (rename / render whole folder)
    // would act on the folder, not the results, so they're dropped - the header keeps just
    // the breadcrumb, the back arrow, and the title so the user can still climb out.
    const searching = !!query;
    const header = `
      ${crumbs}
      <div class="projects-head">
        <a href="${backHref}" class="projects-back" aria-label="${escape(parentId ? t('Up to parent folder') : t('Back to Projects'))}">${BACK_ICON}</a>
        <h2 class="projects-title"${isUncat || searching ? '' : ` data-rename-folder="${escape(id)}" title="${escape(t('Rename folder'))}"`}>${escape(title)}</h2>
        ${searching ? '' : `<span class="projects-count">${count === 1 ? t('1 item') : t('{n} items', { n: count })}</span>`}
        <span class="projects-head-spacer"></span>
        ${!searching && count ? `<button type="button" class="projects-render btn" data-render-folder="${escape(id)}">${RENDER_ICON}<span>${t('Render folder')}</span></button>` : ''}
        ${isUncat || searching ? '' : `<button type="button" class="tile-menu-btn projects-head-menu" data-menu="${escape(id)}" data-menu-kind="folder" aria-label="${escape(t('Folder actions (rename, render, delete)'))}">${MENU_ICON}</button>`}
      </div>`;

    // Searching swaps the ribbon/rail/create tiles for the flat results grid, but keeps the
    // breadcrumb + header so the folder context (and the way back out) stays visible.
    if (searching) return shell(title, 'projects', `${header}${searchBodyHtml()}`, { inFolder: true });

    const gridClass = `folder-grid projects-grid${viewMode === 'list' ? ' projects-list' : ''}`;
    // Gate on whether there are TILES to show (sub-folders OR sessions), not on the
    // subtree file count: an empty sub-folder is a real tile the user needs to see, but
    // contributes 0 to `count` (tileItemCount ignores folders), so keying off `count`
    // would hide a freshly-created empty sub-folder.
    const hasTiles = subfolders.length > 0 || sessions.length > 0 || images.length > 0;
    const body = hasTiles
      ? `<div class="${gridClass}">${tiles}${createFolder}${createTool}</div>`
      : `<div class="${gridClass}">${createFolder}${createTool}</div><p class="projects-empty">${isUncat ? t('No saved sessions are uncategorised yet.') : t('This folder is empty — add a tool or a sub-folder.')}</p>`;

    return shell(title, 'projects', `${ribbon}${stripSwitch}${rail}${header}${body}`, { inFolder: true });
  }

  // The flat results grid for the active query - matching folders first, then sessions,
  // each tile trailing a clickable breadcrumb of WHERE it lives so a hit nested three
  // folders deep still reads in context. Shared by the root + folder search branches.
  function searchBodyHtml(): string {
    const { folders: mf, sessions: ms, total, capped } = searchMatches();
    const shown = mf.length + ms.length;
    const scope = folderId == null ? t('all projects')
      : folderId === UNCAT ? t('Uncategorised')
      : `“${folders.find(f => f.id === folderId)?.name ?? t('this folder')}”`;
    // Results mode always carries an explicit Clear in the status line - BOTH the
    // results and no-results states (plans/99 §2a: the URL-entered mode needs
    // unmistakable context AND an unmissable way out). Routed through
    // [data-search-clear] → clearSearchBar → the claim's onClear, so the bar's
    // field and this view exit as one.
    const clearBtn = `<button type="button" class="projects-linkbtn" data-search-clear>${t('Clear')}</button>`;
    if (!total) {
      return `<p class="projects-search-status" role="status" aria-live="polite">${t('No matches for “{query}” in {scope}', { query, scope })} · ${clearBtn}</p>
        <p class="projects-empty">${tRaw('Nothing here matches “{query}”. Try a different search, or {button}.', { query: escape(query), button: `<button type="button" class="projects-linkbtn" data-search-clear>${t('clear the search')}</button>` })}</p>`;
    }
    // When the match set is capped, name the true total and that only a slice is shown so a
    // broad query never silently looks "complete".
    const countText = capped
      ? t('{total} results — showing the first {shown}, refine to narrow', { total: total.toLocaleString(), shown })
      : (total === 1 ? t('1 result') : t('{n} results', { n: total }));
    const status = `<p class="projects-search-status" role="status" aria-live="polite">${tRaw('{count} for “{query}” in {scope}', { count: countText, query: escape(query), scope: escape(scope) })} · ${clearBtn}</p>`;
    const gridClass = `folder-grid projects-grid projects-search-grid${viewMode === 'list' ? ' projects-list' : ''}`;
    const tiles = [...mf.map(folderResultTile), ...ms.map(sessionResultTile)].join('');
    return `${status}<div class="${gridClass}">${tiles}</div>`;
  }

  // A search hit = the normal tile + a location breadcrumb beneath it. Reusing the shared
  // folderTile/sessionTile keeps open / select / drag / menu working with no extra wiring.
  function folderResultTile(f: Folder): string {
    const tile = folderTile(f, {
      memberPreviews: f.items.map(i => previewForRef(i.ref)).filter(Boolean) as MemberPreview[],
      count: tileItemCount(f), selectable: true, selected: isSelected(f.id),
    });
    const anc = folderPath(folders, f.id).slice(0, -1);   // this folder's ancestors
    const parent = anc.length ? anc[anc.length - 1]!.id : null;
    return `<div class="projects-result">${tile}${locationChip(parent, anc.length ? anc.map(a => a.name).join(' / ') : t('Top level'))}</div>`;
  }
  function sessionResultTile(e: Entry): string {
    const tile = sessionTile(e, {
      toolName: toolName(e.toolId), sizeBytes: sizes[e.slot] || 0, tool: toolById.get(e.toolId),
      selectable: true, selected: isSelected(e.slot),
    });
    const owner = ownerByRef.get(e.slot);   // O(1) - prebuilt in reindex()
    const chip = owner
      ? locationChip(owner.id, folderPath(folders, owner.id).map(a => a.name).join(' / '))
      : locationChip(UNCAT, t('Uncategorised'));
    return `<div class="projects-result">${tile}${chip}</div>`;
  }
  // A folder-path breadcrumb chip. When it points at a real folder (or Uncategorised) it's
  // a button that navigates there (reusing the rail's [data-open-folder-nav]); a top-level
  // item is static text.
  function locationChip(targetId: string | null, text: string): string {
    const inner = `${FOLDER_ICON}<span>${escape(text)}</span>`;
    return targetId
      ? `<button type="button" class="projects-result-path" data-open-folder-nav="${escape(targetId)}" title="${escape(tRaw('Open {name}', { name: text }))}">${inner}</button>`
      : `<span class="projects-result-path projects-result-path--static">${inner}</span>`;
  }

  function createTile(kind: string, icon: string, title: string, sub: string): string {
    return `
      <div class="folder-tile folder-tile--create" data-create="${kind}">
        <button type="button" class="tile-primary" aria-label="${escape(title)}">
          <span class="tile-cover tile-cover--create" aria-hidden="true">${icon}</span>
          <span class="tile-meta">
            <span class="tile-title">${escape(title)}</span>
            <span class="tile-sub">${escape(sub)}</span>
          </span>
        </button>
      </div>`;
  }

  // Projects' own trigger buttons in the shared top bar's `right` slot: view/sort
  // options + saved-sessions (history). The rest of the cluster - language FAB and
  // profile pill - is the shared chrome (components/view-topbar.ts), same as Tools
  // and Catalog. (No tool filters here - they're meaningless for projects.)
  function topRightSlot(): string {
    const saved = entries.length;
    return `
        <button type="button" class="filter-fab projects-viewopts" aria-label="${escape(t('View and sort options'))}" aria-haspopup="true" title="${escape(t('View & sort'))}">${FILTER_ICON}</button>
        ${saved ? `<button type="button" class="history-fab" title="${escape(t('Saved sessions'))}" aria-label="${escape(t('Saved sessions ({n})', { n: saved }))}">${HISTORY_ICON}<span class="history-fab-count" aria-hidden="true">${saved}</span></button>` : ''}`;
  }

  function shell(heading: string, active: 'tools' | 'projects' | 'catalog', inner: string, { inFolder = false }: { inFolder?: boolean } = {}): string {
    // projects--searching marks the URL-entered results mode (plans/99 §2a) - it can
    // never flip mid-view from typing, since live keystrokes go to the spotlight
    // overlay and only ?q= at mount (or exitSearch) changes `query`.
    return `
      <div class="projects${inFolder ? ' projects--folder' : ''}${query ? ' projects--searching' : ''}">
        ${viewTopbarHtml({
          active,
          right: topRightSlot(),
          // No view-specific class on the cluster: the old `.projects-topright` marker
          // this markup used to carry had no CSS rule and no selector anywhere in the
          // repo, so it went out with the hand-rolled copy.
          profile: { firstname: profile?.firstname, headshotUrl },
        })}
        <h1 class="visually-hidden">${escape(heading)}</h1>
        ${inner}
        ${bulkBarHtml()}
      </div>`;
  }

  // The bottom bar is the persistent shell singleton (components/search-bar.ts).
  // Projects claims it with a scope-aware placeholder (it names the CURRENT folder
  // so it's clear a query reaches INTO sub-folders) but NO live-filter tap - typing
  // feeds the spotlight overlay (plans/99 §2a M2), and only the explicit ?q=
  // handoff puts this view into results mode.
  function searchPlaceholder(): string {
    const scopeName = folderId == null ? t('all projects')
      : folderId === UNCAT ? t('Uncategorised')
      : (folders.find(f => f.id === folderId)?.name || t('this folder'));
    return folderId == null ? t('Search all projects…') : tRaw('Search {scope}…', { scope: scopeName });
  }

  // Exit the URL-entered results mode (plans/99 §2a). location.replace with the
  // q-less hash (no new history entry): the projects route signature carries ?q=
  // (main.ts routeSignature), so the hash change remounts the plain grid - the
  // same path the browser's Back button takes out of results mode, so exit
  // behaviour can't fork. Wired as the bar claim's onClear, and reached by
  // every in-body [data-search-clear] via clearSearchBar.
  function exitSearch(): void {
    if (!mounted || !query) return;
    const h = window.location.hash;
    const qi = h.indexOf('?');
    if (qi === -1) { query = ''; searchCache = null; render(); return; }
    const params = new URLSearchParams(h.slice(qi + 1));
    params.delete('q');
    const rest = params.toString();
    window.location.replace(h.slice(0, qi) + (rest ? `?${rest}` : ''));
  }

  // The floating multi-selection action bar - markup + sync live in lib/bulk-bar.ts
  // (shared with the catalog and gallery); this view supplies its action set. The
  // "Render selection" action leads with the primary Render styling to match the
  // header button; "Edit together" only shows for a manageable set of single-tool
  // sessions (2–8, no folders/images/batch grids) - the multi-edit view mounts one
  // live runtime per session, so the cap keeps it responsive.
  const bulkBarCfg: BulkBarConfig = {
    prefix: 'projects-bulkbar',
    rootSelector: '.projects',
    count: () => selected.size,
    actions: [
      { id: 'render', icon: RENDER_ICON, label: () => t('Render selection'), extraClass: 'projects-render projects-bulk-render' },
      { id: 'edit', icon: EDIT_ICON, label: () => t('Edit together'), title: () => t('Open the selected sessions side by side with one combined sidebar'), hidden: () => !editableSelection() },
      { id: 'sheet', icon: SHEET_ICON, label: () => t('Edit as sheet'), title: () => t('Open the whole selection as rows in the batch grid — no size limit'), hidden: () => !sheetableSelection() },
      { id: 'move', icon: MOVE_ICON, label: () => t('Move to…') },
      { id: 'newfolder', icon: FOLDER_PLUS_ICON, label: () => t('New folder') },
      { id: 'delete', icon: TRASH_ICON, label: () => t('Delete'), extraClass: 'projects-bulk-danger' },
    ],
  };
  const bulkBarHtml = (): string => buildBulkBar(bulkBarCfg);
  const syncBulkBar = (): void => syncSharedBulkBar(viewEl, bulkBarCfg);

  /** The selected slots IFF the whole selection is 2–8 single-tool sessions; else null. */
  function editableSelection(): string[] | null {
    if (selected.size < 2 || selected.size > 8) return null;
    const slots: string[] = [];
    for (const [ref, kind] of selected) {
      if (kind !== 'session' || isBatchSlot(ref)) return null;
      slots.push(ref);
    }
    return slots;
  }

  /** Open the selected sessions in the multi-edit view (#/multi?s=slot,slot…). */
  function editSelection(): void {
    const slots = editableSelection();
    if (!slots) return;
    window.location.hash = `#/multi?s=${slots.map(encodeURIComponent).join(',')}`;
  }

  /** The selected SESSION + IMAGE refs (any count), or null if the selection has
   *  none. The batch grid's complement to multi-edit: no 2–8 cap, heterogeneous
   *  tools welcome, non-tool items land as tool-less rows (see rowsFromRefs).
   *  Folders are excluded - they stay containers with their own open-in-grid path. */
  function sheetableSelection(): string[] | null {
    const refs = [...selected].filter(([, k]) => k !== 'folder').map(([ref]) => ref);
    return refs.length ? refs : null;
  }

  /** Open the selection as rows in the /pro batch grid (#/pro?s=slot,slot…). */
  function editAsSheet(): void {
    const refs = sheetableSelection();
    if (!refs) return;
    window.location.hash = `#/pro?s=${refs.map(encodeURIComponent).join(',')}`;
  }

  // ── wiring ─────────────────────────────────────────────────────────────────
  // The view-options (filter) popover is still this hand-rolled body-absolute one - 
  // only the two CONTEXT menus (below) moved onto mountBodyPopover, rec 9's remainder.
  let openPopover: HTMLElement | null = null;
  function closeMenu(): void {
    openPopover?.remove(); openPopover = null;
    document.removeEventListener('pointerdown', onDocDown, true); document.removeEventListener('keydown', onMenuKey, true);
    tileMenu.close();
  }
  function onDocDown(e: PointerEvent): void { if (openPopover && !openPopover.contains(e.target as Node)) closeMenu(); }
  // Escape closes an open popover menu - matching the app-wide dialog convention (see confirm-dialog).
  function onMenuKey(e: KeyboardEvent): void { if (e.key === 'Escape' && openPopover) { e.preventDefault(); e.stopPropagation(); closeMenu(); } }

  // ── per-tile / bulk-selection context menu (kebab button, right-click, long-press) ──
  // The whole mechanism - one mountBodyPopover over a mutable pointAnchor, the edge-
  // clamped fixed positioning, right-click delegation ("inside a multi-selection →
  // bulk menu"), and the press-and-hold touch bridge - now lives in
  // lib/context-menu.ts (extracted from this view, shared with gallery + catalog).
  // This view supplies the menu bodies and the action dispatch; the kebab buttons
  // (recreated each render) route through tileMenu.openAt with themselves as the
  // focus-restore delegate. Create tiles + the synthetic Uncategorised tile decline
  // (refOf → null) → the NATIVE menu shows, as before.
  const tileMenu = wireTileContextMenu({
    host: viewEl,
    tileSelector: '.folder-tile[data-ref][data-kind]',
    refOf: (tile) => (tile.classList.contains('folder-tile--create') || tile.classList.contains('folder-tile--uncat'))
      ? null : tile.dataset.ref ?? null,
    isBulkTarget: (ref) => selected.size > 1 && selected.has(ref),
    singleHtml: (tgt) => tileMenuHtml(tgt.data ?? tgt.tile?.dataset.kind ?? 'session', tgt.ref),
    bulkHtml: () => bulkMenuHtml(),
    onAction: (act, tgt) => { void onMenuAction(act, tgt); },
    className: 'folder-menu projects-menu',
  });

  // Destructive actions (delete a folder + its contents, delete a saved session) use
  // the shared styled confirm modal - close any open tile menu first so it doesn't
  // hang behind the dialog. closeMenu() detaches the popover that held the trigger, so
  // the native <dialog>'s focus-restore would land on <body>; capture a still-connected
  // fallback up front and refocus it once the dialog resolves. See components/confirm-dialog.js.
  const confirmDialog = (opts: ConfirmDialogOpts): Promise<boolean> => {
    const active = document.activeElement;
    const fallback = (active instanceof HTMLElement && active !== document.body && active.isConnected && !openPopover?.contains(active))
      ? active
      : viewEl.querySelector<HTMLElement>('.projects-viewopts');
    closeMenu();
    return baseConfirmDialog(opts).then((ok) => { if (fallback?.isConnected) fallback.focus({ preventScroll: true }); return ok; });
  };

  function wire(): void {
    const root = viewEl.querySelector<HTMLElement>('.projects');
    if (!root) return;

    root.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;

      // Exit results mode (the status line's Clear + the no-results link). Routed
      // through clearSearchBar so the bar's field empties too; with no onQuery
      // claimed, the bar invokes this view's onClear (the M2 contract).
      const clr = t.closest<HTMLElement>('[data-search-clear]');
      if (clr) { e.preventDefault(); clearSearchBar({ focus: false }); return; }

      // Exit the ?tools= results mode. In place, not by navigation: the projects route
      // signature keys on folderId alone (main.ts), so a hash change #/p?tools=… → #/p
      // is deduped and would never re-mount - same reason the ?q= exit works in place.
      const tclr = t.closest<HTMLElement>('[data-tools-clear]');
      if (tclr) { e.preventDefault(); exitToolsFilter(); return; }

      // Preview-strip view switcher (the .view-seg below the Uncategorised ribbon). Live-
      // switch the strip via its handle (no full re-render) and persist the shared pref so the
      // choice carries to the gallery hero + next mount - matching the catalog's switch.
      const fviewBtn = t.closest<HTMLElement>('[data-fview]');
      if (fviewBtn) {
        const mode = fviewBtn.dataset.fview as FeaturedViewMode;
        try { localStorage.setItem(FEATURED_VIEW_STORAGE, mode); } catch { /* storage off */ }
        featuredHandle?.setViewMode(mode);
        root.querySelectorAll<HTMLElement>('.projects-featured-switch [data-fview]')
          .forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fview === mode)));
        return;
      }

      // Per-tile overflow menu (check before the open-folder primary it sits inside)
      const menuBtn = t.closest<HTMLElement>('[data-menu]');
      if (menuBtn) {
        e.preventDefault(); e.stopPropagation();
        const r = menuBtn.getBoundingClientRect();
        openMenu({ ref: menuBtn.dataset.menu!, kind: menuBtn.dataset.menuKind!, tileEl: menuBtn.closest<HTMLElement>('.folder-tile'), anchorEl: menuBtn, x: r.left, y: r.bottom + 6 });
        return;
      }

      // Selection toggle (must beat the open-folder / open-session primary it neighbours).
      // Shift-click extends from the anchor instead of toggling - see lib/tile-select.ts.
      const selBtn = t.closest<HTMLElement>('[data-select]');
      if (selBtn) {
        e.preventDefault(); e.stopPropagation();
        tileSelect.onDotClick(selBtn.dataset.select!, e.shiftKey, () => toggleSelect(selBtn));
        return;
      }

      // Bulk-action bar
      const bulk = t.closest<HTMLElement>('[data-bulk]');
      if (bulk) { e.preventDefault(); e.stopPropagation(); handleBulk(bulk.dataset.bulk!); return; }

      // Open a folder (folder tile primary). Hash navigation (folders are hash-routed).
      const open = t.closest<HTMLElement>('[data-open-folder]');
      if (open) { window.location.hash = '#/p/' + open.dataset.openFolder; return; }
      // Rail chip navigates (drops are handled separately)
      const navChip = t.closest<HTMLElement>('[data-open-folder-nav]');
      if (navChip) { window.location.hash = '#/p/' + navChip.dataset.openFolderNav; return; }

      // Create tiles
      const create = t.closest<HTMLElement>('[data-create]');
      if (create) {
        const kind = create.dataset.create;
        if (kind === 'folder') startCreateFolder(create);
        else if (kind === 'team') void openTeamProjects();
        else startCreateTool();
        return;
      }

      // Rename folder (click the title in a folder view)
      const rn = t.closest<HTMLElement>('[data-rename-folder]');
      if (rn) { startRename(rn, rn.dataset.renameFolder); return; }

      // Render whole folder
      const rf = t.closest<HTMLElement>('[data-render-folder]');
      if (rf) { renderFolder(rf.dataset.renderFolder!); return; }

      // Open a saved session (resume the tool / open batch)
      const os = t.closest<HTMLElement>('[data-open-session]');
      if (os) { resumeSession(os.dataset.openSession!); return; }

      // Open a folder image (catalog reference or your upload) in a lightbox preview.
      const oi = t.closest<HTMLElement>('[data-open-image]');
      if (oi) { openImagePreview(oi.dataset.openImage!); return; }

      // A tap on a preview-ribbon tile resumes that session. The Featured strip's own
      // capture-phase handler has already swallowed a drag / a Cover-Flow re-centre before
      // this bubbles, so reaching here means a clean open - route it through resumeSession
      // (closeMenu + armReturn + batch handling) rather than the anchor's raw navigation.
      const ribbonTile = t.closest<HTMLElement>('.projects-featured .ftile');
      if (ribbonTile) { e.preventDefault(); resumeSession(ribbonTile.dataset.tool!); return; }
    });

    // (The search field lives in the shell's persistent bar; typing there feeds the
    // spotlight overlay, never this view - see the claimSearchBar call in the boot
    // section. Only the explicit ?q= handoff enters results mode.)

    // View-options (filter) button → preview/list + sort popover.
    root.querySelector('.projects-viewopts')?.addEventListener('click', (e) => { e.stopPropagation(); openViewOpts(e.currentTarget as HTMLElement); });

    // History → the quick saved-sessions overlay (same as the gallery). It can
    // move/rename folders behind the page, so refresh Projects when it closes.
    // Reached from the history button AND, on mobile, the consolidated profile menu.
    async function openHistory(): Promise<void> {
      // Filtered: the user-asset store also holds fonts, the tokens doc and ICC
      // profiles, and the overlay tiles whatever it is handed as an image.
      const stored = await (host as ProjectsHost).assets._listUserAssets?.().catch(() => []) ?? [];
      const imageRefs = stored.filter(isPlaceableAsset);
      openFolderOverlay(host as ProjectsHost, {
        context: 'projects',
        sessionEntries: [...entries].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
        imageRefs, sessionSizes: sizes, nameById,
        showCreateFolder: true,
        allowBatchExport: flagEnabled(profile, PRO_FLAG.id),
        showRecentExports: true,
        onResume: (entry) => resumeSession(entry.slot),
        onDelete: () => {},
      });
      document.querySelector('dialog.folder-overlay')
        ?.addEventListener('close', async () => { if (!mounted) return; await reload(); render(); }, { once: true });
    }
    root.querySelector('.history-fab')?.addEventListener('click', openHistory);

    // The invariant top-bar wiring - language menu, plus the mobile profile menu (on
    // mobile the avatar opens theme + saved sessions + Settings; on desktop it stays a
    // plain link to the profile page). Same call Tools and Catalog make.
    mountViewTopbar(root, host as ProjectsHost, {
      profileMenu: { savedCount: entries.length, onHistory: openHistory },
    });

    wireDrag(root);
    mountUncatRibbon(root);
    syncBulkBar();   // reflect a selection that survived this re-render
    applyCollabBadges(root);
  }

  // Live-collab badge (plan 100 §4.6; lib/collab-tile-state.ts) - every session
  // tile, in both the grid and the search-results list (sessionResultTile reuses
  // the same sessionTile() shape), gets consulted against the dormant-by-default
  // provider registry. No provider registered anywhere in this repo yet, so
  // renderCollabBadge is always called with an empty peer list and paints
  // nothing - the grid stays byte-identical to before this call existed
  // (pinned by collab-tile-state.test.ts). Called once per render() (wire()'s
  // last step), matching how the rest of this view re-derives its DOM from
  // scratch on every data change rather than patching incrementally.
  function applyCollabBadges(root: HTMLElement): void {
    const provider = getCollabTileProvider();
    for (const tile of root.querySelectorAll<HTMLElement>('.folder-tile[data-kind="session"]')) {
      const slot = tile.dataset.ref;
      renderCollabBadge(tile, slot && provider ? provider.peersFor(slot) : []);
    }
  }

  // (Right-click + long-press → context menu is wired once per mount by the shared
  // wireTileContextMenu above - bound to the persistent viewEl, so it survives the
  // render() that replaces `.projects` and needs no per-render re-wiring here.)

  // ── multi-select gestures (marquee + Shift-range) ───────────────────────────
  // Both live in lib/tile-select.ts, shared verbatim with the Catalogue so the two
  // grids behave identically: drag a box through the gaps between cards to select
  // what it touches, Shift-click a dot to sweep up everything back to the anchor.
  // Wired ONCE per mount against viewEl - render() replaces the `.projects` root,
  // so a listener bound in wire() would be orphaned (and re-wiring per render would
  // reset the Shift-anchor mid-gesture).
  const selectableTiles = (): HTMLElement[] =>
    [...viewEl.querySelectorAll<HTMLElement>('.folder-tile[data-ref][data-kind]')]
      .filter(t => !t.classList.contains('folder-tile--uncat') && !t.classList.contains('folder-tile--create'));

  const tileSelect = wireTileSelect({
    host: viewEl,
    tiles: selectableTiles,
    refOf: (t) => t.dataset.ref!,
    current: () => new Set(selected.keys()),
    // Reconcile the Map to exactly `refs` (the kind is read back off each tile), then
    // repaint every tile in place - a full render() would drop scroll/focus mid-drag.
    setRefs: (refs) => {
      selected.clear();
      for (const t of selectableTiles()) {
        const ref = t.dataset.ref!;
        if (refs.has(ref)) selected.set(ref, t.dataset.kind as SelectKind);
      }
      for (const t of viewEl.querySelectorAll<HTMLElement>('.folder-tile[data-ref]')) {
        const on = selected.has(t.dataset.ref!);
        t.classList.toggle('is-selected', on);
        t.querySelector('.tile-check')?.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      syncBulkBar();
    },
    clear: () => { dropSelection(); render(); },
    // Never start a box on a tile, control, chip, bar, breadcrumb, etc. - only in a gap.
    noStart: '.folder-tile, button, a, input, label, dialog, .projects-bulkbar, .projects-rail, .projects-crumbs, .projects-head, .gallery-topbar',
  });

  // Empty the selection AND forget the Shift-anchor together. They have to move as one:
  // an anchor left behind by a cleared selection would silently become the far end of the
  // next Shift-click's range, selecting a swathe the user never started.
  function dropSelection(): void {
    selected.clear();
    tileSelect.resetAnchor();
  }

  // Escape drops the selection (yielding to any open menu/dialog/field first) - 
  // the keyboard exit the ✕ button and an empty-canvas click already provide.
  const unwireEscape = wireEscapeClearsSelection({
    active: () => mounted && selected.size > 0,
    clear: () => { dropSelection(); render(); },
  });

  // Toggle one tile's membership in `selected` and update just that tile + the bulk bar
  // in place (a full render() would drop scroll position / focus and interrupt a drag).
  function toggleSelect(btn: HTMLElement): void {
    const ref = btn.dataset.select!;
    const kind = btn.dataset.kind as SelectKind;
    if (selected.has(ref)) selected.delete(ref); else selected.set(ref, kind);
    const on = selected.has(ref);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.closest('.folder-tile')?.classList.toggle('is-selected', on);
    syncBulkBar();
  }

  // Bulk-bar dispatch. Each action re-checks `mounted` after awaits and clears the
  // selection once applied.
  function handleBulk(action: string): void {
    if (action === 'clear') { dropSelection(); render(); return; }
    if (action === 'render') { renderSelection(); return; }
    if (action === 'edit') { editSelection(); return; }
    if (action === 'sheet') { editAsSheet(); return; }
    if (action === 'move') { moveSelection(); return; }
    if (action === 'newfolder') { newFolderFromSelection(); return; }
    if (action === 'delete') { deleteSelection(); return; }
  }

  // ── drag-and-drop: drag a session OR a sub-folder onto a folder chip / folder tile ──
  function wireDrag(root: HTMLElement): void {
    // Session, image AND real folder tiles are draggable (not the synthetic Uncategorised,
    // not the create tiles). A folder carries 'text/lolly-folder'; a session 'text/lolly-session';
    // an image 'text/lolly-image' - the kind lets the drop target pick store.moveItem's type.
    root.querySelectorAll<HTMLElement>('.folder-tile[data-kind="session"], .folder-tile[data-kind="image"], .folder-tile--folder:not(.folder-tile--uncat)').forEach(tile => {
      const kind = tile.dataset.kind as SelectKind;   // 'folder' | 'session' | 'image'
      const mime = kind === 'folder' ? 'text/lolly-folder' : kind === 'image' ? 'text/lolly-image' : 'text/lolly-session';
      tile.setAttribute('draggable', 'true');
      tile.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData(mime, tile.dataset.ref!);
        e.dataTransfer!.effectAllowed = 'move';
        tile.classList.add('is-dragging');
        root.classList.add(kind === 'folder' ? 'is-dragging-folder' : 'is-dragging-session');
      });
      tile.addEventListener('dragend', () => {
        tile.classList.remove('is-dragging');
        root.classList.remove('is-dragging-session', 'is-dragging-folder');
      });
    });
    // Drop targets: the move-rail chips AND folder tiles (the open-button is the hit area).
    const targets: HTMLElement[] = [
      ...root.querySelectorAll<HTMLElement>('[data-drop-folder]'),
      ...[...root.querySelectorAll('.folder-tile--folder')].map(t => t.querySelector<HTMLElement>('[data-open-folder]')).filter(Boolean) as HTMLElement[],
    ];
    targets.forEach(target => {
      const folderRef = (target.dataset.dropFolder || target.dataset.openFolder)!;
      const hit = target.closest('[data-drop-folder]') || target.closest('.folder-tile');
      target.addEventListener('dragover', (e) => { e.preventDefault(); (e as DragEvent).dataTransfer!.dropEffect = 'move'; hit?.classList.add('is-drop'); });
      target.addEventListener('dragleave', () => hit?.classList.remove('is-drop'));
      target.addEventListener('drop', async (e) => {
        e.preventDefault(); hit?.classList.remove('is-drop');
        const dt = (e as DragEvent).dataTransfer!;
        const slot = dt.getData('text/lolly-session');
        const image = dt.getData('text/lolly-image');
        const draggedFolder = dt.getData('text/lolly-folder');
        const draggedRef = slot || image || draggedFolder;
        if (!draggedRef) return;
        const dest = folderRef === UNCAT ? null : folderRef;
        // Grabbing one tile of a multi-selection drags the WHOLE set - move every
        // selected folder/session/image so they all follow, matching the "Move to…" bar.
        if (selected.size > 1 && selected.has(draggedRef)) {
          await applySelectionMove(dest);
        } else if (slot) {
          await store.moveItem(slot, dest, 'session');
        } else if (image) {
          await store.moveItem(image, dest, 'image');
        } else {
          if (draggedFolder === folderRef) return;   // dropped on itself - no-op
          await store.moveFolder(draggedFolder, dest); // store guards self/descendant cycles
        }
        await reload(); render(); announce(t('Moved'));
      });
    });
  }

  // ── per-tile menu ────────────────────────────────────────────────────────
  // One row of the context menu, icon + label - the shared builder (lib/context-menu.ts).
  const menuItem = menuItemHtml;

  // Content for the per-tile context menu - folder actions or session actions. `kind`/
  // `ref` come through the shared wireTileContextMenu's target: folder or session,
  // "Move to…" opens the drill-down picker (no more flat all-folders-at-once list).
  function tileMenuHtml(kind: string, ref: string): string {
    if (kind === 'folder') {
      return [
        menuItem('open-folder', OPEN_ICON, t('Open')),
        menuItem('rename', EDIT_ICON, t('Rename folder')),
        menuItem('move-folder', MOVE_ICON, t('Move to…')),
        menuItem('render', RENDER_ICON, t('Render folder'), { render: true }),
        menuItem('delete', TRASH_ICON, t('Delete folder'), { danger: true }),
      ].join('');
    }
    if (kind === 'image') {
      // A catalog reference can be REMOVED from the folder (it's a pointer, never deleted);
      // your own upload is permanently DELETED. deleteImage() picks the right one by ref.
      const isUpload = ref.startsWith('user/');
      return [
        menuItem('open-image', OPEN_ICON, t('Preview')),
        menuItem('move-image', MOVE_ICON, t('Move to…')),
        menuItem('delete-image', TRASH_ICON, isUpload ? t('Delete image') : t('Remove from folder'), { danger: true }),
      ].join('');
    }
    // A batch session is a multi-row group with no single tool URL, so it can't be
    // shared as a link - offer Share only for single-tool sessions.
    const canShare = !isBatchSlot(ref);
    return [
      menuItem('open', OPEN_ICON, t('Open')),
      menuItem('rename-session', EDIT_ICON, t('Rename')),
      menuItem('move', MOVE_ICON, t('Move to…')),
      canShare ? menuItem('share', SHARE_ICON, t('Share link')) : '',
      menuItem('render-session', RENDER_ICON, t('Render'), { render: true }),
      menuItem('delete-session', TRASH_ICON, t('Delete'), { danger: true }),
    ].join('');
  }

  // The context menu for a MULTI-selection (right-clicking a tile that's part of the
  // current selection) - the same actions as the bulk bar, at the cursor. The "{n}
  // selected" head is plain text, not a menuitem - nested in its own role="menu" (the
  // shared wireTileContextMenu demotes the OUTER div to a plain group for bulk menus)
  // so it's a valid sibling instead of an invalid child of the menu - the same
  // reasoning lang-menu.ts's sort-tabs-above-the-list split documents.
  function bulkMenuHtml(): string {
    return `<p class="folder-menu-head">${t('{n} selected', { n: selected.size })}</p>`
      + `<div class="folder-menu-list" role="menu" aria-label="${escape(t('Selection actions'))}">${[
        menuItem('render', RENDER_ICON, t('Render selection'), { render: true }),
        ...(sheetableSelection() ? [menuItem('sheet', SHEET_ICON, t('Edit as sheet'))] : []),
        menuItem('move', MOVE_ICON, t('Move to…')),
        menuItem('newfolder', FOLDER_PLUS_ICON, t('New folder from selection')),
        menuItem('delete', TRASH_ICON, t('Delete'), { danger: true }),
      ].join('')}</div>`;
  }

  // Dispatch a picked context-menu row. The shared wireTileContextMenu has already
  // closed the popover; `target` is null for the bulk menu, else carries the tile's
  // ref + element (tileEl null when the folder-view header ⋯ opened it - those
  // actions fall back to the header <h2>).
  async function onMenuAction(act: string, target: { ref: string; tile: HTMLElement | null } | null): Promise<void> {
    if (!target) { handleBulk(act); return; }
    const { ref, tile: tileEl } = target;
    closeMenu();   // the viewopts popover could be up behind a kebab-opened menu
    // Rename can fire from a folder TILE (root view) or the folder-view header menu
    // button (no enclosing tile) - fall back to the header <h2> in that case.
    if (act === 'rename') startRename(tileEl || viewEl.querySelector<HTMLElement>('.projects-title[data-rename-folder]'), ref);
    else if (act === 'render') renderFolder(ref);
    else if (act === 'delete') deleteFolderCascade(ref);
    else if (act === 'open-folder') { window.location.hash = '#/p/' + ref; }
    else if (act === 'move-folder') {
      // A folder can't move into itself or its own subtree - block those targets.
      const blocked = new Set([ref, ...descendantFolderIds(folders, ref)]);
      openMovePicker({
        title: t('Move folder to…'), blocked,
        onPick: async (dest) => { await store.moveFolder(ref, dest); await reload(); render(); announce(t('Folder moved')); },
      });
    }
    else if (act === 'open') resumeSession(ref);
    else if (act === 'rename-session') startRenameSession(tileEl, ref);
    else if (act === 'move') {
      openMovePicker({
        title: t('Move to…'),
        onPick: async (dest) => { await store.moveItem(ref, dest, 'session'); await reload(); render(); announce(t('Session moved')); },
      });
    }
    else if (act === 'render-session') renderSession(ref);
    else if (act === 'share') shareSession(ref);
    else if (act === 'delete-session') {
      const ok = await confirmDialog({
        title: t('Delete this saved session?'),
        message: t('This permanently deletes the saved session and its preview. This cannot be undone.'),
        confirmLabel: t('Delete'),
      });
      if (ok && mounted) { await host.state.delete(ref).catch(() => {}); await reload(); render(); announce(t('Session deleted')); }
    }
    else if (act === 'open-image') openImagePreview(ref);
    else if (act === 'move-image') {
      openMovePicker({
        title: t('Move to…'),
        onPick: async (dest) => { await store.moveItem(ref, dest, 'image'); await reload(); render(); announce(t('Image moved')); },
      });
    }
    else if (act === 'delete-image') { await deleteImage(ref); }
  }

  // Remove a folder image: a catalog REFERENCE just leaves the folder (the shared asset is
  // never deleted); your own upload is permanently deleted (matching the picker / gallery).
  async function deleteImage(ref: string): Promise<void> {
    const isUpload = ref.startsWith('user/');
    const ok = await confirmDialog(isUpload
      ? { title: t('Delete this image?'), message: t('This permanently deletes the saved image. This cannot be undone.'), confirmLabel: t('Delete') }
      : { title: t('Remove from folder?'), message: t('This removes the catalog asset from this folder. The asset itself is unchanged.'), confirmLabel: t('Remove') });
    if (!ok || !mounted) return;
    if (isUpload) await (host as ProjectsHost).assets._deleteUserAsset(ref).catch(() => {});
    else { const owner = ownerByRef.get(ref); if (owner) await store.removeItem(owner.id, ref); }
    await reload(); render();
    announce(isUpload ? t('Image deleted') : t('Removed from folder'));
  }

  // A lightbox preview for a folder image - the resolved AssetRef carries the url + name.
  // Modal chrome + Escape-to-close come from mountModal (matching the app-wide convention).
  function openImagePreview(ref: string): void {
    const a = imageRefs.get(ref);
    if (!a?.url) return;
    const name = String(a.meta?.name ?? '');
    const modal = mountModal<void>(
      `<figure class="projects-imgpreview">
        <img src="${escape(a.url)}" alt="${escape(name)}" decoding="async">
        ${name ? `<figcaption>${escape(name)}</figcaption>` : ''}
      </figure>`,
      { className: 'projects-imgpreview-modal', ariaLabel: name || t('Image preview') },
    );
    overlayModal = modal;
    modal.el.querySelector('.projects-imgpreview')?.addEventListener('click', () => modal.close());
  }

  // Open the per-tile context menu from a ⋯ kebab button (anchored below it, with the
  // button as the focus-restore delegate). Right-click/long-press opens are handled by
  // the shared wireTileContextMenu delegation directly. tileEl is the enclosing
  // .folder-tile (null for the folder-view header ⋯, which falls back to <h2>).
  function openMenu({ ref, kind, tileEl = null, anchorEl = null, x, y }: { ref: string; kind: string; tileEl?: HTMLElement | null; anchorEl?: HTMLElement | null; x: number; y: number }): void {
    closeMenu();
    tileMenu.openAt(x, y, { ref, tile: tileEl, data: kind }, anchorEl);
  }

  // ── drill-down "Move to" picker ─────────────────────────────────────────────
  // A native <dialog> that navigates the folder tree one level at a time (rather than
  // dumping every folder at once): click a folder to drill in, breadcrumb to climb, then
  // "Move to «here»" commits at the current level. `blocked` folder ids (a folder's own
  // subtree, to prevent a cycle) are shown disabled. onPick(destId|null) - null = top level.
  function openMovePicker({ title, blocked = new Set<string>(), onPick }: { title: string; blocked?: Set<string>; onPick: (dest: string | null) => void }): void {
    closeMenu();
    let cursor: string | null = null; // current folder id (null = top level)

    const render = (): string => {
      const kids = sortFolders(childFolders(folders, cursor));
      const path = cursor ? folderPath(folders, cursor) : [];
      const curName = cursor ? (path[path.length - 1]?.name ?? t('Folder')) : t('Top level');
      const canDropHere = cursor == null || !blocked.has(cursor);
      return `
        <div class="movepicker-head">
          <h2 class="movepicker-title">${escape(title)}</h2>
          <button type="button" class="movepicker-close" aria-label="${escape(t('Close'))}">✕</button>
        </div>
        <nav class="movepicker-crumbs" aria-label="${escape(t('Folder path'))}">
          <button type="button" class="movepicker-crumb${cursor == null ? ' is-current' : ''}" data-cursor="">${t('Projects')}</button>
          ${path.map(f => `<span class="projects-crumb-sep" aria-hidden="true">/</span><button type="button" class="movepicker-crumb${f.id === cursor ? ' is-current' : ''}" data-cursor="${escape(f.id)}">${escape(f.name)}</button>`).join('')}
        </nav>
        <div class="movepicker-list">
          ${kids.length ? kids.map(f => {
            const isBlocked = blocked.has(f.id);
            const kidCount = childFolders(folders, f.id).length;
            return `<button type="button" class="movepicker-row${isBlocked ? ' is-blocked' : ''}" data-into="${escape(f.id)}"${isBlocked ? ' disabled' : ''}>
              <span class="movepicker-row-icon" aria-hidden="true">${FOLDER_ICON}</span>
              <span class="movepicker-row-name">${escape(f.name)}</span>
              ${kidCount ? `<span class="movepicker-row-chev" aria-hidden="true">${CHEVRON_ICON}</span>` : ''}
            </button>`;
          }).join('') : `<p class="movepicker-empty">${t('No sub-folders here.')}</p>`}
        </div>
        <div class="movepicker-foot">
          <button type="button" class="btn movepicker-cancel">${t('Cancel')}</button>
          <button type="button" class="btn projects-render movepicker-confirm"${canDropHere ? '' : ' disabled'}>${t('Move to {name}', { name: curName })}</button>
        </div>`;
    };

    // Focus the first meaningful control so keyboard users don't land on <body> or the ✕:
    // a folder to drill into, else the "Move to …" confirm, else the dialog shell itself
    // (kept tabbable via tabIndex=-1, set once on mount below).
    const focusFirst = (el: HTMLDialogElement): HTMLElement =>
      el.querySelector<HTMLElement>('.movepicker-row:not([disabled])')
        ?? el.querySelector<HTMLElement>('.movepicker-confirm:not([disabled])')
        ?? el;

    const modal = mountModal<void>(render(), {
      className: 'projects-movepicker',
      initialFocus: (el) => { el.tabIndex = -1; return focusFirst(el); },
      onClose: () => { if (overlayModal === modal) overlayModal = null; },
    });
    overlayModal = modal;

    const redraw = (): void => {
      modal.el.innerHTML = render();
      // Keep keyboard focus inside the picker after a redraw (drill-in / crumb climb).
      if (modal.el.open) focusFirst(modal.el).focus({ preventScroll: true });
    };

    modal.el.addEventListener('click', (e) => {
      const crumb = (e.target as HTMLElement).closest<HTMLElement>('[data-cursor]');
      if (crumb) { cursor = crumb.dataset.cursor || null; redraw(); return; }
      const into = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-into]');
      if (into && !into.disabled) { cursor = into.dataset.into!; redraw(); return; }
      if ((e.target as HTMLElement).closest('.movepicker-close, .movepicker-cancel')) { modal.close(); return; }
      if ((e.target as HTMLElement).closest('.movepicker-confirm:not([disabled])')) { const dest = cursor; modal.close(); onPick(dest); return; }
    });
  }

  // A tiny name prompt (New folder from selection). Resolves the trimmed name, or null.
  function promptFolderName(): Promise<string | null> {
    return new Promise((resolve) => {
      closeMenu();
      const content = `
        <h2 class="modal-title">${t('New folder')}</h2>
        <input class="projects-name-input projects-prompt-input" type="text" placeholder="${escape(t('Folder name'))}" maxlength="60" aria-label="${escape(t('Folder name'))}">
        <div class="modal-actions">
          <button type="button" class="btn" data-act="cancel">${t('Cancel')}</button>
          <button type="button" class="btn projects-render" data-act="ok">${t('Create')}</button>
        </div>`;
      // Resolves null however the dialog closes (Cancel, Escape, backdrop, or _cleanup
      // calling modal.close() on navigate-away) so the awaiting newFolderFromSelection()
      // never hangs - cancelValue + onClose cover every path, mountModal is idempotent.
      const modal = mountModal<string | null>(content, {
        className: 'modal projects-prompt',
        cancelValue: null,
        initialFocus: (el) => el.querySelector<HTMLElement>('input'),
        onClose: (result) => { if (overlayModal === modal) overlayModal = null; resolve(result || null); },
      });
      overlayModal = modal;
      const input = modal.el.querySelector('input')!;
      modal.el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'ok') return modal.close(input.value.trim());
        if (act === 'cancel') return modal.close(null);
      });
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') modal.close(input.value.trim()); });
    });
  }

  // The gallery-style filter button → a popover to switch view mode (Preview/List) and
  // sort (Name / Date added / Last modified / By tool). Preference persists in localStorage.
  function openViewOpts(btn: HTMLElement): void {
    closeMenu();
    const atRoot = folderId == null;
    const opt = (on: boolean, attr: string, val: string, label: string): string =>
      `<button type="button" class="folder-menu-item${on ? ' is-on' : ''}" data-${attr}="${val}">${on ? '✓ ' : '  '}${label}</button>`;
    // (The Uncategorised preview-strip Gallery↔Cover-Flow switch is no longer a menu item - 
    // it's a .view-seg segmented control below the ribbon, matching the catalog.)
    const pop = document.createElement('div');
    pop.className = 'folder-menu projects-viewmenu';
    pop.innerHTML = `
      ${themeSegmentHtml('folder-menu-head')}
      <p class="folder-menu-head">${t('View')}</p>
      ${opt(viewMode === 'preview', 'vm', 'preview', t('Preview'))}
      ${opt(viewMode === 'list', 'vm', 'list', t('List'))}
      <p class="folder-menu-head">${t('Sort')}</p>
      ${opt(sortBy === 'name', 'sort', 'name', t('Name'))}
      ${opt(sortBy === 'added', 'sort', 'added', t('Date added'))}
      ${opt(sortBy === 'modified', 'sort', 'modified', t('Last modified'))}
      ${atRoot ? '' : opt(sortBy === 'tool', 'sort', 'tool', t('By tool'))}
      ${soundSegmentHtml('folder-menu-head')}`;
    document.body.appendChild(pop);
    wireThemeSegment(pop, host as unknown as Parameters<typeof wireThemeSegment>[1]);   // Theme picker atop the menu
    wireSoundSegment(pop, host as unknown as Parameters<typeof wireSoundSegment>[1]);   // Sound on/off segment
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6 + window.scrollY)}px`;
    pop.style.left = `${Math.round(Math.min(r.left, window.innerWidth - pop.offsetWidth - 12) + window.scrollX)}px`;
    openPopover = pop;
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onMenuKey, true);
    pop.addEventListener('click', (e) => {
      const vm = (e.target as HTMLElement).closest<HTMLElement>('[data-vm]'); const so = (e.target as HTMLElement).closest<HTMLElement>('[data-sort]');
      if (vm) { viewMode = vm.dataset.vm as ViewMode; try { localStorage.setItem('lolly:projectsView', viewMode); } catch { /* ignore */ } closeMenu(); render(); }
      else if (so) { sortBy = so.dataset.sort as SortBy; try { localStorage.setItem('lolly:projectsSort', sortBy); } catch { /* ignore */ } closeMenu(); render(); }
    });
  }

  // ── create / rename ────────────────────────────────────────────────────────
  // Wire an inline name <input> to commit-on-Enter/blur, cancel-on-Escape (once).
  function wireNameInput(input: HTMLInputElement, onCommit: (name: string) => void | Promise<void>): void {
    input.focus(); input.select?.();
    let done = false;
    const commit = async (): Promise<void> => { if (done) return; done = true; await onCommit(input.value.trim()); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit(); else if (e.key === 'Escape') { done = true; render(); }
    });
    input.addEventListener('blur', commit);
  }

  function startCreateFolder(tile: HTMLElement): void {
    // Replace the whole tile (NOT just .tile-meta): the input must not live inside the
    // <button class="tile-primary"> or Space/Enter would also activate the button.
    tile.classList.add('is-editing');
    tile.removeAttribute('data-create');
    tile.innerHTML = `
      <span class="tile-cover tile-cover--create" aria-hidden="true">${FOLDER_PLUS_ICON}</span>
      <div class="tile-meta"><input class="projects-name-input" type="text" placeholder="${escape(t('Folder name'))}" aria-label="${escape(t('New folder name'))}" maxlength="60"></div>`;
    // Inside a real folder, the new folder nests here (parentId); at root / Uncategorised
    // it's a top-level folder.
    const parent = (folderId && folderId !== UNCAT) ? folderId : null;
    wireNameInput(tile.querySelector('input')!, async (name) => {
      if (name) { try { await store.create(name, parent); } catch { /* empty name */ } }
      await reload(); render();
    });
  }

  function startRename(tile: HTMLElement | null, id: string | undefined): void {
    if (!id || id === UNCAT) return;
    const f = folders.find(x => x.id === id); if (!f) return;
    const onCommit = async (name: string): Promise<void> => {
      if (name && name !== f.name) { try { await store.rename(id, name); announce(t('Folder renamed')); } catch { /* empty */ } }
      await reload(); render();
    };
    if (tile?.matches?.('[data-rename-folder]')) {
      // Folder-view header: the title is an <h2> (not inside a button) - swap it directly.
      const input = document.createElement('input');
      input.className = 'projects-name-input'; input.value = f.name; input.maxLength = 60;
      input.setAttribute('aria-label', t('Folder name'));
      tile.replaceWith(input);
      wireNameInput(input, onCommit);
    } else if (tile) {
      // Root folder tile: replace the whole tile so the input isn't nested in the button.
      tile.classList.add('is-editing');
      tile.innerHTML = `
        <span class="tile-cover tile-cover--batch" aria-hidden="true">${FOLDER_ICON}</span>
        <div class="tile-meta"><input class="projects-name-input" type="text" maxlength="60" aria-label="${escape(t('Folder name'))}"></div>`;
      const input = tile.querySelector('input')!;
      input.value = f.name;
      wireNameInput(input, onCommit);
    }
  }

  // Rename a saved session in place. For a single-tool session the name IS the export
  // filename (host.state.list().filename = data.__export_filename), so the rename rewrites
  // both __export_filename and __label - the displayed name AND every future export (a
  // single download, or a folder "Render" batch row via folder-rows.js) use the new name.
  function startRenameSession(tile: HTMLElement | null, slot: string): void {
    const e = entryBySlot().get(slot); if (!tile || !e) return;
    const current = e.label || e.filename || toolName(e.toolId) || '';
    // Replace the WHOLE tile (the title lives inside the <button>; an input nested there
    // would let Space/Enter activate the button - see startCreateFolder).
    const cover = tile.querySelector('.tile-cover, .folder-mosaic')?.outerHTML || '';
    tile.classList.add('is-editing');
    tile.innerHTML = `${cover}<div class="tile-meta"><input class="projects-name-input" type="text" maxlength="80" aria-label="${escape(t('Session name'))}"></div>`;
    const input = tile.querySelector('input')!;
    input.value = current;
    wireNameInput(input, async (name) => {
      if (name && name !== current) { await applySessionRename(e, name); announce(t('Session renamed')); }
      await reload(); render();
    });
  }

  async function applySessionRename(entry: Entry, name: string): Promise<void> {
    try {
      const data = await (host as ProjectsHost).state.load(entry.slot);
      if (!data) return;
      data.__label = name;
      if (isBatchSlot(entry.slot)) {
        // A batch slot encodes its label → re-key under a new slot + follow membership.
        const newSlot = BATCH_SLOT_PREFIX + name;
        if (newSlot !== entry.slot) {
          await (host as ProjectsHost).state.save(newSlot, data, entry.thumb);
          await host.state.delete(entry.slot).catch(() => {});
          await store.swapSessionSlot(entry.slot, newSlot);
        } else {
          await (host as ProjectsHost).state.save(entry.slot, data, entry.thumb);
        }
      } else {
        data.__export_filename = name;   // the export filename for single-tool sessions
        await (host as ProjectsHost).state.save(entry.slot, data, entry.thumb);
      }
    } catch (e) { if (host.log) host.log('warn', 'projects: rename failed', { error: String(e) }); }
  }

  // "+ New asset": open the shared, host-owned asset picker (the SAME Library / Saved
  // creations / Projects / Tools dialog that fills a tool image slot) in "collect into
  // this folder" mode. Every pick ADDS to the current folder and the dialog stays open
  // for several in a row: a Library/your-images/uploaded/rendered image is filed as an
  // image item (catalog assets by reference - no duplicate bytes), a saved creation is
  // filed as an editable session, and a tool either opens its editor (files in on first
  // save) or "+ Add"s a default-settings session. Standardised in one component, so the
  // UX improves everywhere at once (replaces the old bespoke tools-only chooser).
  function startCreateTool(): void { void openAddPicker(); }

  async function openAddPicker(): Promise<void> {
    // A real folder is the drop target; at the root / the synthetic Uncategorised bucket
    // there's no folder to hold an image (catalog references especially have nowhere to
    // live loose), so image adds are declined there with a nudge while tool + saved-
    // creation adds still work (they file loose = Uncategorised).
    const target = (folderId && folderId !== UNCAT) ? folderId : null;
    const folderName = target ? (folders.find(f => f.id === target)?.name || t('this folder'))
      : folderId === UNCAT ? t('Uncategorised') : t('Projects');
    // Projects are creations you file, not on-device transforms - offer every non-utility
    // tool (a superset of the picker's image-embeddable set, so audio/video tools show too).
    const tools = ((w.__toolIndex?.tools ?? []) as unknown as ProjectsTool[]).filter(x => x.category !== 'utility');
    // Fold in the user's own saved tools (lib/user-tools) as extra tool cards under the "Your
    // tools" category. Their id is namespaced (usertool:<id>), so onOpenTool / onQuickAddTool
    // below route them through their BASE tool seeded with the saved values - never the
    // synthetic id, which no tool loader could resolve. Kept LOCAL to this picker's tool list
    // (not merged into window.__toolIndex, which ~17 other readers consume), so nothing else
    // has to become user-tool-aware. Best-effort: a load failure just omits them.
    const userToolById = new Map<string, ProjectedUserTool>();
    try {
      const { createUserToolStore, projectUserTool } = await import('../lib/user-tools.ts');
      const mine = await createUserToolStore(host as unknown as Parameters<typeof createUserToolStore>[0]).list();
      for (const ut of mine) {
        const p = projectUserTool(ut);
        userToolById.set(p.id, p);
        tools.push({ id: p.id, name: p.name, description: p.description, category: p.category, icon: p.icon, formats: p.formats });
      }
    } catch (err) { host.log?.('warn', 'projects: user tools load failed', { error: String(err) }); }
    // Lazy chunk - the shared picker (DOMPurify, engine, its own CSS) stays out of the
    // Projects boot chunk, loaded only when the add flow actually opens (matches how the
    // bridge's host.assets.pick and this view's other heavy actions import on demand).
    const { openPicker } = await import('./picker.ts');
    await openPicker(host as unknown as PickerHost, {
      allowUpload: true,
      collect: {
        folderName,
        tools,
        onAsset: async (ref) => {
          // Images (catalog references especially) need a real folder to live in - the
          // root and the synthetic Uncategorised bucket can't hold one. Decline with a nudge.
          if (!target) return { ok: false, label: t('Open a folder to add images') };
          // A user upload (user/…) is owned bytes; a catalog id is a reference. Both are
          // stored as the folder's image item by id - reconciliation keeps either kind.
          await store.addItem(target, { type: 'image', ref: ref.id });
          return { ok: true };
        },
        onSession: async (slot) => {
          await store.moveItem(slot, target, 'session');   // target null → filed loose (Uncategorised)
          return { ok: true };
        },
        onOpenTool: (toolId) => {
          // A user tool opens its BASE tool seeded with its saved values, via the same
          // in-memory pending-seed the drop/PSD route uses (the mount consumes it as
          // `seededDirect`, so no URL packing and no chooser). A real tool opens as before.
          const ut = userToolById.get(toolId);
          const openId = ut ? ut.userTool.baseToolId : toolId;
          if (ut) setPendingToolSeed(openId, ut.userTool.values);
          try { sessionStorage.setItem(FILE_INTO_KEY, target ?? ''); } catch { /* private mode */ }
          armReturn();
          window.location.hash = '#/tool/' + openId;
        },
        onQuickAddTool: async (toolId) => {
          try {
            // A user tool IS a specific seed, so it quick-adds its base tool + saved values
            // straight away (no default-or-variation step). A real tool offers that chooser.
            const ut = userToolById.get(toolId);
            if (ut) { await addDefaultSession(ut.userTool.baseToolId, ut.userTool.values); return { ok: true }; }
            const choice = await chooseAddSeed(toolId);
            if (choice.cancelled) return { ok: false, silent: true };   // chooser dismissed → no toast
            await addDefaultSession(toolId, choice.values);
            return { ok: true };
          }
          catch (err) { host.log?.('warn', 'projects: quick-add failed', { tool: toolId, error: String(err) }); return { ok: false }; }
        },
      },
    });
    // The picker closed (× / Escape / a tool that navigated away) - reflect everything
    // added under it in one pass.
    if (mounted) { await reload(); render(); }
  }

  // Create a saved session for `toolId` and file it into the current folder. With no seed it
  // is the tool's RESOLVED defaults (createRuntime alone runs onInit + profile binding, no
  // offscreen render); with a seed (a saved user template/variation) the runtime is born with
  // those input values, exactly the way the template chooser seeds a fresh mount. No thumbnail:
  // a fresh session shows the standard placeholder cover until it's opened and saved. The
  // caller re-renders once the picker closes.
  async function addDefaultSession(toolId: string, seedValues?: Record<string, unknown>): Promise<void> {
    const tool = await getTool(toolId);
    const runtime = await createRuntime(tool, host, (seedValues ?? {}) as Parameters<typeof createRuntime>[2]);
    const values = Object.fromEntries(runtime.getModel().map(i => [i.id, i.value]));
    // getModel returns only declared inputs, so carry any __-prefixed export markers the seed
    // brought (a saved template may store them beside its input values) through separately.
    const markers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(seedValues ?? {})) if (k.startsWith('__')) markers[k] = v;
    const slot = `${tool.manifest.id}:${Date.now()}`;
    await (host as ProjectsHost).state.save(slot, {
      ...values,
      ...markers,
      __toolId:        tool.manifest.id,
      __toolVersion:   tool.manifest.version,
      __export_format: (markers.__export_format as string) || tool.manifest.render?.formats?.[0] || '',
    }, '');
    const target = (folderId && folderId !== UNCAT) ? folderId : null;
    if (target) await store.moveItem(slot, target, 'session');
  }

  // Quick-add intermediate step: when a tool has saved templates/variations, offer a tiny
  // chooser (the tool's default settings, or one of the user's saved variations) and return
  // the seed values to hand addDefaultSession. A tool with NONE resolves straight to the
  // default (no extra step, exactly as before). `cancelled` is true only when the chooser was
  // actually shown and dismissed, so the caller can stay silent instead of flashing a failure.
  async function chooseAddSeed(toolId: string): Promise<{ cancelled: boolean; values?: Record<string, unknown> }> {
    let mine: UserTemplate[] = [];
    try {
      const { createUserTemplateStore } = await import('../lib/user-templates.ts');
      mine = await createUserTemplateStore(host as unknown as Parameters<typeof createUserTemplateStore>[0]).list(toolId);
    } catch { /* best-effort - fall through to the default add */ }
    if (!mine.length) return { cancelled: false };   // nothing saved → default, no extra step
    closeMenu();
    const toolName = nameById.get(toolId) || toolId;
    const chosen = await choiceDialog({
      title: tRaw('Add {tool}', { tool: toolName }),
      message: t('Start from the default, or one of your saved variations.'),
      choices: [
        { id: '__default__', label: t('Default settings'), primary: true },
        ...mine.map(ut => ({ id: ut.id, label: ut.name })),
      ],
    });
    if (chosen === null) return { cancelled: true };            // Cancel / Escape / backdrop
    if (chosen === '__default__') return { cancelled: false };  // resolved defaults
    return { cancelled: false, values: mine.find(x => x.id === chosen)?.values };
  }

  // Arm the return target so the tool's Save button lands back on this exact page - 
  // root `/#/p`, the Uncategorised view, or a specific folder. navigateTo-compatible URL.
  function armReturn(): void {
    armSessionReturn('/#/p' + (folderId ? '/' + folderId : ''));
  }

  function resumeSession(slot: string): void {
    closeMenu();
    const batch = isBatchSlot(slot);
    if (!batch) armReturn();   // a batch grid opens in /pro, which owns its own return
    window.location.hash = sessionOpenHref({ slot, toolId: entryBySlot().get(slot)?.toolId || '' }, batch);
  }

  // The href resumeSession() ends up at (the shared sessionOpenHref - same target the
  // spotlight's projects provider uses) - set on the preview-ribbon tiles so a
  // middle-click / no-JS open still lands right (the click handler routes clean taps
  // through resumeSession so Save returns here, but the anchor is the accessible fallback).
  const resumeHref = (e: Entry): string => sessionOpenHref(e, isBatchSlot(e.slot));

  // The gallery persists the Featured strip's view mode (Gallery drift | Cover Flow); the
  // Uncategorised ribbon reads the same key so a mode chosen there carries over.
  function readFeaturedView(): FeaturedViewMode {
    try {
      const v = localStorage.getItem(FEATURED_VIEW_STORAGE);
      if (v && (FEATURED_VIEWS as readonly string[]).includes(v)) return v as FeaturedViewMode;
    } catch { /* storage off */ }
    return 'gallery';
  }

  // Hydrate the Uncategorised preview ribbon: the shared Featured strip over the loose
  // sessions (same drift / Cover Flow / mobile grip). Re-mounted each render; the prior
  // handle is destroyed at the top of render() so its rAF loop + listeners don't leak.
  function mountUncatRibbon(root: HTMLElement): void {
    const mount = root.querySelector<HTMLElement>('[data-uncat-ribbon]');
    if (!mount) return;
    const tiles: FeaturedEntry[] = sortSessions(uncategorised()).map(e => {
      const name = e.label || e.filename || toolName(e.toolId);
      const tn = toolName(e.toolId);
      return {
        id: e.slot,
        name,
        preview: e.thumb || undefined,
        href: resumeHref(e),
        featured: { blurb: name !== tn ? tn : undefined },
      };
    });
    if (!tiles.length) return;
    featuredHandle = mountFeaturedRow(mount, tiles, host, {
      viewMode: readFeaturedView(),
      ariaLabel: t('Uncategorised previews'),
      tileDragOut: true,
      tileMenu: true,
    });
    // A ⋯ button on every ribbon preview opens the SAME actions menu (Open · Rename · Move to
    // folder… · Render · Delete) the grid session tiles get - the touch-friendly path to
    // organising loose sessions that also works in Cover Flow, where drag-to-folder can't
    // (native HTML5 drag is mouse-only and fights the 3D pointer capture). Delegated on the
    // persistent mount so it survives the strip's clone / view-mode rebuilds.
    mount.addEventListener('click', (e) => {
      const btn = (e.target as Element | null)?.closest?.<HTMLElement>('.ftile-menu');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const tile = btn.closest<HTMLElement>('.ftile');
      const slot = tile?.dataset.tool;
      if (!slot) return;
      const r = btn.getBoundingClientRect();
      openMenu({ ref: slot, kind: 'session', tileEl: tile, anchorEl: btn, x: r.left, y: r.bottom + 6 });
    });
    // Each ribbon preview is also a drag source for the "Move to" rail (desktop) - same payload
    // a grid session tile carries (wireDrag), so the shared drop targets move it with no extra
    // wiring. Delegated on the persistent mount so it survives the strip's clone rebuilds
    // on a Gallery↔Cover-Flow switch. The tile's data-tool is the session slot.
    mount.addEventListener('dragstart', (e) => {
      const tile = (e.target as Element | null)?.closest?.<HTMLElement>('.ftile');
      const slot = tile?.dataset.tool;
      if (!tile || !slot) return;
      (e as DragEvent).dataTransfer!.setData('text/lolly-session', slot);
      (e as DragEvent).dataTransfer!.effectAllowed = 'move';
      tile.classList.add('is-dragging');
      root.classList.add('is-dragging-session');   // lights up the rail chips (see projects.css)
    });
    mount.addEventListener('dragend', (e) => {
      (e.target as Element | null)?.closest?.<HTMLElement>('.ftile')?.classList.remove('is-dragging');
      root.classList.remove('is-dragging-session');
    });
  }

  // ── delete a folder AND everything inside it (its WHOLE subtree) ────────────
  // Unlike store.remove() (which only drops one record and lifts its contents up), this
  // permanently deletes the folder, every SUB-FOLDER beneath it, and every saved session
  // and image they hold - including stored previews - then the folder records. Confirmed.
  async function deleteFolderCascade(id: string): Promise<void> {
    closeMenu();
    if (!id || id === UNCAT) return;
    const folder = folders.find(f => f.id === id);
    if (!folder) return;
    // The whole subtree: this folder + all descendants, and every item they contain.
    const subtreeIds = [id, ...descendantFolderIds(folders, id)];
    const subtree = folders.filter(f => subtreeIds.includes(f.id));
    const items = subtree.flatMap(f => f.items ?? []);
    const subCount = subtreeIds.length - 1;            // sub-folders beneath this one
    const n = items.length;                            // sessions + images across the subtree
    const parts: string[] = [];
    if (subCount) parts.push(subCount === 1 ? t('1 sub-folder') : t('{n} sub-folders', { n: subCount }));
    if (n) parts.push(n === 1 ? t('1 item (saved sessions and images, including previews)') : t('{n} items (saved sessions and images, including previews)', { n }));
    const ok = await confirmDialog({
      title: tRaw('Delete “{name}”?', { name: folder.name }),
      message: parts.length
        ? tRaw('This permanently deletes the folder, {parts}. This cannot be undone.', { parts: parts.join(t(' and ')) })
        : t('This permanently deletes the folder. This cannot be undone.'),
      confirmLabel: t('Delete folder'),
    });
    if (!ok || !mounted) return;
    for (const it of items) {
      try {
        // A catalog reference owns no bytes - removeSubtree drops its folder membership;
        // only an uploaded image (user/…) is a real asset to delete.
        if (it.type === 'image') { if (it.ref.startsWith('user/')) await (host as ProjectsHost).assets._deleteUserAsset(it.ref); }
        else await host.state.delete(it.ref);
      } catch (err) { host.log?.('warn', 'projects: folder item delete failed', { ref: it.ref, error: String(err) }); }
    }
    await store.removeSubtree(id);
    announce(tRaw('Folder “{name}” deleted', { name: folder.name }));
    if (!mounted) return;
    // If we were viewing the deleted folder (or one now-deleted beneath it), climb to its
    // parent (or root); otherwise just re-render in place.
    if (folderId != null && subtreeIds.includes(folderId)) {
      const parentId = folder.parentId ?? null;
      window.location.hash = parentId ? `#/p/${parentId}` : '#/p';
      return;
    }
    await reload(); render();
  }

  const authorForExport = (): Profile | null => (profile?.useDetails ? profile : null);

  // Every render/export path (folder, single session, selection) runs inside the shared
  // progress toast (components/progress-toast.ts) - full-width `--bar` variant under the
  // profile row (projects.css), tracked in `toasts` so navigate-away tears it down
  // (_cleanup). `run(mount)` does the gated /pro export; errors surface in the toast.
  function renderViaToast(run: (mount: HTMLElement) => unknown): void {
    closeMenu();
    mountProgressToast(run, { variant: 'bar', track: toasts });
  }

  // ── render a whole folder as one nested batch zip (gated /pro import) ────────
  async function renderFolder(id: string): Promise<void> {
    closeMenu();
    const isUncat = id === UNCAT;
    const folder = isUncat
      ? { name: t('Uncategorised'), items: uncategorised().map(e => ({ type: 'session', ref: e.slot })) } as Folder
      : folders.find(f => f.id === id);
    if (!folder) return;
    // A folder is renderable if its WHOLE subtree (it + descendants) holds any items.
    const subtreeItems = isUncat
      ? folder.items
      : [id, ...descendantFolderIds(folders, id)].flatMap(cid => folders.find(f => f.id === cid)?.items ?? []);
    if (!subtreeItems.length) return;
    // Ask before rendering, and optionally AES-256-lock any PDF members in the zip.
    const { askExportLock } = await import('../lib/export-lock.ts');
    const { ok, strongPassword, zipLock } = await askExportLock(t('this folder'), true);
    if (!ok) return;
    renderViaToast(async (mount) => {
      const { exportFolderAsBatch } = await import('../pro/folder-export.ts');
      await exportFolderAsBatch(host, folder, {
        mount,
        author: authorForExport(),
        folders,   // recurse sub-folders into nested zip paths (Uncategorised has none)
        onBatchRendered: opts.onBatchRendered,
        strongPassword, zipLock,
      });
    });
  }

  // ── render a SINGLE saved session (parity with "Render folder") ─────────────
  // A single-tool session downloads as a bare file (its native format); a batch session
  // falls back to a zip. See pro/folder-export.js renderSessionToFile.
  function renderSession(slot: string): void {
    renderViaToast(async (mount) => {
      const { renderSessionToFile } = await import('../pro/folder-export.ts');
      await renderSessionToFile(host, slot, { mount, author: authorForExport(), onBatchRendered: opts.onBatchRendered });
    });
  }

  // ── share a saved session as a link (same dialog as the tool view's Share) ──
  // Reconstruct the tool's URL state from the saved values (createRuntime →
  // serializeUrlState, the picker's recipe) and hand it to the shared Share dialog.
  async function shareSession(slot: string): Promise<void> {
    closeMenu();
    const entry = entryBySlot().get(slot);
    if (!entry || isBatchSlot(slot)) return;   // batch sessions have no single tool URL
    try {
      const data = await (host as ProjectsHost).state.load(slot);
      if (!data) throw new Error('This saved session could not be loaded.');
      const tool = await getTool(entry.toolId);
      const runtime = await createRuntime(tool, host, data as Parameters<typeof createRuntime>[2]);
      const query = serializeUrlState(runtime.getModel());
      const baseParts = query ? query.split('&') : [];
      // Carry the session's export format so the recipient's link opens on the same one.
      if (data.__export_format) baseParts.push(`format=${encodeURIComponent(data.__export_format as string)}`);
      openShareDialog({
        toolId: entry.toolId, baseParts, manifest: tool.manifest,
        currentFormat: (data.__export_format as string) || '', title: t('Share this creation'),
      });
    } catch (err) {
      host.log?.('warn', 'projects: share session failed', { slot, error: String(err) });
    }
  }

  // ── team projects (control-plane session source; dormant without one) ───────
  // A self-contained modal: browse the instance's shared projects → their
  // sessions → open one into its tool. Opening reuses the SAME reconstruction
  // shareSession() uses (createRuntime → serializeUrlState → navigate), so a team
  // session opens as a fresh working copy at full fidelity (blocks included), with
  // no local slot written. The source is pure data (see lib/session-source.ts).
  const teamRowStyle = 'display:flex;justify-content:space-between;gap:1rem;width:100%;padding:.55rem .7rem;background:none;border:0;border-radius:var(--radius);color:inherit;text-align:left;cursor:pointer;font:inherit';
  async function openTeamProjects(): Promise<void> {
    const src = getSessionSource();
    if (!src) return;
    const modal = mountModal<void>(
      `<div style="min-width:min(30rem,86vw)"><h2 style="margin-top:0">${escape(t('Team projects'))}</h2>
        <div data-team-body><p class="projects-empty">${escape(t('Loading…'))}</p></div></div>`,
      { className: 'team-projects-dialog' },
    );
    const body = modal.el.querySelector<HTMLElement>('[data-team-body]')!;
    // Which project's session list is on screen - the modal is two screens deep and the
    // session rows only carry their own id. Recorded so an opened session can name the
    // project it came from in its origin stash (org/team-session-origin.ts).
    let openProjectId: string | null = null;
    const row = (attr: string, id: string, name: string, meta: string): string =>
      `<li><button type="button" style="${teamRowStyle}" ${attr}="${escape(id)}"
        onmouseover="this.style.background='color-mix(in oklab,currentColor 8%,transparent)'" onmouseout="this.style.background='none'">
        <span>${escape(name)}</span><span style="opacity:.6">${escape(meta)}</span></button></li>`;
    const list = (items: string): string => `<ul style="list-style:none;margin:.4rem 0 0;padding:0;display:flex;flex-direction:column;gap:2px">${items}</ul>`;
    const showProjects = async (): Promise<void> => {
      openProjectId = null;
      const projects = await src.listProjects().catch(() => []);
      if (!modal.el.isConnected) return;
      body.innerHTML = projects.length
        ? list(projects.map(p => row('data-team-project', p.id, p.name, p.sessionCount != null ? t('{n} sessions', { n: String(p.sessionCount) }) : '')).join(''))
        : `<p class="projects-empty">${escape(t('No team projects are shared with you yet.'))}</p>`;
    };
    const showSessions = async (projectId: string, name: string): Promise<void> => {
      openProjectId = projectId;
      body.innerHTML = `<p class="projects-empty">${escape(t('Loading…'))}</p>`;
      const sessions = await src.listSessions(projectId).catch(() => []);
      if (!modal.el.isConnected) return;
      const back = `<button type="button" data-team-back style="background:none;border:0;color:inherit;opacity:.7;cursor:pointer;font:inherit;padding:.2rem 0;margin-bottom:.3rem">${escape(t('← All team projects'))}</button>`;
      body.innerHTML = back + `<h3 style="margin:.1rem 0 .2rem;font-size:1rem">${escape(name)}</h3>` + (sessions.length
        ? list(sessions.map(s => row('data-team-session', s.id, s.label || toolName(s.toolId) || s.toolId, toolName(s.toolId) || s.toolId)).join(''))
        : `<p class="projects-empty">${escape(t('This project has no sessions yet.'))}</p>`);
    };
    body.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const proj = el.closest<HTMLElement>('[data-team-project]');
      if (proj) { void showSessions(proj.dataset.teamProject!, proj.querySelector('span')?.textContent || ''); return; }
      if (el.closest('[data-team-back]')) { void showProjects(); return; }
      const sess = el.closest<HTMLElement>('[data-team-session]');
      if (sess) { modal.close(); void openTeamSession(sess.dataset.teamSession!, openProjectId); }
    });
    void showProjects();
  }

  async function openTeamSession(sessionId: string, projectId?: string | null): Promise<void> {
    const src = getSessionSource();
    if (!src) return;
    try {
      const data = await src.fetchSession(sessionId);
      if (!data) { announce(t('That session is no longer available.')); return; }
      const tool = await getTool(data.toolId);
      const runtime = await createRuntime(tool, host, data.inputs as Parameters<typeof createRuntime>[2]);
      const query = serializeUrlState(runtime.getModel());
      armReturn();
      // The hash below is a faithful working copy that has otherwise forgotten where it
      // came from: the instance's id for this session is not an input and is deliberately
      // not serialised into a link. Hand it to the mount alongside the navigation instead
      // - a one-shot stash the tool view spends on mount, and the only thing that lets the
      // Share dialog's "Work collab" row key a room on the session actually being edited
      // (org/team-session-origin.ts; plans/100 §7). Armed LAST, immediately before the
      // navigation it belongs to, so a failure above leaves nothing armed.
      rememberTeamSessionOrigin({ sessionId, toolId: data.toolId, ...(projectId ? { projectId } : {}) });
      window.location.hash = `#/tool/${data.toolId}${query ? `?${query}` : ''}`;
    } catch (err) {
      host.log?.('warn', 'projects: open team session failed', { sessionId, error: String(err) });
      announce(t('That session could not be opened.'));
    }
  }

  // ── bulk actions over the current multi-selection ───────────────────────────
  // Selected FOLDERS that are descendants of another selected folder are redundant - 
  // the ancestor's subtree already covers them. Drop them so we don't double-process.
  function topLevelSelectedFolders(): string[] {
    const ids = selectedByKind('folder');
    return ids.filter(id => !ids.some(other => other !== id && descendantFolderIds(folders, other).includes(id)));
  }

  async function renderSelection(): Promise<void> {
    const sessionRefs = selectedByKind('session');
    const folderIds = topLevelSelectedFolders();
    if (!sessionRefs.length && !folderIds.length) return;
    const label = folderId && folderId !== UNCAT ? (folders.find(f => f.id === folderId)?.name || t('Selection')) : t('Selection');
    // Ask before rendering, and optionally AES-256-lock any PDF members in the zip.
    const { askExportLock } = await import('../lib/export-lock.ts');
    const { ok, strongPassword, zipLock } = await askExportLock(t('this selection'), true);
    if (!ok) return;
    renderViaToast(async (mount) => {
      const { exportSelectionAsBatch } = await import('../pro/folder-export.ts');
      await exportSelectionAsBatch(host, {
        label, sessionRefs, folderIds, allFolders: folders,
        mount, author: authorForExport(), onBatchRendered: opts.onBatchRendered,
        strongPassword, zipLock,
      });
    });
  }

  // Move EVERY selected item into `dest` (null = root) and clear the selection. Descendant
  // folders of another selected folder are pruned (their ancestor already carries them);
  // store.moveFolder guards self/descendant cycles, so dropping onto a selected folder just
  // leaves it put while its siblings move in. Shared by drag-and-drop and the "Move to…" bar.
  async function applySelectionMove(dest: string | null): Promise<void> {
    for (const ref of selectedByKind('session')) await store.moveItem(ref, dest, 'session');
    for (const ref of selectedByKind('image'))   await store.moveItem(ref, dest, 'image');
    for (const id of topLevelSelectedFolders())  await store.moveFolder(id, dest); // store guards cycles
    dropSelection();
  }

  function moveSelection(): void {
    const folderIds = topLevelSelectedFolders();
    if (!selected.size) return;
    // Can't move a selected folder into itself or any selected folder's subtree.
    const blocked = new Set(folderIds.flatMap(id => [id, ...descendantFolderIds(folders, id)]));
    openMovePicker({
      title: selected.size === 1 ? t('Move 1 item to…') : t('Move {n} items to…', { n: selected.size }), blocked,
      onPick: async (dest) => {
        const n = selected.size;
        await applySelectionMove(dest);
        if (!mounted) return;
        await reload(); render();
        announce(n === 1 ? t('1 item moved') : t('{n} items moved', { n }));
      },
    });
  }

  async function newFolderFromSelection(): Promise<void> {
    if (!selected.size) return;
    const name = await promptFolderName();
    if (!name || !mounted) return;
    const parent = (folderId && folderId !== UNCAT) ? folderId : null;
    const created = await store.create(name, parent);
    for (const ref of selectedByKind('session')) await store.moveItem(ref, created.id, 'session');
    for (const ref of selectedByKind('image'))   await store.moveItem(ref, created.id, 'image');
    for (const id of topLevelSelectedFolders()) { if (id !== created.id) await store.moveFolder(id, created.id); }
    dropSelection();
    if (!mounted) return;
    await reload(); render();
  }

  async function deleteSelection(): Promise<void> {
    const sessionRefs = selectedByKind('session');
    const imageSelRefs = selectedByKind('image');   // standalone-selected folder images
    const folderIds = topLevelSelectedFolders();
    if (!sessionRefs.length && !imageSelRefs.length && !folderIds.length) return;
    // Count everything the delete will remove (subtree items across selected folders +
    // the directly-selected sessions/images).
    const subtreeIds = folderIds.flatMap(id => [id, ...descendantFolderIds(folders, id)]);
    const folderItems = folders.filter(f => subtreeIds.includes(f.id)).flatMap(f => f.items ?? []);
    const totalSessions = sessionRefs.length + folderItems.filter(i => i.type !== 'image').length;
    const totalImages = imageSelRefs.length + folderItems.filter(i => i.type === 'image').length;
    const bits: string[] = [];
    if (folderIds.length) bits.push((folderIds.length === 1 ? t('1 folder') : t('{n} folders', { n: folderIds.length })) + (subtreeIds.length > folderIds.length ? ` ${t('(and everything inside)')}` : ''));
    if (totalSessions) bits.push(totalSessions === 1 ? t('1 saved session') : t('{n} saved sessions', { n: totalSessions }));
    if (totalImages) bits.push(totalImages === 1 ? t('1 image') : t('{n} images', { n: totalImages }));
    const ok = await confirmDialog({
      title: selected.size === 1 ? t('Delete 1 selected item?') : t('Delete {n} selected items?', { n: selected.size }),
      message: tRaw('This permanently deletes {list}, including previews. This cannot be undone.', { list: bits.join(', ') }),
      confirmLabel: t('Delete'),
    });
    if (!ok || !mounted) return;
    announce(selected.size === 1 ? t('1 item deleted') : t('{n} items deleted', { n: selected.size }));
    for (const slot of sessionRefs) await host.state.delete(slot).catch(() => {});
    // A standalone image: an upload is deleted; a catalog reference just leaves its folder.
    for (const ref of imageSelRefs) {
      try {
        if (ref.startsWith('user/')) await (host as ProjectsHost).assets._deleteUserAsset(ref);
        else { const owner = ownerByRef.get(ref); if (owner) await store.removeItem(owner.id, ref); }
      } catch (err) { host.log?.('warn', 'projects: bulk image delete failed', { ref, error: String(err) }); }
    }
    for (const id of folderIds) {
      const items = folders.filter(f => [id, ...descendantFolderIds(folders, id)].includes(f.id)).flatMap(f => f.items ?? []);
      for (const it of items) {
        try {
          if (it.type === 'image') { if (it.ref.startsWith('user/')) await (host as ProjectsHost).assets._deleteUserAsset(it.ref); }
          else await host.state.delete(it.ref);
        }
        catch (err) { host.log?.('warn', 'projects: bulk delete item failed', { ref: it.ref, error: String(err) }); }
      }
      await store.removeSubtree(id);
    }
    dropSelection();
    if (!mounted) return;
    await reload(); render();
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  // Arriving at Projects means we're not mid-"+ New tool" creation, so disarm any
  // stale file-into / return-to markers left by an abandoned flow.
  try { sessionStorage.removeItem(FILE_INTO_KEY); sessionStorage.removeItem(RETURN_KEY); } catch { /* ignore */ }
  // NB tileSelect.destroy() is not optional: its mousedown is bound to viewEl (#view), which
  // the router REUSES for every route - leave it bound and the next mount stacks another.
  (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => { mounted = false; cancelArrivalAah(); tileSelect.destroy(); tileMenu.destroy(); unwireEscape(); featuredHandle?.destroy(); featuredHandle = null; closeMenu(); closeConfirmDialogs(); toasts.forEach(t => t.remove()); toasts.clear(); overlayModal?.close(); releaseSearch?.(); };
  await reload();
  // A stale /p/<id> deep link to a deleted folder falls back to root.
  if (folderId && folderId !== UNCAT && !folders.some(f => f.id === folderId)) folderId = null;
  // Claim the shell search bar AFTER reload() - the scope-aware placeholder needs
  // `folders` (and the deleted-folder fallback above) resolved. NO onQuery (the M2
  // flip, plans/99 §2a): Projects is an overlay-only view, so typing feeds the
  // spotlight and this grid never reshapes under the user's hands. The claim seeds
  // the bar with the ?q= handoff query, and onClear (the bar's ✕/Escape, with no
  // live tap claimed) exits results mode in place.
  releaseSearch = claimSearchBar({
    placeholder: searchPlaceholder(),
    value: query,
    onClear: exitSearch,
  });
  render();
}
