// SPDX-License-Identifier: MPL-2.0
/**
 * Live frame-source controls - the "Go live" (camera) and "Play" (animated asset)
 * affordances for tools with an `onFrame` hook, e.g. the filter effects.
 *
 * ONE controller per mounted tool owns the whole live state machine, and every
 * button - the sidebar pair riding the asset picker's slot-actions row AND the
 * canvas-stage fallback pair - is just a view of it, so the two placements can
 * never disagree. Placement rule (Andy, 2026-08-10): when the tool has a sidebar
 * with an asset slot, Play + Go live belong THERE, with the picker button that
 * chooses what they act on; the floating canvas toggles remain only for tools
 * with no sidebar to ride (canvas layout, or no asset input at all).
 *
 * The frame path is the camera's, exactly: the media bridge's anim source
 * (bridge/media.ts AnimSourceSpec) replays the asset - a CSS/SMIL-animated SVG,
 * a GIF/APNG/animated-WebP (via ImageDecoder), or a video - as plain RGBA frames,
 * and `runtime.startLive({ source: 'asset' })` drives the tool's onFrame from
 * them with the same drop-overlap throttle. `source: 'asset'` is the provenance
 * guard: replayed file content must never claim a live camera capture (engine
 * 1.113). Camera permission gating is untouched - getUserMedia only ever runs on
 * the Go live path.
 *
 * What plays:
 *   - the PICKED asset, when the tool's source asset input holds something
 *     animated (lib/anim-detect.ts decides; SVG markup is fetched + sniffed).
 *     Picking an animated asset in-session AUTO-plays it - that pick is the
 *     user asking to see it move ("come alive"), and pause freezes the current
 *     frame so the still export path keeps working.
 *   - else the tool's sample animation (`render.liveDefault`), exactly the old
 *     Play behaviour - still manual-start only (the auto-play-on-open decision
 *     stays gated, see the TODO that used to live in tool.ts).
 *
 * Lottie catalog assets are deliberately not playable here yet (no lottie lane
 * in the anim source); they keep their static path.
 */

import { svgMarkupAnimated, precheckAnimatedRef, type AnimRefLike } from '../lib/anim-detect.ts';
import type { AnimSourceSpec } from '../bridge/media.ts';

/** Structural view of the runtime this module needs (tests stub it). */
export interface LiveRuntimeLike {
  hasFrameHook: boolean;
  isLive(): boolean;
  startLive(opts?: { source?: 'camera' | 'asset' }): Promise<boolean>;
  stopLive(): void;
  getModel(): Array<{ id: string; type?: string; value: unknown }>;
  manifest: { id: string; render?: unknown };
}

/** Structural view of the host this module needs (tests stub it). */
export interface LiveHostLike {
  media?: {
    isAvailable?(): boolean;
    armAnimSource?(src: AnimSourceSpec | string | null): void;
  };
  assets: { get(id: string): Promise<unknown> };
  log?(level: string, msg: string, data?: Record<string, unknown>): void;
}

export interface LiveControlsOpts {
  runtime: LiveRuntimeLike;
  host: LiveHostLike;
  t: (s: string) => string;
  announce: (msg: string, opts?: { assertive?: boolean }) => void;
  /** Dev fps meter hooks (frame-fps.ts) - no-ops by default. */
  onStart?: () => void;
  onStop?: () => void;
  /** Fetch + sanitise SVG markup for a URL. Defaults to anim-svg-mount's cached
   *  fetchAnimSvg (lazy import so importing this module stays light). Injectable
   *  for tests. */
  fetchSvgMarkup?: (url: string) => Promise<string>;
  /** Whether animated rasters can be decoded (defaults to an ImageDecoder probe). */
  canDecodeRaster?: boolean;
}

export interface LiveControls {
  /** False when the tool has no onFrame hook or the shell has no media source. */
  readonly enabled: boolean;
  /** The asset input whose sidebar row hosts the buttons; null = no asset input. */
  readonly sourceInputId: string | null;
  /** Append the floating canvas-stage toggles (fallback placement). */
  mountStage(stageEl: HTMLElement): void;
  /** True once mountStage placed the toggles - the sidebar then never doubles them. */
  stageHosted(): boolean;
  /** Populate a sidebar slot-actions cluster (mountSidebarLiveControls calls this). */
  mountSidebarCluster(cluster: HTMLElement): void;
  /** Reflect a model change: reclassify the picked source, auto-play a fresh
   *  animated pick, stop playback when the source it fed from is swapped away. */
  syncFromModel(model: ReadonlyArray<{ id: string; value: unknown }>): void;
  playing(): boolean;
  cameraLive(): boolean;
  dispose(): void;
}

