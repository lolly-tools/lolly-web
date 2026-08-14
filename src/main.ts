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
import type { Profile } from '@lolly-tools/core/host-v1';
import { syncCatalog, syncCorePrefetch, defaultFavouriteAssetIds, toolIndexChanged, localizeToolIndex } from './catalog/sync.ts';
import { saveFavouriteAssets } from './lib/asset-favourites.ts';
import { mountGallery } from './views/gallery.ts';
import { initTheme, applyTheme } from './theme.ts';
import { hydrateA11yPrefs, currentA11yPrefs, setA11yPref } from './lib/a11y-prefs.ts';
import { initI18n } from './i18n.ts';
import { applyChromeBrandVars } from './brand-vars.ts';
import { hydrateSfxMuted, hydrateSfxVolume, installGlobalSfx, playSfx } from './lib/sfx.ts';
import { hydrateFeatureFlags, flagEnabledSync, setJellyDefault } from './feature-flags.ts';
// Side-effect only: registers the "Private collab" Share-dialog row into the
// generic lib/share-sections.ts seam (plan 100 §0/§6, Track A — an OSS
// individual feature, not under org/). The row itself stays gated on the
// private-collab flag + a registered opener and renders nothing until both
// exist (see the module header) — importing it is the whole of the wiring.
import './lib/collab-share-private.ts';
// Side-effect only: registers the 'private' opener that row consults, so pressing
// "Start a collab" opens the inviter ceremony (plan 100 §6.1). Gated INSIDE the opener
// on the same private-collab flag, and platform-free on this path — the ceremony
// dialog, the QR encoder and the WebRTC transport are one dynamic import behind the
// press, sharing the chunk the #/join route loads (see the module header).
import './collab/private-opener.ts';
// The other end of that ceremony: what turns a connected pair into a MOUNTED, co-editing
// tool (plan 100 §5, §6.2a). `lib/collab-mount.ts`'s header specifies the two-line stitch
// — register, then drain whatever the ceremony parked while this module was importing —
// and `installLiveCollabMount()` (called below the import block) is its only call site.
// Platform-free on the boot path for the same reason as the opener above: everything
// under it (the memory state bridge, the tool route itself) is a dynamic import.
import { installLiveCollabMount } from './lib/collab-live-mount.ts';
// Side-effect wire for LAN discovery (plans/110 §3): registers the 'lan' NearbyProvider
// ONLY when the Tauri runtime is present (probed at call time). A no-op on the web — a
// PWA cannot do mDNS/sockets — so the registry stays empty and every Nearby affordance
// stays absent, keeping the web build byte-identical. The native side is Rust `nearby.rs`.
import { installNearbyBoot } from './lib/nearby-boot.ts';
// The acceptor side of a nearby pairing: opens the accept ceremony when a peer hands us an
// invite over the nearby channel (plans/110 §3). Dormant off Tauri / with the flag off.
import { installNearbyAccept } from './collab/nearby-accept.ts';
import { initSearchBar, applySearchBarRoute } from './components/search-bar.ts';
import { initSpotlight } from './components/spotlight.ts';
import { ensureJelly, jellyEnabled } from './lib/jelly.ts';
import { applyCaptureNeutral } from './lib/capture-neutral.ts';
import { peekNeuroDemo, applyNeuroDemo } from './lib/neuro-demo.ts';
import { syncJellyNavToggle, UTILITIES_FLAG_ID, type ViewToggleKey } from './components/view-toggle.ts';
import { installGlobalReveal } from './lib/reveal.ts';
import { maybeShowFirstRunInstanceSheet } from './lib/instance-choice.ts';
import { initOrg } from './org/index.ts';
import { initSelectPreview } from './select-preview.ts';
import { recordTool, recordBatch, bumpMetric, recordFormat } from './metrics.ts';
import { announce } from './a11y.ts';
import { beginViewFade } from './view-fade.ts';
import { noteLeavingHref, takeLeavingHref, recordLeave, noteMountedView } from './lib/back-nav.ts';

// Own co-editing (see the import). Registering here rather than as an import side effect
// is deliberate: the drain half must run AFTER the registration, and a drain hidden
// inside `registerCollabMount` would fire re-entrantly during that module's own import.
installLiveCollabMount();
// Register the LAN discovery provider if we're on Tauri; dormant no-op on the web.
installNearbyBoot();
// …and listen for inbound nearby invites (after the provider is registered above).
installNearbyAccept();

/** The web capability bridge, as produced by createBridge. */
type WebHost = Awaited<ReturnType<typeof createBridge>>;

/** Route names the shell can be in. */
type RouteName = 'gallery' | 'utilities' | 'tool' | 'profile' | 'dashboard' | 'pro' | 'projects' | 'catalog' | 'verify' | 'convert' | 'data' | 'start' | 'multi' | 'components' | 'lab' | 'pdf' | 'script' | 'ask' | 'join' | 'join-reply';

/** A parsed route: a discriminated union on `name`. */
type Route =
  | { name: 'tool'; toolId: string; params: string }
  | { name: 'profile'; params: string }
  | { name: 'dashboard'; params?: string }
  | { name: 'verify'; params?: string }
  | { name: 'convert'; params?: string }
  | { name: 'data'; params?: string }
  | { name: 'pro'; params?: string }
  | { name: 'projects'; folderId: string | null; params?: string }
  | { name: 'catalog'; params?: string }
  | { name: 'start'; params?: string }
  | { name: 'multi'; params?: string }
  | { name: 'components' }
  | { name: 'utilities'; params?: string }
  | { name: 'lab'; params?: string }
  | { name: 'pdf' }
  | { name: 'script' }
  | { name: 'ask'; params?: string }
  | { name: 'join'; params?: string }
  | { name: 'join-reply'; params?: string }
  | { name: 'gallery'; params?: string };

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

/**
 * Which piece of a route's sub-state its dedup signature keys on (see
 * routeSignature). Absent ⇒ the route name alone is the whole signature.
 */
type RouteSigKey = 'toolId' | 'folderId' | 'params';

