// SPDX-License-Identifier: MPL-2.0
/**
 * Web shell entry.
 *
 * Responsibilities:
 *   1. Construct the capability bridge (web implementations of each API).
 *   2. Sync the tool & asset catalogs (or load from cache when offline).
 *   3. Route between gallery / tool / profile / saved views.
 *   4. Hand the engine runtime a mounted node to render into.
 */

import { createBridge } from './bridge/index.ts';
import { syncCatalog, syncCorePrefetch, defaultFavouriteAssetIds, toolIndexChanged } from './catalog/sync.ts';
import { saveFavouriteAssets } from './lib/asset-favourites.ts';
import { mountGallery } from './views/gallery.ts';
import { initTheme, applyTheme } from './theme.ts';
import { applyChromeBrandVars } from './brand-vars.ts';
import { registerUserFonts } from './user-fonts.ts';
import { hydrateSfxMuted, hydrateSfxVolume, installGlobalSfx, playSfx } from './lib/sfx.ts';
import { hydrateNeurospicy, armNeurospicy, invalidateNeurospicyTracks, dropNeurospicyTracks } from './lib/neurospicy.ts';
import { hydrateFeatureFlags, flagEnabledSync } from './feature-flags.ts';
import { syncNeuroDock } from './components/neuro-dock.ts';
import { installGlobalReveal } from './lib/reveal.ts';
import { initSelectPreview } from './select-preview.ts';
import { recordTool, recordBatch, bumpMetric, recordFormat } from './metrics.ts';
import { announce } from './a11y.ts';

/** The web capability bridge, as produced by createBridge. */
type WebHost = Awaited<ReturnType<typeof createBridge>>;

/** Route names the shell can be in. */
type RouteName = 'gallery' | 'tool' | 'profile' | 'dashboard' | 'pro' | 'projects' | 'catalog' | 'verify' | 'start';

/** A parsed route: a discriminated union on `name`. */
type Route =
  | { name: 'tool'; toolId: string; params: string }
  | { name: 'profile'; params: string }
  | { name: 'dashboard'; params?: string }
  | { name: 'verify'; params?: string }
  | { name: 'pro'; params?: string }
  | { name: 'projects'; folderId: string | null; params?: string }
  | { name: 'catalog'; params?: string }
  | { name: 'start'; params?: string }
  | { name: 'gallery' };

/** The #view container, which a mounted view may stamp a teardown fn onto. */
interface ViewElement extends HTMLElement {
  _cleanup?: () => void;
}

// Apply localStorage theme immediately — before the profile loads — so there
// is no visible flash between the inline FOUC script and full JS boot.
initTheme();
// Make every <select> a keyboard + wheel live-preview scrubber (macOS otherwise
// opens the native popup on arrow keys instead of cycling the value).
initSelectPreview();

let _lastRouteName: RouteName | null = null;
// Signature of the route currently mounted — used to drop a redundant re-navigate to the
// SAME route (a single tool open fires hashchange AND popstate → two navigates). See navigate().
let mountedRouteSig = '';

// Announce client-side route changes (the view swaps via innerHTML, which
// assistive tech wouldn't otherwise notice).
function announceRoute(name: RouteName): void {
  const labels: Record<RouteName, string> = { gallery: 'Tools gallery', tool: 'Tool', profile: 'Profile', dashboard: 'Dashboard', pro: 'Batch mode', projects: 'Projects', catalog: 'Catalogue', verify: 'Verify', start: 'Brand setup' };
  announce(`${labels[name] ?? 'Page'} loaded`);
}

