// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the chrome half of the brand var contract: the HSL-triple
 * conversion and the injected-stylesheet builder. DOM-free (the application
 * function is thin glue over these).
 * Run directly:  node --test shells/web/src/brand-vars.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToHslTriple, chromeBrandCss, brandThemeCss, brandFontStack, brandRadiusValue } from './brand-vars.ts';

const SANS_TAIL = "'Outfit', ui-sans-serif, system-ui, sans-serif";

test('brandFontStack builds a safe stack ending in the platform tail', () => {
  assert.equal(brandFontStack('SUSE', SANS_TAIL), `'SUSE', ${SANS_TAIL}`);
  // A brand naming a platform default doesn't duplicate it in the tail
  // (SUSE's font.mono is 'SUSE Mono' — the mono tail's own first family).
  assert.equal(
    brandFontStack('SUSE Mono', "'SUSE Mono', ui-monospace, monospace"),
    "'SUSE Mono', ui-monospace, monospace",
  );
  assert.equal(brandFontStack('Outfit', SANS_TAIL), SANS_TAIL); // same family, same stack
  // DTCG fontFamily array form; quotes on names are stripped before re-quoting.
  assert.equal(brandFontStack(['"Inter"', 'Roboto Flex'], SANS_TAIL), `'Inter', 'Roboto Flex', ${SANS_TAIL}`);
  // Nothing usable → null (slot treated as missing; :root default stands).
  assert.equal(brandFontStack(undefined, SANS_TAIL), null);
  assert.equal(brandFontStack('', SANS_TAIL), null);
  assert.equal(brandFontStack('{font.brand}', SANS_TAIL), null); // alias residue
  assert.equal(brandFontStack(42, SANS_TAIL), null);
});

test('brandFontStack rejects families that could smuggle CSS', () => {
  // The value comes from an untrusted imported tokens doc and lands in a style
  // value — anything beyond plain name characters must be dropped.
  assert.equal(brandFontStack("x'; background:url(//evil)", SANS_TAIL), null);
  assert.equal(brandFontStack('a}*{color:red', SANS_TAIL), null);
  assert.equal(brandFontStack('url(//evil.example/f.woff2)', SANS_TAIL), null);
  // A hostile entry in an array is dropped; the clean one survives.
  assert.equal(brandFontStack(['Inter', 'x;y'], SANS_TAIL), `'Inter', ${SANS_TAIL}`);
});

test('brandRadiusValue accepts a plain CSS length in rem/px/em', () => {
  assert.equal(brandRadiusValue('0.5rem'), '0.5rem');
  assert.equal(brandRadiusValue('0rem'), '0rem');
  assert.equal(brandRadiusValue('12px'), '12px');
  assert.equal(brandRadiusValue('1em'), '1em');
});

test('brandRadiusValue rejects anything that isn\'t a bare length', () => {
  assert.equal(brandRadiusValue(undefined), null);
  assert.equal(brandRadiusValue(''), null);
  assert.equal(brandRadiusValue('{shape.radius}'), null); // alias residue
  assert.equal(brandRadiusValue('1rem; background:url(//evil)'), null); // CSS smuggling
  assert.equal(brandRadiusValue('calc(1rem + 1px)'), null); // not a bare length
  assert.equal(brandRadiusValue('1vw'), null); // unit not in the allowed set
  assert.equal(brandRadiusValue('-1rem'), null); // negative — meaningless for a radius
  assert.equal(brandRadiusValue(-1), null); // wrong type entirely (a number, not a string)
});

test('hexToHslTriple produces shadcn "H S% L%" triples', () => {
  assert.equal(hexToHslTriple('#000000'), '0 0% 0%');
  assert.equal(hexToHslTriple('#ffffff'), '0 0% 100%');
  assert.equal(hexToHslTriple('#ff0000'), '0 100% 50%');
  // SUSE Jungle #30ba78 — the triple tokens.css derived its dark-theme accent from.
  assert.equal(hexToHslTriple('#30ba78'), '151.3 59% 45.9%');
  assert.equal(hexToHslTriple('not-a-hex'), null);
  assert.equal(hexToHslTriple('#fff'), null); // 6-digit only — resolver output is normalised
});

test('chromeBrandCss emits light/dark accent blocks plus the constructed brand theme', () => {
  const css = chromeBrandCss(
    { primary: '#1c1c22', onPrimary: '#f7f7f5' },
    { primary: '#f7f7f5', onPrimary: '#1c1c22' },
  );
  assert.ok(css.includes(':root, [data-theme="light"]'));
  assert.ok(css.includes('[data-theme="dark"] {'));
  assert.ok(css.includes('[data-theme="brand"] {'));
  assert.ok(css.includes('--primary:'));
  assert.ok(css.includes('--primary-foreground:'));
  // --ring follows --primary in all three blocks (tokens.css couples them).
  assert.equal((css.match(/--ring:/g) ?? []).length, 3);
});

test('brandThemeCss constructs the full mid-toned chrome from the two primaries', () => {
  // The SUSE palette itself: surfaces from Pine, accent Jungle — the construction
  // should land in the neighbourhood of the static tokens.css block.
  const css = brandThemeCss('#0c322c', '#30ba78', '#08211d');
  for (const name of ['background', 'foreground', 'card', 'popover', 'muted', 'secondary',
    'accent', 'border', 'input', 'ring', 'primary', 'primary-foreground',
    'store-1', 'store-4', 'store-other']) {
    assert.ok(css.includes(`--${name}:`), `constructs --${name}`);
  }
  assert.ok(css.includes('color-scheme: dark'));
  // Every emitted value is a valid "H S% L%" triple.
  for (const m of css.matchAll(/--[\w-]+: ([^;]+);/g)) {
    assert.match(m[1]!, /^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/, `${m[0]} is a triple`);
  }
  // The accent passes through verbatim as Jungle's triple; the background is a
  // mid-dark Pine-hued surface (hue within a few degrees of Pine's 171).
  assert.ok(css.includes('--primary: 151.3 59% 45.9%'));
  const bg = /--background: ([\d.]+) ([\d.]+)% ([\d.]+)%/.exec(css)!;
  assert.ok(Math.abs(parseFloat(bg[1]!) - 171) < 12, `background hue ${bg[1]} ≈ Pine`);
  const bgL = parseFloat(bg[3]!);
  assert.ok(bgL > 6 && bgL < 22, `background stays mid-dark (${bgL}%)`);
  // A neutral (ink) brand constructs a *grey* chrome — low saturation everywhere.
  const neutral = brandThemeCss('#0e1217', '#f3f5f8', '#0e1217');
  const sats = [...neutral.matchAll(/--(?:background|card|muted|border): [\d.]+ ([\d.]+)%/g)].map(m => parseFloat(m[1]!));
  assert.ok(sats.length >= 4 && sats.every(s => s < 20), `neutral brand stays near-grey (${sats.join(', ')})`);
});

test('an unresolvable primary yields no block; both missing yields empty css', () => {
  const darkOnly = chromeBrandCss({ primary: null, onPrimary: null }, { primary: '#f7f7f5', onPrimary: null });
  assert.ok(!darkOnly.includes('[data-theme="light"]'));
  assert.ok(darkOnly.includes('[data-theme="dark"]'));
  assert.ok(!darkOnly.includes('--primary-foreground:'), 'missing on-primary leaves the foreground override out');
  assert.equal(chromeBrandCss({ primary: null, onPrimary: null }, { primary: null, onPrimary: null }), '');
});