/** Everything the router needs to know about one route, in one place. */
interface RouteSpec {
  /** Spoken name, announced to assistive tech after the view mounts. */
  label: string;
  /** The view-toggle tab this route lights up. Absent ⇒ no tab bar. */
  tab?: ViewToggleKey;
  /** Scoping classes #view carries while this route is mounted. */
  viewClasses?: readonly string[];
  /** The sub-state the dedup signature keys on. */
  sigKey?: RouteSigKey;
  /** Whether the persistent bottom search bar shows on this route (plans/99 M1):
   *  'search' on the browse views, 'none' (the default) on editing views and the
   *  utility views that keep their own chrome for now. */
  footer?: 'search' | 'none';
}

/**
 * THE route table — the single source of truth for per-route chrome. The tab a
 * route lights up, the scoping classes #view carries, the announced label and
 * the dedup signature's shape are all derived from here, so adding a view means
 * adding one row (plus its parseRoute branch and its lazy mount case) rather
 * than editing four parallel lists that silently half-work when one is missed.
 */
const ROUTES: Record<RouteName, RouteSpec> = {
  gallery: { label: 'Tools gallery', tab: 'tools', viewClasses: ['gallery-view'], footer: 'search' },
  // Utilities IS the gallery view (mountGallery in only-utility mode), so it must
  // carry the same scoping class — gallery.css's desktop saved-list grid, footer
  // padding and every other .gallery-view rule apply identically. Without it the
  // mounted markup is styled by nothing and the view renders broken/blank.
  utilities: { label: 'Utilities', tab: 'utilities', viewClasses: ['gallery-view', 'utilities-view'], footer: 'search' },
  tool: { label: 'Tool', viewClasses: ['tool-view'], sigKey: 'toolId', footer: 'none' },
  profile: { label: 'Profile', viewClasses: ['profile-view'], sigKey: 'params', footer: 'search' },
  // The dashboard keys on its query too, so a deep link that only changes a flag
  // (#/d → #/d?print, or an old #/platform?x redirect) re-mounts and re-applies
  // the open+scroll, instead of being deduped as the same 'dashboard' route.
  dashboard: { label: 'Dashboard', viewClasses: ['dashboard-view'], sigKey: 'params', footer: 'search' },
  // params-keyed so #/pro?s=slot,slot… ("Edit as sheet") and #/pro?session=… deep
  // links re-seed the grid and survive Back. Safe: /pro never rewrites its own
  // params mid-session (its only location writes navigate AWAY — see index.ts).
  pro: { label: 'Batch mode', viewClasses: ['pro-view'], sigKey: 'params', footer: 'none' },
  projects: { label: 'Projects', tab: 'projects', viewClasses: ['projects-view'], sigKey: 'folderId', footer: 'search' },
  catalog: { label: 'Catalogue', tab: 'catalog', viewClasses: ['catalog-view'], footer: 'search' },
  // Verify/Convert/PDF/Lab keep their own chrome in v1 — the bar reaches them in
  // plans/99 M3 once proven (decision locked 2026-08-08).
  verify: { label: 'Verify', viewClasses: ['verify-view'], footer: 'none' },
  convert: { label: 'Convert', viewClasses: ['convert-view'], footer: 'none' },
  data: { label: 'Spreadsheet', viewClasses: ['data-view'], footer: 'none' },
  // The studio keys on ?tab= for the same reason — "Manage fonts" (#/start?tab=type)
  // clicked while already on #/start must switch steps, not dedupe to a no-op.
  start: { label: 'Brand setup', viewClasses: ['start-view'], sigKey: 'params', footer: 'none' },
  // Multi-edit keys on its selection (?s=slot,slot…) so editing a different
  // selection re-mounts with the new set instead of deduping.
  multi: { label: 'Multi-edit', viewClasses: ['multi-view'], sigKey: 'params', footer: 'none' },
  // Components keeps its footerNav SPECIMEN (in-flow, neutralised in components.css)
  // rather than the live bar.
  components: { label: 'Component library', footer: 'none' },
  // The Lab gets NO tab. It's a utility you open and come back from, like any tool
  // page — so it gets the back pill and no tab bar. Lighting the Utilities tab
  // here would suggest the pill is where you are rather than where you'd go,
  // and the tabs would compete with the report's own numbered sequence.
  lab: { label: 'Colour Lab', footer: 'none' },
  pdf: { label: 'Take a PDF apart', viewClasses: ['pdfx-view'], footer: 'none' },
  // Script audio is a utility view like the Lab: no tab, the back pill instead
  // (see the lab row's rationale above).
  script: { label: 'Script audio', viewClasses: ['scriptst-view'], footer: 'none' },
  // Ask Lolly (#/ask) — the in-app help surface (plans/103). A utility view like
  // the Lab: no tab, the back pill, and its OWN composer (footer: 'none') rather
  // than the shell search bar, since chat-Enter is a submit the bar has no slot
  // for. Keys on `params` so a fresh #/ask?q= from spotlight (or a Back into it)
  // re-mounts and appends the new question to the session transcript instead of
  // deduping onto the first.
  ask: { label: 'Ask Lolly', viewClasses: ['ask-view'], sigKey: 'params', footer: 'none' },
  // The two private-collab ceremony links (plan 100 §6.1 skin 1, §11.25). Both are
  // arrival points from someone ELSE's device, so they get no tab and no footer bar —
  // and both key on `params`, because the whole meaning of the route is the invite (or
  // reply) token in the query: a second link pasted into the same tab must re-mount
  // with the new payload, never dedupe onto the first one.
  join: { label: 'Join a collab', sigKey: 'params', footer: 'none' },
  'join-reply': { label: 'Collab reply', sigKey: 'params', footer: 'none' },
};

/** Every scoping class in ROUTES → the routes that own it, in declaration order. */
const VIEW_CLASS_OWNERS: ReadonlyMap<string, ReadonlySet<RouteName>> = (() => {
  const owners = new Map<string, Set<RouteName>>();
  for (const [name, spec] of Object.entries(ROUTES) as Array<[RouteName, RouteSpec]>) {
    for (const cls of spec.viewClasses ?? []) {
      let set = owners.get(cls);
      if (!set) { set = new Set(); owners.set(cls, set); }
      set.add(name);
    }
  }
  return owners;
})();

