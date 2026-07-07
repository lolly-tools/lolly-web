// SPDX-License-Identifier: MPL-2.0
/**
 * staggerReveal — the gallery's entrance cascade, made reusable for any freshly-shown
 * set of items: an input section expanding, or a catalog group opening. Each item
 * animates in with a stepped delay (the CSS `.reveal-item` rule → shared `card-in`
 * keyframes) and a soft "shuffle" cue plays under it.
 *
 * Reduced motion: the CSS animation is gated to `prefers-reduced-motion: no-preference`,
 * so items just appear instantly; the sound self-gates in sfx.ts. So callers never need
 * their own reduced-motion check.
 */
import { playSfx } from './sfx.ts';

interface RevealOpts {
  /** Per-item delay step (ms). */ step?: number;
  /** Cap on total delay (ms) so a large section doesn't crawl. */ max?: number;
  /** Play the shuffle cue (default true). */ sound?: boolean;
}

/** Cascade `items` in with a stepped delay + a soft shuffle. Safe to call repeatedly. */
export function staggerReveal(items: Element[], { step = 22, max = 260, sound = true }: RevealOpts = {}): void {
  if (!items.length) return;
  for (const el of items) el.classList.remove('reveal-item');   // reset any in-flight run
  void (items[0] as HTMLElement).offsetWidth;                   // one reflow re-arms the animation
  items.forEach((el, i) => {
    const h = el as HTMLElement;
    h.style.setProperty('--reveal-delay', `${Math.min(i * step, max)}ms`);
    h.classList.add('reveal-item');
  });
  if (sound) playSfx('shuffle');
}

// The collapsible-section flavours that cascade on open: sidebar input groups, the
// platform/capabilities panels, and the profile cards. All are <details>; each keeps
// its items in a known body wrapper.
const SECTION_CLASSES = ['input-section', 'plat-section', 'profile-collapse'];
const SECTION_BODIES = '.input-section-body, .plat-section-body, .profile-collapse-body';

/** The items to cascade inside an opened section: a grid of cards if the body wraps one
 *  (capabilities/platform), otherwise the body's own direct children. */
function revealItemsFor(details: HTMLDetailsElement): Element[] {
  const body = details.querySelector(SECTION_BODIES);
  if (!body) return [];
  const grid = body.querySelector(':scope > [class*="grid"]');
  return [...(grid ?? body).children];
}

let installed = false;

/**
 * App-wide: when a collapsible `<details>` SECTION opens — a sidebar input group, a
 * platform / capabilities panel, or a profile card — cascade its contents in (+ a soft
 * shuffle). The `toggle` event doesn't bubble, so we listen in the CAPTURE phase, which
 * still visits the target for non-bubbling events. Idempotent; call once at boot
 * (main.ts), alongside installGlobalSfx().
 */
export function installGlobalReveal(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open) return;
    if (!SECTION_CLASSES.some(c => d.classList.contains(c))) return;
    const items = revealItemsFor(d);
    if (items.length) staggerReveal(items);
  }, true);
}
