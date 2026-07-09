// SPDX-License-Identifier: MPL-2.0
/**
 * User-fonts tests: the font.brand token merge (both doc shapes), family
 * grouping/primary detection, and the remove→promote-next-primary flow.
 * Run directly:  node --test shells/web/src/user-fonts.test.ts
 *
 * DOM-free: registerUserFonts no-ops without FontFace, and the chrome repaint
 * inside setPrimaryFont swallows the missing-document rejection — so the whole
 * flow runs against an in-memory host whose tokens.resolve reads back the
 * user tokens blob the flow itself installs (a real round-trip, not a stub of
 * the answer).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withBrandFontToken, familyFromTokenValue, listUserFonts, removeUserFont,
  setPrimaryFont, primaryFontFamily, USER_FONT_PREFIX,
  withRadiusToken, setBrandRadius,
} from './user-fonts.ts';
import type { UserFontsHost } from './user-fonts.ts';

// ── withBrandFontToken ────────────────────────────────────────────────────────

test('plain DTCG doc: sets font.brand, preserves siblings, clears cleanly', () => {
  const doc = { color: { x: { $type: 'color', $value: '#123456' } }, font: { $type: 'fontFamily', mono: { $value: 'SUSE Mono' } } };
  const set = withBrandFontToken(doc, 'Inter');
  assert.deepEqual((set.font as any).brand, { $type: 'fontFamily', $value: ['Inter'] });
  assert.equal((set.font as any).mono.$value, 'SUSE Mono');      // sibling kept
  assert.ok((doc.font as any).brand === undefined);              // source untouched
  const cleared = withBrandFontToken(set, null);
  assert.equal((cleared.font as any).brand, undefined);
  assert.equal((cleared.font as any).mono.$value, 'SUSE Mono');  // mono keeps the group alive
});

test('clearing the only font slot removes the group entirely', () => {
  const cleared = withBrandFontToken(withBrandFontToken({}, 'Inter'), null);
  assert.equal(cleared.font, undefined);
});

test('layered doc ($themes): the token lands in the base SET, not top-level', () => {
  const doc = {
    $themes: [{ name: 'light', selectedTokenSets: { base: 'enabled', light: 'enabled' } }],
    base: { color: { ramp: {} } },
    light: {},
  };
  const set = withBrandFontToken(doc, 'Sora');
  assert.deepEqual((set.base as any).font.brand.$value, ['Sora']);
  assert.equal((set as any).font, undefined);
});

// ── withRadiusToken ──────────────────────────────────────────────────────────

test('plain DTCG doc: sets shape.radius, preserves siblings, clears cleanly', () => {
  const doc = { color: { x: { $type: 'color', $value: '#123456' } } };
  const set = withRadiusToken(doc, '0.5rem');
  assert.deepEqual((set.shape as any).radius, { $type: 'dimension', $value: '0.5rem' });
  assert.equal((set.color as any).x.$value, '#123456'); // sibling kept
  assert.ok((doc as any).shape === undefined);           // source untouched
  const cleared = withRadiusToken(set, null);
  assert.equal((cleared as any).shape, undefined);
});

test('layered doc ($themes): the token lands in the base SET, not top-level', () => {
  const doc = {
    $themes: [{ name: 'light', selectedTokenSets: { base: 'enabled', light: 'enabled' } }],
    base: { color: { ramp: {} } },
    light: {},
  };
  const set = withRadiusToken(doc, '0.75rem');
  assert.equal((set.base as any).shape.radius.$value, '0.75rem');
  assert.equal((set as any).shape, undefined);
});

test('familyFromTokenValue: arrays, strings, quotes, alias residue', () => {
  assert.equal(familyFromTokenValue(['Inter', 'sans-serif']), 'Inter');
  assert.equal(familyFromTokenValue('SUSE'), 'SUSE');
  assert.equal(familyFromTokenValue("'Space Grotesk'"), 'Space Grotesk');
  assert.equal(familyFromTokenValue('{font.brand}'), '');
  assert.equal(familyFromTokenValue(undefined), '');
});

// ── In-memory host: assets store + tokens that read the stored user doc ──────

function memoryHost(): UserFontsHost & { store: Map<string, any> } {
  const store = new Map<string, any>();
  const host: UserFontsHost & { store: Map<string, any> } = {
    store,
    assets: {
      async _uploadUserAsset(record: any) { store.set(record.id, record); },
      async _deleteUserAsset(id: string) { store.delete(id); },
      async _exportUserAssets() { return [...store.values()]; },
      async _getBlob(id: string) { return store.get(id)?.blob ?? null; },
    },
    tokens: {
      // Resolve {font.brand} / {shape.radius} from the installed user doc —
      // the live bridge's discovery order, reduced to the slice these flows
      // exercise (both live at the doc's top level or under 'base', per
      // fontTargetOf's layered-vs-plain-DTCG resolution).
      async resolve(ref: string) {
        const blob = store.get('user/tokens/brand')?.blob;
        if (!blob) return undefined;
        const doc = JSON.parse(await blob.text());
        if (ref === '{font.brand}') return doc?.font?.brand?.$value ?? doc?.base?.font?.brand?.$value;
        if (ref === '{shape.radius}') return doc?.shape?.radius?.$value ?? doc?.base?.shape?.radius?.$value;
        return undefined;
      },
      bust() { /* nothing cached here */ },
    },
  };
  return host;
}

