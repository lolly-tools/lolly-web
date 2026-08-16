// SPDX-License-Identifier: MPL-2.0
/**
 * Roles as an assignment layer (plan 97 section 7.1).
 *
 * A role is a SLOT, not a colour. Primary, Secondary, Surface and Text are
 * satisfied by pointing `color.semantic.<role>` at a swatch that already exists
 * in the palette, and a design system with three loose colours and no roles at
 * all is valid - nothing here ever invents a swatch, and nothing forces a slot
 * to be filled.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It writes the one slot it is asked
 * to write, and nothing else. `deriveBrandTokens` maintains `on-primary`,
 * `muted` and `edge` as a contrast-enforced SET (see engine/brand-derive.ts's
 * buildSemantic: the primary step itself shifts along its ramp until a passing
 * on-primary exists), and `setSemanticRampAlias` in brand-doc.ts - the only
 * other role write in the shell - likewise touches exactly the named role. So
 * assigning Primary here does not re-pick on-primary: re-deriving those pairs
 * from one hand-assigned swatch would be new policy, and the readouts below
 * exist precisely so a pairing the user has broken is VISIBLE rather than
 * silently corrected. Regenerating the derived set is what the Generate wing's
 * Replace-palette path is for.
 *
 * Pure and DOM-free down to `roleContrast`; `rolesStripHtml` is a pure string
 * builder over a model, and `mountRolesStrip` is the only part that touches the
 * DOM. That split is what lets the readouts be unit-tested headless.
 *
 * Contrast is reported APCA-first, WCAG second (house rule): the Lc and its band
 * are the readout, the 2.1 ratio rides the tooltip.
 */

