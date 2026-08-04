// SPDX-License-Identifier: MPL-2.0
/**
 * The back pill — the "← Tools" control that used to be hand-written in every
 * view that has one (Dashboard, Verify, Profile, /pro, /start, the component
 * library, full-screen and sidebar tools, multi-edit).
 *
 * Two things were wrong with the hand-written copies, and this module fixes
 * both in one place:
 *
 * 1. They were LIES. Each was a hardcoded `<a href="#/">Tools</a>` — it always
 *    said "Tools" and always teleported to the gallery, no matter where you had
 *    actually come from. Opening the Dashboard from a Projects folder and
 *    pressing back dumped you in the gallery. Now the pill reads the view you
 *    last left (lib/back-nav.ts, already fed by the router) and both NAMES and
 *    RETURNS to it — "← Campaign assets", "← QR Code" — falling back to
 *    "← Home" → the gallery only when there is no previous view, i.e. you
 *    opened the URL directly. It also behaves like a back button: when a real
 *    history entry sits behind us it calls history.back() rather than pushing
 *    another entry, so back-back-back doesn't build a zig-zag stack.
 *
 * 2. They were MISALIGNED. The pill sat at its own top offset with its own
 *    padding while the top-right chrome cluster (.gallery-topright — the
 *    filter/history/language FABs and the profile pill) sat at another, so the
 *    two ends of the top row never lined up. The pill now shares the cluster's
 *    box metrics and offsets (see .tools-home / .tools-home.home-full in
 *    styles/parts/components.css + tool.css) and draws a stroked Lucide arrow
 *    instead of a text "←", so it reads as one of the same set.
 *
 * Call-sites render `backPillHtml()` and then wire `mountBackPill()`. Views
 * with unsaved work (the tool view, /pro) pass an `intercept` that takes over
 * the click and calls the supplied `go()` once the user has decided — that way
 * the confirm dialog and the pill never both navigate.
 */

import { t, tRaw } from '../i18n.ts';
import { escape } from '../utils.ts';
import { icon } from '../lib/icons.ts';
import { canGoBack, getPrevView } from '../lib/back-nav.ts';
import { navigateTo } from '../nav.ts';

export interface BackTarget {
  /** Where the pill points. Always a real href so middle-click/copy-link work. */
  href: string;
  /** The pill's text, already localised — render escaped. */
  label: string;
  /** True when clicking should pop the history entry instead of pushing a new one. */
  useHistory: boolean;
}

export interface BackPillOpts {
  /**
   * A target this view must return to regardless of history — the tool view's
   * launch folder (the `lolly:returnTo` marker). When the previous view IS that
   * target the pill still wears its name and still goes back through history;
   * otherwise it becomes a plain forward link, since history.back() would land
   * somewhere else entirely.
   */
  href?: string;
  /** Force the label (rare — only when the caller knows better than the router). */
  label?: string;
  /** Extra classes on the pill: 'home-full' (fixed top-left, the default),
   *  'sidebar-back' (in the tool sidebar's back row), 'start-back' (in flow). */
  class?: string;
  /** Drop the visible label and keep only the arrow, moving the destination into
   *  the aria-label — for the compact square in a dense header row (multi-edit),
   *  where a full pill would crowd the title. The destination is still resolved
   *  the same way, so screen readers get "Back to Campaign assets", not "Back". */
  iconOnly?: boolean;
}

