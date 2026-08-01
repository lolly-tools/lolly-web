// SPDX-License-Identifier: MPL-2.0
/**
 * Deployment governance for the export-panel preflight card — a seam module
 * with no imports, like export-policy.ts, so the boot-path control plane
 * (src/org/index.ts) and the lazy tool view can both reach it without either
 * dragging the other's dependencies into its chunk.
 *
 * Default OFF, deliberately: prepress findings (bleed, marks, colour intent)
 * are enterprise print-workflow machinery, and ambushing an individual who is
 * exporting a PNG for a chat message with "2 things to fix" is overwhelm, not
 * help. This is NOT a personal feature flag — it never appears in the
 * profile's flags list; a deployment's control plane enables it for its
 * members via org-config `can['export.preflight']`. The engine's preflight
 * rules (engine/src/preflight.ts) and the /pro batch row checks are untouched
 * — only the per-export panel card is governed.
 */

let governedOn = false;

/** Flip the export-panel preflight surface (control-plane seam; tests too). */
export function setPreflightGoverned(on: boolean): void { governedOn = on; }

/** Whether the surface is currently enabled on this install. */
export function preflightGoverned(): boolean { return governedOn; }
