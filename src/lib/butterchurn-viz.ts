// SPDX-License-Identifier: MPL-2.0
/**
 * The MilkDrop visualizer's engine wrapper — everything WebGL and audio, nothing UI.
 * components/viz-overlay.ts owns the surface it draws into; this module owns the
 * butterchurn instance, the render loop, and the audio tap.
 *
 * Deliberately kept out of the initial bundle: `butterchurn` is ~40 KB gzipped and
 * only ever needed when someone actually opens the visualizer, so it arrives via a
 * dynamic import on first `mountViz()` and is cached by the module system after.
 *
 * AUDIO. It taps the EXISTING focus-loop graph rather than building its own:
 * `getNeurospicyAnalyser()` hands back the pass-through analyser that already sits
 * between the player's gain and the speakers (lib/neurospicy.ts), and its
 * `.context` is the AudioContext butterchurn needs. `connectAudio` adds a parallel
 * branch into butterchurn's internal delay tap — it never reaches the destination,
 * so nothing is heard twice — and `disconnectAudio` unhooks only that branch,
 * leaving analyser→destination intact. That means:
 *   - no second AudioContext, no autoplay-gesture juggling of our own;
 *   - the visualizer is dead until audio has actually started once (the analyser
 *     doesn't exist before then), hence `vizAudioReady()` and the retry the overlay
 *     does on 'lolly:neuro-playing';
 *   - internet radio DOES drive it: the stream's <audio> element is tapped into the
 *     same graph via createMediaElementSource (SomaFM sends the CORS header that
 *     needs), so a station looks exactly like a local track here. A station whose
 *     server refuses the tap falls back to untapped playback and reports
 *     'unanalysable' — `vizHasSignal()` is false then, and the overlay says why
 *     instead of looking broken.
 *
 * WebGL2 is a hard requirement of butterchurn 2.x, so every entry point here is
 * gated on `vizSupported()` from the dependency-free lib/viz-support.ts (which the
 * dock also reads, synchronously, to decide whether to show its button at all).
 */
import { getNeurospicyAnalyser, neurospicySignalState } from './neurospicy.ts';
import { vizSupported } from './viz-support.ts';
import { vizPalette, vizPaletteDiagnostics, type VizPalette, type VizPaletteHost } from './viz-palette.ts';
import { vizPresetById, type VizPreset } from './viz-presets.ts';

/** Cap the backing store so a 4K display doesn't ask for a 4× mesh render. The
 *  visualizer is a soft, blurred image — the extra pixels buy nothing and cost fps. */
const MAX_PIXEL_RATIO = 1.5;
/** Mesh resolution. butterchurn defaults to 48×36; 40×30 is visually equivalent for
 *  our presets and noticeably cheaper on integrated GPUs. */
const MESH = { width: 40, height: 30 };
/** Seconds to cross-fade when switching presets. */
const BLEND_SECONDS = 2.2;
/** The shortest blend we ever ask for. Must be > 0 — see the `load()` call site: a
 *  zero blend duration divides by zero and wedges the renderer on NaN. */
const MIN_BLEND_SECONDS = 0.05;

type Butterchurn = { createVisualizer: typeof import('butterchurn').createVisualizer };

/**
 * Dig `createVisualizer` out of however the bundler chose to present the package.
 *
 * butterchurn ships a webpack UMD bundle whose `module.exports` is itself
 * `{ default: { createVisualizer } }` — webpack's own harmony-export wrapper. Layer
 * an ES-module interop on top of that and the nesting depends on the toolchain:
 * Node's `require` gives one `default` to unwrap, while Vite's esbuild pre-bundle
 * adds its own, so `m.default.default` is where the real object lives. Getting it
 * wrong throws `mod.createVisualizer is not a function` in one environment and
 * works fine in the other — dev vs. build, which is the worst way to find out.
 *
 * So don't guess a depth: walk `default` until something has `createVisualizer`.
 */
export function resolveButterchurn(mod: unknown): Butterchurn {
  let cur = mod;
  for (let depth = 0; depth < 4; depth++) {
    if (cur && typeof (cur as Butterchurn).createVisualizer === 'function') return cur as Butterchurn;
    const next = (cur as { default?: unknown } | null)?.default;
    if (!next || next === cur) break;
    cur = next;
  }
  throw new Error('butterchurn loaded but exposes no createVisualizer — unexpected module shape');
}

let loggedPalette = false;
let modPromise: Promise<Butterchurn> | null = null;
function loadButterchurn(): Promise<Butterchurn> {
  modPromise ??= import('butterchurn').then(resolveButterchurn);
  return modPromise;
}

