// SPDX-License-Identifier: MPL-2.0
/**
 * Projects view (route /p and /p/<folderId>).
 *
 * A gallery-style page over the FOLDERS of saved sessions (the same data the folder
 * overlay manages, surfaced as a first-class destination). Two modes:
 *
 *   ROOT (/p)            — a grid of the TOP-LEVEL folder tiles: an always-present
 *                          "Uncategorised" folder (every saved session not filed into a
 *                          folder), the user's folders, then a "+ New folder" + "+ New
 *                          tool" tile. Open a folder → /p/<id>.
 *   FOLDER (/p/<id>)     — that folder's SUB-FOLDERS and saved sessions as tiles, a
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
import { t } from '../i18n.ts';
import { createFolderStore, childFolders, folderPath, descendantFolderIds } from '../folders.ts';
import type { Folder } from '../folders.ts';
import {
  folderTile, sessionTile, FOLDER_ICON, PACKAGE_ICON, MENU_ICON,
  isBatchSlot, BATCH_SLOT_PREFIX,
  type MemberPreview,
} from '../folder-tiles.ts';
import { viewToggle } from '../components/view-toggle.ts';
import { playProjectsAah, cancelArrivalAah } from '../lib/sfx.ts';
import { mountFeaturedRow } from '../components/featured-row.ts';
import type { FeaturedEntry, FeaturedRowHandle, FeaturedViewMode } from '../components/featured-row.ts';
import { attachProfileMenu } from '../components/profile-menu.ts';
import { langFabHtml, attachLangMenu } from '../components/lang-menu.ts';
import { footerNav, NAV_ICONS } from '../components/footer-nav.ts';
import { confirmDialog as baseConfirmDialog, closeConfirmDialogs } from '../components/confirm-dialog.ts';
import type { ConfirmDialogOpts } from '../components/confirm-dialog.ts';
import { announce } from '../a11y.ts';
import { soundSegmentHtml, wireSoundSegment } from '../components/sound-toggle.ts';
import { openShareDialog } from '../components/share-dialog.ts';
import { themeSegmentHtml, wireThemeSegment } from '../components/theme-toggle.ts';
import { openFolderOverlay } from '../folder-overlay.ts';
import { flagEnabled, PRO_FLAG } from '../feature-flags.ts';
import { createRuntime, serializeUrlState } from '@lolly/engine';
import { getTool } from '../bridge/tool-loader.ts';
import type { HostV1, Profile } from '../../../../engine/src/bridge/host-v1.ts';
import type { WebStateAPI } from '../bridge/state.ts';
import type { BatchFile } from '../pro/batch.ts';

// The web shell hands mountProjects its concrete host, whose state/assets/profile
// expose more than the tool-facing HostV1 contract: state.sizes(), a thumbnail-carrying
// 3-arg save(), the user-asset helpers, and profile.set(). We describe just that extra
// surface this view reaches for and cast to it at the (few) call sites — erased at
// runtime, no behaviour change. main.js passes the concrete WebHost (assignable to
// HostV1), so the parameter stays typed HostV1 and this narrows locally.
interface ProjectsHost extends HostV1 {
  state: WebStateAPI;
  assets: HostV1['assets'] & {
    _listUserAssets(): Promise<ReadonlyArray<{ id: string }>>;
    _deleteUserAsset(id: string): Promise<void>;
  };
  profile: HostV1['profile'] & { set(profile: object): Promise<unknown> };
}

// Denormalised projection of a catalogue-index tool entry this view reads off
// window.__toolIndex — a build artifact, not a domain type the engine owns.
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

type SortBy = 'date' | 'name' | 'tool';
type ViewMode = 'preview' | 'list';
type SelectKind = 'folder' | 'session' | 'image';   // images join via marquee (no checkbox)

/** Query result: the (capped) tiles to render plus the true `total` so the header can
 *  say "showing the first N of M" without holding every match's DOM. */
interface SearchMatches { folders: Folder[]; sessions: Entry[]; total: number; capped: boolean }
// Ceiling on rendered result tiles. A one- or two-character query can match thousands of
// sessions; building that many tiles (+ their drag/select wiring) per keystroke is the one
// place this view could stall at scale, so we render the first slice and tell the user to
// narrow. Filtering still scans everything (it's O(n) over a prebuilt index) — only the DOM
// is bounded.
const SEARCH_LIMIT = 200;

/** Options passed in by main.js — a metrics hook injected so /pro isn't imported
 *  eagerly (see the batch export call sites below). */
interface MountProjectsOpts {
  onBatchRendered?: (files: BatchFile[]) => void;
}

// Sentinel folderId for the synthetic "Uncategorised" folder (sessions in no folder).
const UNCAT = '__uncat__';
// Set by the "+ New tool" tile so the next saved session files into this folder; read
// + cleared by the tool view after its first save. sessionStorage so it survives the
// navigation to the tool and dies with the tab.
const FILE_INTO_KEY = 'lolly:fileInto';

// Set just before opening/resuming a tool from here so the tool's Save button returns
// to THIS projects page (the folder or root the user launched from) instead of the
// gallery. sessionStorage, one-shot — read + cleared by the tool view on mount.
const RETURN_KEY = 'lolly:returnTo';

// The Uncategorised view floats the same cinematic strip the gallery's Featured row uses
// (drift · Cover Flow · mobile grip) as a browsable ribbon of loose-session previews above
// the "Move to" rail. It honours the SAME view-mode preference the gallery persists, so
// switching to Cover Flow in the gallery carries over here.
const FEATURED_VIEW_STORAGE = 'lolly-featured-view';
const FEATURED_VIEWS: readonly FeaturedViewMode[] = ['gallery', 'coverflow'];

const FOLDER_PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.7.9H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>';
const FILE_PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>';
const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const RENDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3 19 12 5 21Z"/></svg>';
// "history" (clock-rewind) — matches the gallery's saved-sessions button.
const HISTORY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>';
// "sliders-horizontal" — the gallery's filter/view-options button, reused here for
// view mode (preview/list) + sort.
const FILTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>';
// Context-menu glyphs (lucide house style). None of these existed in the codebase.
const OPEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
const EDIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const MOVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.7.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
// lucide "link" — the shareable-link glyph (matches the tool view's Share button).
const SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></svg>';
// (Footer nav links + their glyphs live in components/footer-nav.ts, shared with the
// Tools gallery and the Catalogue; NAV_ICONS.search is reused for the search field.)