type Mode = 'camera' | 'asset' | null;
type Role = 'play' | 'camera';

export function createLiveControls(opts: LiveControlsOpts): LiveControls {
  const { runtime, host, t, announce } = opts;
  const onStart = opts.onStart ?? (() => {});
  const onStop = opts.onStop ?? (() => {});
  const log = (msg: string, data?: Record<string, unknown>): void => host.log?.('warn', msg, data);
  const canDecodeRaster = opts.canDecodeRaster
    ?? typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder !== 'undefined';
  const fetchSvg = opts.fetchSvgMarkup
    ?? (async (url: string) => (await import('./anim-svg-mount.ts')).fetchAnimSvg(url));

  const enabled = Boolean(runtime.hasFrameHook && host.media);
  const cameraAvailable = (): boolean => Boolean(host.media?.isAvailable?.());
  const arm = (src: AnimSourceSpec | null): void => host.media?.armAnimSource?.(src);
  const liveDefault = (runtime.manifest.render as { liveDefault?: string } | undefined)?.liveDefault ?? null;

  // The tool's image SOURCE input: the first declared asset input - the same slot
  // whose swap retires the runtime's live-capture flag, and the row the sidebar
  // buttons ride. Null when the tool has no asset input (stage fallback only).
  const sourceInputId = enabled
    ? (runtime.getModel().find(i => i.type === 'asset')?.id ?? null)
    : null;

  let mode: Mode = null;
  let disposed = false;

  // ── Source classification ──────────────────────────────────────────────────
  // `playSource` is the resolved thing Play would start right now: the picked
  // asset when it's animated, else the sample (liveDefault). `fromPick` gates
  // auto-play - only an explicit user pick auto-starts.
  let playSource: { spec: AnimSourceSpec; fromPick: boolean } | null = null;
  let classifyToken = 0;
  let lastKey: string | null | undefined; // undefined = never synced

  // Fetch + brand-bake SVG markup (cached per URL): the sampler renders it in an
  // isolated <img>, which can't inherit :root's --brand-primary, so the var is
  // resolved to the live brand value here - same trick the old sample path used.
  const svgCache = new Map<string, Promise<string | null>>();
  const svgSourceFor = (url: string): Promise<string | null> => {
    let p = svgCache.get(url);
    if (!p) {
      p = (async () => {
        try {
          const clean = await fetchSvg(url);
          if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return clean;
          const bp = getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim();
          return bp ? clean.replace(/var\(--brand-primary\s*,\s*[^)]*\)/g, bp) : clean;
        } catch (e) {
          log('live anim source prepare failed', { error: String(e), toolId: runtime.manifest.id });
          return null;
        }
      })();
      svgCache.set(url, p);
    }
    return p;
  };

  const sourceValue = (model: ReadonlyArray<{ id: string; value: unknown }>): AnimRefLike | null => {
    if (!sourceInputId) return null;
    const v = model.find(i => i.id === sourceInputId)?.value;
    return v && typeof v === 'object' ? (v as AnimRefLike) : null;
  };

  /** Re-derive playSource for the current pick (or the sample). Resolves to true
   *  when the PICKED asset is playable (drives auto-play). Token-guarded so a
   *  stale classification can never clobber a newer pick's verdict. */
  async function classify(): Promise<boolean> {
    const token = ++classifyToken;
    const ref = sourceValue(runtime.getModel());
    let next: { spec: AnimSourceSpec; fromPick: boolean } | null = null;
    if (ref?.url) {
      const hint = precheckAnimatedRef(ref, { canDecodeRaster });
      if (hint === 'svg-check') {
        const markup = await svgSourceFor(ref.url);
        if (markup && svgMarkupAnimated(markup)) next = { spec: { kind: 'svg', markup }, fromPick: true };
      } else if (hint && hint.kind !== 'svg') {
        next = { spec: { kind: hint.kind, url: hint.url }, fromPick: true };
      }
    } else if (liveDefault) {
      // No pick → the tool's sample animation (an SVG catalog asset).
      try {
        const def = await host.assets.get(liveDefault) as { url?: string } | null;
        if (def?.url) {
          const markup = await svgSourceFor(def.url);
          if (markup) next = { spec: { kind: 'svg', markup }, fromPick: false };
        }
      } catch (e) {
        log('live sample resolve failed', { error: String(e), toolId: runtime.manifest.id });
      }
    }
    if (token !== classifyToken || disposed) return false;
    playSource = next;
    updateUi();
    return Boolean(next?.fromPick);
  }

  // ── State machine ──────────────────────────────────────────────────────────
  async function startPlayback(): Promise<boolean> {
    if (disposed || mode !== null || runtime.isLive() || !playSource) return false;
    arm(playSource.spec);
    try {
      const ok = await runtime.startLive({ source: 'asset' });
      if (!ok) { arm(null); return false; }
    } catch (e) {
      log('startLive (anim) failed', { error: String(e), toolId: runtime.manifest.id });
      arm(null);
      return false;
    }
    mode = 'asset';
    onStart();
    updateUi();
    return true;
  }

  function stopPlayback(o: { silent?: boolean } = {}): void {
    if (mode !== 'asset') return;
    runtime.stopLive();
    onStop();
    arm(null); // freeze on the current frame; the still/export path takes over
    mode = null;
    updateUi();
    if (!o.silent) announce(t('Animation paused'));
  }

  async function startCamera(): Promise<boolean> {
    if (disposed || mode !== null || runtime.isLive()) return false;
    // Camera and the animated source share the media singleton; disarm the anim
    // source so start() opens the camera rather than replaying the animation.
    arm(null);
    try {
      const ok = await runtime.startLive();
      if (!ok) return false;
    } catch (e) {
      announce((e as { name?: string })?.name === 'NotAllowedError'
        ? t('Camera permission was declined.')
        : t('Couldn’t start the camera.'), { assertive: true });
      log('startLive failed', { error: String(e), toolId: runtime.manifest.id });
      return false;
    }
    mode = 'camera';
    onStart();
    updateUi();
    announce(t('Live camera started — the canvas now reacts to your camera'));
    return true;
  }

  function stopCamera(): void {
    if (mode !== 'camera') return;
    runtime.stopLive();
    onStop();
    mode = null;
    updateUi();
    announce(t('Live camera stopped'));
  }

  async function togglePlay(): Promise<void> {
    if (mode === 'asset') { stopPlayback(); return; }
    if (mode === 'camera') stopCamera();
    if (await startPlayback()) {
      announce(playSource?.fromPick
        ? t('Playing the animation through the effect')
        : t('Playing the sample animation through the effect'));
    }
  }

  async function toggleCamera(): Promise<void> {
    if (mode === 'camera') { stopCamera(); return; }
    if (mode === 'asset') stopPlayback({ silent: true });
    await startCamera();
  }

  // ── Buttons (both placements are views of the same state) ──────────────────
  const buttons = new Set<{ el: HTMLButtonElement; role: Role; labelEl: HTMLElement }>();

  function makeButton(role: Role, variant: 'stage' | 'sidebar'): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (variant === 'stage') {
      btn.className = role === 'camera' ? 'canvas-live-toggle' : 'canvas-live-toggle canvas-anim-toggle';
    } else {
      btn.className = role === 'camera' ? 'slot-act slot-live slot-live-camera' : 'slot-act slot-live slot-live-play';
      btn.setAttribute(role === 'camera' ? 'data-live-camera' : 'data-live-play', sourceInputId ?? '');
    }
    btn.setAttribute('aria-pressed', 'false');
    btn.title = role === 'camera'
      ? t('React to your camera in real time')
      : t('Play the animation through this effect');
    const label = document.createElement('span');
    label.className = 'canvas-live-label';
    const dot = document.createElement('span');
    dot.className = 'canvas-live-dot';
    dot.setAttribute('aria-hidden', 'true');
    btn.append(dot, label);
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      btn.disabled = true;
      void (role === 'camera' ? toggleCamera() : togglePlay()).finally(() => { btn.disabled = false; });
    });
    buttons.add({ el: btn, role, labelEl: label });
    return btn;
  }

  function updateUi(): void {
    for (const b of [...buttons]) {
      if (!b.el.isConnected) { buttons.delete(b); continue; }
      const live = runtime.isLive();
      if (b.role === 'camera') {
        const on = live && mode === 'camera';
        b.el.hidden = !cameraAvailable();
        b.el.classList.toggle('is-live', on);
        b.el.setAttribute('aria-pressed', String(on));
        b.labelEl.textContent = on ? t('Live') : t('Go live');
      } else {
        const on = live && mode === 'asset';
        b.el.hidden = !playSource && !on;
        b.el.classList.toggle('is-live', on);
        b.el.setAttribute('aria-pressed', String(on));
        b.labelEl.textContent = on ? t('Playing') : t('Play');
      }
    }
  }

  let stagePlaced = false;

  const lc: LiveControls = {
    enabled,
    sourceInputId,
    mountStage(stageEl: HTMLElement): void {
      if (!enabled) return;
      stagePlaced = true;
      if (cameraAvailable()) stageEl.appendChild(makeButton('camera', 'stage'));
      stageEl.appendChild(makeButton('play', 'stage'));
      updateUi();
    },
    stageHosted: () => stagePlaced,
    mountSidebarCluster(cluster: HTMLElement): void {
      if (!enabled) return;
      cluster.appendChild(makeButton('play', 'sidebar'));
      if (cameraAvailable()) cluster.appendChild(makeButton('camera', 'sidebar'));
      updateUi();
    },
    syncFromModel(model): void {
      if (!enabled || disposed) return;
      const key = sourceValue(model)?.url ?? null;
      const first = lastKey === undefined;
      if (!first && key === lastKey) return;
      lastKey = key;
      // The frames the canvas is showing came from the OLD source - stop cleanly.
      const wasPlaying = mode === 'asset';
      if (wasPlaying) stopPlayback({ silent: true });
      void classify().then((pickedAnimated) => {
        // Auto-play an animated PICK (the user chose motion - let it move), but
        // never on the initial hydrate (URL/session restore keeps the deliberate
        // no-autoplay-on-open behaviour), and never over a running camera.
        if (!first && pickedAnimated && mode === null && !runtime.isLive() && !disposed) {
          void startPlayback().then((ok) => {
            if (ok) announce(t('Playing the animation through the effect'));
          });
        }
      });
    },
    playing: () => mode === 'asset' && runtime.isLive(),
    cameraLive: () => mode === 'camera' && runtime.isLive(),
    dispose(): void {
      disposed = true;
      classifyToken++;
      buttons.clear();
      registry.delete(runtime);
    },
  };
  return lc;
}

