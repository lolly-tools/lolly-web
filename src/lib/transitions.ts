// SPDX-License-Identifier: MPL-2.0
/**
 * The shared transition vocabulary — one definition of what "pop" or "slide-left"
 * MEANS, consumed by both the video compositor (bridge/export.ts renderRecord) and
 * the timeline editing chrome that lets a user pick a kind per object.
 *
 * The maths moved here VERBATIM out of bridge/export.ts so exports stay byte-identical;
 * this module adds only the vocabulary around it (the kind union, the labelled registry,
 * and a prototype-safe membership test).
 *
 * The registry's keys are the wire values stored in a design box's enter/exit
 * fields, so they are a permanent contract: add kinds, never rename or reuse one.
 */

/** Every transition the compositor implements, in the order the sidebar offers them. */
export const TRANSITIONS = Object.freeze({
  fade: 'Fade',
  pop: 'Pop',
  grow: 'Grow',
  rise: 'Rise',
  drop: 'Drop',
  'slide-left': 'Slide from right',
  'slide-right': 'Slide from left',
  'slide-up': 'Slide from below',
  'slide-down': 'Slide from above',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  tilt: 'Tilt',
  swoop: 'Swoop',
  spin: 'Spin',
  drift: 'Drift',
  none: 'Cut (no animation)',
} as const);

export type TransitionKind = keyof typeof TRANSITIONS;

/** The kinds in registry order — for building a `<select>` or a picker grid. */
export const TRANSITION_KINDS = Object.freeze(Object.keys(TRANSITIONS) as TransitionKind[]);

/**
 * The kind a TIMELINE box animates with when its enter/exit field is empty — 'none',
 * matching the manifest default of those fields (design / sequence-studio).
 *
 * Deliberately NOT the same as the video compositor's `el.dataset.transition || 'fade'`
 * fallback in bridge/export.ts: that one reads a top-tail record stage, where an
 * overlay with no declared transition is meant to fade in. Two different data sources,
 * two different "nothing stored" answers — which is why this constant is named for the
 * one it serves rather than being shared.
 */
export const DEFAULT_TRANSITION: TransitionKind = 'none';

/**
 * Prototype-safe membership test: hasOwnProperty, never `TRANSITIONS[v]` — a bare
 * lookup answers truthy for 'constructor'/'toString'/'valueOf' and would let inherited
 * Object.prototype keys through as valid kinds.
 */
export function isTransitionKind(v: unknown): v is TransitionKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TRANSITIONS, v);
}

/** The human label for a kind, or the raw value back if it isn't one we implement. */
export function transitionLabel(v: unknown): string {
  return isTransitionKind(v) ? TRANSITIONS[v] : String(v ?? '');
}

