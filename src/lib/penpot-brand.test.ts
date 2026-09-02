// SPDX-License-Identifier: MPL-2.0
/**
 * lib/penpot-brand.ts at its seam: the brand a `.penpot` archive carries is read
 * through a tokens surface (raw document + resolved swatches), so a stub surface
 * proves the font roles become typographies and the `sans` / `mono` families the
 * Design tool's keys stand for, that swatches become library colours, and that a
 * shell with no tokens yields an empty brand rather than a failure.
 *
 * Run with: node --test shells/web/src/lib/penpot-brand.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandFromTokens } from './penpot-brand.ts';

const DOC = {
  $metadata: { tokenSetOrder: ['base'] },
  $themes: [{ name: 'light', selectedTokenSets: { base: 'enabled' } }],
  base: {
    font: { $type: 'fontFamily', brand: { $value: 'SUSE' }, mono: { $value: ['SUSE Mono', 'monospace'] }, display: { $value: '{font.brand}' } },
    color: { $type: 'color', primary: { $value: '#30ba78' } },
  },
};
const SWATCHES = [
  { path: 'color.primary', name: 'Jungle', group: 'Brand', value: '#30ba78', description: null },
  { path: 'color.odd', name: 'Odd', group: null, value: 'rgb(1,2,3)', description: null },
];

test('font roles become the sans/mono families and typographies; an alias role is skipped', async () => {
  const brand = await brandFromTokens({ raw: async () => DOC, colors: async () => SWATCHES });
  assert.equal(brand.tokens, DOC);
  assert.deepEqual(brand.fonts, { sans: 'SUSE', mono: 'SUSE Mono' });
  assert.deepEqual(brand.typographies.map((t) => [t.name, t.fontFamily, t.fontWeight]), [['Brand', 'SUSE', 400], ['Mono', 'SUSE Mono', 400]]);
});

test('swatches become library colours; a non-hex value is left out', async () => {
  const brand = await brandFromTokens({ raw: async () => DOC, colors: async () => SWATCHES });
  assert.deepEqual(brand.palette, [{ name: 'Jungle', path: 'Brand', color: '#30ba78' }]);
});

test('no surface, or a surface that throws, yields an empty brand', async () => {
  assert.deepEqual(await brandFromTokens(null), { tokens: null, palette: [], typographies: [], fonts: {}, googleFamilies: [] });
  const brand = await brandFromTokens({ raw: async () => { throw new Error('locked'); }, colors: async () => { throw new Error('locked'); } });
  assert.equal(brand.tokens, null);
  assert.deepEqual(brand.palette, []);
  assert.deepEqual(brand.fonts, {});
});
