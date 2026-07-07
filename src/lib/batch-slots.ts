// SPDX-License-Identifier: MPL-2.0
/**
 * Canonical namespace prefix for batch-run "slots" persisted in host.state.
 * This literal + predicate were copy-pasted across pro/sessions, gallery,
 * profile, folder-tiles and folder-rows (finding #13). This leaf module (no
 * other imports, so it can't create an import cycle) is now the single source;
 * the others import or re-export it.
 */
export const BATCH_SLOT_PREFIX = '__batch__:';

export const isBatchSlot = (slot: unknown): boolean =>
  typeof slot === 'string' && slot.startsWith(BATCH_SLOT_PREFIX);
