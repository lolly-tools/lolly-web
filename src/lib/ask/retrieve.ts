// SPDX-License-Identifier: MPL-2.0
/**
 * Retrieval for Ask answers (plans/103 M0).
 *
 * Two independent retrievals, both federating over data the client already
 * holds (plans/99 principle 2):
 *  - `retrieveDocsSections` ranks the /info section index with the shared docs
 *    scorer. This is the ONE place the docs ranking lives; plans/103 M1 swaps in
 *    a lexical+semantic hybrid here and nowhere else.
 *  - `retrieveProviderHits` asks the registered spotlight providers (tools,
 *    settings, places, projects, catalog…) the same tokens, so "where is…" and
 *    "make a…" answers reuse the exact hits the spotlight overlay would show.
 *    The `ask` group is skipped (it would recurse into this surface).
 */
import { GROUP_CAP, searchProviders, type SearchGroupId, type SearchHit } from '../search/registry.ts';
import { scoreHaystack } from '../search/match.ts';
import { loadDocsIndex, type DocsRecord } from '../search/docs-index.ts';

/** One ranked documentation section. */
export interface DocsSectionHit { rec: DocsRecord; score: number }

/**
 * A small English stopword set. A natural-language question ("how do I export a
 * transparent PNG?") is mostly function words that appear in no section, and the
 * spotlight matcher is AND-across-tokens — so scoring the raw question finds
 * nothing. Stripping these focuses the match on the content terms. English-only
 * and English-first by design (plans/103): other locales keep every token, where
 * the additive OR scoring below simply treats the extra words as weak signal.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'be', 'do', 'does', 'did', 'how', 'what', 'why',
  'when', 'where', 'which', 'who', 'can', 'could', 'should', 'would', 'will', 'to', 'of',
  'in', 'on', 'for', 'and', 'or', 'my', 'i', 'me', 'it', 'this', 'that', 'with', 'as',
  'from', 'at', 'by', 'you', 'your', 'we', 'if', 'so', 'get', 'use', 'using',
]);

/**
 * Rank the docs section index against the tokens. Unlike the spotlight docs
 * provider (which is AND-across-tokens — right for a short lookup), Ask questions
 * are natural language, so this is ADDITIVE OR: each content token contributes
 * its best-field weight through the shared matcher (a single-token scoreHaystack
 * call, so folding, word-boundary doubling and the heading>title>body ladder are
 * all still the one matcher's), a missing token just scores 0 instead of zeroing
 * the record, and sections are ranked by how many query terms they cover first,
 * then by weight. This is the ONE place docs ranking lives; plans/103 M1 blends a
 * semantic score in here and nowhere else.
 */
export async function retrieveDocsSections(tokens: readonly string[], limit: number): Promise<DocsSectionHit[]> {
  if (!tokens.length) return [];
  const content = tokens.filter((t) => !STOPWORDS.has(t));
  const use = content.length ? content : tokens; // never strip a query to nothing
  const scored: Array<DocsSectionHit & { matched: number }> = [];
  for (const { rec, fields } of await loadDocsIndex()) {
    let score = 0;
    let matched = 0;
    for (const tok of use) {
      const s = scoreHaystack(fields, [tok]);
      if (s > 0) { score += s; matched++; }
    }
    if (matched > 0) scored.push({ rec, score, matched });
  }
  // Coverage first (a section hitting more of the question wins), then weight.
  scored.sort((a, b) => b.matched - a.matched || b.score - a.score);
  return scored.slice(0, limit).map(({ rec, score }) => ({ rec, score }));
}

/** One provider's contribution to an answer. */
export interface ProviderHitGroup { group: SearchGroupId; hits: SearchHit[] }

/** Ask every registered provider (except `ask`) the tokens; drop empty groups. */
export async function retrieveProviderHits(tokens: readonly string[]): Promise<ProviderHitGroup[]> {
  if (!tokens.length) return [];
  const groups = await Promise.all(
    searchProviders()
      .filter((p) => p.id !== 'ask')
      .map(async (p): Promise<ProviderHitGroup> => ({
        group: p.id,
        hits: await p.search(tokens, GROUP_CAP).catch(() => []),
      })),
  );
  return groups.filter((g) => g.hits.length > 0);
}
