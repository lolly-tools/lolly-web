// SPDX-License-Identifier: MPL-2.0
/**
 * Brand document surgery — the pure, DOM-free half of the brand editor.
 *
 * The editor treats the installed DTCG document (host.tokens.raw()) as the
 * single source of truth for the palette: every colour leaf is a swatch, and
 * "recolour / rename / delete / add" are just writes to that document, which is
 * then re-installed wholesale through installUserTokens.
 *
 * Everything here is a pure function over a plain object so it can be unit
 * tested without a browser (see brand-doc.test.ts). Nothing in this module
 * imports the DOM, the bridge, or any component.
 *
 * Shape notes: a derived brand (engine deriveBrandTokens) is multi-set —
 * `base` holds the ramps + spectrum, and `light` / `dark` each hold the seven
 * `color.semantic.*` ROLES, which are `{alias}` references into the ramps. An
 * imported Tokens-Studio/W3C export may be single-set with colour leaves at any
 * depth, so the walker addresses leaves by JSON key path rather than assuming
 * a fixed layout.
 */

import { colorToHex, TOKEN_EXT } from '@lolly/engine';
import type { SpotColor } from '../../../../engine/src/bridge/host-v1.ts';
// The exclusion READ lives in a leaf module so the boot-path tokens bridge can
// filter excluded swatches without importing this (engine-barrel-heavy) file;
// re-exported here so studio callers keep their single brand-doc import.
import { getExcludedSwatches } from './brand-exclusions.ts';
export { getExcludedSwatches };

type Rec = Record<string, unknown>;

export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
/** `{color.ramp.primary.5}` — a reference, not a literal colour. */
export const isAliasStr = (v: unknown): v is string => typeof v === 'string' && /^\{[^}]+\}$/.test(v.trim());
const isColorString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && (isAliasStr(v) || colorToHex(v) !== null);
const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(n => typeof n === 'number');
const isSpotColor = (v: unknown): v is SpotColor => {
  if (!isRec(v) || typeof v.name !== 'string') return false;
  return v.book === undefined || typeof v.book === 'string';
};

/** A swatch's print-export lock. `cmyk` and `spot` are independent — a token
 *  may carry either, both, or neither (absent fields, not present at all, when
 *  not locked): `cmyk` is the process-colour fallback used for preview,
 *  non-PDF export, and the Separation alternate-space value regardless of
 *  whether a spot is also set, so locking a named ink never discards a
 *  separately-tuned CMYK build. Absent entirely means auto-convert from
 *  `$value` at export. */
export type PrintLock = { cmyk?: [number, number, number, number]; spot?: SpotColor };

/** Read whichever of `cmyk`/`spot` are present on a leaf's vendor extension, or
 *  null if neither is. */
function readPrintLock(leaf: Rec | null): PrintLock | null {
  const ext = leaf && isRec(leaf.$extensions) ? (leaf.$extensions as Rec)[TOKEN_EXT] : null;
  if (!isRec(ext)) return null;
  const lock: PrintLock = {};
  if (isNumberArray(ext.cmyk) && ext.cmyk.length === 4) lock.cmyk = ext.cmyk as [number, number, number, number];
  if (isSpotColor(ext.spot)) lock.spot = ext.spot;
  return lock.cmyk || lock.spot ? lock : null;
}

export const prettify = (s: string): string => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Top-level DTCG token sets a derived brand uses. */
const SET_KEYS = new Set(['base', 'light', 'dark']);

