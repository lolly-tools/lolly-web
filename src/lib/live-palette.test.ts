// SPDX-License-Identifier: MPL-2.0
/**
 * toPaletteEntry reconstructs groupPalette()-compatible entries from a
 * resolved ColorSwatch. Fixtures mirror the real shape host.tokens.colors()
 * resolves for a catalog doc built by scripts/build-brand-tokens.ts (see
 * brands/suse/catalog/assets/suse/tokens/brand.json): $description → name,
 * the DTCG path's second segment → which bucket the colour came from, group
 * pre-prettified by the engine (toSwatch in engine/src/tokens.ts).
 * Run directly:  node --test shells/web/src/lib/live-palette.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPaletteEntry } from './live-palette.ts';

test('a ramp swatch keeps its family as group, so it re-groups into that ramp', () => {
  const entry = toPaletteEntry({
    path: 'color.ramp.jungle.4', name: 'Jungle 4', group: 'Jungle', value: '#30ba78', cmyk: null,
  });
  assert.deepEqual(entry, { hex: '#30ba78', label: 'Jungle 4', cmyk: null, group: 'Jungle' });
});

test('a spectrum swatch normalises to the lowercase literal groupPalette() checks for', () => {
  const entry = toPaletteEntry({
    path: 'color.spectrum.teal', name: 'Teal', group: 'Spectrum', value: '#00bda7', cmyk: null,
  });
  assert.equal(entry.group, 'spectrum');
});

test('a named brand swatch drops its DTCG parent group, so it falls into the brand bucket', () => {
  // Real SUSE fixture: color.brand.pine, CMYK-tagged (build-brand-tokens.ts
  // $extensions) — the exact case this fix restores for CMYK PDF substitution.
  const entry = toPaletteEntry({
    path: 'color.brand.pine', name: 'Pine', group: 'Brand', value: '#0c322c', cmyk: [65, 0, 35, 85],
  });
  assert.deepEqual(entry, { hex: '#0c322c', label: 'Pine', cmyk: [65, 0, 35, 85], group: undefined });
});

test('a semantic role swatch also drops its group (no numbered suffix, so groupPalette buckets it as brand)', () => {
  const entry = toPaletteEntry({
    path: 'color.semantic.primary', name: 'Primary', group: 'Roles · Light', value: '#4f84ba', cmyk: null,
  });
  assert.equal(entry.group, undefined);
});

test('a malformed cmyk (wrong arity) is treated as absent rather than shipped to the CMYK substituter', () => {
  const entry = toPaletteEntry({
    path: 'color.brand.oops', name: 'Oops', group: 'Brand', value: '#123456', cmyk: [1, 2, 3],
  });
  assert.equal(entry.cmyk, null);
});
