// SPDX-License-Identifier: MPL-2.0
/**
 * injected-tools — a generic registry for tools an EXTERNAL source adds to the
 * gallery at runtime.
 *
 * The sibling of session-source / field-policy / input-policy: a neutral seam the
 * gallery (and, later, the picker/dashboard) consults to list tools that come from
 * somewhere other than the mounted catalog. It is EMPTY by default, so
 * `getInjectedTools()` returns `[]` and every listing renders exactly as today.
 *
 * It knows nothing about WHO registers a tool: a deployment's optional control
 * plane registers a set (see src/org/) so a governed tool appears beside the pack's
 * own, but the registry is a standalone primitive a test or future feature can drive
 * the same way. One set at a time (last registration wins), mirroring session-source.
 *
 * The entries are pure DATA the gallery renders as ordinary tool cards — never code.
 * A `catalog`-source tool's `id` is the tool id the instance already serves under
 * `/tools/<id>/`, so clicking it loads through the normal tool-loader path with no
 * change. A `url`-source tool carries `toolUrl`, a link the picker's renderUrl path
 * turns into an image (the same safety net: it must resolve to a tool the instance
 * actually serves).
 */

/** One injected tool, in neutral terms (no control-plane vocabulary leaks here). */
export interface InjectedTool {
  /** The served tool id — the `/tools/<id>/` the loader fetches (NOT the injectable id). */
  id: string;
  /** Gallery card title. */
  name: string;
  /** Card grouping; defaults to the catch-all section when absent. */
  category?: string;
  /** Set for a url-source tool: the Lolly tool URL the picker renders. */
  toolUrl?: string;
}

let current: readonly InjectedTool[] = [];

/** Register the injected tool set (last-wins). Empty array = back to dormant. */
export function setInjectedTools(tools: readonly InjectedTool[]): void {
  current = tools.slice();
}

/** The injected tools, or `[]` when dormant (no control plane). */
export function getInjectedTools(): readonly InjectedTool[] {
  return current;
}

/** TEST-ONLY: clear the registry back to its dormant default. */
export function _clearInjectedToolsForTests(): void {
  current = [];
}