/** One editable colour leaf, located in the raw doc. */
export interface BrandSwatch {
  /** JSON key path to the leaf group (the object holding `$value`). */
  path: string[];
  /** Canonical dotted token key, set prefix stripped (`color.ramp.primary.5`). */
  key: string;
  /** Display bucket: a ramp family, `Spectrum`, `Custom`, or `Roles · Light`. */
  group: string;
  /** Label shown on the tile ($description, else a prettified leaf key). */
  name: string;
  /** The stored `$value` — may be an `oklch()` string or a `{alias}`. */
  raw: string;
  /** Resolved sRGB hex for the tile ('' when it can't be resolved, e.g. an alias). */
  hex: string;
  isAlias: boolean;
  kind: 'ramp' | 'spectrum' | 'custom' | 'semantic' | 'other';
  /** Top-level set (base/light/dark) when the doc is multi-set, else null. */
  set: string | null;
  /** Only swatches the user owns are removable; ramps + roles are structural. */
  deletable: boolean;
  /** Pinned print-export value (CMYK or spot), or null when auto-converted from `hex`. */
  lock: PrintLock | null;
}

/**
 * Every colour leaf in `doc`, in document order.
 *
 * A semantic ROLE exists once per theme set, so a multi-set doc would otherwise
 * surface `primary`/`surface`/… twice. `theme` picks which set's roles to show
 * (defaulting to light); ramps + spectrum live in `base` and are always shown.
 *
 * `resolve` (the caller's TokenSet, typically) supplies the displayable colour
 * for leaves whose `$value` is an `{alias}` — every semantic role is one, so
 * without it those tiles would render blank. It is optional so this module stays
 * pure and unit-testable.
 */
export function walkSwatches(
  doc: unknown, theme = 'light', resolve?: (key: string) => unknown,
): BrandSwatch[] {
  const out: BrandSwatch[] = [];
  const multiSet = isRec(doc) && [...SET_KEYS].some(k => k in doc);
  const wantSet = theme === 'dark' ? 'dark' : 'light';
  // Where a custom swatch tagged "Roles" files: the CURRENT theme's Roles
  // section. The tag is stored theme-less by contract — a persisted
  // "Roles · Light" would strand the swatch under a phantom stale-theme
  // section the moment the app theme flips (toSwatch tolerates legacy
  // suffixed tags by mapping them here too).
  const rolesGroup = `Roles · ${multiSet ? prettify(wantSet) : 'Theme'}`;
  const walk = (node: unknown, path: string[]): void => {
    if (!isRec(node)) return;
    if (isColorString(node.$value)) {
      out.push(toSwatch(path, node.$value, node.$description, node.$extensions, resolve, rolesGroup));
      return;
    }
    for (const k of Object.keys(node)) {
      if (k.startsWith('$')) continue;
      walk(node[k], [...path, k]);
    }
  };
  walk(doc, []);
  if (!multiSet) return out;
  return out.filter(s => s.kind !== 'semantic' || s.set === wantSet);
}

