// SPDX-License-Identifier: MPL-2.0
/**
 * User fonts — Google Fonts faces the user added, stored ON-DEVICE and made
 * real everywhere the brand is felt.
 *
 * The storage story is deliberately boring: every downloaded woff2 is a
 * `type:'font'` USER ASSET (`user/fonts/<slug>/<n>`), so it rides every
 * existing rail for free — the storage meter counts it, "Export my data" (and
 * the hoard) bundles the bytes, a backup import restores them, and clear-all
 * wipes them. No parallel store, no second source of truth.
 *
 * The PRIMARY font is not a separate preference: it's the brand's `font.brand`
 * token (DTCG fontFamily) in the user's installed tokens doc — exactly what
 * applyBrandFonts (brand-vars.ts) already reads to set `--font-brand` on
 * <html> for the app chrome, every tool canvas and the offscreen export
 * mounts. Setting a primary here merges the token into the active doc and
 * re-installs it as `user/tokens/brand`; there is always exactly one primary
 * while any font is installed.
 *
 * Faces load into the document via the FontFace API at boot
 * (registerUserFonts, called from main.ts) and immediately after an install,
 * so a newly-added family is usable without a reload.
 */

import { installUserTokens, USER_TOKENS_ID } from './bridge/tokens.ts';
import { applyChromeBrandVars, brandRadiusValue } from './brand-vars.ts';
import { bustFontRegistry } from './bridge/font-registry.ts';
import { fetchGoogleFont, GOOGLE_FAMILY_RE } from './lib/google-fonts.ts';
import type { DownloadedFontFace } from './lib/google-fonts.ts';

/** Every user font asset id starts with this (headshot-style fixed namespace). */
export const USER_FONT_PREFIX = 'user/fonts/';

/** The slice of the web bridge this module drives. The upload record is typed
 *  loosely (`type: string`) so one signature serves both the font faces this
 *  module writes and the tokens doc installUserTokens writes through the same
 *  method; the real bridge narrows it to UserAssetRecord. */
export interface UserFontsHost {
  assets: {
    _uploadUserAsset(record: {
      id: string; type: string; format: string; blob: Blob;
      version?: string; meta?: Record<string, unknown>;
    }): Promise<void>;
    _deleteUserAsset(id: string): Promise<unknown>;
    _exportUserAssets(): Promise<Array<{
      id: string; type: string; blob?: Blob; meta?: Record<string, unknown>;
    }>>;
    _getBlob(id: string): Promise<Blob | null>;
  };
  tokens?: {
    resolve(ref: string, opts?: { theme?: string }): Promise<unknown>;
    bust?(): void;
  };
}

/** One installed family, grouped from its per-face assets. */
export interface UserFontFamily {
  family: string;
  /** Asset ids of every stored face (latin/latin-ext × weights × slants). */
  assetIds: string[];
  /** Total stored bytes across the family's faces. */
  bytes: number;
  /** A human blurb: "variable 100–900" or "400 + 700". */
  weights: string;
  /** True when the family shipped an italic face too (Anton et al. have none). */
  italic: boolean;
  primary: boolean;
}

const slugOf = (family: string): string =>
  family.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ── Brand-font family cache (for tool selectors that list every added font) ────
// A SYNCHRONOUS snapshot of the installed brand-font family names, so a tool's
// input renderer (which runs sync) can offer them as select options without an
// async round-trip. Refreshed at boot (registerUserFonts) and after every
// install / removal; a change fires 'lolly:brand-fonts' for anything that wants
// to react (mounted tools re-read it on their next render regardless).
let brandFontFamilyCache: string[] = [];
/** The installed brand-font family names (a copy — safe to mutate). */
export function brandFontFamilies(): string[] { return brandFontFamilyCache.slice(); }
function setBrandFontFamilyCache(families: string[]): void {
  const next = [...new Set(families.filter(Boolean))];
  const changed = next.length !== brandFontFamilyCache.length || next.some((f, i) => f !== brandFontFamilyCache[i]);
  brandFontFamilyCache = next;
  if (changed && typeof document !== 'undefined') document.dispatchEvent(new Event('lolly:brand-fonts'));
}
/** Recompute the family cache from stored user fonts (best-effort; never throws). */
export async function refreshBrandFontFamilies(host: UserFontsHost): Promise<void> {
  try { setBrandFontFamilyCache((await listUserFonts(host)).map(f => f.family)); }
  catch { /* leave the last-known cache in place */ }
}

