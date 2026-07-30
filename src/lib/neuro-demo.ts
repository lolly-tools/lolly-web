// SPDX-License-Identifier: MPL-2.0
/**
 * The `?neuro` demo deep-link — how the docs screenshot pipeline (url-shot recipes,
 * no clicking) captures the Neurospicy sound dock and the enlarged visualizer panel.
 *
 *   #/?neuro=player   dock open + expanded, Atmosphere section open with a demo mix
 *   #/?neuro=viz      the same, plus the enlarged viz panel (never fullscreen —
 *                     requestFullscreen needs a user gesture)
 *
 * `viz` implies `player`; values outside that closed vocabulary are ignored. The param
 * rides the hash query like `lang` does (see peekUrlLang in main.ts).
 *
 * NOTHING PERSISTS AND NOTHING SOUNDS. The demo lights the feature flag in memory only
 * (overrideFlagInMemory), assigns the player/atmosphere state in memory only
 * (demoNeurospicy / demoAtmosphere — no persistLocal, no persistProfile), and never
 * touches the audio graph: isNeurospicyPlaying() is state-only, so the transport
 * renders the "playing" look silently. A shared ?neuro link affects one page load.
 *
 * Kept import-free at module top level (types only): lib/viz-support.ts consults
 * neuroDemoActive() from its synchronous probe, and everything heavier is
 * dynamic-imported inside applyNeuroDemo.
 */
import type { NeurospicyHost } from './neurospicy.ts';

export type NeuroDemoMode = 'player' | 'viz';

/** How long to wait for the catalog sync before giving up on picking a demo track.
 *  Bounded so an empty catalog still yields a dock (with no selection) rather than
 *  a promise that never settles. */
const TRACKS_WAIT_MS = 20_000;

// Read once per page load: the demo is a property of how the page was opened, so a
// later in-app hash navigation neither activates nor deactivates it.
let peeked: NeuroDemoMode | null | undefined;

/** The demo mode this page load was opened with, or null. Mirrors peekUrlLang in
 *  main.ts: the hash query first (#/?neuro=viz), then the search string. */
export function peekNeuroDemo(): NeuroDemoMode | null {
  if (peeked !== undefined) return peeked;
  if (typeof window === 'undefined') return (peeked = null);
  const hashQuery = window.location.hash.split('?')[1] ?? '';
  const v = new URLSearchParams(hashQuery).get('neuro')
    ?? new URLSearchParams(window.location.search).get('neuro');
  peeked = v === 'player' || v === 'viz' ? v : null;   // closed vocabulary — anything else is ignored
  return peeked;
}

/** Is this page load a ?neuro demo? The gate the dock/visualizer bypasses hang on. */
export function neuroDemoActive(): boolean { return peekNeuroDemo() !== null; }

type NeuroModule = typeof import('./neurospicy.ts');

/**
 * The demo track: the first 'neurospicy'-tagged, non-radio entry in the canonical
 * playlist order. NOT loops[0] — radio is online-gated, so [0] is nondeterministic.
 * On a cold context the catalog sync hasn't landed when boot runs this, so wait for
 * the track-list invalidation main.ts fires once it does ('lolly:neuro-tracks').
 */
async function demoLoopId(host: NeurospicyHost, neuro: NeuroModule): Promise<string> {
  const pick = async (): Promise<string> =>
    (await neuro.listLoops(host))
      .find((t) => t.tags?.includes('neurospicy') && neuro.trackCategory(t) !== 'radio')?.id ?? '';
  const now = await pick();
  if (now || typeof document === 'undefined') return now;
  return new Promise<string>((resolve) => {
    const done = (id: string): void => {
      clearTimeout(timer);
      document.removeEventListener('lolly:neuro-tracks', onTracks);
      resolve(id);
    };
    const onTracks = (): void => { void pick().then((id) => { if (id) done(id); }); };
    const timer = setTimeout(() => done(''), TRACKS_WAIT_MS);
    document.addEventListener('lolly:neuro-tracks', onTracks);
  });
}

/**
 * Stage the demo: flag lit in memory, silent "playing" player state, an Atmosphere
 * mix with its section open, the dock shown expanded with no entrance animation
 * (the spring-in + confetti burst are nondeterministic), and for `viz` the enlarged
 * panel on top. Fire-and-forget from main.ts's boot.
 */
export async function applyNeuroDemo(host: NeurospicyHost, mode: NeuroDemoMode): Promise<void> {
  const [{ overrideFlagInMemory }, neuro, atmo] = await Promise.all([
    import('../feature-flags.ts'),
    import('./neurospicy.ts'),
    import('./atmosphere.ts'),
  ]);
  // In memory only — outranks the mirror, so this works even under the docs
  // pipeline's capture-neutral pin (which forces the mirror copy off).
  overrideFlagInMemory('neurospicy', true);
  const loopId = await demoLoopId(host, neuro);
  neuro.demoNeurospicy({ enabled: true, loopId, volume: 0.5, paused: false });
  // Real layer ids from ATMOSPHERE_LAYERS: Wind / Birdsong / Crickets.
  atmo.demoAtmosphere({ wind: 0.55, birds: 0.32, night: 0.18 }, { open: true });
  const dock = await import('../components/neuro-dock.ts');
  dock.showNeuroDock(host, { animateIn: false, forceExpanded: true });
  if (mode === 'viz') {
    const viz = await import('../components/viz-overlay.ts');
    // No fullscreen: requestFullscreen needs a gesture, and a capture has none.
    await viz.openVizPanel(host as Parameters<typeof viz.openVizPanel>[0]);
  }
}
