// SPDX-License-Identifier: MPL-2.0
/**
 * The Catalogue view's selection model (views/catalog-filter.ts).
 *
 * views/catalog.ts was the largest fully-untested view in the shell — 3,563
 * lines, one 3,078-line mountCatalog, zero tests (maintainability-2026-07-29.md
 * item 2). These are the rules that decide what a user can see, search and bulk
 * DELETE, so the consequential cases here are the ones about a selection
 * outliving the thing it selected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesType, visibleAssets, buildSearchHaystack, matchesQuery,
  favItems, selectableIds, pruneSelection, TYPE_FILTER_TYPES,
  type TypeFilter,
} from './catalog-filter.ts';
import type { AssetRef } from '@lolly-tools/core/host-v1';

/** Minimal asset; only the fields this module reads. */
const A = (id: string, over: Partial<AssetRef> = {}): AssetRef => ({
  source: 'library', id, type: 'raster', format: 'png', url: '',
  ...over,
} as AssetRef);

/** The real base-id rule: everything before a `?modifier`. */
const baseId = (id: string): string => id.split('?')[0] as string;
const cat = (): string => 'Logos';

// ── filetype filter ──────────────────────────────────────────────────────────

test("'all' admits every type, including one no bucket lists", () => {
  for (const t of ['raster', 'vector', 'video', 'lottie', 'audio', 'tokens', 'font']) {
    assert.equal(matchesType(A('x', { type: t as AssetRef['type'] }), 'all'), true, t);
  }
});

test('each bucket admits exactly its own types', () => {
  assert.equal(matchesType(A('a', { type: 'raster' }), 'image'), true);
  assert.equal(matchesType(A('a', { type: 'vector' }), 'image'), false);
  assert.equal(matchesType(A('a', { type: 'vector' }), 'vector'), true);
  // motion is the one bucket with two members — a regression that dropped either
  // would hide half the animated catalogue behind a filter that looks correct.
  assert.equal(matchesType(A('a', { type: 'video' }), 'motion'), true);
  assert.equal(matchesType(A('a', { type: 'lottie' }), 'motion'), true);
  assert.equal(matchesType(A('a', { type: 'audio' }), 'audio'), true);
  assert.equal(matchesType(A('a', { type: 'audio' }), 'motion'), false);
});

test('a type in no bucket is hidden by every filter except all', () => {
  const tokens = A('t', { type: 'tokens' });
  for (const f of ['image', 'vector', 'motion', 'audio'] as TypeFilter[]) {
    assert.equal(matchesType(tokens, f), false, f);
  }
});

test('the buckets are disjoint (no type admitted by two filters)', () => {
  const seen = new Map<string, string>();
  for (const [bucket, types] of Object.entries(TYPE_FILTER_TYPES)) {
    for (const t of types) {
      assert.equal(seen.has(t), false, `${t} is admitted by both ${seen.get(t)} and ${bucket}`);
      seen.set(t, bucket);
    }
  }
});

// ── hiding ───────────────────────────────────────────────────────────────────

test('hiding is keyed by BASE id, so it hides every modified variant too', () => {
  // The trap: hide `logo/primary` but leave `logo/primary?theme=dark` on screen,
  // and the user cannot get rid of a mark they explicitly hid.
  const assets = [A('logo/primary'), A('logo/primary?theme=dark'), A('logo/alt')];
  const out = visibleAssets(assets, new Set(['logo/primary']), baseId);
  assert.deepEqual(out.map((a) => a.id), ['logo/alt']);
});

test('an empty hidden set changes nothing', () => {
  const assets = [A('a'), A('b')];
  assert.deepEqual(visibleAssets(assets, new Set(), baseId).map((a) => a.id), ['a', 'b']);
});

// ── search ───────────────────────────────────────────────────────────────────

test('the haystack indexes name, id, tags, category and format', () => {
  const a = A('brand/mark', { format: 'svg', meta: { name: 'Primary Mark', tags: ['hero', 'dark'] } } as Partial<AssetRef>);
  const hay = buildSearchHaystack([a], cat);
  const s = hay.get('brand/mark') ?? '';
  for (const needle of ['primary mark', 'brand/mark', 'hero', 'dark', 'logos', 'svg']) {
    assert.ok(s.includes(needle), `haystack is missing "${needle}": ${s}`);
  }
});

test('an empty query matches everything — search is a filter, not a mode', () => {
  const a = A('a');
  const hay = buildSearchHaystack([a], cat);
  assert.equal(matchesQuery(a, '', hay), true);
});

