// SPDX-License-Identifier: MPL-2.0
/**
 * Usage-derived brand proposal — the policy half of the token-less Penpot
 * import. The engine's `scanPenpotUsage` (brand-import.ts) is the pure census:
 * every paint source tallied per colour, gradients deduped, fonts aggregated.
 * This module turns that census into the roles a designer would assign:
 *
 *   - surface   = the highest-weight FILL colour (backgrounds dominate fills);
 *   - shades    = colours co-occurring with the surface in any gradient's stops
 *                 (data-driven, no hue window) — excluded from the accent pool,
 *                 which is load-bearing: a surface shade rides huge gradient
 *                 counts and would otherwise out-score a real accent;
 *   - accents   = remaining colours with OKLCH chroma >= 0.09, scored
 *                 weight x chroma; primary is the top score, secondary the next
 *                 accent at least 30 degrees of hue away (else null);
 *   - scheme    = nearest of mono/analogous/triad/complement to the
 *                 primary-secondary hue arc;
 *   - text      = the most-frequent text-run colour that clears WCAG 4.5:1 on
 *                 the surface, else white/black by the surface's look.
 *
 * `buildBrandDocFromUsage` then composes the EXISTING machinery rather than
 * inventing a doc shape: deriveBrandTokens for the full OKLCH ramp/semantic
 * doc, a literal semantic-secondary override (the supported alias-detach
 * write), addSwatch custom entries for kept extras, addStudioToken gradient
 * tokens for the top gradients, and withFontRoleToken for font.brand/font.mono
 * so carryUserFontTokens lets the doc's own font group win on install.
 *
 * Pure and DOM-free on purpose: unit-testable under node, and importable by
 * the repo-root gated keynote suite the same way font-upload-edge-cases.test.ts
 * imports lib modules.
 */

import { hexToOklch, contrastRatio, deriveBrandTokens } from '@lolly/engine';
import type { PenpotUsage } from '@lolly/engine';
import { addSwatch } from './brand-doc.ts';
import { addStudioToken } from './token-studio.ts';
import { withFontRoleToken } from '../user-fonts.ts';

export interface BrandRoleProposal {
  primary: string;
  secondary: string | null;
  surface: string;
  surfaceLook: 'light' | 'dark';
  text: string;
  scheme: 'mono' | 'analogous' | 'triad' | 'complement';
  /** Accent-pool colours beyond primary/secondary, in score order. */
  extras: string[];
}

export interface BrandUsageFonts {
  /** The most-used family — the app's primary face candidate. */
  brand: string | null;
  /** The most-used family matching /mono/i, for font.mono. */
  mono: string | null;
  /** Families sourced from Google Fonts (`gfont-` ids), most-used first. */
  google: string[];
  /** Families with no fetchable source — named in the card, never fetched. */
  missing: string[];
}

/** Minimum OKLCH chroma for a colour to count as an accent candidate. */
const ACCENT_CHROMA_MIN = 0.09;
/** Minimum hue arc (degrees) between primary and secondary. */
const SECONDARY_HUE_ARC_MIN = 30;
/** WCAG floor for keeping an observed text colour on the observed surface. */
const TEXT_CONTRAST_MIN = 4.5;
/** How many observed gradients become brand tokens. */
const MAX_GRADIENT_TOKENS = 3;

/** Shortest hue arc between two hues, 0..180. */
function hueArc(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
}

/**
 * Pick brand roles from a usage census. Null when the census carries no
 * colours at all (the caller keeps its "nothing found" error for that).
 */
export function proposeBrandRoles(usage: PenpotUsage): BrandRoleProposal | null {
  const colors = usage.colors;
  if (!colors.length) return null;

  // Surface: the highest-weight fill colour (colors are total-sorted, so ties
  // on fills resolve toward overall weight). A file with no fills at all falls
  // back to the heaviest colour overall.
  let surfaceRow = colors[0]!;
  let bestFills = -1;
  for (const c of colors) {
    if (c.fills > bestFills) { surfaceRow = c; bestFills = c.fills; }
  }
  const surface = surfaceRow.hex;
  const surfaceL = hexToOklch(surface)?.l ?? 1;
  const surfaceLook: 'light' | 'dark' = surfaceL < 0.5 ? 'dark' : 'light';

  // Surface shades: colours that share a gradient with the surface. A shade is
  // the surface's own ramp partner, not an accent — and its gradient-stop
  // weight would out-score genuine accents if left in the pool.
  const shades = new Set<string>();
  for (const g of usage.gradients) {
    if (!g.stops.some(s => s.color === surface)) continue;
    for (const s of g.stops) if (s.color !== surface) shades.add(s.color);
  }

  // Accents: weight x chroma over what's left.
  const accents = colors
    .filter(c => c.hex !== surface && !shades.has(c.hex))
    .map(c => ({ hex: c.hex, ok: hexToOklch(c.hex), score: 0 }))
    .filter(a => a.ok !== null && a.ok.c >= ACCENT_CHROMA_MIN)
    .map(a => ({ ...a, score: (colors.find(c => c.hex === a.hex)?.total ?? 0) * a.ok!.c }))
    .sort((a, b) => b.score - a.score);

  // A file of pure greys still needs a primary for deriveBrandTokens: fall
  // back to the heaviest non-surface colour, then the surface itself.
  const primary = accents[0]?.hex ?? colors.find(c => c.hex !== surface)?.hex ?? surface;
  const primaryHue = hexToOklch(primary)?.h ?? 0;

  let secondary: string | null = null;
  const extras: string[] = [];
  for (const a of accents.slice(1)) {
    if (secondary === null && hueArc(a.ok!.h, primaryHue) >= SECONDARY_HUE_ARC_MIN) {
      secondary = a.hex;
    } else {
      extras.push(a.hex);
    }
  }

  // Scheme: nearest named relationship to the observed hue arc.
  let scheme: BrandRoleProposal['scheme'] = 'mono';
  if (secondary !== null) {
    const arc = hueArc(hexToOklch(secondary)?.h ?? 0, primaryHue);
    const named: [BrandRoleProposal['scheme'], number][] =
      [['mono', 0], ['analogous', 30], ['triad', 120], ['complement', 180]];
    let bestD = Infinity;
    for (const [name, at] of named) {
      const d = Math.abs(arc - at);
      if (d < bestD) { bestD = d; scheme = name; }
    }
  }

  // Text: the most-frequent observed text colour that actually reads on the
  // surface; otherwise plain white/black by the surface's look.
  let text: string | null = null;
  let bestRuns = 0;
  for (const c of colors) {
    if (c.textRuns > bestRuns && contrastRatio(c.hex, surface) >= TEXT_CONTRAST_MIN) {
      text = c.hex;
      bestRuns = c.textRuns;
    }
  }
  text ??= surfaceLook === 'dark' ? '#FFFFFF' : '#000000';

  return { primary, secondary, surface, surfaceLook, text, scheme, extras };
}

