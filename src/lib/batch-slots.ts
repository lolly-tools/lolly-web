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

/**
 * Trash namespace (plans/133 WP-4): a deleted session's state record is MOVED
 * to `__trash__:<original slot>` instead of being removed, so it can be
 * restored. Every surface that lists sessions for the user (projects, gallery,
 * picker, /pro sessions, spotlight, folder overlay) must filter these out;
 * backup/export and slot-collision checks deliberately keep seeing them.
 */
export const TRASH_SLOT_PREFIX = '__trash__:';

export const isTrashedSlot = (slot: unknown): boolean =>
  typeof slot === 'string' && slot.startsWith(TRASH_SLOT_PREFIX);

/**
 * Project-template namespace (plans/133 WP-11a): a saved folder template keeps a
 * COPY of each member session's record at `__ptpl__:<template id>:<original slot>`.
 * Hidden from every session-listing surface exactly like the trash; instantiating
 * a template copies these back out under fresh slots.
 */
export const PTPL_SLOT_PREFIX = '__ptpl__:';

export const isTemplateSlot = (slot: unknown): boolean =>
  typeof slot === 'string' && slot.startsWith(PTPL_SLOT_PREFIX);

/** A slot no user-facing session list should show: trashed or template-held. */
export const isHiddenSlot = (slot: unknown): boolean => isTrashedSlot(slot) || isTemplateSlot(slot);