// ── FontFace registration ─────────────────────────────────────────────────────

// Track what this document already registered (asset id → FontFace) so boot +
// install + import can all call register without duplicating faces, and delete
// can unload the exact faces it removes.
const REGISTERED = new Map<string, FontFace>();

async function registerFace(
  assetId: string,
  family: string,
  blob: Blob,
  desc: { weight?: string; style?: string; unicodeRange?: string },
): Promise<void> {
  if (REGISTERED.has(assetId) || typeof FontFace === 'undefined') return;
  const face = new FontFace(family, await blob.arrayBuffer(), {
    weight: desc.weight || '400',
    style: desc.style || 'normal',
    ...(desc.unicodeRange ? { unicodeRange: desc.unicodeRange } : {}),
  });
  await face.load();
  document.fonts.add(face);
  REGISTERED.set(assetId, face);
}

/**
 * Load every stored user font into document.fonts. Call at boot (before the
 * brand vars land there's nothing to render in the face yet — it's async and
 * best-effort) and after a backup import. Idempotent per document.
 */
export async function registerUserFonts(host: UserFontsHost): Promise<void> {
  // The installed set may have just changed (install, brand pack, backup restore
  // — every path funnels through here), so the vector-export font registry must
  // re-read it rather than serve a stale family map. See bridge/font-registry.ts.
  bustFontRegistry();
  let records: Array<{ id: string; type: string; blob?: Blob; meta?: Record<string, unknown> }>;
  try { records = await host.assets._exportUserAssets(); }
  catch { return; }
  // Refresh the family cache FIRST, off the records' meta — it needs only the
  // family names, not loaded FontFaces, so populating it before the (awaited)
  // face-load below means a tool that renders during boot (a deep link straight
  // to a font-picking tool) already sees the installed brand fonts in its select,
  // instead of racing the parse. Covers boot, install (installGoogleFont calls us)
  // and backup import; one store read for both.
  setBrandFontFamilyCache(records
    .filter(r => r.type === 'font' && r.id.startsWith(USER_FONT_PREFIX))
    .map(r => String(r.meta?.family ?? r.meta?.name ?? '')));
  await Promise.all(records
    .filter(r => r.type === 'font' && r.id.startsWith(USER_FONT_PREFIX) && r.blob)
    .map(r => registerFace(r.id, String(r.meta?.family ?? r.meta?.name ?? ''), r.blob!, {
      weight: typeof r.meta?.weight === 'string' ? r.meta.weight : undefined,
      style: typeof r.meta?.style === 'string' ? r.meta.style : undefined,
      unicodeRange: typeof r.meta?.unicodeRange === 'string' ? r.meta.unicodeRange : undefined,
    }).catch(() => { /* one broken face never blocks the rest */ })));
}

// ── The primary font = the brand's font.brand token ───────────────────────────

