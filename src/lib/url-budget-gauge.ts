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
  /** Cancel any pending pack timer — call on tool unmount so it can't fire after teardown. */
  dispose(): void;
}

/**
 * Wire a gauge to a chrome element that contains `[data-gauge-fill]` (the SVG fill ring),
 * `[data-gauge-pct]` (the centred percentage text), and takes `--gauge-frac` (0..1) +
 * `data-band` / `data-state`. `prefersReducedMotion` is injected so the module stays
 * DOM-pref-agnostic (the caller passes the app's shared read); the CSS gates the actual
 * transition, this only avoids a JS count-up.
 */
export function createUrlGauge(
  el: HTMLElement,
  labels: GaugeLabels,
  _prefersReducedMotion: () => boolean,
): UrlGauge {
  const pctEl = el.querySelector<HTMLElement>('[data-gauge-pct]');
  let seq = 0;
  let packTimer: ReturnType<typeof setTimeout> | null = null;

  const paint = (band: GaugeBand, usedFraction: number): void => {
    el.dataset.band = band;
    delete el.dataset.state;
    el.style.setProperty('--gauge-frac', String(Math.min(Math.max(usedFraction, 0), 1)));
    const pct = Math.round(usedFraction * 100);
    if (pctEl) pctEl.textContent = `${pct}%`;
    el.setAttribute('aria-label', labels.used(pct, band));
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

  const dispose = (): void => { if (packTimer) { clearTimeout(packTimer); packTimer = null; } };

  return { update, dispose };
}
