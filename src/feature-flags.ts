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
import { orgFlagGovernance } from './org/index.ts';

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

// Jelly effects — flag-gated soft-body chrome controls (the vendored Jelly UI web
// components, see lib/jelly.ts). ON by default like every historic flag, so the
// plain `flagEnabled`/`flagEnabledSync` reads apply. Turning it off reverts the
// upgraded controls to the plain CSS primitives and skips loading the bundle.
export const JELLY_FLAG: FeatureFlag = {
  id: 'jelly-effects',
  label: 'Jelly effects',
  pill: 'squishy',
  info: 'Gives some controls a soft, springy feel, starting with the switches on this page. Follows your theme and brand colours, respects reduced-motion, and never touches tool output.',
};

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

// The standalone flags an OPTIONAL control plane may govern (default + visibility).
// Ids match the server's GOVERNABLE_FLAGS; category/Pro flags stay purely local.
export const GOVERNED_FLAG_IDS: readonly string[] = [NEUROSPICY_FLAG.id, JELLY_FLAG.id, STRIP_UPLOAD_META_FLAG.id];

/** Whether the control plane has hidden a flag's user-facing toggle (a staged
 *  surprise, or a policy the deployment owns). Dormant ⇒ false. The resolved
 *  state still applies via flagEnabled/isFlagOn — hiding only drops the switch. */
export function flagHidden(id: string): boolean {
  return orgFlagGovernance(id)?.hidden === true;
}

/** A flag is ON unless it has been explicitly turned off — but a control plane can
 *  set the default (applied when the user hasn't chosen) and, for a hidden flag,
 *  force its default regardless of any stored value. Dormant ⇒ historic behaviour. */
export function flagEnabled(profile: Profile | null | undefined, id: string): boolean {
  const gov = orgFlagGovernance(id);
  const saved = profile?.featureFlags?.[id];
  if (gov?.hidden) return gov.default ?? saved !== false;
  if (saved !== undefined) return saved;
  return gov?.default ?? true;
}

/** Default-aware read: honours a flag's `default` (opt-in flags start off) when the user
 *  hasn't set it, the control plane's default over that, and the saved value once the
 *  user has chosen — unless the control plane hides the flag, when its default wins. */
export function isFlagOn(profile: Profile | null | undefined, flag: FeatureFlag): boolean {
  const gov = orgFlagGovernance(flag.id);
  const builtin = flag.default !== false;
  const saved = profile?.featureFlags?.[flag.id];
  if (gov?.hidden) return gov.default ?? builtin;
  if (saved !== undefined) return saved;
  return gov?.default ?? builtin;
}

// A synchronous localStorage mirror of profile.featureFlags, so surfaces that render
// OUTSIDE the profile-aware views — the Sound control's Neurospicy player, shown in
// gallery/catalog/projects popovers — can gate on a flag without awaiting the profile.
// Hydrated from the profile at boot; kept in sync on each toggle. Defaults ON (like
// flagEnabled), so an unhydrated mirror still shows opt-out features.
const FLAG_MIRROR_KEY = 'lolly:featureFlags';
export function hydrateFeatureFlags(profile: Profile | null | undefined): void {
  // Bake control-plane governance into the mirror so the synchronous reads match
  // the default-aware ones: seed an unset governed flag with its instance default,
  // and force a hidden flag to its default (no user toggle can override it).
  const eff: Record<string, boolean> = { ...(profile?.featureFlags ?? {}) };
  for (const id of GOVERNED_FLAG_IDS) {
    const gov = orgFlagGovernance(id);
    if (!gov) continue;
    if (gov.hidden) { if (gov.default !== undefined) eff[id] = gov.default; }
    else if (eff[id] === undefined && gov.default !== undefined) eff[id] = gov.default;
  }
  try { localStorage.setItem(FLAG_MIRROR_KEY, JSON.stringify(eff)); } catch { /* best-effort */ }
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