async function navigate(host: WebHost, opts: { force?: boolean } = {}): Promise<void> {
  const route = parseRoute();
  // A single tool open sets a hash while on a History-API /t/<id> URL, which fires BOTH
  // hashchange AND popstate — in separate macrotasks, with variable timing (the 2nd can
  // land after the 1st mount's replaceState). That mounted the tool TWICE per open,
  // re-running loadTool + createRuntime + hydrate for nothing (~2× the open cost; the tool
  // view even documents the quirk, reading its resume markers read-only to survive it).
  // Skip a navigate that resolves to the route already mounted — timing-independent, since
  // parseRoute maps both #/tool/<id> and /t/<id> to the same `tool:<id>` signature. The
  // signature must capture EVERYTHING that changes what's mounted, or it over-collapses:
  // keyed on `route.name` alone, opening a Projects folder (#/p/<id>) from the Projects
  // root both read 'projects' and the folder never opens. So each route keys on its full
  // sub-state (folderId / params). ONLY the tool route strips params — its two burst
  // events repack the query mid-mount, and same-tool param edits apply in place
  // (runtime.setInput), never by re-mount; every other route's sub-state is stable across
  // a burst. Explicit refreshes — boot, the gallery's post-sync re-render — force past this.
  const routeSig =
    route.name === 'tool'       ? `tool:${route.toolId}`
    : route.name === 'projects' ? `projects:${route.folderId ?? ''}`
    : route.name === 'profile'  ? `profile:${route.params ?? ''}`
    // The dashboard keys on its query too, so a deep link that only changes a flag
    // (#/d → #/d?print, or an old #/platform?x redirect) re-mounts and re-applies
    // the open+scroll, instead of being deduped as the same 'dashboard' route.
    : route.name === 'dashboard' ? `dashboard:${route.params ?? ''}`
    : route.name;
  if (!opts.force && routeSig === mountedRouteSig) return;
  mountedRouteSig = routeSig;

  const view = document.getElementById('view') as ViewElement;
  view._cleanup?.();
  delete view._cleanup;

  // The Projects "+ New tool" / resume flow arms one-shot sessionStorage markers
  // (lolly:fileInto, lolly:returnTo) that the tool view READS on mount (it can't
  // remove them — a single hash navigation may mount the tool twice, and the second
  // mount owns the live Save button). Clear them the moment we land on any NON-tool
  // view so a marker can't leak into the next, unrelated tool a user opens.
  if (route.name !== 'tool') {
    try { sessionStorage.removeItem('lolly:fileInto'); sessionStorage.removeItem('lolly:returnTo'); } catch { /* private mode */ }
  }

  document.querySelectorAll<HTMLElement>('.nav-btn[data-route]').forEach(btn => {
    btn.classList.toggle('nav-btn--active', btn.dataset.route === route.name);
  });

  // Track returns from tool → gallery so card-in animation doesn't replay.
  const prevRouteName = _lastRouteName;
  // Leaving an editing session — a sweet "yum-yum" cheer as you step away from a tool
  // (any tool → non-tool move; not tool → tool, which stays in editing).
  if (prevRouteName === 'tool' && route.name !== 'tool') playSfx('leaveSession');
  const returning = _lastRouteName === 'tool' && route.name === 'gallery';
  _lastRouteName = route.name;

  view.classList.toggle('tool-view', route.name === 'tool');
  view.classList.toggle('gallery-view', route.name === 'gallery');
  view.classList.toggle('profile-view', route.name === 'profile');
  view.classList.toggle('dashboard-view', route.name === 'dashboard');
  view.classList.toggle('pro-view', route.name === 'pro');
  view.classList.toggle('projects-view', route.name === 'projects');
  view.classList.toggle('catalog-view', route.name === 'catalog');
  view.classList.toggle('verify-view', route.name === 'verify');
  view.classList.toggle('start-view', route.name === 'start');
  view.classList.toggle('is-returning', returning);

  // When the route NAME changes, the view-scoping class above changes with it
  // (e.g. .profile-view → .gallery-view). But the outgoing view's markup is still
  // in `view` and won't be replaced until the incoming mount writes its innerHTML
  // — which happens AFTER that mount's first await (gallery reads IndexedDB before
  // it paints). In that gap the old markup is styled by a class it no longer has,
  // so it flashes UNSTYLED (e.g. a bare profile form). Drop the stale markup now so
  // that flash can't show; the incoming mount fills the empty container. Same-name
  // updates (the gallery's post-sync refresh) keep their content so they never
  // blank, and first boot keeps the "Loading…" skeleton until the gallery lands.
  if (prevRouteName && route.name !== prevRouteName) view.replaceChildren();

  // The dashboard leans on SUSE Mono (device readouts, hex/CMYK rows, code). It
  // isn't preloaded globally — that would tax the mono-light gallery cold-load —
  // so warm it here, before the view chunk imports and paints, to head off a
  // post-paint reflow when the woff2 lands late. Idempotent.
  if (route.name === 'dashboard') ensureMonoPreload();

  // Any failure mounting the route must NOT leave the (already-cleared) view blank:
  // a stale lazy chunk reloads onto the fresh shell; any other mount error shows a
  // Reload card. See recoverFromStaleShell / showReloadCard below.
  try {
  switch (route.name) {
    case 'tool': {
      recordTool(route.toolId); // local usage metric (profile page)
      // Lazy-load the tool view (the largest) so it stays out of the cold-load
      // bundle every gallery/catalog visitor pays for before first paint. Same
      // dynamic-import pattern as the other views; idle-prefetched below so the
      // first tap into a tool still opens instantly.
      const { mountTool } = await import('./views/tool.ts');
      await mountTool(view, host as unknown as Parameters<typeof mountTool>[1], route.toolId, route.params);
      break;
    }
    // Profile / Platform / Capabilities pull in their own (sometimes heavy, e.g.
    // fflate) deps; lazy-load them so they stay out of the cold-load bundle that
    // every gallery visitor pays for. Same dynamic-import pattern as /pro below.
    case 'profile': {
      const { mountProfile } = await import('./views/profile.ts');
      await mountProfile(view, host as unknown as Parameters<typeof mountProfile>[1], route.params);
      break;
    }
    case 'dashboard': {
      const { mountDashboard } = await import('./views/dashboard.ts');
      await mountDashboard(view, host);
      break;
    }
    // /verify — on-device Content Credentials check (aliases /valid, /v). Same
    // engine verifier the CLI `validate` command uses; the view module is named
    // for what it checks (validity), lazy-loaded like the other dashboards.
    case 'verify': {
      const { mountValid } = await import('./views/valid.ts');
      await mountValid(view, host);
      break;
    }
    // --- /pro batch mode: isolated, lazy-loaded feature. Safe to remove by
    // deleting src/pro/ and this case + the parseRoute branch below. ---
    case 'pro': {
      const { mountPro } = await import('./pro/index.ts');
      // The folder overlay is pro-free; inject it (like onBatchRendered) so /pro
      // keeps its "imports only engine/host/siblings" isolation intact.
      const { openFolderOverlay } = await import('./folder-overlay.ts');
      const sessionSlot = new URLSearchParams(route.params || '').get('session');
      // Inject a metrics hook rather than letting /pro import metrics.js — keeps
      // the folder's "imports only engine/host/siblings" isolation intact.
      const onBatchRendered = (files: Array<{ name: unknown }>) => {
        recordBatch(files.length);
        bumpMetric('filesRendered', files.length);
        for (const f of files) recordFormat(String(f.name).split('.').pop());
      };
      await mountPro(view, host as unknown as Parameters<typeof mountPro>[1], { sessionSlot, onBatchRendered, openFolderOverlay } as unknown as Parameters<typeof mountPro>[2]);
      break;
    }
    // --- Projects: a gallery-style view of folders of saved sessions. Shares the
    // pro-free folder store + folder-export (gated import); safe to keep even if /pro
    // is removed. ---
    case 'projects': {
      const { mountProjects } = await import('./views/projects.ts');
      const onBatchRendered = (files: Array<{ name: unknown }>) => {
        recordBatch(files.length);
        bumpMetric('filesRendered', files.length);
        for (const f of files) recordFormat(String(f.name).split('.').pop());
      };
      await mountProjects(view, host, route.folderId, { onBatchRendered });
      break;
    }
    // --- Catalog: a gallery-style view of every asset (catalog + user), plus swatches
    // and downloadable fonts. Lazy-loaded like the other non-gallery views. ---
    case 'catalog': {
      const { mountCatalog } = await import('./views/catalog.ts');
      await mountCatalog(view, host, route.params);
      break;
    }
    // --- /start: the brand wizard (derive-or-import your tokens). Lazy-loaded —
    // it statically pulls the engine's derive/token modules, which the gallery
    // cold-load must not pay for. ---
    case 'start': {
      const { mountStart } = await import('./views/start.ts');
      await mountStart(view, host as unknown as Parameters<typeof mountStart>[1]);
      break;
    }
    case 'gallery':
    default:
      await mountGallery(view, host as unknown as Parameters<typeof mountGallery>[1]);
  }
  } catch (err) {
    console.error('View mount failed:', err);
    if (import.meta.env.PROD && looksLikeChunkError(err)) { recoverFromStaleShell(); return; }
    showReloadCard('This view didn’t finish loading. Reload to try again.');
    return;
  }

  // After the view swaps, tell assistive tech and move focus into the new view
  // so keyboard/SR users aren't stranded on the now-removed element. (Within a
  // view, state changes use replaceState — no navigate — so focus isn't stolen.)
  // BUT if the view's own mount already placed focus on something meaningful
  // (e.g. /pro focuses its template search, which lives in a body-mounted
  // popover), don't yank it back to the container.
  // Land a newly-entered view at the top. A route-NAME change swaps the whole
  // view via innerHTML, so inheriting the previous page's scroll offset would
  // drop you mid-content (e.g. a scrolled gallery → capabilities). Skip the
  // tool→gallery "return" so that path keeps its current feel, and skip same-name
  // updates (those go through replaceState, not navigate, so they never reach here).
  if (route.name !== prevRouteName && !returning) {
    window.scrollTo(0, 0);
    view.scrollTop = 0;
  }

  announceRoute(route.name);
  const af = document.activeElement;
  if (!af || af === document.body || af === view) {
    view.setAttribute('tabindex', '-1');
    view.focus({ preventScroll: true });
  }
}

