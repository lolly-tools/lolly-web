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
 * The registry's keys are the wire values stored in a layout-studio box's enter/exit
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
 * matching the manifest default of those fields (layout-studio / sequence-studio).
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

// One object's animated offset at progress p∈[0,1] (0 = entrance start, 1 = at rest).
// Distances scale with the object's own size so a small lower-third slides a small way.
function recTransition(kind: string, p: number, w: number, h: number): { dx: number; dy: number; sc: number; alpha: number; rot: number } {
  if (kind === 'none') return { dx: 0, dy: 0, sc: 1, alpha: 1, rot: 0 };
  const pc = Math.max(0, Math.min(1, p));
  const ep = easeOutCubic(pc);
  const eb = easeOutBack(pc);
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

export { easeOutCubic, easeOutBack, recTransition };