/** Has the focus-loop audio graph been built yet? Until it has, there's nothing to
 *  create a visualizer against (butterchurn needs the AudioContext). */
export function vizAudioReady(): boolean {
  return getNeurospicyAnalyser() !== null;
}

/**
 * Will the visualizer actually see samples right now? False while paused/idle, while a
 * stream is still connecting, and for a station whose server wouldn't allow the analyser
 * tap. `neurospicySignalState()` is the single source of truth the level meter shares, so
 * the two views never disagree about whether there's a signal.
 */
export function vizHasSignal(): boolean {
  return neurospicySignalState() === 'live';
}

export interface VizHandle {
  /** Switch preset, cross-fading. Unknown ids fall back to the default. */
  setPreset(id: string): void;
  /** Re-colour: rebuild the CURRENT preset against a new palette and cross-fade to it.
   *  A scheme change is a palette change — the presets themselves are unaffected. */
  setPalette(palette: VizPalette): void;
  /** Load a preset object built elsewhere — the brand-wrapped artist presets, which are
   *  fetched and assembled by lib/viz-stock.ts rather than coming from our registry. */
  setRawPreset(id: string, preset: VizPreset): void;
  /** The palette currently in force, so a caller rebuilding a preset can match it. */
  palette(): VizPalette;
  /** Is the render loop still going? False once the canvas was hidden or detached
   *  (the loop stands itself down) or after a frame threw — an INLINE surface that
   *  gets collapsed and reopened needs to know it must re-mount. */
  running(): boolean;
  /** The preset currently loaded. */
  presetId(): string;
  /** Re-read the canvas's box and resize the renderer to match. */
  resize(): void;
  /** Stop rendering, unhook the audio branch, and drop the GL context's canvas use. */
  destroy(): void;
}

/**
 * Attach a visualizer to `canvas` and start rendering. Resolves null when the
 * browser can't do WebGL2 or the audio graph doesn't exist yet — callers should
 * check `vizSupported()`/`vizAudioReady()` first and retry the latter on
 * 'lolly:neuro-playing'.
 *
 * `host` supplies the brand tokens the palette is seeded from; a host without
 * tokens gets the fallback palette rather than no colour.
 *
 * `onError` is called if a frame throws after a successful mount — butterchurn
 * failures are otherwise completely silent (a dead rAF chain over a black canvas),
 * which is exactly the failure mode that makes this thing hard to debug.
 */