/** One object's animated offset at a moment in its entrance. */
export interface TransitionOffset { dx: number; dy: number; sc: number; alpha: number; rot: number }

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
function easeOutBack(t: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

/* ── Authored easing ─────────────────────────────────────────────────────────
   The curve above is the one every kind was BORN with, and it stays the answer
   when nothing is authored — `recTransition` with no ease argument returns the
   numbers it always returned, byte for byte, which is the property that lets the
   compositor keep its existing output.

   What an authored ease governs is GEOMETRY ONLY: dx, dy, sc, rot. Alpha keeps
   its own fixed ramp (`pc / 0.6`, or `pc / 0.4` for the slides) because that ramp
   is not a stylistic choice — a fade that tracks a slow curve turns to mud once
   the frame has been through video compression, which is what the `aFast` comment
   below has always been about. Opacity therefore has no curve control anywhere in
   the UI, by design, not by omission.

   The wire format is a string, and it is a PERMANENT CONTRACT like the kind keys:
   either a preset name from `EASINGS` or a CSS `cubic-bezier(a,b,c,d)`. CSS's own
   spelling, so it is readable in a URL, familiar to anyone who has written a
   transition, and needs no bespoke serialisation. */

/** The named curves offered before anyone reaches for a custom one. */
export const EASINGS = Object.freeze({
  linear: 'Linear',
  'ease-out': 'Ease out',
  'ease-in': 'Ease in',
  'ease-in-out': 'Ease in and out',
  overshoot: 'Overshoot',
  anticipate: 'Anticipate',
  // Added with the keyframe grammar (plan 104 §5.1), which names eight presets and
  // round-trips every one of them BY NAME through `engine/src/keyframes.ts`. Adding
  // them here rather than only in the engine is what keeps ONE vocabulary: a curve
  // authored on a transition and one authored on a keyframe are the same curve, and
  // `kfEaseName` hands back exactly these names. Strictly additive — the six above
  // keep their spelling, their order and their points, so every authored ease and
  // every unauthored transition renders byte-identically to before.
  smooth: 'Smooth',
  snappy: 'Snappy',
} as const);

export type EasingName = keyof typeof EASINGS;

/** The preset curves as bezier control points, in CSS order (x1, y1, x2, y2). */
const EASING_POINTS: Readonly<Record<EasingName, readonly [number, number, number, number]>> = Object.freeze({
  linear: [0, 0, 1, 1],
  'ease-out': [0.33, 1, 0.68, 1],
  'ease-in': [0.32, 0, 0.67, 0],
  'ease-in-out': [0.65, 0, 0.35, 1],
  // y > 1 overshoots the resting value and settles back; y < 0 pulls away first.
  // Both are legal CSS and both are what people mean by "with a bit of life".
  overshoot: [0.34, 1.56, 0.64, 1],
  anticipate: [0.36, -0.4, 0.66, 1],
  // The two the keyframe grammar adds. `smooth` is the standard accelerate-decelerate
  // curve; `snappy` shares its in-ramp but holds the out-handle much later, so it
  // leaves at the same rate and arrives abruptly — a deliberate sibling of smooth
  // rather than a second overshoot. Byte-identical to KF_EASE_PRESETS.es/.ek in
  // engine/src/keyframes.ts; transitions.test.ts pins the two tables together.
  smooth: [0.4, 0, 0.2, 1],
  snappy: [0.4, 0, 0.6, 1],
});

export function isEasingName(v: unknown): v is EasingName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(EASINGS, v);
}

/** The four control points of an authored ease, or null if it isn't one. */
export function easingPoints(v: unknown): [number, number, number, number] | null {
  if (isEasingName(v)) return [...EASING_POINTS[v]];
  if (typeof v !== 'string') return null;
  const m = /^\s*cubic-bezier\(([^)]*)\)\s*$/i.exec(v);
  if (!m) return null;
  const n = m[1]!.split(',').map((s) => Number(s.trim()));
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  // x is TIME and must stay inside the unit interval or the curve is not a
  // function of progress — CSS rejects the same thing. y is unbounded on purpose:
  // that is the whole overshoot family.
  if (n[0]! < 0 || n[0]! > 1 || n[2]! < 0 || n[2]! > 1) return null;
  return [n[0]!, n[1]!, n[2]!, n[3]!];
}

/** Round-trip an authored ease back to its canonical wire string. */
export function easingToWire(v: unknown): string {
  if (isEasingName(v)) return v;
  const p = easingPoints(v);
  return p ? `cubic-bezier(${p.map((x) => Math.round(x * 1000) / 1000).join(',')})` : '';
}

/**
 * y at time x on a unit cubic bezier with endpoints (0,0) and (1,1).
 *
 * Newton-Raphson first, because it converges in two or three steps for the curves
 * anyone actually authors, then bisection as the guaranteed fallback — the same
 * shape as every browser's own implementation. A near-zero derivative is where
 * Newton diverges (a curve with a flat spot, e.g. an x1 of 0 against an x2 of 1),
 * so that case bails to bisection rather than dividing by it.
 */