/** Routes whose signature keys on `params`, so re-navigating WITHIN them isn't a leave. */
const PARAM_KEYED_ROUTES: ReadonlySet<RouteName> = new Set(
  (Object.entries(ROUTES) as Array<[RouteName, RouteSpec]>)
    .filter(([, spec]) => spec.sigKey === 'params')
    .map(([name]) => name),
);

let _lastRouteName: RouteName | null = null;
// Signature of the route currently mounted — used to drop a redundant re-navigate to the
// SAME route (a single tool open fires hashchange AND popstate → two navigates). See navigate().
let mountedRouteSig = '';

// Announce client-side route changes (the view swaps via innerHTML, which
// assistive tech wouldn't otherwise notice).
function announceRoute(name: RouteName): void {
  announce(`${ROUTES[name]?.label ?? 'Page'} loaded`);
}

/** The view-toggle tab a route lights up — null for routes without the tab bar. */
function navKeyForRoute(name: RouteName): ViewToggleKey | null {
  return ROUTES[name]?.tab ?? null;
}

/**
 * The dedup signature for a parsed route: its name plus whatever sub-state
 * ROUTES says changes what's mounted. See navigate() for the rationale.
 */
function routeSignature(route: Route): string {
  const key = ROUTES[route.name]?.sigKey;
  if (!key) return route.name;
  const sub = route as { toolId?: string; folderId?: string | null; params?: string };
  if (key === 'toolId') return `${route.name}:${sub.toolId ?? ''}`;
  if (key === 'folderId') {
    // The ?q= results-mode param is mount state too (plans/99 §2a): entering or
    // leaving projects results mode must remount in BOTH directions — the
    // overlay's "See all in Projects" handoff forward AND the browser's Back —
    // so the signature carries it alongside the folder. Other params stay out:
    // they don't change what's mounted.
    const q = new URLSearchParams(sub.params ?? '').get('q');
    return `${route.name}:${sub.folderId ?? ''}${q ? `?q=${q}` : ''}`;
  }
  return `${route.name}:${sub.params ?? ''}`;
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
  // Which sub-state each route keys on is declared in ROUTES (sigKey) above.
  const routeSig = routeSignature(route);
  // The URL this navigation left (hashchange oldURL / navigateTo's capture) —
  // consumed on EVERY navigate, even a deduped one, so a stale stash can't
  // leak into a later record. popstate leaves no stash; recordLeave() then
  // falls back to the outgoing view's mount-time URL.
  const leftHref = takeLeavingHref();
  if (!opts.force && routeSig === mountedRouteSig) return;
  const prevSig = mountedRouteSig;
  mountedRouteSig = routeSig;

  // Remember the view being left so the next view's back pill can name it and
  // return there (lib/back-nav.ts). Only on a genuine view change: the routes
  // whose signature keys on params (start/dashboard/profile/multi) re-navigate
  // within themselves (#/start?tab=color → ?tab=type), and a forced same-sig
  // remount (lolly:remount) isn't a leave at all.
  const viewIdent = (sig: string): string => {
    const colon = sig.indexOf(':');
    if (colon < 0) return sig;
    const name = sig.slice(0, colon);
    return PARAM_KEYED_ROUTES.has(name as RouteName) ? name : sig;
  };
  if (prevSig && viewIdent(routeSig) !== viewIdent(prevSig)) recordLeave(leftHref);

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

  // Cross-view fade: snapshot the OUTGOING view now — before its scoping class
  // flips (below) or its markup is torn down (the clear/incoming mount below) — so
  // the blank frame while the next view mounts is hidden behind the old pixels,
  // which fade out once the new view has painted underneath. Only on a genuine
  // view-NAME change (never a same-view refresh, e.g. the gallery's post-sync
  // re-render), and not on the tool→gallery "return" (that path keeps its own
  // instant feel). beginViewFade MOVES #view's nodes into the overlay, so the
  // clear/mount below fill an already-empty container; it returns null under
  // reduced motion or on first boot, collapsing to today's instant swap. commit()
  // (after the mount, or in the catch) starts the fade — or drops the snapshot if
  // superseded by a newer navigation.
  const fade = (prevRouteName && route.name !== prevRouteName && !returning)
    ? beginViewFade(view)
    : null;

  // Scoping classes, from ROUTES: every class any route declares is toggled on
  // EVERY navigation, so the outgoing view's class comes off as the incoming
  // view's goes on. (A route with no viewClasses, e.g. the Lab, scopes itself.)
  for (const [cls, owners] of VIEW_CLASS_OWNERS) view.classList.toggle(cls, owners.has(route.name));
  view.classList.toggle('is-returning', returning);

  // The persistent search bar (plans/99 M1): shown on browse routes, hidden on
  // editing ones. After the outgoing view's _cleanup (its claim is released) and
  // before the incoming mount (which claims it) — and before the try, so a mount
  // failure still leaves the bar consistent with the route.
  applySearchBarRoute(ROUTES[route.name].footer ?? 'none', route.name);

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
      await mountValid(view, host, route.params);
      break;
    }
    // /convert — on-device file converter (fonts, SVG⇄SVGZ, raster⇄raster), a
    // verify-like drop→pick→download surface. Lazy-loaded like the other dashboards.
    case 'convert': {
      const { mountConvert } = await import('./views/convert.ts');
      await mountConvert(view, host, route.params);
      break;
    }
    // /data — on-device spreadsheet viewer/editor (xlsx/csv/tsv/json → virtualized
    // grid → edit → download-as). Lazy-loaded like the other dashboards.
    case 'data': {
      const { mountDataView } = await import('./views/data.ts');
      await mountDataView(view, host, route.params);
      break;
    }
    // --- Multi-edit: 2–8 saved sessions edited side by side (grid of live
    // canvases + one combined sidebar). Reached from the Projects bulk bar. ---
    case 'multi': {
      const { mountMultiEdit } = await import('./views/multi-edit.ts');
      await mountMultiEdit(view, host as unknown as Parameters<typeof mountMultiEdit>[1], route.params ?? '');
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
      // Projects "Edit as sheet": #/pro?s=slot,slot… seeds one grid row per
      // selected session (mirrors #/multi?s=…). Read the refs from the RAW query,
      // NOT via URLSearchParams: a ref is `__batch__:<label>` and a label may hold
      // ',' or '%', which encodeURIComponent wrote as %2C/%25. URLSearchParams.get
      // would decode ONCE — turning an encoded %2C back into a delimiter comma, and
      // leaving a bare '%' that a second decode chokes on. So split the encoded
      // value on the literal commas that only ever separate refs, then decode each
      // piece exactly once (guarded, so a hand-typed malformed ?s= can't throw the
      // whole mount).
      const rawS = (route.params || '').split('&').find(p => p.startsWith('s='))?.slice(2) ?? '';
      const safeDecode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
      const seedRefs = rawS ? rawS.split(',').map(safeDecode).filter(Boolean) : [];
      // Inject a metrics hook rather than letting /pro import metrics.js — keeps
      // the folder's "imports only engine/host/siblings" isolation intact.
      const onBatchRendered = (files: Array<{ name: unknown }>) => {
        recordBatch(files.length);
        bumpMetric('filesRendered', files.length);
        for (const f of files) recordFormat(String(f.name).split('.').pop());
      };
      await mountPro(view, host as unknown as Parameters<typeof mountPro>[1], { sessionSlot, seedRefs, onBatchRendered, openFolderOverlay } as unknown as Parameters<typeof mountPro>[2]);
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
      await mountProjects(view, host, route.folderId, { onBatchRendered, params: route.params });
      break;
    }
    // --- Catalog: a gallery-style view of every asset (catalog + user), plus swatches
    // and downloadable fonts. Lazy-loaded like the other non-gallery views. ---
    case 'catalog': {
      const { mountCatalog } = await import('./views/catalog.ts');
      await mountCatalog(view, host, route.params);
      break;
    }
    // --- /start: the brand studio (set, save, import or export your brand
    // primitives — step tabs, ?tab=<key> deep-links one). Lazy-loaded — it
    // statically pulls the engine's derive/token modules, which the gallery
    // cold-load must not pay for. ---
    case 'start': {
      const { mountStart } = await import('./views/start.ts');
      await mountStart(view, host as unknown as Parameters<typeof mountStart>[1], route.params ?? '');
      break;
    }
    case 'lab': {
      // Colour Lab (#/lab) — a scrolling single-colour report. Lazy: it pulls the
      // gamut solid and the slice charts, which no other view on a cold path needs.
      const { mountColorLab } = await import('./views/color-lab.ts');
      await mountColorLab(view, host as unknown as Parameters<typeof mountColorLab>[1], route.params ?? '');
      break;
    }
    case 'pdf': {
      // Take a PDF apart (#/pdf). Lazy: it pulls the PDF interpreter and pdf-lib,
      // which nothing on the landing path needs.
      const { mountPdfExtract } = await import('./views/pdf-extract.ts');
      await mountPdfExtract(view, host as unknown as Parameters<typeof mountPdfExtract>[1]);
      break;
    }
    case 'script': {
      // Script audio (#/script) — the writing surface over host.speech. Lazy:
      // nothing on the landing path needs the speech plumbing.
      const { mountScriptStudio } = await import('./views/script-studio.ts');
      await mountScriptStudio(view, host as unknown as Parameters<typeof mountScriptStudio>[1]);
      break;
    }
    case 'ask': {
      // Ask Lolly (#/ask) — in-app help over the docs + spotlight providers. Lazy:
      // it pulls the ask pipeline (retrieval, md extraction) that no other route needs.
      const { mountAsk } = await import('./views/ask.ts');
      await mountAsk(view, host as unknown as Parameters<typeof mountAsk>[1], route.params ?? '');
      break;
    }
    // --- The private-collab ceremony links (plan 100 §6.1, §11.25). One lazy chunk
    // for both, shared with the Share dialog's "Start a collab" opener: WebRTC, the QR
    // encoder and the ceremony dialog have no business on any other route. ---
    case 'join': {
      const { mountJoinRoute } = await import('./collab/join-route.ts');
      await mountJoinRoute(view, host as unknown as Parameters<typeof mountJoinRoute>[1], route.params ?? '');
      break;
    }
    case 'join-reply': {
      // No host: this tab hands a payload to the tab that owns the ceremony and gets
      // out of the way — it opens no connection and reads no profile of its own.
      const { mountJoinReplyRoute } = await import('./collab/join-route.ts');
      await mountJoinReplyRoute(view, route.params ?? '');
      break;
    }
    case 'components': {
      // The browsable component library (#/components). Lazy — it's a dev/design
      // surface, off every hot path. Its back pill is the shared one — it names
      // and returns to the view you came from, or the gallery on a cold deep link.
      const { mountComponents } = await import('./views/components.ts');
      await mountComponents(view, host as unknown as Parameters<typeof mountComponents>[1]);
      break;
    }
    case 'utilities':
      // The gallery in only-utilities mode: same view, same wiring, filtered to
      // the on-device utility tools (compress-pdf, strip-data, countdown-timer…).
      // The 'Offline Utilities' flag governs the WHOLE view now — off means no
      // tab and no route (a deep link lands on the main gallery).
      if (!flagEnabledSync(UTILITIES_FLAG_ID)) { window.location.replace('#'); return; }
      await mountGallery(view, host as unknown as Parameters<typeof mountGallery>[1], { only: 'utility', params: route.params });
      break;
    case 'gallery':
      await mountGallery(view, host as unknown as Parameters<typeof mountGallery>[1], { params: route.params });
      break;
    default:
      await mountGallery(view, host as unknown as Parameters<typeof mountGallery>[1]);
  }
  } catch (err) {
    console.error('View mount failed:', err);
    // Fade the outgoing snapshot out either way, so it can't linger over the
    // reload card (or the fresh shell after a stale-chunk reload).
    fade?.commit();
    if (import.meta.env.PROD && looksLikeChunkError(err)) { recoverFromStaleShell(); return; }
    showReloadCard('This view didn’t finish loading. Reload to try again.');
    return;
  }

  // The mount settled: its document.title is set and any URL canonicalisation
  // (the tool view's /t/<id> rewrite) is done — snapshot it as the candidate
  // "previous view" for the next navigation's back pill.
  noteMountedView(route.name);

  // Reconcile the persistent jelly tab pill (view-toggle.ts): listing views
  // show it (the pill slides to the active tab), everything else hides it.
  syncJellyNavToggle(navKeyForRoute(route.name));

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

  // The incoming view is mounted and scrolled to top — fade the outgoing snapshot
  // out over it. A no-op when there was no fade (same-view refresh, reduced motion).
  fade?.commit();

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

  // Installing the PWA re-arms the one-time offline nudge (views/offline-nudge.ts):
  // an install puts an icon on the device while precaching only the shell, so a
  // user who installs reasonably believes "I have the app now" — and must hear
  // "not all of it, yet" once more, in the installed app's sharper copy, even if
  // they dismissed the browser-tab nudge earlier. One profile write, best-effort.
  window.addEventListener('appinstalled', () => {
    void (async () => {
      try {
        // The web bridge's profile setter — not on the tool-facing ProfileAPI,
        // same structural slice the a11y prefs and the nudges themselves use.
        const profileApi = host.profile as { get(): Promise<Profile>; set?(p: Profile): Promise<void> };
        const current = await profileApi.get();
        if (!current.offlineNudgeDismissed) return;   // nudge is still armed anyway
        await profileApi.set?.({ ...current, offlineNudgeDismissed: false });
      } catch { /* best-effort — worst case the nudge simply doesn't reappear */ }
    })();
  });

  // Loopback-only tooling hook: the docs-screenshot pipeline (scripts/
  // build-docs-shots.ts) prints an app page to PDF in its Chromium, then asks the
  // app itself to convert that print into a self-contained true-vector SVG
  // (lib/pdf-vector-shot.ts — the same interpreter the design-import path ships,
  // plus in-page font outlining/inlining only the app can do). Registered HERE,
  // after the host (with its text shaper) exists, and closing over it, so text
  // outlines to <path>. Gated to loopback so it never becomes deployed surface;
  // lazy import, so a normal session pays nothing for it.
  if (/^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)) {
    // `opts` (today: cropCssPx — the region the caller will keep, so the interpreter
    // can drop nodes that provably can't paint there before decoding rasters and
    // shaping text) is optional and passed straight through, so an older harness
    // calling with one argument against a newer dist keeps working.
    (window as unknown as { __lollyVectorShot?: (b64: string, opts?: unknown) => Promise<unknown> }).__lollyVectorShot =
      (b64: string, opts?: unknown) => import('./lib/pdf-vector-shot.ts').then((m) => m.pdfToVectorSvg(
        b64,
        host as unknown as Parameters<typeof m.pdfToVectorSvg>[1],
        (opts ?? {}) as Parameters<typeof m.pdfToVectorSvg>[2],
      ));

    // Sibling loopback hook, same gate: run the DIRECT HTML→SVG walker (the export
    // bridge's renderSvgFromHtml — the path every tool export takes) over an
    // arbitrary page subtree, with NO print-to-PDF in between. Built for the
    // vector-render audit (plans/69-svg-snapshot-without-print.md), and since the
    // walker migration it is ALSO how the docs pipeline captures a `walker=1`
    // recipe — `scripts/build-docs-shots.ts` calls this, not __lollyVectorShot.
    (window as unknown as { __lollyWalkerShot?: (sel?: string) => Promise<unknown> }).__lollyWalkerShot =
      async (sel = 'body', o: Record<string, unknown> = {}) => {
        const node = document.querySelector(sel);
        if (!node) throw new Error(`__lollyWalkerShot: no element matches ${sel}`);
        const t0 = performance.now();
        // convertPaths / rasterFallback are web-bridge ExportOpts, wider than the
        // portable HostV1 ExportOpts this call is typed against — hence the cast.
        // elementScopedRaster: a page snapshot must degrade LOCALLY. Without it one
        // conic-gradient or backdrop-filter on a top-level container rasterises the
        // whole page (measured: 100% raster coverage on two audit fixtures).
        // stackingOrder: a page snapshot must paint in CSS stacking-context order
        // (Appendix E §E.2), not DOM order. Lolly's own gallery has 99 non-auto
        // z-indexes, 22 of them negative, so DOM order puts scrims over content
        // and cards in reverse. Off for tool exports — see ExportOpts.
        // layerIds: this is the production caller plans/104 §7 was written for —
        // "Lolly screenshots become semantically explodable … url-shot output then
        // lifts along real UI boundaries (nav/hero/cards)". The passthrough is inert
        // unless the walked element already carries `data-box-id`, so it changes
        // nothing on a page without a canvas; where it does, the resulting SVG lifts
        // along the boxes the canvas knows about instead of along whatever the markup
        // happened to group, and `enumerateSvgLayers` hands each id back as
        // `layer.boxId` for the lift dialog to name the row with. A caller that wants
        // the old bytes passes `{ layerIds: false }` — `o` is spread last.
        const blob = await host.export.render(node, 'svg', { convertPaths: true, elementScopedRaster: true, stackingOrder: true, backdropBlur: true, layerIds: true, ...o } as Parameters<typeof host.export.render>[2]);
        return { svg: await blob.text(), ms: Math.round(performance.now() - t0) };
      };
  }

  // Chrome follows the brand: override the theme accent triples from the active
  // brand's semantic primary (a doc with no semantic slots — SUSE's — leaves the
  // hardcoded chrome). Fire-and-forget; the accents refine in place once tokens land.
  // User fonts first: --font-brand may name a locally-stored Google Font, so its
  // FontFaces should be in document.fonts by the time the stack applies (both are
  // async and best-effort — worst case the face pops in a beat later).
  // register-user-fonts + load-user-fonts (and its font-utils/font-asset-handler chain)
  // are dynamic-imported off the boot path — this was already fire-and-forget, so a
  // locally-stored --font-brand face applying a beat later is the same tolerated swap.
  void import('./lib/register-user-fonts.ts')
    .then(async ({ registerUserFonts }) => {
      await registerUserFonts(host as unknown as Parameters<typeof registerUserFonts>[0]);
      const { loadUserFonts } = await import('./lib/load-user-fonts.ts');
      await loadUserFonts(host);
    })
    .finally(() => { void applyChromeBrandVars(host); });

  // Profile is the canonical theme store. Apply it now so the theme is correct
  // before the first view renders. Also keeps localStorage in sync for FOUC.
  const profile = await host.profile.get();
  const profileTheme = (profile as { theme?: string }).theme;
  if (profileTheme) applyTheme(profileTheme, false);

  // Accessibility prefs ride the profile the same way (localStorage is only
  // their FOUC mirror, applied by the index.html inline script) — reconcile.
  hydrateA11yPrefs(profile.a11y);
  // One-time migration: "Hide previews" used to be a device-local gallery toggle
  // (localStorage 'lolly-hide-previews'); it is now the hidePreviews a11y pref.
  // Carry an ON choice into the profile once, then retire the old key.
  try {
    if (localStorage.getItem('lolly-hide-previews') === '1' && !currentA11yPrefs().hidePreviews) {
      await setA11yPref(host, 'hidePreviews', true);
    }
    localStorage.removeItem('lolly-hide-previews');
  } catch { /* storage off — nothing to migrate */ }

  // Language — same precedence chain as the theme, plus a session-only `lang`
  // URL override (never written back to the profile — see i18n.ts). Awaited
  // before the first navigate() below so every view renders in the resolved
  // language from its very first paint, with no re-render pass.
  await initI18n({ urlLang: peekUrlLang(), profileLang: (profile as { lang?: string }).lang });

  // Interface sounds: the profile is the canonical mute store (like the theme). Reconcile
  // the sfx layer's localStorage-derived flag with the profile's value once it has loaded,
  // then install the one set of app-wide, delegated cue listeners (idempotent).
  hydrateSfxMuted((profile as { sfxMuted?: boolean }).sfxMuted);
  hydrateSfxVolume((profile as { sfxVolume?: number }).sfxVolume);
  installGlobalSfx();
  installGlobalReveal();
  // Jelly effects default is brand-aware: OFF on a locked brand build (SUSE keeps
  // its stock chrome), ON for the customisable start profile (lolly.art). A user
  // who has toggled the flag keeps their choice either way. Resolved BEFORE the
  // flag mirror below so jellyEnabled()/flagEnabledSync agree from first paint;
  // isLocked() is memoised catalog metadata (IDB, index fetch only on a cold
  // first load) so the await is cheap. Unreachable tokens ⇒ unlocked ⇒ ON.
  const jellyHost = host as { tokens?: { isLocked?(): Promise<boolean> } };
  setJellyDefault(!(await jellyHost.tokens?.isLocked?.().catch(() => false)));
  // Mirror the profile's feature flags to localStorage so surfaces that render before
  // (or without) the profile — the Sound control's Neurospicy player in popovers — can
  // gate synchronously.
  hydrateFeatureFlags(profile as Parameters<typeof hydrateFeatureFlags>[0]);
  // The persistent bottom search bar (plans/99 M1) — one instance for the whole
  // session, mounted after #view. Needs t() (initI18n above) and the flag mirror
  // (hydrateFeatureFlags above, for the Pro link); hidden until the first
  // navigate() below applies the route's footer mode.
  initSearchBar();
  // The spotlight overlay (plans/99 M2): hooks into the bar synchronously (the
  // chord + combobox semantics from first paint) and lazy-loads the provider
  // set off the boot path. Must follow the bar init above — it registers into it.
  initSpotlight(host);
  // An automated screenshot run pins neutral chrome: effect flags off, a11y prefs
  // clear. It has to land HERE — after the line above rewrites the flag mirror from
  // the profile (which discards anything seeded earlier), and before the two reads
  // just below act on it. Inert for everyone else. See lib/capture-neutral.ts.
  if (applyCaptureNeutral()) console.info('[lolly] neutral capture state pinned');
  // Neurospicy Mode + Atmosphere beds — reconcile the saved focus-loop / bed state,
  // then (only if enabled and left on) arm a one-shot gesture to resume, since audio
  // can't autoplay before a gesture. Both modules (lib/neurospicy.ts + lib/atmosphere.ts,
  // which statically couple through neuroAudioContext) are DEFERRED off the boot path:
  // they default OFF, and even for a flag-on user nothing here is needed before first
  // paint — arm only installs a gesture listener, hydrate is pure state. The import is
  // kicked here (after hydrateFeatureFlags + applyCaptureNeutral have settled the flag
  // mirror) so the listener installs ahead of the user's first pointerdown; a first
  // gesture landing in the ~ms import window would miss a one-time resume, which affects
  // only the flag-on minority. The ?neuro docs deep-link runs INSIDE the .then, AFTER the
  // hydrates (they'd overwrite its in-memory demo state) and after applyCaptureNeutral.
  const neuroDemo = peekNeuroDemo();
  void Promise.all([import('./lib/neurospicy.ts'), import('./lib/atmosphere.ts')]).then(([neuro, atmo]) => {
    neuro.hydrateNeurospicy((profile as { neurospicy?: unknown }).neurospicy);
    atmo.hydrateAtmosphere((profile as { atmosphere?: unknown }).atmosphere);
    if (neuroDemo) void applyNeuroDemo(host as unknown as Parameters<typeof applyNeuroDemo>[0], neuroDemo);
    if (flagEnabledSync('neurospicy')) {
      neuro.armNeurospicy(host as unknown as Parameters<typeof neuro.armNeurospicy>[0]);
      atmo.armAtmosphere(host as unknown as Parameters<typeof atmo.armAtmosphere>[0]);
      // Show the bottom-right dock if the mode was left on. The dock (and the music
      // player inside it) is dynamic-imported and only when the mode is actually enabled.
      if (neuro.getNeurospicy().enabled) {
        void import('./components/neuro-dock.ts')
          .then(m => m.syncNeuroDock(host as unknown as Parameters<typeof m.syncNeuroDock>[0]));
      }
    }
  });
  // Jelly effects — start the lazy bundle load now, racing the rest of boot
  // (catalog sync + first view mount) rather than blocking or idle-deferring:
  // surfaces check the synchronous jellyActive() gate at paint, and a
  // same-origin ~52 KB chunk usually wins that race (always, once the service
  // worker has it). If it loses, that first render shows the plain controls —
  // and the .then() below retrofits the persistent nav pill for the view that
  // already mounted. Flag-off users never fetch the chunk.
  if (jellyEnabled()) void ensureJelly().then(ok => { if (ok) syncJellyNavToggle(navKeyForRoute(parseRoute().name)); });
  // Sliders. Deferred off the boot path (no native range paints on the gallery's
  // first frame; the upgrader is a MutationObserver + one initial document sweep, so a
  // late install still catches every range already mounted). Idle-scheduled after the
  // flag hydration above, because the egg-trail is flag-gated and a slider reads that
  // once, when it mounts. Not gated itself: `.custom-slider` is the app's slider in
  // both modes, and the chrome's plain ranges become one wherever they mount.
  const upgradeSliders = (): void => { void import('./components/custom-slider.ts').then(m => m.installRangeUpgrader()); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(upgradeSliders); else setTimeout(upgradeSliders, 200);
  // EVERY user-asset delete funnels through the bridge, which announces it here —
  // an audio delete must also leave the music player (stopping it, or advancing,
  // if it was the sounding track), no matter which surface deleted it (catalog,
  // picker, the saved-sessions folder overlay, Projects). Not gated on the feature
  // flag: purging dead cache entries is correct even while the player is hidden.
  document.addEventListener('lolly:user-asset-deleted', (e) => {
    const d = (e as CustomEvent<{ id?: string; type?: string }>).detail;
    const id = d?.id;
    if (d?.type === 'audio' && id) {
      void import('./lib/neurospicy.ts').then(m => m.dropNeurospicyTracks(host as unknown as Parameters<typeof m.dropNeurospicyTracks>[0], [id]));
    }
  });

  // Prime the in-memory tool index from the last cached copy so the gallery can
  // paint immediately, before the network catalog sync resolves. syncCatalog
  // overwrites window.__toolIndex with fresh data when it lands. (Mirrors the
  // 'sbt-tool-index' fallback key written by catalog/sync.js.) localizeToolIndex
  // runs AFTER initI18n above has resolved the active language, so the very
  // first paint already shows translated tool names/descriptions.
  if (!window.__toolIndex) {
    try {
      const cached = localStorage.getItem('sbt-tool-index');
      if (cached) {
        const primed = JSON.parse(cached);
        localizeToolIndex(primed);
        window.__toolIndex = primed;
      }
    } catch { /* ignore corrupt/oversized cache */ }
  }

  // First-run instance choice (Tauri shells only, once): gate BEFORE the first
  // catalog sync so a chosen instance is honoured immediately instead of a
  // bundled sync followed by a second one. A no-op (one fast IndexedDB read,
  // no dialog) on every later boot and on every non-Tauri shell — see
  // components/instance-sheet.ts's own header for the two callers (this gate,
  // and the profile "Change" button later).
  await maybeShowFirstRunInstanceSheet(host);

  const catalogReady = syncCatalog(host as unknown as Parameters<typeof syncCatalog>[0]);
  catalogReady.then(() => syncCorePrefetch(host as unknown as Parameters<typeof syncCorePrefetch>[0])); // fire-and-forget after sync
  // The Neurospicy dock mounts ABOVE, before this sync starts — on a cold install its
  // track list would be built from a not-yet-synced catalog. Rebuild it once assets land.
  catalogReady.then(async () => {
    if (!flagEnabledSync('neurospicy')) return;
    const m = await import('./lib/neurospicy.ts');
    m.invalidateNeurospicyTracks();
    // Now that the real track list has landed, heal a persisted selection pointing at an
    // asset we've since retired from the catalog (it would otherwise sit enabled-but-silent).
    await m.reconcileNeurospicySelection(host as unknown as Parameters<typeof m.reconcileNeurospicySelection>[0]);
  }).catch(() => { /* offline boot — cache-skip above already re-queries */ });

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
  // Optional deployment control plane (src/org/): dormant + byte-identical to
  // today when a deployment provides no org-config endpoint (the public case) —
  // one tolerant, time-boxed probe, remembered so later boots skip even that. A
  // `gated` deployment with no signed-in member renders its own sign-in gate in
  // place of the app and returns `gate: true`; stop boot before any view mounts.
  const org = await initOrg();
  if (org?.gate) return;

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

  // Android share-target (ACTION_SEND → Lolly): poll the native stash and route
  // shared files through the universal drop chooser. Placed after the first
  // navigate so a cold-start share opens its sheet over a painted view, not the
  // boot skeleton; runs regardless of which view mounted (the chooser is
  // body-mounted). A feature-detected no-op everywhere but the Android WebView.
  // drop-router (the sniff + chooser module) is itself dynamic-imported off the boot
  // path now — its heavy import/ingest deps were already lazy.
  void import('./lib/drop-router.ts').then(m => m.initShareTargetIngest(host as unknown as Parameters<typeof m.initShareTargetIngest>[0]));

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
  // Capture the URL a hash navigation leaves BEFORE the debounced navigate
  // consumes it — it becomes the back-pill target on the next view
  // (lib/back-nav.ts; navigateTo() captures its own, popstate has none).
  window.addEventListener('hashchange', (e) => noteLeavingHref(e.oldURL));
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('lolly:navigate', onRouteChange);
  // Forced same-route remount — lib/drop-router.ts routes a shared file INTO the
  // route the user is already on (its one-shot stashes are consumed at mount),
  // which the same-route dedup inside navigate() would otherwise swallow.
  window.addEventListener('lolly:remount', () => { navigate(host, { force: true }).catch(console.error); });

  document.querySelectorAll<HTMLElement>('[data-route]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.route;
      window.location.hash = r === 'gallery' ? '' : `#/${r}`;
    });
  });
}