/** First family name out of a resolved fontFamily token value ('' if none). */
export function familyFromTokenValue(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && !first.startsWith('{') ? first.replace(/^['"]|['"]$/g, '').trim() : '';
}

/** Where a doc's `font` group belongs: the doc itself for a plain DTCG tree,
 *  or — for a layered Tokens-Studio doc (non-empty $themes ⇒ top-level keys
 *  are SETS) — a set enabled everywhere, `base` by convention. Mutates/creates
 *  the set container on the (already-cloned) doc it's given. */
function fontTargetOf(out: Record<string, unknown>): Record<string, unknown> {
  const layered = Array.isArray(out.$themes) && out.$themes.length > 0;
  if (!layered) return out;
  const setKey = 'base' in out ? 'base' : Object.keys(out).find(k => !k.startsWith('$')) ?? 'base';
  if (typeof out[setKey] !== 'object' || out[setKey] === null) out[setKey] = {};
  return out[setKey] as Record<string, unknown>;
}

/** A doc's `font` group (searched in the same place fontTargetOf writes), or null. */
export function fontGroupOf(doc: unknown): Record<string, unknown> | null {
  if (typeof doc !== 'object' || doc === null) return null;
  const d = doc as Record<string, unknown>;
  const layered = Array.isArray(d.$themes) && d.$themes.length > 0;
  const holder = layered
    ? (['base', ...Object.keys(d).filter(k => !k.startsWith('$'))]
      .map(k => d[k])
      .find(v => typeof v === 'object' && v !== null && 'font' in (v as object)) as Record<string, unknown> | undefined)
    : d;
  const g = holder?.font;
  return (typeof g === 'object' && g !== null) ? g as Record<string, unknown> : null;
}

/**
 * Merge (or clear, with null) the `font.brand` token into a tokens doc, in
 * place of a copy. Handles both doc shapes createTokenSet reads (layered and
 * plain DTCG — the SUSE doc's shape). Pure; exported for tests.
 */
export function withBrandFontToken(doc: unknown, family: string | null): Record<string, unknown> {
  const src = (typeof doc === 'object' && doc !== null && !Array.isArray(doc)) ? doc as Record<string, unknown> : {};
  const out: Record<string, unknown> = structuredClone(src);
  const target = fontTargetOf(out);
  const fontGroup = (typeof target.font === 'object' && target.font !== null)
    ? target.font as Record<string, unknown> : {};
  if (family) {
    fontGroup.brand = { $type: 'fontFamily', $value: [family] };
    target.font = fontGroup;
  } else {
    delete fontGroup.brand;
    if (Object.keys(fontGroup).filter(k => !k.startsWith('$')).length) target.font = fontGroup;
    else delete target.font;
  }
  return out;
}

/**
 * Merge (or clear, with null) the `shape.radius` token into a tokens doc, in
 * place of a copy. Reuses fontTargetOf — it's the generic "which SET to write
 * into" resolver (base vs. a layered doc's top level), not actually font-
 * specific despite the name. Pure; exported for tests.
 */
export function withRadiusToken(doc: unknown, value: string | null): Record<string, unknown> {
  const src = (typeof doc === 'object' && doc !== null && !Array.isArray(doc)) ? doc as Record<string, unknown> : {};
  const out: Record<string, unknown> = structuredClone(src);
  const target = fontTargetOf(out);
  if (value) target.shape = { radius: { $type: 'dimension', $value: value } };
  else delete target.shape;
  return out;
}

/**
 * Set (or clear, with null) the app's corner-radius override: merges
 * shape.radius into the base doc (see primaryBaseDoc), installs it as the
 * user's tokens, and re-applies chrome vars immediately — no reload needed.
 * Mirrors setPrimaryFont. Rejects an unsafe/malformed value up front (the
 * same CSS-length gate applyBrandRadius checks on the way back out).
 */
export async function setBrandRadius(host: UserFontsHost, value: string | null): Promise<void> {
  if (value && !brandRadiusValue(value)) throw new Error(`"${value}" isn't a plain CSS length (e.g. "0.5rem").`);
  const doc = withRadiusToken(await primaryBaseDoc(host), value);
  await installUserTokens(host as Parameters<typeof installUserTokens>[0], doc, { label: 'My brand' });
  await applyChromeBrandVars(host as Parameters<typeof applyChromeBrandVars>[0]).catch(() => {});
}

/**
 * Carry the user's chosen fonts through a brand (re)install: when `doc` (a
 * freshly derived or imported tokens doc) declares no `font` group of its own,
 * graft the one from the user's currently-installed tokens onto it — otherwise
 * re-running the #/start wizard would silently snap the app back to the
 * platform face the moment the new doc lands. A doc that DOES declare fonts
 * wins (an imported brand's type choice is part of that brand).
 */
export async function carryUserFontTokens(
  host: UserFontsHost, doc: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (fontGroupOf(doc)) return doc;
  const current = await userTokensDoc(host);
  const group = current && fontGroupOf(current);
  if (!group) return doc;
  const out = structuredClone(doc);
  fontTargetOf(out).font = structuredClone(group);
  return out;
}

/** The active tokens doc as raw JSON: the user's installed doc when present,
 *  else null (setting a primary font on a catalog-branded install copies the
 *  catalog doc first — see primaryBaseDoc). */
async function userTokensDoc(host: UserFontsHost): Promise<Record<string, unknown> | null> {
  try {
    const blob = await host.assets._getBlob(USER_TOKENS_ID);
    if (!blob) return null;
    const doc: unknown = JSON.parse(await blob.text());
    return (typeof doc === 'object' && doc !== null) ? doc as Record<string, unknown> : null;
  } catch { return null; }
}

/** The doc a font.brand edit starts from: the user's own doc, else a copy of
 *  whatever tokens the shell currently resolves (the active catalog brand),
 *  else a fresh empty doc. Uses the assets bridge's discovery so it works
 *  offline exactly like the tokens bridge itself. */
async function primaryBaseDoc(host: UserFontsHost): Promise<Record<string, unknown>> {
  const user = await userTokensDoc(host);
  if (user) return user;
  try {
    const meta = await (host.assets as unknown as {
      _findMetaByType(t: string): Promise<{ id: string } | null>;
    })._findMetaByType('tokens');
    if (meta) {
      const blob = await host.assets._getBlob(meta.id);
      if (blob) {
        const doc: unknown = JSON.parse(await blob.text());
        if (typeof doc === 'object' && doc !== null) return doc as Record<string, unknown>;
      }
    }
  } catch { /* no catalog tokens reachable — start empty */ }
  return {};
}

/** The current primary family, resolved through the live token set. */
export async function primaryFontFamily(host: UserFontsHost): Promise<string> {
  try { return familyFromTokenValue(await host.tokens?.resolve('{font.brand}')); }
  catch { return ''; }
}

/** Write `family` (or clear, with null) as font.brand and repaint the chrome.
 *  Throws BrandLockedError when the shipped brand is authoritative (the caller's
 *  UI should already be hidden — see host.tokens.isLocked). The repaint is
 *  cosmetic and never fails the write: the font IS the primary once the tokens
 *  land, even if the chrome can't be redrawn (no DOM, a broken token doc, …). */
export async function setPrimaryFont(host: UserFontsHost, family: string | null): Promise<void> {
  const doc = withBrandFontToken(await primaryBaseDoc(host), family);
  await installUserTokens(host as Parameters<typeof installUserTokens>[0], doc, { label: 'My brand' });
  await applyChromeBrandVars(host as Parameters<typeof applyChromeBrandVars>[0]).catch(() => {});
}

// ── Install / list / remove ───────────────────────────────────────────────────

/**
 * Download a Google Fonts family and make it local: one user asset per face,
 * FontFaces registered immediately, and — when `primary` (or when it's the
 * only font) — font.brand updated so the whole app wears it.
 */
export async function installGoogleFont(
  host: UserFontsHost, family: string, opts: { primary?: boolean } = {},
): Promise<UserFontFamily> {
  const name = family.trim();
  if (!GOOGLE_FAMILY_RE.test(name)) throw new Error(`"${family}" doesn't look like a font family name.`);
  const faces = await fetchGoogleFont(name);
  const canonical = faces[0]?.family || name; // css2 echoes the canonical casing
  const slug = slugOf(canonical);
  const version = new Date().toISOString().slice(0, 10);
  const stored: string[] = [];
  for (let i = 0; i < faces.length; i++) {
    const f: DownloadedFontFace = faces[i]!;
    const id = `${USER_FONT_PREFIX}${slug}/${i}`;
    // The stored format mirrors whatever css2 actually served (see
    // google-fonts.ts's FONT_EXT_FORMAT) — usually woff2, occasionally
    // truetype/opentype when the request wasn't recognised as a modern
    // browser. The MIME type is informational only; font-registry.ts sniffs
    // the bytes' own magic number rather than trusting it.
    const mime = f.format === 'truetype' ? 'font/ttf' : f.format === 'opentype' ? 'font/otf' : 'font/woff2';
    await host.assets._uploadUserAsset({
      id,
      type: 'font',
      format: f.format,
      blob: new Blob([f.bytes as BlobPart], { type: mime }),
      version,
      meta: {
        name: `${canonical} (${f.subset || 'all'}${f.weight !== '400' ? ` ${f.weight}` : ''}${f.style === 'italic' ? ' italic' : ''})`,
        family: canonical,
        style: f.style,
        weight: f.weight,
        subset: f.subset,
        unicodeRange: f.unicodeRange,
        source: 'google-fonts',
        tags: ['font'],
      },
    });
    stored.push(id);
  }
  await registerUserFonts(host); // load the new faces into document.fonts
  const families = await listUserFonts(host);
  const mustBePrimary = opts.primary || !(await primaryFontFamily(host));
  if (mustBePrimary) await setPrimaryFont(host, canonical);
  return families.find(f => f.family === canonical)
    ?? { family: canonical, assetIds: stored, bytes: 0, weights: '', italic: faces.some(f => f.style === 'italic'), primary: mustBePrimary };
}

/** A weight blurb for the family list: 'variable 100–900' / '400 + 700' / '400'. */
function weightsBlurb(weights: Set<string>): string {
  const list = [...weights];
  const range = list.find(w => / /.test(w));
  if (range) return `variable ${range.replace(' ', '–')}`;
  return list.sort((a, b) => Number(a) - Number(b)).join(' + ') || '400';
}

/** Installed families, grouped, with the primary marked. */
export async function listUserFonts(host: UserFontsHost): Promise<UserFontFamily[]> {
  let records: Array<{ id: string; type: string; blob?: Blob; meta?: Record<string, unknown> }>;
  try { records = await host.assets._exportUserAssets(); }
  catch { return []; }
  const primary = await primaryFontFamily(host);
  const byFamily = new Map<string, UserFontFamily & { _weights: Set<string> }>();
  for (const r of records) {
    if (r.type !== 'font' || !r.id.startsWith(USER_FONT_PREFIX)) continue;
    const family = String(r.meta?.family ?? r.meta?.name ?? 'Font');
    let g = byFamily.get(family);
    if (!g) {
      g = { family, assetIds: [], bytes: 0, weights: '', italic: false, primary: family === primary, _weights: new Set() };
      byFamily.set(family, g);
    }
    g.assetIds.push(r.id);
    g.bytes += r.blob?.size ?? 0;
    if (typeof r.meta?.weight === 'string') g._weights.add(r.meta.weight);
    if (r.meta?.style === 'italic') g.italic = true;
  }
  return [...byFamily.values()]
    .map(({ _weights, ...fam }) => ({ ...fam, weights: weightsBlurb(_weights) }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.family.localeCompare(b.family));
}

/**
 * Remove a family: delete its assets, unload its FontFaces, and — if it was
 * the primary — hand font.brand to the next installed family (or clear it,
 * falling back to the platform default stack).
 */
export async function removeUserFont(host: UserFontsHost, family: UserFontFamily): Promise<void> {
  for (const id of family.assetIds) {
    await host.assets._deleteUserAsset(id);
    const face = REGISTERED.get(id);
    if (face) { document.fonts.delete(face); REGISTERED.delete(id); }
  }
  bustFontRegistry();   // the family is gone — exports must stop resolving it
  if (family.primary) {
    const rest = (await listUserFonts(host)).filter(f => f.family !== family.family);
    await setPrimaryFont(host, rest[0]?.family ?? null);
  }
  await refreshBrandFontFamilies(host); // the removed family must leave tool selectors too
}