/** Aggregate the census's font entries into role + source buckets. */
export function proposeFonts(usage: PenpotUsage): BrandUsageFonts {
  const families = new Map<string, { runs: number; google: boolean }>();
  for (const u of usage.fonts) {
    const name = u.fontFamily || u.fontId;
    let e = families.get(name);
    if (!e) { e = { runs: 0, google: false }; families.set(name, e); }
    e.runs += u.runs;
    if (u.fontId.startsWith('gfont-')) e.google = true;
  }
  const byRuns = [...families.entries()].sort((a, b) => b[1].runs - a[1].runs);
  const brand = byRuns[0]?.[0] ?? null;
  const mono = byRuns.find(([name]) => /mono/i.test(name))?.[0] ?? null;
  return {
    brand,
    mono,
    google: byRuns.filter(([, e]) => e.google).map(([name]) => name),
    missing: byRuns.filter(([, e]) => !e.google).map(([name]) => name),
  };
}

/**
 * Compose a full installable tokens doc from a usage census. Throws when the
 * census has no colours — call proposeBrandRoles first to gate on null.
 *
 * `opts.keepExtras` restricts which of the proposal's extra accents become
 * custom swatches (the review card's checkboxes); omitted = keep them all.
 */
export function buildBrandDocFromUsage(
  usage: PenpotUsage, label: string, opts?: { keepExtras?: string[] },
): { doc: Record<string, unknown>; roles: BrandRoleProposal; fonts: BrandUsageFonts; gradientCount: number } {
  const roles = proposeBrandRoles(usage);
  if (!roles) throw new Error('No colours found in the file.');

  let doc = deriveBrandTokens({
    primary: roles.primary,
    scheme: roles.scheme,
    surface: roles.surfaceLook,
    name: label,
  });

  // Detach color.semantic.secondary from its derived ramp step in BOTH theme
  // sets, pinning the colour the designer actually used (writing a literal
  // over the alias is the supported detach — see brand-doc.ts).
  if (roles.secondary) {
    for (const set of ['light', 'dark']) {
      const setRec = doc[set];
      if (typeof setRec !== 'object' || setRec === null) continue;
      const color = (setRec as Record<string, unknown>).color;
      if (typeof color !== 'object' || color === null) continue;
      const semantic = (color as Record<string, unknown>).semantic;
      if (typeof semantic !== 'object' || semantic === null) continue;
      const leaf = (semantic as Record<string, unknown>).secondary;
      if (typeof leaf === 'object' && leaf !== null) (leaf as Record<string, unknown>).$value = roles.secondary;
      else (semantic as Record<string, unknown>).secondary = { $value: roles.secondary };
    }
  }

  // Kept extra accents land as custom swatches, labelled by their hex — honest
  // provenance for colours the file used without naming.
  const keep = opts?.keepExtras ?? roles.extras;
  for (const hex of keep) {
    if (roles.extras.includes(hex)) addSwatch(doc, 'custom', hex, hex);
  }

  // The top observed gradients become gradient tokens (stops as
  // {color, position}, the census's modal angle in the vendor extension).
  let gradientCount = 0;
  for (const g of usage.gradients.slice(0, MAX_GRADIENT_TOKENS)) {
    const path = addStudioToken(doc, 'gradient', `File gradient ${gradientCount + 1}`, {
      stops: g.stops.map(s => ({ color: s.color, position: s.offset })),
      angle: g.angle,
    });
    if (path) gradientCount++;
  }

  // Font roles from the tally — writing them here means carryUserFontTokens
  // keeps THESE on install instead of re-applying the previously chosen faces.
  const fonts = proposeFonts(usage);
  if (fonts.brand) doc = withFontRoleToken(doc, 'brand', fonts.brand);
  if (fonts.mono) doc = withFontRoleToken(doc, 'mono', fonts.mono);

  return { doc, roles, fonts, gradientCount };
}