export function cubicBezierAt(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const dx = sampleX(t) - x;
    if (Math.abs(dx) < 1e-6) return sampleY(t);
    const d = slopeX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= dx / d;
  }
  let lo = 0, hi = 1;
  t = x;
  for (let i = 0; i < 24 && Math.abs(sampleX(t) - x) > 1e-6; i++) {
    if (sampleX(t) < x) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

/**
 * The geometry curve for one transition: the authored ease if there is a valid one,
 * otherwise the kind's own — which is `easeOutBack` for `pop` and `easeOutCubic` for
 * everything else, exactly as before this control existed.
 */
function geometryEase(kind: string, ease: unknown): (t: number) => number {
  const p = easingPoints(ease);
  if (p) return (t: number) => cubicBezierAt(p[0], p[1], p[2], p[3], t);
  return kind === 'pop' ? easeOutBack : easeOutCubic;
}

// One object's animated offset at progress p∈[0,1] (0 = entrance start, 1 = at rest).
// Distances scale with the object's own size so a small lower-third slides a small way.
//
// `ease` is optional and governs GEOMETRY ONLY (see the easing section above). Omit it
// — as every caller did before the control existed, and as every unauthored box still
// does — and the numbers are identical to the ones this returned when the maths first
// moved out of the compositor.
function recTransition(kind: string, p: number, w: number, h: number, ease?: unknown): { dx: number; dy: number; sc: number; alpha: number; rot: number } {
  if (kind === 'none') return { dx: 0, dy: 0, sc: 1, alpha: 1, rot: 0 };
  const pc = Math.max(0, Math.min(1, p));
  const curve = geometryEase(kind, ease);
  // `ep` and `eb` are the SAME curve now — a kind picks its default through
  // `geometryEase`, and an authored ease overrides whichever it would have used. The
  // two names are kept because the cases below read as the shapes they always were.
  const ep = curve(pc);
  const eb = kind === 'pop' ? ep : easeOutBack(pc);
  const aFast = Math.min(1, pc / 0.6);   // opacity ramps in fast → crisp video/gif
  const aSlide = Math.min(1, pc / 0.4);
  let dx = 0, dy = 0, sc = 1, alpha = aFast, rot = 0;
  switch (kind) {
    case 'fade': break;
    case 'pop': sc = 0.7 + 0.3 * eb; break;
    case 'grow': sc = Math.max(0.02, ep); break;
    case 'rise': dy = (1 - ep) * (h * 0.6 + 48); break;
    case 'drop': dy = -(1 - ep) * (h * 0.6 + 48); break;
    case 'slide-left':  dx = (1 - ep) * (w * 0.9 + 140); alpha = aSlide; break; // from the right
    case 'slide-right': dx = -(1 - ep) * (w * 0.9 + 140); alpha = aSlide; break; // from the left
    case 'slide-up':    dy = (1 - ep) * (h * 0.9 + 140); alpha = aSlide; break; // from below
    case 'slide-down':  dy = -(1 - ep) * (h * 0.9 + 140); alpha = aSlide; break; // from above
    case 'zoom-in': sc = 0.6 + 0.4 * ep; break;
    case 'zoom-out': sc = 1.5 - 0.5 * ep; break;
    case 'tilt': rot = (1 - ep) * -14; dy = (1 - ep) * 36; break;
    case 'swoop': dx = (1 - ep) * (w * 0.6 + 140); rot = (1 - ep) * 10; break;
    case 'spin': rot = (1 - ep) * -200; sc = 0.5 + 0.5 * ep; break;
    case 'drift': dx = (1 - ep) * (w * 0.25); dy = (1 - ep) * (h * 0.12); alpha = Math.min(1, pc / 0.9); break;
    default: break; // unknown → plain fade
  }
  return { dx, dy, sc, alpha, rot };
}

export { easeOutCubic, easeOutBack, recTransition, geometryEase };
