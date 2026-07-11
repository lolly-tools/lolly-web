// Unit tests for i18n.ts's persist-time URL handling (and the RTL dir stamp).
//
// A `lang` URL override is session-only and out-ranks the saved preference in
// initI18n's precedence chain — so an explicit picker choice must strip it from
// the address bar (both places peekUrlLang reads: the search string and the
// hash query), or the switch appears not to stick on any ?lang= link.
//
// i18n.ts only touches window/document/localStorage inside functions, so plain
// object stubs installed before the dynamic import are enough — no jsdom. The
// 'en' switch is used for the strip cases because it skips the locale-chunk
// dynamic import entirely; the 'ar' case relies on that import's .catch(() =>
// ({default:{}})) fallback (node can't import .json without attributes), which
// still exercises the <html dir> stamp.
import test from 'node:test';
import assert from 'node:assert/strict';

const replaceCalls: string[] = [];
const win = {
  location: new URL('http://lolly.test/'),
  history: { state: null, replaceState: (_s: unknown, _t: string, next: string) => { replaceCalls.push(next); } },
};
globalThis.window = win as unknown as typeof globalThis.window;
globalThis.history = win.history as unknown as History; // i18n.ts uses the bare `history` global
globalThis.document = { documentElement: { lang: '', dir: '' } } as unknown as Document;
globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;

const { setActiveLang } = await import('./i18n.ts');

async function stripped(url: string): Promise<string | null> {
  win.location = new URL(url);
  replaceCalls.length = 0;
  await setActiveLang('en', { persist: true });
  return replaceCalls[0] ?? null;
}

test('persist strips a search-string lang override', async () => {
  assert.equal(await stripped('http://lolly.test/?lang=de#/p'), '/#/p');
});

test('persist strips a hash-query lang override', async () => {
  assert.equal(await stripped('http://lolly.test/#/p?lang=de'), '/#/p');
});

test('persist strips lang from both places at once', async () => {
  assert.equal(await stripped('http://lolly.test/?lang=de#/p?lang=de'), '/#/p');
});

test('other params ride through byte-identical (compact URL-mode encodings)', async () => {
  assert.equal(
    await stripped('http://lolly.test/?a=1&lang=de&b=2#/tool/qr-code?url=https%3A%2F%2Fs.com&lang=de&color=ff0~00'),
    '/?a=1&b=2#/tool/qr-code?url=https%3A%2F%2Fs.com&color=ff0~00',
  );
});

test('a bare valueless ?lang is stripped too', async () => {
  assert.equal(await stripped('http://lolly.test/?lang#/p'), '/#/p');
});

test('params merely ending in "lang" are not false-positives', async () => {
  assert.equal(await stripped('http://lolly.test/?slang=de#/p?golang=1'), null);
});

test('no lang override ⇒ no history rewrite at all', async () => {
  assert.equal(await stripped('http://lolly.test/#/p'), null);
});

test('non-persist switches never touch the URL', async () => {
  win.location = new URL('http://lolly.test/?lang=de#/p');
  replaceCalls.length = 0;
  await setActiveLang('en', { persist: false });
  assert.equal(replaceCalls.length, 0);
});

test('<html dir> stamps rtl for Arabic and restores ltr on the way back', async () => {
  const doc = document.documentElement;
  await setActiveLang('ar', { persist: false }); // catalog import fails under node — caught, empty catalog
  assert.equal(doc.lang, 'ar');
  assert.equal(doc.dir, 'rtl');
  await setActiveLang('de', { persist: false });
  assert.equal(doc.dir, 'ltr');
});
