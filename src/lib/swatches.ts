// SPDX-License-Identifier: MPL-2.0
/**
 * Brand-palette grouping + swatch markup — shared by the Platform view and the Catalog
 * view so both render the swatches identically (and click-to-copy works the same). The
 * source of truth for the colours themselves is palette.ts (PALETTE).
 *
 * The markup keeps the `.plat-swatch*` class contract (global CSS), so a `swatch()` reads
 * the same wherever it's dropped. Copy-to-clipboard is wired by the host view over the
 * `.plat-swatch-chip[data-copy]` buttons.
 */
import { escape } from '../utils.ts';
import type { PaletteEntry } from '../palette.ts';

export const isTransparent = (hex: string): boolean => !hex || hex.toLowerCase() === 'transparent';

export const cmykText = (cmyk: PaletteEntry['cmyk']): string =>
  Array.isArray(cmyk) ? `C ${cmyk[0]}  M ${cmyk[1]}  Y ${cmyk[2]}  K ${cmyk[3]}` : 'RGB→CMYK (generic)';

/** A swatch carries a locked print value — either a plain CMYK anchor or a named
 *  spot colour (which also carries its own CMYK equivalent) — mutually exclusive. */
export const isLockedInk = (c: Pick<PaletteEntry, 'cmyk' | 'spot'>): boolean => Array.isArray(c.cmyk) || !!c.spot;

/** The ink readout for a swatch: the spot name when locked to one (its CMYK
 *  equivalent is for preview/fallback, not what's shown here), else its plain
 *  CMYK figures (measured or the generic RGB→CMYK fallback). */
export const inkText = (c: Pick<PaletteEntry, 'cmyk' | 'spot'>): string =>
  c.spot ? `Spot · ${c.spot.name}` : cmykText(c.cmyk);

/** One family's tint ramp, e.g. ['Jungle', [Jungle 1, Jungle 2, …]]. */
export type PaletteRamp = [string, PaletteEntry[]];

export interface GroupedPalette {
  brand: PaletteEntry[];
  spectrum: PaletteEntry[];
  ramps: PaletteRamp[];
}

// Split the flat palette into three buckets: the named "brand" colours, the secondary
// "spectrum" palette (tagged group:'spectrum'), and the numbered tint ramps (e.g.
// "Jungle 1".."Jungle 8"), grouped by family in first-seen order. An explicit group that
// names a family (e.g. White → 'Fog') pins a swatch into that ramp; otherwise a trailing
// number in the label decides the family.
export function groupPalette(palette: readonly PaletteEntry[]): GroupedPalette {
  const ramps = new Map<string, PaletteEntry[]>();
  const brand: PaletteEntry[] = [];
  const spectrum: PaletteEntry[] = [];
  const addToRamp = (fam: string, c: PaletteEntry) => {
    if (!ramps.has(fam)) ramps.set(fam, []);
    ramps.get(fam)!.push(c); // just set above when absent, so always present here
  };
  for (const c of palette) {
    if (c.group === 'spectrum') {
      spectrum.push(c);
    } else if (c.group) {
      addToRamp(c.group, c);
    } else {
      const m = /^(.+?)\s+\d+$/.exec(c.label);
      if (m) addToRamp(m[1]!, c); // group 1 (`.+?`) always captures when matched
      else brand.push(c);
    }
  }
  return { brand, spectrum, ramps: [...ramps] };
}

export function swatch(c: PaletteEntry): string {
  const measured = isLockedInk(c);
  const trans = isTransparent(c.hex);
  const chipStyle = trans ? '' : `style="background:${escape(c.hex)}"`;
  // Transparent has no ink at all — a generic RGB→CMYK note would be misleading, so mark
  // it N/A. Locked colours show their exact/spot values; everything else, the generic note.
  const cmykLabel = trans ? 'CMYK N/A' : inkText(c);
  const flag = c.spot
    ? `<span class="plat-chip-flag" title="${escape(`Spot colour: ${c.spot.name}${c.spot.book ? ' · ' + c.spot.book : ''} — its CMYK equivalent is substituted into CMYK PDF exports`)}">SPOT</span>`
    : '<span class="plat-chip-flag" title="Exact CMYK ink values — substituted directly into CMYK PDF exports">CMYK</span>';
  return `
    <div class="plat-swatch${measured ? ' is-measured' : ''}">
      <button type="button" class="plat-swatch-chip${trans ? ' is-transparent' : ''}" ${chipStyle}
              data-copy="${trans ? 'transparent' : escape(c.hex)}"
              aria-label="${escape(c.label)} — ${trans ? 'transparent' : escape(c.hex)} (click to copy)">
        ${measured ? flag : ''}
      </button>
      <span class="plat-swatch-name">${escape(c.label)}</span>
      <code class="plat-swatch-hex">${trans ? 'transparent' : escape(c.hex)}</code>
      <span class="plat-swatch-cmyk${measured || trans ? '' : ' is-generic'}">${cmykLabel}</span>
    </div>`;
}
