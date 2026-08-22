// SPDX-License-Identifier: MPL-2.0
/**
 * NAV_SECTIONS - the profile settings index the spotlight settings provider
 * federates (plans/99 section 2b). Guards:
 *
 *  1. Every exported section id exists as a real `id="…"` in the view's markup
 *     (a renamed card would leave search deep-linking a ghost anchor).
 *  2. The ?focus= deep link honours ANY NAV_SECTIONS id (widened from the old
 *     five-collapsible list for the provider), while the two legacy aliases
 *     (feature-flags, use-details) keep working.
 *  3. The rail matcher runs on lib/search (M3) - no private `.includes()` copy.
 *  4. (plans/137 D2) All three recognised focus targets share ONE highlight
 *     path (pulseHighlight) - before this, only use-details got a visible
 *     pulse; feature-flags and the generic NAV_SECTIONS path scrolled with no
 *     highlight at all, so the deep link arrived with nothing to notice.
 *  5. pulseHighlight respects prefers-reduced-motion: a static ring that fades
 *     via a plain transition, never the animated keyframe.
 *  6. (plans/137 D1) The empty-state headshot circle row-scales down at
 *     <=640px so First name reaches the first screen; a set photo keeps the
 *     full-size circle.
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
const CSS_SRC = readFileSync(fileURLToPath(new URL('../styles/parts/profile.css', import.meta.url)), 'utf8');

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

test('all three recognised ?focus= targets share one highlight call site (plans/137 D2)', () => {
  // Was three separate branches, only one of which (use-details) added a pulse
  // class - feature-flags and the generic NAV_SECTIONS path scrolled silently.
  assert.match(PROFILE_SRC, /function pulseHighlight\(/, 'a named helper exists');
  const calls = PROFILE_SRC.split('pulseHighlight(sec)').length - 1;
  assert.equal(calls, 1, 'exactly one call site drives all three focus branches');
});

test('pulseHighlight respects prefers-reduced-motion with a fade, not just a static swap', () => {
  assert.ok(PROFILE_SRC.includes('prefersReducedMotion()'), 'branches on the shared a11y pref');
  assert.ok(PROFILE_SRC.includes('is-focus-pulse-out'), 'a distinct fade-out step under reduced motion');
});

test('the .is-focus-pulse CSS: an animated ring normally, a transitioned static ring under reduced motion', () => {
  assert.ok(
    CSS_SRC.includes('.profile-view .is-focus-pulse { animation: profile-focus-pulse 1.1s ease-out 2; }'),
    'the default rule animates',
  );
  const reducedRuleAt = CSS_SRC.indexOf('.profile-view .is-focus-pulse {\n    animation: none;');
  assert.notEqual(reducedRuleAt, -1, 'a reduced-motion override exists for .is-focus-pulse');
  const reducedRule = CSS_SRC.slice(reducedRuleAt, reducedRuleAt + 200);
  assert.match(reducedRule, /transition:\s*box-shadow/, 'the static ring fades via a plain transition, not a keyframe');
});

test('empty-state headshot row-scales at <=640px; a set photo keeps the full circle (plans/137 D1)', () => {
  const phoneBlock = CSS_SRC.slice(CSS_SRC.indexOf('@media (max-width: 640px)'));
  assert.match(
    phoneBlock,
    /\.headshot:has\(\.headshot-preview\.is-empty\)\s*\{\s*width:\s*56px;\s*height:\s*56px;/,
    'the circle shrinks only when the :has(.is-empty) match fires',
  );
  // Scoped to .is-empty, so a headshot that's actually set (no .is-empty class)
  // never matches this rule and keeps the full 200px circle from the base rule.
  assert.ok(!/\.headshot\s*\{[^}]*width:\s*56px/.test(CSS_SRC), 'the unscoped .headshot rule is untouched');
});
