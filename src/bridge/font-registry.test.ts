// SPDX-License-Identifier: MPL-2.0
/**
 * Font-registry unit tests — the pure resolution logic that decides WHICH face
 * outlines a run: family-stack parsing, unicode-range coverage, and face/axis
 * selection. The IndexedDB + woff2-decompression halves are exercised
 * end-to-end in the browser (see the export verification), not here.
 *
 * Run directly:  node --test shells/web/src/bridge/font-registry.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFontFamilies, parseUnicodeRange, rangesCover, pickFace } from './font-registry.ts';

// ── parseFontFamilies ────────────────────────────────────────────────────────

test('splits a computed font-family stack, unquoted, in cascade order', () => {
  assert.deepEqual(
    parseFontFamilies("'Space Grotesk', Outfit, ui-sans-serif, system-ui"),
    ['Space Grotesk', 'Outfit', 'ui-sans-serif', 'system-ui'],
  );
  assert.deepEqual(parseFontFamilies('"SUSE Mono", ui-monospace'), ['SUSE Mono', 'ui-monospace']);
  assert.deepEqual(parseFontFamilies('Inter'), ['Inter']);
  assert.deepEqual(parseFontFamilies(undefined), []);
  assert.deepEqual(parseFontFamilies('  '), []);
});

test('a comma inside a quoted family name does not split it', () => {
  assert.deepEqual(parseFontFamilies(`"Ye Olde, Face", serif`), ['Ye Olde, Face', 'serif']);
});

// ── parseUnicodeRange / rangesCover ──────────────────────────────────────────

test('parses the three unicode-range forms: range, single, wildcard', () => {
  assert.deepEqual(parseUnicodeRange('U+0-7F'), [[0x0, 0x7f]]);
  assert.deepEqual(parseUnicodeRange('U+2212'), [[0x2212, 0x2212]]);
  assert.deepEqual(parseUnicodeRange('U+4??'), [[0x400, 0x4ff]]);
  assert.deepEqual(parseUnicodeRange('U+0-FF, U+131, U+152-153'), [[0, 0xff], [0x131, 0x131], [0x152, 0x153]]);
  assert.deepEqual(parseUnicodeRange(''), []);
  assert.deepEqual(parseUnicodeRange(undefined), []);
});

test('coverage: latin subset covers ASCII, not latin-ext; whitespace ignored', () => {
  const latin = parseUnicodeRange('U+0000-00FF');
  assert.equal(rangesCover(latin, 'Hello World'), true);
  assert.equal(rangesCover(latin, 'Ærø'), true);          // U+00C6/U+00F8 are in latin
  assert.equal(rangesCover(latin, 'Ĳsselmeer'), false);   // U+0132 is latin-ext
  assert.equal(rangesCover(latin, 'привет'), false);      // cyrillic
});

test('an empty range list means an unsubsetted face — covers everything', () => {
  assert.equal(rangesCover([], 'anything 漢字 ✓'), true);
});

test('astral codepoints are read whole (surrogate pairs), not per unit', () => {
  const bmp = parseUnicodeRange('U+0000-FFFF');
  assert.equal(rangesCover(bmp, '😀'), false); // U+1F600 sits above the BMP
});

// ── pickFace ─────────────────────────────────────────────────────────────────

const face = (o: Partial<Parameters<typeof pickFace>[0][number]>) => ({
  assetId: 'a', staticUrl: '', weight: '400', style: 'normal', unicodeRange: '', ...o,
} as Parameters<typeof pickFace>[0][number]);

test('a variable face wins and carries the run weight as a wght axis', () => {
  const faces = [face({ weight: '100 900' })];
  const hit = pickFace(faces, { fontFamily: 'X', fontWeight: '700' }, 'Hi');
  assert.deepEqual(hit?.variations, ['wght=700']);
});

test('the wght axis is clamped to the face range', () => {
  const faces = [face({ weight: '300 600' })];
  assert.deepEqual(pickFace(faces, { fontFamily: 'X', fontWeight: '900' }, 'Hi')?.variations, ['wght=600']);
  assert.deepEqual(pickFace(faces, { fontFamily: 'X', fontWeight: '100' }, 'Hi')?.variations, ['wght=300']);
});

test('static faces: the nearest weight wins, with no variations', () => {
  const faces = [face({ assetId: 'r', weight: '400' }), face({ assetId: 'b', weight: '700' })];
  const bold = pickFace(faces, { fontFamily: 'X', fontWeight: '600' }, 'Hi');
  assert.equal(bold?.face.assetId, 'b');
  assert.equal(bold?.variations, undefined);
  assert.equal(pickFace(faces, { fontFamily: 'X', fontWeight: '500' }, 'Hi')?.face.assetId, 'r');
});

test('missing weight defaults to 400', () => {
  const faces = [face({ assetId: 'r', weight: '400' }), face({ assetId: 'b', weight: '700' })];
  assert.equal(pickFace(faces, { fontFamily: 'X' }, 'Hi')?.face.assetId, 'r');
});

test('the face is chosen by unicode coverage of the actual run', () => {
  const faces = [
    face({ assetId: 'latin', weight: '100 900', unicodeRange: 'U+0000-00FF' }),
    face({ assetId: 'ext', weight: '100 900', unicodeRange: 'U+0100-024F' }),
  ];
  assert.equal(pickFace(faces, { fontFamily: 'X' }, 'Hello')?.face.assetId, 'latin');
  assert.equal(pickFace(faces, { fontFamily: 'X' }, 'Ĳssel')?.face.assetId, 'ext');
  // A run straddling both subsets has no single covering face → caller falls back.
  assert.equal(pickFace(faces, { fontFamily: 'X' }, 'HelloĲ'), null);
});

test('italic runs never borrow an upright face (they would un-slant silently)', () => {
  const faces = [face({ weight: '100 900', style: 'normal' })];
  assert.equal(pickFace(faces, { fontFamily: 'X', fontStyle: 'italic' }, 'Hi'), null);
  assert.equal(pickFace(faces, { fontFamily: 'X', fontStyle: 'oblique' }, 'Hi'), null);
  assert.ok(pickFace(faces, { fontFamily: 'X', fontStyle: 'normal' }, 'Hi'));
});

test('an italic face serves an italic run', () => {
  const faces = [face({ assetId: 'i', weight: '400', style: 'italic' })];
  assert.equal(pickFace(faces, { fontFamily: 'X', fontStyle: 'italic' }, 'Hi')?.face.assetId, 'i');
});