function toSwatch(
  path: string[], raw: string, desc: unknown, extensions: unknown,
  resolve?: (key: string) => unknown, rolesGroup?: string,
): BrandSwatch {
  const set = SET_KEYS.has(path[0] ?? '') ? path[0]! : null;
  const rest = set ? path.slice(1) : path;
  const key = (rest[0] === 'color' ? rest : ['color', ...rest]).join('.');
  const leaf = path[path.length - 1] ?? '';
  const at = (seg: string): number => path.indexOf(seg);
  let kind: BrandSwatch['kind'] = 'other';
  let group = prettify(path[path.length - 2] ?? 'Colour');
  let deletable = true;
  if (at('ramp') >= 0) {
    // Ramp steps (primary/neutral/secondary shades) are user-deletable — the shade
    // count is theirs to shape (a semantic role aliasing a deleted step just falls
    // back to a blank chip until re-derived, same as any dangling alias).
    kind = 'ramp'; deletable = true;
    group = prettify(path[at('ramp') + 1] ?? 'Ramp');
  } else if (at('spectrum') >= 0) { kind = 'spectrum'; group = 'Spectrum'; }
  else if (at('custom') >= 0) { kind = 'custom'; group = 'Custom'; }
  else if (at('semantic') >= 0) {
    kind = 'semantic'; deletable = false;
    group = `Roles · ${set ? prettify(set) : 'Theme'}`;
  }
  const isAlias = isAliasStr(raw);
  // A literal resolves directly; an {alias} needs the caller's token set (a role
  // otherwise has no colour of its own to show).
  let hex = colorToHex(raw) ?? '';
  if (!hex && isAlias && resolve) {
    try { hex = colorToHex(resolve(key)) ?? ''; } catch { /* unresolvable → blank chip */ }
  }
  // A per-group "+ Add" on a derived section (Primary/Neutral/…) creates a
  // CUSTOM swatch tagged with that section's heading (addSwatch's displayGroup)
  // — the tag only relabels where the tile renders, never what the token is.
  const extNs = isRec(extensions) ? (extensions as Rec)[TOKEN_EXT] : null;
  let groupTag = isRec(extNs) && typeof (extNs as Rec).group === 'string' ? String((extNs as Rec).group) : null;
  // A "Roles" tag means "the current theme's Roles section", never a section
  // of its own — the walker passes the live label (a legacy theme-suffixed
  // "Roles · Light" tag maps there too, instead of stranding the swatch under
  // a stale-theme heading with its own duplicate + Add).
  if (groupTag && /^roles(\s*·.*)?$/i.test(groupTag)) groupTag = rolesGroup ?? groupTag;
  return {
    path, key, group: groupTag || group,
    name: typeof desc === 'string' && desc ? desc : prettify(leaf),
    raw, hex, isAlias, kind, set, deletable,
    lock: readPrintLock({ $extensions: extensions } as Rec),
  };
}

/** The object at a JSON key path, or null. */
export function leafAt(doc: unknown, path: string[]): Rec | null {
  let node: unknown = doc;
  for (const seg of path) { if (!isRec(node)) return null; node = node[seg]; }
  return isRec(node) ? node : null;
}

/** Recolour a swatch. Writing a literal detaches an `{alias}` role from its ramp. */
export function setSwatchValue(doc: unknown, path: string[], hex: string): boolean {
  const leaf = leafAt(doc, path);
  if (!leaf) return false;
  leaf.$value = hex;
  return true;
}

/** Rename a swatch (its `$description` — the label pickers show). */
export function setSwatchName(doc: unknown, path: string[], name: string): boolean {
  const leaf = leafAt(doc, path);
  if (!leaf) return false;
  const t = name.trim();
  if (t) leaf.$description = t; else delete leaf.$description;
  return true;
}

/** Remove a swatch from its parent group. */
export function deleteSwatch(doc: unknown, path: string[]): boolean {
  const parent = leafAt(doc, path.slice(0, -1));
  const leaf = path[path.length - 1];
  if (!parent || leaf === undefined || !(leaf in parent)) return false;
  delete parent[leaf];
  return true;
}

/**
 * Point `color.semantic.<role>` (both the light and dark sets, when present) at
 * a different ramp step — how the brand editor's neutral/secondary swatch
 * picker overrides a fresh `deriveBrandTokens` doc before install. `secondary`
 * already carries such an alias (the engine hardcodes step 5); `neutral` has no
 * slot of its own today, so this simply adds one, in the same shape.
 */
export function setSemanticRampAlias(doc: unknown, role: 'neutral' | 'secondary', step: number): void {
  if (!isRec(doc)) return;
  for (const set of ['light', 'dark']) {
    const semantic = leafAt(doc, [set, 'color', 'semantic']);
    if (semantic) semantic[role] = { $value: `{color.ramp.${role}.${step}}` };
  }
}

// ── Print (CMYK / spot) override — any swatch ────────────────────────────────
// "Auto-convert until you lock one": a swatch's screen colour ($value) is the
// source of truth (sRGB/OKLCH), and print/PDF-CMYK export auto-converts it —
// UNLESS a print value is locked here, which the export palette then substitutes
// exactly. The lock rides in the DTCG `$extensions` vendor namespace (TOKEN_EXT)
// as EITHER `cmyk` (a plain process-ink anchor) OR `spot` (a named spot/Pantone
// colour with a CMYK equivalent for preview/fallback) — never both; setting one
// clears the other. tokens.colors() already surfaces both as `.cmyk`/`.spot`,
// which the CMYK export and the Separation tint-transform's alternate space read.

