// SPDX-License-Identifier: MPL-2.0
/**
 * Feature flags — local, per-user toggles that tailor the gallery.
 *
 * Stored on the profile (`profile.featureFlags`, keyed by flag id) so they ride
 * the normal profile persistence and sync. Every flag defaults to ON when unset.
 *
 * Two kinds:
 *  - CATEGORY_FLAGS hide a tool-category section from the gallery (nothing else).
 *  - PRO_FLAG hides the "Batch" link in the gallery footer (the /pro route itself
 *    still works via a deep link).
 */

import type { Profile } from '../../../engine/src/bridge/host-v1.ts';

export interface FeatureFlag {
  id: string;
  label: string;
  /** The gallery `category` this flag shows/hides (category flags only). */
  category?: string;
  /** Small badge shown beside the label in the profile view. */
  pill?: string;
  /** Default state when the user hasn't set it. Omitted ⇒ ON (the historic default for
   *  every flag). Set `false` for opt-IN flags that should start off. */
  default?: boolean;
  /** Optional explainer, surfaced via a small (i) icon beside the flag in the profile. */
  info?: string;
}

// label → the gallery `category` it shows/hides. (Categories live in tool.json.)
export const CATEGORY_FLAGS: readonly FeatureFlag[] = [
  { id: 'cat-everyone',  label: 'Tools for Everyone', category: 'everyone' },
  { id: 'cat-designer',  label: 'Designer Tools',     category: 'designer' },
  { id: 'cat-event',     label: 'Event Kit',          category: 'event'    },
  // id stays 'cat-developer' (a persisted key); only the user-facing label changed.
  { id: 'cat-developer', label: 'Offline Utilities',  category: 'utility'  },
];

export const PRO_FLAG: FeatureFlag = { id: 'pro-batch', label: 'Pro', pill: 'batch mode' };

// Standalone feature toggles (not a gallery category, not Pro). Neurospicy Mode —
// the background focus-music player — is opt-out here (ON by default like every flag).
export const NEUROSPICY_FLAG: FeatureFlag = { id: 'neurospicy', label: 'Neurospicy Mode', pill: 'focus music' };

// Opt-IN (default OFF): strip EXIF/XMP/GPS from images uploaded to the catalog. C2PA
// content credentials are ALWAYS preserved regardless — this only governs other metadata.
// Read by the upload pipeline (views/picker.ts storeUserUpload).
export const STRIP_UPLOAD_META_FLAG: FeatureFlag = {
  id: 'strip-upload-metadata',
  label: 'Strip metadata from uploads',
  pill: 'privacy',
  default: false,
  info: 'Removes EXIF, location (GPS) and other embedded metadata from images you upload. Content Credentials (C2PA provenance) are always preserved — a signed or AI-generated image keeps its credential either way.',
};

/** A flag is ON unless it has been explicitly turned off (the default for every flag). */
export function flagEnabled(profile: Profile | null | undefined, id: string): boolean {
  return profile?.featureFlags?.[id] !== false;
}

/** Default-aware read: honours a flag's `default` (opt-in flags start off) when the user
 *  hasn't set it, and the saved value once they have. Prefer this when a flag isn't the
 *  historic "ON unless off" kind. */
export function isFlagOn(profile: Profile | null | undefined, flag: FeatureFlag): boolean {
  const saved = profile?.featureFlags?.[flag.id];
  return saved === undefined ? flag.default !== false : saved;
}

// A synchronous localStorage mirror of profile.featureFlags, so surfaces that render
// OUTSIDE the profile-aware views — the Sound control's Neurospicy player, shown in
// gallery/catalog/projects popovers — can gate on a flag without awaiting the profile.
// Hydrated from the profile at boot; kept in sync on each toggle. Defaults ON (like
// flagEnabled), so an unhydrated mirror still shows opt-out features.
const FLAG_MIRROR_KEY = 'lolly:featureFlags';
export function hydrateFeatureFlags(profile: Profile | null | undefined): void {
  try { localStorage.setItem(FLAG_MIRROR_KEY, JSON.stringify(profile?.featureFlags ?? {})); } catch { /* best-effort */ }
}
export function flagEnabledSync(id: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(FLAG_MIRROR_KEY) || '{}') as Record<string, boolean>)[id] !== false;
  } catch { return true; }
}
export function setFlagMirror(id: string, on: boolean): void {
  try {
    const m = JSON.parse(localStorage.getItem(FLAG_MIRROR_KEY) || '{}') as Record<string, boolean>;
    m[id] = on;
    localStorage.setItem(FLAG_MIRROR_KEY, JSON.stringify(m));
  } catch { /* best-effort */ }
}

/** Set of gallery categories to hide, given the profile's current flags. */
export function hiddenCategories(profile: Profile | null | undefined): Set<string | undefined> {
  return new Set(
    CATEGORY_FLAGS.filter(f => !flagEnabled(profile, f.id)).map(f => f.category),
  );
}
