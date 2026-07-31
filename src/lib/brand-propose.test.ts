// SPDX-License-Identifier: MPL-2.0
/**
 * Unit coverage for the usage-derived brand proposal (brand-propose.ts) on
 * SYNTHETIC PenpotUsage fixtures — the role heuristic, the load-bearing
 * surface-shade exclusion, scheme classification, the text contrast pick, the
 * font role/source split, and doc composition. The real-file replay of the
 * same pipeline lives in the gated tests/penpot-keynote-replay.test.ts.
 *
 * Run with: node --test shells/web/src/lib/brand-propose.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PenpotUsage, PenpotUsageColor, PenpotUsageGradient } from '@lolly/engine';
import { proposeBrandRoles, proposeFonts, buildBrandDocFromUsage } from './brand-propose.ts';
import { listStudioTokens } from './token-studio.ts';

type FontRow = PenpotUsage['fonts'][number];

function color(hex: string, o: Partial<Omit<PenpotUsageColor, 'hex' | 'total'>> = {}): PenpotUsageColor {
  const fills = o.fills ?? 0, strokes = o.strokes ?? 0, textRuns = o.textRuns ?? 0, gradientStops = o.gradientStops ?? 0;
  return { hex, fills, strokes, textRuns, gradientStops, total: fills + strokes + textRuns + gradientStops };
}

function usage(o: { colors?: PenpotUsageColor[]; gradients?: PenpotUsageGradient[]; fonts?: FontRow[] } = {}): PenpotUsage {
  return { colors: o.colors ?? [], gradients: o.gradients ?? [], fonts: o.fonts ?? [] };
}

function grad(stops: [string, number][], count = 1, angle = 180): PenpotUsageGradient {
  return { type: 'linear', stops: stops.map(([c, off]) => ({ color: c, offset: off, opacity: 1 })), count, angle };
}

function font(fontId: string, fontFamily: string, runs: number, weight = 400): FontRow {
  return { fontId, fontFamily, fontVariantId: String(weight), fontWeight: weight, fontStyle: 'normal', runs };
}

// The keynote's decisive quartet, in miniature: a dark surface, its gradient
// shade whose weight x chroma score BEATS the real secondary, and two accents.
const QUARTET = [
  color('#151035', { fills: 1066 }),          // surface (dark, L 0.205)
  color('#F23AE5', { fills: 95 }),            // primary (C 0.274, score ~26)
  color('#312470', { gradientStops: 76 }),    // surface shade (score ~9.5 if left in)
  color('#14CECA', { fills: 57 }),            // real secondary (score ~7.4)
];

test('proposeBrandRoles: null when the census carries no colours', () => {
  assert.equal(proposeBrandRoles(usage()), null);
});

test('proposeBrandRoles: surface is the top fill colour, look follows its lightness', () => {
  const dark = proposeBrandRoles(usage({ colors: [color('#151035', { fills: 9 }), color('#F23AE5', { fills: 5 })] }))!;
  assert.equal(dark.surface, '#151035');
  assert.equal(dark.surfaceLook, 'dark');
  assert.equal(dark.text, '#FFFFFF', 'no text runs → white on a dark surface');

  const light = proposeBrandRoles(usage({ colors: [color('#F9FAFF', { fills: 9 }), color('#F23AE5', { fills: 5 })] }))!;
  assert.equal(light.surface, '#F9FAFF');
  assert.equal(light.surfaceLook, 'light');
  assert.equal(light.text, '#000000', 'no text runs → black on a light surface');
});

test('proposeBrandRoles: the surface-shade exclusion is decisive for secondary', () => {
  // With the shade co-occurring beside the surface in a gradient, it leaves
  // the accent pool and the lower-scoring true accent becomes secondary.
  const excluded = proposeBrandRoles(usage({
    colors: QUARTET,
    gradients: [grad([['#151035', 0], ['#312470', 1]], 76)],
  }))!;
  assert.equal(excluded.primary, '#F23AE5');
  assert.equal(excluded.secondary, '#14CECA');
  assert.ok(!excluded.extras.includes('#312470'), 'the shade never reaches the pool');

  // Control: the SAME weights without the co-occurrence — the shade's higher
  // score wins, proving the exclusion (not the scores) made the call above.
  const kept = proposeBrandRoles(usage({
    colors: QUARTET,
    gradients: [grad([['#312470', 0], ['#FFFFFF', 1]], 76)],
  }))!;
  assert.equal(kept.secondary, '#312470');
});

test('proposeBrandRoles: scheme is the nearest named hue relationship', () => {
  const pair = (a: string, b: string) => proposeBrandRoles(usage({
    colors: [color('#111111', { fills: 9 }), color(a, { fills: 5 }), color(b, { fills: 4 })],
  }))!;
  assert.equal(pair('#FF0000', '#00FFFF').scheme, 'complement', 'a ~165 degree arc');
  assert.equal(pair('#FF0000', '#FFAA00').scheme, 'analogous', 'a ~44 degree arc');
  assert.equal(pair('#F23AE5', '#14CECA').scheme, 'triad', 'the keynote pair, a 139 degree arc');

  const lone = proposeBrandRoles(usage({ colors: [color('#111111', { fills: 9 }), color('#FF0000', { fills: 5 })] }))!;
  assert.equal(lone.secondary, null, 'one accent → no secondary');
  assert.equal(lone.scheme, 'mono');
});

test('proposeBrandRoles: text is the most frequent run colour that clears 4.5:1', () => {
  const roles = proposeBrandRoles(usage({
    colors: [
      color('#151035', { fills: 9, textRuns: 58 }),  // most runs, but 1:1 on itself
      color('#FFFFFF', { textRuns: 49 }),            // passes at ~18:1
      color('#F23AE5', { fills: 5, textRuns: 10 }),  // passes at ~5.6:1 but fewer runs
    ],
  }))!;
  assert.equal(roles.text, '#FFFFFF');
});

test('proposeFonts: brand by runs, mono by name, sources split', () => {
  const fonts = proposeFonts(usage({
    fonts: [
      font('gfont-work-sans', 'Work Sans', 10, 700),
      font('gfont-spline-sans-mono', 'Spline Sans Mono', 2, 700),
      font('custom-foo', 'Foo', 1),
    ],
  }));
  assert.equal(fonts.brand, 'Work Sans');
  assert.equal(fonts.mono, 'Spline Sans Mono');
  assert.deepEqual(fonts.google, ['Work Sans', 'Spline Sans Mono']);
  assert.deepEqual(fonts.missing, ['Foo']);

  assert.deepEqual(proposeFonts(usage()), { brand: null, mono: null, google: [], missing: [] });
});

test('buildBrandDocFromUsage: composes a resolvable doc with the observed roles', () => {
  const u = usage({
    colors: [...QUARTET, color('#C8A2FF', { fills: 24 }), color('#FF8800', { strokes: 12 })],
    gradients: [
      grad([['#151035', 0], ['#312470', 1]], 74, 180),
      grad([['#FF1EBD', 0], ['#BF98FF', 1]], 9, 180),
      grad([['#F23AE5', 0], ['#14CECA', 1]], 2, 270),
      grad([['#FFFFFF', 0], ['#FFFFFF', 1]], 1, 180),
    ],
    fonts: [
      font('gfont-work-sans', 'Work Sans', 10, 700),
      font('gfont-spline-sans-mono', 'Spline Sans Mono', 2, 700),
      font('custom-foo', 'Foo', 1),
    ],
  });
  const { doc, roles, fonts, gradientCount } = buildBrandDocFromUsage(u, 'Fixture', { keepExtras: ['#C8A2FF', '#00FF00'] });

  assert.equal(roles.primary, '#F23AE5');
  assert.equal(roles.secondary, '#14CECA');
  assert.ok(roles.extras.includes('#C8A2FF'));

  // The observed secondary is pinned as a LITERAL in both theme sets.
  for (const set of ['light', 'dark'] as const) {
    const leaf = ((doc[set] as any).color.semantic as any).secondary;
    assert.equal(leaf.$value, '#14CECA', `${set}: semantic secondary detached to the literal`);
  }

  // Only kept extras that were actually proposed become custom swatches.
  const custom = ((doc.base as any).color.custom ?? {}) as Record<string, unknown>;
  const customKeys = Object.keys(custom).filter(k => !k.startsWith('$'));
  assert.equal(customKeys.length, 1, 'the un-proposed keepExtras entry is ignored');

  // Top three gradients became tokens, angle riding the vendor extension.
  assert.equal(gradientCount, 3);
  const gradTokens = listStudioTokens(doc).filter(t => t.kind === 'gradient');
  assert.equal(gradTokens.length, 3);
  const g1 = gradTokens.find(t => t.key === 'gradient.file-gradient-1')!;
  assert.equal(g1.angle, 180);
  assert.deepEqual((g1.raw as Array<{ color: string }>).map(s => s.color), ['#151035', '#312470']);
  const g3 = gradTokens.find(t => t.key === 'gradient.file-gradient-3')!;
  assert.equal(g3.angle, 270);

  // Font roles ride the doc so carryUserFontTokens keeps them on install.
  assert.deepEqual((doc.base as any).font.brand.$value, ['Work Sans']);
  assert.deepEqual((doc.base as any).font.mono.$value, ['Spline Sans Mono']);
  assert.deepEqual(fonts.missing, ['Foo']);

  assert.throws(() => buildBrandDocFromUsage(usage(), 'Empty'), /No colours/);
});