/** Compare two in-app URLs ignoring a leading slash — `/#/p/x` vs `#/p/x`. */
const sameTarget = (a: string, b: string): boolean =>
  a.replace(/^\//, '') === b.replace(/^\//, '');

/**
 * Where back should go and what it should be called. Exported because views
 * need the same answer for their non-pill exits too (the tool view's
 * "Save & leave", /start's done button) — those must not drift from the pill.
 */
export function resolveBackTarget(opts: BackPillOpts = {}): BackTarget {
  const prev = getPrevView();
  if (opts.href) {
    const match = !!prev && sameTarget(prev.href, opts.href);
    return {
      href: opts.href,
      label: opts.label ?? (match ? prev!.label : t('Back')),
      useHistory: match && canGoBack(),
    };
  }
  // A known previous view always NAMES the pill and is always where it goes —
  // including after a reload, which is why back-nav persists it to
  // sessionStorage. Only the mechanism varies: this document pushed an entry
  // (canGoBack) → pop it, so repeated backs unwind rather than pile up;
  // otherwise (reloaded straight onto this view) there's no entry of ours to
  // pop, so go forward to the same place.
  if (prev) {
    return { href: prev.href, label: opts.label ?? prev.label, useHistory: canGoBack() };
  }
  // No previous view — a direct visit / fresh session (a shared /t/<id> link, a
  // reloaded editor). The only honest answer is the app's front door, so the pill
  // says "Home" and goes there.
  //
  // The href MUST be root-absolute. A bare '#/' resolves against whatever path
  // we're on, and a tool's canonical URL is the PATH form /t/<id> — so '#/'
  // became /t/<id>#/, which parseRoute (main.ts) reads as … the same tool: hash
  // '/' is skipped, the /t/<id> path branch wins. That left anyone who opened a
  // tool link directly with no way out of the editor at all.
  return { href: '/#/', label: opts.label ?? t('Home'), useHistory: false };
}

/** The pill's markup. `data-back-pill` carries the mode so mountBackPill()
 *  doesn't have to re-resolve (and possibly disagree with) the render. */
export function backPillHtml(opts: BackPillOpts = {}): string {
  const target = resolveBackTarget(opts);
  const cls = opts.class ?? 'home-full';
  const mode = target.useHistory ? 'history' : 'link';
  const arrow = `<span class="back-pill-icon" aria-hidden="true">${icon('arrowLeft', { size: 18 })}</span>`;
  if (opts.iconOnly) {
    // nosemgrep: lolly-href-escape-is-not-scheme-validation — resolveBackTarget() returns only an origin-relative in-app route (back-nav toRelative(), the '/#/p…' returnTo marker, or the '/#/' literal)
    return `<a href="${escape(target.href)}" class="${cls}" data-back-pill="${mode}" aria-label="${escape(tRaw('Back to {view}', { view: target.label }))}">${arrow}</a>`;
  }
  // nosemgrep: lolly-href-escape-is-not-scheme-validation — same resolveBackTarget() origin-relative route as above
  return `<a href="${escape(target.href)}" class="tools-home${cls ? ` ${cls}` : ''}" data-back-pill="${mode}">${arrow}<span class="back-pill-label">${escape(target.label)}</span></a>`;
}

export interface MountBackPillOpts {
  /**
   * Give the view first refusal on the click — for unsaved-work dialogs. Return
   * true to say "I've taken it" (the pill does nothing further); call the
   * supplied `go()` when the user has confirmed. Return false/undefined to let
   * the pill navigate normally.
   */
  intercept?: (go: () => void) => boolean | void;
}

/** Perform the back step for an already-rendered pill. */
function leave(el: HTMLElement): void {
  if (el.dataset.backPill === 'history' && window.history.length > 1) {
    window.history.back();
    return;
  }
  navigateTo(el.getAttribute('href') || '/#/');
}

/** Wire every back pill inside `root`. Idempotent per element — safe to call
 *  after a re-render that replaced the markup. */
export function mountBackPill(root: HTMLElement, opts: MountBackPillOpts = {}): void {
  root.querySelectorAll<HTMLElement>('[data-back-pill]').forEach(el => {
    el.addEventListener('click', e => {
      // Let the browser handle modified clicks (new tab / new window) — that's
      // what keeping a real href is for.
      const me = e as MouseEvent;
      if (me.metaKey || me.ctrlKey || me.shiftKey || me.altKey || me.button > 0) return;
      e.preventDefault();
      const go = () => leave(el);
      if (opts.intercept?.(go)) return;
      go();
    });
  });
}