// A `lang` override rides either routing form — #/tool/id?lang=de (hash) or
// /t/id?lang=de (path) — so read both instead of depending on parseRoute()
// (which runs later and, for some routes, redirects before boot resolves i18n).
function peekUrlLang(): string | null {
  const hashQuery = window.location.hash.split('?')[1] ?? '';
  return new URLSearchParams(hashQuery).get('lang') ?? new URLSearchParams(window.location.search).get('lang');
}

/** Tools renamed inside the id-break window. parseRoute is the single funnel for every
 *  share link, bookmark, docs link, AND saved-session resume URL (`#/tool/<storedId>?slot=`),
 *  so aliasing the old id here — and ONLY here — keeps all of them resolving instead of
 *  404-ing on the retired id. `layout-studio` → `design` (the Design tool). */
const RENAMED_TOOL_IDS: Record<string, string> = { 'layout-studio': 'design' };
const canonToolId = (id: string): string => RENAMED_TOOL_IDS[id] ?? id;

function parseRoute(): Route {
  const hash = window.location.hash.slice(1);

  if (hash && hash !== '/') {
    const [path, query] = hash.split('?');
    const parts = (path ?? '').split('/').filter(Boolean);
    if (parts[0] === 'tool' && parts[1]) {
      return { name: 'tool', toolId: canonToolId(parts[1]), params: query || '' };
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
    if (parts[0] === 'convert') return { name: 'convert', params: query || '' }; // on-device file converter
    if (parts[0] === 'data') return { name: 'data', params: query || '' }; // on-device spreadsheet viewer/editor
    if (parts[0] === 'start') return { name: 'start', params: query || '' }; // brand wizard
    if (parts[0] === 'multi') return { name: 'multi', params: query || '' }; // multi-edit (?s=slot,slot…)
    if (parts[0] === 'pro') return { name: 'pro', params: query || '' }; // /pro batch mode
    if (parts[0] === 'p') return { name: 'projects', folderId: parts[1] || null, params: query || '' };
    if (parts[0] === 'c' || parts[0] === 'catalog') return { name: 'catalog', params: query || '' };
    if (parts[0] === 'u' || parts[0] === 'utilities') return { name: 'utilities', params: query || '' }; // gallery filtered to the utility category
    if (parts[0] === 'lab') return { name: 'lab', params: query || '' }; // Colour Lab (?c=<any css colour>)
    if (parts[0] === 'pdf') return { name: 'pdf' }; // take a PDF apart — text/asset extraction
    if (parts[0] === 'script') return { name: 'script' }; // Script audio — the TTS writing surface
    if (parts[0] === 'ask') return { name: 'ask', params: query || '' }; // Ask Lolly — in-app help (?q=<question>)
    if (parts[0] === 'components') return { name: 'components' }; // the browsable component library
    // The two halves of a private collab's ceremony (plan 100 §6.1, §11.25). These
    // paths are minted by components/collab-ceremony.ts's JOIN_ROUTE / REPLY_ROUTE —
    // an invite link carries ?inv=<token>, a reply link ?ans=<token>. A test pins the
    // two spellings against each other so a renamed route cannot quietly orphan every
    // invite already sent.
    if (parts[0] === 'join') return { name: 'join', params: query || '' };
    if (parts[0] === 'join-reply') return { name: 'join-reply', params: query || '' };
    // The gallery itself (#/?q=… keeps its query — the search field seeds from it),
    // and the fall-through for any unrecognised hash path.
    return { name: 'gallery', params: query || '' };
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
    return { name: 'tool', toolId: canonToolId(pathParts[1]!), params: window.location.search.slice(1) };
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
    // /design is the Design tool's canonical vanity path — the one tool with a bare
    // top-level URL. Returned as a first-class tool route (NOT redirected), so the bar
    // stays `/design` the way /t/<id> stays put; syncUrl keeps it there via tool.ts's
    // TOOL_URL_BASE special-case, and vercel.json rewrites it to the tool's OG stub.
    if (pathParts[0] === 'design') {
      return { name: 'tool', toolId: 'design', params: window.location.search.slice(1) };
    }
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
    // /components is the browsable component library, not a tool shortcut — a bare
    // /components would otherwise fall through to /#/tool/components and 404.
    if (pathParts[0] === 'components') { window.location.replace('/#/components'); return { name: 'components' }; }
    // The remaining view shortlinks that carry an OG share card (scripts/build-view-og.ts
    // → vercel.json rewrites them to a crawler-visible stub). In production a human never
    // reaches this branch — the stub bounces them into the hash route — but in dev, and on
    // any fall-through, these MUST resolve to their view rather than to /#/tool/<slug>,
    // which would 404 on a tool id that doesn't exist. Same contract as /pro and /start.
    const PATH_VIEWS: Record<string, { hash: string; route: Route }> = {
      tools:     { hash: '#/',     route: { name: 'gallery' } },
      u:         { hash: '#/u',    route: { name: 'utilities' } },
      utilities: { hash: '#/u',    route: { name: 'utilities' } },
      c:         { hash: '#/c',    route: { name: 'catalog' } },
      lab:       { hash: '#/lab',  route: { name: 'lab' } },
      pdf:       { hash: '#/pdf',  route: { name: 'pdf' } },
      profile:   { hash: '#/profile', route: { name: 'profile', params: '' } },
    };
    const view = PATH_VIEWS[pathParts[0]!];
    if (view) {
      const q = window.location.search;
      window.location.replace(`/${view.hash}${q}`);
      return view.route.name === 'profile' ? { name: 'profile', params: q.slice(1) } : view.route;
    }
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