export async function mountViz(
  canvas: HTMLCanvasElement,
  host: VizPaletteHost | undefined,
  presetId: string,
  onError?: (err: unknown) => void,
  initialPalette?: VizPalette | null,
): Promise<VizHandle | null> {
  const analyser = getNeurospicyAnalyser();
  if (!analyser || !vizSupported()) return null;

  const [mod, derived] = await Promise.all([loadButterchurn(), vizPalette(host)]);
  // A caller that has already chosen a SCHEME passes its palette; otherwise fall back
  // to the brand's default derivation.
  let palette = initialPalette ?? derived;
  // One line per mount saying where the brand colour came from. A mis-resolved accent
  // shows up as "the whole visualizer is the wrong colour" with nothing to explain it,
  // which is exactly the kind of bug that costs a round trip to diagnose.
  if (!loggedPalette) {
    loggedPalette = true;
    console.info('[lolly:viz]', vizPaletteDiagnostics(derived));
  }

  /**
   * DPR handling, and the trap in it.
   *
   * butterchurn never touches `canvas.width`/`canvas.height`. `renderToScreen` does
   * `bindFrambufferAndSetViewport(null, this.width, this.height)` — so the SCREEN
   * viewport is exactly the width/height we hand it, and the canvas's drawing buffer
   * must match those numbers or the frame lands in the wrong part of the buffer:
   *   - buffer left at its 300×150 default → the viewport overshoots it entirely;
   *   - buffer set to `size × pixelRatio` while width/height stay CSS px → the frame
   *     renders into the lower-left corner and CSS scales that corner up.
   * Both look like a broken visualizer and neither warns.
   *
   * So we work in DEVICE pixels throughout: width/height AND the drawing buffer are
   * the device-pixel size, with `pixelRatio: 1` (its only job is scaling texsize off
   * width/height, which we've already done). CSS keeps the element at its box size,
   * so the extra pixels become sharpness.
   */
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const box = (): { w: number; h: number } => {
    const r = canvas.getBoundingClientRect();
    // A detached or zero-size canvas would make butterchurn allocate a 0×0 texture
    // and throw; floor at 1 and let the next resize() correct it.
    return {
      w: Math.max(1, Math.round(r.width * dpr)),
      h: Math.max(1, Math.round(r.height * dpr)),
    };
  };
  const first = box();

  const applySize = (w: number, h: number): void => {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  };
  applySize(first.w, first.h);

  const viz = mod.createVisualizer(analyser.context, canvas, {
    width: first.w,
    height: first.h,
    pixelRatio: 1,
    meshWidth: MESH.width,
    meshHeight: MESH.height,
  });
  viz.connectAudio(analyser);

  let currentId = presetId;
  const load = (id: string, blend: number): void => {
    const def = vizPresetById(id);
    viz.loadPreset(def.build(palette), blend);
    currentId = def.id;
  };
  // NEVER pass 0 as the blend time. `loadPreset` unconditionally sets `blending = true`,
  // and the next frame computes `blendProgress = (time - blendStartTime) / blendDuration`.
  // With a 0 duration that's 0/0 = NaN on any frame where the clock hasn't advanced —
  // and `NaN > 1.0` is false, so `blending` never clears. Every value then goes through
  // `mixFrameEquations(NaN, …)` and comes out NaN, so the renderer draws nothing at
  // all: a black canvas, for the whole session, with no error anywhere.
  load(presetId, MIN_BLEND_SECONDS);

  // Render loop. Driven by the rAF clock of the window the CANVAS lives in, not
  // ours — for a popped-out visualizer those differ, and an opener that's minimized
  // or in a background tab throttles its rAF to a standstill, which would freeze a
  // popout that is itself perfectly visible.
  const clock: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'> =
    canvas.ownerDocument.defaultView ?? window;
  // Bails when the canvas leaves the DOM or is hidden, so a closed overlay can't
  // keep a GL context spinning; the overlay restarts it on open by mounting afresh.
  // Sized lazily: the loop notices box changes instead of needing a ResizeObserver.
  let raf = 0;
  let alive = true;
  let lastW = first.w;
  let lastH = first.h;
  const frame = (): void => {
    if (!alive) return;
    if (!canvas.isConnected || canvas.offsetParent === null) { raf = 0; alive = false; return; }
    const { w, h } = box();
    if (w !== lastW || h !== lastH) {
      lastW = w; lastH = h;
      applySize(w, h);
      viz.setRendererSize(w, h, { pixelRatio: 1 });
    }
    // A throw anywhere inside butterchurn's frame — a preset shape the renderer
    // doesn't accept, a lost GL context — otherwise just stops the rAF chain and
    // leaves a black canvas with nothing logged near the cause. Report it once and
    // stand down, so the surface can say what happened instead of looking dead.
    try {
      viz.render();
    } catch (err) {
      alive = false;
      raf = 0;
      onError?.(err);
      return;
    }
    raf = clock.requestAnimationFrame(frame);
  };
  raf = clock.requestAnimationFrame(frame);

  return {
    setPreset(id: string): void {
      // Keep a bad preset from taking the whole visualizer down with it: report and
      // stay on the one that's already rendering.
      try {
        load(id, BLEND_SECONDS);
      } catch (err) {
        onError?.(err);
      }
    },
    setRawPreset(id: string, preset: VizPreset): void {
      try {
        viz.loadPreset(preset, BLEND_SECONDS);
        currentId = id;
      } catch (err) {
        onError?.(err);
      }
    },
    palette: () => palette,
    setPalette(next: VizPalette): void {
      // The shaders bake the palette in as GLSL constants, so a colour change means
      // rebuilding and reloading the preset — butterchurn cross-fades it like any other
      // preset change, which is exactly the transition a scheme change wants.
      try {
        palette = next;
        load(currentId, BLEND_SECONDS);
      } catch (err) {
        onError?.(err);
      }
    },
    presetId: () => currentId,
    running: () => alive,
    resize(): void {
      const { w, h } = box();
      lastW = w; lastH = h;
      applySize(w, h);
      viz.setRendererSize(w, h, { pixelRatio: 1 });
    },
    destroy(): void {
      alive = false;
      if (raf) clock.cancelAnimationFrame(raf);
      raf = 0;
      // Selective disconnect: drops only analyser→butterchurn, never the
      // analyser→destination edge the player's audio actually flows through.
      try { viz.disconnectAudio(analyser); } catch { /* already gone */ }
    },
  };
}
