// SPDX-License-Identifier: MPL-2.0
/**
 * mountModal - the shared native-`<dialog>` lifecycle every app dialog needs:
 * body mount, `showModal()`, Escape via the `cancel` event, backdrop-hit-test
 * dismissal, initial focus, and teardown. Extracted from confirm-dialog.ts,
 * whose four dialog kinds (confirm/choice/notice/prompt) were the closest
 * thing to a shared modal component already - that behaviour is the spec
 * this primitive codifies for every other dialog to build on.
 *
 * `content` is opaque HTML; the caller wires its own listeners onto the
 * returned `.el` (data-act buttons, inputs, …) - this primitive only owns
 * the shell around it: create, mount, open, dismiss, close.
 *
 * Two things the caller never has to wire, because the dialog is mounted on
 * `document.body` - OUTSIDE the router's `#view`, which is the only thing a route
 * change replaces:
 *   - a route change under an open dialog (a hash link, navigateTo) tears it down,
 *     so it can't be left stranded in the top layer over the next view. Same
 *     NAV_EVENTS safety net body-popover.ts has for the same reason.
 *   - system Back (Android's key, iOS's edge swipe, the browser button) closes the
 *     topmost dialog INSTEAD of navigating the view out from under it: opening
 *     pushes one same-URL history entry per dialog for Back to consume, and any
 *     other close path consumes its own entry again. See openStack below.
 *
 * Focus containment is native: `showModal()` traps Tab inside the dialog and
 * `close()` restores focus to whatever was focused beforehand (the HTML
 * dialog-closing steps) - so there's no need for lib/focus-trap.ts here,
 * which exists for `role="dialog"` DIV overlays the browser doesn't trap for
 * free. `close()` always calls the native `.close()` before removing the
 * node so that restore step actually runs.
 */

export interface ModalHandle<T> {
  /** The mounted `<dialog>` element - wire content-specific listeners onto it. */
  el: HTMLDialogElement;
  /** Close (if not already closed/removed) and resolve `onClose` with `result`. Idempotent. */
  close(result?: T): void;
}

export interface ModalOptions<T> {
  /** Class name(s) set on the `<dialog>` element, e.g. `'modal'`, `'share-dialog'`. */
  className: string;
  ariaLabel?: string;
  /** Element to focus once mounted (called right after `showModal()`). Omit to
   *  leave focus wherever the browser's default (first autofocus/focusable) goes. */
  initialFocus?: (el: HTMLDialogElement) => HTMLElement | null | undefined;
  /** Value to resolve with on Escape, a backdrop click, or system Back. Fixed value,
   *  or computed from the dialog element at dismiss time. */
  cancelValue?: T | ((el: HTMLDialogElement) => T);
  /** Fired exactly once, after the dialog is closed + removed - however it closed
   *  (Escape, backdrop, Back, or a caller-driven `close(result)`). A route change
   *  under the dialog resolves `undefined`, never cancelValue: nobody dismissed it. */
  onClose?: (result: T | undefined) => void;
}

import { adoptFloatCluster, releaseFloatCluster } from '../lib/float-cluster.ts';
import { NAV_EVENTS } from '../utils.ts';

/** One record per open dialog, innermost last. */
interface OpenModal {
  /** The route changed under us: tear down (no user choice was made). */
  nav(): void;
  /** Back popped this dialog's own history entry: dismiss it. */
  pop(): void;
}
const openStack: OpenModal[] = [];

/**
 * Count of history entries mountModal has pushed and not yet popped. `history.back()`
 * can only consume the NEWEST entry, so a dialog only consumes its own when nothing
 * has pushed on top of it (`seq < depth`); otherwise the entry is left stranded,
 * which costs one Back press that does nothing but can never navigate wrongly.
 * Only the comparison against the newest matters, so a stranded entry inflating
 * this is harmless.
 */
let depth = 0;
/** Entry-consuming `history.back()` calls whose popstate hasn't arrived yet. Those
 *  pops are bookkeeping, not Back presses, so no dialog closes on them - and it's a
 *  count, not a flag: two stacked dialogs closed in one tick pop two entries, and
 *  the second popstate can land after a NEW dialog has opened. */
let selfPops = 0;

const onNavEvent = (e: Event): void => {
  if (e.type === 'popstate') {
    if (selfPops) { selfPops -= 1; return; }
    // One Back, the innermost dialog - the rule everywhere else in the shell. The
    // entry it popped was that dialog's own, so the URL is unchanged and main.ts's
    // navigate() resolves the same route signature and returns without re-mounting.
    openStack[openStack.length - 1]?.pop();
    return;
  }
  // hashchange / lolly:navigate: the view underneath is being replaced, so every
  // body-mounted dialog goes with it. Snapshot the stack - each close splices
  // itself out of it, and a caller's onClose may open a dialog of its own.
  [...openStack].forEach(m => m.nav());
};