// ── Registry: lets the sidebar renderer find the mounted tool's controller ────
// Keyed by the runtime object (the one value tool.ts and tool-inputs.ts share).
// /multi's fanRuntime adapters are never registered, so renderInputs stays a
// no-op there exactly as before.
const registry = new WeakMap<object, LiveControls>();

export function registerLiveControls(runtime: object, lc: LiveControls): void {
  registry.set(runtime, lc);
}

/**
 * Sidebar placement (called by renderInputs after each panel rebuild): put the
 * Play + Go live buttons at the head of the source asset input's slot-actions
 * row - the established per-slot affordance cluster (Fit canvas / Match length /
 * Preview live there too) - creating the row when the slot has none yet.
 * No registered controller (or no asset input) → no-op.
 */
export function mountSidebarLiveControls(panel: HTMLElement, runtime: unknown): void {
  if (!runtime || typeof runtime !== 'object') return;
  const lc = registry.get(runtime);
  if (!lc?.enabled || !lc.sourceInputId || lc.stageHosted()) return;
  const trigger = panel.querySelector(`.asset-picker-trigger[data-input-id="${CSS.escape(lc.sourceInputId)}"]`);
  const row = trigger?.closest('.asset-picker-row');
  const parent = row?.parentElement;
  if (!row || !parent) return;
  if (parent.querySelector('[data-live-cluster]')) return; // already mounted this rebuild
  let actions = parent.querySelector(':scope > .slot-actions') as HTMLElement | null;
  if (!actions) {
    actions = panel.ownerDocument.createElement('div');
    actions.className = 'slot-actions';
    row.after(actions);
  }
  const cluster = panel.ownerDocument.createElement('span');
  cluster.className = 'slot-live-cluster';
  cluster.setAttribute('data-live-cluster', lc.sourceInputId);
  actions.prepend(cluster);
  lc.mountSidebarCluster(cluster);
}
