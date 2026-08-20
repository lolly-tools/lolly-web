// SPDX-License-Identifier: MPL-2.0
/**
 * The Catalogue view's selection model - pure, DOM-free, testable.
 *
 * Extracted from views/catalog.ts (3,563 lines, one 3,078-line `mountCatalog`)
 * for maintainability-2026-07-29.md item 2: 33 of 45 views have no test, and the
 * ones that DO are exactly the ones whose pure logic was pulled into a sibling
 * module (free-canvas-math.ts, timeline-math.ts, free-canvas-pen.ts). The audit's
 * point was that the technique needs no design debate, only application. This is
 * that, applied to the largest fully-untested view.
 *
 * WHY THIS CLUSTER FIRST. These six functions decide which assets a user can see,
 * search, favourite and bulk-select - and `pruneSelection` is what keeps the
 * "N selected" counter honest when a search hides something that is still ticked.
 * Getting that wrong deletes the wrong files, or reports a count that does not
 * match what a delete will actually touch. It is the highest-consequence pure
 * logic in the file and it had no coverage at all.
 *
 * Everything here takes its state as arguments rather than closing over
 * mountCatalog's locals. That is the whole extraction: the view still owns the
 * mutable state, this module owns the rules.
 */

import type { AssetRef } from '@lolly-tools/core/host-v1';
import { fold, tokenize, scoreHaystack } from '../lib/search/match.ts';

/** The sticky filetype-filter buckets. 'all' admits everything. */
export type TypeFilter = 'all' | 'image' | 'vector' | 'motion' | 'audio' | 'text';

/** Which asset `type` values each bucket admits. */
export const TYPE_FILTER_TYPES: Record<Exclude<TypeFilter, 'all'>, ReadonlySet<string>> = {
  image: new Set(['raster']),
  vector: new Set(['vector']),
  motion: new Set(['video', 'lottie']),
  audio: new Set(['audio']),
  text: new Set(['text', 'data']),
};

/** Filetype-filter predicate. */
export function matchesType(asset: AssetRef, filter: TypeFilter): boolean {
  return filter === 'all' || (TYPE_FILTER_TYPES[filter]?.has(asset.type as string) ?? false);
}

/**
 * Assets the user has not hidden. Hidden-ness is keyed by BASE id, so hiding an
 * asset hides every modified variant of it (`<id>?theme=…`, `<id>?treatment=…`)
 * rather than leaving orphans behind - which is why the caller passes a
 * base-id-extracting function rather than this module guessing at the format.
 */
export function visibleAssets(
  assets: readonly AssetRef[],
  hidden: ReadonlySet<string>,
  baseId: (id: string) => string,
): AssetRef[] {
  return assets.filter((a) => !hidden.has(baseId(a.id)));
}

/**
 * The search index: asset id → one FOLDED haystack string (lib/search fold - 
 * lowercase + diacritics stripped, so "café" and "cafe" index identically).
 * Built once and reused across keystrokes (the view memoises it and drops it
 * when the asset list changes), because rebuilding per keystroke is O(assets)
 * per character.
 *
 * `categoryOf` is injected so this module needs neither the category registry nor
 * the user's overrides - it is the only part of the haystack that is not intrinsic
 * to the asset.
 */
export function buildSearchHaystack(
  assets: readonly AssetRef[],
  categoryOf: (asset: AssetRef) => string,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const a of assets) {
    const tags = ((a.meta?.tags as string[] | undefined) ?? []).join(' ');
    index.set(
      a.id,
      fold(`${String(a.meta?.name ?? '')} ${a.id} ${tags} ${categoryOf(a)} ${a.format ?? a.type}`),
    );
  }
  return index;
}

// matchesQuery runs once per asset per keystroke over one unchanging query, so
// the tokenization (fold + split) is memoised on the last query seen rather
// than recomputed per asset.
let lastQuery = '';
let lastTokens: string[] = [];
function queryTokens(query: string): string[] {
  if (query !== lastQuery) {
    lastQuery = query;
    lastTokens = tokenize(query);
  }
  return lastTokens;
}

/**
 * Search predicate - lib/search semantics (plans/99 M3, principle 1): the query
 * is folded + tokenized, and every token must appear in the asset's haystack
 * (AND across terms, so "logo dark" narrows rather than widens; word order is
 * free). An empty query passes everything - the search box is a filter, not a
 * mode, so clearing it must restore the full list.
 *
 * `query` may arrive lowercased and trimmed by the caller (the view still does,
 * harmlessly - fold is idempotent); an asset the index has never seen simply
 * does not match, rather than throwing.
 */
export function matchesQuery(
  asset: AssetRef,
  query: string,
  haystack: ReadonlyMap<string, string>,
): boolean {
  if (!query) return true;
  const text = haystack.get(asset.id);
  if (text === undefined) return false;
  return scoreHaystack([{ text, weight: 1 }], queryTokens(query)) > 0;
}

