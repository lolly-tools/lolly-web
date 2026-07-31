// SPDX-License-Identifier: MPL-2.0
/**
 * The raster export path's default supersampling factor — ONE statement of it.
 *
 * `rasterStyle` (bridge/export.ts) renders a node at its native CSS size and
 * scales it up to the target resolution. When the caller requested NO dimension
 * the target is not the node box: it is the node box times this factor, so a
 * 600 x 600 tool with nothing typed in the size fields exports a 1200 x 1200 PNG.
 *
 * It lives in its own module, rather than beside `rasterStyle`, because the
 * PREFLIGHT collectors need it too — `pro/preflight-rows.ts` reports the pixel
 * count a batch row will actually produce, and importing `bridge/export.ts` for a
 * number would drag the whole DOM-bound export bridge into a headless pre-pass.
 * A second literal `2` is how preflight ends up stamping `bound: 'exact'` on a
 * count that is four times too small (`plans/preflight-and-cost.md` §6).
 */
export const RASTER_DEFAULT_SCALE = 2;