export function mountModal<T = void>(content: string, opts: ModalOptions<T>): ModalHandle<T> {
  const dlg = document.createElement('dialog');
  dlg.className = opts.className;
  if (opts.ariaLabel) dlg.setAttribute('aria-label', opts.ariaLabel);
  dlg.innerHTML = content;
  document.body.appendChild(dlg);

  let settled = false;
  // This dialog's history entry: `seq` is its position in `depth`, `owed` says it's
  // still on the stack, `pushedHref` the URL it was pushed at.
  let owed = false;
  let seq = 0;
  let pushedHref = '';
  const cancelResult = (): T | undefined =>
    typeof opts.cancelValue === 'function' ? (opts.cancelValue as (el: HTMLDialogElement) => T)(dlg) : opts.cancelValue;

  /** Give up the entry without popping it: Back already did (`pop`), or a
   *  navigation pushed its own entry on top of ours (`nav`), and popping then
   *  would undo the navigation the user just made. */
  const disown = (): void => { if (owed) { owed = false; depth -= 1; } };

  /** Pop the entry this dialog pushed, so the next Back leaves the view rather
   *  than doing nothing. Deferred one microtask because a caller routinely
   *  navigates right after close() (welcome-dialog sets '#/start', pickers call
   *  navigateTo): by then the URL has moved, and the href check leaves our entry
   *  alone instead of racing a traversal against that navigation. */
  const consume = (): void => {
    owed = false;
    queueMicrotask(() => {
      if (seq < depth || location.href !== pushedHref) return;
      depth -= 1;
      selfPops += 1;
      try { history.back(); } catch { selfPops -= 1; }
    });
  };

  const close = (result?: T): void => {
    if (settled) return;
    settled = true;
    const i = openStack.indexOf(record);
    if (i >= 0) openStack.splice(i, 1);
    if (!openStack.length) NAV_EVENTS.forEach(ev => window.removeEventListener(ev, onNavEvent));
    if (owed) consume();
    releaseFloatCluster(dlg); // rescue the adopted floating cluster BEFORE the node goes away
    if (dlg.open) dlg.close(); // runs the native dialog-closing steps (incl. focus restore)
    dlg.remove();
    opts.onClose?.(result);
  };

  const record: OpenModal = {
    // Teardown, not a dismissal: resolve with `undefined` rather than cancelValue so
    // a caller can tell a route change from an Escape (welcome-dialog persists the
    // "seen" flag on one and not the other).
    nav: () => { disown(); close(); },
    pop: () => { disown(); close(cancelResult()); },
  };

  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(cancelResult()); }); // Escape
  // Safety net for outside callers that close the <dialog> natively instead of via
  // the handle (confirm-dialog's closeConfirmDialogs teardown does) - without this
  // the stack record and its owed history entry outlive the dialog, and the next
  // Back press gets eaten by the phantom. close() is idempotent, so the event this
  // handle's own close() fires at line ~142 is a no-op re-entry.
  dlg.addEventListener('close', () => close());
  dlg.addEventListener('click', (e) => {
    // Click outside the content box (on the ::backdrop) dismisses. A <dialog>'s own
    // click target is the dialog element itself whether the hit lands on its padding
    // or the backdrop, so a plain bounding-rect test is what actually distinguishes
    // them - works regardless of whether the content wraps itself in an inner div.
    // Only rect-test clicks that target the dialog itself: keyboard activation
    // (Enter/Space) of an inner button fires a UA-synthetic click at clientX/Y =
    // 0,0 - outside any centered card - which the bare rect test would misread as
    // a backdrop hit and dismiss as Cancel before the caller's data-act listener
    // (registered after this one) ever sees it. A true backdrop or padding click
    // always targets the <dialog> element, never an inner node.
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(cancelResult());
  });

  // Same URL, so this fires neither hashchange nor popstate and no route work runs;
  // it exists purely as something for Back to consume. Blocked (a sandboxed iframe,
  // a rate limit) is survivable: Back then reaches the route, and onNavEvent's
  // popstate branch still closes the dialog rather than stranding it.
  try {
    history.pushState(history.state, '', location.href);
    depth += 1;
    seq = depth;
    owed = true;
    pushedHref = location.href;
  } catch { /* history unavailable */ }
  openStack.push(record);
  if (openStack.length === 1) NAV_EVENTS.forEach(ev => window.addEventListener(ev, onNavEvent));

  dlg.showModal();
  // Everything outside a modal dialog is inert and below the top layer, so the
  // body-level floating cluster (job toast + undo toasts) moves in with us -
  // progress and Undo stay visible and interactive over the dialog.
  adoptFloatCluster(dlg);
  opts.initialFocus?.(dlg)?.focus();

  return { el: dlg, close };
}