test('an asset missing from the index simply does not match, rather than throwing', () => {
  assert.equal(matchesQuery(A('never-indexed'), 'x', new Map()), false);
});

test('search falls back to type when an asset has no format', () => {
  const a = A('a', { format: undefined, type: 'audio' } as Partial<AssetRef>);
  const hay = buildSearchHaystack([a], cat);
  assert.ok((hay.get('a') ?? '').includes('audio'));
});

test('an asset with no meta at all still indexes without throwing', () => {
  const a = A('bare', { meta: undefined } as Partial<AssetRef>);
  const hay = buildSearchHaystack([a], cat);
  assert.ok((hay.get('bare') ?? '').includes('bare'));
});

// ── favourites ───────────────────────────────────────────────────────────────

test('favourites dedupe by base id, keeping the FIRST (catalog beats user)', () => {
  // The view passes catalog assets first, so the catalog copy must win — otherwise
  // a user upload sharing a base id shows the mark twice in the favourites strip.
  const visible = [
    A('logo/primary', { source: 'library' }),
    A('logo/primary', { source: 'user' }),
  ];
  const out = favItems(visible, new Set(['logo/primary']), baseId);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.source, 'library');
});

test('a favourited modified variant is matched by its base id', () => {
  const visible = [A('logo/primary?theme=dark')];
  assert.equal(favItems(visible, new Set(['logo/primary']), baseId).length, 1);
});

test('nothing favourited yields nothing', () => {
  assert.deepEqual(favItems([A('a'), A('b')], new Set(), baseId), []);
});

// ── selectable + prune: the consequential pair ───────────────────────────────

const userA = A('u1', { source: 'user' });
const userB = A('u2', { source: 'user', type: 'vector' });
const libA = A('c1', { source: 'library' });

test('only user-owned assets are selectable — catalog assets cannot be bulk-deleted', () => {
  const visible = [userA, libA];
  const hay = buildSearchHaystack(visible, cat);
  const ids = selectableIds(visible, { query: '', haystack: hay, typeFilter: 'all' });
  assert.deepEqual([...ids], ['u1']);
});

test('a search narrows what is selectable, so a bulk action cannot touch what is hidden', () => {
  const visible = [userA, userB];
  const hay = buildSearchHaystack(visible, cat);
  const ids = selectableIds(visible, { query: 'u2', haystack: hay, typeFilter: 'all' });
  assert.deepEqual([...ids], ['u2']);
});

test('the filetype filter narrows it for the same reason', () => {
  const visible = [userA, userB];   // u1 raster, u2 vector
  const hay = buildSearchHaystack(visible, cat);
  const ids = selectableIds(visible, { query: '', haystack: hay, typeFilter: 'vector' });
  assert.deepEqual([...ids], ['u2']);
});

test('pruneSelection drops a tick the user can no longer see, and reports how many', () => {
  // The bug this prevents: search for "u2", the u1 tick survives invisibly, and
  // "1 selected" then deletes a file the user is not looking at.
  const visible = [userA, userB];
  const hay = buildSearchHaystack(visible, cat);
  const selected = new Set(['u1', 'u2']);
  const dropped = pruneSelection(selected, selectableIds(visible, { query: 'u2', haystack: hay, typeFilter: 'all' }));
  assert.equal(dropped, 1);
  assert.deepEqual([...selected], ['u2']);
});

test('pruneSelection drops an id whose asset was deleted outright', () => {
  const selected = new Set(['gone', 'u1']);
  assert.equal(pruneSelection(selected, new Set(['u1'])), 1);
  assert.deepEqual([...selected], ['u1']);
});

test('pruneSelection is a no-op on an empty selection and on a fully-valid one', () => {
  const empty = new Set<string>();
  assert.equal(pruneSelection(empty, new Set(['u1'])), 0);
  const all = new Set(['u1', 'u2']);
  assert.equal(pruneSelection(all, new Set(['u1', 'u2'])), 0);
  assert.deepEqual([...all], ['u1', 'u2']);
});

test('a hidden asset is not selectable even when it matches the search', () => {
  // visibleAssets runs first in the view; this pins the composition, since a
  // hidden-but-selectable asset would be deletable from a UI that never shows it.
  const assets = [userA, userB];
  const visible = visibleAssets(assets, new Set(['u1']), baseId);
  const hay = buildSearchHaystack(assets, cat);
  const ids = selectableIds(visible, { query: '', haystack: hay, typeFilter: 'all' });
  assert.deepEqual([...ids], ['u2']);
});
