// SPDX-License-Identifier: MPL-2.0
/**
 * The ambient URL-budget gauge (plan 115 P1). A small SVG ring in the tool chrome that
 * shows how much of a shareable link the current edit costs — green → amber → red vs the
 * active target — updating live as you edit. It READS the P0 cost model (costUrlState),
 * never the raw address bar, so its number is the link you'd actually copy.
 *
 * Two jobs:
 *  - render a UrlCostModel to the ring synchronously every edit (cheap, never blocks);
 *  - for a BROWSER-target link that will auto-pack (readableLen >= AUTO_PACK_MIN), refine
 *    the verdict with a debounced, seq-guarded real packQuery — because a 2500-char link
 *    that deflates to 700 is fine, and showing red for it would be dishonest. QR/SMS never
 *    consult packing (a `z=` blob defeats a scannable/textable link), so they always show
 *    their readable band.
 *
 * Chrome-only: the caller mounts this in tool chrome, NEVER inside .tool-canvas /
 * #tool-content / the export stage. The gauge writes nothing that reaches a render.
 */
import { PACK_PARAM, packQuery } from '@lolly/engine';
import type { UrlCostModel } from './url-budget.ts';

/** How long after the last edit to spend a real pack on the refine. Fine enough to feel
 *  live, coarse enough not to re-pack every settled frame during a slider drag. */
const PACK_REFINE_DEBOUNCE_MS = 200;

export type GaugeBand = 'ok' | 'warn' | 'over';

/** Pure: the band/fraction/overBy for an effective (possibly packed) length against a
 *  target. Shared by the sync render and the packed refine so they can't disagree. */
export function bandForLength(
  target: { warn: number; hard: number },
  effectiveLen: number,
): { band: GaugeBand; usedFraction: number; overBy: number } {
  return {
    band: effectiveLen >= target.hard ? 'over' : effectiveLen >= target.warn ? 'warn' : 'ok',
    usedFraction: target.warn > 0 ? effectiveLen / target.warn : 0,
    overBy: effectiveLen - target.warn,
  };
}

/** The share query the gauge packs — the kept rows' emits joined by '&'. This reproduces
 *  costUrlState's own readable query (the buildShareParams serialization), NOT the address
 *  bar's (a deliberately different byte stream), so the packed number stays honest. */
export function shareQueryOf(model: UrlCostModel): string {
  return model.params
    .filter((p) => p.status === 'kept')
    .map((p) => p.emit)
    .join('&');
}

export interface GaugeLabels {
  /** e.g. (42, 'warn') => "URL budget: 42% used". Localised by the caller. */
  used: (pct: number, band: GaugeBand) => string;
  /** shown on the interim state while a large link is being compressed. */
  compressing: string;
}

export interface UrlGauge {
  /** Render a fresh cost model. `base` is the full-URL base (origin + '/t/<id>?') so the
   *  packed length is measured against the same absolute ceiling as readableLen. */
  update(model: UrlCostModel, base: string): void;
  /** Cancel timers + listeners — call on tool unmount so nothing fires after teardown. */
  dispose(): void;
}

/** localStorage key for the gauge's dragged position — a chrome pref (device-local, like
 *  the theme), NOT tool state. */
const POS_KEY = 'lolly-url-gauge-pos';
/** Pointer travel (px) past which a press is a drag, not a click. */
const DRAG_THRESHOLD = 4;

/**
 * Wire a gauge to a chrome element that has `[data-gauge-fill]` (the fill) and takes
 * `--gauge-frac` (0..1) + `data-band` / `data-state`. Also makes it DRAGGABLE (the user
 * repositions it instead of it hiding — position persists across sessions) and calls
 * `onActivate` on a click that wasn't a drag (opens the Share dialog). `prefersReducedMotion`
 * is accepted for API symmetry; the CSS gates the actual transitions.
 */
