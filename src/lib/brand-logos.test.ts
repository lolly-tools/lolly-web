// SPDX-License-Identifier: MPL-2.0
/** brand-logos.ts — pure doc surgery for the orientation×treatment logo tokens. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLogoToken, logoGroupOf, LOGO_VARIANTS, splitVariant, variantLabel } from './brand-logos.ts';

test('the variant matrix is orientation × treatment (6 optional slots)', () => {
  assert.equal(LOGO_VARIANTS.length, 6);
  assert.ok(LOGO_VARIANTS.includes('horizontal-primary'));
  assert.ok(LOGO_VARIANTS.includes('vertical-reverse'));
  assert.deepEqual(splitVariant('vertical-mono'), { orientation: 'vertical', treatment: 'mono' });
  assert.equal(variantLabel('horizontal-reverse'), 'Horizontal · Reverse');
});

test('withLogoToken adds/reads/clears a variant on a layered doc (writes into base)', () => {
  const doc = { $themes: [{ name: 'light' }], base: {}, light: {} };
  const a = withLogoToken(doc, 'horizontal-primary', 'user/logo/horizontal-primary');
  const grp = logoGroupOf(a);
  assert.ok(grp, 'group exists');
  assert.deepEqual(grp!['horizontal-primary'], { $type: 'asset', $value: 'user/logo/horizontal-primary' });
  assert.ok((a.base as Record<string, unknown>).asset, 'base.asset created');

  const b = withLogoToken(a, 'vertical-reverse', 'user/logo/vertical-reverse');
  assert.equal(Object.keys(logoGroupOf(b)!).length, 2);

  const c = withLogoToken(b, 'horizontal-primary', null);
  assert.equal(logoGroupOf(c)!['horizontal-primary'], undefined);
  assert.ok(logoGroupOf(c)!['vertical-reverse'], 'other variant untouched');

  const d = withLogoToken(c, 'vertical-reverse', null);
  assert.equal(logoGroupOf(d), null);
  assert.equal((d.base as Record<string, unknown>).asset, undefined);
});

test('withLogoToken works on a plain (non-layered) doc at the root', () => {
  const a = withLogoToken({}, 'vertical-mono', 'user/logo/vertical-mono');
  assert.deepEqual(logoGroupOf(a)!['vertical-mono'], { $type: 'asset', $value: 'user/logo/vertical-mono' });
});
