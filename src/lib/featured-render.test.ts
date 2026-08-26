// SPDX-License-Identifier: MPL-2.0
/**
 * The missing-look fallback contract.
 *
 * Now the preview bundle is a MANIFEST, a pre-rendered look is a URL - and a URL can 404
 * (a look deleted from the catalog, a half-copied deploy, a manifest published ahead of its
 * previews). Every surface that paints one recovers the same way, through renderMissingLook,
 * and the whole recovery hinges on it asking under a namespace that does NOT consult the
 * manifest: asked the ordinary way it would hand straight back the URL that just failed and
 * the tile would settle on a broken <img> forever. Nothing throws when that regresses - the
 * tile just stays blank - so the two paths are pinned against each other here.
 *
 * No module mocking (the harness runs without --experimental-test-module-mocks): the REAL
 * renderFeaturedVariant runs, driven down its cache-HIT branch by a stub host.previews.get,
 * so it answers without importing the render engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFeaturedVariant, renderMissingLook, isManifestLook } from './featured-render.ts';

const SRC = '/catalog/previews/demo.look0.svg';   // what the manifest names
const THUMB = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';   // a live render
const VALUES = { headline: 'demo' };
const SIG = JSON.stringify(VALUES);

// loadPreviewBundle memoises its fetch for the life of the process, so the stub is installed
// once here rather than per test - and the tests below share the one manifest it answers with.
globalThis.fetch = (async () => ({
  ok: true,
  json: async () => ({ 'demo:0': { src: SRC, sig: SIG } }),
})) as unknown as typeof globalThis.fetch;

/** Records every cache key probed; always answers with a HIT for THUMB. */
function spyHost(keys: string[]) {
  return {
    previews: {
      get: async (key: string) => { keys.push(key); return { thumb: THUMB, sig: SIG }; },
      put: async () => {},
    },
  } as unknown as Parameters<typeof renderFeaturedVariant>[0];
}

test('isManifestLook separates a manifest URL from a live render', () => {
  assert.equal(isManifestLook(SRC), true);
  assert.equal(isManifestLook(THUMB), false, 'a data-URL is already the render - it cannot 404');
});

test('a bundled look comes from the manifest, before the engine or the preview cache', async () => {
  const keys: string[] = [];
  assert.equal(await renderFeaturedVariant(spyHost(keys), 'demo', ['svg'], 0, VALUES), SRC);
  assert.deepEqual(keys, [], 'the manifest answers first - no render, no cache probe');
});

test('renderMissingLook skips the manifest and renders live under its own namespace', async () => {
  const keys: string[] = [];
  const got = await renderMissingLook(spyHost(keys), 'demo', ['svg'], 0, VALUES);
  assert.notEqual(got, SRC, 'the fallback must not hand back the URL whose 404 triggered it');
  assert.equal(got, THUMB);
  // The namespace is what bypasses the manifest, AND it keeps the render: the next visit
  // 404s again and reuses this record instead of re-rendering.
  assert.deepEqual(keys, ['featured-missing:demo:0:svg']);
});
