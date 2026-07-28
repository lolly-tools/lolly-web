// SPDX-License-Identifier: MPL-2.0
/*
 * gamut-slider.ts — the broken OKLCH axis, and the onion rings on it.
 *
 * Run directly:  node --test shells/web/src/lib/gamut-slider.test.ts
 *
 * What matters here is that this surface and the picker's tracks share ONE tier
 * model (engine/src/gamut-tier.ts): a stretch the limit cannot show is still
 * painted, at the tier of the narrowest gamut that CAN show it. Written after the
 * fact — the module had no coverage at all — so it pins the intent rather than the
 * numbers: the opacities live in CSS tokens and are meant to be tuned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;

const { gamutRuns, renderGamutSlider, paintGamutSlider } = await import('./gamut-slider.ts');
const { BEYOND_TIER, inGamut } = await import('@lolly/engine');
import type { GamutSliderState } from './gamut-slider.ts';

/** A chroma axis at a mid-lightness blue: reachable near grey, then out. */
const CHROMA: GamutSliderState = { channel: 'c', base: { l: 0.62, c: 0.19, h: 260 }, limit: 'srgb' };
/** A hue axis at a chroma some hues hold and others do not. */
const HUE: GamutSliderState = { channel: 'h', base: { l: 0.6, c: 0.22, h: 0 }, limit: 'srgb' };

test('a run carries HOW FAR out it is, not merely that it is out', () => {
  const runs = gamutRuns(CHROMA);
  assert.ok(runs.length >= 2, 'the axis must break somewhere');
  assert.equal(runs[0]!.tier, 0, 'the axis starts at grey, which every gamut holds');
  assert.ok(runs.some(r => r.tier > 0), 'and the unreachable part is a RING, not a hole');
  // Every run still carries colours to paint across it — a wash shades in the
  // direction the axis is going rather than flat-lining at the boundary colour.
  for (const r of runs) {
    assert.ok(r.to > r.from, 'no zero-width runs');
    assert.ok(r.stops.length >= 1 && r.stops.every(s => /^#[0-9a-f]{6}$/i.test(s)), JSON.stringify(r.stops));
  }
  // Contiguous, so the axis reads as one axis.
  for (let i = 0; i + 1 < runs.length; i++) assert.equal(runs[i]!.to, runs[i + 1]!.from);
});

test('the tiers come from membership, so sRGB is never a ring under a P3 limit', () => {
  // Same rule the classifier is pinned on in tests/gamut-tier.test.ts, asserted
  // through this surface: a true subset answers tier 0 and can never be a wash.
  for (const r of gamutRuns({ ...HUE, limit: 'p3' })) {
    if (r.tier === 0) continue;
    const mid = (r.from + r.to) / 2 * 360;
    assert.equal(inGamut(HUE.base.l, HUE.base.c, mid, 'srgb'), false,
      `hue ${mid.toFixed(0)}° is inside sRGB, so it cannot be a ring under a P3 limit`);
  }
  // Under sRGB the same axis shows more than one ring — the onion.
  const tiers = new Set(gamutRuns(HUE).map(r => r.tier));
  assert.ok(tiers.has(1) && tiers.has(2), `expected two rings, got ${[...tiers].join(',')}`);
  assert.ok(tiers.has(BEYOND_TIER), 'and hues no display holds at this chroma');
});

test('a segment states its ring as a CSS token, and tier 0 states nothing', () => {
  const root = document.getElementById('mount')!;
  root.innerHTML = renderGamutSlider('gs', HUE, 200);
  paintGamutSlider(root.querySelector('.gsl')!, HUE, 200);
  const segs = [...root.querySelectorAll<HTMLElement>('.gsl-seg')];
  assert.ok(segs.length >= 3, `expected several segments, got ${segs.length}`);
  const solid = segs.filter(s => !s.style.getPropertyValue('--seg-a'));
  const washed = segs.filter(s => s.style.getPropertyValue('--seg-a'));
  assert.ok(solid.length >= 1, 'the reachable arcs carry no alpha override at all');
  assert.ok(washed.length >= 1, 'the unreachable ones do');
  // The VALUE is a var() into the shared scale, never a number baked in here: the
  // wash brightness is a design judgement, tunable in styles/tokens.css.
  for (const s of washed) {
    assert.match(s.style.getPropertyValue('--seg-a'), /^var\(--track-tier-(\d+|beyond),/);
    assert.ok(!/opacity/.test(s.getAttribute('style') ?? ''), 'no literal opacity on the element');
  }
  // …and more than one distinct ring is named across the axis.
  const named = new Set(washed.map(s => s.style.getPropertyValue('--seg-a')));
  assert.ok(named.size >= 2, `expected different rings, got ${[...named].join(' / ')}`);
  // The out-of-gamut MARK is about the current value, not about the axis, and it
  // stays exactly as it was.
  assert.equal(root.querySelector('.gsl')!.classList.contains('is-out'),
    !inGamut(HUE.base.l, HUE.base.c, 200, 'srgb'));
});

test('the wash opacity defaults to fully opaque, for the non-gamut sliders', () => {
  // views/color-lab.ts hand-builds a .gsl-seg for the blend-steps gradient preview.
  // It is not a gamut axis and must not be washed, which is why `.gsl-seg` reads
  // `opacity: var(--seg-a, 100%)` rather than defaulting to a wash.
  const css = readFileSync(new URL('./oklch-slice.css', import.meta.url), 'utf8');
  assert.match(css, /opacity:\s*var\(--seg-a,\s*100%\)/, 'the 100% default keeps the blend preview opaque');
  assert.ok(!/gsl-seg--ghost/.test(css), 'the single flat ghost class is retired');
});
