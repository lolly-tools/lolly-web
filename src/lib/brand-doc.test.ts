// SPDX-License-Identifier: MPL-2.0
/**
 * brand-doc.ts — the pure DTCG surgery behind the Dashboard's brand editor.
 *
 * Run with: node --test "shells/web/src/**\/*.test.ts"
 *
 * Exercised against the REAL shipped starter brand (brands/lolly-start), so a
 * change to the token contract's shape (ramps / spectrum / per-theme semantic
 * roles) fails here rather than silently blanking the palette in the UI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTokenSet } from '@lolly/engine';
import {
  walkSwatches, setSwatchValue, setSwatchName, deleteSwatch, addSwatch, leafAt,
  setSwatchCmykLock, setSwatchSpotLock, getSwatchPrintOverride, primaryAnchorPath,
} from './brand-doc.ts';

const BRAND = fileURLToPath(
  new URL('../../../../brands/lolly-start/catalog/assets/lolly/tokens/brand.json', import.meta.url),
);
/** A fresh deep clone per test — every helper mutates in place. */
const load = (): Record<string, unknown> => JSON.parse(readFileSync(BRAND, 'utf8'));
const resolverFor = (doc: unknown, theme: string) => {
  const set = createTokenSet(doc, { theme });
  return (key: string) => set.resolve(key);
};

test('walkSwatches finds the starter brand’s ramps, spectrum and one theme’s roles', () => {
  const doc = load();
  const s = walkSwatches(doc, 'light', resolverFor(doc, 'light'));

  const ramps = s.filter(x => x.kind === 'ramp');
  const spectrum = s.filter(x => x.kind === 'spectrum');
  const roles = s.filter(x => x.kind === 'semantic');

  // 3 ramps × 9 steps, 6 spectrum hues, 7 semantic slots (light only).
  assert.equal(ramps.length, 27, 'primary + neutral + secondary, 9 steps each');
  assert.equal(spectrum.length, 6);
  assert.equal(roles.length, 7);
  assert.equal(s.length, 40);

  // Dark roles are filtered out entirely (they'd duplicate primary/surface/…).
  assert.ok(!s.some(x => x.set === 'dark'));
});

