// SPDX-License-Identifier: MPL-2.0
/**
 * NAV_SECTIONS - the profile settings index the spotlight settings provider
 * federates (plans/99 §2b). Guards:
 *
 *  1. Every exported section id exists as a real `id="…"` in the view's markup
 *     (a renamed card would leave search deep-linking a ghost anchor).
 *  2. The ?focus= deep link honours ANY NAV_SECTIONS id (widened from the old
 *     five-collapsible list for the provider), while the two legacy aliases
 *     (feature-flags, use-details) keep working.
 *  3. The rail matcher runs on lib/search (M3) - no private `.includes()` copy.
 *
 * Run directly:
 *   node --import ./tests/css-stub.mjs --test shells/web/src/views/profile-nav.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// jsdom globals BEFORE the dynamic import (profile.ts's import graph expects a
// window) - the search-bar.test.ts convention.
const dom = new JSDOM('<!doctype html><html><body><main id="view"></main></body></html>', { url: 'https://lolly.tools/' });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const { NAV_SECTIONS } = await import('./profile.ts');
const PROFILE_SRC = readFileSync(fileURLToPath(new URL('./profile.ts', import.meta.url)), 'utf8');

test('NAV_SECTIONS is exported, well-formed and unique', () => {
  assert.ok(NAV_SECTIONS.length >= 9, 'all settings sections listed');
  const ids = NAV_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  for (const s of NAV_SECTIONS) {
    assert.ok(s.id.endsWith('-section'), `${s.id} follows the -section convention`);
    assert.ok(s.label.trim(), `${s.id} has a label`);
    assert.ok(s.keywords.trim(), `${s.id} has search keywords`);
  }
});

test('every NAV_SECTIONS id is a section id in the rendered markup', () => {
  for (const s of NAV_SECTIONS) {
    assert.ok(PROFILE_SRC.includes(`id="${s.id}"`), `markup carries id="${s.id}"`);
  }
});

test('?focus= honours ANY NAV_SECTIONS id, not a hard-coded list', () => {
  assert.ok(
    PROFILE_SRC.includes('NAV_SECTIONS.some(s => s.id === focusParam)'),
    'the deep-link gate is the exported registry itself',
  );
  // The widened handler must open a collapsible before scrolling.
  assert.ok(PROFILE_SRC.includes('sec instanceof HTMLDetailsElement'), 'collapsibles still auto-open');
  // Legacy aliases the gallery links by (no -section suffix) stay handled.
  assert.ok(PROFILE_SRC.includes("focusParam === 'feature-flags'"), 'feature-flags alias kept');
  assert.ok(PROFILE_SRC.includes("focusParam === 'use-details'"), 'use-details alias kept');
});

test('the rail search runs on lib/search, with no private matcher left', () => {
  assert.ok(PROFILE_SRC.includes("from '../lib/search/match.ts'"), 'imports the shared matcher');
  assert.ok(PROFILE_SRC.includes('scoreHaystack(['), 'scores via scoreHaystack');
  assert.ok(!PROFILE_SRC.includes('hay.includes('), 'the old .includes() copy is gone');
});