// Route-scoped font preload for the mono-heavy dashboards (see navigate). Added
// once; the browser dedupes against the @font-face request that follows.
function ensureMonoPreload(): void {
  if (document.getElementById('preload-suse-mono')) return;
  const l = document.createElement('link');
  l.id = 'preload-suse-mono';
  l.rel = 'preload';
  l.as = 'font';
  l.type = 'font/woff2';
  l.crossOrigin = 'anonymous';
  l.href = '/fonts/SUSEMono[wght].woff2'; // shell-served (fonts.css) — profile-independent
  document.head.appendChild(l);
}

// Update a dashboard's "N tools" stat in place after a cold fast-path paint, once
// the synced catalog carries a (newer) count. Patching beats re-navigating, which
// would replay the whole entrance cascade just to change a number. The view marks
// the stat with [data-tool-count] and hides it while the count is unknown.
function patchDashboardToolCount(): void {
  const n = window.__toolIndex?.tools?.length;
  if (n == null) return;
  document.querySelectorAll<HTMLElement>('[data-tool-count]').forEach((el) => {
    const strong = el.querySelector('strong');
    if (strong) strong.textContent = String(n);
    el.hidden = false;
  });
}

// Publish the visual viewport's offset (how far the zoomed/panned visible area
// sits from the layout viewport) as CSS vars. position:fixed pins to the LAYOUT
// viewport, so without this the mobile controls sheet drifts off-screen while
// the page is pinch-zoomed; the mobile sheet rules add --vv-top/--vv-left back.
// Fixed-cost, polite (rAF-throttled), and a no-op when not zoomed (offsets = 0).
function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let raf = 0;
  // Last values written, to skip redundant setProperty calls. The common case —
  // ordinary momentum scroll at scale 1, where the mobile URL bar fires
  // visualViewport scroll/resize — recomputes the same `0px` every frame;
  // re-writing inherited root custom props each time invalidates style document-
  // wide and shows up as micro-stutter on long pages. Memoising makes it a no-op.
  let lastTop: number | undefined, lastLeft: number | undefined, lastRight: number | undefined, lastBottom: number | undefined;
  const apply = () => {
    raf = 0;
    // Only re-pin while genuinely pinch-zoomed (scale > 1). At scale 1 the visual
    // and layout viewports can still differ — a mobile browser's retractable
    // toolbar (URL bar) shrinks the visual viewport as it shows/hides on scroll —
    // but there position:fixed already tracks the layout-viewport edges, so a
    // computed inset would wrongly float a bottom-pinned bar up above where the
    // (often hidden) controls sit, and have it drift as you scroll. Zeroing the
    // offsets at scale 1 hands the un-zoomed case back to native bottom:0.
    const zoomed = vv.scale > 1.01;
    const top = zoomed ? Math.max(0, vv.offsetTop) : 0;
    const left = zoomed ? Math.max(0, vv.offsetLeft) : 0;
    const right = zoomed ? Math.max(0, root.clientWidth - left - vv.width) : 0;
    const bottom = zoomed ? Math.max(0, root.clientHeight - top - vv.height) : 0;
    if (top === lastTop && left === lastLeft && right === lastRight && bottom === lastBottom) return;
    lastTop = top; lastLeft = left; lastRight = right; lastBottom = bottom;
    root.style.setProperty('--vv-top', `${top}px`);
    root.style.setProperty('--vv-left', `${left}px`);
    root.style.setProperty('--vv-right', `${right}px`);
    root.style.setProperty('--vv-bottom', `${bottom}px`);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  apply();
}

