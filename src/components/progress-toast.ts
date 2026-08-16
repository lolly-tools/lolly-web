// SPDX-License-Identifier: MPL-2.0
/**
 * The floating progress toast that hosts an offscreen render/export pipeline's
 * progress UI (`.pro-toast` - see styles/parts/projects.css).
 *
 * The scaffold - create a `.pro-toast`, give it a close button + a
 * `.pro-toast-mount`, append it to <body>, run an export into the mount, and
 * swap in an error paragraph if the job throws - was retyped four times
 * (projects.ts, multi-edit.ts, folder-overlay.ts, profile.ts). This is that one
 * copy. Reconciled drift, picked deliberately:
 *
 * - Close label: translated `t('Close')` (projects/multi-edit/profile) rather
 *   than folder-overlay's untranslated hardcoded "Close".
 * - Glyph: the literal ✕ (three of four) rather than folder-overlay's
 *   `&#x2715;` entity - same rendered character, one fewer indirection.
 * - Error branch: present for EVERY caller. profile.ts had no outer failure
 *   path at all, so a throw outside its two inner try/catches left a stale
 *   "rendering…" toast on screen; it now surfaces the message like the rest.
 * - Lifecycle: `track` is OPTIONAL, because the right answer differs per caller.
 *   The three view-level callers (projects, multi-edit, profile) pass a set their
 *   view teardown drains, so a nav-away can't leave a toast floating over the
 *   next view. folder-overlay deliberately passes nothing: its only lifecycle is
 *   a showModal() dialog, and the toast is BELOW that dialog's top layer, so the
 *   user only ever sees it after closing the overlay - binding it there would
 *   destroy it exactly when it becomes visible. It's dismissed by its own ✕.
 */
import { escape } from '../utils.ts';
import { t } from '../i18n.ts';
import { announce } from '../a11y.ts';

export interface ProgressToastOpts {
  /** Positioning modifier: `bar` = full-width bar (projects/multi-edit),
   *  `top` = top-right corner (profile). Omit for the bare bottom-right default. */
  variant?: 'bar' | 'top';
  /** Initial mount content, so a slow first step doesn't show an empty toast. */
  seed?: string;
  /** Caller-owned live set; the toast adds itself on mount and removes itself
   *  when dismissed. Drain it from the view's teardown so a nav-away can't
   *  leave a toast floating over the next view. */
  track?: Set<HTMLElement>;
}

/**
 * Float a progress toast and run `run` inside it. Returns the toast element
 * (profile needs it to dim the whole toast behind a nested dialog). Errors from
 * `run` are rendered into the mount rather than thrown.
 */
export function mountProgressToast(
  run: (mount: HTMLElement, toast: HTMLElement) => unknown,
  opts: ProgressToastOpts = {},
): HTMLElement {
  const toast = document.createElement('div');
  toast.className = `pro-toast${opts.variant ? ` pro-toast--${opts.variant}` : ''}`;
  toast.innerHTML = `<button type="button" class="pro-toast-close" aria-label="${escape(t('Close'))}">✕</button><div class="pro-toast-mount">${opts.seed ?? ''}</div>`;
  document.body.appendChild(toast);
  opts.track?.add(toast);
  const mount = toast.querySelector<HTMLElement>('.pro-toast-mount')!;
  /* The mount is the only channel a long batch export has for "still going",
     "done" and "failed". Painting that text is not enough - mark it a polite
     live region so a screen-reader user hears the same progress a sighted one
     watches. Not `aria-atomic`: these runs append log lines, and re-reading the
     whole log on every append would be unusable. */
  mount.setAttribute('role', 'status');
  mount.setAttribute('aria-live', 'polite');
  toast.querySelector('.pro-toast-close')!.addEventListener('click', () => {
    toast.remove();
    opts.track?.delete(toast);
  });
  Promise.resolve(run(mount, toast)).catch((err) => {
    const msg = String((err as { message?: unknown })?.message ?? err);
    mount.innerHTML = `<p class="pro-progress-msg pro-log-err">${escape(msg)}</p>`;
    // A failure replaces the log wholesale; announce() guarantees it is spoken
    // even if the polite region's mutation is coalesced away mid-run.
    announce(msg);
  });
  return toast;
}
