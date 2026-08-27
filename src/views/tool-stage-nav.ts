// SPDX-License-Identifier: MPL-2.0
/**
 * Canvas stage navigation for the tool view: pinch-zoom + drag-pan on touch,
 * trackpad-native zoom/pan on desktop, a Fit/% HUD, and keyboard shortcuts - 
 * all layered on top of the fitCanvas scale via a transform on the OUTER wrapper.
 * Extracted verbatim from views/tool.ts (was a standalone module-level factory
 * there); `isTyping` moved with it because it was used only by this controller.
 * The HUD widget itself (markup/click-delegation/disabled-state) now lives in
 * components/zoom-hud.ts, shared with multi-edit and the catalog inspector/crop
 * dialog - this module keeps the pinch/pan/wheel/keyboard math, which is real
 * per-canvas behaviour, not accidental duplication.
 */
import { mountZoomHud } from '../components/zoom-hud.ts';
import type { ZoomHud } from '../components/zoom-hud.ts';
import { isTypingTarget } from '../lib/typing-target.ts';
import { icon } from '../lib/icons.ts';
import { requestDock, releaseDock, isDocked, edgeDockHitTest, edgeDockPreview, edgeDockAvailable } from '../lib/edge-dock.ts';

/** A client-space point. */
export interface Point { x: number; y: number; }
/** The canvas pan/zoom handle setupStageNav returns. */
export interface StageNav { reset(): void; isZoomed(): boolean; sync(): void; focusRect(x: number, y: number, w: number, h: number): void; destroy(): void; }

// True when focus is in a text field, so global canvas shortcuts don't hijack typing.
// Shadow-aware (lib/typing-target.ts): the sidebar's fields are <jelly-input> custom
// elements whose real <input> is in a shadow root, and a host-only test used to read
// as "not typing" - which is why `0` and `1` could not be typed into any text field.
const isTyping = (): boolean => isTypingTarget();

/**
 * Touch pinch-to-zoom + pan for the canvas stage.
 *
 * The page's native pinch-zoom is disabled (viewport user-scalable=no) so the
 * sticky sidebar header can't be stranded off-screen on mobile. To compensate,
 * the canvas preview gets gesture zoom here. It applies a transform to the OUTER
 * wrapper - fitCanvas only ever touches the inner canvas's width/height/transform,
 * so the two layers compose cleanly (fit-to-screen, then pinch on top of that).
 *
 * Returns { reset } so callers can snap back to the fitted view.
 */
