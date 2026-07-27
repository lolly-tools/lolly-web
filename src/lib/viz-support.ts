// SPDX-License-Identifier: MPL-2.0
/**
 * The visualizer's capability probe, deliberately alone in its own module with no
 * imports: the dock has to decide SYNCHRONOUSLY whether to render its visualizer
 * button, and everything else in the feature (butterchurn itself, the presets, the
 * palette derivation, the overlay chrome) should stay out of the main bundle until
 * someone actually presses it. Importing this costs nothing; importing the engine
 * wrapper would drag the whole graph in.
 */

let cached: boolean | null = null;

/**
 * Is a MilkDrop visualizer possible here? butterchurn 2.x is WebGL2-or-nothing —
 * a single `getContext('webgl2')` with no WebGL1 fallback path.
 *
 * `failIfMajorPerformanceCaveat` additionally rules out software rasterisers, where
 * a full-screen mesh render crawls badly enough to read as a broken feature rather
 * than a slow one. Cached: the answer can't change within a session, and creating
 * throwaway GL contexts to re-ask is not free.
 */
export function vizSupported(): boolean {
  if (cached !== null) return cached;
  if (typeof document === 'undefined') return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    cached = gl !== null;
  } catch {
    cached = false;
  }
  return cached;
}
