// SPDX-License-Identifier: MPL-2.0
/**
 * The ONE place that decides whether a tool's export carries Content Credentials
 * by default — shared by the tool view's export sheet (views/tool-actions.ts) and
 * the offscreen batch/zip renderer (pro/render-export.ts), so a file rendered
 * through "Render selection" / "Download all" / the /pro grid is signed exactly
 * like the same file rendered with the tool's own Export button.
 *
 * Off by default only for:
 *  • on-device privacy utilities (their output is the user's OWN file and must
 *    never be stamped with provenance — validated invariant), and
 *  • a tool that explicitly opts out with render.c2pa:false.
 * A ?c2pa= link/save default (or an explicit caller option) still overrides this
 * at the call sites.
 */
import type { ToolManifest } from '../../../../engine/src/loader.js';

export function c2paDefaultOn(manifest: ToolManifest): boolean {
  return (manifest.render as { c2pa?: boolean }).c2pa !== false && manifest.privacy !== 'on-device';
}
