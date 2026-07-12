// SPDX-License-Identifier: MPL-2.0
/**
 * Shared shell for a body-mounted anchored popover — the machinery lang-menu.ts
 * and profile-menu.ts used to hand-roll twice: mount a `<div>` on `document.body`,
 * position it off the trigger's rect, trap focus inside it, and tear it down on
 * Escape, an outside pointerdown, a window resize, or a route change (any of
 * NAV_EVENTS — the popover lives outside the view tree, so a hash/route change
 * would otherwise orphan it).
 *
 * `render(el, popover)` builds the popover's own content fresh on every open
 * (item lists, current-value checks, etc. can change between opens) and wires
 * whatever internal listeners it needs (item clicks, roving-tabindex arrow keys);
 * it returns the element that should receive initial focus, or null/undefined to
 * leave focus where it is. The shell only owns the generic lifecycle — callers
 * keep deciding what the trigger's own click handler does (profile-menu, e.g.,
 * only intercepts the click at a mobile breakpoint).
 *
 * inertBackground is always off: the trigger that opens one of these anchored
 * dropdowns lives in the same branch `trapFocus` would otherwise inert (see its
 * module doc), which would kill the trigger's own re-click-to-close affordance.
 *
 * The anchor need not be a real trigger element: `PopoverAnchor` is the minimal
 * shape `position()`/the outside-click check actually use, so a context menu that
 * opens at a pointer position (a right-click, a kebab button's corner) can pass a
 * `pointAnchor()` instead of forking this whole lifecycle — see projects.ts's and
 * folder-overlay.ts's tile context menus. `container` (default `document.body`)
 * lets a popover opened from WITHIN a native `<dialog open>` mount inside that
 * dialog instead — required for it to paint above the dialog's own `::backdrop`
 * (only the top-layer dialog's own subtree renders above its backdrop).
 */
import { trapFocus, type FocusTrap } from '../lib/focus-trap.ts';
import { NAV_EVENTS } from '../utils.ts';

export interface BodyPopoverHandle {
  open(): void;
  close(returnFocus?: boolean): void;
  isOpen(): boolean;
}

/** The minimal shape mountBodyPopover needs from whatever it's anchored to. A real
 *  HTMLElement satisfies this as-is; `pointAnchor()` below builds a virtual one for
 *  popovers with no real trigger element (a right-click, a computed point). `focus`/
 *  `setAttribute` are optional — a virtual anchor has no aria-expanded to toggle and
 *  no element worth returning focus to. */
export interface PopoverAnchor {
  getBoundingClientRect(): { top: number; left: number; right: number; bottom: number; width: number; height: number };
  contains(node: Node | null): boolean;
  focus?(): void;
  setAttribute?(name: string, value: string): void;
}

/** A virtual anchor at a viewport point (a right-click, a kebab button's computed
 *  corner) rather than a live element — mutate `.x`/`.y` before each `open()` to
 *  reposition it. `contains()` always reports false: nothing IS the point, so the
 *  outside-click check never carves out an exception for it. */
export interface PointAnchor extends PopoverAnchor { x: number; y: number; }
export function pointAnchor(x = 0, y = 0): PointAnchor {
  return {
    x, y,
    getBoundingClientRect() { return { top: this.y, left: this.x, right: this.x, bottom: this.y, width: 0, height: 0 }; },
    contains: () => false,
  };
}

export interface BodyPopoverOptions {
  /** Class applied to the mounted `<div>`. */
  className: string;
  /** Default 'menu'. */
  role?: string;
  ariaLabel?: string;
  /** Where the popover `<div>` is appended. Default `document.body`. Pass the host
   *  `<dialog>` when opening this from inside one (see the module doc). */
  container?: HTMLElement;
  /** Reposition the popover relative to the anchor; called on open and again on
   *  every window resize unless `onResize` is given. Default: right-aligned,
   *  dropped 8px below the anchor's bottom edge (matches the old profile-menu). */
  position?(el: HTMLDivElement, anchor: PopoverAnchor): void;
  /** Called on window resize INSTEAD OF re-running `position()` — e.g. to close
   *  the popover outright when a responsive breakpoint no longer applies. */
  onResize?(popover: BodyPopoverHandle): void;
}

function defaultPosition(el: HTMLDivElement, anchor: PopoverAnchor): void {
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.round(r.bottom + 8)}px`;
  el.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
}

export function mountBodyPopover(
  anchor: PopoverAnchor,
  render: (el: HTMLDivElement, popover: BodyPopoverHandle) => HTMLElement | null | void,
  opts: BodyPopoverOptions,
): BodyPopoverHandle {
  const position = opts.position ?? defaultPosition;
  const container = opts.container ?? document.body;
  let menu: HTMLDivElement | null = null;
  let outside: ((e: PointerEvent) => void) | null = null;
  let trap: FocusTrap | null = null;

  const reposition = (): void => { if (menu) position(menu, anchor); };
  const onResizeEvt = (): void => { opts.onResize ? opts.onResize(handle) : reposition(); };
  // preventDefault (not just stopPropagation) so an ancestor native <dialog> showing
  // modally — e.g. folder-overlay's, which a context menu can mount inside via
  // `container` — doesn't ALSO process this Escape as its own close request and
  // cascade-close behind us; only the popover should close.
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } };
  const onNavAway = (): void => close();

  function close(returnFocus = false): void {
    if (!menu) return;
    if (outside) document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResizeEvt);
    NAV_EVENTS.forEach(ev => window.removeEventListener(ev, onNavAway));
    outside = null;
    trap?.release();
    trap = null;
    menu.remove();
    menu = null;
    anchor.setAttribute?.('aria-expanded', 'false');
    if (returnFocus) anchor.focus?.();
  }

  function open(): void {
    if (menu) return;
    const el = document.createElement('div');
    menu = el;
    el.className = opts.className;
    el.setAttribute('role', opts.role ?? 'menu');
    if (opts.ariaLabel) el.setAttribute('aria-label', opts.ariaLabel);
    const initialFocus = render(el, handle);
    container.appendChild(el);
    position(el, anchor);
    anchor.setAttribute?.('aria-expanded', 'true');

    outside = (e) => { if (menu && !menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
    // Deferred so the very click that opened the popover doesn't also fire as
    // its own outside-click dismissal.
    setTimeout(() => document.addEventListener('pointerdown', outside!), 0);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResizeEvt);
    NAV_EVENTS.forEach(ev => window.addEventListener(ev, onNavAway));
    trap = trapFocus(el, { initialFocus: initialFocus ?? null, inertBackground: false });
  }

  const handle: BodyPopoverHandle = { open, close, isOpen: () => menu !== null };
  return handle;
}
