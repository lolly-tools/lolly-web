// SPDX-License-Identifier: MPL-2.0
/**
 * SVG `transform` → the EMF/EPS/DXF IR (svg-ir).
 *
 * The walk used to carry a translate+scale accumulator, so a `rotate()` on an
 * element (angled axis labels, word-cloud verticals, tilted groups) was silently
 * dropped and the mark exported axis-aligned. It now carries a full 2-D affine
 * matrix, so rotation/skew/matrix survive. These tests pin:
 *   • translate + scale still map exactly (byte-goldens cover the rest);
 *   • rotate(θ cx cy) lands geometry where the pivot rotation predicts;
 *   • rotation composes through a parent <g> transform.
 * A rect is used (no text shaping / host needed) — the maths is shared with the
 * outlined-text path, which maps every glyph point through the same closure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { svgDomToIr } from './svg-ir.ts';

async function irFromSvg(inner: string): Promise<{ minX: number; minY: number; maxX: number; maxY: number }> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${inner}</svg>`);
  const svg = dom.window.document.querySelector('svg');
  assert.ok(svg, 'fixture did not parse');
  const ir = await svgDomToIr(svg as unknown as Element, { background: '#ffffff' });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ir.prims) {
    if (p.type !== 'path') continue;
    for (const sub of p.subpaths) for (const s of sub.segments) {
      const c = s as { x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number };
      for (const [x, y] of [[c.x, c.y], [c.x1, c.y1], [c.x2, c.y2]] as [number | undefined, number | undefined][]) {
        if (typeof x === 'number' && Number.isFinite(x)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
        if (typeof y === 'number' && Number.isFinite(y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;

test('a plain rect maps to its own box (viewBox == canvas, region scale 1)', async () => {
  const b = await irFromSvg(`<rect x="10" y="10" width="10" height="10" fill="#000"/>`);
  assert.ok(near(b.minX, 10) && near(b.minY, 10) && near(b.maxX, 20) && near(b.maxY, 20),
    `box ${JSON.stringify(b)} should be ~[10,10,20,20]`);
});

test('translate + scale still compose exactly (backward compatibility)', async () => {
  // translate(30,0) scale(2) applies as x' = 2x+30, y' = 2y: the 10×10 box at
  // (10,10) → x 50..70, y 20..40 (identical to the pre-matrix accumulator).
  const b = await irFromSvg(`<rect x="10" y="10" width="10" height="10" transform="translate(30,0) scale(2)" fill="#000"/>`);
  assert.ok(near(b.minX, 50) && near(b.maxX, 70) && near(b.minY, 20) && near(b.maxY, 40),
    `box ${JSON.stringify(b)} should be ~[50,20,70,40]`);
});

test('rotate(180 cx cy) rotates the mark about the pivot (was dropped before)', async () => {
  // Rotating the (10..20, 10..20) square 180° about (50,50) sends it to (80..90, 80..90).
  const b = await irFromSvg(`<rect x="10" y="10" width="10" height="10" transform="rotate(180 50 50)" fill="#000"/>`);
  assert.ok(near(b.minX, 80) && near(b.minY, 80) && near(b.maxX, 90) && near(b.maxY, 90),
    `box ${JSON.stringify(b)} should be ~[80,80,90,90] under a 180° pivot rotation`);
});

test('rotate(90 cx cy) maps the square to the predicted quadrant', async () => {
  // (10,10)→(90,10), (20,20)→(80,20): x 80..90, y 10..20.
  const b = await irFromSvg(`<rect x="10" y="10" width="10" height="10" transform="rotate(90 50 50)" fill="#000"/>`);
  assert.ok(near(b.minX, 80) && near(b.maxX, 90) && near(b.minY, 10) && near(b.maxY, 20),
    `box ${JSON.stringify(b)} should be ~[80,10,90,20] under a 90° pivot rotation`);
});

test('rotation composes through a parent <g> transform', async () => {
  // Parent translate(50,0); child rotate(90 0 0) about the (translated) origin on a
  // 10×10 square at (0,0): local rotate(90) sends (0..10,0..10) → (-10..0, 0..10);
  // then +50 in x → x 40..50, y 0..10.
  const b = await irFromSvg(
    `<g transform="translate(50,0)"><rect x="0" y="0" width="10" height="10" transform="rotate(90 0 0)" fill="#000"/></g>`);
  assert.ok(near(b.minX, 40) && near(b.maxX, 50) && near(b.minY, 0) && near(b.maxY, 10),
    `box ${JSON.stringify(b)} should be ~[40,0,50,10] (g translate ∘ child rotate)`);
});