/** JSON path to the primary ramp's anchor swatch — the MIDDLE step (the brand
 *  colour), computed from however many steps the ramp carries (5 on a 9-step
 *  ramp, 3 on a 5-step ramp; = the engine's `at(0.5)`). Null if absent. A
 *  re-derive rebuilds the ramp, so the editor re-applies its lock after deriving. */
export function primaryAnchorPath(doc: unknown): string[] | null {
  const multiSet = isRec(doc) && [...SET_KEYS].some(k => k in doc);
  const groupPath = multiSet ? ['base', 'color', 'ramp', 'primary'] : ['color', 'ramp', 'primary'];
  const group = leafAt(doc, groupPath);
  if (!group) return null;
  const steps = Object.keys(group).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
  if (!steps.length) return null;
  const anchor = Math.round((steps.length - 1) / 2) + 1;
  const step = steps.includes(anchor) ? anchor : steps[Math.floor(steps.length / 2)]!;
  return [...groupPath, String(step)];
}

/** The swatch at `path`'s pinned print lock (cmyk and/or spot), or null when
 *  neither is set. */
export function getSwatchPrintOverride(doc: unknown, path: string[]): PrintLock | null {
  return readPrintLock(leafAt(doc, path));
}

/** Deletes the vendor extension entry once both `cmyk` and `spot` are gone,
 *  and `$extensions` itself once it's the only thing left in it. */
function cleanupExt(leaf: Rec): void {
  const ext = isRec(leaf.$extensions) ? (leaf.$extensions as Rec) : null;
  if (!ext || !isRec(ext[TOKEN_EXT])) return;
  if (Object.keys(ext[TOKEN_EXT] as Rec).length === 0) delete ext[TOKEN_EXT];
  if (Object.keys(ext).length === 0) delete leaf.$extensions;
}

/** Lock (or clear, with null) the swatch at `path`'s process-CMYK print value.
 *  Independent of `setSwatchSpotLock` — locking or clearing one never touches
 *  the other, so a token can carry a CMYK fallback alongside a spot lock. */
export function setSwatchCmykLock(doc: unknown, path: string[], cmyk: [number, number, number, number] | null): boolean {
  const leaf = leafAt(doc, path);
  if (!leaf) return false;
  if (cmyk === null) {
    const ext = isRec(leaf.$extensions) ? (leaf.$extensions as Rec) : null;
    if (ext && isRec(ext[TOKEN_EXT])) { delete (ext[TOKEN_EXT] as Rec).cmyk; cleanupExt(leaf); }
    return true;
  }
  const ext = (isRec(leaf.$extensions) ? leaf.$extensions : (leaf.$extensions = {} as Rec)) as Rec;
  const ns = (isRec(ext[TOKEN_EXT]) ? ext[TOKEN_EXT] : (ext[TOKEN_EXT] = {} as Rec)) as Rec;
  const clamp = (n: number): number => Math.round(Math.min(100, Math.max(0, n)));
  ns.cmyk = cmyk.map(clamp);
  return true;
}

/** Lock (or clear, with null) the swatch at `path`'s named spot/Pantone ink.
 *  Independent of `setSwatchCmykLock` (see its doc comment). */