export async function mountProjects(
  viewEl: HTMLElement,
  host: HostV1,
  folderId: string | null,
  opts: MountProjectsOpts = {},
): Promise<void> {
  const store = createFolderStore(host as ProjectsHost);
  // The soft "stacking clicks → puff of wind" arrival — only on the MAIN projects view
  // (folderId null), NOT every time a folder opens. One-shot, gesture-gated, silent when
  // sound's off; cancelled on leave (see _cleanup) so it can't fire on another page.
  if (!folderId) playProjectsAah();
  const w = window as typeof window & { __toolIndex?: { tools?: ProjectsTool[] } };
  const nameById = new Map((w.__toolIndex?.tools ?? []).map((tool): [string, string] => [tool.id, (tool as unknown as ProjectsTool).name]));
  const toolName = (id: string): string => nameById.get(id) || id || t('Saved session');
  // Full index entries (formats + intended width/height/unit) so session tiles can show
  // the same "what you'll get" spec the gallery cards do — see sessionTile's `tool` opt.
  const toolById = new Map((w.__toolIndex?.tools ?? []).map((t): [string, ProjectsTool] => [t.id, t as unknown as ProjectsTool]));

  // Live data, re-read on every reload() so a move/rename/delete reflects at once.
  let folders: Folder[] = [];
  let entries: Entry[] = [];          // host.state.list() rows
  let sizes: Record<string, number> = {};            // slot -> bytes
  // Derived indices, rebuilt once per reload() (see reindex()). `folders`/`entries` only
  // change in reload(), so these stay valid between renders and turn the per-tile lookups
  // below from O(entries)/O(folders×items) rebuilds-per-call into O(1) map hits — the
  // difference between linear and quadratic work when a project holds thousands of sessions.
  let entryMap = new Map<string, Entry>();       // slot → row
  let ownerByRef = new Map<string, Folder>();    // session ref → the folder that holds it
  let searchIndex = new Map<string, string>();   // slot → lowercased search haystack
  let uncatCache: Entry[] = [];                  // sessions filed into no folder
  let profile: Profile | null = null;
  let headshotUrl = '';
  let mounted = true;        // false after the view is swapped out (guards async renders)
  const toasts = new Set<HTMLDivElement>();  // live "Render folder" toasts, torn down on navigate-away
  let toolPickerEl: HTMLDialogElement | null = null;   // the "New from a tool" chooser dialog, if open
  let overlayEl: HTMLDialogElement | null = null;      // the move-picker / new-folder-name dialog, if open
  let featuredHandle: FeaturedRowHandle | null = null; // the Uncategorised preview ribbon (drift/coverflow/grip), if mounted
  // Multi-select: ref → 'folder' | 'session'. A closure var (NOT the DOM) because
  // render() wipes viewEl.innerHTML — the selection is re-emitted from this Map each
  // render, and toggles update just the affected tile + the bulk bar in place.
  const selected = new Map<string, SelectKind>();
  let viewMode: ViewMode = 'preview';  // 'preview' (tile grid) | 'list'
  let sortBy: SortBy = 'date';       // 'date' | 'name' | 'tool' (a client-side display preference)
  // Live search text (lowercased, trimmed). When non-empty the view swaps to a flat
  // "results" grid that searches the CURRENT scope's WHOLE subtree — every folder and
  // saved session nested beneath it — so matches inside sub-folders surface too. A closure
  // var (not the URL), reset when the view unmounts; each match tile carries its folder path.
  let query = '';
  // Memoised searchMatches() result (invalidated on data reload + query change) so the two
  // callers in a render — pruneSelection + searchBodyHtml — don't each re-scan the tree.
  let searchCache: { q: string; scope: string | null; matches: SearchMatches } | null = null;
  try {
    if (localStorage.getItem('lolly:projectsView') === 'list') viewMode = 'list';
    const s = localStorage.getItem('lolly:projectsSort');
    if (s === 'name' || s === 'tool' || s === 'date') sortBy = s;
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
  }

  // Rebuild the derived indices from the freshly-loaded folders/entries. One linear pass
  // each — everything downstream then reads O(1) instead of re-deriving per call/per tile.
  function reindex(): void {
    entryMap = new Map(entries.map(e => [e.slot, e]));
    ownerByRef = new Map();
    const claimed = new Set<string>();
    for (const f of folders) {
      for (const it of f.items) {
        if (it.type !== 'session') continue;
        claimed.add(it.ref);
        ownerByRef.set(it.ref, f);   // a session lives in at most one folder (store invariant)
      }
    }
    uncatCache = entries.filter(e => !claimed.has(e.slot));
    searchIndex = new Map(entries.map(e => [e.slot, sessionSearchText(e)]));
    searchCache = null;   // matches depend on the data that just changed
  }

  const entryBySlot = (): Map<string, Entry> => entryMap;
  const uncategorised = (): Entry[] => uncatCache;

  // Resolve a session ref → a mosaic preview cell ({thumb}|{batch}) for folder tiles.
  function previewForRef(ref: string): MemberPreview | null {
    const e = entryMap.get(ref);
    if (!e) return null;
    return isBatchSlot(e.slot) ? { batch: true } : { thumb: e.thumb || null };
  }
  function sessionsInFolder(f: Folder | null | undefined): Entry[] {
    return (f?.items ?? []).filter(i => i.type === 'session').map(i => entryMap.get(i.ref)).filter(Boolean) as Entry[];
  }

  // Sort helpers honouring the view-options menu. 'date' is the default (recent first).
  function sortFolders(arr: readonly Folder[]): Folder[] {
    const a = [...arr];
    if (sortBy === 'name') a.sort((x, y) => x.name.localeCompare(y.name));
    else if (sortBy === 'date') a.sort((x, y) => +new Date(y.updatedAt || y.createdAt || 0) - +new Date(x.updatedAt || x.createdAt || 0));
    // 'tool' has no meaning for folders → keep stored order.
    return a;
  }
  // Tile / header count = every renderable file (session or image) in a folder's WHOLE
  // subtree — exactly what "Render folder" would output — so "N items" matches the number
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
  // ref that isn't currently visible — deleted, OR moved out of view via drag / a per-tile
  // "Move to…" / the history overlay (none of which clear selection). This keeps the bulk
  // bar count honest and stops a bulk action (esp. Delete) from silently hitting an item
  // the user can no longer see was selected. Called at the top of every render().
  function pruneSelection(): void {
    if (!selected.size) return;
    const visible = new Set<string>();
    if (query) {
      // Searching swaps the grid for a flat results set spanning the subtree — the
      // selection stays valid for anything the results still show.
      const m = searchMatches();
      for (const f of m.folders) visible.add(f.id);
      for (const e of m.sessions) visible.add(e.slot);
    } else if (folderId == null) {
      for (const f of childFolders(folders, null)) visible.add(f.id);
    } else if (folderId === UNCAT) {
      for (const e of uncategorised()) visible.add(e.slot);
    } else {
      const folder = folders.find(f => f.id === folderId);
      for (const f of childFolders(folders, folderId)) visible.add(f.id);
      for (const e of sessionsInFolder(folder)) visible.add(e.slot);
    }
    for (const ref of [...selected.keys()]) if (!visible.has(ref)) selected.delete(ref);
  }

  const sessionTitle = (e: Entry): string => (e.label || e.filename || toolName(e.toolId) || '').toLowerCase();
  function sortSessions(arr: Entry[]): Entry[] {
    const a = [...arr];
    if (sortBy === 'name') a.sort((x, y) => sessionTitle(x).localeCompare(sessionTitle(y)));
    else if (sortBy === 'tool') a.sort((x, y) => (toolName(x.toolId) || '').localeCompare(toolName(y.toolId) || '') || sessionTitle(x).localeCompare(sessionTitle(y)));
    else a.sort((x, y) => +new Date(y.updatedAt || 0) - +new Date(x.updatedAt || 0)); // date
    return a;
  }

  // ── search (within the current scope's whole subtree) ───────────────────────
  // The haystack a session is matched against: its display title, the tool's name/id, and
  // a "batch" keyword for batch sessions.
  const sessionSearchText = (e: Entry): string =>
    [e.label, e.filename, toolName(e.toolId), e.toolId, isBatchSlot(e.slot) ? 'batch' : '']
      .filter(Boolean).join(' ').toLowerCase();

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

  // The query-filtered, sorted matches for the current scope — capped for render (see
  // SEARCH_LIMIT) and memoised so a single render's two callers scan the tree once.
  function searchMatches(): SearchMatches {
    if (!query) return { folders: [], sessions: [], total: 0, capped: false };
    if (searchCache && searchCache.q === query && searchCache.scope === folderId) return searchCache.matches;
    const scope = searchScope();
    // Sessions match via the prebuilt lowercased haystack (searchIndex) — no per-keystroke
    // string building. Folders match on name (there are far fewer of them).
    const mf = sortFolders(scope.folders.filter(f => f.name.toLowerCase().includes(query)));
    const ms = sortSessions(scope.sessions.filter(e => (searchIndex.get(e.slot) ?? '').includes(query)));
    const total = mf.length + ms.length;
    const cf = total > SEARCH_LIMIT ? mf.slice(0, SEARCH_LIMIT) : mf;
    const cs = total > SEARCH_LIMIT ? ms.slice(0, Math.max(0, SEARCH_LIMIT - cf.length)) : ms;
    const matches: SearchMatches = { folders: cf, sessions: cs, total, capped: total > SEARCH_LIMIT };
    searchCache = { q: query, scope: folderId, matches };
    return matches;
  }

  // ── render ───────────────────────────────────────────────────────────────
  function render(): void {
    if (!mounted) return; // an async callback fired after we navigated away — don't clobber the new view
    featuredHandle?.destroy(); featuredHandle = null;  // stop the prior ribbon's rAF loop + listeners before its DOM is wiped
    searchCache = null;   // recompute matches once for this render (sort/data may have changed); the two callers below then share it
    pruneSelection();     // forget refs that vanished since the last render
    viewEl.innerHTML = folderId == null ? rootHtml() : folderHtml(folderId);
    wire();
  }

  function rootHtml(): string {
    if (query) return shell(t('Projects'), 'projects', searchBodyHtml());
    const uncat = uncategorised();
    const createFolder = createTile('folder', FOLDER_PLUS_ICON, t('New folder'), t('Group saved sessions'));
    const createTool = createTile('tool', FILE_PLUS_ICON, t('New asset'), t('Start a fresh creation'));
    const uncatTile = pseudoFolderTile(UNCAT, t('Uncategorised'), uncat.map(e => e.slot));
    // Only TOP-LEVEL folders at the root; nested folders show inside their parent.
    const topFolders = sortFolders(childFolders(folders, null));
    const folderTiles = topFolders.map(f => folderTile(f, {
      memberPreviews: f.items.map(i => i.type === 'session' ? previewForRef(i.ref) : null).filter(Boolean) as MemberPreview[],
      count: tileItemCount(f),
      selectable: true, selected: isSelected(f.id),
    })).join('');
    // First run: no folders AND no loose sessions → the lone "Uncategorised · 0 items" tile
    // reads oddly on its own, so lead with a one-line invite explaining what Projects hold.
    const invite = (!topFolders.length && !uncat.length)
      ? `<p class="projects-empty">${t('Your saved sessions land here — save one from any tool to start a project.')}</p>`
      : '';
    // Content first (Uncategorised, then folders), create tiles LAST, so the grid reads
    // top-left like a file manager and the "new" affordances trail.
    return shell(t('Projects'), 'projects', `
      ${invite}
      <div class="folder-grid projects-grid${viewMode === 'list' ? ' projects-list' : ''}">
        ${uncatTile}${folderTiles}${createFolder}${createTool}
      </div>`);
  }

  function folderHtml(id: string): string {
    const isUncat = id === UNCAT;
    const folder = isUncat ? null : folders.find(f => f.id === id);
    if (!isUncat && !folder) {
      return shell(t('Projects'), 'projects', `<p class="projects-empty">${t('That folder no longer exists. {link}.', { link: `<a href="#/p">${t('Back to Projects')}</a>` })}</p>`, { inFolder: true });
    }
    const subfolders = isUncat ? [] : sortFolders(childFolders(folders, id));
    const sessions = sortSessions(isUncat ? uncategorised() : sessionsInFolder(folder));
    const title = isUncat ? t('Uncategorised') : folder!.name;
    // Header count matches the folder tile: total renderable files in the whole subtree
    // (Uncategorised is flat, so its direct session count is already the full picture).
    const count = isUncat ? sessions.length : tileItemCount(folder!);

    // Breadcrumb + parent — the back arrow climbs ONE level (to the parent folder, or
    // the root), and the trail links every ancestor. The current folder is the <h2>.
    const ancestors = isUncat ? [] : folderPath(folders, id).slice(0, -1);
    const parentId = ancestors.length ? ancestors[ancestors.length - 1]!.id : null;
    const backHref = parentId ? `#/p/${escape(parentId)}` : '#/p';
    const crumbs = `
      <nav class="projects-crumbs" aria-label="${escape(t('Folder path'))}">
        <a href="#/p">${t('Projects')}</a>
        ${ancestors.map(a => `<span class="projects-crumb-sep" aria-hidden="true">/</span><a href="#/p/${escape(a.id)}">${escape(a.name)}</a>`).join('')}
      </nav>`;

    // "Move to" rail: CONTEXTUAL drop targets only (not the whole tree dumped flat) —
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
    // (drift · Cover Flow · mobile grip) once the DOM exists — see mountUncatRibbon().
    const ribbon = isUncat && sessions.length ? `<div class="projects-featured" data-uncat-ribbon></div>` : '';
    // Preview-strip view switcher, BELOW the ribbon — the SAME `.view-seg` segmented control
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
    const createFolder = isUncat ? '' : createTile('folder', FOLDER_PLUS_ICON, t('New folder'), t('Group inside {title}', { title }));
    const createTool = createTile('tool', FILE_PLUS_ICON, t('New asset'), isUncat ? t('New saved session') : t('Add to {title}', { title }));
    const tiles = [
      ...subfolders.map(f => folderTile(f, {
        memberPreviews: f.items.map(i => i.type === 'session' ? previewForRef(i.ref) : null).filter(Boolean) as MemberPreview[],
        count: tileItemCount(f),
        selectable: true, selected: isSelected(f.id),
      })),
      ...sessions.map(e => sessionTile(e, {
        toolName: toolName(e.toolId), sizeBytes: sizes[e.slot] || 0, tool: toolById.get(e.toolId),
        selectable: true, selected: isSelected(e.slot),
      })),
    ].join('');

    // While a search is active the folder's own actions (rename / render whole folder)
    // would act on the folder, not the results, so they're dropped — the header keeps just
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
    const hasTiles = subfolders.length > 0 || sessions.length > 0;
    const body = hasTiles
      ? `<div class="${gridClass}">${tiles}${createFolder}${createTool}</div>`
      : `<div class="${gridClass}">${createFolder}${createTool}</div><p class="projects-empty">${isUncat ? t('No saved sessions are uncategorised yet.') : t('This folder is empty — add a tool or a sub-folder.')}</p>`;

    return shell(title, 'projects', `${ribbon}${stripSwitch}${rail}${header}${body}`, { inFolder: true });
  }

  // The flat results grid for the active query — matching folders first, then sessions,
  // each tile trailing a clickable breadcrumb of WHERE it lives so a hit nested three
  // folders deep still reads in context. Shared by the root + folder search branches.
  function searchBodyHtml(): string {
    const { folders: mf, sessions: ms, total, capped } = searchMatches();
    const shown = mf.length + ms.length;
    const scope = folderId == null ? t('all projects')
      : folderId === UNCAT ? t('Uncategorised')
      : `“${folders.find(f => f.id === folderId)?.name ?? t('this folder')}”`;
    if (!total) {
      return `<p class="projects-search-status" role="status" aria-live="polite">${t('No matches for “{query}” in {scope}', { query: escape(query), scope: escape(scope) })}</p>
        <p class="projects-empty">${t('Nothing here matches “{query}”. Try a different search, or {button}.', { query: escape(query), button: `<button type="button" class="projects-linkbtn" data-search-clear>${t('clear the search')}</button>` })}</p>`;
    }
    // When the match set is capped, name the true total and that only a slice is shown so a
    // broad query never silently looks "complete".
    const countText = capped
      ? t('{total} results — showing the first {shown}, refine to narrow', { total: total.toLocaleString(), shown })
      : (total === 1 ? t('1 result') : t('{n} results', { n: total }));
    const status = `<p class="projects-search-status" role="status" aria-live="polite">${t('{count} for “{query}” in {scope}', { count: countText, query: escape(query), scope: escape(scope) })}</p>`;
    const gridClass = `folder-grid projects-grid projects-search-grid${viewMode === 'list' ? ' projects-list' : ''}`;
    const tiles = [...mf.map(folderResultTile), ...ms.map(sessionResultTile)].join('');
    return `${status}<div class="${gridClass}">${tiles}</div>`;
  }

  // A search hit = the normal tile + a location breadcrumb beneath it. Reusing the shared
  // folderTile/sessionTile keeps open / select / drag / menu working with no extra wiring.
  function folderResultTile(f: Folder): string {
    const tile = folderTile(f, {
      memberPreviews: f.items.map(i => i.type === 'session' ? previewForRef(i.ref) : null).filter(Boolean) as MemberPreview[],
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
    const owner = ownerByRef.get(e.slot);   // O(1) — prebuilt in reindex()
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
      ? `<button type="button" class="projects-result-path" data-open-folder-nav="${escape(targetId)}" title="${escape(t('Open {name}', { name: text }))}">${inner}</button>`
      : `<span class="projects-result-path projects-result-path--static">${inner}</span>`;
  }

  // A folder-style tile for the synthetic Uncategorised group (no per-tile menu).
  function pseudoFolderTile(id: string, name: string, slots: string[]): string {
    const map = entryBySlot();
    const cells = slots.slice(0, 4).map(s => {
      const e = map.get(s);
      if (e && isBatchSlot(e.slot)) return `<span class="folder-cell folder-cell--batch" aria-hidden="true">${PACKAGE_ICON}</span>`;
      return e?.thumb
        ? `<img class="folder-cell" src="${escape(e.thumb)}" alt="" loading="lazy" decoding="async">`
        : `<span class="folder-cell folder-cell--empty" aria-hidden="true"></span>`;
    }).join('');
    const mosaic = cells ? `<span class="folder-mosaic">${cells}</span>` : `<span class="tile-cover tile-cover--batch" aria-hidden="true">${FOLDER_ICON}</span>`;
    return `
      <div class="folder-tile folder-tile--folder folder-tile--uncat" data-ref="${escape(id)}" data-kind="folder">
        <button type="button" class="tile-primary" data-open-folder="${escape(id)}" aria-label="${escape(t('Open {name}', { name }))}">
          ${mosaic}
          <span class="tile-meta">
            <span class="tile-title">${escape(name)}</span>
            <span class="tile-sub">${slots.length === 1 ? t('1 item') : t('{n} items', { n: slots.length })}</span>
          </span>
        </button>
      </div>`;
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

  // Profile + saved-sessions (history) buttons, carried over from the gallery so the
  // chrome is consistent (no tool filters here — they're meaningless for projects).
  function topRight(): string {
    const saved = entries.length;
    return `
      <div class="gallery-topright projects-topright">
        <button type="button" class="filter-fab projects-viewopts" aria-label="${escape(t('View and sort options'))}" aria-haspopup="true" title="${escape(t('View & sort'))}">${FILTER_ICON}</button>
        ${saved ? `<button type="button" class="history-fab" title="${escape(t('Saved sessions'))}" aria-label="${escape(t('Saved sessions ({n})', { n: saved }))}">${HISTORY_ICON}<span class="history-fab-count" aria-hidden="true">${saved}</span></button>` : ''}
        ${langFabHtml()}
        <a href="#/profile" class="profile-link${headshotUrl ? ' has-avatar' : ''}" aria-label="${escape(t('Open your profile'))}">${headshotUrl ? `<img class="profile-link-avatar" src="${escape(headshotUrl)}" alt="">` : ''}<span class="profile-link-name">${escape(profile?.firstname || t('Profile'))}</span></a>
      </div>`;
  }

  function shell(heading: string, active: 'tools' | 'projects' | 'catalog', inner: string, { inFolder = false }: { inFolder?: boolean } = {}): string {
    return `
      <div class="projects${inFolder ? ' projects--folder' : ''}${query ? ' projects--searching' : ''}">
        <div class="gallery-topbar">
          <div class="view-toggle-wrap">${viewToggle(active)}</div>
          ${topRight()}
        </div>
        <h1 class="visually-hidden">${escape(heading)}</h1>
        ${inner}
        ${bulkBarHtml()}
        ${footerHtml()}
      </div>`;
  }

  // The Projects surface's fixed bottom bar — the SAME chrome the gallery uses
  // (Pro · Dashboard · search · Verify · What?), so the two primary tabs share one
  // footer instead of Projects hiding those app-wide destinations. The search field in
  // the middle filters the CURRENT project scope's whole subtree — its placeholder names
  // that scope so it's clear a query reaches INTO sub-folders — and its value is echoed
  // from `query` so it survives the re-render each keystroke triggers (wire() rebinds it).
  function footerHtml(): string {
    const scopeName = folderId == null ? t('all projects')
      : folderId === UNCAT ? t('Uncategorised')
      : (folders.find(f => f.id === folderId)?.name || t('this folder'));
    const placeholder = folderId == null ? t('Search all projects…') : t('Search {scope}…', { scope: scopeName });
    const proEnabled = flagEnabled(profile, PRO_FLAG.id);
    return `
      ${footerNav({
        proEnabled,
        footerClass: 'projects-footer',
        searchHtml: `
        <div class="gallery-search-wrap">
          <div class="projects-search-box">
            <span class="projects-search-icon" aria-hidden="true">${NAV_ICONS.search}</span>
            <input class="projects-search-input" type="search" placeholder="${escape(placeholder)}" autocomplete="off" spellcheck="false" aria-label="${escape(placeholder)}" value="${escape(query)}">
            <button type="button" class="projects-search-clear" data-search-clear aria-label="${escape(t('Clear search'))}"${query ? '' : ' hidden'}>✕</button>
          </div>
        </div>`,
      })}`;
  }

  // A floating action bar for the current multi-selection — rebuilt each render and
  // shown/hidden (+ count) by syncBulkBar() reading the `selected` Map. The "Render
  // selection" action leads with the primary Render styling to match the header button.
  function bulkBarHtml(): string {
    return `
      <div class="projects-bulkbar" role="region" aria-label="${escape(t('Selection actions'))}" hidden>
        <span class="projects-bulkbar-count" aria-live="polite"></span>
        <div class="projects-bulkbar-actions">
          <button type="button" class="btn projects-render projects-bulk-render" data-bulk="render">${RENDER_ICON}<span>${t('Render selection')}</span></button>
          <button type="button" class="btn" data-bulk="edit" hidden title="${escape(t('Open the selected sessions side by side with one combined sidebar'))}">${EDIT_ICON}<span>${t('Edit together')}</span></button>
          <button type="button" class="btn" data-bulk="move">${MOVE_ICON}<span>${t('Move to…')}</span></button>
          <button type="button" class="btn" data-bulk="newfolder">${FOLDER_PLUS_ICON}<span>${t('New folder')}</span></button>
          <button type="button" class="btn projects-bulk-danger" data-bulk="delete">${TRASH_ICON}<span>${t('Delete')}</span></button>
        </div>
        <button type="button" class="projects-bulkbar-clear" data-bulk="clear" aria-label="${escape(t('Clear selection'))}">✕</button>
      </div>`;
  }

  // Reflect the current selection into the (already-rendered) bulk bar: show/hide +
  // count. Called after every toggle and inside wire() on each render.
  function syncBulkBar(): void {
    const bar = viewEl.querySelector<HTMLElement>('.projects-bulkbar');
    if (!bar) return;
    const n = selected.size;
    bar.hidden = n === 0;
    // Reserve bottom room (mobile) so the floating bar doesn't cover the last tile row.
    viewEl.querySelector('.projects')?.classList.toggle('has-selection', n > 0);
    const count = bar.querySelector('.projects-bulkbar-count');
    if (count) count.textContent = t('{n} selected', { n });
    // "Edit together" only when the selection is a manageable set of single-tool
    // sessions (2–8, no folders/images/batch grids) — the multi-edit view mounts
    // one live runtime per session, so the cap keeps it responsive.
    const edit = bar.querySelector<HTMLElement>('[data-bulk="edit"]');
    if (edit) edit.hidden = !editableSelection();
  }

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

  // ── wiring ─────────────────────────────────────────────────────────────────
  let searchTimer: ReturnType<typeof setTimeout> | undefined;   // debounces search re-renders
  // Re-focus the (freshly re-rendered) search field, caret at the end, after a search-driven
  // render() has replaced the input. Value is identical, so caret-to-end is where the user is.
  function focusSearch(caretToEnd = false): void {
    const el = viewEl.querySelector<HTMLInputElement>('.projects-search-input');
    if (!el) return;
    el.focus({ preventScroll: true });
    if (caretToEnd) { const n = el.value.length; try { el.setSelectionRange(n, n); } catch { /* unsupported */ } }
  }
  let openPopover: HTMLElement | null = null;
  function closeMenu(): void { openPopover?.remove(); openPopover = null; document.removeEventListener('pointerdown', onDocDown, true); document.removeEventListener('keydown', onMenuKey, true); }
  function onDocDown(e: PointerEvent): void { if (openPopover && !openPopover.contains(e.target as Node)) closeMenu(); }
  // Escape closes an open popover menu — matching the app-wide dialog convention (see confirm-dialog).
  function onMenuKey(e: KeyboardEvent): void { if (e.key === 'Escape' && openPopover) { e.preventDefault(); e.stopPropagation(); closeMenu(); } }

  // Mount a popover at a viewport point (x,y) — a menu button's bottom-left, or the
  // cursor for a right-click — clamped to stay on-screen (flips up near the bottom edge).
  // The `.folder-menu` is position:absolute, so document coords add the scroll offset.
  function placePopoverAt(pop: HTMLElement, x: number, y: number): void {
    document.body.appendChild(pop);
    openPopover = pop;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(x, window.innerWidth - pw - 12));
    const top  = (y + ph > window.innerHeight - 8) ? Math.max(8, y - ph - 12) : y;
    pop.style.left = `${Math.round(left + window.scrollX)}px`;
    pop.style.top  = `${Math.round(top + window.scrollY)}px`;
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onMenuKey, true);
  }

  // Destructive actions (delete a folder + its contents, delete a saved session) use
  // the shared styled confirm modal — close any open tile menu first so it doesn't
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

      // Clear the search (the ✕ in the field, or the link in the no-results message).
      const clr = t.closest<HTMLElement>('[data-search-clear]');
      if (clr) { e.preventDefault(); clearTimeout(searchTimer); if (query) { query = ''; render(); } focusSearch(); return; }

      // Preview-strip view switcher (the .view-seg below the Uncategorised ribbon). Live-
      // switch the strip via its handle (no full re-render) and persist the shared pref so the
      // choice carries to the gallery hero + next mount — matching the catalog's switch.
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
        openMenu({ ref: menuBtn.dataset.menu!, kind: menuBtn.dataset.menuKind!, tileEl: menuBtn.closest<HTMLElement>('.folder-tile'), x: r.left, y: r.bottom + 6 });
        return;
      }

      // Selection toggle (must beat the open-folder / open-session primary it neighbours)
      const selBtn = t.closest<HTMLElement>('[data-select]');
      if (selBtn) { e.preventDefault(); e.stopPropagation(); toggleSelect(selBtn); return; }

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
      if (create) { create.dataset.create === 'folder' ? startCreateFolder(create) : startCreateTool(); return; }

      // Rename folder (click the title in a folder view)
      const rn = t.closest<HTMLElement>('[data-rename-folder]');
      if (rn) { startRename(rn, rn.dataset.renameFolder); return; }

      // Render whole folder
      const rf = t.closest<HTMLElement>('[data-render-folder]');
      if (rf) { renderFolder(rf.dataset.renderFolder!); return; }

      // Open a saved session (resume the tool / open batch)
      const os = t.closest<HTMLElement>('[data-open-session]');
      if (os) { resumeSession(os.dataset.openSession!); return; }

      // A tap on a preview-ribbon tile resumes that session. The Featured strip's own
      // capture-phase handler has already swallowed a drag / a Cover-Flow re-centre before
      // this bubbles, so reaching here means a clean open — route it through resumeSession
      // (closeMenu + armReturn + batch handling) rather than the anchor's raw navigation.
      const ribbonTile = t.closest<HTMLElement>('.projects-featured .ftile');
      if (ribbonTile) { e.preventDefault(); resumeSession(ribbonTile.dataset.tool!); return; }
    });

    // Search field → debounced re-render into the flat results grid. The timer callback
    // re-reads the LIVE input (not the captured node) so a render triggered elsewhere mid-
    // debounce can't fire against a detached input, and refocuses the new field afterwards.
    const searchInput = root.querySelector<HTMLInputElement>('.projects-search-input');
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (!mounted) return;
        const v = (viewEl.querySelector<HTMLInputElement>('.projects-search-input')?.value ?? '').trim().toLowerCase();
        if (v === query) return;
        query = v;
        render();
        focusSearch(true);
      }, 110);
    });
    // Keep keystrokes off the global shortcut handlers (undo/redo etc.); Escape clears the
    // query, or blurs the field when it's already empty.
    searchInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        clearTimeout(searchTimer);
        if (query || searchInput.value) { query = ''; render(); focusSearch(); }
        else searchInput.blur();
      }
    });

    // View-options (filter) button → preview/list + sort popover.
    root.querySelector('.projects-viewopts')?.addEventListener('click', (e) => { e.stopPropagation(); openViewOpts(e.currentTarget as HTMLElement); });

    // History → the quick saved-sessions overlay (same as the gallery). It can
    // move/rename folders behind the page, so refresh Projects when it closes.
    // Reached from the history button AND, on mobile, the consolidated profile menu.
    async function openHistory(): Promise<void> {
      const imageRefs = await (host as ProjectsHost).assets._listUserAssets?.().catch(() => []) ?? [];
      openFolderOverlay(host as ProjectsHost, {
        context: 'projects',
        sessionEntries: [...entries].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
        imageRefs, sessionSizes: sizes, nameById,
        showCreateFolder: true,
        allowBatchExport: flagEnabled(profile, PRO_FLAG.id),
        onResume: (entry) => resumeSession(entry.slot),
        onDelete: () => {},
      });
      document.querySelector('dialog.folder-overlay')
        ?.addEventListener('close', async () => { if (!mounted) return; await reload(); render(); }, { once: true });
    }
    root.querySelector('.history-fab')?.addEventListener('click', openHistory);

    // Mobile: the avatar opens a single menu (theme + saved sessions + Settings);
    // on desktop it stays a plain link to the profile page.
    attachProfileMenu(root.querySelector<HTMLElement>('.profile-link'), host as ProjectsHost, {
      savedCount: entries.length,
      onHistory: openHistory,
    });
    attachLangMenu(root.querySelector<HTMLElement>('.lang-fab'), host as ProjectsHost);

    wireDrag(root);
    wireContextMenu(root);
    mountUncatRibbon(root);
    wireMarquee(root);
    syncBulkBar();   // reflect a selection that survived this re-render
  }

  // ── desktop: right-click → context menu ─────────────────────────────────────
  // Right-clicking a folder/session tile opens its menu at the cursor (matching the ⋯
  // button); right-clicking a tile that's part of a multi-selection opens the bulk menu.
  // Create tiles + the synthetic Uncategorised tile have no menu → the native menu shows.
  function wireContextMenu(root: HTMLElement): void {
    root.addEventListener('contextmenu', (e) => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>('.folder-tile[data-ref][data-kind]');
      if (!tile || tile.classList.contains('folder-tile--create') || tile.classList.contains('folder-tile--uncat')) return;
      e.preventDefault();
      const ref = tile.dataset.ref!, kind = tile.dataset.kind!;
      if (selected.size > 1 && selected.has(ref)) openBulkMenu(e.clientX, e.clientY);
      else openMenu({ ref, kind, tileEl: tile, x: e.clientX, y: e.clientY });
    });
  }

  // ── desktop: click-drag marquee (rubber-band) selection ─────────────────────
  // Press on empty canvas and drag a box; tiles it touches are selected live. A plain
  // drag replaces the selection; holding Shift/Cmd/Ctrl adds to it. A plain click on
  // empty canvas clears the selection. Fine-pointer only (touch uses the checkboxes).
  function wireMarquee(root: HTMLElement): void {
    if (!window.matchMedia?.('(pointer: fine)').matches) return;
    let sx = 0, sy = 0, box: HTMLDivElement | null = null, base: Map<string, SelectKind> | null = null, additive = false, active = false;

    const selectableTiles = (): HTMLElement[] =>
      [...root.querySelectorAll<HTMLElement>('.folder-tile[data-ref][data-kind]')]
        .filter(t => !t.classList.contains('folder-tile--uncat') && !t.classList.contains('folder-tile--create'));

    // Reconcile the selection Map to `next`, then repaint every tile's state in place.
    function applySelection(next: Map<string, SelectKind>): void {
      selected.clear();
      for (const [ref, kind] of next) selected.set(ref, kind);
      root.querySelectorAll<HTMLElement>('.folder-tile[data-ref]').forEach(t => {
        const on = selected.has(t.dataset.ref!);
        t.classList.toggle('is-selected', on);
        t.querySelector('.tile-check')?.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      syncBulkBar();
    }

    function onMove(e: MouseEvent): void {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!box) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;   // ignore micro-jitter (it's a click)
        box = document.createElement('div');
        box.className = 'projects-marquee';
        document.body.appendChild(box);
        root.classList.add('is-marqueeing');
      }
      e.preventDefault();
      const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
      const w = Math.abs(dx), h = Math.abs(dy);
      box.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
      const next = new Map<string, SelectKind>(additive ? base! : []);
      for (const tile of selectableTiles()) {
        const r = tile.getBoundingClientRect();
        const hit = !(r.right < x || r.left > x + w || r.bottom < y || r.top > y + h);
        if (hit) next.set(tile.dataset.ref!, tile.dataset.kind as SelectKind);
      }
      applySelection(next);
    }

    function onUp(): void {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      if (box) { box.remove(); box = null; root.classList.remove('is-marqueeing'); }
      else if (!additive && selected.size) { selected.clear(); render(); }  // plain click on empty → deselect
      active = false; base = null;
    }

    root.addEventListener('mousedown', (e) => {
      if (active || e.button !== 0) return;
      // Only start on empty canvas — never on a tile, control, chip, bar, breadcrumb, etc.
      if ((e.target as HTMLElement).closest('.folder-tile, button, a, input, label, dialog, .projects-bulkbar, .projects-rail, .projects-crumbs, .projects-head, .projects-search, .projects-footer, .gallery-topbar')) return;
      active = true;
      sx = e.clientX; sy = e.clientY;
      additive = e.shiftKey || e.metaKey || e.ctrlKey;
      base = new Map(selected);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
  }

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
    if (action === 'clear') { selected.clear(); render(); return; }
    if (action === 'render') { renderSelection(); return; }
    if (action === 'edit') { editSelection(); return; }
    if (action === 'move') { moveSelection(); return; }
    if (action === 'newfolder') { newFolderFromSelection(); return; }
    if (action === 'delete') { deleteSelection(); return; }
  }

  // ── drag-and-drop: drag a session OR a sub-folder onto a folder chip / folder tile ──
  function wireDrag(root: HTMLElement): void {
    // Session, image AND real folder tiles are draggable (not the synthetic Uncategorised,
    // not the create tiles). A folder carries 'text/lolly-folder'; a session 'text/lolly-session';
    // an image 'text/lolly-image' — the kind lets the drop target pick store.moveItem's type.
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
        // Grabbing one tile of a multi-selection drags the WHOLE set — move every
        // selected folder/session/image so they all follow, matching the "Move to…" bar.
        if (selected.size > 1 && selected.has(draggedRef)) {
          await applySelectionMove(dest);
        } else if (slot) {
          await store.moveItem(slot, dest, 'session');
        } else if (image) {
          await store.moveItem(image, dest, 'image');
        } else {
          if (draggedFolder === folderRef) return;   // dropped on itself — no-op
          await store.moveFolder(draggedFolder, dest); // store guards self/descendant cycles
        }
        await reload(); render(); announce(t('Moved'));
      });
    });
  }

  // ── per-tile menu ────────────────────────────────────────────────────────
  // One row of the context menu, icon + label. `render`/`danger` tint it.
  const menuItem = (act: string, icon: string, label: string, { render = false, danger = false }: { render?: boolean; danger?: boolean } = {}): string =>
    `<button type="button" class="folder-menu-item${render ? ' folder-menu-item--render' : ''}${danger ? ' folder-menu-item--danger' : ''}" data-act="${act}">${icon}<span>${escape(label)}</span></button>`;

  // Open the per-tile context menu. `ctx` = { ref, kind, tileEl, x, y } — from the ⋯
  // button (anchored below it) OR a right-click (anchored at the cursor). tileEl is the
  // enclosing .folder-tile (null for the folder-view header ⋯, which falls back to <h2>).
  function openMenu({ ref, kind, tileEl = null, x, y }: { ref: string; kind: string; tileEl?: HTMLElement | null; x: number; y: number }): void {
    closeMenu();
    const pop = document.createElement('div');
    pop.className = 'folder-menu projects-menu';
    // "Move to…" opens the drill-down picker (no more flat all-folders-at-once list).
    if (kind === 'folder') {
      pop.innerHTML = [
        menuItem('open-folder', OPEN_ICON, t('Open')),
        menuItem('rename', EDIT_ICON, t('Rename folder')),
        menuItem('move-folder', MOVE_ICON, t('Move to…')),
        menuItem('render', RENDER_ICON, t('Render folder'), { render: true }),
        menuItem('delete', TRASH_ICON, t('Delete folder'), { danger: true }),
      ].join('');
    } else {
      // A batch session is a multi-row group with no single tool URL, so it can't be
      // shared as a link — offer Share only for single-tool sessions.
      const canShare = !isBatchSlot(ref);
      pop.innerHTML = [
        menuItem('open', OPEN_ICON, t('Open')),
        menuItem('rename-session', EDIT_ICON, t('Rename')),
        menuItem('move', MOVE_ICON, t('Move to…')),
        canShare ? menuItem('share', SHARE_ICON, t('Share link')) : '',
        menuItem('render-session', RENDER_ICON, t('Render'), { render: true }),
        menuItem('delete-session', TRASH_ICON, t('Delete'), { danger: true }),
      ].join('');
    }
    placePopoverAt(pop, x, y);
    // Land keyboard focus on the first action so opening the menu doesn't strand the user on
    // the trigger tile — arrow/Tab then walk the items (Escape closes; see onMenuKey).
    pop.querySelector<HTMLElement>('[data-act]')?.focus({ preventScroll: true });

    pop.addEventListener('click', async (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (!item) return;
      const act = item.dataset.act;
      closeMenu();
      // Rename can fire from a folder TILE (root view) or the folder-view header menu
      // button (no enclosing tile) — fall back to the header <h2> in that case.
      if (act === 'rename') startRename(tileEl || viewEl.querySelector<HTMLElement>('.projects-title[data-rename-folder]'), ref);
      else if (act === 'render') renderFolder(ref);
      else if (act === 'delete') deleteFolderCascade(ref);
      else if (act === 'open-folder') { window.location.hash = '#/p/' + ref; }
      else if (act === 'move-folder') {
        // A folder can't move into itself or its own subtree — block those targets.
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
    });
  }

  // The context menu for a MULTI-selection (right-clicking a tile that's part of the
  // current selection) — the same actions as the bulk bar, at the cursor.
  function openBulkMenu(x: number, y: number): void {
    closeMenu();
    const pop = document.createElement('div');
    pop.className = 'folder-menu projects-menu';
    pop.innerHTML = [
      `<p class="folder-menu-head">${t('{n} selected', { n: selected.size })}</p>`,
      menuItem('render', RENDER_ICON, t('Render selection'), { render: true }),
      menuItem('move', MOVE_ICON, t('Move to…')),
      menuItem('newfolder', FOLDER_PLUS_ICON, t('New folder from selection')),
      menuItem('delete', TRASH_ICON, t('Delete'), { danger: true }),
    ].join('');
    placePopoverAt(pop, x, y);
    // Focus the first action so the bulk menu opens onto a control, not <body>.
    pop.querySelector<HTMLElement>('[data-act]')?.focus({ preventScroll: true });
    pop.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (!item) return;
      closeMenu();
      handleBulk(item.dataset.act!);
    });
  }

  // ── drill-down "Move to" picker ─────────────────────────────────────────────
  // A native <dialog> that navigates the folder tree one level at a time (rather than
  // dumping every folder at once): click a folder to drill in, breadcrumb to climb, then
  // "Move to «here»" commits at the current level. `blocked` folder ids (a folder's own
  // subtree, to prevent a cycle) are shown disabled. onPick(destId|null) — null = top level.
  function openMovePicker({ title, blocked = new Set<string>(), onPick }: { title: string; blocked?: Set<string>; onPick: (dest: string | null) => void }): void {
    closeMenu();
    let cursor: string | null = null; // current folder id (null = top level)
    const dlg = document.createElement('dialog');
    dlg.className = 'projects-movepicker';
    dlg.tabIndex = -1;   // focus fallback target so keyboard users land IN the picker on open
    document.body.appendChild(dlg);
    overlayEl = dlg;

    // Focus the first meaningful control so keyboard users don't land on <body> or the ✕:
    // a folder to drill into, else the "Move to …" confirm, else the dialog shell itself.
    const focusFirst = (): void => {
      (dlg.querySelector<HTMLElement>('.movepicker-row:not([disabled])')
        ?? dlg.querySelector<HTMLElement>('.movepicker-confirm:not([disabled])')
        ?? dlg).focus({ preventScroll: true });
    };

    const draw = (): void => {
      const kids = sortFolders(childFolders(folders, cursor));
      const path = cursor ? folderPath(folders, cursor) : [];
      const curName = cursor ? (path[path.length - 1]?.name ?? t('Folder')) : t('Top level');
      const canDropHere = cursor == null || !blocked.has(cursor);
      dlg.innerHTML = `
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
          <button type="button" class="btn projects-render movepicker-confirm"${canDropHere ? '' : ' disabled'}>${t('Move to {name}', { name: escape(curName) })}</button>
        </div>`;
      // Keep keyboard focus inside the picker after a redraw (drill-in / crumb climb); the
      // initial open focuses post-showModal below (the dialog isn't modal-focusable yet here).
      if (dlg.open) focusFirst();
    };
    draw();

    dlg.addEventListener('click', (e) => {
      const crumb = (e.target as HTMLElement).closest<HTMLElement>('[data-cursor]');
      if (crumb) { cursor = crumb.dataset.cursor || null; draw(); return; }
      const into = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-into]');
      if (into && !into.disabled) { cursor = into.dataset.into!; draw(); return; }
      if ((e.target as HTMLElement).closest('.movepicker-close, .movepicker-cancel')) { dlg.close(); return; }
      if ((e.target as HTMLElement).closest('.movepicker-confirm:not([disabled])')) { const dest = cursor; dlg.close(); onPick(dest); return; }
      // backdrop click
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); dlg.close(); }); // Escape
    dlg.addEventListener('close', () => { dlg.remove(); if (overlayEl === dlg) overlayEl = null; });
    dlg.showModal();
    focusFirst();   // land keyboard focus on the first meaningful control (see focusFirst)
  }

  // A tiny name prompt (New folder from selection). Resolves the trimmed name, or null.
  function promptFolderName(): Promise<string | null> {
    return new Promise((resolve) => {
      closeMenu();
      const dlg = document.createElement('dialog');
      dlg.className = 'projects-confirm projects-prompt';
      dlg.innerHTML = `
        <h2 class="projects-confirm-title">${t('New folder')}</h2>
        <input class="projects-name-input projects-prompt-input" type="text" placeholder="${escape(t('Folder name'))}" maxlength="60" aria-label="${escape(t('Folder name'))}">
        <div class="projects-confirm-actions">
          <button type="button" class="btn" data-act="cancel">${t('Cancel')}</button>
          <button type="button" class="btn projects-render" data-act="ok">${t('Create')}</button>
        </div>`;
      document.body.appendChild(dlg);
      overlayEl = dlg;
      const input = dlg.querySelector('input')!;
      let settled = false;
      const finish = (val: string | null): void => {
        if (settled) return; settled = true;
        if (overlayEl === dlg) overlayEl = null;
        if (dlg.open) dlg.close();
        dlg.remove();
        resolve(val || null);
      };
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
      // Resolve if the dialog is closed any other way (incl. _cleanup calling .close() on
      // navigate-away) so the awaiting newFolderFromSelection() never hangs.
      dlg.addEventListener('close', () => finish(null));
      dlg.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'ok') return finish(input.value.trim());
        if (act === 'cancel') return finish(null);
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) finish(null);
      });
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(input.value.trim()); });
      dlg.showModal();
      input.focus();
    });
  }

  // The gallery-style filter button → a popover to switch view mode (Preview/List) and
  // sort (Alphabetical / By date / By tool). Preference persists in localStorage.
  function openViewOpts(btn: HTMLElement): void {
    closeMenu();
    const atRoot = folderId == null;
    const opt = (on: boolean, attr: string, val: string, label: string): string =>
      `<button type="button" class="folder-menu-item${on ? ' is-on' : ''}" data-${attr}="${val}">${on ? '✓ ' : '  '}${label}</button>`;
    // (The Uncategorised preview-strip Gallery↔Cover-Flow switch is no longer a menu item —
    // it's a .view-seg segmented control below the ribbon, matching the catalog.)
    const pop = document.createElement('div');
    pop.className = 'folder-menu projects-viewmenu';
    pop.innerHTML = `
      ${themeSegmentHtml('folder-menu-head')}
      <p class="folder-menu-head">${t('View')}</p>
      ${opt(viewMode === 'preview', 'vm', 'preview', t('Preview'))}
      ${opt(viewMode === 'list', 'vm', 'list', t('List'))}
      <p class="folder-menu-head">${t('Sort')}</p>
      ${opt(sortBy === 'name', 'sort', 'name', t('Alphabetical'))}
      ${opt(sortBy === 'date', 'sort', 'date', t('By date'))}
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
      // Folder-view header: the title is an <h2> (not inside a button) — swap it directly.
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
  // both __export_filename and __label — the displayed name AND every future export (a
  // single download, or a folder "Render" batch row via folder-rows.js) use the new name.
  function startRenameSession(tile: HTMLElement | null, slot: string): void {
    const e = entryBySlot().get(slot); if (!tile || !e) return;
    const current = e.label || e.filename || toolName(e.toolId) || '';
    // Replace the WHOLE tile (the title lives inside the <button>; an input nested there
    // would let Space/Enter activate the button — see startCreateFolder).
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

  // "+ New tool": open an in-place tool chooser (a file-style selector) rather than
  // jumping to the gallery. Picking a tool opens it; inside a real folder we leave the
  // file-into marker so the tool view files the first saved session here (claimed on a
  // fresh open — see tool.js). Stays in the Projects flow.
  function startCreateTool(): void { openToolPicker(); }

  function openToolPicker(): void {
    // Projects are creative sessions you file in a folder, so the "new tool" chooser
    // omits utilities (on-device transforms, pickers, etc. — category 'utility').
    const tools = ((w.__toolIndex?.tools ?? []) as unknown as ProjectsTool[]).filter(x => x.category !== 'utility');
    const dlg = document.createElement('dialog');
    dlg.className = 'projects-toolpicker';
    dlg.setAttribute('aria-label', t('New from a tool'));   // accessible name (title text removed)
    dlg.innerHTML = `
      <div class="toolpicker-head">
        <input class="toolpicker-search" type="search" placeholder="${escape(t('Search tools…'))}" aria-label="${escape(t('Search tools'))}" autocomplete="off" spellcheck="false">
        <button type="button" class="toolpicker-close" aria-label="${escape(t('Close'))}">✕</button>
      </div>
      <div class="toolpicker-grid">
        ${tools.map(tool => `
          <div class="toolpicker-cell" data-tool="${escape(tool.id)}">
            <button type="button" class="toolpicker-tile" data-open-tool="${escape(tool.id)}">
              <span class="toolpicker-icon" aria-hidden="true">${tool.icon || ''}</span>
              <span class="toolpicker-name">${escape(tool.name)}</span>
              ${tool.description ? `<span class="toolpicker-desc">${escape(tool.description)}</span>` : ''}
            </button>
            <button type="button" class="toolpicker-add" data-add-tool="${escape(tool.id)}" title="${escape(t('Add to this folder with default settings — without opening the editor'))}" aria-label="${escape(t('Add {name} to this folder without opening', { name: tool.name }))}"><span class="toolpicker-add-label">${t('+ Add')}</span></button>
          </div>`).join('')}
      </div>`;
    document.body.appendChild(dlg);
    toolPickerEl = dlg;
    dlg.addEventListener('close', () => { dlg.remove(); if (toolPickerEl === dlg) toolPickerEl = null; });
    dlg.showModal();
    const search = dlg.querySelector<HTMLInputElement>('.toolpicker-search')!;
    setTimeout(() => search.focus(), 0);
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      // Match on the tile's own text (name + description), hide the whole CELL so the
      // grid collapses — and so the "+ Add" button's label never pollutes the search.
      dlg.querySelectorAll<HTMLElement>('.toolpicker-cell').forEach(cell => {
        const tile = cell.querySelector('.toolpicker-tile');
        cell.hidden = !!(q && !tile!.textContent!.toLowerCase().includes(q));
      });
    });
    dlg.querySelector('.toolpicker-close')!.addEventListener('click', () => dlg.close());
    dlg.querySelector('.toolpicker-grid')!.addEventListener('click', (e) => {
      // "+ Add": file a default-settings session into this folder WITHOUT opening the
      // editor, and leave the picker open so several tools can be added in a row.
      const addBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-add-tool]');
      if (addBtn) { e.stopPropagation(); queueAddOnly(addBtn); return; }
      // Default action: open the tool in the editor (files into this folder on first save).
      const openBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-open-tool]');
      if (!openBtn) return;
      const target = (folderId && folderId !== UNCAT) ? folderId : '';
      try { sessionStorage.setItem(FILE_INTO_KEY, target); } catch { /* private mode */ }
      armReturn();
      dlg.close();
      window.location.hash = '#/tool/' + openBtn.dataset.openTool;
    });
  }

  // Serialise "+ Add" clicks — each files a fresh default-settings session into the
  // current folder. Chained so a rapid burst can't race store.moveItem's read-modify-
  // write of the profile's folder list (a concurrent add could otherwise drop a sibling).
  let addChain = Promise.resolve();
  function queueAddOnly(btn: HTMLButtonElement): void {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    setAddLabel(btn, t('Adding…'));
    addChain = addChain.then(async () => {
      let ok = false;
      try { await addDefaultSession(btn.dataset.addTool!); ok = true; }
      catch (err) { host.log?.('warn', 'projects: add-only failed', { tool: btn.dataset.addTool, error: String(err) }); }
      if (!btn.isConnected) return;
      setAddLabel(btn, ok ? t('✓ Added') : t('Failed'));
      btn.classList.toggle('is-added', ok);
      // Reset a moment later, fire-and-forget so it never stalls the next queued add.
      setTimeout(() => {
        if (!btn.isConnected) return;
        setAddLabel(btn, t('+ Add')); btn.classList.remove('is-added'); btn.disabled = false; delete btn.dataset.busy;
      }, 1300);
    });
  }
  function setAddLabel(btn: HTMLElement, text: string): void {
    const l = btn.querySelector('.toolpicker-add-label'); if (l) l.textContent = text;
  }

  // Create a saved session for `toolId` seeded with its RESOLVED defaults (createRuntime
  // alone runs onInit + profile binding — no offscreen render), file it into the current
  // folder, and refresh the grid under the still-open picker. No thumbnail: a fresh
  // default session shows the standard placeholder cover until it's opened and saved.
  async function addDefaultSession(toolId: string): Promise<void> {
    const tool = await getTool(toolId);
    const runtime = await createRuntime(tool, host, {});
    const values = Object.fromEntries(runtime.getModel().map(i => [i.id, i.value]));
    const slot = `${tool.manifest.id}:${Date.now()}`;
    await (host as ProjectsHost).state.save(slot, {
      ...values,
      __toolId:        tool.manifest.id,
      __toolVersion:   tool.manifest.version,
      __export_format: tool.manifest.render?.formats?.[0] ?? '',
    }, '');
    const target = (folderId && folderId !== UNCAT) ? folderId : null;
    if (target) await store.moveItem(slot, target, 'session');
    if (mounted) { await reload(); render(); }
  }

  // Arm the return target so the tool's Save button lands back on this exact page —
  // root `/#/p`, the Uncategorised view, or a specific folder. navigateTo-compatible URL.
  function armReturn(): void {
    try { sessionStorage.setItem(RETURN_KEY, '/#/p' + (folderId ? '/' + folderId : '')); } catch { /* private mode */ }
  }

  function resumeSession(slot: string): void {
    closeMenu();
    if (isBatchSlot(slot)) {
      window.location.hash = `#/pro?session=${encodeURIComponent(slot)}`;
      return;
    }
    armReturn();
    window.location.hash = `#/tool/${entryBySlot().get(slot)?.toolId || ''}?slot=${encodeURIComponent(slot)}`;
  }

  // The href resumeSession() ends up at — set on the preview-ribbon tiles so a middle-click
  // / no-JS open still lands right (the click handler routes clean taps through
  // resumeSession so Save returns here, but the anchor is the accessible fallback).
  const resumeHref = (e: Entry): string =>
    isBatchSlot(e.slot)
      ? `#/pro?session=${encodeURIComponent(e.slot)}`
      : `#/tool/${e.toolId || ''}?slot=${encodeURIComponent(e.slot)}`;

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
    // folder… · Render · Delete) the grid session tiles get — the touch-friendly path to
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
      openMenu({ ref: slot, kind: 'session', tileEl: tile, x: r.left, y: r.bottom + 6 });
    });
    // Each ribbon preview is also a drag source for the "Move to" rail (desktop) — same payload
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
  // and image they hold — including stored previews — then the folder records. Confirmed.
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
      title: t('Delete “{name}”?', { name: folder.name }),
      message: parts.length
        ? t('This permanently deletes the folder, {parts}. This cannot be undone.', { parts: parts.join(t(' and ')) })
        : t('This permanently deletes the folder. This cannot be undone.'),
      confirmLabel: t('Delete folder'),
    });
    if (!ok || !mounted) return;
    for (const it of items) {
      try {
        if (it.type === 'image') await (host as ProjectsHost).assets._deleteUserAsset(it.ref);
        else await host.state.delete(it.ref);
      } catch (err) { host.log?.('warn', 'projects: folder item delete failed', { ref: it.ref, error: String(err) }); }
    }
    await store.removeSubtree(id);
    announce(t('Folder “{name}” deleted', { name: folder.name }));
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

  // Shared scaffold for every render/export path (folder, single session, selection):
  // a floating .pro-toast with a live mount + close button, tracked so navigate-away
  // tears it down (_cleanup). `run(mount)` does the gated /pro export; errors surface
  // in the toast instead of throwing.
  function renderViaToast(run: (mount: HTMLElement) => unknown): void {
    closeMenu();
    const toast = document.createElement('div');
    toast.className = 'pro-toast projects-toast'; // top-right under the profile row (see app.css)
    toast.innerHTML = `<button type="button" class="pro-toast-close" aria-label="${escape(t('Close'))}">✕</button><div class="pro-toast-mount"></div>`;
    document.body.appendChild(toast);
    toasts.add(toast);
    const mount = toast.querySelector<HTMLElement>('.pro-toast-mount')!;
    toast.querySelector('.pro-toast-close')!.addEventListener('click', () => { toast.remove(); toasts.delete(toast); });
    Promise.resolve(run(mount)).catch((err) => {
      mount.innerHTML = `<p class="pro-progress-msg pro-log-err">${escape(String((err as { message?: unknown })?.message ?? err))}</p>`;
    });
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

  // ── bulk actions over the current multi-selection ───────────────────────────
  // Selected FOLDERS that are descendants of another selected folder are redundant —
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
    selected.clear();
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
    selected.clear();
    if (!mounted) return;
    await reload(); render();
  }

  async function deleteSelection(): Promise<void> {
    const sessionRefs = selectedByKind('session');
    const folderIds = topLevelSelectedFolders();
    if (!sessionRefs.length && !folderIds.length) return;
    // Count everything the delete will remove (subtree items across selected folders).
    const subtreeIds = folderIds.flatMap(id => [id, ...descendantFolderIds(folders, id)]);
    const folderItems = folders.filter(f => subtreeIds.includes(f.id)).flatMap(f => f.items ?? []);
    const totalSessions = sessionRefs.length + folderItems.filter(i => i.type !== 'image').length;
    const totalImages = folderItems.filter(i => i.type === 'image').length;
    const bits: string[] = [];
    if (folderIds.length) bits.push((folderIds.length === 1 ? t('1 folder') : t('{n} folders', { n: folderIds.length })) + (subtreeIds.length > folderIds.length ? ` ${t('(and everything inside)')}` : ''));
    if (totalSessions) bits.push(totalSessions === 1 ? t('1 saved session') : t('{n} saved sessions', { n: totalSessions }));
    if (totalImages) bits.push(totalImages === 1 ? t('1 image') : t('{n} images', { n: totalImages }));
    const ok = await confirmDialog({
      title: selected.size === 1 ? t('Delete 1 selected item?') : t('Delete {n} selected items?', { n: selected.size }),
      message: t('This permanently deletes {list}, including previews. This cannot be undone.', { list: bits.join(', ') }),
      confirmLabel: t('Delete'),
    });
    if (!ok || !mounted) return;
    announce(selected.size === 1 ? t('1 item deleted') : t('{n} items deleted', { n: selected.size }));
    for (const slot of sessionRefs) await host.state.delete(slot).catch(() => {});
    for (const id of folderIds) {
      const items = folders.filter(f => [id, ...descendantFolderIds(folders, id)].includes(f.id)).flatMap(f => f.items ?? []);
      for (const it of items) {
        try { if (it.type === 'image') await (host as ProjectsHost).assets._deleteUserAsset(it.ref); else await host.state.delete(it.ref); }
        catch (err) { host.log?.('warn', 'projects: bulk delete item failed', { ref: it.ref, error: String(err) }); }
      }
      await store.removeSubtree(id);
    }
    selected.clear();
    if (!mounted) return;
    await reload(); render();
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  // Arriving at Projects means we're not mid-"+ New tool" creation, so disarm any
  // stale file-into / return-to markers left by an abandoned flow.
  try { sessionStorage.removeItem(FILE_INTO_KEY); sessionStorage.removeItem(RETURN_KEY); } catch { /* ignore */ }
  (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => { mounted = false; cancelArrivalAah(); featuredHandle?.destroy(); featuredHandle = null; closeMenu(); closeConfirmDialogs(); toasts.forEach(t => t.remove()); toasts.clear(); toolPickerEl?.remove(); toolPickerEl = null; overlayEl?.close?.(); overlayEl?.remove(); overlayEl = null; };
  await reload();
  // A stale /p/<id> deep link to a deleted folder falls back to root.
  if (folderId && folderId !== UNCAT && !folders.some(f => f.id === folderId)) folderId = null;
  render();
}
