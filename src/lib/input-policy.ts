// SPDX-License-Identifier: MPL-2.0
/**
 * input-policy — a generic per-input display-policy registry for the tool sidebar.
 *
 * The sibling of lib/field-policy.ts, one level up: where field-policy governs the
 * profile form's fixed fields, this governs a tool's declared inputs. A neutral
 * seam the sidebar renderer consults when building an input control: should this
 * input render as usual, be locked to a read-only value, be hidden entirely, or
 * have its choices narrowed to an allowed set?
 *
 * Keyed by (toolId, inputId) — a tool's inputs are namespaced by the tool, and the
 * registry mirrors that so a policy for one tool can never bleed into another. It
 * is EMPTY by default, so `getInputPolicy` returns `undefined` and the sidebar
 * renders exactly as it does today; this primitive is dormant until a setter runs.
 *
 * Like field-policy, it knows nothing about WHERE a policy comes from: a
 * deployment's optional org-config module populates it (see src/org/), but the
 * registry is a standalone primitive with no dependency on that. The human-readable
 * `note` arrives already localised from whoever sets the policy, so this file needs
 * no i18n and no product vocabulary.
 *
 * This is a RENDERING overlay only. The engine input model stays the single source
 * of truth — nothing here mutates it; the sidebar reads a policy alongside the
 * model and adjusts how it presents the control.
 */

/** How the sidebar should present an input. */
export type InputMode = 'locked' | 'hidden' | 'choice';

export interface InputPolicy {
  mode: InputMode;
  /** A short, already-localised note for a locked/choice input (e.g. "Managed by Acme"). */
  note?: string;
  /** For a locked input, the value the sidebar should display (and keep) instead of
   *  the model's stored value. Also carried on a `choice` for a pre-selected value. */
  value?: unknown;
  /** For a `choice` input, the option values a select-like control is restricted to. */
  allow?: readonly string[];
}

// toolId → (inputId → policy).
const registry = new Map<string, Map<string, InputPolicy>>();

/**
 * The policy for one input of one tool, or `undefined` when none is registered (the
 * default — the sidebar then behaves exactly as with no policy layer). Short-circuits
 * when the registry is empty (the dormant common case) so there is no per-input cost.
 */
export function getInputPolicy(toolId: string | undefined, inputId: string): InputPolicy | undefined {
  if (!toolId || registry.size === 0) return undefined;
  return registry.get(toolId)?.get(inputId);
}

/**
 * Replace ONE tool's entire input-policy set. An empty (or omitted) map removes that
 * tool's policies, restoring its dormant default. A whole-set swap keeps the source
 * of truth authoritative: an input dropped from a fresh set is unlocked again, never
 * left stale.
 */
export function setToolInputPolicies(toolId: string, policies: Record<string, InputPolicy> = {}): void {
  const entries = Object.entries(policies);
  if (!entries.length) { registry.delete(toolId); return; }
  registry.set(toolId, new Map(entries));
}

/** Clear every tool's policies, restoring the dormant default. */
export function clearInputPolicies(): void {
  registry.clear();
}

/** TEST-ONLY convenience: empty the registry back to its dormant default. */
export function _clearInputPoliciesForTests(): void {
  registry.clear();
}