export function createUrlGauge(
  el: HTMLElement,
  labels: GaugeLabels,
  _prefersReducedMotion: () => boolean,
  onActivate?: () => void,
): UrlGauge {
  const pctEl = el.querySelector<HTMLElement>('[data-gauge-pct]');
  let seq = 0;
  let packTimer: ReturnType<typeof setTimeout> | null = null;

  // Position is stage-relative (the gauge is position:absolute inside #tool-stage), so
  // drags + persistence use offsetLeft/offsetTop and clamp to the offset parent's box.
  const bounds = (): { maxL: number; maxT: number } => {
    const p = el.offsetParent as HTMLElement | null;
    return {
      maxL: Math.max(4, (p ? p.clientWidth : window.innerWidth) - el.offsetWidth - 4),
      maxT: Math.max(4, (p ? p.clientHeight : window.innerHeight) - el.offsetHeight - 4),
    };
  };

  // ── restore the dragged position (clamped in case the stage is smaller here) ──
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
      const { maxL, maxT } = bounds();
      el.style.left = `${Math.max(4, Math.min(saved.left, maxL))}px`;
      el.style.top = `${Math.max(4, Math.min(saved.top, maxT))}px`;
    }
  } catch { /* no/bad storage — keep the CSS default (canvas top-left) */ }

  // ── drag to move / click to share ──
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let baseLeft = 0;
  let baseTop = 0;

  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) moved = true;
    if (!moved) return;
    const { maxL, maxT } = bounds();
    el.style.left = `${Math.min(Math.max(baseLeft + dx, 4), maxL)}px`;
    el.style.top = `${Math.min(Math.max(baseTop + dy, 4), maxT)}px`;
  };
  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (moved) {
      try { localStorage.setItem(POS_KEY, JSON.stringify({ left: el.offsetLeft, top: el.offsetTop })); } catch { /* ignore */ }
    } else {
      onActivate?.(); // a click, not a drag → open the Share dialog
    }
  };
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    baseLeft = el.offsetLeft; // stage-relative, matches the position:absolute coords we set
    baseTop = el.offsetTop;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate?.(); }
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('keydown', onKey);

  const paint = (band: GaugeBand, usedFraction: number): void => {
    el.dataset.band = band;
    delete el.dataset.state;
    el.style.setProperty('--gauge-frac', String(Math.min(Math.max(usedFraction, 0), 1)));
    const pct = Math.round(usedFraction * 100);
    if (pctEl) pctEl.textContent = `${pct}%`;
    el.setAttribute('aria-label', labels.used(pct, band));
    el.title = labels.used(pct, band);
    el.hidden = false;
  };

  const paintFor = (target: { warn: number; hard: number }, effectiveLen: number): void => {
    const { band, usedFraction } = bandForLength(target, effectiveLen);
    paint(band, usedFraction);
  };

  const setCompressing = (): void => {
    // Don't flash the readable band first — a >=1800-char readable is already ~90% of the
    // 2000 warn, so it would snap amber→green when the pack lands. Show a neutral interim.
    el.dataset.state = 'compressing';
    el.setAttribute('aria-label', labels.compressing);
    el.hidden = false;
  };

  const update = (model: UrlCostModel, base: string): void => {
    const mySeq = ++seq; // invalidates any pack already in flight from a prior update
    if (packTimer) { clearTimeout(packTimer); packTimer = null; }

    // QR/SMS, tiny browser links, or no CompressionStream: honest readable band, no async.
    if (model.target.name !== 'browser' || !model.packable) {
      paintFor(model.target, model.readableLen);
      return;
    }

    setCompressing();
    const shareQuery = shareQueryOf(model);
    packTimer = setTimeout(() => {
      packTimer = null;
      packQuery(shareQuery)
        .then((token) => {
          if (mySeq !== seq) return; // a newer update() already took over the ring
          if (token == null) { paintFor(model.target, model.readableLen); return; } // codec vanished
          // Absolute full-URL length of the packed link, to band against the same ceiling.
          const packedFull = base.length + PACK_PARAM.length + 1 + token.length;
          // "Packing didn't help" (mirror syncUrl): fall back to the readable band.
          paintFor(model.target, packedFull < model.readableLen ? packedFull : model.readableLen);
        })
        .catch(() => { if (mySeq === seq) paintFor(model.target, model.readableLen); });
    }, PACK_REFINE_DEBOUNCE_MS);
  };

  const dispose = (): void => {
    if (packTimer) { clearTimeout(packTimer); packTimer = null; }
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('keydown', onKey);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  return { update, dispose };
}