export function setSwatchSpotLock(doc: unknown, path: string[], spot: SpotColor | null): boolean {
  const leaf = leafAt(doc, path);
  if (!leaf) return false;
  if (spot === null) {
    const ext = isRec(leaf.$extensions) ? (leaf.$extensions as Rec) : null;
    if (ext && isRec(ext[TOKEN_EXT])) { delete (ext[TOKEN_EXT] as Rec).spot; cleanupExt(leaf); }
    return true;
  }
  const ext = (isRec(leaf.$extensions) ? leaf.$extensions : (leaf.$extensions = {} as Rec)) as Rec;
  const ns = (isRec(ext[TOKEN_EXT]) ? ext[TOKEN_EXT] : (ext[TOKEN_EXT] = {} as Rec)) as Rec;
  ns.spot = { name: spot.name, ...(spot.book ? { book: spot.book } : {}) };
  return true;
}

/**
 * Add a swatch under the `spectrum` or `custom` colour group, creating the group
 * (and `base.color`, on a multi-set doc) when absent so the very first custom
 * swatch has somewhere to live. Slugs collide-safely. Returns the new leaf's
 * JSON path so the caller can select it.
 *
 * `displayGroup` tags the new leaf's vendor extension with a section heading —
 * how a per-group "+ Add" on a derived section (Primary/Neutral/Roles…) files a
 * CUSTOM swatch under that heading in the palette grid without pretending it's
 * a derived step (walkSwatches reads the tag back as the swatch's `group`).
 */
export function addSwatch(
  doc: unknown, group: 'spectrum' | 'custom', name: string, hex: string,
  opts: { displayGroup?: string } = {},
): string[] | null {
  if (!isRec(doc)) return null;
  const multiSet = [...SET_KEYS].some(k => k in doc);
  const base = multiSet
    ? (isRec(doc.base) ? doc.base : (doc.base = {} as Rec)) as Rec
    : doc;
  const color = (isRec(base.color) ? base.color : (base.color = { $type: 'color' } as Rec)) as Rec;
  if (!('$type' in color)) color.$type = 'color';
  const bucket = (isRec(color[group]) ? color[group] : (color[group] = {} as Rec)) as Rec;

  const slugBase = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'swatch';
  let slug = slugBase;
  for (let i = 2; slug in bucket; i++) slug = `${slugBase}-${i}`;
  bucket[slug] = {
    $value: hex, $description: name.trim() || prettify(slug), $type: 'color',
    ...(opts.displayGroup ? { $extensions: { [TOKEN_EXT]: { group: opts.displayGroup } } } : {}),
  };
  return [...(multiSet ? ['base'] : []), 'color', group, slug];
}

// ── Swatch exclusions — "delete" for derived leaves ──────────────────────────
// Derived ramp steps (and the theme roles) are structural: the ramp stays
// derived, so deleting one from the palette means HIDING it, not removing the
// token. The exclusion list is the doc-level `$extensions` vendor entry
// `excluded` — an array of canonical swatch keys (`color.ramp.primary.2`).
// Excluded swatches disappear from the palette grid + picker swatches, while
// the tokens keep resolving (semantic roles and gradient aliases that point at
// an excluded step never dangle). A re-derive carries the list forward but
// clears entries whose step no longer exists (see the editor's derive flow).

/** Add (or, with `excluded: false`, remove) a swatch key on the exclusion list.
 *  An emptied list cleans its `$extensions` entry away entirely. */
export function setSwatchExcluded(doc: unknown, key: string, excluded: boolean): boolean {
  if (!isRec(doc)) return false;
  const cur = getExcludedSwatches(doc);
  const next = excluded ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter(k => k !== key);
  if (!next.length) {
    const ext = isRec(doc.$extensions) ? (doc.$extensions as Rec) : null;
    if (ext && isRec(ext[TOKEN_EXT])) { delete (ext[TOKEN_EXT] as Rec).excluded; cleanupExt(doc); }
    return true;
  }
  const ext = (isRec(doc.$extensions) ? doc.$extensions : (doc.$extensions = {} as Rec)) as Rec;
  const ns = (isRec(ext[TOKEN_EXT]) ? ext[TOKEN_EXT] : (ext[TOKEN_EXT] = {} as Rec)) as Rec;
  ns.excluded = next;
  return true;
}