const fontRecord = (family: string, n: number, weight = '100 900') => ({
  id: `${USER_FONT_PREFIX}${family.toLowerCase().replace(/ /g, '-')}/${n}`,
  type: 'font',
  format: 'woff2',
  blob: new Blob([new Uint8Array(64)], { type: 'font/woff2' }),
  meta: { family, weight, style: 'normal', subset: n === 0 ? 'latin' : 'latin-ext' },
});

test('listUserFonts groups faces by family, sums bytes, marks the primary first', async () => {
  const host = memoryHost();
  await host.assets._uploadUserAsset(fontRecord('Inter', 0));
  await host.assets._uploadUserAsset(fontRecord('Inter', 1));
  await host.assets._uploadUserAsset(fontRecord('Space Grotesk', 0, '400'));
  await setPrimaryFont(host, 'Space Grotesk');
  const fams = await listUserFonts(host);
  assert.deepEqual(fams.map(f => f.family), ['Space Grotesk', 'Inter']); // primary sorts first
  assert.equal(fams[0]!.primary, true);
  assert.equal(fams[0]!.weights, '400');
  assert.equal(fams[1]!.primary, false);
  assert.equal(fams[1]!.assetIds.length, 2);
  assert.equal(fams[1]!.bytes, 128);
  assert.equal(fams[1]!.weights, 'variable 100–900');
});

test('setPrimaryFont installs a user tokens doc that resolves back', async () => {
  const host = memoryHost();
  await setPrimaryFont(host, 'Inter');
  assert.equal(await primaryFontFamily(host), 'Inter');
  // The write is the standard user-tokens asset — backups carry it for free.
  assert.ok(host.store.has('user/tokens/brand'));
});

test('setBrandRadius installs a user tokens doc that resolves back, and clears with null', async () => {
  const host = memoryHost();
  await setBrandRadius(host, '0.5rem');
  assert.equal(await host.tokens!.resolve('{shape.radius}'), '0.5rem');
  assert.ok(host.store.has('user/tokens/brand'));
  await setBrandRadius(host, null);
  assert.equal(await host.tokens!.resolve('{shape.radius}'), undefined);
});

test('setBrandRadius rejects a value that could smuggle CSS', async () => {
  const host = memoryHost();
  await assert.rejects(() => setBrandRadius(host, '0.5rem; background:url(//evil)'));
  assert.equal(await host.tokens!.resolve('{shape.radius}'), undefined); // never written
});

test('setBrandRadius preserves an existing font.brand token (independent slots)', async () => {
  const host = memoryHost();
  await setPrimaryFont(host, 'Inter');
  await setBrandRadius(host, '1.25rem');
  assert.equal(await primaryFontFamily(host), 'Inter');
  assert.equal(await host.tokens!.resolve('{shape.radius}'), '1.25rem');
});

test('removing the primary family promotes the next installed one', async () => {
  const host = memoryHost();
  await host.assets._uploadUserAsset(fontRecord('Inter', 0));
  await host.assets._uploadUserAsset(fontRecord('Sora', 0, '400'));
  await setPrimaryFont(host, 'Inter');
  const [inter] = await listUserFonts(host);
  assert.equal(inter!.family, 'Inter');
  await removeUserFont(host, inter!);
  assert.equal(await primaryFontFamily(host), 'Sora');
  assert.equal((await listUserFonts(host)).length, 1);
});

test('removing the last family clears font.brand (back to platform default)', async () => {
  const host = memoryHost();
  await host.assets._uploadUserAsset(fontRecord('Inter', 0));
  await setPrimaryFont(host, 'Inter');
  const [inter] = await listUserFonts(host);
  await removeUserFont(host, inter!);
  assert.equal(await primaryFontFamily(host), '');
});