import { colorToHex, contrastRatio, apcaVerdict, tokenSetNames, TOKEN_EXT } from '@lolly/engine';
import type { ApcaUse } from '@lolly/engine';
import { escape } from '../../utils.ts';
import { t, tRaw } from '../../i18n.ts';

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{color.ramp.primary.5}` - a reference, not a literal colour. Kept in step
 *  with brand-doc.ts's `isAliasStr` (the same one-line test, duplicated rather
 *  than imported so this module stays free of the editor's doc surgery). */
const aliasTarget = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const m = /^\{([^}]+)\}$/.exec(v.trim());
  return m ? m[1]!.trim() : null;
};

/** The four assignable slots, in strip order. */
export type RoleId = 'primary' | 'secondary' | 'surface' | 'text';
export const ROLE_IDS: readonly RoleId[] = ['primary', 'secondary', 'surface', 'text'];

const isRoleId = (v: unknown): v is RoleId => ROLE_IDS.includes(v as RoleId);

/** The role's name as the strip shows it. Called per render, never cached at
 *  module scope, so a language switch repaints correctly. */
export function roleLabel(id: RoleId): string {
  switch (id) {
    case 'primary': return t('Primary');
    case 'secondary': return t('Secondary');
    case 'surface': return t('Surface');
    case 'text': return t('Text');
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Top-level DTCG token sets a derived document uses (brand-doc.ts's SET_KEYS). */
const SET_KEYS = ['base', 'light', 'dark'] as const;

/**
 * The document's top-level token sets, or `[]` when it is flat.
 *
 * The ENGINE decides whether a document is layered at all - `tokenSetNames`,
 * the same test `withRoleAliases` and `createTokenSet` consult. Nothing here may
 * answer that question on its own, in either direction:
 *
 *  - Saying "flat" of a layered one was the first bug. A Tokens-Studio or Penpot
 *    export names its sets whatever the designer likes (`Global`, plus the
 *    `Lolly roles` set the install path creates), so a name check against three
 *    fixed keys read every one of those as flat and sent every read and write to
 *    a root with no `color` group at all.
 *  - Saying "layered" of a flat one is the same bug wearing the other face. A
 *    hand-written `{ base: {…} }` with no `$metadata` and no `$themes` is FLAT
 *    to the engine - `base` is just a group. Trusting the name there wrote a
 *    role into `base.color.semantic.*`, reported success, and left a reference
 *    the resolver cannot see.
 *
 * Once the engine says layered, `base`/`light`/`dark` are answered by name: that
 * IS the derived shape, and naming them keeps a stray extra top-level group out
 * of the theme handling below.
 */
function setKeysOf(doc: Rec): string[] {
  const names = tokenSetNames(doc);
  if (!names) return [];
  const known = SET_KEYS.filter(k => isRec(doc[k]));
  return known.length ? known : names;
}

/**
 * Which ONE set of a layered non-themed document owns the roles, in order of
 * preference: the set that already carries a `color.semantic` group (that IS
 * the answer - it is where `withRoleAliases` put them); else the last set in the
 * resolution order that has a `color` group at all (last wins, so a role written
 * there overrides the sets below it, and a set of spacing tokens is no place for
 * one); else the last set in the order.
 */
function roleSetOf(doc: Rec, keys: string[]): string {
  for (const k of keys) if (at(doc, [k, 'color', 'semantic'])) return k;
  const meta = isRec(doc.$metadata) ? doc.$metadata : null;
  const ordered = meta && Array.isArray(meta.tokenSetOrder)
    ? meta.tokenSetOrder.filter((s): s is string => typeof s === 'string' && keys.includes(s))
    : [];
  const order = ordered.length ? ordered : keys;
  for (let i = order.length - 1; i >= 0; i--) { const k = order[i]!; if (at(doc, [k, 'color'])) return k; }
  return order[order.length - 1]!;
}

/**
 * Which sets a role write lands in, and a read looks at.
 *
 * A derived document carries the roles once per THEME, and the two are
 * deliberately different - `deriveBrandTokens` inverts surface and text so the
 * dark theme's surface is the darkest neutral where the light theme's is the
 * lightest. So a themed document ALWAYS reads one theme, and a write names the
 * theme it is editing: writing both sets from a light-theme strip would replace
 * the dark theme's inverted role with the light one and destroy dark mode.
 *
 * `theme` omitted means "every theme set" - the deliberate both-themes write,
 * used where a value genuinely is theme-invariant (the brand primary a logo
 * hands over). It is not a default to reach for from a themed UI.
 *
 * A layered import (Tokens-Studio / Penpot) has no light/dark sets of ours: its
 * roles live in one set (see {@link roleSetOf}). A flat document keeps them at
 * the root, addressed as the empty prefix.
 */
function roleSets(doc: unknown, theme?: string): string[][] {
  if (!isRec(doc)) return [[]];
  const keys = setKeysOf(doc);
  if (!keys.length) return [[]];
  const themed = keys.filter((k): k is 'light' | 'dark' => k === 'light' || k === 'dark');
  if (!themed.length) return [[roleSetOf(doc, keys)]];
  if (theme) {
    const want = theme === 'dark' ? 'dark' : 'light';
    return [[themed.find(k => k === want) ?? themed[0]!]];
  }
  return themed.map(k => [k]);
}

/** The object at a JSON key path, or null. */
function at(doc: unknown, path: string[]): Rec | null {
  let node: unknown = doc;
  for (const seg of path) { if (!isRec(node)) return null; node = node[seg]; }
  return isRec(node) ? node : null;
}

/** One role's current state in one theme. */
export interface RoleState {
  /** The dotted swatch key this role points at, or null when it holds a literal
   *  colour or is not set at all. */
  ref: string | null;
  /** Resolved sRGB hex, '' when the role is unset or its alias cannot resolve. */
  hex: string;
  /** True when the slot holds a colour of its own rather than a reference. */
  literal: boolean;
}

const UNSET: RoleState = { ref: null, hex: '', literal: false };

/**
 * Read one semantic slot's raw `$value` from the theme's set. Not exported: the
 * strip only ever needs the four assignable roles plus the pairing colours,
 * both of which go through the wrappers below.
 */
function slotValue(doc: unknown, theme: string, slot: string): unknown {
  const [prefix] = roleSets(doc, theme);
  const semantic = at(doc, [...(prefix ?? []), 'color', 'semantic']);
  const leaf = semantic && isRec(semantic[slot]) ? semantic[slot] as Rec : null;
  return leaf ? leaf.$value : undefined;
}

/**
 * Resolve a slot's `$value` to hex.
 *
 * A literal reads directly. An `{alias}` needs the caller's token set: try the
 * ROLE's own key first (what `walkSwatches` does, so a `createTokenSet` resolver
 * behaves identically here), then the alias target, so a bare doc + a shallow
 * resolver still lands a colour.
 */
function hexOfSlot(raw: unknown, slot: string, resolve?: (key: string) => unknown): string {
  if (raw === undefined) return '';
  const direct = colorToHex(raw);
  if (typeof direct === 'string' && direct.startsWith('#')) return direct;
  const ref = aliasTarget(raw);
  if (!ref || !resolve) return '';
  for (const key of [`color.semantic.${slot}`, ref]) {
    try {
      const got = colorToHex(resolve(key));
      if (typeof got === 'string' && got.startsWith('#')) return got;
    } catch { /* unresolvable → keep looking, then blank */ }
  }
  return '';
}

/** One slot's resolved hex ('' when absent/unresolvable) - the pairing colours
 *  (`on-primary`, `text`, `surface`) read through this. */
function semanticHex(doc: unknown, theme: string, slot: string, resolve?: (key: string) => unknown): string {
  return hexOfSlot(slotValue(doc, theme, slot), slot, resolve);
}

/**
 * Every assignable role's current target, for one theme.
 *
 * `resolve` supplies the colour for an `{alias}` exactly as `walkSwatches` does,
 * so this module stays pure: without it a role that references a ramp step reads
 * back with its `ref` intact and a blank `hex`.
 *
 * An unset role is `{ ref: null, hex: '', literal: false }` - which is how "not
 * set" is told apart from a literal (`literal: true`, `hex` filled).
 */
export function readRoles(
  doc: unknown, theme = 'light', resolve?: (key: string) => unknown,
): Record<RoleId, RoleState> {
  const out = {} as Record<RoleId, RoleState>;
  for (const role of ROLE_IDS) {
    const raw = slotValue(doc, theme, role);
    if (raw === undefined) { out[role] = { ...UNSET }; continue; }
    const ref = aliasTarget(raw);
    out[role] = { ref, hex: hexOfSlot(raw, role, resolve), literal: ref === null };
  }
  return out;
}

/**
 * The roles that actually point at a swatch, as slot → `{ key, hex }`.
 *
 * A literal-valued role is deliberately absent: it has no swatch behind it, so
 * it is a colour the slot owns rather than an assignment. Use {@link readRoles}
 * when you need to see those too.
 */
export function roleAssignments(
  doc: unknown, theme = 'light', resolve?: (key: string) => unknown,
): Partial<Record<RoleId, { key: string; hex: string }>> {
  const roles = readRoles(doc, theme, resolve);
  const out: Partial<Record<RoleId, { key: string; hex: string }>> = {};
  for (const role of ROLE_IDS) {
    const s = roles[role];
    if (s.ref) out[role] = { key: s.ref, hex: s.hex };
  }
  return out;
}

// ── Writing ──────────────────────────────────────────────────────────────────

/** The group hint the engine's own semantic slots carry, so an assigned role
 *  files under the same palette heading as a derived one. */
const SEMANTIC_GROUP = 'Semantic';

function stampGroup(leaf: Rec): void {
  const ext = isRec(leaf.$extensions) ? leaf.$extensions as Rec : (leaf.$extensions = {} as Rec);
  const ns = isRec(ext[TOKEN_EXT]) ? ext[TOKEN_EXT] as Rec : (ext[TOKEN_EXT] = {} as Rec);
  ns.group = SEMANTIC_GROUP;
}

/**
 * Point `color.semantic.<role>` at a swatch key.
 *
 * `theme` names the theme being edited and is what a UI must pass: a themed
 * document's roles are per-theme and deliberately inverted between them, so an
 * unscoped write from a light-theme strip would overwrite the dark theme's
 * surface and text with the light ones. Omit it only for a value that genuinely
 * belongs to both themes (see {@link roleSets}); on a single-set or layered
 * import it makes no difference - there is one set either way.
 *
 * Creates the `color.semantic` group when it is absent, keeps any `$description`
 * and print lock already on the slot, and stamps the engine's group hint.
 * Refuses a `color.semantic.*` target: a role aliasing a role chains, and the
 * chain breaks the moment either end is reassigned.
 *
 * Only the named role is touched. See the module header for why `on-primary`,
 * `muted` and `edge` are left exactly as they were.
 */
export function assignRole(doc: unknown, role: RoleId, swatchKey: string, theme?: string): boolean {
  if (!isRec(doc) || !isRoleId(role)) return false;
  const key = String(swatchKey ?? '').trim().replace(/^\{|\}$/g, '');
  if (!key || key.startsWith('color.semantic.')) return false;
  let wrote = false;
  for (const prefix of roleSets(doc, theme)) {
    const color = at(doc, [...prefix, 'color']);
    if (!color) continue;
    const semantic = isRec(color.semantic) ? color.semantic as Rec : (color.semantic = {} as Rec);
    const prev = isRec(semantic[role]) ? semantic[role] as Rec : null;
    const leaf: Rec = prev ?? {};
    leaf.$value = `{${key}}`;
    leaf.$type = 'color';
    stampGroup(leaf);
    semantic[role] = leaf;
    wrote = true;
  }
  return wrote;
}

/** Drop a role. `theme` scopes it exactly as {@link assignRole}'s does - the
 *  theme being edited, or every theme set when omitted. A system with no roles
 *  is valid, so this is an ordinary action and not a repair. False when there
 *  was nothing to remove. */
export function clearRole(doc: unknown, role: RoleId, theme?: string): boolean {
  if (!isRec(doc) || !isRoleId(role)) return false;
  let removed = false;
  for (const prefix of roleSets(doc, theme)) {
    const semantic = at(doc, [...prefix, 'color', 'semantic']);
    if (semantic && role in semantic) { delete semantic[role]; removed = true; }
  }
  return removed;
}

// ── Contrast ─────────────────────────────────────────────────────────────────

/** The Lc under which the strip paints its readout as a warning: APCA's
 *  headline floor, the point below which a pair carries nothing but icons and
 *  borders. Not a pass/fail - APCA has none - just where the readout stops
 *  being reassuring. */
export const WEAK_LC = 45;

export interface RoleContrast {
  /** Signed Lc: positive for dark-on-light, negative for light-on-dark. */
  lc: number;
  use: ApcaUse;
  /** The band's short phrase, ready to show. */
  label: string;
  /** WCAG 2.1 ratio, 1–21. Secondary by house rule: tooltip only. */
  wcag: number;
  /** |Lc| below {@link WEAK_LC}. */
  weak: boolean;
}

/** APCA first, WCAG second. Null when either colour is unreadable, which the
 *  strip renders as nothing at all rather than a misleading zero. */
export function roleContrast(fgHex: string, bgHex: string): RoleContrast | null {
  if (!fgHex || !bgHex) return null;
  const v = apcaVerdict(fgHex, bgHex);
  if (!v) return null;
  const wcag = contrastRatio(fgHex, bgHex);
  return {
    lc: v.lc,
    use: v.use,
    label: v.label,
    wcag: Number.isFinite(wcag) ? wcag : NaN,
    weak: v.abs < WEAK_LC,
  };
}

/** One role's readout: what it is, and how it reads against the colour it is
 *  judged with. */
export interface RoleReadout extends RoleState {
  /** The other half of the measured pair (see the table on {@link roleReadouts}). */
  against: string;
  /** The pair's contrast, or null when either side is missing. */
  contrast: RoleContrast | null;
}

/**
 * Every role's colour plus its contrast readout, measured against the assigned
 * surface.
 *
 * The pairing, applied uniformly (plan 97 section 7.1: "with roles set, live APCA
 * readouts appear against the chosen surface"):
 *
 * | role      | foreground                        | background            |
 * |-----------|-----------------------------------|-----------------------|
 * | primary   | `on-primary`, falling back `text` | the primary itself    |
 * | secondary | `text`                            | the secondary itself  |
 * | surface   | `text`                            | the surface itself    |
 * | text      | the text colour                   | `surface`, else white |
 *
 * The white fallback is the last resort for a document with no surface role at
 * all: text has to be read on something, and a blank page is what it gets.
 */
export function roleReadouts(
  doc: unknown, theme = 'light', resolve?: (key: string) => unknown,
): Record<RoleId, RoleReadout> {
  const roles = readRoles(doc, theme, resolve);
  const textHex = roles.text.hex || semanticHex(doc, theme, 'text', resolve);
  const surfaceHex = roles.surface.hex || semanticHex(doc, theme, 'surface', resolve);
  const onPrimary = semanticHex(doc, theme, 'on-primary', resolve) || textHex;

  const out = {} as Record<RoleId, RoleReadout>;
  for (const role of ROLE_IDS) {
    const state = roles[role];
    const against =
      role === 'primary' ? onPrimary
        : role === 'text' ? (surfaceHex || '#ffffff')
          : textHex;
    // For `text` the role IS the foreground; for the other three it is the
    // ground the pairing colour sits on.
    const [fg, bg] = role === 'text' ? [state.hex, against] : [against, state.hex];
    out[role] = { ...state, against, contrast: roleContrast(fg, bg) };
  }
  return out;
}

// ── The strip ────────────────────────────────────────────────────────────────

/** A swatch a role can be assigned to. `group` drives the `<optgroup>` headings
 *  in the picker; omit it and the options render flat. */
export interface RoleSwatchOption {
  key: string;
  name: string;
  hex: string;
  group?: string;
}

/** One rendered chip. Built by {@link buildRolesModel}, so the strip's shape is
 *  assertable without a DOM. */
export interface RoleRow {
  id: RoleId;
  label: string;
  /** The chip's paint, '' when the role is unset. */
  hex: string;
  /** The value line: the swatch's name when the role points at one, else the
   *  raw hex, else the not-set label. */
  value: string;
  /** True when the slot holds something. */
  set: boolean;
  /** The picker's current selection: a swatch key, or '' for Not set. */
  selected: string;
  contrast: RoleContrast | null;
}

export interface RolesModel {
  rows: RoleRow[];
  options: RoleSwatchOption[];
}

/**
 * The strip's model. Pure: everything the markup needs, computed from the
 * document, the theme, and the swatches on offer.
 *
 * `swatches` is expected to be pre-filtered to the non-semantic ones (a role
 * cannot take a role) - the caller has that list already from `walkSwatches`,
 * and re-deriving it here would mean importing the editor's doc surgery.
 */
export function buildRolesModel(
  doc: unknown, theme: string, swatches: RoleSwatchOption[], resolve?: (key: string) => unknown,
): RolesModel {
  const readouts = roleReadouts(doc, theme, resolve);
  const options = swatches.filter(s => !s.key.startsWith('color.semantic.'));
  const byKey = new Map(options.map(s => [s.key, s]));
  const rows = ROLE_IDS.map((id): RoleRow => {
    const r = readouts[id];
    const named = r.ref ? byKey.get(r.ref) : undefined;
    const set = !!(r.ref || (r.literal && r.hex));
    return {
      id,
      label: roleLabel(id),
      hex: r.hex,
      value: named?.name || (r.ref ?? '') || r.hex || t('Not set'),
      set,
      selected: r.ref && byKey.has(r.ref) ? r.ref : '',
      contrast: r.contrast,
    };
  });
  return { rows, options };
}

/** `Lc 78` - one decimal would suggest a precision APCA does not claim at this
 *  size, and the sign matters (it is the polarity), so it is kept. */
const fmtLc = (lc: number): string => `${lc < 0 ? '-' : ''}${Math.round(Math.abs(lc))}`;

/** The readout's three rendered parts, so the string builder and the in-place
 *  patch below cannot drift apart on wording or on the weak-pairing class. */
function apcaParts(c: RoleContrast): { weak: boolean; title: string; text: string } {
  return {
    weak: c.weak,
    title: tRaw('APCA Lc {lc} ({band}). WCAG {wcag} to 1.', {
      lc: fmtLc(c.lc),
      band: c.label,
      wcag: Number.isFinite(c.wcag) ? c.wcag.toFixed(2) : '-',
    }),
    text: tRaw('Lc {lc}', { lc: fmtLc(c.lc) }),
  };
}

function apcaHtml(c: RoleContrast | null): string {
  if (!c) return '';
  const p = apcaParts(c);
  return `<span class="be-role-apca${p.weak ? ' is-weak' : ''}" title="${escape(p.title)}">${escape(p.text)}</span>`;
}

function optionsHtml(options: RoleSwatchOption[], selected: string): string {
  const opt = (s: RoleSwatchOption): string =>
    `<option value="${escape(s.key)}"${s.key === selected ? ' selected' : ''}>${escape(s.name)}</option>`;
  const groups = new Map<string, RoleSwatchOption[]>();
  for (const s of options) {
    const g = s.group ?? '';
    const bucket = groups.get(g) ?? [];
    bucket.push(s);
    groups.set(g, bucket);
  }
  const body = [...groups].map(([g, list]) =>
    g ? `<optgroup label="${escape(g)}">${list.map(opt).join('')}</optgroup>` : list.map(opt).join('')).join('');
  return `<option value=""${selected ? '' : ' selected'}>${escape(t('Not set'))}</option>${body}`;
}

/** The strip's markup for a model. Pure, so its shape is unit-tested headless. */
export function rolesStripHtml(model: RolesModel): string {
  return `<div class="be-roles-strip">${model.rows.map(row => `
    <div class="be-role${row.set ? '' : ' is-unset'}" data-be-role="${escape(row.id)}">
      <span class="be-role-sw" style="--sw:${escape(row.hex || 'transparent')}" aria-hidden="true"></span>
      <span class="be-role-meta">
        <span class="be-role-name">${escape(row.label)}</span>
        <span class="be-role-val" title="${escape(row.value)}">${escape(row.value)}</span>
      </span>
      ${apcaHtml(row.contrast)}
      <select class="field-select be-role-pick" data-be-role-pick="${escape(row.id)}"
              aria-label="${escape(tRaw('Colour for {role}', { role: row.label }))}">${
    optionsHtml(model.options, row.selected)}</select>
    </div>`).join('')}</div>`;
}

/** Live getters, the same ctx shape `mountPrintLock` and the rooms use - the
 *  room reassigns its `doc` on Replace, undo and reload, so nothing here may
 *  hold a reference to one. */
export interface RolesCtx {
  doc: () => Record<string, unknown>;
  /** 'light' | 'dark' - which theme's roles are being edited. */
  theme: () => string;
  /** Resolves an `{alias}` to a colour, typically a `createTokenSet` lookup. */
  resolve?: (key: string) => unknown;
  /** Assignable swatches, non-semantic, already resolved to hex. */
  swatches: () => RoleSwatchOption[];
  /** The room does the write (`assignRole`), the repaint and the persist - this
   *  module never touches the document from the DOM half. Write the theme you
   *  are reading: pass `theme()` through to `assignRole`/`clearRole`, or a strip
   *  showing the light theme edits the dark one too. */
  assign: (role: RoleId, key: string) => void;
  clear: (role: RoleId) => void;
}

/** The option list as one comparable string. A role write only ever touches
 *  `color.semantic.*`, which `buildRolesModel` filters OUT of the options - so
 *  the picker's own change event leaves this identical, which is what lets the
 *  repaint it triggers patch rather than rebuild. */
function optionsSig(options: RoleSwatchOption[]): string {
  return options.map(s => `${s.key}␟${s.name}␟${s.group ?? ''}`).join('␞');
}

/**
 * Update an already-rendered strip in place, or report that it cannot be done.
 *
 * False means "the DOM is not the shape this model describes" - first paint, a
 * language switch, a changed row set - and the caller rebuilds. Everything else
 * is written onto the nodes already there, through the DOM rather than through
 * markup (no second raw-HTML sink, and no detached `<select>`), so the element
 * the person is operating survives the repaint its own `change` event caused.
 *
 * The caller only reaches here when the OPTION LIST is unchanged, which is
 * exactly the picker's own case: a role write lands in `color.semantic.*`, and
 * `buildRolesModel` filters those out of the options. A real palette change
 * rebuilds.
 */
function patchStrip(mount: HTMLElement, model: RolesModel): boolean {
  const rows = mount.querySelectorAll<HTMLElement>('[data-be-role]');
  if (rows.length !== model.rows.length) return false;
  for (let i = 0; i < model.rows.length; i++) {
    const row = model.rows[i]!;
    const el = rows[i]!;
    if (el.dataset.beRole !== row.id) return false;
    const sel = el.querySelector<HTMLSelectElement>('[data-be-role-pick]');
    if (!sel) return false;
    el.classList.toggle('is-unset', !row.set);
    el.querySelector<HTMLElement>('.be-role-sw')?.style.setProperty('--sw', row.hex || 'transparent');
    const name = el.querySelector<HTMLElement>('.be-role-name');
    if (name) name.textContent = row.label;
    sel.setAttribute('aria-label', tRaw('Colour for {role}', { role: row.label }));
    const val = el.querySelector<HTMLElement>('.be-role-val');
    if (val) { val.textContent = row.value; val.title = row.value; }
    // The readout appears and disappears with the pairing, so it is created and
    // removed rather than only rewritten. It holds no state and nothing in it
    // is focusable, so replacing it costs the interaction nothing.
    let apca = el.querySelector<HTMLElement>('.be-role-apca');
    if (!row.contrast) { apca?.remove(); }
    else {
      const p = apcaParts(row.contrast);
      if (!apca) {
        apca = el.ownerDocument.createElement('span');
        sel.before(apca);
      }
      apca.className = `be-role-apca${p.weak ? ' is-weak' : ''}`;
      apca.title = p.title;
      apca.textContent = p.text;
    }
    sel.value = row.selected;
  }
  return true;
}

/**
 * Render the roles strip into `mount` and wire its pickers.
 *
 * `render()` is the caller's resync hook - the room pushes it onto
 * `paletteHooks`, so the strip re-reads after every add, delete, replace and
 * undo with no extra seam. One delegated `change` listener on the mount, so a
 * re-render never leaks handlers.
 *
 * It PATCHES the rendered nodes rather than replacing the strip's markup,
 * because the commonest caller of all is the picker's own `change`: assigning a
 * role repaints the palette, which calls this back while the `<select>` that
 * fired the event is the focused element. Replacing the markup there detaches
 * it mid-interaction - focus falls to `<body>`, and on the platforms where a
 * CLOSED select fires `change` on every arrow key (Windows/Linux Chrome and
 * Firefox) the second arrow press has nothing left to land on, so the picker
 * cannot be operated by keyboard at all. A wholesale rebuild is still the
 * fallback for anything the patch cannot express, and it restores focus to the
 * same role's picker afterwards.
 */
export function mountRolesStrip(mount: HTMLElement, ctx: RolesCtx): { render: () => void } {
  let sig: string | null = null;
  const render = (): void => {
    const model = buildRolesModel(ctx.doc(), ctx.theme(), ctx.swatches(), ctx.resolve);
    const next = optionsSig(model.options);
    const sameOptions = next === sig;
    sig = next;
    if (sameOptions && patchStrip(mount, model)) return;
    // A rebuild is unavoidable here (the swatches on offer changed, or the strip
    // is not yet drawn). Put focus back on the picker it was on: a delete, an
    // add or an undo can land while one is focused too.
    const active = mount.ownerDocument.activeElement;
    const hadRole = active && mount.contains(active)
      ? (active as HTMLElement).closest<HTMLElement>('[data-be-role-pick]')?.dataset.beRolePick ?? '' : '';
    mount.innerHTML = rolesStripHtml(model);
    if (isRoleId(hadRole)) {
      mount.querySelector<HTMLSelectElement>(`[data-be-role-pick="${hadRole}"]`)?.focus();
    }
  };
  mount.addEventListener('change', (e) => {
    const sel = (e.target as HTMLElement | null)?.closest<HTMLSelectElement>('[data-be-role-pick]');
    if (!sel) return;
    const role = sel.dataset.beRolePick;
    if (!isRoleId(role)) return;
    const key = sel.value;
    if (key) ctx.assign(role, key); else ctx.clear(role);
  });
  render();
  return { render };
}
