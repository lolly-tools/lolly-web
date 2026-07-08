// SPDX-License-Identifier: MPL-2.0
/**
 * Canvas stage navigation for the tool view: pinch-zoom + drag-pan on touch,
 * trackpad-native zoom/pan on desktop, a Fit/% HUD, and keyboard shortcuts —
 * all layered on top of the fitCanvas scale via a transform on the OUTER wrapper.
 * Extracted verbatim from views/tool.ts (was a standalone module-level factory
 * there); `isTyping` moved with it because it was used only by this controller.
 */

/** A client-space point. */
export interface Point { x: number; y: number; }
/** The canvas pan/zoom handle setupStageNav returns. */
export interface StageNav { reset(): void; isZoomed(): boolean; sync(): void; destroy(): void; }

// True when focus is in a text field, so global canvas shortcuts don't hijack typing.
function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/**
 * Touch pinch-to-zoom + pan for the canvas stage.
 *
 * The page's native pinch-zoom is disabled (viewport user-scalable=no) so the
 * sticky sidebar header can't be stranded off-screen on mobile. To compensate,
 * the canvas preview gets gesture zoom here. It applies a transform to the OUTER
 * wrapper — fitCanvas only ever touches the inner canvas's width/height/transform,
 * so the two layers compose cleanly (fit-to-screen, then pinch on top of that).
 *
 * Returns { reset } so callers can snap back to the fitted view.
 */
