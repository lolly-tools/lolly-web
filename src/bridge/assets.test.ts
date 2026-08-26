// SPDX-License-Identifier: MPL-2.0
/**
 * host.assets query type-matching (plans/162). The asset picker's catalog rail
 * used to hide items an input could accept - a motion (onFrame) tool's image slot
 * hid every catalog VIDEO while showing the user's own video uploads. The fix
 * threads `motion` through typeMatches so an `image` query admits video for a
 * motion slot, and the picker now trusts this narrowing instead of re-filtering.
 *
 * Run: node --test shells/web/src/bridge/assets.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeMatches } from './assets.ts';

test('an untyped query admits every type', () => {
  for (const t of ['raster', 'vector', 'video', 'audio', 'text', 'data', 'font']) {
    assert.equal(typeMatches(t, undefined), true, `${t} under no filter`);
  }
});

test('an exact type matches only itself', () => {
  assert.equal(typeMatches('audio', 'audio'), true);
  assert.equal(typeMatches('text', 'text'), true);
  assert.equal(typeMatches('data', 'data'), true);
  assert.equal(typeMatches('raster', 'audio'), false);
  assert.equal(typeMatches('video', 'audio'), false);
});

test('an image slot is the still-image superset (raster OR vector), not video', () => {
  assert.equal(typeMatches('raster', 'image'), true);
  assert.equal(typeMatches('vector', 'image'), true);
  assert.equal(typeMatches('video', 'image'), false, 'a still-image slot excludes video');
  assert.equal(typeMatches('audio', 'image'), false);
});

test('motion widens an image slot to also admit video (the catalog-video fix)', () => {
  assert.equal(typeMatches('video', 'image', true), true, 'a motion tool takes catalog video');
  assert.equal(typeMatches('raster', 'image', true), true, 'still images still admitted');
  assert.equal(typeMatches('vector', 'image', true), true);
  assert.equal(typeMatches('audio', 'image', true), false, 'motion does not admit audio');
  // motion only widens `image`; it never loosens an exact type.
  assert.equal(typeMatches('video', 'audio', true), false);
});
