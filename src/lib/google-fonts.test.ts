// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the css2 parser + subset filter (pure, no network).
 * Run directly:  node --test shells/web/src/lib/google-fonts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleFontCss, keepFaces, GOOGLE_FAMILY_RE } from './google-fonts.ts';

// A trimmed, structurally-faithful css2 response: variable font, three subsets.
const CSS_VARIABLE = `
/* cyrillic */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v13/cyr.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F;
}
/* latin-ext */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v13/ext.woff2) format('woff2');
  unicode-range: U+0100-02BA;
}
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v13/lat.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
`;

test('parses css2 blocks: family, weight range, subset, unicode-range, url', () => {
  const faces = parseGoogleFontCss(CSS_VARIABLE);
  assert.equal(faces.length, 3);
  const latin = faces.find(f => f.subset === 'latin')!;
  assert.equal(latin.family, 'Inter');
  assert.equal(latin.style, 'normal');
  assert.equal(latin.weight, '100 900');
  assert.equal(latin.url, 'https://fonts.gstatic.com/s/inter/v13/lat.woff2');
  assert.equal(latin.unicodeRange, 'U+0000-00FF');
});

test('keepFaces keeps latin + latin-ext, drops other subsets', () => {
  const kept = keepFaces(parseGoogleFontCss(CSS_VARIABLE));
  assert.deepEqual(kept.map(f => f.subset).sort(), ['latin', 'latin-ext']);
});

test('keepFaces keeps everything when css names no subsets', () => {
  const css = `@font-face { font-family: 'Solo'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/solo/a.woff2) format('woff2'); }`;
  const kept = keepFaces(parseGoogleFontCss(css));
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.weight, '400');
});

test('non-woff2 sources are skipped (legacy ttf fallback css)', () => {
  const css = `@font-face { font-family: 'Old'; src: url(https://fonts.gstatic.com/s/old/a.ttf) format('truetype'); }`;
  assert.equal(parseGoogleFontCss(css).length, 0);
});

test('family-name gate: plain names pass, injection shapes fail', () => {
  for (const ok of ['Inter', 'Source Sans 3', 'M PLUS Rounded 1c']) assert.ok(GOOGLE_FAMILY_RE.test(ok), ok);
  for (const bad of ['', ' Inter', "x'; url(", 'a{b}', 'font:family', 'x'.repeat(70)]) {
    assert.ok(!GOOGLE_FAMILY_RE.test(bad), JSON.stringify(bad));
  }
});
