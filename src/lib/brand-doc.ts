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

type Rec = Record<string, unknown>;

export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
/** `{color.ramp.primary.5}` — a reference, not a literal colour. */
export const isAliasStr = (v: unknown): v is string => typeof v === 'string' && /^\{[^}]+\}$/.test(v.trim());
const isColorString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && (isAliasStr(v) || colorToHex(v) !== null);
const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(n => typeof n === 'number');
const isSpotColor = (v: unknown): v is SpotColor => {
  if (!isRec(v) || typeof v.name !== 'string') return false;
  if (v.book !== undefined && typeof v.book !== 'string') return false;
  return isNumberArray(v.cmyk) && v.cmyk.length === 4;
};

/** A swatch's print-export lock — exactly one of the two, never both (see
 *  setSwatchPrintOverride). Absent (null) means auto-convert from `$value` at export. */
export type PrintLock = { cmyk: [number, number, number, number] } | { spot: SpotColor };

/** Read whichever of `cmyk`/`spot` is present on a leaf's vendor extension, or null. */
function readPrintLock(leaf: Rec | null): PrintLock | null {
  const ext = leaf && isRec(leaf.$extensions) ? (leaf.$extensions as Rec)[TOKEN_EXT] : null;
  if (!isRec(ext)) return null;
  if (isSpotColor(ext.spot)) return { spot: ext.spot };
  if (isNumberArray(ext.cmyk) && ext.cmyk.length === 4) return { cmyk: ext.cmyk as [number, number, number, number] };
  return null;
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
  const walk = (node: unknown, path: string[]): void => {
    if (!isRec(node)) return;
    if (isColorString(node.$value)) {
      out.push(toSwatch(path, node.$value, node.$description, node.$extensions, resolve));
      return;
    }
    for (const k of Object.keys(node)) {
      if (k.startsWith('$')) continue;
      walk(node[k], [...path, k]);
    }
  };
  walk(doc, []);
  const multiSet = isRec(doc) && [...SET_KEYS].some(k => k in doc);
  if (!multiSet) return out;
  const wantSet = theme === 'dark' ? 'dark' : 'light';
  return out.filter(s => s.kind !== 'semantic' || s.set === wantSet);
}

function toSwatch(
  path: string[], raw: string, desc: unknown, extensions: unknown, resolve?: (key: string) => unknown,
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
  return {
    path, key, group,
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

/** The swatch at `path`'s pinned print override (CMYK or spot), or null when auto. */
export function getSwatchPrintOverride(doc: unknown, path: string[]): PrintLock | null {
  return readPrintLock(leafAt(doc, path));
}

/**
 * Lock (or clear, with null) the swatch at `path`'s print override. `cmyk` and
 * `spot` are mutually exclusive — setting one always removes the other, so a
 * token never carries both. Clearing (null) removes whichever is present, and
 * the whole `$extensions["com.suse.lolly"]` entry too once it's empty.
 */
export function setSwatchPrintOverride(doc: unknown, path: string[], override: PrintLock | null): boolean {
  const leaf = leafAt(doc, path);
  if (!leaf) return false;
  if (override === null) {
    const ext = isRec(leaf.$extensions) ? (leaf.$extensions as Rec) : null;
    if (ext && isRec(ext[TOKEN_EXT])) {
      delete (ext[TOKEN_EXT] as Rec).cmyk;
      delete (ext[TOKEN_EXT] as Rec).spot;
      if (Object.keys(ext[TOKEN_EXT] as Rec).length === 0) delete ext[TOKEN_EXT];
      if (Object.keys(ext).length === 0) delete leaf.$extensions;
    }
    return true;
  }
  const ext = (isRec(leaf.$extensions) ? leaf.$extensions : (leaf.$extensions = {} as Rec)) as Rec;
  const ns = (isRec(ext[TOKEN_EXT]) ? ext[TOKEN_EXT] : (ext[TOKEN_EXT] = {} as Rec)) as Rec;
  const clamp = (n: number): number => Math.round(Math.min(100, Math.max(0, n)));
  if ('spot' in override) {
    delete ns.cmyk;
    ns.spot = {
      name: override.spot.name,
      ...(override.spot.book ? { book: override.spot.book } : {}),
      cmyk: override.spot.cmyk.map(clamp),
    };
  } else {
    delete ns.spot;
    ns.cmyk = override.cmyk.map(clamp);
  }
  return true;
}

/**
 * Add a swatch under the `spectrum` or `custom` colour group, creating the group
 * (and `base.color`, on a multi-set doc) when absent so the very first custom
 * swatch has somewhere to live. Slugs collide-safely. Returns the new leaf's
 * JSON path so the caller can select it.
 */
export function addSwatch(doc: unknown, group: 'spectrum' | 'custom', name: string, hex: string): string[] | null {
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
  bucket[slug] = { $value: hex, $description: name.trim() || prettify(slug), $type: 'color' };
  return [...(multiSet ? ['base'] : []), 'color', group, slug];
}
