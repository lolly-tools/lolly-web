// SPDX-License-Identifier: MPL-2.0
/**
 * The app-global SINGLETON audio dock - ONE draggable/resizable window on document.body
 * that BOTH the music player and the docs narration reader feed, so the user never sees
 * two competing windows (plan "this-is-a-very-sparkling-eich", unification pass).
 *
 * COEXIST model: page voice + music can sound AT THE SAME TIME. The one window carries a
 * NARRATION block (page voice: play/scrub/follow/speed) up top and the MUSIC player below
 * (transport + Music/Effects mixer + Tracks/Atmosphere/Visualiser). Each is optional.
 *
 * Sources REGISTER into a stable `ComposedHost` that the dock is built over once:
 *   - components/neuro-dock.ts registers the MUSIC source (flag-gated on neurospicy) as the
 *     flat DockHost (transport + sources/atmosphere/viz/volumes/repeat).
 *   - views/docs.ts registers the NARRATION source (content-gated) as `narrationBlock`.
 * Unregistering removes that block; when no source remains the window hides. The window,
 * its drag position + size, and its collapse pref are shared across both.
 *
 * The audio ENGINES (lib/neurospicy.ts, docs-narration-host's own <audio>) are untouched - 
 * this only owns the shared shell + composition.
 */
import {
  createAudioDock,
  type DockController,
  type DockCapabilities,
  type DockHost,
  type DockNarrationPlayer,
  type DockNowPlaying,
  type DockSources,
  type DockAtmosphere,
  type DockViz,
  type DockRepeat,
  type DockVolume,
  type DockPlacement,
} from '@lolly-tools/audio-dock';
import { isNeuroDockCollapsed, setNeuroDockCollapsed } from './neuro-dock-pref.ts';
import { neuroDemoActive } from './neuro-demo.ts';

const DOCK_ID = 'neuro-dock';
const STYLE_ID = 'lolly-audio-dock-app-styles';
const PLACEMENT_KEY = 'lolly:neuro-dock-placement';

/** The app-level chrome positioning + entrance, scoped to `.neuro-managed` (a marker on
 *  the singleton element) so it never touches any other audio-dock consumer. Injected
 *  AFTER the package's DOCK_CSS so these win specificity ties. */
const APP_CSS = `
/* Sits ABOVE the fixed bottom cluster (search bar + footer nav, ~5.5rem) so it never
   covers the footer's "Valid" / info-site links - overrides the package's 1rem. */
.audio-dock.neuro-managed { bottom: calc(6rem + var(--safe-bottom)); z-index: 9002; }
.audio-dock.neuro-managed.is-hidden { display: none; }
@keyframes neuro-dock-in { from { transform: translateY(28px) scale(.9); opacity: 0; } to { transform: none; opacity: 1; } }
.audio-dock.neuro-managed.is-entering { animation: neuro-dock-in .36s cubic-bezier(.6,.2,.1,1.2); transform-origin: bottom right; }
@media (prefers-reduced-motion: reduce) { .audio-dock.neuro-managed.is-entering { animation: none; } }
html[data-a11y-motion="reduce"] .audio-dock.neuro-managed.is-entering { animation: none; }
@media (max-width: 520px) {
  /* !important: the dock's drag/resize writes INLINE left/width (a remembered
     desktop placement), which lands controls off a phone's viewport. The phone
     placement is full-width by policy, so it must beat the inline geometry. */
  .audio-dock.neuro-managed { right: 8px !important; left: 8px !important; width: auto !important; max-width: none; }
  .audio-dock.neuro-managed[data-collapse="mini"] { display: none; }
}`;

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = APP_CSS;
  document.head.appendChild(style);
}

/** Where the user dragged the player + how big they made each window state. Device-local;
 *  never written under the ?neuro demo (a shared capture link persists nothing). */
