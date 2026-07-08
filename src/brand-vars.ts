// SPDX-License-Identifier: MPL-2.0
/**
 * Brand semantic CSS variables — the web half of the brand token contract
 * (plans/brand-token-contract.md §3/§5).
 *
 * applyBrandVars(el, host) resolves the seven `color.semantic.*` slots from the
 * active brand tokens (host.tokens) and mirrors them onto the tool-canvas root
 * as CSS custom properties, so tool templates can consume
 * `var(--primary, #4f84ba)` — always with a fallback. A missing slot REMOVES
 * the property (it is never set to '') so the template fallback stays in
 * charge. Best-effort and async: it never throws and mounting never waits on it.
 *
 * Known shadow (deliberate): the web shell's styles/tokens.css defines
 * `--primary` etc. on `:root` as shadcn HSL *triples* consumed via
 * `hsl(var(--primary))`. Our full-colour values are scoped to the tool-canvas
 * root (`#tool-canvas`, or `#tool-content` for hideSidebar tools), whose
 * subtree contains only tool markup — editor overlay/toolbars are siblings by
 * invariant — so the two vocabularies never meet in one selector.
 */

/** The seven semantic slots (token leaf under `color.semantic`) → CSS var. */
const SLOTS = [
  ['primary', '--primary'],
  ['on-primary', '--on-primary'],
  ['secondary', '--secondary'],
  ['surface', '--surface'],
  ['text', '--text'],
  ['muted', '--muted'],
  ['edge', '--edge'],
] as const;

/** The host slice this module reads — just the (optional) tokens resolver. */
interface BrandVarsHost {
  tokens?: { resolve(ref: string, opts?: { theme?: string }): Promise<unknown> };
}

/**
 * Resolve each semantic slot and set/remove its custom property on `el`.
 * Values pass through as resolved (hex from the engine is fine; a raw
 * `oklch()` string is a valid CSS color the browser resolves natively).
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
      if (typeof value === 'string' && value) el.style.setProperty(cssVar, value);
      else el.style.removeProperty(cssVar);
    } catch { /* cosmetic only — never break mounting */ }
  }));
}
