// SPDX-License-Identifier: MPL-2.0
/**
 * Leaving an instance - the covenant's exit, client side, in one place.
 *
 * Enrollment is a nomination and exit is unilateral: the person leaves without
 * asking, and what the ORGANISATION supplied leaves with them - its brand
 * pack (and the tools it installed), its cached org-config and policy, the
 * install identity this device spoke while enrolled, and the native-shell
 * session pair. What the PERSON made stays: sessions, images, profile,
 * preferences and any tool they sideloaded themselves are untouched (a
 * sideload was their own act - installed-tools records no per-instance
 * origin, and guessing would delete someone's work).
 *
 * The install id is cleared rather than kept, deliberately: a device that
 * re-enrolls later returns as a NEW install, so no identity carries across
 * enrollments. The instance keeps everything that was saved TO it - that
 * surrender happened continuously while enrolled, and needs nothing here.
 *
 * Ordering matters: every cache keyed by the CURRENT base (org-config caches,
 * the pack store's catalog paths) is cleared before the base itself moves.
 */
import { getInstanceBase, setInstanceBase, clearInstallId, setInstanceSession } from './instance.ts';
import { clearInstancePack } from './pack-store.ts';

/** Remove the org's ingredients and point the shell back at what is bundled.
 *  Callers re-sync the catalog and remount afterwards (same contract as
 *  setInstanceBase). Best-effort throughout - a failed cache delete must not
 *  strand the person on an instance they asked to leave. */
export async function leaveInstance(): Promise<void> {
  const scope = getInstanceBase() || 'same-origin';
  // The org seam's per-base caches (org/index.ts owns these keys; the shapes
  // are stable contracts there - absent entries are a no-op here).
  try {
    localStorage.removeItem(`lolly:org-absent:${scope}`);
    localStorage.removeItem(`lolly:org-config:${scope}`);
  } catch { /* storage unavailable - the caches expire on their own TTLs */ }
  // The install identity and the native-shell session: this device stops
  // speaking for the org entirely, and returns fresh if it ever comes back.
  await clearInstallId();
  await setInstanceSession(null);
  // The org's pack - brand catalog overlay plus every tool the pack installed.
  await clearInstancePack().catch(() => { /* no pack loaded - nothing to clear */ });
  // Last: the base itself (also drops the sbt-* catalog caches; see instance.ts).
  await setInstanceBase(null);
}