// Unified canvas navigation for the stage: pinch-zoom + drag-pan on touch, and
// trackpad-native zoom/pan (+ a Fit/% HUD and keyboard shortcuts) on desktop.
// One module so both pointer types share a single transform model and never drift.
// The transform sits on the OUTER wrapper, layered on top of the fitCanvas scale;
// `scale` is a multiplier where 1 == the fitted view ("Fit").
export function setupStageNav(stageEl: HTMLElement, outerEl: HTMLElement, canvasEl: HTMLElement | null, nativeW: number, onFit: (() => void) | null | undefined, themeToggle?: HTMLElement, soundToggle?: HTMLElement): StageNav {
  const MAX_ABS = 16;             // zoom-IN ceiling: 16× native export pixels (≈1600% in the HUD)
  const MIN_ABS = 0.2;            // zoom-out floor: 20% of native export pixels
  const PINCH_DEADZONE = 0.02;    // ignore <2% finger-spread wobble so a pan ≠ zoom
  let scale = 1, tx = 0, ty = 0;
  let originX = 0, originY = 0;   // outer's natural (untransformed) top-left, client coords
  const pts = new Map<number, Point>();          // pointerId -> { x, y }   (touch / pen)
  let pinchDist = 0;              // finger separation at the previous move
  let lastMid: Point | null = null;             // previous pinch midpoint (client coords)
  let panPt: Point | null = null;               // previous single-finger point (client coords)
  let lastTap = 0;
  let spaceDown = false;          // desktop: hold Space to drag-pan
  let mousePanPt: Point | null = null;          // desktop: previous mouse point while panning

  // transform-origin must be the top-left for the focal-point math below to hold
  // (CSS defaults to centre). fitCanvas never sets a transform on the outer wrapper.
  outerEl.style.transformOrigin = '0 0';

  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid  = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function apply(): void {
    outerEl.style.transform = (scale === 1 && tx === 0 && ty === 0)
      ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    syncHud();
  }

  // Recover the wrapper's natural top-left from its current rect + transform, so
  // the math works regardless of the flex centring that positions it in the stage.
  function captureOrigin(): void {
    const r = outerEl.getBoundingClientRect();
    originX = r.left - tx;
    originY = r.top  - ty;
  }

  // Keep the (scaled) content centre inside the stage so it can never be lost.
  function clampPan(): void {
    const sr = stageEl.getBoundingClientRect();
    const w  = outerEl.offsetWidth  * scale;
    const h  = outerEl.offsetHeight * scale;
    const cx = originX + tx + w / 2;
    const cy = originY + ty + h / 2;
    if (cx < sr.left)   tx += sr.left   - cx;
    if (cx > sr.right)  tx += sr.right  - cx;
    if (cy < sr.top)    ty += sr.top    - cy;
    if (cy > sr.bottom) ty += sr.bottom - cy;
  }

  // Zooming OUT past Fit is allowed down to an absolute floor of MIN_ABS (so
  // objects parked off the artboard stay reachable in editor tools) — or Fit
  // itself when a huge canvas already fits below that floor.
  function minScale(): number {
    const w = canvasEl ? canvasEl.getBoundingClientRect().width : 0;
    if (!(w > 0)) return 1;
    const fitAbs = (w / scale) / nativeW;   // absolute zoom the Fit view shows
    return Math.min(1, MIN_ABS / fitAbs);
  }

  // Zoom-IN ceiling as a fit-multiplier — the `scale` that renders at MAX_ABS× native
  // pixels, so the HUD tops out at a consistent ~1600% regardless of stage/canvas size
  // (MAX_ABS is an ABSOLUTE cap; the fit ratio varies, so a fixed multiplier wouldn't).
  // Never below 1, so a tiny canvas already shown large still zooms to at least Fit.
  function maxScale(): number {
    const w = canvasEl ? canvasEl.getBoundingClientRect().width : 0;
    if (!(w > 0)) return MAX_ABS;
    const fitAbs = (w / scale) / nativeW;
    return Math.max(1, MAX_ABS / fitAbs);
  }

  function isZoomed(): boolean { return Math.abs(scale - 1) > 0.001 || tx !== 0 || ty !== 0; }
  function reset(): void { scale = 1; tx = 0; ty = 0; apply(); }
  // "Fit" = clear any zoom/pan, then recompute the fit for the current layout
  // (so it accounts for e.g. the mobile sheet's current coverage). reset() first
  // so isZoomed() is false and onFit's fitCanvas isn't skipped.
  function fit(): void { reset(); onFit?.(); }

  // Zoom by `factor`, keeping the client point (fx, fy) pinned under the cursor.
  function zoomAbout(factor: number, fx: number, fy: number): void {
    captureOrigin();
    const next = Math.max(minScale(), Math.min(maxScale(), scale * factor));
    if (next === scale) return;
    const r = next / scale;
    const lx = fx - originX, ly = fy - originY;
    tx = lx - (lx - tx) * r;
    ty = ly - (ly - ty) * r;
    scale = next;
    clampPan();
    apply();
  }

  function stageCentre(): Point {
    const sr = stageEl.getBoundingClientRect();
    return { x: (sr.left + sr.right) / 2, y: (sr.top + sr.bottom) / 2 };
  }

  // Effective on-screen size vs native export pixels — the figure the HUD shows.
  function pct(): number {
    const w = canvasEl ? canvasEl.getBoundingClientRect().width : 0;
    return w > 0 ? Math.round(w / nativeW * 100) : 100;
  }

  // Jump to true 100% (1 CSS px per export px) about the stage centre.
  function actual(): void {
    const w = canvasEl ? canvasEl.getBoundingClientRect().width : 0;
    if (!(w > 0)) return;
    const c = stageCentre();
    zoomAbout(nativeW / w, c.x, c.y);
  }

  // ── Touch / pen: pinch-zoom + drag-pan (mouse stays free for click-to-focus) ──
  stageEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    captureOrigin();
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinchDist = dist(a!, b!);
      lastMid   = mid(a!, b!);
      panPt     = null;
    } else if (pts.size === 1) {
      panPt = { x: e.clientX, y: e.clientY };
      if (e.timeStamp - lastTap < 300 && isZoomed()) { fit(); lastTap = 0; }  // double-tap → fit (sheet-aware)
      else lastTap = e.timeStamp;
    }
  });

  stageEl.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = dist(a!, b!);
      const m = mid(a!, b!);
      if (lastMid) { tx += m.x - lastMid.x; ty += m.y - lastMid.y; }  // two-finger pan
      // Pinch-zoom with a dead-zone: ignore small finger-spread wobble so a
      // two-finger PAN doesn't register as zoom. (Without this, every frame
      // applied a tiny zoom about the moving midpoint and the jitter compounded —
      // "zooms like crazy" — while also fighting the pan so it felt sluggish.)
      // Hold pinchDist as the reference until we actually zoom, so a slow,
      // deliberate pinch still accumulates past the threshold and applies smoothly.
      if (pinchDist > 0 && Math.abs(d / pinchDist - 1) > PINCH_DEADZONE) {
        const next = Math.max(minScale(), Math.min(maxScale(), scale * (d / pinchDist)));
        const r = next / scale;
        const fx = m.x - originX, fy = m.y - originY;
        tx = fx - (fx - tx) * r;   // zoom about the pinch midpoint
        ty = fy - (fy - ty) * r;
        scale = next;
        pinchDist = d;             // reset the reference only when we actually zoom
      }
      lastMid = m;
      clampPan();
      apply();
      e.preventDefault();
    } else if (pts.size === 1 && isZoomed() && panPt) {
      tx += e.clientX - panPt.x;
      ty += e.clientY - panPt.y;
      panPt = { x: e.clientX, y: e.clientY };
      clampPan();
      apply();
      e.preventDefault();
    }
  });

  const endTouch = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) { lastMid = null; pinchDist = 0; }
    if (pts.size === 1) {
      const [p] = [...pts.values()];
      panPt = { x: p!.x, y: p!.y };
    } else if (pts.size === 0) {
      panPt = null;
      // Settled back AT fit — clear the transform. (Not <=: zoomed OUT past fit
      // is a legitimate resting state now.)
      if (Math.abs(scale - 1) <= 0.001) reset();
    }
  };
  stageEl.addEventListener('pointerup', endTouch);
  stageEl.addEventListener('pointercancel', endTouch);

  // Suppress native scroll/zoom on the stage so the gestures above own the touch.
  // Scoped here (not in CSS) so scrollable no-canvas tools keep normal touch scroll.
  stageEl.style.touchAction = 'none';

  // ── Desktop: trackpad-native zoom/pan + a Fit/% HUD + keyboard shortcuts ──────
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  let hud: HTMLDivElement | null = null, pctEl: HTMLElement | null = null;

  function syncHud(): void {
    if (pctEl) pctEl.textContent = pct() + '%';
    if (hud)   hud.dataset.zoomed = isZoomed() ? '1' : '';
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !isTyping()) { spaceDown = true; stageEl.classList.add('is-grabbable'); return; }
    if (isTyping()) return;
    if (e.key === '0')                       fit();                                              // Fit
    else if (e.key === '1')                  actual();                                           // 100%
    else if (e.key === '+' || e.key === '=') { const c = stageCentre(); zoomAbout(1.25, c.x, c.y); }
    else if (e.key === '-' || e.key === '_') { const c = stageCentre(); zoomAbout(0.8,  c.x, c.y); }
    else return;
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') { spaceDown = false; stageEl.classList.remove('is-grabbable'); } };

  // Zoom HUD (−  [NN%]  +  Fit) — created for EVERY pointer type. On touch it's the
  // primary way to snap to exact zoom levels and Fit (a pinch is imprecise); on
  // desktop it complements the trackpad/keyboard. The desktop-only wheel, mouse-pan
  // and keyboard wiring stays gated behind !isTouch further below.
  hud = document.createElement('div');
  hud.className = 'stage-nav';
  hud.innerHTML =
    '<button type="button" class="stage-nav-btn" data-nav="out" aria-label="Zoom out">−</button>' +
    '<button type="button" class="stage-nav-pct" data-nav="pct" aria-label="Toggle Fit and 100%"><span class="stage-nav-pct-val">100%</span></button>' +
    '<button type="button" class="stage-nav-btn" data-nav="in" aria-label="Zoom in">+</button>' +
    '<button type="button" class="stage-nav-btn stage-nav-fit" data-nav="fit" aria-label="Fit to window">Fit</button>';
  // Dock the theme cycle toggle at the end of the HUD (a hairline separator sets
  // it apart from the zoom controls), so every canvas tool carries a theme
  // switcher without cluttering the sidebar. Icon-only with a tooltip; it has no
  // data-nav attr, so the HUD's zoom click delegation ignores it.
  if (themeToggle || soundToggle) {
    const sep = document.createElement('span');
    sep.className = 'stage-nav-sep';
    sep.setAttribute('aria-hidden', 'true');
    hud.append(sep);
    if (themeToggle) hud.append(themeToggle);
    if (soundToggle) hud.append(soundToggle);
  }
  stageEl.appendChild(hud);
  pctEl = hud.querySelector<HTMLElement>('.stage-nav-pct-val');
  // Keep taps on the pill from reaching the stage's pinch / double-tap-to-fit logic.
  hud.addEventListener('pointerdown', e => e.stopPropagation());
  hud.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
    if (!b) return;
    const c = stageCentre();
    if (b.dataset.nav === 'in')       zoomAbout(1.25, c.x, c.y);
    else if (b.dataset.nav === 'out') zoomAbout(0.8,  c.x, c.y);
    else if (b.dataset.nav === 'fit') fit();
    else if (b.dataset.nav === 'pct') { if (isZoomed()) fit(); else actual(); }
  });

  if (!isTouch) {
    // Cmd/Ctrl-wheel (and trackpad pinch, which the browser delivers as ctrl+wheel)
    // zooms about the cursor; a plain wheel pans, but only once zoomed in (nothing
    // to pan at Fit). passive:false so we can preventDefault the page zoom/scroll.
    stageEl.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAbout(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      } else if (isZoomed()) {
        e.preventDefault();
        captureOrigin();
        tx -= e.deltaX; ty -= e.deltaY;
        clampPan(); apply();
      }
    }, { passive: false });

    // Pan with middle-drag or Space+left-drag; plain left-clicks stay free so the
    // canvas click-to-focus behaviour keeps working.
    stageEl.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse') return;
      if (!(e.button === 1 || (e.button === 0 && spaceDown))) return;
      e.preventDefault();
      stageEl.setPointerCapture(e.pointerId);
      mousePanPt = { x: e.clientX, y: e.clientY };
      stageEl.classList.add('is-grabbing');
    });
    stageEl.addEventListener('pointermove', e => {
      if (!mousePanPt || e.pointerType !== 'mouse') return;
      captureOrigin();
      tx += e.clientX - mousePanPt.x;
      ty += e.clientY - mousePanPt.y;
      mousePanPt = { x: e.clientX, y: e.clientY };
      clampPan(); apply();
    });
    const endMouse = () => {
      if (!mousePanPt) return;
      mousePanPt = null;
      stageEl.classList.remove('is-grabbing');
      if (!isZoomed()) reset();
    };
    stageEl.addEventListener('pointerup', endMouse);
    stageEl.addEventListener('pointercancel', endMouse);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  syncHud();

  function destroy(): void {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    hud?.remove();
  }

  return { reset, isZoomed, sync: syncHud, destroy };
}