async function boot(): Promise<void> {
  const host = await createBridge();
  trackVisualViewport();

  // Chrome follows the brand: override the theme accent triples from the active
  // brand's semantic primary (a doc with no semantic slots — SUSE's — leaves the
  // hardcoded chrome). Fire-and-forget; the accents refine in place once tokens land.
  // User fonts first: --font-brand may name a locally-stored Google Font, so its
  // FontFaces should be in document.fonts by the time the stack applies (both are
  // async and best-effort — worst case the face pops in a beat later).
  void registerUserFonts(host as unknown as Parameters<typeof registerUserFonts>[0])
    .finally(() => { void applyChromeBrandVars(host); });

  // Profile is the canonical theme store. Apply it now so the theme is correct
  // before the first view renders. Also keeps localStorage in sync for FOUC.
  const profile = await host.profile.get();
  const profileTheme = (profile as { theme?: string }).theme;
  if (profileTheme) applyTheme(profileTheme, false);

  // Interface sounds: the profile is the canonical mute store (like the theme). Reconcile
  // the sfx layer's localStorage-derived flag with the profile's value once it has loaded,
  // then install the one set of app-wide, delegated cue listeners (idempotent).
  hydrateSfxMuted((profile as { sfxMuted?: boolean }).sfxMuted);
  hydrateSfxVolume((profile as { sfxVolume?: number }).sfxVolume);
  installGlobalSfx();
  installGlobalReveal();
  // Mirror the profile's feature flags to localStorage so surfaces that render before
  // (or without) the profile — the Sound control's Neurospicy player in popovers — can
  // gate synchronously.
  hydrateFeatureFlags(profile as Parameters<typeof hydrateFeatureFlags>[0]);
  // Neurospicy Mode — reconcile the saved focus-loop state, then (only if the feature is
  // enabled and it was on) arm a one-shot gesture to resume the loop, since audio can't
  // autoplay before a gesture.
  hydrateNeurospicy((profile as { neurospicy?: unknown }).neurospicy);
  if (flagEnabledSync('neurospicy')) {
    armNeurospicy(host as unknown as Parameters<typeof armNeurospicy>[0]);
    syncNeuroDock(host as unknown as Parameters<typeof syncNeuroDock>[0]);   // show the bottom-right dock if the mode was left on
  }
  // EVERY user-asset delete funnels through the bridge, which announces it here —
  // an audio delete must also leave the music player (stopping it, or advancing,
  // if it was the sounding track), no matter which surface deleted it (catalog,
  // picker, the saved-sessions folder overlay, Projects). Not gated on the feature
  // flag: purging dead cache entries is correct even while the player is hidden.
  document.addEventListener('lolly:user-asset-deleted', (e) => {
    const d = (e as CustomEvent<{ id?: string; type?: string }>).detail;
    if (d?.type === 'audio' && d.id) void dropNeurospicyTracks(host as unknown as Parameters<typeof dropNeurospicyTracks>[0], [d.id]);
  });

  // Prime the in-memory tool index from the last cached copy so the gallery can
  // paint immediately, before the network catalog sync resolves. syncCatalog
  // overwrites window.__toolIndex with fresh data when it lands. (Mirrors the
  // 'sbt-tool-index' fallback key written by catalog/sync.js.)
  if (!window.__toolIndex) {
    try {
      const cached = localStorage.getItem('sbt-tool-index');
      if (cached) window.__toolIndex = JSON.parse(cached);
    } catch { /* ignore corrupt/oversized cache */ }
  }

  const catalogReady = syncCatalog(host as unknown as Parameters<typeof syncCatalog>[0]);
  catalogReady.then(() => syncCorePrefetch(host as unknown as Parameters<typeof syncCorePrefetch>[0])); // fire-and-forget after sync
  // The Neurospicy dock mounts ABOVE, before this sync starts — on a cold install its
  // track list would be built from a not-yet-synced catalog. Rebuild it once assets land.
  catalogReady.then(() => { if (flagEnabledSync('neurospicy')) invalidateNeurospicyTracks(); }).catch(() => { /* offline boot — cache-skip above already re-queries */ });

  // First-run seed: give a brand-new user the catalog's curated default asset favourites
  // (see catalog/assets/index.json → defaultFavourites) so those headshots are pinned in
  // the "Favourites" section at the top of every picker on their first visit. One-time and
  // best-effort — only when the user has NEVER set asset favourites (an explicit choice,
  // including clearing them all, leaves favouriteAssets defined and always wins). Runs after
  // the asset sync so the id list is populated; the profile write is a single idempotent put.
  catalogReady.then(async () => {
    if (profile.favouriteAssets !== undefined) return;
    const ids = defaultFavouriteAssetIds();
    if (ids.length) await saveFavouriteAssets(host as unknown as Parameters<typeof saveFavouriteAssets>[0], profile, new Set(ids));
  }).catch(() => { /* seeding is best-effort; a failed write just means no pins this run */ });

  // The gallery can paint instantly from a CACHED index, then silently refresh
  // when the network sync lands. But a brand-new user has no cache, and painting
  // { tools: [] } would flash the gallery's *failure* empty-state ("couldn't
  // load the tools — check your connection") during a sync that's actually
  // succeeding. So only take the fast path when we already have an index;
  // otherwise wait for the sync (it resolves even offline, falling back to cache)
  // so the first paint is real data, not a false error. Deep links to a
  // tool/profile/etc. need the synced catalog (asset metadata) before their first
  // render, so those keep the original "sync, then navigate" ordering.
  // Paint instantly from cache instead of blocking on the full catalog network
  // sync, then reconcile when it lands. The gallery and the dashboard need a
  // CACHED index (gallery would otherwise flash its load-failure empty state
  // mid-sync; the dashboard would briefly show "none loaded" for its catalogue
  // breakdown) — but the dashboard still fast-paths without one, since its one
  // urgent live value is a tool count that's gracefully hidden when absent and
  // patched in place once synced. Deep-linked /tool and /profile keep the
  // sync-then-navigate ordering: they genuinely need synced asset metadata first.
  const routeName = parseRoute().name;
  const fastPath =
    ((routeName === 'gallery') && window.__toolIndex) ||
    routeName === 'dashboard';

  if (fastPath) {
    await navigate(host, { force: true });
    catalogReady.then(() => {
      const now = parseRoute().name;
      if (!toolIndexChanged()) return; // no-op sync — data is byte-identical to the cached copy
      if (now === 'gallery') {
        // Re-render from fresh data — the gallery's cascade only replays because
        // the data actually changed (guarded above), not on every sync. force: the
        // route is unchanged (gallery→gallery), so the dedup would otherwise skip it.
        navigate(host, { force: true }).catch(console.error);
      } else if (now === 'dashboard') {
        // Patch the tool count in place. Re-navigating would replay the entrance
        // cascade just to update a number — the exact jitter we're removing. The
        // catalogue tile breakdown refreshes on the next visit.
        patchDashboardToolCount();
      }
    });
  } else {
    await catalogReady;
    await navigate(host, { force: true });
  }

  // Warm the likely-next view chunks so the first tap doesn't pay a cold dynamic-import.
  // import() promises are cached, so the later route reuses these.
  const warmTool = (): void => { void import('./views/tool.ts').catch(() => {}); };

  // The TOOL view is special: it statically pulls the render engine (createRuntime +
  // Handlebars + Ajv + export, ~170 KB gz). That used to sit on the boot preload — moving
  // it off made the gallery boot lean, but a cold first tool-open now shows a "Loading…"
  // state while those chunks arrive. So warm it PROMPTLY (tight idle timeout wins the slot
  // even while the featured row is rendering), not on deep idle — the cold window shrinks
  // from ~1.6s to <0.6s. Lolly is a tool app; the tool engine being warm matters most.
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warmTool, { timeout: 600 });
  else setTimeout(warmTool, 200);

  // Belt-and-suspenders: warm the engine the instant a tool link is hovered or pressed, so
  // even a tap inside that <0.6s window opens warm. Capture-phase, one-shot (import() caches),
  // and it fires ahead of the click that navigates. Covers gallery tiles, the featured row,
  // catalog, search results — anything linking to a tool — with one delegated listener.
  let toolWarmed = false;
  const warmOnIntent = (e: Event): void => {
    if (toolWarmed) return;
    if ((e.target as HTMLElement | null)?.closest?.('a[href*="tool/"]')) { toolWarmed = true; warmTool(); }
  };
  document.addEventListener('pointerover', warmOnIntent, { capture: true, passive: true });
  document.addEventListener('pointerdown', warmOnIntent, { capture: true, passive: true });

  // The other route chunks are light — deep idle is fine.
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => {
      import('./views/dashboard.ts').catch(() => {});
      import('./views/projects.ts').catch(() => {});
      import('./views/catalog.ts').catch(() => {});
    });
  }

  // Re-render on any route change. hashchange covers legacy #/… links and external
  // deep links; popstate covers History-API back/forward across /t/<id> tool entries;
  // 'lolly:navigate' is fired by navigateTo() for in-app links that leave a tool.
  // A microtask debounce collapses a synchronous same-tick burst; the real guard against
  // the hashchange+popstate DOUBLE-mount (whose events land in separate macrotasks, which
  // a microtask can't span) is the same-route dedup inside navigate() itself.
  let navQueued = false;
  const onRouteChange = () => {
    if (navQueued) return;
    navQueued = true;
    Promise.resolve().then(() => { navQueued = false; navigate(host).catch(console.error); });
  };
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('lolly:navigate', onRouteChange);

  document.querySelectorAll<HTMLElement>('[data-route]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.route;
      window.location.hash = r === 'gallery' ? '' : `#/${r}`;
    });
  });
}