/**
 * Favourited, visible assets - deduped by base id, in catalog-then-user order.
 *
 * The dedupe matters: a user upload can shadow a catalog asset at the same base
 * id, and without this the favourites strip shows the same mark twice. Input
 * order carries the precedence (the view passes catalog assets first), so the
 * FIRST occurrence wins and later duplicates are dropped.
 */
export function favItems(
  visible: readonly AssetRef[],
  favourites: ReadonlySet<string>,
  baseId: (id: string) => string,
): AssetRef[] {
  const seen = new Set<string>();
  const out: AssetRef[] = [];
  for (const a of visible) {
    const b = baseId(a.id);
    if (favourites.has(b) && !seen.has(b)) { seen.add(b); out.push(a); }
  }
  return out;
}

/**
 * The ids a selection may hold: visible, matching the current search AND the
 * current filetype filter. The search and the filter both belong here for the
 * same reason: a bulk action must only ever touch what the user can actually
 * SEE. Anything else acts invisibly.
 *
 * `scope` - 'uploads' restricts to user-owned assets; 'all' admits shared
 * catalog assets too (2026-08-09: every tile is selectable now - people expect
 * a grid to marquee - and the DESTRUCTIVE actions gate per-kind instead:
 * Duplicate/Download/Delete only light up when the whole selection is uploads,
 * since catalog assets are a permanent contract that can only be favourited or
 * hidden). The uploads section's own "Select all" button stays 'uploads'.
 */
export function selectableIds(
  visible: readonly AssetRef[],
  opts: {
    query: string;
    haystack: ReadonlyMap<string, string>;
    typeFilter: TypeFilter;
    scope?: 'uploads' | 'all';
  },
): Set<string> {
  const out = new Set<string>();
  for (const a of visible) {
    if ((opts.scope ?? 'uploads') === 'uploads' && a.source !== 'user') continue;
    if (!matchesQuery(a, opts.query, opts.haystack)) continue;
    if (!matchesType(a, opts.typeFilter)) continue;
    out.add(a.id);
  }
  return out;
}

/**
 * Drop selected ids that are no longer selectable - deleted, or filtered out by a
 * search - so the "N selected" count matches what an action would actually touch.
 * Mutates `selected` in place (the view holds it across renders) and returns the
 * number removed, so a caller can tell whether anything changed without diffing.
 */
export function pruneSelection(selected: Set<string>, selectable: ReadonlySet<string>): number {
  if (!selected.size) return 0;
  let dropped = 0;
  for (const id of [...selected]) {
    if (!selectable.has(id)) { selected.delete(id); dropped++; }
  }
  return dropped;
}

// ── Sort + dates (plans/132 WP-A) ────────────────────────────────────────────

export type CatSort = 'default' | 'name' | 'added' | 'modified' | 'size' | 'type';

/**
 * When an asset was added. Uploads embed their mint time in the id
 * (`user/<kind>/<Date.now()>-…`), so every existing upload has a date with no
 * migration; a stored `meta.addedAt` (future writers) wins. Catalog assets
 * have no date - null, and they keep their curated order under a date sort
 * (Array.sort is stable).
 */
export function assetAddedAt(ref: Pick<AssetRef, 'id' | 'meta'>): number | null {
  const meta = Number(ref.meta?.addedAt);
  if (Number.isFinite(meta) && meta > 0) return meta;
  const m = /^user\/[^/]+\/(\d{12,})(?:-|$)/.exec(ref.id);
  return m ? Number(m[1]) : null;
}

/** Last content modification: `meta.modifiedAt` (stamped by the bridge on every
 *  record write - replace/trim/etc.), falling back to the added time. */
export function assetModifiedAt(ref: Pick<AssetRef, 'id' | 'meta'>): number | null {
  const meta = Number(ref.meta?.modifiedAt);
  if (Number.isFinite(meta) && meta > 0) return meta;
  return assetAddedAt(ref);
}

/**
 * Sort a section's assets. 'default' preserves the curated manifest order
 * (uploads: newest-first from the bridge). Date sorts are newest-first with
 * dateless (catalog) assets keeping their relative order after the dated ones;
 * name/type are A→Z; size is largest-first.
 */
export function sortAssets(list: readonly AssetRef[], sortBy: CatSort): AssetRef[] {
  if (sortBy === 'default') return [...list];
  const arr = [...list];
  const name = (a: AssetRef): string => String(a.meta?.name ?? a.id).toLowerCase();
  switch (sortBy) {
    case 'name': arr.sort((a, b) => name(a).localeCompare(name(b))); break;
    case 'added': arr.sort((a, b) => (assetAddedAt(b) ?? -1) - (assetAddedAt(a) ?? -1)); break;
    case 'modified': arr.sort((a, b) => (assetModifiedAt(b) ?? -1) - (assetModifiedAt(a) ?? -1)); break;
    case 'size': arr.sort((a, b) => (Number(b.meta?.bytes) || 0) - (Number(a.meta?.bytes) || 0)); break;
    case 'type': arr.sort((a, b) => String(a.format ?? a.type).localeCompare(String(b.format ?? b.type))); break;
  }
  return arr;
}