test('roles resolve their {alias} to a real hex (the tiles must never be blank)', () => {
  const doc = load();
  const s = walkSwatches(doc, 'light', resolverFor(doc, 'light'));
  const roles = s.filter(x => x.kind === 'semantic');

  for (const r of roles) {
    assert.ok(r.isAlias, `${r.key} should be stored as an alias`);
    assert.match(r.hex, /^#[0-9a-f]{6}$/i, `${r.key} must resolve to a hex, got ${JSON.stringify(r.hex)}`);
  }
  // Without a resolver, an alias has no colour of its own — the exact bug the
  // resolver argument exists to prevent.
  const blind = walkSwatches(doc, 'light').filter(x => x.kind === 'semantic');
  assert.ok(blind.every(r => r.hex === ''));
});

test('the theme argument selects which set’s roles surface', () => {
  const doc = load();
  const light = walkSwatches(doc, 'light', resolverFor(doc, 'light')).filter(x => x.kind === 'semantic');
  const dark = walkSwatches(doc, 'dark', resolverFor(doc, 'dark')).filter(x => x.kind === 'semantic');

  assert.ok(light.every(r => r.set === 'light'));
  assert.ok(dark.every(r => r.set === 'dark'));
  // The starter brand inverts its neutral ramp between themes, so surface differs.
  const surfL = light.find(r => r.key === 'color.semantic.surface')!;
  const surfD = dark.find(r => r.key === 'color.semantic.surface')!;
  assert.notEqual(surfL.hex.toLowerCase(), surfD.hex.toLowerCase());
});

test('roles are structural (not deletable); ramps, spectrum + custom are the user’s', () => {
  const doc = load();
  const s = walkSwatches(doc, 'light', resolverFor(doc, 'light'));
  // Semantic roles are the fixed contract slots — never deletable.
  assert.ok(s.filter(x => x.kind === 'semantic').every(x => !x.deletable));
  // Ramp steps ARE user-deletable now (the user shapes their own shade set).
  assert.ok(s.filter(x => x.kind === 'ramp').every(x => x.deletable));
  assert.ok(s.filter(x => x.kind === 'spectrum').every(x => x.deletable));
});

test('token keys are the canonical dotted paths pickers resolve', () => {
  const doc = load();
  const s = walkSwatches(doc, 'light', resolverFor(doc, 'light'));
  assert.ok(s.some(x => x.key === 'color.ramp.primary.5'));
  assert.ok(s.some(x => x.key === 'color.spectrum.blue'));
  assert.ok(s.some(x => x.key === 'color.semantic.primary'));
  // Group labels drive the palette's sections.
  assert.equal(s.find(x => x.key === 'color.ramp.primary.5')!.group, 'Primary');
  assert.equal(s.find(x => x.key === 'color.spectrum.blue')!.group, 'Spectrum');
  assert.equal(s.find(x => x.key === 'color.semantic.primary')!.group, 'Roles · Light');
});

test('setSwatchValue recolours a ramp step in place', () => {
  const doc = load();
  const path = ['base', 'color', 'ramp', 'primary', '5'];
  assert.equal(setSwatchValue(doc, path, '#ff0000'), true);
  assert.equal(leafAt(doc, path)!.$value, '#ff0000');

  const s = walkSwatches(doc, 'light', resolverFor(doc, 'light'));
  assert.equal(s.find(x => x.key === 'color.ramp.primary.5')!.hex.toLowerCase(), '#ff0000');
  assert.equal(setSwatchValue(doc, ['base', 'color', 'ramp', 'nope', '1'], '#fff'), false);
});

test('recolouring a role DETACHES its alias into a literal', () => {
  const doc = load();
  const path = ['light', 'color', 'semantic', 'primary'];
  assert.match(String(leafAt(doc, path)!.$value), /^\{.+\}$/); // starts as an alias
  setSwatchValue(doc, path, '#123456');

  const role = walkSwatches(doc, 'light', resolverFor(doc, 'light'))
    .find(x => x.key === 'color.semantic.primary')!;
  assert.equal(role.isAlias, false);
  assert.equal(role.hex.toLowerCase(), '#123456');
});

test('setSwatchName writes $description; clearing it removes the key', () => {
  const doc = load();
  const path = ['base', 'color', 'spectrum', 'blue'];
  setSwatchName(doc, path, '  Ocean  ');
  assert.equal(leafAt(doc, path)!.$description, 'Ocean');
  assert.equal(walkSwatches(doc, 'light').find(x => x.key === 'color.spectrum.blue')!.name, 'Ocean');

  setSwatchName(doc, path, '   ');
  assert.equal('$description' in leafAt(doc, path)!, false);
  // Falls back to the prettified leaf key.
  assert.equal(walkSwatches(doc, 'light').find(x => x.key === 'color.spectrum.blue')!.name, 'Blue');
});

test('addSwatch creates the custom group, slugs collide-safely, and is findable', () => {
  const doc = load();
  assert.equal(walkSwatches(doc, 'light').some(x => x.kind === 'custom'), false);

  const p1 = addSwatch(doc, 'custom', 'Brand Blue', '#4f84ba');
  assert.deepEqual(p1, ['base', 'color', 'custom', 'brand-blue']);

  const p2 = addSwatch(doc, 'custom', 'Brand Blue', '#000000');
  assert.deepEqual(p2, ['base', 'color', 'custom', 'brand-blue-2']);

  const customs = walkSwatches(doc, 'light', resolverFor(doc, 'light')).filter(x => x.kind === 'custom');
  assert.equal(customs.length, 2);
  assert.equal(customs[0]!.name, 'Brand Blue');
  assert.equal(customs[0]!.hex.toLowerCase(), '#4f84ba');
  assert.equal(customs[0]!.group, 'Custom');
  assert.ok(customs.every(c => c.deletable));
  // It must be a real token the picker/exports can resolve.
  assert.equal(createTokenSet(doc, { theme: 'light' }).resolve('color.custom.brand-blue'), '#4f84ba');
});

test('addSwatch can grow the spectrum, and lands in the spectrum group', () => {
  const doc = load();
  const p = addSwatch(doc, 'spectrum', 'Chartreuse', '#7fff00');
  assert.deepEqual(p, ['base', 'color', 'spectrum', 'chartreuse']);
  const s = walkSwatches(doc, 'light', resolverFor(doc, 'light'));
  assert.equal(s.filter(x => x.kind === 'spectrum').length, 7);
  assert.equal(s.find(x => x.key === 'color.spectrum.chartreuse')!.group, 'Spectrum');
});

test('deleteSwatch removes a leaf, and reports a miss', () => {
  const doc = load();
  const p = addSwatch(doc, 'custom', 'Temp', '#abcdef')!;
  assert.equal(walkSwatches(doc, 'light').some(x => x.key === 'color.custom.temp'), true);

  assert.equal(deleteSwatch(doc, p), true);
  assert.equal(walkSwatches(doc, 'light').some(x => x.key === 'color.custom.temp'), false);
  assert.equal(deleteSwatch(doc, p), false, 'deleting twice is a miss, not a throw');
  assert.equal(deleteSwatch(doc, ['base', 'color', 'nope', 'x']), false);
});

test('a translucent (#rrggbbaa) swatch survives into a resolvable token', () => {
  const doc = load();
  const path = addSwatch(doc, 'custom', 'Glass', '#0088ff80')!;
  // The walker keeps the 8-digit hex (alpha not dropped).
  const sw = walkSwatches(doc, 'light', resolverFor(doc, 'light')).find(s => s.key === 'color.custom.glass')!;
  assert.equal(sw.hex.toLowerCase(), '#0088ff80');
  // And it resolves as a real token (so pickers + exports see the alpha), and is deletable.
  assert.equal(createTokenSet(doc, { theme: 'light' }).resolve('color.custom.glass'), '#0088ff80');
  assert.ok(sw.deletable);
  // Recolour-in-place keeps the alpha byte the caller writes.
  setSwatchValue(doc, path, '#11223344');
  assert.equal(leafAt(doc, path)!.$value, '#11223344');
});

test('a single-set (imported) doc still walks and accepts new swatches', () => {
  const doc: Record<string, unknown> = {
    color: { $type: 'color', brand: { blue: { $value: '#0055ff' } } },
  };
  const s = walkSwatches(doc, 'light');
  assert.equal(s.length, 1);
  assert.equal(s[0]!.key, 'color.brand.blue');
  assert.equal(s[0]!.set, null);

  // No `base` set → the custom group hangs off the top-level colour group.
  assert.deepEqual(addSwatch(doc, 'custom', 'Accent', '#ff0090'), ['color', 'custom', 'accent']);
  assert.equal(walkSwatches(doc, 'light').length, 2);
});

test('walkSwatches ignores $-metadata and non-colour leaves', () => {
  const doc: Record<string, unknown> = {
    $description: 'doc',
    base: {
      color: { $type: 'color', ramp: { primary: { 1: { $value: '#111111', $description: 'Ink' } } } },
      // A non-colour token (spacing) must never surface as a swatch.
      space: { sm: { $value: '4px', $type: 'dimension' } },
    },
  };
  const s = walkSwatches(doc, 'light');
  assert.equal(s.length, 1);
  assert.equal(s[0]!.name, 'Ink');
  assert.equal(s[0]!.kind, 'ramp');
});

test('primary CMYK lock: pin, read back, and clear (round-trip)', () => {
  const doc = load();
  const path = primaryAnchorPath(doc)!;
  assert.equal(getSwatchPrintOverride(doc, path), null, 'starter brand has no pinned override');

  assert.equal(setSwatchCmykLock(doc, path, [80, 20, 0, 5]), true);
  assert.deepEqual(getSwatchPrintOverride(doc, path), { cmyk: [80, 20, 0, 5] });

  // The anchor rides in the vendor $extensions on the primary ramp's step 5.
  const leaf = leafAt(doc, ['base', 'color', 'ramp', 'primary', '5'])!;
  const ext = leaf.$extensions as Record<string, { cmyk?: unknown }>;
  assert.deepEqual(ext['com.suse.lolly']!.cmyk, [80, 20, 0, 5]);

  // Clearing removes the anchor (and the empty extension scaffolding).
  assert.equal(setSwatchCmykLock(doc, path, null), true);
  assert.equal(getSwatchPrintOverride(doc, path), null);
  assert.equal(leaf.$extensions, undefined, 'empty $extensions cleaned up');
});

test('primary CMYK lock clamps to 0–100 and rounds', () => {
  const doc = load();
  const path = primaryAnchorPath(doc)!;
  setSwatchCmykLock(doc, path, [120, -5, 33.7, 50]);
  assert.deepEqual(getSwatchPrintOverride(doc, path), { cmyk: [100, 0, 34, 50] });
});

test('cmyk and spot locks are independent: setting/clearing one never touches the other', () => {
  const doc = load();
  const path = primaryAnchorPath(doc)!;

  assert.equal(setSwatchCmykLock(doc, path, [80, 20, 0, 5]), true);
  assert.equal(setSwatchSpotLock(doc, path, { name: 'PANTONE 186 C', book: 'PANTONE+ Solid Coated' }), true);

  // Both present at once — the spot lock is a fallback source, not a replacement.
  const locked = getSwatchPrintOverride(doc, path);
  assert.deepEqual(locked, { cmyk: [80, 20, 0, 5], spot: { name: 'PANTONE 186 C', book: 'PANTONE+ Solid Coated' } });

  const leaf = leafAt(doc, ['base', 'color', 'ramp', 'primary', '5'])!;
  const ext = leaf.$extensions as Record<string, { cmyk?: unknown; spot?: unknown }>;
  assert.deepEqual(ext['com.suse.lolly']!.cmyk, [80, 20, 0, 5], 'setting spot left cmyk untouched');

  // Clearing the spot leaves the cmyk lock in place.
  assert.equal(setSwatchSpotLock(doc, path, null), true);
  assert.deepEqual(getSwatchPrintOverride(doc, path), { cmyk: [80, 20, 0, 5] });

  // Clearing the cmyk lock too fully clears the entry.
  assert.equal(setSwatchCmykLock(doc, path, null), true);
  assert.equal(getSwatchPrintOverride(doc, path), null);
  assert.equal(leaf.$extensions, undefined, 'empty $extensions cleaned up');
});

test('walkSwatches surfaces a swatch\'s print lock (cmyk and/or spot, or none)', () => {
  const doc = load();
  const path = primaryAnchorPath(doc)!;
  setSwatchCmykLock(doc, path, [0, 100, 79, 4]);
  setSwatchSpotLock(doc, path, { name: 'PANTONE 186 C' });
  const s = walkSwatches(doc, 'light').find(sw => sw.path.length === path.length && sw.path.every((seg, i) => seg === path[i]));
  assert.deepEqual(s?.lock, { cmyk: [0, 100, 79, 4], spot: { name: 'PANTONE 186 C' } });
});