function parseRoute(): Route {
  const hash = window.location.hash.slice(1);

  if (hash && hash !== '/') {
    const [path, query] = hash.split('?');
    const parts = (path ?? '').split('/').filter(Boolean);
    if (parts[0] === 'tool' && parts[1]) {
      return { name: 'tool', toolId: parts[1], params: query || '' };
    }
    if (parts[0] === 'profile') return { name: 'profile', params: query || '' };
    if (parts[0] === 'd' || parts[0] === 'dashboard') return { name: 'dashboard', params: query || '' };
    // /b and /brand are shortlinks straight to the Dashboard's Design System tab.
    // Redirect (like /platform → /d) so mountDashboard reads ?tab=brand off the hash.
    if (parts[0] === 'b' || parts[0] === 'brand') {
      const q = query ? `${query}&tab=brand` : 'tab=brand';
      window.location.replace(`/#/d?${q}`);
      return { name: 'dashboard', params: q };
    }
    // /platform and /capabilities merged into the single Dashboard (#/d). Redirect
    // old links (and their deep-link flags) so bookmarks keep working — the flags
    // still resolve, since the dashboard's sections carry the same data-flag keys.
    if (parts[0] === 'platform' || parts[0] === 'capabilities') {
      window.location.replace(`/#/d${query ? `?${query}` : ''}`);
      return { name: 'dashboard', params: query || '' };
    }
    if (parts[0] === 'verify' || parts[0] === 'valid' || parts[0] === 'v') return { name: 'verify', params: query || '' };
    if (parts[0] === 'start') return { name: 'start', params: query || '' }; // brand wizard
    if (parts[0] === 'pro') return { name: 'pro', params: query || '' }; // /pro batch mode
    if (parts[0] === 'p') return { name: 'projects', folderId: parts[1] || null, params: query || '' };
    if (parts[0] === 'c' || parts[0] === 'catalog') return { name: 'catalog', params: query || '' };
    return { name: 'gallery' };
  }

  const pathParts = window.location.pathname.split('/').filter(Boolean);
  // /t/<id> is a tool's canonical address-bar URL (path form, so a copied link
  // carries the per-tool OG preview — see scripts/build-tool-og.ts); params ride in
  // the query string. Returned as a first-class tool route — NOT redirected to the
  // hash — so History-API back/forward to a /t/<id> entry re-mounts correctly. In
  // production the server serves the static OG stub at this exact path and the stub
  // bounces a human into #/tool/<id>, which mounts and then syncUrl rewrites the bar
  // back to /t/<id>; this branch is what re-mounts on client-side popstate to it.
  if (pathParts.length === 2 && pathParts[0] === 't') {
    return { name: 'tool', toolId: pathParts[1]!, params: window.location.search.slice(1) };
  }
  // /p (Projects root) and /p/<folderId> deep links → redirect into the canonical
  // hash form so all in-app projects navigation stays hash-based (folders are private
  // profile data — no OG stub / first-class path needed, unlike /t/). Same redirect
  // style as /pro|/platform|/capabilities. Must precede the length===1 tool-shortcut
  // block so a bare /p isn't treated as a tool id.
  if (pathParts[0] === 'p') {
    window.location.replace(`/#/p${pathParts[1] ? '/' + pathParts[1] : ''}${window.location.search}`);
    return { name: 'projects', folderId: pathParts[1] || null };
  }
  if (pathParts.length === 1) {
    // /pro and /d are real routes; everything else is a tool shortcut. /platform and
    // /capabilities are retired aliases that fold into the Dashboard.
    if (pathParts[0] === 'pro') { window.location.replace('/#/pro'); return { name: 'pro' }; }
    if (pathParts[0] === 'd' || pathParts[0] === 'dashboard' || pathParts[0] === 'platform' || pathParts[0] === 'capabilities') {
      // Preserve any deep-link query (e.g. /platform?print) across the redirect,
      // like the hash-form branch and the tool-shortcut fallback below.
      window.location.replace(`/#/d${window.location.search}`);
      return { name: 'dashboard', params: window.location.search.slice(1) };
    }
    // /verify is canonical; /valid and the /v shortlink are aliases.
    if (pathParts[0] === 'verify' || pathParts[0] === 'valid' || pathParts[0] === 'v') { window.location.replace('/#/verify'); return { name: 'verify' }; }
    // /start is the brand wizard, not a tool shortcut.
    if (pathParts[0] === 'start') { window.location.replace('/#/start'); return { name: 'start' }; }
    // /b and /brand → the Dashboard's Design System tab (shortlinks, not tools).
    if (pathParts[0] === 'b' || pathParts[0] === 'brand') {
      const q = window.location.search ? `${window.location.search.slice(1)}&tab=brand` : 'tab=brand';
      window.location.replace(`/#/d?${q}`);
      return { name: 'dashboard', params: q };
    }
    window.location.replace(`/#/tool/${pathParts[0]}${window.location.search}`);
    return { name: 'gallery' };
  }

  return { name: 'gallery' };
}

