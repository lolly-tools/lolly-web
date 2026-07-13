// SPDX-License-Identifier: MPL-2.0
/**
 * mountModal — the shared native-`<dialog>` lifecycle every app dialog needs:
 * body mount, `showModal()`, Escape via the `cancel` event, backdrop-hit-test
 * dismissal, initial focus, and teardown. Extracted from confirm-dialog.ts,
 * whose four dialog kinds (confirm/choice/notice/prompt) were the closest
 * thing to a shared modal component already — that behaviour is the spec
 * this primitive codifies for every other dialog to build on.
 *
 * `content` is opaque HTML; the caller wires its own listeners onto the
 * returned `.el` (data-act buttons, inputs, …) — this primitive only owns
 * the shell around it: create, mount, open, dismiss, close.
 *
 * Focus containment is native: `showModal()` traps Tab inside the dialog and
 * `close()` restores focus to whatever was focused beforehand (the HTML
 * dialog-closing steps) — so there's no need for lib/focus-trap.ts here,
 * which exists for `role="dialog"` DIV overlays the browser doesn't trap for
 * free. `close()` always calls the native `.close()` before removing the
 * node so that restore step actually runs.
 */

export interface ModalHandle<T> {
  /** The mounted `<dialog>` element — wire content-specific listeners onto it. */
  el: HTMLDialogElement;
  /** Close (if not already closed/removed) and resolve `onClose` with `result`. Idempotent. */
  close(result?: T): void;
}

export interface ModalOptions<T> {
  /** Class name(s) set on the `<dialog>` element, e.g. `'modal'`, `'share-dialog'`. */
  className: string;
  ariaLabel?: string;
  /** Element to focus once mounted (called right after `showModal()`). Omit to
   *  leave focus wherever the browser's default (first autofocus/focusable) lands. */
  initialFocus?: (el: HTMLDialogElement) => HTMLElement | null | undefined;
  /** Value to resolve with on Escape or a backdrop click. Fixed value, or computed
   *  from the dialog element at dismiss time. */
  cancelValue?: T | ((el: HTMLDialogElement) => T);
  /** Fired exactly once, after the dialog is closed + removed — however it closed
   *  (Escape, backdrop, or a caller-driven `close(result)`). */
  onClose?: (result: T | undefined) => void;
}

export function mountModal<T = void>(content: string, opts: ModalOptions<T>): ModalHandle<T> {
  const dlg = document.createElement('dialog');
  dlg.className = opts.className;
  if (opts.ariaLabel) dlg.setAttribute('aria-label', opts.ariaLabel);
  dlg.innerHTML = content;
  document.body.appendChild(dlg);

  let settled = false;
  const cancelResult = (): T | undefined =>
    typeof opts.cancelValue === 'function' ? (opts.cancelValue as (el: HTMLDialogElement) => T)(dlg) : opts.cancelValue;

  const close = (result?: T): void => {
    if (settled) return;
    settled = true;
    if (dlg.open) dlg.close(); // runs the native dialog-closing steps (incl. focus restore)
    dlg.remove();
    opts.onClose?.(result);
  };

  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(cancelResult()); }); // Escape
  dlg.addEventListener('click', (e) => {
    // Click outside the content box (on the ::backdrop) dismisses. A <dialog>'s own
    // click target is the dialog element itself whether the hit lands on its padding
    // or the backdrop, so a plain bounding-rect test is what actually distinguishes
    // them — works regardless of whether the content wraps itself in an inner div.
    // Only rect-test clicks that target the dialog itself: keyboard activation
    // (Enter/Space) of an inner button fires a UA-synthetic click at clientX/Y =
    // 0,0 — outside any centered card — which the bare rect test would misread as
    // a backdrop hit and dismiss as Cancel before the caller's data-act listener
    // (registered after this one) ever sees it. A true backdrop or padding click
    // always targets the <dialog> element, never an inner node.
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(cancelResult());
  });

  dlg.showModal();
  opts.initialFocus?.(dlg)?.focus();

  return { el: dlg, close };
}
