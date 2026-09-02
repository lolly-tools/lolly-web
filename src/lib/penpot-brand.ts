// SPDX-License-Identifier: MPL-2.0
/**
 * The brand, as a `.penpot` archive wants it (plans/178): the raw Tokens-Studio
 * document the Penpot writer filters into `tokens.json`, the resolved colour
 * swatches for the file's Assets tab, the font roles as typographies, and the
 * two families the Design tool's `sans` / `mono` keys stand for.
 *
 * Shared by the `penpot` export format (bridge/export-penpot.ts) and the Send to
 * Penpot driver (lib/penpot-send.ts) so a download and a send carry the same
 * brand. Everything is read through the web host's tokens surface; a shell
 * without tokens (or a locked brand with none reachable yet) yields an empty
 * brand and the archive simply carries no tokens - never a failure.
 */
import type { PenpotIrTypography, PenpotPaletteColor } from '../../../../engine/src/penpot-file.ts';
import { familyFromTokenValue, fontGroupOf } from '../user-fonts.ts';

export interface PenpotBrand {
  /** The effective DTCG / Tokens-Studio document, unresolved (host.tokens.raw()). */
  tokens: unknown;
  palette: PenpotPaletteColor[];
  typographies: PenpotIrTypography[];
  /** What the Design tool's `sans` / `mono` font keys resolve to. */
  fonts: { sans?: string; mono?: string };
  /** Families known to come from Google Fonts (Penpot's `gfont-` ids). */
  googleFamilies: string[];
}

interface TokensSurfaceLike {
  raw?: () => Promise<unknown>;
  colors?: (opts?: { theme?: string }) => Promise<Array<{ path: string; name: string; group: string | null; value: string; description: string | null }>>;
}

const EMPTY: PenpotBrand = { tokens: null, palette: [], typographies: [], fonts: {}, googleFamilies: [] };

/** Font roles the brand may declare, in the order they are worth listing. */
const FONT_ROLES: ReadonlyArray<{ key: string; name: string; weight: number; italic?: boolean }> = [
  { key: 'brand', name: 'Brand', weight: 400 },
  { key: 'display', name: 'Display', weight: 700 },
  { key: 'mono', name: 'Mono', weight: 400 },
  { key: 'italic', name: 'Italic', weight: 400, italic: true },
];

/** Read the brand through a tokens surface (the web host's, or any object with `raw`/`colors`). */
export async function brandFromTokens(surface: TokensSurfaceLike | null | undefined): Promise<PenpotBrand> {
  if (!surface) return { ...EMPTY };
  let tokens: unknown = null;
  try { tokens = surface.raw ? await surface.raw() : null; } catch { tokens = null; }
  let palette: PenpotPaletteColor[] = [];
  try {
    const swatches = surface.colors ? await surface.colors() : [];
    palette = swatches
      .filter((s) => typeof s.value === 'string' && /^#[0-9a-f]{6,8}$/i.test(s.value))
      .map((s) => ({ name: s.name || s.path, path: s.group ?? undefined, color: s.value }));
  } catch { palette = []; }
  const fonts: PenpotBrand['fonts'] = {};
  const typographies: PenpotIrTypography[] = [];
  const group = fontGroupOf(tokens);
  if (group) {
    for (const role of FONT_ROLES) {
      const entry = group[role.key];
      const value = entry && typeof entry === 'object' ? (entry as { $value?: unknown; value?: unknown }).$value ?? (entry as { value?: unknown }).value : entry;
      const family = familyFromTokenValue(value);
      if (!family) continue;
      if (role.key === 'brand') fonts.sans = family;
      if (role.key === 'mono') fonts.mono = family;
      typographies.push({ name: role.name, path: 'Brand', fontFamily: family, fontWeight: role.weight, italic: role.italic, fontSize: 16, lineHeight: 1.2 });
    }
  }
  return { tokens, palette, typographies, fonts, googleFamilies: [] };
}

/**
 * The brand of the running web shell. Lazy on the export bridge, which owns the
 * live host: the send driver stays off the boot graph and the export panel has
 * the bridge loaded already.
 */
export async function brandForPenpot(): Promise<PenpotBrand> {
  try {
    const { _host } = await import('../bridge/export.ts');
    return await brandFromTokens((_host as { tokens?: TokensSurfaceLike } | null)?.tokens ?? null);
  } catch {
    return { ...EMPTY };
  }
}