// Only register the service worker in production builds. In dev it would cache
// /tools/ files, so a slow reload could serve a stale edit instead of the file
// just changed on disk.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Never a blank page: recover from a stale app shell ────────────────────────
// A cached shell one deploy behind points its lazy chunks (the router's
// `await import('./views/…')`) at content-hashes the new deploy removed, so the
// import 404s ("Failed to fetch dynamically imported module"). A reload boots on
// the fresh, network-first shell. This must be bullet-proof from EVERY angle a
// failure surfaces — Vite's preloadError, an unhandled rejection, a failed
// <script>/<link>, or a router mount that throws — and must NEVER strand the user
// on a blank page: when a reload can't help (just retried, or offline) show a
// visible Reload card and auto-recover the moment connectivity returns.
const CHUNK_RELOAD_KEY = 'lolly-chunk-reload-at';
const CHUNK_ERR_RE = /(dynamically imported module|module script failed|error loading dynamically|loading chunk|chunkloaderror|failed to fetch)/i;

function looksLikeChunkError(v: unknown): boolean {
  const e = v as { message?: unknown; reason?: { message?: unknown } | string } | null;
  const msg = String(e?.message ?? (typeof e?.reason === 'string' ? e.reason : e?.reason?.message) ?? v ?? '');
  return CHUNK_ERR_RE.test(msg);
}