const placement = {
  get(): DockPlacement | null {
    try { const raw = localStorage.getItem(PLACEMENT_KEY); return raw ? (JSON.parse(raw) as DockPlacement) : null; }
    catch { return null; }
  },
  set(p: DockPlacement): void {
    if (neuroDemoActive()) return;
    try { localStorage.setItem(PLACEMENT_KEY, JSON.stringify(p)); } catch { /* best-effort */ }
  },
};

/**
 * The stable DockHost the dock is built over. Its flat transport + music adapters delegate
 * to the registered MUSIC source (or no-op when none); `narrationBlock` surfaces the
 * registered NARRATION source. Registering/unregistering just swaps a field + emits.
 */
class ComposedHost implements DockHost {
  private musicSrc: DockHost | null = null;
  private narrSrc: DockNarrationPlayer | null = null;
  private readonly listeners = new Set<() => void>();
  private musicUnsub: (() => void) | null = null;

  setMusic(m: DockHost | null): void {
    if (this.musicSrc === m) return;
    this.musicUnsub?.();
    this.musicUnsub = null;
    this.musicSrc = m;
    if (m) this.musicUnsub = m.onChange(() => this.emit());
    this.emit();
  }
  setNarration(n: DockNarrationPlayer | null): void { this.narrSrc = n; this.emit(); }
  hasMusic(): boolean { return !!this.musicSrc; }
  hasNarration(): boolean { return !!this.narrSrc; }
  hasAny(): boolean { return !!this.musicSrc || !!this.narrSrc; }

  // ── flat transport (the MUSIC block; no-ops when no music registered) ──
  isPlaying(): boolean { return this.musicSrc?.isPlaying() ?? false; }
  togglePlay(): void | Promise<void> { return this.musicSrc?.togglePlay(); }
  next(): void | Promise<void> { return this.musicSrc?.next?.(); }
  prev(): void | Promise<void> { return this.musicSrc?.prev?.(); }
  currentTime(): number { return this.musicSrc?.currentTime?.() ?? 0; }
  duration(): number { return this.musicSrc?.duration?.() ?? 0; }
  seekable(): boolean { return this.musicSrc?.seekable?.() ?? false; }
  seek(seconds: number): void { this.musicSrc?.seek?.(seconds); }
  nowPlaying(): DockNowPlaying { return this.musicSrc?.nowPlaying() ?? { title: '' }; }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── capability adapters (delegate to the current music source) ──
  get sources(): DockSources | undefined { return this.musicSrc?.sources; }
  get atmosphere(): DockAtmosphere | undefined { return this.musicSrc?.atmosphere; }
  get viz(): DockViz | undefined { return this.musicSrc?.viz; }
  get repeat(): DockRepeat | undefined { return this.musicSrc?.repeat; }
  get volume(): DockVolume | undefined { return this.musicSrc?.volume; }
  get volumes(): DockVolume[] | undefined { return this.musicSrc?.volumes; }
  get narrationBlock(): DockNarrationPlayer | undefined { return this.narrSrc ?? undefined; }

  private emit(): void {
    for (const l of this.listeners) { try { l(); } catch { /* one bad listener never blocks the rest */ } }
  }
}

let composed: ComposedHost | null = null;
let controller: DockController | null = null;
let el: HTMLElement | null = null;
let musicOnClose: (() => void) | null = null;

function musicCaps(): DockCapabilities {
  return composed?.hasMusic() ? { music: true, radio: true, atmosphere: true, viz: true } : {};
}

