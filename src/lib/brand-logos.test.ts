// SPDX-License-Identifier: MPL-2.0
/** brand-logos.ts — the pure doc surgery for the four logo-variant tokens. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLogoToken, logoGroupOf } from './brand-logos.ts';

test('withLogoToken adds/reads/clears a variant on a layered doc (writes into base)', () => {
  const doc = { $themes: [{ name: 'light' }], base: {}, light: {} };
  const a = withLogoToken(doc, 'horizontal', 'user/logo/horizontal');
  const grp = logoGroupOf(a);
  assert.ok(grp, 'group exists');
  assert.deepEqual(grp!.horizontal, { $type: 'asset', $value: 'user/logo/horizontal' });
  // Writes into base on a layered doc.
  assert.ok((a.base as Record<string, unknown>).asset, 'base.asset created');

  const b = withLogoToken(a, 'reverse', 'user/logo/reverse');
  assert.equal(Object.keys(logoGroupOf(b)!).length, 2);

  const c = withLogoToken(b, 'horizontal', null);
  const grpC = logoGroupOf(c)!;
  assert.equal(grpC.horizontal, undefined);
  assert.ok(grpC.reverse, 'other variant untouched');

  // Clearing the last variant removes the empty asset scaffolding.
  const d = withLogoToken(c, 'reverse', null);
  assert.equal(logoGroupOf(d), null);
  assert.equal((d.base as Record<string, unknown>).asset, undefined);
});

test('withLogoToken works on a plain (non-layered) doc at the root', () => {
  const a = withLogoToken({}, 'mono', 'user/logo/mono');
  assert.deepEqual(logoGroupOf(a)!.mono, { $type: 'asset', $value: 'user/logo/mono' });
});
