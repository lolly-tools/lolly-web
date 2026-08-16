// SPDX-License-Identifier: MPL-2.0
/**
 * Hidden tools - the user's "hide this tool from my gallery" overlay, the tool
 * twin of lib/asset-favourites.ts's hidden ASSETS. Hiding never uninstalls or
 * breaks deep links; it only removes the tile from the browse grids, behind the
 * "Show hidden tools" reveal box that sits last in the grid.
 *
 * Stored on the user PROFILE (`profile.hiddenTools`), like `favourites` - so it
 * persists across reloads AND travels in the portable backup / any future profile
 * sync. Utility VIEW cards (app routes, not tools) live in the same set under
 * their `view:<id>` namespaced key, mirroring how favourites stars them.
 */

import type { HostV1, Profile } from '@lolly-tools/core/host-v1';

type ProfileHost = HostV1 & { profile: { set(p: Profile): Promise<void> } };

/** The hidden tool ids (and `view:<id>` card keys) from the profile (empty if none). */
export function loadHiddenTools(profile: Profile | null | undefined): Set<string> {
  const list = profile?.hiddenTools;
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
}

/**
 * Write the hidden set back onto the profile and persist it. Mutates the passed
 * profile object (the same cached instance host.profile.get() returned) so later
 * reads see the change, then flushes via host.profile.set. Best-effort - a failed
 * write just means the hide doesn't survive a reload.
 */
export async function saveHiddenTools(host: ProfileHost, profile: Profile, hidden: Set<string>): Promise<void> {
  profile.hiddenTools = [...hidden];
  try { await host.profile.set(profile); } catch { /* storage off / quota - non-fatal */ }
}
