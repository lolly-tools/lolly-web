// SPDX-License-Identifier: MPL-2.0
/**
 * Web implementation of the `media` capability — a live camera frame source
 * (engine bridge v1.4). The runtime drives a tool's `onFrame` hook from these
 * frames so a tool (e.g. a filter) can react to motion.
 *
 * The whole MediaStream / <video> / grab-loop lives HERE, in the shell — the engine
 * only ever sees plain RGBA pixel frames, so it stays DOM-free (mirrors how capture
 * keeps its browser engine in the shell). Pixels are read on the device and never
 * leave it; the only consumer is the in-page filter.
 *
 * Performance + privacy:
 *   - Frames are downscaled to a working size (a halftone/scanline trace doesn't
 *     need 720p) and throttled to ~MAX_FPS so the per-frame vector trace keeps up.
 *   - The grab loop pauses while the document is hidden (don't read the camera in a
 *     backgrounded tab), and the camera is fully released when the last start() is
 *     balanced by a stop().
 */

import type { MediaAPI, MediaFrame } from '@lolly-tools/core/host-v1';
import { cameraAvailable } from './capture-support.ts';

type FrameCallback = (frame: MediaFrame) => void;

/**
 * The web media source, with a shell-private extension: a NON-camera "animated
 * asset" source. Arm it with ready-to-render SVG markup (already sanitised +
 * brand-resolved by the caller) and the next start() plays that animation instead
 * of the camera — an off-screen <img> of the SVG animates on its own clock and
 * grab() samples it with the SAME drawImage→getImageData→MediaFrame path the
 * camera uses. So an onFrame tool (e.g. filter) can run "live" with no camera,
 * showing off effects on a moving subject. Camera and anim source are mutually
 * exclusive (one refcounted singleton); the arm methods are NOT on the portable
 * MediaAPI contract — only the web shell reaches for them.
 */
export interface WebMediaAPI extends MediaAPI {
  /** Arm the non-camera animated-SVG source for the next start(). `markup` must be
   *  self-contained, already-sanitised SVG (see svg-sanitize). Pass null to disarm. */
  armAnimSource(markup: string | null): void;
}

// Default cap for the working frame's longest edge — plenty for a dot/line vector
// trace, and keeps getImageData + the downstream trace cheap. A subscriber can ask
// for more (subscribe opts.maxEdge) when its output is a bitmap rather than a vector
// trace — e.g. filter-pixel-stretch — and the grab loop produces frames at the
// largest size any live subscriber requested (clamped to the native frame).
const DEFAULT_MAX_EDGE = 480;
const MAX_EDGE_CAP = 1920; // ceiling so a tool can't request an absurd working frame
const MAX_FPS = 30;
const MIN_INTERVAL = 1000 / MAX_FPS;