// A visible, always-actionable fallback — the last-resort alternative to a blank
// container. Mirrors boot()'s error card (className 'error', a .btn Reload).
function showReloadCard(message?: string): void {
  const view = document.getElementById('view');
  if (!view) return;
  view.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'error';
  const p = document.createElement('p');
  p.style.margin = '0 0 10px';
  p.textContent = message || 'This page needs a quick refresh to load the latest version.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => window.location.reload());
  wrap.append(p, btn);
  view.append(wrap);
  if (navigator.onLine === false) window.addEventListener('online', () => window.location.reload(), { once: true });
}

let chunkRecovering = false;
function recoverFromStaleShell(): void {
  if (chunkRecovering) return;              // one attempt per episode (preloadError + rejection can co-fire)
  chunkRecovering = true;
  const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0);
  // Online and haven't just reloaded → one silent reload fixes the stale shell.
  if (navigator.onLine !== false && Date.now() - last > 15_000) {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    window.location.reload();               // page unloads; the flag stays set until it does
    return;
  }
  // Reload already tried (and didn't fix it) or we're offline → don't loop; show
  // the card so the user is never left on a blank page.
  showReloadCard();
  chunkRecovering = false;
}

if (import.meta.env.PROD) {
  window.addEventListener('vite:preloadError', (event) => { event.preventDefault(); recoverFromStaleShell(); });
  window.addEventListener('unhandledrejection', (event) => {
    if (looksLikeChunkError(event)) { event.preventDefault(); recoverFromStaleShell(); }
  });
  // Resource-load failures (a removed hashed <script>/<link>) don't bubble — catch
  // them in the capture phase, scoped to our own same-origin JS/CSS so an unrelated
  // asset error never triggers a reload.
  window.addEventListener('error', (event) => {
    const el = event.target as (HTMLScriptElement & HTMLLinkElement) | null;
    const src = (el && (el.src || el.href)) || '';
    const isAppChunk = typeof src === 'string' && src.startsWith(location.origin) && /\.(m?js|css)(\?|$)/.test(src);
    if (isAppChunk || looksLikeChunkError(event)) recoverFromStaleShell();
  }, true);
}

