// SPDX-License-Identifier: MPL-2.0
/**
 * A one-dimensional OKLCH slider whose track is BROKEN where the colour stops
 * being displayable.
 *
 * An ordinary colour slider paints a smooth ramp along its axis and quietly lies:
 * most of a chroma track at high lightness names colours no screen can show, and
 * the ramp goes flat there because every one of them maps to the same boundary
 * colour. This one samples the axis, keeps the runs that fit the gamut, and
 * leaves the rest as gaps inside a dashed outline of the full range. So the
 * shape of the track tells you where you can actually go before you drag.
 *
 * On a hue track the effect is the most useful: at a fixed lightness and chroma
 * you get several solid arcs with real gaps between them — the hues that can
 * hold that much chroma, and the ones that cannot.
 *
 * Companion to the 2D charts in oklch-slice.ts: same engine primitives
 * (`inGamut`, `maxChroma`), one axis instead of two. Kept free of a CSS import so
 * it stays testable under `node --test` — see the note in oklch-slice.ts.
 */

import { inGamut, oklchToHex } from '@lolly/engine';
import type { GamutName } from '@lolly/engine';
import { escapeHtml } from './html.ts';

/** Which channel a slider drives. */
export type GamutChannel = 'l' | 'c' | 'h';

export interface GamutSliderState {
  channel: GamutChannel;
  /** The colour the OTHER two channels are held at. */
  base: { l: number; c: number; h: number };
  /** The widest gamut a value may reach and still count as displayable. */
  limit: Exclude<GamutName, 'none'>;
  /** Ceiling of the chroma axis. Default 0.4. */
  cMax?: number;
}

const DEFAULT_C_MAX = 0.4;

/** The axis range and step for a channel, in that channel's own units. */
export function channelRange(ch: GamutChannel, cMax = DEFAULT_C_MAX): { min: number; max: number; step: number } {
  if (ch === 'h') return { min: 0, max: 360, step: 0.5 };
  if (ch === 'l') return { min: 0, max: 1, step: 0.005 };
  return { min: 0, max: cMax, step: 0.002 };
}

const CHANNEL_LABEL: Record<GamutChannel, string> = { l: 'Lightness', c: 'Chroma', h: 'Hue' };

/** The colour at `v` along the axis, with the other two channels held. */
function colorAt(state: GamutSliderState, v: number): { l: number; c: number; h: number } {
  return { ...state.base, [state.channel]: v };
}

/** Format a channel value the way that channel is normally read. */
export function formatChannel(ch: GamutChannel, v: number): string {
  if (ch === 'h') return `${Math.round(v)}°`;
  if (ch === 'l') return `${Math.round(v * 100)}%`;
  return v.toFixed(3);
}

/**
 * The displayable runs along the axis, as `{ from, to }` in 0–1 fractions of the
 * track, each with the colours to paint across it.
 *
 * `samples` is the resolution of the in/out test. 180 is enough that a run's
 * edges land within half a percent of the track — finer than the eye reads on a
 * slider, and cheap: each sample is one matrix multiply, not a bisection.
 */
export function gamutRuns(
  state: GamutSliderState,
  samples = 180,
): Array<{ from: number; to: number; stops: string[] }> {
  const { min, max } = channelRange(state.channel, state.cMax ?? DEFAULT_C_MAX);
  const n = Math.max(8, Math.floor(samples));
  const runs: Array<{ from: number; to: number; stops: string[] }> = [];
  let start = -1;

  const close = (endIdx: number): void => {
    if (start < 0) return;
    const from = start / n;
    const to = endIdx / n;
    // A handful of stops across the run is plenty — the ramp is smooth, and one
    // stop per sample would put 180 colour stops in a style attribute.
    const stops: string[] = [];
    const steps = Math.max(1, Math.min(12, Math.round((to - from) * 24)));
    for (let k = 0; k <= steps; k++) {
      const v = min + (from + ((to - from) * k) / steps) * (max - min);
      stops.push(oklchToHex(colorAt(state, v)));
    }
    runs.push({ from, to, stops });
    start = -1;
  };

  for (let i = 0; i <= n; i++) {
    const v = min + (i / n) * (max - min);
    const o = colorAt(state, v);
    const ok = inGamut(o.l, o.c, o.h, state.limit);
    if (ok && start < 0) start = i;
    if (!ok) close(i);
  }
  close(n);
  return runs;
}

/**
 * The slider's markup. Paint it with {@link paintGamutSlider} once it is in the
 * document and wire it with {@link wireGamutSlider}.
 *
 * The real `<input type="range">` carries the interaction — keyboard, touch and
 * assistive tech all work without any of it being reimplemented — and the
 * segments are decoration behind it.
 */
export function renderGamutSlider(id: string, state: GamutSliderState, value: number): string {
  const r = channelRange(state.channel, state.cMax ?? DEFAULT_C_MAX);
  const label = CHANNEL_LABEL[state.channel];
  return `
    <div class="gsl" data-gsl="${escapeHtml(id)}" data-channel="${state.channel}">
      <span class="gsl-key" aria-hidden="true">${escapeHtml(label.charAt(0))}</span>
      <div class="gsl-well">
        <div class="gsl-track" data-gsl-track aria-hidden="true"></div>
        <input type="range" class="gsl-input" data-gsl-input
          min="${r.min}" max="${r.max}" step="${r.step}" value="${value}"
          aria-label="${escapeHtml(label)}">
      </div>
      <output class="gsl-val" data-gsl-val>${escapeHtml(formatChannel(state.channel, value))}</output>
    </div>`;
}

/** Paint (or repaint) the broken track and the readout. */
export function paintGamutSlider(root: HTMLElement, state: GamutSliderState, value: number): void {
  const track = root.querySelector<HTMLElement>('[data-gsl-track]');
  if (track) {
    track.innerHTML = gamutRuns(state).map((run) => {
      const left = (run.from * 100).toFixed(3);
      const width = ((run.to - run.from) * 100).toFixed(3);
      const grad = run.stops.length > 1
        ? `linear-gradient(90deg, ${run.stops.join(',')})`
        : (run.stops[0] ?? 'transparent');
      return `<span class="gsl-seg" style="left:${left}%;width:${width}%;background:${grad}"></span>`;
    }).join('');
  }
  const out = root.querySelector<HTMLElement>('[data-gsl-val]');
  if (out) out.textContent = formatChannel(state.channel, value);
  const input = root.querySelector<HTMLInputElement>('[data-gsl-input]');
  if (input && document.activeElement !== input) input.value = String(value);
}

export interface GamutSliderHandlers {
  /** Continuous, on every movement — cheap work only. */
  onInput(value: number): void;
  /** The gesture ended (or a keyboard step landed) — spend the expensive work here. */
  onChange(value: number): void;
}

/** Wire the range input. Returns a teardown. */
export function wireGamutSlider(root: HTMLElement, h: GamutSliderHandlers): () => void {
  const input = root.querySelector<HTMLInputElement>('[data-gsl-input]');
  if (!input) return () => {};
  const onInput = (): void => h.onInput(Number(input.value));
  const onChange = (): void => h.onChange(Number(input.value));
  input.addEventListener('input', onInput);
  input.addEventListener('change', onChange);
  return () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('change', onChange);
  };
}