export function createMediaAPI(): WebMediaAPI {
  let stream: MediaStream | null = null;
  let videoEl: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let rafId = 0;
  let refcount = 0;
  let starting: Promise<void> | null = null; // in-flight start() promise (so concurrent starts share one stream)
  let lastGrab = 0;
  const subscribers = new Map<FrameCallback, number>(); // cb → requested maxEdge
  // Non-camera animated-SVG source (see WebMediaAPI). When `animMarkup` is armed,
  // start() inlines it live in an off-screen host; grabAnim seeks it to the wall-clock
  // time, BAKES that frame to a static SVG, and samples it via a lightweight <img> +
  // drawImage. Baking is the whole trick: an <img>-embedded SVG (or a dom-to-image
  // clone) restarts its @keyframes at t=0 on rasterise, so we commit the seeked
  // transforms as inline style and disable animation in the snapshot — the img then
  // renders exactly the frame we seeked. Far lighter than a per-frame dom-to-image.
  let animMarkup: string | null = null;
  let animHost: HTMLElement | null = null; // off-screen host holding the live inline <svg>
  let animImg: HTMLImageElement | null = null; // reused <img> that decodes each baked frame
  let animStart = 0;                       // wall-clock of the first anim frame (drives playback time)
  let animBusy = false;                    // a bake+decode is in flight (skip-if-busy → adaptive fps)

  // The same probe bridge/index.ts's lazy facade answers from (capture-support.ts),
  // called rather than re-typed so the two can never disagree.
  const isAvailable = cameraAvailable;

  function teardown(): void {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (videoEl) { try { videoEl.pause(); } catch { /* ignore */ } videoEl.srcObject = null; videoEl = null; }
    if (stream) { stream.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } }); stream = null; }
    if (animHost) { try { animHost.remove(); } catch { /* ignore */ } animHost = null; }
    if (animImg) { animImg.onload = null; animImg.onerror = null; animImg = null; }
    animBusy = false; animStart = 0;
    canvas = null; ctx = null;
    lastGrab = 0;
  }

  function workingSize(vw: number, vh: number): { cw: number; ch: number } {
    let want = DEFAULT_MAX_EDGE;
    for (const e of subscribers.values()) if (e > want) want = e;
    const scale = Math.min(1, want / Math.max(vw, vh));
    return { cw: Math.max(1, Math.round(vw * scale)), ch: Math.max(1, Math.round(vh * scale)) };
  }

  function emit(data: Uint8ClampedArray, width: number, height: number, now: number): void {
    const frame: MediaFrame = { width, height, data, t: now };
    // Snapshot the keys so a subscriber that unsubscribes mid-iteration is safe.
    for (const cb of [...subscribers.keys()]) {
      try { cb(frame); } catch { /* one bad subscriber must not kill the loop */ }
    }
  }

  function grab(now: number): void {
    if (!videoEl || !stream || subscribers.size === 0) return;
    // Don't read the camera while backgrounded (privacy + perf).
    if (typeof document !== 'undefined' && document.hidden) return;
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) return; // stream not yet producing frames
    // Working size = the largest edge any live subscriber asked for, clamped to native.
    const { cw, ch } = workingSize(vw, vh);
    if (canvas!.width !== cw) canvas!.width = cw;
    if (canvas!.height !== ch) canvas!.height = ch;
    try {
      ctx!.drawImage(videoEl, 0, 0, cw, ch);
      emit(ctx!.getImageData(0, 0, cw, ch).data, cw, ch, now);
    } catch { /* tainted canvas etc. — skip this frame */ }
  }

  // Seek the live inline SVG to `elapsedMs`, then produce a STATIC snapshot of that exact
  // frame: commitStyles writes each animation's current computed transform/filter as an
  // inline style, then the clone disables all animation so those baked inline values are
  // what render (a live @keyframes would restart at 0 when the snapshot is drawn). Returns
  // serialised SVG, or null if there's nothing to draw.
  function bakeStaticSvg(host: HTMLElement, elapsedMs: number): string | null {
    const svg = host.querySelector('svg');
    if (!svg) return null;
    const anims = (host as Element & { getAnimations?: (o?: { subtree?: boolean }) => Animation[] })
      .getAnimations?.({ subtree: true }) ?? [];
    for (const a of anims) {
      try { a.pause(); a.currentTime = elapsedMs; } catch { /* idle/finished — skip */ }
    }
    for (const a of anims) {
      try { (a as Animation & { commitStyles?: () => void }).commitStyles?.(); } catch { /* not committable — skip */ }
    }
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const kill = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    kill.textContent = '*{animation:none!important;transition:none!important}';
    clone.appendChild(kill);
    return new XMLSerializer().serializeToString(clone);
  }

  // Non-camera source: bake the current frame (above) and decode it through a reused <img>,
  // then drawImage → getImageData → emit. Async + skip-if-busy so a slow decode just lowers
  // the effective fps. The sync work per frame (seek + commit + clone + serialise) is a few
  // ms on a small SVG — nothing like a per-frame dom-to-image DOM clone.
  function grabAnim(now: number): void {
    if (!animHost || animBusy || subscribers.size === 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const host = animHost;
    if (!animStart) animStart = now;
    const svgStr = bakeStaticSvg(host, now - animStart);
    if (!svgStr) return;
    animBusy = true;
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml' }));
    const img = animImg ?? (animImg = new Image());
    img.onload = () => {
      try {
        if (animHost !== host || !canvas || !ctx) return; // torn down mid-decode
        const { cw, ch } = workingSize(img.naturalWidth || 512, img.naturalHeight || 512);
        if (canvas.width !== cw) canvas.width = cw;
        if (canvas.height !== ch) canvas.height = ch;
        ctx.drawImage(img, 0, 0, cw, ch);
        emit(ctx.getImageData(0, 0, cw, ch).data, cw, ch, now);
      } catch { /* a bad frame must not kill the loop */ }
      finally { URL.revokeObjectURL(url); animBusy = false; }
    };
    img.onerror = () => { URL.revokeObjectURL(url); animBusy = false; };
    img.src = url;
  }

  function loop(now: number): void {
    if (!stream && !animHost) return; // torn down
    const t = now ?? 0;
    if (t - lastGrab >= MIN_INTERVAL) { lastGrab = t; if (animHost) grabAnim(t); else grab(t); }
    rafId = requestAnimationFrame(loop);
  }

  async function start(opts?: { facingMode?: 'user' | 'environment' }): Promise<void> {
    refcount++;
    if (stream || animHost) return; // already running (camera or anim source)
    // Non-camera path: an animated SVG is armed → INLINE it live in an off-screen host
    // (rendered, so its CSS/SMIL animation actually ticks) and let grabAnim sample the
    // current frame. No getUserMedia, no permission — works with no camera. The markup
    // is already sanitised (svg-sanitize) by the caller before arming.
    if (animMarkup) {
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:-99999px;top:0;width:512px;height:512px;pointer-events:none;opacity:0.01;overflow:hidden';
      host.innerHTML = animMarkup;
      const svg = host.querySelector('svg');
      if (svg) { svg.setAttribute('width', '512'); svg.setAttribute('height', '512'); }
      (document.body ?? document.documentElement).appendChild(host);
      animHost = host;
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      rafId = requestAnimationFrame(loop);
      return;
    }
    if (starting) return starting; // a concurrent start is bringing the camera up
    const facingMode = opts?.facingMode ?? 'user';
    starting = (async () => {
      const s = await navigator.mediaDevices.getUserMedia({
        // Capture at 1080p so a high-resolution subscriber (a raster filter, or a
        // user-driven resolution slider — see runtime `render.liveMaxEdgeInput`) has
        // real pixels to downscale from; the grab loop never upscales past native
        // (grab() clamps scale ≤ 1), so a low working edge still stays cheap.
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      stream = s;
      videoEl = document.createElement('video');
      videoEl.autoplay = true;
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.srcObject = s;
      // Kick playback but DON'T await it: a detached <video> (and autoplay policies)
      // can leave play() pending indefinitely, and the grab loop already waits for the
      // first frame (it no-ops until videoWidth is set). So start() resolves as soon as
      // the stream + loop are wired, not when the first frame decodes.
      videoEl.play().catch(() => { /* autoplay blocked — frames still arrive via the loop */ });
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      rafId = requestAnimationFrame(loop);
    })();
    try {
      await starting;
    } catch (e) {
      // Failed to come up — undo this reference and surface the error to the caller.
      refcount = Math.max(0, refcount - 1);
      teardown();
      throw e;
    } finally {
      starting = null;
    }
  }

  function stop(): void {
    refcount = Math.max(0, refcount - 1);
    if (refcount === 0) teardown();
  }

  function subscribe(cb: FrameCallback, opts?: { maxEdge?: number }): () => void {
    const want = Math.max(1, Math.min(MAX_EDGE_CAP, Math.round(Number(opts?.maxEdge) || DEFAULT_MAX_EDGE)));
    subscribers.set(cb, want);
    return () => subscribers.delete(cb);
  }

  // Arm/disarm the non-camera animated-SVG source. Only takes effect on the next
  // start(); a running source keeps playing until stop()/teardown. Disarming (null)
  // while the anim source runs tears it down so it can't leak an off-screen <img>.
  function armAnimSource(markup: string | null): void {
    animMarkup = markup;
    if (!markup && animHost && refcount === 0) teardown();
  }

  return { isAvailable, start, stop, subscribe, armAnimSource };
}
