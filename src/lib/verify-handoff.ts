// SPDX-License-Identifier: MPL-2.0
/**
 * A one-shot, in-memory handoff of files to the Verify view (#/verify). The catalog
 * details "Check credentials" action prepares an asset's bytes here, then navigates to
 * Verify, which picks them up on mount and runs the same on-device C2PA check as a drop.
 *
 * In-memory (real File bytes, not a URL) so it works for user uploads whose object URLs
 * are ephemeral, and survives the hash navigation without leaking anything into the URL.
 * A `note` rides along to explain provenance the file itself can't (e.g. that Lolly
 * re-encoded the image on import, so a captured credential no longer binds byte-for-byte).
 */

export interface VerifyHandoff {
  files: File[];
  /** Optional context banner shown above the report (e.g. re-encoded-on-import caveat). */
  note?: string;
}

let pending: VerifyHandoff | null = null;

export function setPendingVerify(handoff: VerifyHandoff): void {
  pending = handoff;
}

/** Consume the pending handoff (single use — cleared on read). */
export function takePendingVerify(): VerifyHandoff | null {
  const p = pending;
  pending = null;
  return p;
}
