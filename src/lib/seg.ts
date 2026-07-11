// SPDX-License-Identifier: MPL-2.0
/**
 * The one segmented-control primitive (component audit rec 1) — a `role="group"`
 * of equal-width `.view-seg-btn`s, `aria-pressed` marking the active option.
 * `.view-seg`/`.view-seg-btn` themselves live in styles/parts/gallery.css (an
 * always-eager sheet, so the primitive is available before any lazy view chunk),
 * this module is just the shared markup function — moved out of brand-editor.ts
 * (its original home) so views that aren't the brand studio can render the same
 * markup without importing the whole editor module.
 *
 * Every segmented control in the app should be built from this — a mutually
 * exclusive choice among a handful of named options, `aria-pressed` the ONE
 * active-state convention. Tab bars (`.dash-tabs`, `.start-tabs`,
 * `.color-mode-tabs`) are a deliberately different widget (they switch panels,
 * not just a value) and use `aria-selected` + the roving-tabindex helper in
 * lib/tabs.ts instead — see that module's doc comment for the distinction.
 */
import { escape } from '../utils.ts';

/** Render a `.view-seg` group. `name` seeds the `data-be-seg` hook the brand
 *  studio's generic click delegate keys off; other callers can ignore it and
 *  wire their own listener against `.view-seg-btn[data-val]` inside the
 *  returned markup — the attribute is always present. */
export const segHtml = (name: string, opts: ReadonlyArray<{ id: string; label: string }>, active: string, label: string): string => `
  <div class="view-seg be-seg" role="group" aria-label="${escape(label)}" data-be-seg="${escape(name)}">
    ${opts.map(o => `<button type="button" class="view-seg-btn" data-val="${escape(o.id)}" aria-pressed="${o.id === active}">${escape(o.label)}</button>`).join('')}
  </div>`;