boot().catch(err => {
  console.error('Boot failed:', err);
  // A stale-shell chunk failure during boot recovers the same way navigation does —
  // reload onto the fresh shell (or a visible Reload card), never a dead screen.
  if (import.meta.env.PROD && looksLikeChunkError(err)) { recoverFromStaleShell(); return; }
  // Build the error node with textContent — never interpolate err.message into
  // innerHTML (it can carry attacker-influenced strings).
  const view = document.getElementById('view')!;
  view.textContent = '';
  const div = document.createElement('div');
  div.className = 'error';
  const msg = document.createElement('p');
  msg.style.margin = '0';
  msg.textContent = `Boot failed: ${err.message}`;
  div.appendChild(msg);

  // A locked/wedged database is recoverable: once the offending tab (or a page
  // frozen in the bfcache) closes, a reload boots cleanly. The common trigger is
  // a DB version upgrade blocked by an older tab. Rather than dead-ending here,
  // offer a Reload button AND auto-reload once when this page next regains
  // visibility — i.e. the moment the user switches back after closing the other
  // tab — so recovery doesn't depend on them knowing to reload manually.
  if (err && (err.code === 'DB_BLOCKED' || err.code === 'DB_OPEN_TIMEOUT')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'Reload';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', () => window.location.reload());
    div.appendChild(btn);

    let retried = false;
    const retry = () => {
      if (retried || document.visibilityState !== 'visible') return;
      retried = true; // one automatic attempt, then leave it to the button
      window.location.reload();
    };
    document.addEventListener('visibilitychange', retry);
    window.addEventListener('focus', retry);
  }

  view.appendChild(div);
});