/** Build the ONE dock over the composed host (once), mounted on document.body, hidden. */
function ensureDock(): { composed: ComposedHost; controller: DockController; el: HTMLElement } {
  if (composed && controller && el) return { composed, controller, el };
  composed = new ComposedHost();
  const initialCollapsed = neuroDemoActive() ? false : isNeuroDockCollapsed();
  controller = createAudioDock({
    host: composed,
    capabilities: musicCaps(),
    // Music has no meaningful compact state (compact == full), so the step-down is binary
    // full ⇄ mini. The header ↗ escalates to fullscreen; leaving fullscreen → expanded.
    collapse: initialCollapsed ? 'mini' : 'full',
    collapseSizes: ['full', 'mini'],
    openSections: { music: false, atmosphere: false },
    placement,
    onClose: () => onCloseDock(),
    onCollapse: (size) => {
      if (!neuroDemoActive() && !suppressCollapsePersist) setNeuroDockCollapsed(size === 'mini');
    },
  });
  ensureStyles();
  el = controller.el;
  el.id = DOCK_ID;
  el.classList.add('neuro-managed', 'is-hidden');
  el.setAttribute('aria-label', 'Audio player');
  document.body.appendChild(el);
  return { composed, controller, el };
}

/** Close (×): leave neurospicy mode when music is present; otherwise dismiss the window. */
function onCloseDock(): void {
  if (musicOnClose) musicOnClose();
  else hideAudioDock();
}

// ── public API ────────────────────────────────────────────────────────────────

/** The dock controller (once built), for collapse/refresh from the registrants. */
export function audioDockController(): DockController | null { return controller; }
/** The dock element (once built), for the entrance confetti / measurement. */
export function audioDockElement(): HTMLElement | null { return el; }

export interface MusicRegistration {
  /** The music `DockHost` (transport + sources/atmosphere/viz/volumes/repeat). */
  host: DockHost;
  /** What the window's × does while music is present (leave neurospicy mode). */
  onClose(): void;
}

/** Register (or replace) the MUSIC source and show the window. */
export function registerMusicSource(reg: MusicRegistration): DockController {
  const d = ensureDock();
  musicOnClose = reg.onClose;
  d.composed.setMusic(reg.host);
  d.controller.setCapabilities(musicCaps());
  showAudioDock();
  return d.controller;
}

/** Remove the MUSIC source (mode off). Hides the window unless narration remains. */
export function unregisterMusicSource(): void {
  if (!composed || !controller) return;
  musicOnClose = null;
  composed.setMusic(null);
  controller.setCapabilities(musicCaps());
  if (!composed.hasNarration()) hideAudioDock();
  else controller.refresh();
}

/** Guards the neuro collapse pref against PROGRAMMATIC collapse writes: narration's
 *  arrive-collapsed default below must never rewrite the music dock's remembered size. */
let suppressCollapsePersist = false;

/** Register (or replace) the NARRATION source and show the window. */
export function registerNarrationSource(block: DockNarrationPlayer): void {
  const d = ensureDock();
  const appearing = !isAudioDockVisible();
  d.composed.setNarration(block);
  d.controller.refresh();
  // Narration arrives COLLAPSED (Andy, 2026-08-17): a docs page's player must not
  // distract from the content, so a dock appearing FOR narration starts as the mini
  // pill - expanding is one tap. A dock already on screen (music playing) keeps
  // whatever state the user gave it. Not on phones: under 520px the app CSS hides
  // the mini dock entirely (the neuro flow has its own chip there), which for
  // narration-only would leave no way to reach the player.
  if (appearing && !d.composed.hasMusic() && !window.matchMedia('(max-width: 520px)').matches) {
    suppressCollapsePersist = true;
    try { d.controller.setCollapse('mini'); } finally { suppressCollapsePersist = false; }
  }
  showAudioDock();
}

/** Remove the NARRATION source (left the reader). Hides the window unless music remains. */
export function unregisterNarrationSource(): void {
  if (!composed || !controller) return;
  composed.setNarration(null);
  if (!composed.hasMusic()) hideAudioDock();
  else controller.refresh();
}

/** Show the shared window (registering already calls this). */
export function showAudioDock(): void {
  const d = ensureDock();
  d.el.classList.remove('is-hidden');
  d.controller.refresh();
}

/** Hide the shared window without destroying it (audio + state survive). */
export function hideAudioDock(): void {
  el?.classList.add('is-hidden');
}

/** Is the shared window built and visible? */
export function isAudioDockVisible(): boolean {
  return !!el && !el.classList.contains('is-hidden');
}
