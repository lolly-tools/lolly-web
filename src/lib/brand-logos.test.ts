// SPDX-License-Identifier: MPL-2.0
/** brand-logos.ts — pure doc surgery for the orientation×treatment logo tokens. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withLogoToken, logoGroupOf, LOGO_VARIANTS, splitVariant, variantLabel, isReverseTreatment,
} from './brand-logos.ts';

test('the matrix is orientation × treatment: 2 × 4 = 8 optional slots', () => {
  assert.equal(LOGO_VARIANTS.length, 8);
  for (const v of ['horizontal-primary', 'horizontal-primary-reverse', 'horizontal-mono', 'horizontal-mono-reverse',
    'vertical-primary', 'vertical-primary-reverse', 'vertical-mono', 'vertical-mono-reverse']) {
    assert.ok((LOGO_VARIANTS as readonly string[]).includes(v), `${v} present`);
  }
  assert.deepEqual(splitVariant('vertical-primary-reverse'), { orientation: 'vertical', treatment: 'primary-reverse' });
  assert.equal(variantLabel('horizontal-primary-reverse'), 'Horizontal · Primary reverse');
  assert.ok(isReverseTreatment('mono-reverse'));
  assert.ok(!isReverseTreatment('primary'));
});

test('withLogoToken adds/reads/clears a variant on a layered doc (writes into base)', () => {
  const doc = { $themes: [{ name: 'light' }], base: {}, light: {} };
  const a = withLogoToken(doc, 'horizontal-primary-reverse', 'user/logo/horizontal-primary-reverse');
  assert.deepEqual(logoGroupOf(a)!['horizontal-primary-reverse'], { $type: 'asset', $value: 'user/logo/horizontal-primary-reverse' });
  assert.ok((a.base as Record<string, unknown>).asset, 'base.asset created');

  const b = withLogoToken(a, 'vertical-mono-reverse', 'user/logo/vertical-mono-reverse');
  assert.equal(Object.keys(logoGroupOf(b)!).length, 2);

  const c = withLogoToken(b, 'horizontal-primary-reverse', null);
  assert.equal(logoGroupOf(c)!['horizontal-primary-reverse'], undefined);
  assert.ok(logoGroupOf(c)!['vertical-mono-reverse'], 'other variant untouched');

  const d = withLogoToken(c, 'vertical-mono-reverse', null);
  assert.equal(logoGroupOf(d), null);
  assert.equal((d.base as Record<string, unknown>).asset, undefined);
});

test('withLogoToken works on a plain (non-layered) doc at the root', () => {
  const a = withLogoToken({}, 'vertical-mono', 'user/logo/vertical-mono');
  assert.deepEqual(logoGroupOf(a)!['vertical-mono'], { $type: 'asset', $value: 'user/logo/vertical-mono' });
});
