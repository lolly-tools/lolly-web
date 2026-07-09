// SPDX-License-Identifier: MPL-2.0
/**
 * Brand semantic CSS variables — the web half of the brand token contract
 * (plans/brand-token-contract.md §3/§5).
 *
 * applyBrandVars(el, host) resolves the seven `color.semantic.*` slots from the
 * active brand tokens (host.tokens) and mirrors them onto the tool-canvas root
 * as namespaced CSS custom properties, so tool templates can consume
 * `var(--brand-primary, #4f84ba)` — always with a fallback. A missing slot
 * REMOVES the property (it is never set to '') so the template fallback stays
 * in charge. Best-effort and async: it never throws and mounting never waits
 * on it (though exports may — see views/tool.ts brandVarsReady).
 *
 * Why `--brand-*`, not bare `--primary` (contract §3): the web shell's
 * styles/tokens.css defines `--primary`/`--muted`/… on `:root` as shadcn HSL
 * *triples*, and community utilities (compress-pdf, strip-data, text-helper)
 * deliberately consume that vocabulary inside the tool canvas as
 * `hsl(var(--primary, …))` — injecting full-colour values under the same names
 * would make those declarations invalid-at-computed-value-time, and would also
 * leak user brand colours into SUSE tools that use bare `var(--primary)` as a
 * private internal. The namespace removes both collision classes at zero cost
 * to template authors.
 */

import { colorToHex, isAlias } from '@lolly/engine';

/** The seven semantic slots (token leaf under `color.semantic`) → CSS var. */
const SLOTS = [
  ['primary', '--brand-primary'],
  ['on-primary', '--brand-on-primary'],
  ['secondary', '--brand-secondary'],
  ['surface', '--brand-surface'],
  ['text', '--brand-text'],
  ['muted', '--brand-muted'],
  ['edge', '--brand-edge'],
] as const;

/** The host slice this module reads — just the (optional) tokens resolver. */
interface BrandVarsHost {
  tokens?: { resolve(ref: string, opts?: { theme?: string }): Promise<unknown> };
}

/**
 * Resolve each semantic slot and set/remove its custom property on `el`.
 * Injection rules (contract §3, identical to the CLI's applyBrandVars):
 * a resolved string passes through (hex or a raw `oklch()` string are both
 * valid CSS colours the browser resolves natively) — UNLESS it is alias
 * residue (a `{path}` that never resolved is a missing slot, not a colour);
 * a structured DTCG colour object is normalised via the engine's colorToHex
 * (null ⇒ missing slot). Missing slots remove the property.
 */
export async function applyBrandVars(el: HTMLElement, host: BrandVarsHost): Promise<void> {
  await Promise.all(SLOTS.map(async ([slot, cssVar]) => {
    let value: unknown;
    try {
      // TokenSet.resolve accepts the `{alias}` form or a bare dotted path —
      // both hit the same lookup (engine/src/tokens.ts strips the braces), so
      // the alias form alone covers both spellings.
      value = await host.tokens?.resolve(`{color.semantic.${slot}}`);
    } catch { /* no tokens / broken doc → treat the slot as missing */ }
    try {
      const css = typeof value === 'string' && value
        ? (isAlias(value) ? null : value)
        : colorToHex(value);
      if (css) el.style.setProperty(cssVar, css);
      else el.style.removeProperty(cssVar);
    } catch { /* cosmetic only — never break mounting */ }
  }));
}
