// SPDX-License-Identifier: MPL-2.0
/**
 * Per-canvas commit channel — the 1:1 path an interactive tool uses to write a
 * value back to ITS OWN runtime.
 *
 * Interactive tool templates (mesh-gradient dot drags, street-map pan/zoom)
 * historically committed a canvas edit by reaching into the sidebar with a
 * GLOBAL `document.querySelector('[data-input-id="…"]')` + a bubbling `input`
 * event. That assumes exactly one sidebar bound to one runtime — true in the
 * single-tool view, FALSE in multi-edit (#/multi), where the FIRST match in
 * document order is the shared "fan" control bound to every sibling session, so
 * a drag on one canvas leaks the value to every similar tool. The tool has no
 * way to know which of the N canvases it came from.
 *
 * The shell instead hands each mounted canvas its own commit function keyed to
 * the runtime that owns it. A tool script resolves it from its OWN subtree:
 *
 *     var root = wrap.closest('[data-lolly-canvas]');
 *     var commit = root && root.__lollyCommit;
 *     if (commit) commit('pos1', { x: 12, y: 34 });   // 1:1 — this canvas only
 *     else …legacy sidebar poke…                      // offscreen export / old shell
 *
 * `data-lolly-canvas` is set on the STABLE canvas container (it survives the
 * innerHTML swap each paint does), so a script may also park per-instance state
 * on that element instead of on `window.__*` globals that N instances stomp.
 */
import type { Runtime } from '../../../../engine/src/runtime.js';
import type { InputValue } from '../../../../engine/src/inputs.js';

export interface CanvasCommitEl extends HTMLElement {
  /** Commit `id`→`value` to the runtime that owns THIS canvas (1:1, never fanned). */
  __lollyCommit?: (id: string, value: InputValue) => void;
}

/**
 * Bind `canvasEl` to `runtime` so an interactive tool script mounted inside it
 * commits values 1:1 to that runtime. Call once when the canvas element is
 * created — the property (and the `data-lolly-canvas` marker) persist across the
 * innerHTML swaps each paint performs, so it never needs re-attaching per render.
 */
export function attachCanvasCommit(canvasEl: CanvasCommitEl, runtime: Runtime): void {
  canvasEl.dataset.lollyCanvas = '';
  canvasEl.__lollyCommit = (id, value) => { void runtime.setInput(id, value); };
}