// Unified canvas navigation for the stage: pinch-zoom + drag-pan on touch, and
// trackpad-native zoom/pan (+ a Fit/% HUD and keyboard shortcuts) on desktop.
// One module so both pointer types share a single transform model and never drift.
// The transform sits on the OUTER wrapper, layered on top of the fitCanvas scale;
// `scale` is a multiplier where 1 == the fitted view ("Fit").
export function setupStageNav(stageEl: HTMLElement, outerEl: HTMLElement, canvasEl: HTMLElement | null, nativeW: number, onFit: (() => void) | null | undefined, themeToggle?: HTMLElement, soundToggle?: HTMLElement, profileToggle?: HTMLElement): StageNav {
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
  // objects parked off the artboard stay reachable in editor tools) - or Fit
  // itself when a huge canvas already fits below that floor.
  function minScale(): number {
    const w = canvasEl ? canvasEl.getBoundingClientRect().width : 0;
    if (!(w > 0)) return 1;
    const fitAbs = (w / scale) / nativeW;   // absolute zoom the Fit view shows
    return Math.min(1, MIN_ABS / fitAbs);
  }

  // Zoom-IN ceiling as a fit-multiplier - the `scale` that renders at MAX_ABS× native
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

  // Jump to true 100% (1 CSS px per export px) about the stage centre.
  function actual(): void {
    const w = canvasEl ? canvasEl.getBoundingClientRect().width : 0;
    if (!(w > 0)) return;
    const c = stageCentre();
    zoomAbout(nativeW / w, c.x, c.y);
  }

  // Zoom + pan so a CLIENT-space rect (an artboard's live on-screen box) fills ~85% of the
  // stage, centred. The Artboards navigator reads the frame element's getBoundingClientRect
  // and passes it through an `fc-focus-rect` event - client coords, deliberately, so this is
  // immune to how the canvas is sized (a frames tool's canvas overflows its nominal width
  // with pasteboard frames, so a native→screen scale derived from `nativeW` is wrong by the
  // pasteboard ratio). Clamped to the same min/max as every other zoom; clampPan keeps it
  // reachable.
  function focusRect(cx: number, cy: number, cw: number, ch: number): void {
    if (!(cw > 0) || !(ch > 0)) return;
    captureOrigin();
    const sr = stageEl.getBoundingClientRect();
    const fcx = cx + cw / 2;   // frame centre, client coords, at the CURRENT transform
    const fcy = cy + ch / 2;
    // Factor that makes the frame fill 85% of the stage, letterboxed to its aspect.
    const want = 0.85 * Math.min(sr.width / cw, sr.height / ch);
    const next = Math.max(minScale(), Math.min(maxScale(), scale * want));
    const r = next / scale;
    // Zoom about the frame centre (pin it), exactly like zoomAbout…
    const lx = fcx - originX, ly = fcy - originY;
    tx = lx - (lx - tx) * r;
    ty = ly - (ly - ty) * r;
    scale = next;
    // …then slide the (still-pinned) frame centre onto the stage centre. NO clampPan here:
    // it keeps the whole WRAPPER's centre in view, which for a multi-frame canvas makes an
    // edge artboard un-centrable (the wrapper centre would have to leave the stage). A frame
    // parked at the stage centre is in view by construction, so the clamp is not needed.
    const sc = stageCentre();
    tx += sc.x - fcx;
    ty += sc.y - fcy;
    apply();
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
      // applied a tiny zoom about the moving midpoint and the jitter compounded - 
      // "zooms like crazy" - while also fighting the pan so it felt sluggish.)
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
    // Mouse pointerups belong to the desktop pan path (endMouse below). Without
    // this guard - the pointerdown/move handlers have it, this one didn't - a
    // middle-drag PAN at Fit fell through to the settle check: pan never changes
    // `scale`, so "scale ≈ 1" read as "back at fit" and the release snapped the
    // canvas straight back to centre. The fit lock is released by the pan itself
    // (tx/ty ≠ 0 → isZoomed() → fitCanvas preserves the view); letting go of the
    // button must not re-engage it.
    if (e.pointerType === 'mouse') return;
    pts.delete(e.pointerId);
    if (pts.size < 2) { lastMid = null; pinchDist = 0; }
    if (pts.size === 1) {
      const [p] = [...pts.values()];
      panPt = { x: p!.x, y: p!.y };
    } else if (pts.size === 0) {
      panPt = null;
      // Settled back AT fit - clear the transform. (Not <=: zoomed OUT past fit
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
  let hud: ZoomHud | null = null;

  function syncHud(): void {
    hud?.setZoomed(isZoomed());
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // CHORDS BELONG TO THE BROWSER. Cmd/Ctrl+= and Cmd/Ctrl+- are the browser's
    // whole-UI zoom (Cmd/Ctrl+0 its reset), and this handler used to catch their
    // bare `key` values ('=', '-', '0') and preventDefault them - so native page
    // zoom could never fire on any canvas tool. Canvas zoom answers only the bare
    // keys and their Shift siblings ('+' is Shift+'=' and '_' is Shift+'-' on
    // most layouts); the moment Meta/Ctrl/Alt is down the key is the browser's,
    // the same rule timeline-panel.ts's onKey applies to its bindings.
    // TODO(tauri): the Tauri webviews ship no native page-zoom UI, so on desktop
    // Cmd+= currently falls through to nothing there. Whole-UI zoom needs the
    // shell to wire WebviewWindow.setZoom (plus the
    // core:webview:allow-set-webview-zoom capability) behind these chords - 
    // neither shell has any zoom hook today (checked bridge-overrides/ and
    // src-tauri/, 2026-08-10). Web is the priority; do NOT re-capture the chords
    // here as a workaround.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
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

  // Zoom HUD (−  [NN%]  +  Fit) - created for EVERY pointer type. On touch it's the
  // primary way to snap to exact zoom levels and Fit (a pinch is imprecise); on
  // desktop it complements the trackpad/keyboard. The desktop-only wheel, mouse-pan
  // and keyboard wiring stays gated behind !isTouch further below.
  const hudEl = document.createElement('div');
  hudEl.className = 'stage-nav';
  // Hidden for the duration of a live-capture take: the HUD hovers over the stage,
  // and the element-crop recording tiers capture anything inside the stage box.
  // The rule ships in live-capture.ts's injected <style>, scoped to the take.
  hudEl.setAttribute('data-live-hide', '');
  stageEl.appendChild(hudEl);
  // Dock the theme cycle + sound toggles and the profile avatar at the end of the
  // HUD (a hairline separator sets them apart from the zoom controls), so every canvas
  // tool carries theme/sound/profile without cluttering the sidebar. Profile sits last
  // (right of the sound/mute toggle).
  const extras = [themeToggle, soundToggle, profileToggle].filter((el): el is HTMLElement => !!el);
  hud = mountZoomHud(hudEl, {
    ariaLabel: 'Zoom',
    // editor.css's mobile stacked-order rules key off the literal `data-nav`
    // attribute (`.stage-nav [data-nav="in"]` etc.) - opt into it explicitly;
    // every other caller gets the component's private, collision-proof default.
    navAttr: 'data-nav',
    classes: { btn: 'stage-nav-btn', pct: 'stage-nav-pct', fit: 'stage-nav-fit', sep: 'stage-nav-sep' },
    // No percent readout (it doubled as a Fit/100% toggle, reading as a second Fit
    // control); a single Fit button sits BETWEEN − and + as the reset, shown as an
    // icon. True 100% still lives on the keyboard (`1`); double-tap still fits.
    noReadout: true,
    fitPosition: 'middle',
    onZoom: (dir) => { const c = stageCentre(); zoomAbout(dir > 0 ? 1.25 : 0.8, c.x, c.y); },
    onFit: fit,
    outAriaLabel: 'Zoom out',
    inAriaLabel: 'Zoom in',
    fitAriaLabel: 'Fit to window',
    fitTitle: 'Fit to window',
    fitContent: icon('resize'),
    extras,
  });

  // ── Drag the HUD (by its grip) to reposition it over the canvas, or onto the
  //    inline-end edge to dock it into the desktop dock column (lib/edge-dock.ts),
  //    exactly like the export/player panels. Desktop only: the dock does not exist
  //    below the mobile breakpoint, and the vertical touch capsule stays put. State
  //    (floated position, or docked) persists per this device. ──────────────────────
  const HUD_STATE_KEY = 'lolly:stage-nav-dock';
  const HUD_DRAG_THRESHOLD = 4;   // px travel before a press counts as a drag
  let hudDragCleanup: (() => void) | null = null;

  type HudState = { mode?: 'edge'; left?: number; top?: number };
  const loadHudState = (): HudState => {
    try { return (JSON.parse(localStorage.getItem(HUD_STATE_KEY) || 'null') as HudState) || {}; }
    catch { return {}; }
  };
  const saveHudState = (s: HudState): void => {
    try { localStorage.setItem(HUD_STATE_KEY, JSON.stringify(s)); } catch { /* best-effort */ }
  };

  function setupHudDrag(): () => void {
    // The pill is all buttons, so a dedicated grip is the drag surface (the rest keeps
    // clicking through to zoom). It rides along in the mobile stacked capsule too.
    const grip = document.createElement('div');
    grip.className = 'stage-nav-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.innerHTML = icon('grip', { filled: true });
    hudEl.prepend(grip);

    // No wobble spring here (unlike the URL gauge): docking re-parents the HUD into the
    // dock column mid-drag, which orphans the wobble's GPU layer as a stuck ghost. The
    // drag itself needs no spring.

    // Stage-relative bounds (the HUD is position:absolute in #tool-stage), matching the
    // URL gauge's offsetLeft/offsetParent model, so a drag can never leave it off-screen.
    const bounds = (): { maxL: number; maxT: number } => {
      const par = (hudEl.offsetParent as HTMLElement | null);
      const pw = par?.clientWidth ?? stageEl.clientWidth;
      const ph = par?.clientHeight ?? stageEl.clientHeight;
      return { maxL: Math.max(4, pw - hudEl.offsetWidth - 4), maxT: Math.max(4, ph - hudEl.offsetHeight - 4) };
    };

    // Float the HUD at an explicit stage-relative position (or clear back to the CSS
    // default top-right when no coords are given, e.g. after undocking).
    const applyFloat = (left?: number, top?: number): void => {
      hudEl.removeAttribute('data-docked');
      if (typeof left === 'number' && typeof top === 'number') {
        const { maxL, maxT } = bounds();
        hudEl.style.right = 'auto';
        hudEl.style.left = `${Math.min(Math.max(left, 4), maxL)}px`;
        hudEl.style.top = `${Math.min(Math.max(top, 4), maxT)}px`;
      } else {
        hudEl.style.left = hudEl.style.top = hudEl.style.right = '';
      }
    };

    // edge-dock moved the HUD back into the stage (drag-out, or the mobile-breakpoint
    // guard): just restore its float look. Persistence is driven by the user gesture
    // (onUp / dockEdge), NOT here, so a breakpoint bounce doesn't wipe the 'edge' pref.
    const onUndock = (): void => applyFloat();

    const dockEdge = (): void => {
      if (!requestDock('zoom', hudEl, { compact: true, onRelease: onUndock, icon: icon('resize'), label: 'Zoom' })) return;
      hudEl.setAttribute('data-docked', '');
      hudEl.style.left = hudEl.style.top = hudEl.style.right = '';
      saveHudState({ mode: 'edge' });
    };

    let dragging = false, moved = false, sx = 0, sy = 0, bl = 0, bt = 0;
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) > HUD_DRAG_THRESHOLD) moved = true;
      if (!moved) return;
      // Grabbing a docked HUD drags it out; re-baseline so it continues from the pointer
      // (its stage-relative home) rather than jumping by the dock's body-level coords.
      if (isDocked('zoom')) { releaseDock('zoom'); sx = e.clientX; sy = e.clientY; bl = hudEl.offsetLeft; bt = hudEl.offsetTop; }
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const { maxL, maxT } = bounds();
      hudEl.style.right = 'auto';
      hudEl.style.left = `${Math.min(Math.max(bl + dx, 4), maxL)}px`;
      hudEl.style.top = `${Math.min(Math.max(bt + dy, 4), maxT)}px`;
      edgeDockPreview(edgeDockHitTest(e.clientX));   // light the drop zone near the edge
    };
    const onUp = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      edgeDockPreview(false);
      if (!moved) return;
      if (edgeDockHitTest(e.clientX)) dockEdge();
      else saveHudState({ left: hudEl.offsetLeft, top: hudEl.offsetTop });
    };
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      bl = hudEl.offsetLeft; bt = hudEl.offsetTop;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    grip.addEventListener('pointerdown', onDown);

    // Restore last session's placement.
    const saved = loadHudState();
    if (saved.mode === 'edge' && edgeDockAvailable()) dockEdge();
    else if (typeof saved.left === 'number' && typeof saved.top === 'number') applyFloat(saved.left, saved.top);

    return () => {
      grip.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      edgeDockPreview(false);
      if (isDocked('zoom')) releaseDock('zoom');   // return the HUD to the stage before teardown removes it
    };
  }

  if (!isTouch) {
    hudDragCleanup = setupHudDrag();

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
    hudDragCleanup?.();   // undock (return the HUD to the stage) + drop drag listeners first
    hud?.destroy();
    hudEl.remove();
  }

  return { reset, isZoomed, sync: syncHud, focusRect, destroy };
}
